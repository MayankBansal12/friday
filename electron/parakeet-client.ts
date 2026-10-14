import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ParakeetOptions {
  workerPath: string;
  pythonPath?: string;
  modelDirectory?: string;
  threads?: number;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  spawn?: typeof spawn;
}

interface Worker {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  startupTimer: NodeJS.Timeout;
  buffer: string;
  stderr: string;
  pending?: {
    id: string;
    resolve: (value: { text: string; inferenceMs: number }) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };
}

const MODEL = 'parakeet-tdt-0.6b-v3-int8';

/** The copy from pnpm stt:setup, else one Handy already downloaded. */
function defaultModel(data: string): string {
  const own = join(data, 'friday', MODEL);
  const handy = join(data, 'com.pais.handy/models', MODEL);
  const has = (directory: string) => existsSync(join(directory, 'encoder-model.int8.onnx'));
  return has(own) || !has(handy) ? own : handy;
}

/** One model process shared by successive utterances, with crash/timeout recovery. */
export class ParakeetClient {
  private worker?: Worker;
  private closed = false;

  constructor(private readonly options: ParakeetOptions) {}

  prepare(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Speech service is closed.'));
    if (this.worker) return this.worker.ready;
    const data = process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
    const python =
      this.options.pythonPath || process.env.LINUX_BUDDY_STT_PYTHON || join(data, 'friday/stt-venv/bin/python');
    const model = this.options.modelDirectory || process.env.LINUX_BUDDY_STT_MODEL || defaultModel(data);
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const child = (this.options.spawn ?? spawn)(
      python,
      [
        '-u',
        this.options.workerPath,
        '--model-dir',
        model,
        '--threads',
        String(this.options.threads ?? process.env.LINUX_BUDDY_STT_THREADS ?? 4),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: { ...process.env, HF_HUB_OFFLINE: '1' } },
    );
    const worker: Worker = {
      child,
      ready,
      resolveReady,
      rejectReady,
      buffer: '',
      stderr: '',
      startupTimer: setTimeout(
        () => this.fail(worker, new Error('Parakeet model loading timed out.')),
        this.options.startupTimeoutMs ?? 60_000,
      ),
    };
    this.worker = worker;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(worker, chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      worker.stderr = `${worker.stderr}${chunk.toString('utf8')}`.slice(-2000);
    });
    child.on('error', (error) =>
      this.fail(
        worker,
        new Error(`Local STT could not start: ${error.message}. Run pnpm stt:setup or set LINUX_BUDDY_STT_PYTHON.`),
      ),
    );
    child.stdin.on('error', (error) => this.fail(worker, error));
    child.on('close', () => this.fail(worker, new Error(`Parakeet worker stopped. ${worker.stderr}`.trim())));
    return ready;
  }

  transcribe(path: string) {
    return this.request({ path });
  }

  transcribePcm(audio: ArrayBuffer) {
    if (!(audio instanceof ArrayBuffer) || !audio.byteLength || audio.byteLength > 800_000 || audio.byteLength % 2)
      return Promise.reject(new Error('Invalid PCM audio.'));
    return this.request({ pcm: Buffer.from(audio).toString('base64'), sampleRate: 16000 });
  }

  private async request(input: { path: string } | { pcm: string; sampleRate: number }) {
    await this.prepare();
    const worker = this.worker;
    if (!worker) throw new Error('Parakeet worker is unavailable.');
    if (worker.pending) throw new Error('A transcription is already in progress.');
    return new Promise<{ text: string; inferenceMs: number }>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(
        () => this.fail(worker, new Error('Parakeet transcription timed out.')),
        this.options.requestTimeoutMs ?? 60_000,
      );
      worker.pending = { id, resolve, reject, timer };
      worker.child.stdin.write(`${JSON.stringify({ id, ...input })}\n`);
    });
  }

  close() {
    this.closed = true;
    if (this.worker) this.fail(this.worker, new Error('Speech service is closed.'));
  }

  private fail(worker: Worker, error: Error) {
    if (this.worker !== worker) return;
    this.worker = undefined;
    clearTimeout(worker.startupTimer);
    worker.rejectReady(error);
    if (worker.pending) {
      clearTimeout(worker.pending.timer);
      worker.pending.reject(error);
      worker.pending = undefined;
    }
    // This worker has no side effects beyond inference and must not outlive Friday.
    worker.child.kill('SIGKILL');
  }

  private consume(worker: Worker, chunk: string) {
    if (this.worker !== worker) return;
    worker.buffer += chunk;
    if (worker.buffer.length > 1024 * 1024) {
      this.fail(worker, new Error('Parakeet returned an oversized response.'));
      return;
    }
    let newline: number;
    while ((newline = worker.buffer.indexOf('\n')) !== -1) {
      const line = worker.buffer.slice(0, newline);
      worker.buffer = worker.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as {
          type?: string;
          id?: string;
          text?: string;
          error?: string;
          inferenceMs?: number;
        };
        if (message.type === 'ready') {
          clearTimeout(worker.startupTimer);
          worker.resolveReady();
        } else if (message.type === 'error') {
          this.fail(worker, new Error(message.error || 'Parakeet could not load the model.'));
          return;
        } else if (worker.pending && message.id === worker.pending.id) {
          const pending = worker.pending;
          worker.pending = undefined;
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error));
          else if (typeof message.text !== 'string' || !Number.isFinite(message.inferenceMs))
            pending.reject(new Error('Invalid Parakeet transcription response.'));
          else pending.resolve({ text: message.text, inferenceMs: message.inferenceMs! });
        }
      } catch {
        this.fail(worker, new Error('Invalid response from the Parakeet worker.'));
        return;
      }
    }
  }
}
