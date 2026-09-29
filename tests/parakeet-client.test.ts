import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ParakeetClient } from '../electron/parakeet-client.js';

class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
  messages: { id: string; path: string }[] = [];
  constructor() {
    super();
    this.stdin.on('data', (data: Buffer) => this.messages.push(JSON.parse(data.toString())));
  }
  send(value: unknown) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

const clients: ParakeetClient[] = [];
function setup(options: { startupTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
  const processes: FakeProcess[] = [];
  const spawnProcess = vi.fn(() => {
    const child = new FakeProcess();
    processes.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const client = new ParakeetClient({ workerPath: '/worker.py', spawn: spawnProcess as typeof spawn, ...options });
  clients.push(client);
  return { client, processes, spawnProcess };
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.close());
  vi.useRealTimers();
});

describe('persistent Parakeet worker', () => {
  it('shares model preparation and reuses one process across utterances', async () => {
    const { client, processes, spawnProcess } = setup();
    const first = client.prepare();
    expect(client.prepare()).toBe(first);
    processes[0].send({ type: 'ready' });
    await first;
    for (const path of ['/one.wav', '/two.wav']) {
      const pending = client.transcribe(path);
      await Promise.resolve();
      const request = processes[0].messages.at(-1)!;
      expect(request.path).toBe(path);
      processes[0].send({ id: request.id, text: 'Friday, hello.', inferenceMs: 123 });
      await expect(pending).resolves.toEqual({ text: 'Friday, hello.', inferenceMs: 123 });
    }
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('handles fragmented UTF-8 JSON records and ignores unrelated response IDs', async () => {
    const { client, processes } = setup();
    const ready = client.prepare();
    processes[0].stdout.write('{"type":"rea');
    processes[0].stdout.write('dy"}\n');
    await ready;
    const pending = client.transcribe('/speech.wav');
    await Promise.resolve();
    processes[0].send({ id: 'old-request', text: 'stale', inferenceMs: 1 });
    const response = Buffer.from(
      JSON.stringify({ id: processes[0].messages[0].id, text: 'café', inferenceMs: 3 }) + '\n',
    );
    const split = response.indexOf(Buffer.from('é')) + 1;
    processes[0].stdout.write(response.subarray(0, split));
    processes[0].stdout.write(response.subarray(split));
    await expect(pending).resolves.toEqual({ text: 'café', inferenceMs: 3 });
  });

  it('reports missing runtime and can restart on a later attempt', async () => {
    const { client, processes, spawnProcess } = setup();
    const failed = expect(client.prepare()).rejects.toThrow('pnpm stt:setup');
    processes[0].emit('error', new Error('spawn ENOENT'));
    await failed;
    const retry = client.prepare();
    processes[1].send({ type: 'ready' });
    await retry;
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it('reports model loading errors without leaving a running process', async () => {
    const { client, processes } = setup();
    const failed = expect(client.prepare()).rejects.toThrow('Missing model');
    processes[0].send({ type: 'error', error: 'Missing model' });
    await failed;
    expect(processes[0].kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('kills a stalled model load', async () => {
    vi.useFakeTimers();
    const { client, processes } = setup({ startupTimeoutMs: 100 });
    const failed = expect(client.prepare()).rejects.toThrow('loading timed out');
    await vi.advanceTimersByTimeAsync(101);
    await failed;
    expect(processes[0].kill).toHaveBeenCalled();
  });

  it('rejects concurrent requests without replacing the first request', async () => {
    const { client, processes } = setup();
    const ready = client.prepare();
    processes[0].send({ type: 'ready' });
    await ready;
    const first = client.transcribe('/first.wav');
    await Promise.resolve();
    await expect(client.transcribe('/second.wav')).rejects.toThrow('already in progress');
    processes[0].send({ id: processes[0].messages[0].id, text: 'first', inferenceMs: 1 });
    await expect(first).resolves.toMatchObject({ text: 'first' });
  });

  it('keeps the model available after an invalid audio error', async () => {
    const { client, processes, spawnProcess } = setup();
    const ready = client.prepare();
    processes[0].send({ type: 'ready' });
    await ready;
    const bad = client.transcribe('/bad.wav');
    await Promise.resolve();
    processes[0].send({ id: processes[0].messages[0].id, error: 'Invalid WAV' });
    await expect(bad).rejects.toThrow('Invalid WAV');
    await client.prepare();
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('rejects an in-flight request on process exit', async () => {
    const { client, processes } = setup();
    const ready = client.prepare();
    processes[0].send({ type: 'ready' });
    await ready;
    const failed = expect(client.transcribe('/speech.wav')).rejects.toThrow('worker stopped');
    await Promise.resolve();
    processes[0].emit('close', 1);
    await failed;
  });

  it('kills timed-out inference and starts a fresh worker next time', async () => {
    vi.useFakeTimers();
    const { client, processes, spawnProcess } = setup({ requestTimeoutMs: 100 });
    const ready = client.prepare();
    processes[0].send({ type: 'ready' });
    await ready;
    const failed = expect(client.transcribe('/speech.wav')).rejects.toThrow('transcription timed out');
    await vi.advanceTimersByTimeAsync(101);
    await failed;
    const retry = client.prepare();
    processes[1].send({ type: 'ready' });
    await retry;
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it('shutdown rejects pending work and prevents a new worker', async () => {
    const { client, processes, spawnProcess } = setup();
    const failed = expect(client.prepare()).rejects.toThrow('closed');
    client.close();
    await failed;
    await expect(client.prepare()).rejects.toThrow('closed');
    expect(processes[0].kill).toHaveBeenCalled();
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });
});

it('sends bounded PCM16 directly to the resident worker without a path or conversion', async () => {
  const { client, processes, spawnProcess } = setup();
  await expect(client.transcribePcm(new ArrayBuffer(800002))).rejects.toThrow('Invalid PCM');
  await expect(client.transcribePcm(new ArrayBuffer(3))).rejects.toThrow('Invalid PCM');
  expect(spawnProcess).not.toHaveBeenCalled();
  const ready = client.prepare();
  processes[0].send({ type: 'ready' });
  await ready;
  const audio = new Int16Array([0, 1000, -1000]).buffer;
  const pending = client.transcribePcm(audio);
  await Promise.resolve();
  const message = processes[0].messages[0] as unknown as { id: string; pcm: string; sampleRate: number; path?: string };
  expect(message.path).toBeUndefined();
  expect(message.sampleRate).toBe(16000);
  expect(Buffer.from(message.pcm, 'base64')).toEqual(Buffer.from(audio));
  processes[0].send({ id: message.id, text: 'hello', inferenceMs: 10 });
  await expect(pending).resolves.toEqual({ text: 'hello', inferenceMs: 10 });
});
