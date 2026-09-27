import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentService } from '../electron/agent-service.js';
import { DesktopError } from '../electron/desktop-status.js';
import { TaskStore } from '../electron/store.js';
import type { BuddySettings } from '../electron/types.js';

const dirs: string[] = [];
const services: AgentService[] = [];
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

async function fixture(options: ConstructorParameters<typeof AgentService>[4] = {}) {
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
    { spawn: spawnMock, terminateGraceMs: 100, persistDebounceMs: 5, ...options },
  );
  services.push(service);
  await service.init();
  async function tool(index: number, path: string, data = {}) {
    const env = (invocations[index][2] as { env: Record<string, string> }).env;
    const response = await fetch(`${env.LINUX_BUDDY_RUNTIME_URL}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.LINUX_BUDDY_RUNTIME_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  }
  return { service, children, invocations, tool, dir };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
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
  it('reuses one warm parent process and session for direct guidance and follow-ups', async () => {
    const { service, children, invocations } = await fixture();
    const first = await service.submit('Circle the save button');
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Circled Save.' }] });
    await settle();
    expect(service.list()[0].status).toBe('thinking');
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    const second = await service.submit('What next?');
    expect(second.conversationId).toBe(first.conversationId);
    expect(children).toHaveLength(1);
    const args = invocations[0][1] as string[];
    expect(args[args.indexOf('--tools') + 1]).toContain('desktop_draw');
    expect(args[args.indexOf('--tools') + 1]).not.toContain('desktop_action');
    const newId = await service.newConversation();
    expect((await service.submit('New topic')).conversationId).toBe(newId);
    expect(newId).not.toBe(first.conversationId);
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

  it('interrupts the parent for new speech while independent children keep running', async () => {
    const { service, children, tool } = await fixture();
    const first = await service.submit('research this');
    const started = await tool(0, '/tools/session_start', { title: 'Research', prompt: 'Find the answer' });
    expect(started.status).toBe(200);
    expect(started.data.status).toBe('running');
    expect(children).toHaveLength(2);
    const second = await service.submit('Guide me here');
    expect(second.conversationId).toBe(first.conversationId);
    expect(children).toHaveLength(3);
    expect(children[0].signals).toEqual(['SIGTERM']);
    expect(children[1].signals).toEqual([]);
    expect(service.list().find((t) => t.id === first.id)?.status).toBe('cancelled');
    expect(service.state().sessions.find((s) => s.id === started.data.id)?.status).toBe('running');
  });

  it('keeps cancellation terminal and idempotent despite late RPC completion', async () => {
    const { service, children } = await fixture();
    const task = await service.submit('cancel me');
    await service.cancel(task.id);
    await service.cancel(task.id);
    children[0].rpc({ type: 'agent_end' });
    children[0].rpc({ type: 'agent_settled' });
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
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    children[0].rpc({ type: 'agent_settled' });
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
    children[0].rpc({ type: 'agent_settled' });
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
    children[0].rpc({ type: 'agent_settled' });
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
    await service.resolveApproval(`${task.conversationId}:approval:1`, false);
    await expect(service.resolveApproval(`${task.conversationId}:approval:1`, true)).rejects.toThrow(
      'no longer active',
    );
    const sent = children[0].stdin.read()?.toString();
    expect(sent).toContain('"confirmed":false');
    expect(sent).toContain('"id":"approval:1"');

    children[0].rpc({ type: 'extension_ui_request', method: 'confirm', id: 'approval:2' });
    await settle();
    await service.cancel(task.id);
    await expect(service.resolveApproval(`${task.conversationId}:approval:2`, true)).rejects.toThrow(
      'no longer active',
    );
    await service.shutdown();
  });

  it('marks work terminal and terminates the active child during shutdown', async () => {
    const { service, children } = await fixture();
    const task = await service.submit('still running');
    await service.shutdown();
    expect(service.list().find((item) => item.id === task.id)?.status).toBe('failed');
    expect(children[0].signals).toContain('SIGTERM');
    await expect(service.submit('too late')).rejects.toThrow('shutting down');
  });
});

describe('parent and child runtime boundary', () => {
  it('rejects child UI, screen access and delegation even with a valid token', async () => {
    const { service, tool } = await fixture();
    await service.submit('Delegate');
    await service.startChild('Lookup', 'Research');
    for (const path of [
      '/tools/speak',
      '/tools/show_text',
      '/tools/session_start',
      '/tools/session_list',
      '/desktop/screenshot',
    ]) {
      expect((await tool(1, path, { text: 'Hi', title: 'Nested', prompt: 'Run' })).status).toBe(400);
    }
    expect((await tool(0, '/desktop/action', { action: 'click' })).status).toBe(400);
    expect((await tool(1, '/tools/task_report', { status: 'needs_input', text: 'Which folder?' })).status).toBe(200);
    expect(service.state().sessions.find((s) => s.role === 'child')).toMatchObject({
      status: 'needs_input',
      question: 'Which folder?',
    });
  });

  it('stores quiet child results and resumes the same saved session', async () => {
    const speak = vi.fn(async () => {});
    const { service, children, tool, invocations } = await fixture({ speak });
    await service.submit('Delegate');
    const child = await service.startChild('Lookup', 'Find answer');
    children[1].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'The answer is 42.' }] });
    children[1].rpc({ type: 'agent_settled' });
    await settle();
    expect(speak).not.toHaveBeenCalled();
    expect(service.state().presentation.text).toBe('');
    expect((await tool(0, '/tools/session_read', { id: child.id })).data.session).toMatchObject({
      status: 'completed',
      summary: 'The answer is 42.',
    });
    const resumed = await service.updateChild(child.id, 'Explain the result');
    expect(resumed.conversationId).toBe(child.id);
    const a = invocations[1][1] as string[],
      b = invocations[2][1] as string[];
    expect(a[a.indexOf('--session') + 1]).toBe(b[b.indexOf('--session') + 1]);
    await service.stopChild(child.id);
    expect(service.state().sessions.find((s) => s.id === child.id)?.status).toBe('cancelled');
  });

  it('keeps a child question resumable and caps active background tasks', async () => {
    const { service, children, tool } = await fixture({ maxChildren: 1 });
    await service.submit('Delegate');
    const child = await service.startChild('Lookup', 'Find answer');
    await tool(1, '/tools/task_report', { status: 'needs_input', text: 'Which folder?' });
    children[1].rpc({ type: 'agent_settled' });
    await settle();
    expect(service.state().sessions.find((s) => s.id === child.id)?.status).toBe('needs_input');
    await expect(service.startChild('Another', 'Run')).rejects.toThrow('already active');
    await service.stopChild(child.id);
    await service.startChild('Another', 'Run');
    await expect(service.updateChild(child.id, 'Resume')).rejects.toThrow('limit');
  });

  it('speaks once, preserves detailed text, and revokes tools between turns', async () => {
    const speak = vi.fn(async () => {});
    const { service, children, tool } = await fixture({ speak });
    await service.submit('Answer');
    await tool(0, '/tools/show_text', { text: 'Long detailed instructions', expanded: true });
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Brief answer.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(speak).toHaveBeenCalledExactlyOnceWith('Brief answer.');
    expect(service.state().presentation.text).toBe('Long detailed instructions');
    expect((await tool(0, '/tools/speak', { text: 'Late speech' })).status).toBe(401);
    await service.submit('Next');
    await tool(0, '/tools/show_text', { text: 'Keep these instructions visible', expanded: true });
    await tool(0, '/tools/speak', { text: 'Early answer.' });
    expect(service.state().presentation.text).toBe('Keep these instructions visible');
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Do not speak twice.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(speak).toHaveBeenCalledTimes(2);
  });

  it('restores the parent identity and marks unfinished children interrupted on restart', async () => {
    const { service, dir } = await fixture();
    const parentId = service.state().parentId;
    await service.submit('Delegate');
    const child = await service.startChild('Long job', 'Keep going');
    await service.shutdown();
    const restored = new AgentService(new TaskStore(join(dir, 'state.json')), settings, '/tmp/extension.mjs', {
      url: 'http://127.0.0.1:1',
    });
    services.push(restored);
    await restored.init();
    expect(restored.state().parentId).toBe(parentId);
    expect(restored.state().sessions.find((s) => s.id === child.id)?.status).toBe('interrupted');
    expect((await restored.searchSessions('Keep going'))[0].session.id).toBe(child.id);
  });
});
