import { validPcmRequest, type PcmRequest, type PcmResult } from './pcm-transcription.js';
import { detectWakeCommand } from './wake-command.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ParakeetClient, type ParakeetOptions } from './parakeet-client.js';
import type { TranscriptResult } from './types.js';

function run(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`${command} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout = `${stdout}${chunk.toString('utf8')}`.slice(-5000)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = `${stderr}${chunk.toString('utf8')}`.slice(-5000)));
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      finish(() =>
        code === 0
          ? resolve({ stdout, stderr })
          : reject(new Error(`${command} exited ${code}: ${stderr.slice(-1200)}`)),
      );
    });
  });
}

export { detectWakeCommand } from './wake-command.js';

export class SpeechService {
  private pcmQueued?: {
    request: PcmRequest;
    generation: number;
    resolve: (v: PcmResult) => void;
    reject: (e: unknown) => void;
  };
  private pcmRunning = false;
  private armed = false;
  private generation = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly client: ParakeetClient;

  constructor(
    private wakeWord: string,
    options: Partial<ParakeetOptions> = {},
  ) {
    this.client = new ParakeetClient({
      workerPath: fileURLToPath(new URL('../native/parakeet-worker.py', import.meta.url)),
      ...options,
    });
  }

  prepare() {
    return this.client.prepare();
  }

  setWakeWord(value: string) {
    this.wakeWord = value.trim() || 'Friday';
    this.reset();
  }

  reset() {
    this.armed = false;
    this.generation++;
    if (this.pcmQueued) {
      this.pcmQueued.resolve(this.cancelledPcm(this.pcmQueued.request));
      this.pcmQueued = undefined;
    }
  }

  close() {
    this.reset();
    this.client.close();
  }

  private cancelledPcm(request: PcmRequest): PcmResult {
    return {
      segment: request.segment,
      revision: request.revision,
      coverage: request.coverage,
      text: '',
      inferenceMs: 0,
      cancelled: true,
    };
  }

  transcribePcm(input: unknown): Promise<PcmResult> {
    const request = validPcmRequest(input);
    // Defensive host bound, including callers other than the renderer scheduler.
    if (this.pcmQueued) this.pcmQueued.resolve(this.cancelledPcm(this.pcmQueued.request));
    const result = new Promise<PcmResult>((resolve, reject) => {
      this.pcmQueued = { request, generation: this.generation, resolve, reject };
    });
    this.drainPcm();
    return result;
  }

  private drainPcm() {
    if (this.pcmRunning || !this.pcmQueued) return;
    const job = this.pcmQueued;
    this.pcmQueued = undefined;
    this.pcmRunning = true;
    // Share the legacy file path's serialization boundary.
    const operation = this.pending
      .catch(() => undefined)
      .then(async () => {
        if (job.generation !== this.generation) return job.resolve(this.cancelledPcm(job.request));
        try {
          const result = await this.client.transcribePcm(job.request.audio);
          job.resolve(
            job.generation === this.generation
              ? {
                  segment: job.request.segment,
                  revision: job.request.revision,
                  coverage: job.request.coverage,
                  ...result,
                }
              : this.cancelledPcm(job.request),
          );
        } catch (error) {
          job.reject(error);
        }
      });
    this.pending = operation;
    void operation.finally(() => {
      this.pcmRunning = false;
      this.drainPcm();
    });
  }

  transcribe(audio: ArrayBuffer, mimeType: string): Promise<TranscriptResult> {
    const generation = this.generation;
    const operation = this.pending
      .catch(() => undefined)
      .then(() => {
        if (generation !== this.generation) return { text: '', wakeDetected: false };
        return this.transcribeAudio(audio, mimeType, generation);
      });
    this.pending = operation;
    return operation;
  }

  private async transcribeAudio(audio: ArrayBuffer, mimeType: string, generation: number): Promise<TranscriptResult> {
    if (audio.byteLength < 1000) return { text: '', wakeDetected: false };
    const started = Date.now();
    let directory: string | undefined;
    const suffix = mimeType.includes('ogg') ? '.ogg' : mimeType.includes('wav') ? '.wav' : '.webm';
    try {
      await this.prepare();
      const modelReady = Date.now();
      directory = await mkdtemp(join(tmpdir(), 'friday-speech-'));
      const input = join(directory, `utterance${suffix}`);
      const wav = join(directory, `${randomUUID()}.wav`);
      await writeFile(input, Buffer.from(audio));
      await run(
        process.env.LINUX_BUDDY_FFMPEG_BIN || 'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          input,
          '-t',
          '31',
          '-ar',
          '16000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          wav,
        ],
        30_000,
      );
      const converted = Date.now();
      const { text, inferenceMs } = await this.client.transcribe(wav);
      // Results from an old listening interaction must never arm the next one.
      if (generation !== this.generation) return { text: '', wakeDetected: false };
      // Keep transcribed background speech from becoming a command. A segment must
      // contain the wake word, or immediately follow a wake-word-only segment.
      const detected = text
        ? detectWakeCommand(text, this.wakeWord, this.armed)
        : { result: { text: '', wakeDetected: false }, armed: this.armed };
      this.armed = detected.armed;
      return {
        ...detected.result,
        timings: {
          modelWaitMs: modelReady - started,
          conversionMs: converted - modelReady,
          transcriptionMs: Date.now() - converted,
          inferenceMs,
          totalMs: Date.now() - started,
        },
      };
    } catch (error) {
      throw new Error(
        `Local Parakeet transcription failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
