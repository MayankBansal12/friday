import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentService } from '../electron/agent-service.js';
import { TaskStore } from '../electron/store.js';
import type { BuddySettings } from '../electron/types.js';

const dirs: string[] = [];
const settings: BuddySettings = {
  defaultCwd: process.cwd(),
  launchAtLogin: false,
  wakeWord: 'Friday',
  model: 'kimi-k2.6',
};

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.signals.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }

  finish(code = 0) {
    this.exitCode = code;
    this.emit('close', code, null);
  }

  rpc(value: unknown) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-agent-'));
  dirs.push(dir);
  const children: FakeChild[] = [];
  const spawnMock = (() => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof spawn;
  const service = new AgentService(
    new TaskStore(join(dir, 'state.json')),
    settings,
    '/tmp/extension.mjs',
    { url: 'http://127.0.0.1:1', token: 'token' },
    { spawn: spawnMock, terminateGraceMs: 100, persistDebounceMs: 5 },
  );
  await service.init();
  return { service, children };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AgentService lifecycle', () => {
  it('runs a strict FIFO with only one Pi child active', async () => {
    const { service, children } = await fixture();
    const first = await service.submit('first');
    const second = await service.submit('second');
    expect(children).toHaveLength(1);
    expect(service.list().find((task) => task.id === second.id)?.status).toBe('queued');

    children[0].rpc({ type: 'agent_end' });
    await settle();
    expect(service.list().find((task) => task.id === first.id)?.status).toBe('completed');
    expect(children).toHaveLength(1);

    children[0].finish();
    await settle();
    expect(children).toHaveLength(2);
    expect(service.list().find((task) => task.id === second.id)?.status).toBe('thinking');
    await service.shutdown();
  });

  it('keeps cancellation terminal and idempotent despite late RPC completion', async () => {
    const { service, children } = await fixture();
    const task = await service.submit('cancel me');
    await service.cancel(task.id);
    await service.cancel(task.id);
    children[0].rpc({ type: 'agent_end' });
    await settle();
    const cancelled = service.list().find((item) => item.id === task.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.steps.filter((step) => step.title === 'Stopped by you')).toHaveLength(1);
    expect(children[0].stdin.read()?.toString()).toContain('"type":"abort"');
    await service.shutdown();
  });

  it('allows each approval to be resolved once and clears ownership on cancellation', async () => {
    const { service, children } = await fixture();
    const task = await service.submit('needs approval');
    children[0].rpc({ type: 'extension_ui_request', method: 'confirm', id: 'approval:1', message: 'Send it?' });
    await settle();
    await service.resolveApproval('approval:1', false);
    await expect(service.resolveApproval('approval:1', true)).rejects.toThrow('no longer active');
    expect(children[0].stdin.read()?.toString()).toContain('"confirmed":false');

    children[0].rpc({ type: 'extension_ui_request', method: 'confirm', id: 'approval:2' });
    await settle();
    await service.cancel(task.id);
    await expect(service.resolveApproval('approval:2', true)).rejects.toThrow('no longer active');
    await service.shutdown();
  });

  it('marks work terminal and terminates the active child during shutdown', async () => {
    const { service, children } = await fixture();
    const task = await service.submit('still running');
    await service.shutdown();
    expect(service.list().find((item) => item.id === task.id)?.status).toBe('cancelled');
    expect(children[0].signals).toContain('SIGTERM');
    await expect(service.submit('too late')).rejects.toThrow('shutting down');
  });
});
