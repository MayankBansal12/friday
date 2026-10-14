import { readFile } from 'node:fs/promises';

const endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';
const maxPcmBytes = 800_000; // 400,000 samples: the segmenter's 25 s limit.
const maxResponseBytes = 65_536; // verbose_json carries per-segment scores.
/** Below this mean token log-probability a segment is Whisper guessing, not hearing. */
const minSegmentLogprob = -1;
// Whisper's stock output for audio without speech (room noise, breath, a knock). Groq's
// no_speech_prob is always 0, so a whole utterance that is only one of these is dropped.
const silencePhrases = new Set([
  'you',
  'thank you',
  'thanks',
  'thank you very much',
  'thank you so much',
  'thanks for watching',
  'thank you for watching',
  'thank you so much for watching',
  'thanks for listening',
  'please subscribe',
  'bye',
  'bye bye',
]);

interface Segment {
  text?: unknown;
  avg_logprob?: unknown;
}

/** Text Whisper actually heard: unsure segments and silence hallucinations are removed. */
export function heardText(text: string, segments?: Segment[]) {
  const kept = Array.isArray(segments)
    ? segments
        .filter((segment) => typeof segment.text === 'string')
        .filter((segment) => typeof segment.avg_logprob !== 'number' || segment.avg_logprob >= minSegmentLogprob)
        .map((segment) => segment.text as string)
        .join('')
    : text;
  const normalized = kept
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return !normalized || silencePhrases.has(normalized) ? '' : kept.trim();
}

export interface GroqOptions {
  apiKey: string;
  model?: string;
  /** Whisper auto-detects when unset; a hint forces one language (e.g. `hi`). */
  language?: string;
  /** Longest single attempt (default 8 s), always within the remaining budget. */
  timeoutMs?: number;
  /**
   * Total time for one transcription, retries and waits included (default 10 s). The renderer's
   * recognition timeout allows two of these in a row, since a superseded segment's request can
   * still be running when the next one queues behind it.
   */
  budgetMs?: number;
  // Dependency hooks are main-process only; never exposed over IPC.
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A retry needs at least this much of the budget left to be worth sending. */
const minAttemptMs = 1500;

interface Transcription {
  text: string;
  inferenceMs: number;
}

/** A raw PCM16/16 kHz recording becomes a valid single-channel WAV container. */
export function wavFromPcm(pcm: ArrayBuffer, sampleRate = 16000) {
  if (pcm.byteLength % 2) throw new Error('Invalid PCM audio.');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // Linear PCM.
  header.writeUInt16LE(1, 22); // Mono.
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

/** Hosted speech recognition through the Groq API. One utterance per request. */
export class GroqClient {
  readonly model: string;
  constructor(private readonly options: GroqOptions) {
    this.model = options.model?.trim() || 'whisper-large-v3-turbo';
  }

  prepare(): Promise<void> {
    // There is no resident model to warm; the network round trip is the cost.
    return Promise.resolve();
  }

  transcribe(path: string) {
    return this.send(readFile(path));
  }

  transcribePcm(audio: ArrayBuffer) {
    if (!(audio instanceof ArrayBuffer) || !audio.byteLength || audio.byteLength > maxPcmBytes || audio.byteLength % 2)
      return Promise.reject(new Error('Invalid PCM audio.'));
    return this.send(Promise.resolve(wavFromPcm(audio)));
  }

  close() {}

  private wait(ms: number) {
    return (this.options.sleep ?? ((delay: number) => new Promise<void>((yes) => setTimeout(yes, delay))))(ms);
  }

  private async send(audio: Promise<Buffer>): Promise<Transcription> {
    const buffer = await audio;
    const form = () => {
      const data = new FormData();
      data.append('file', new Blob([new Uint8Array(buffer)], { type: 'audio/wav' }), 'utterance.wav');
      data.append('model', this.model);
      data.append('response_format', 'verbose_json');
      data.append('temperature', '0');
      const language = this.options.language?.trim();
      if (language) data.append('language', language);
      return data;
    };
    const now = this.options.now ?? Date.now;
    const started = now();
    const budget = this.options.budgetMs ?? 10_000;
    const remaining = () => budget - (now() - started);
    // Retries are only worth it when the rest of the budget can still hold a real attempt.
    const canRetry = (attempt: number, waitMs: number) => attempt < 2 && remaining() - waitMs >= minAttemptMs;
    // One retry covers rate limits, transient 5xx, and a lost connection; the
    // endpoint decision in the renderer survives a slow second attempt.
    for (let attempt = 1; ; attempt++) {
      const signal = new AbortController();
      const deadline = setTimeout(
        () => signal.abort(),
        Math.max(0, Math.min(this.options.timeoutMs ?? 8_000, remaining())),
      );
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: signal.signal,
          headers: { Authorization: `Bearer ${this.options.apiKey}` },
          body: form(),
        });
      } catch (error) {
        clearTimeout(deadline);
        if (signal.signal.aborted)
          throw new Error('Groq transcription timed out. Check the network.', { cause: error });
        if (canRetry(attempt, 250)) {
          await this.wait(250);
          continue;
        }
        throw new Error(
          `Groq transcription request failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (response.ok) {
        let raw: string;
        try {
          // The deadline covers the body too; a stalled body must not outlive the budget.
          raw = await response.text();
        } catch (error) {
          throw new Error(
            signal.signal.aborted
              ? 'Groq transcription timed out. Check the network.'
              : 'Groq returned an invalid transcription response.',
            { cause: error },
          );
        } finally {
          clearTimeout(deadline);
        }
        if (raw.length > maxResponseBytes) throw new Error('Groq returned an oversized transcription response.');
        let body: { text?: unknown; segments?: Segment[] };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch (error) {
          throw new Error('Groq returned an invalid transcription response.', { cause: error });
        }
        if (typeof body.text !== 'string') throw new Error('Groq returned an invalid transcription response.');
        return { text: heardText(body.text, body.segments), inferenceMs: now() - started };
      }
      clearTimeout(deadline);
      void response.body?.cancel().catch(() => {});
      if (response.status === 429 || response.status >= 500) {
        const after = Number(response.headers.get('retry-after'));
        const waitMs = Math.min(Number.isFinite(after) && after >= 0 ? after : 1, 5) * 1000;
        if (canRetry(attempt, waitMs)) {
          await this.wait(waitMs);
          continue;
        }
        throw new Error('Speech service is busy. Try again shortly.');
      }
      throw httpError(response.status);
    }
  }
}

function httpError(status: number) {
  if (status === 401) return new Error('Speech authentication failed. Check the Groq key.');
  if (status === 403) return new Error('Speech access denied. Check the Groq key and plan.');
  if (status === 413) return new Error('The utterance is too long for the Groq service.');
  if (status === 422) return new Error('Groq rejected the audio. Check the language hint.');
  return new Error('Speech request was rejected. Check the Groq configuration.');
}
