import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentService } from '../electron/agent-service.js';
import { DesktopError } from '../electron/desktop-status.js';
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
  const invocations: unknown[][] = [];
  const spawnMock = ((...args: unknown[]) => {
    invocations.push(args);
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
  return { service, children, invocations };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('AgentService lifecycle', () => {
  it('reports desktop interruptions as failures rather than blaming the user', async () => {
    const { service } = await fixture();
    const task = await service.submit('circle the button');
    await service.desktopInterrupted(task.id, new DesktopError('Desktop session ended: overview', 'overview'));
    const result = service.list()[0];
    expect(result.status).toBe('failed');
    expect(result.error).toContain('GNOME overview');
    expect(result.steps.some((s) => s.title === 'Stopped by you')).toBe(false);
    await service.shutdown();
  });
  it('distinguishes the native Escape shortcut from Stop in the app', async () => {
    const { service } = await fixture();
    const task = await service.submit('circle the button');
    await service.desktopInterrupted(task.id, new DesktopError('Desktop session ended: escape', 'escape'));
    expect(service.list()[0]).toMatchObject({ status: 'cancelled', stopReason: 'escape' });
    await service.shutdown();
  });
  it('offers drawing and actions without mode switching, remembers follow-ups, and isolates New conversation', async () => {
    const { service, children, invocations } = await fixture();
    const first = await service.submit('Circle the save button');
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Circled Save.' }] });
    await settle();
    children[0].finish();
    await settle();
    const second = await service.submit('open that');
    expect(second.conversationId).toBe(first.conversationId);
    const firstArgs = invocations[0][1] as string[];
    const nextArgs = invocations[1][1] as string[];
    expect(firstArgs[firstArgs.indexOf('--session') + 1]).toBe(nextArgs[nextArgs.indexOf('--session') + 1]);
    expect(firstArgs).not.toContain('--no-session');
    expect(firstArgs[firstArgs.indexOf('--tools') + 1]).toContain('desktop_draw,desktop_clear,desktop_action');
    expect(firstArgs[firstArgs.indexOf('--tools') + 1]).toBe(nextArgs[nextArgs.indexOf('--tools') + 1]);
    expect(nextArgs[nextArgs.indexOf('--tools') + 1]).toContain('bash');
    await service.cancel(second.id);
    children[1].finish();
    await settle();
    const newId = service.newConversation();
    expect((await service.submit('New topic')).conversationId).toBe(newId);
    expect(newId).not.toBe(first.conversationId);
    await service.shutdown();
  });

  it('finishes screenshot steps when Pi sends a large image result, and records tool errors', async () => {
    const { service, children } = await fixture();
    const task = await service.submit('Look');
    children[0].rpc({ type: 'tool_execution_start', toolCallId: 'screen', toolName: 'desktop_observe' });
    children[0].rpc({
      type: 'tool_execution_end',
      toolCallId: 'screen',
      result: { content: [{ type: 'image', data: 'a'.repeat(1_500_000) }] },
    });
    children[0].rpc({ type: 'tool_execution_start', toolCallId: 'draw', toolName: 'desktop_draw' });
    children[0].rpc({
      type: 'tool_execution_end',
      toolCallId: 'draw',
      isError: true,
      result: { content: [{ type: 'text', text: 'Observe again' }] },
    });
    await settle();
    const steps = service.list().find((t) => t.id === task.id)!.steps;
    expect(steps.find((s) => s.title === 'Looking at the screen')?.status).toBe('done');
    expect(steps.find((s) => s.title === 'Using desktop draw')).toMatchObject({
      status: 'failed',
      detail: 'Observe again',
    });
    await service.shutdown();
  });

  it('runs a strict FIFO with only one Pi child active', async () => {
    const { service, children } = await fixture();
    const first = await service.submit('first');
    const second = await service.submit('second');
    expect(children).toHaveLength(1);
    expect(service.list().find((task) => task.id === second.id)?.status).toBe('queued');

    children[0].rpc({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'First finished.' }] }],
    });
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

  it('recovers the final answer from message_end when text deltas are missing', async () => {
    const { service, children } = await fixture();
    const task = await service.submit('answer me');
    children[0].rpc({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the answer.' }] },
    });
    children[0].rpc({ type: 'agent_end' });
    await settle();
    const completed = service.list().find((item) => item.id === task.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.response).toBe('Here is the answer.');
    await service.shutdown();
  });

  it('recovers the final answer from agent_end messages', async () => {
    const { service, children } = await fixture();
    const task = await service.submit('answer at the end');
    children[0].rpc({
      type: 'agent_end',
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Recovered final answer.' }] },
      ],
    });
    await settle();
    const completed = service.list().find((item) => item.id === task.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.response).toBe('Recovered final answer.');
    await service.shutdown();
  });

  it('fails clearly instead of claiming Done when Pi returns no answer', async () => {
    const { service, children } = await fixture();
    const task = await service.submit('silent task');
    children[0].rpc({ type: 'agent_end', messages: [] });
    await settle();
    const failed = service.list().find((item) => item.id === task.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.response).toBeUndefined();
    expect(failed?.error).toContain('without returning an answer');
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
