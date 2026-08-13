import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptResult } from './types.js';

function run(command: string, args: string[], signal?: AbortSignal) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, signal });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-1200)}`)),
    );
  });
}

function transcriptFrom(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['text', 'transcript', 'transcription', 'result']) {
    const found = transcriptFrom(record[key]);
    if (found) return found;
  }
  return undefined;
}

export function detectWakeCommand(text: string, wakeWord: string, armed: boolean) {
  if (armed) return { result: { text, wakeDetected: true, command: text } as TranscriptResult, armed: false };
  const escaped = wakeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`\\b${escaped}\\b[\\s,.:;!?—-]*(.*)$`, 'i'));
  if (!match) return { result: { text, wakeDetected: false } as TranscriptResult, armed: false };
  const command = match[1].trim();
  return {
    result: { text, wakeDetected: true, command: command || undefined } as TranscriptResult,
    armed: !command,
  };
}

export class SpeechService {
  private armed = false;

  constructor(
    private wakeWord: string,
    private readonly model = process.env.LINUX_BUDDY_STT_MODEL ||
      'handy-computer/canary-180m-flash-gguf/canary-180m-flash-Q8_0.gguf',
  ) {}

  setWakeWord(value: string) {
    this.wakeWord = value.trim() || 'Friday';
  }

  reset() {
    this.armed = false;
  }

  async transcribe(audio: ArrayBuffer, mimeType: string): Promise<TranscriptResult> {
    if (audio.byteLength < 1000) return { text: '', wakeDetected: false };
    const directory = await mkdtemp(join(tmpdir(), 'friday-speech-'));
    const suffix = mimeType.includes('ogg') ? '.ogg' : mimeType.includes('wav') ? '.wav' : '.webm';
    const input = join(directory, `utterance${suffix}`);
    const wav = join(directory, `${randomUUID()}.wav`);
    try {
      await writeFile(input, Buffer.from(audio));
      await run(process.env.LINUX_BUDDY_FFMPEG_BIN || 'ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        input,
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        wav,
      ]);
      const { stdout } = await run(process.env.LINUX_BUDDY_HANDY_BIN || 'handy', [
        '--transcribe-file',
        wav,
        '--model',
        this.model,
        '--json',
      ]);
      let text = '';
      try {
        text = transcriptFrom(JSON.parse(stdout)) ?? '';
      } catch {
        text = stdout.trim().split('\n').at(-1)?.trim() ?? '';
      }
      if (!text) return { text: '', wakeDetected: false };
      const detected = detectWakeCommand(text, this.wakeWord, this.armed);
      this.armed = detected.armed;
      return detected.result;
    } catch {
      throw new Error(
        'Canary could not transcribe this utterance. Check that Handy and the configured model are available.',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
