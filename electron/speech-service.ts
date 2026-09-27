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

export function detectWakeCommand(text: string, wakeWord: string, armed: boolean) {
  if (armed) return { result: { text, wakeDetected: true, command: text } as TranscriptResult, armed: false };
  const escaped = wakeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`\\b${escaped}\\b[\\s,.:;!?—-]*(.*)$`, 'i'));
  if (!match) {
    return {
      result: { text, wakeDetected: false } as TranscriptResult,
      armed: false,
    };
  }
  const command = match[1].trim();
  return {
    result: { text, wakeDetected: true, command: command || undefined } as TranscriptResult,
    armed: !command,
  };
}

export class SpeechService {
  private armed = false;
  private generation = 0;
  private busy = false;
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
  }

  close() {
    this.reset();
    this.client.close();
  }

  async transcribe(audio: ArrayBuffer, mimeType: string): Promise<TranscriptResult> {
    if (audio.byteLength < 1000) return { text: '', wakeDetected: false };
    if (this.busy) throw new Error('A transcription is already in progress.');
    this.busy = true;
    const generation = this.generation;
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
      this.busy = false;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
