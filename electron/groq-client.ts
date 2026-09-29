import { readFile } from 'node:fs/promises';

const endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';
const maxPcmBytes = 800_000; // 400,000 samples: the segmenter's 25 s limit.

export interface GroqOptions {
  apiKey: string;
  model?: string;
  /** Whisper auto-detects when unset; a hint forces one language (e.g. `hi`). */
  language?: string;
  timeoutMs?: number;
  // Dependency hooks are main-process only; never exposed over IPC.
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

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
      data.append('response_format', 'json');
      data.append('temperature', '0');
      const language = this.options.language?.trim();
      if (language) data.append('language', language);
      return data;
    };
    const started = Date.now();
    // One retry covers rate limits, transient 5xx, and a lost connection; the
    // endpoint decision in the renderer survives a slow second attempt.
    for (let attempt = 1; ; attempt++) {
      const signal = new AbortController();
      const deadline = setTimeout(() => signal.abort(), this.options.timeoutMs ?? 20_000);
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
        if (attempt < 2) {
          await this.wait(250);
          continue;
        }
        throw new Error(
          `Groq transcription request failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      clearTimeout(deadline);
      if (response.ok) {
        const raw = await response.text();
        if (raw.length > 4096) throw new Error('Groq returned an oversized transcription response.');
        let text: unknown;
        try {
          text = (JSON.parse(raw) as { text?: unknown }).text;
        } catch (error) {
          throw new Error('Groq returned an invalid transcription response.', { cause: error });
        }
        if (typeof text !== 'string') throw new Error('Groq returned an invalid transcription response.');
        return { text, inferenceMs: Date.now() - started };
      }
      void response.body?.cancel().catch(() => {});
      if (response.status === 429 || response.status >= 500) {
        if (attempt < 2) {
          const after = Number(response.headers.get('retry-after'));
          await this.wait(Math.min(Number.isFinite(after) && after >= 0 ? after : 1, 5) * 1000);
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
