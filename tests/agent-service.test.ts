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
import { FakeVoice } from './fake-voice.js';

const dirs: string[] = [];
const services: AgentService[] = [];
const settings: BuddySettings = {
  defaultCwd: process.cwd(),
  launchAtLogin: false,
  wakeWord: 'Friday',
  model: 'gpt-6-luna',
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

async function fixture(
  options: ConstructorParameters<typeof AgentService>[4] = {},
  bridgeOptions: Partial<ConstructorParameters<typeof AgentService>[3]> = {},
) {
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
    { url: 'http://127.0.0.1:1', beginRun: () => 'token', ...bridgeOptions },
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
  it('Stop cancels queued submissions and running children, clears presentation, and permits a fresh request', async () => {
    const voice = new FakeVoice();
    const { service, children, tool } = await fixture({ voice });
    await service.submit('Guide me');
    await tool(0, '/tools/interact', { actions: [{ tool: 'show_text_tool', args: { text: 'Look here.' } }] });
    await service.startChild('Research', 'Find the answer');
    const queued = service.submit('A queued request');
    const rejection = expect(queued).rejects.toThrow('Request stopped');
    await service.stop();
    await rejection;
    expect(service.list().every((task) => task.status === 'cancelled')).toBe(true);
    expect(service.state().presentation).toEqual({ text: '', expanded: false, speaking: false, echo: [] });
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.signals.includes('SIGTERM'))).toBe(true);
    expect((await tool(0, '/tools/session_start', { title: 'Late', prompt: 'Must not run' })).status).toBe(401);
    expect((await service.submit('A fresh voice request')).status).toBe('thinking');
    expect(children).toHaveLength(3);
    expect(voice.stops).toBeGreaterThan(0);
  });
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
    expect(args[args.indexOf('--tools') + 1]).toContain('interact');
    expect(args[args.indexOf('--tools') + 1]).not.toMatch(/desktop_draw|\bspeak\b|show_text|set_presentation/);
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
    await vi.waitFor(() => {
      const steps = service.list().find((t) => t.id === task.id)!.steps;
      expect(steps.find((s) => s.title === 'Looking at the screen')?.status).toBe('done');
      expect(steps.find((s) => s.title === 'Using desktop draw')).toMatchObject({
        status: 'failed',
        detail: 'Observe again',
      });
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

describe('fresh desktop readiness', () => {
  it('explains an interrupted request when its pending tool result was lost', async () => {
    const { service, children } = await fixture({}, { status: async () => ({ ready: true }) });
    const first = await service.submit('Click the test button');
    await service.desktopInterrupted(first.id, new DesktopError('Desktop session ended', 'lease_expired'));
    await service.submit('Why did that return no result?');
    const sent = JSON.parse(children[1].stdin.read().toString()).message;
    expect(sent).toContain('Missing historical tool results mean the request was interrupted');
    expect(sent).toContain('lastInterruptedRequest');
    expect(sent).toContain('desktop connection timed out');
    expect(sent).toContain('"ready":true');
  });
  it('refreshes a recovered extension in the same saved parent conversation', async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({ ready: false, protocolVersion: 5, error: 'Sign out and back in.' })
      .mockResolvedValueOnce({ ready: true, protocolVersion: 6 });
    const { service, children } = await fixture({}, { status });
    const first = await service.submit('Open the app');
    const previous = JSON.parse(children[0].stdin.read().toString()).message;
    expect(previous).toContain('"ready":false');
    expect(previous).toContain('Sign out and back in.');
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Please sign in again.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    const retry = await service.submit('I signed back in. Check again.');
    const current = JSON.parse(children[0].stdin.read().toString()).message;
    expect(retry.conversationId).toBe(first.conversationId);
    expect(children).toHaveLength(1);
    expect(status).toHaveBeenCalledTimes(2);
    expect(current).toContain('"ready":true');
    expect(current).toContain('"protocolVersion":6');
    expect(current).not.toContain('Sign out and back in.');
  });
  it('does not check or send desktop readiness to background children', async () => {
    const status = vi.fn(async () => ({ ready: true }));
    const { service, children } = await fixture({}, { status });
    await service.startChild('Research', 'Read project files');
    expect(status).not.toHaveBeenCalled();
    expect(children[0].stdin.read().toString()).not.toContain('Friday desktop status');
  });
  it.each(['failure', 'timeout'])('keeps conversation available after a status %s', async (mode) => {
    const status = vi.fn(() =>
      mode === 'timeout' ? new Promise<never>(() => {}) : Promise.reject(new Error('Disconnected')),
    );
    const { service, children } = await fixture({}, { status });
    await service.submit('Hello');
    const sent = JSON.parse(children[0].stdin.read().toString()).message;
    expect(sent).toContain('"ready":"unknown"');
    expect(sent).not.toContain('"ready":false');
    expect(status).toHaveBeenCalledOnce();
  });
  it('does not send a queued prompt when Stop arrives during the readiness check', async () => {
    let finish!: (value: { ready: boolean }) => void;
    const status = vi.fn(
      () =>
        new Promise<{ ready: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    const { service, children } = await fixture({}, { status });
    const pending = service.submit('Open the app');
    await vi.waitFor(() => expect(status).toHaveBeenCalledOnce());
    await service.stop();
    finish({ ready: true });
    expect((await pending).status).toBe('cancelled');
    expect(children[0].stdin.read()?.toString()).not.toContain('"type":"prompt"');
  });
});

describe('parent and child runtime boundary', () => {
  it('speaks progress on the progress lane but never auto-speaks the final reply', async () => {
    const voice = new FakeVoice();
    voice.instant = true;
    const { service, children } = await fixture({ voice });
    const task = await service.submit('Click the button', { source: 'voice' });
    service.controlProgress(task.id, 'Clicking', 'Opening it now.');
    expect(voice.started).toEqual(['Opening it now.']);
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Opened and verified.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(voice.started).toEqual(['Opening it now.']);
    expect(service.list()[0]).toMatchObject({ status: 'completed', response: 'Opened and verified.' });
    // Shown silently because no interact reached the user.
    expect(service.state().presentation).toMatchObject({ text: 'Opened and verified.', expanded: true });
    expect(service.list()[0].steps.some((s) => s.title === 'Final reply shown without speech')).toBe(true);
    expect(() => service.readAloud(task.id)).toThrow('on screen');
  });
  it('keeps progress out of reply presentation and Read aloud', async () => {
    const voice = new FakeVoice();
    const { service } = await fixture({ voice });
    const task = await service.submit('Click the button', { source: 'voice' });
    const presentation = { ...service.state().presentation };
    service.controlProgress(task.id, 'Opening the app', 'Opening it now.');
    expect(service.state().presentation).toMatchObject({ text: presentation.text, expanded: presentation.expanded });
    expect(service.list()[0].speechText).toBeUndefined();
    expect(service.list()[0].spoken).toBeFalsy();
  });
  it.each(['invalid', 'muted', 'silenced', 'typed'])(
    'drops %s progress speech without changing reply state',
    async (mode) => {
      const voice = new FakeVoice();
      const { service } = await fixture({ voice });
      const task = await service.submit('Click the button', { source: mode === 'typed' ? 'typed' : 'voice' });
      if (mode === 'muted') await service.updateSettings({ autoSpeak: false });
      if (mode === 'silenced') service.silence();
      service.controlProgress(
        task.id,
        'Opening the app',
        mode === 'invalid' ? Array(80).fill('detail').join(' ') : 'Opening it now.',
      );
      await settle();
      expect(voice.utterances).toHaveLength(0);
      expect(service.list()[0].speechIssue).toBeUndefined();
      expect(service.list()[0].speechText).toBeUndefined();
    },
  );
  it('drops progress while an answer is playing and while previous progress is playing', async () => {
    const voice = new FakeVoice();
    voice.instant = true;
    const { service, tool } = await fixture({ voice, interactSyncWaitMs: 20 });
    const task = await service.submit('Click the button', { source: 'voice' });
    await tool(0, '/tools/interact', { actions: [{ tool: 'speak_tool', args: { text: 'I can open the app.' } }] });
    service.controlProgress(task.id, 'Working', 'Opening it now.');
    expect(voice.started).toEqual(['I can open the app.']);
    voice.last!.finish();
    await settle();
    service.controlProgress(task.id, 'Working', 'Opening it now.');
    service.controlProgress(task.id, 'Still working', 'Checking the app.');
    expect(voice.started).toEqual(['I can open the app.', 'Opening it now.']);
    expect(voice.last!.state()).toBe('playing');
    expect(service.list()[0].speechText).toBe('I can open the app.');
  });
  it('rejects child UI, screen access and delegation even with a valid token', async () => {
    const { service, tool } = await fixture();
    await service.submit('Delegate');
    await service.startChild('Lookup', 'Research');
    for (const path of [
      '/tools/interact',
      '/tools/speak',
      '/tools/show_text',
      '/tools/session_start',
      '/tools/session_list',
      '/desktop/screenshot',
      '/desktop/control',
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
    const voice = new FakeVoice();
    const { service, children, tool, invocations } = await fixture({ voice });
    await service.submit('Delegate');
    const child = await service.startChild('Lookup', 'Find answer');
    children[1].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'The answer is 42.' }] });
    children[1].rpc({ type: 'agent_settled' });
    await settle();
    expect(voice.utterances).toHaveLength(0);
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

  it('stops every unfinished background task from one tool call and keeps the parent turn', async () => {
    const { service, children, tool } = await fixture({ maxChildren: 3 });
    const parent = await service.submit('Delegate');
    const done = await service.startChild('Done', 'Finish quickly');
    children[1].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Finished.' }] });
    children[1].rpc({ type: 'agent_settled' });
    await settle();
    const running = await service.startChild('Running', 'Keep going');
    const waiting = await service.startChild('Waiting', 'Ask first');
    await tool(3, '/tools/task_report', { status: 'needs_input', text: 'Which folder?' });
    children[3].rpc({ type: 'agent_settled' });
    await settle();
    const result = await tool(0, '/tools/stop_all', {});
    expect(result.status).toBe(200);
    expect(result.data.stopped.map((s: { id: string }) => s.id).sort()).toEqual([running.id, waiting.id].sort());
    const status = (id: string) => service.state().sessions.find((s) => s.id === id)?.status;
    expect(status(running.id)).toBe('cancelled');
    expect(status(waiting.id)).toBe('cancelled');
    expect(status(done.id)).toBe('completed');
    expect(service.list().find((t) => t.id === parent.id)?.status).not.toBe('cancelled');
    expect((await tool(0, '/tools/stop_all', {})).data.stopped).toEqual([]);
    await service.shutdown();
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

  it('keeps interact text over the final reply and revokes tools between turns', async () => {
    const voice = new FakeVoice();
    voice.instant = true;
    const { service, children, tool } = await fixture({ voice });
    await service.submit('Answer', { source: 'voice' });
    await tool(0, '/tools/interact', {
      actions: [
        { tool: 'speak_tool', args: { text: 'Brief answer.' } },
        { tool: 'show_text_tool', args: { text: 'Long detailed instructions' } },
      ],
    });
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Do not show or speak this.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(voice.started).toEqual(['Brief answer.']);
    expect(service.state().presentation.text).toBe('Long detailed instructions');
    expect(
      (await tool(0, '/tools/interact', { actions: [{ tool: 'speak_tool', args: { text: 'Late.' } }] })).status,
    ).toBe(401);
  });
  it('starts a fresh parent session on restart and keeps earlier sessions searchable', async () => {
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
    expect(restored.state().parentId).not.toBe(parentId);
    const previous = restored.state().sessions.find((s) => s.id === parentId);
    expect(previous?.role).toBe('parent');
    const interrupted = restored.state().sessions.find((s) => s.id === child.id);
    expect(interrupted?.status).toBe('interrupted');
    expect(interrupted?.parentId).toBe(parentId);
    expect((await restored.searchSessions('Keep going')).map((r) => r.session.id)).toContain(child.id);
    expect((await restored.searchSessions('Delegate')).map((r) => r.session.id)).toContain(parentId);
  });
});

describe('Selected background task context', () => {
  it('resolves a fresh snapshot on submission and preserves the parent and running child', async () => {
    const { service, children, tool } = await fixture();
    const child = await service.startChild('Read release notes', 'Find the changes');
    await tool(0, '/tools/task_report', { status: 'running', text: 'Fresh progress after selection' });
    const parentId = service.state().parentId;
    const request = await service.submit('What has changed so far?', { selectedChildId: child.id });
    expect(request.conversationId).toBe(parentId);
    expect(children[0].signals).toEqual([]);
    const sent = children[1].stdin.read()?.toString() || '';
    expect(sent).toContain('Selected background task');
    expect(sent).toContain(child.id);
    expect(sent).toContain('snapshotAt');
    expect(sent).toContain('Fresh progress after selection');
    expect(sent).toContain('Read release notes');
    await service.cancel(request.id);
    expect(service.state().sessions.find((s) => s.id === child.id)?.status).toBe('running');
  });
  it('rejects an unknown or parent subject before starting a turn', async () => {
    const { service, children } = await fixture();
    await expect(service.submit('Look at it', { selectedChildId: 'missing' })).rejects.toThrow('Unknown session');
    await expect(service.submit('Look at it', { selectedChildId: service.state().parentId })).rejects.toThrow(
      'background child',
    );
    expect(children).toHaveLength(0);
  });
});

describe('session actions without attached speech', () => {
  const start = (title: string) => ({ kind: 'start', title, prompt: 'Wait, then calculate.' });
  it('runs a batch once and leaves confirmation to interact', async () => {
    const voice = new FakeVoice();
    const { service, tool } = await fixture({ voice });
    await service.submit('Start two calculations', { source: 'voice' });
    const result = await tool(0, '/tools/session_actions', { actions: [start('Orchid'), start('Flint')] });
    expect(result.data).toMatchObject({ ok: true, effects: 'applied' });
    expect(result.data.speech).toBeUndefined();
    expect(voice.utterances).toHaveLength(0);
    expect(service.state().sessions.filter((s) => s.role === 'child' && s.status === 'running')).toHaveLength(2);
    expect((await tool(0, '/tools/session_actions', { actions: [start('Again')] })).data.effects).toBe('none');
    const confirm = await tool(0, '/tools/interact', {
      actions: [{ tool: 'speak_tool', args: { text: 'Both calculations have started.' } }],
    });
    expect(confirm.data.status).toBe('in_progress');
    expect(voice.started).toEqual(['Both calculations have started.']);
  });
  it.each([
    { actions: [start('Valid')], confirmation: 'Started.' },
    { actions: [start('Valid'), { kind: 'stop', id: 'missing' }] },
    { actions: [start('Valid'), { kind: 'update', id: 4, prompt: 'Go' }] },
    { actions: [start('Valid'), { kind: 'erase' }] },
    { actions: [start('Valid')], extra: true },
    { actions: [start('Valid'), { ...start('Bad'), surprise: true }] },
    { actions: [] },
  ])('prevalidates all input with no effects: %j', async (data) => {
    const { service, tool } = await fixture();
    await service.submit('Start work');
    const result = await tool(0, '/tools/session_actions', data);
    expect(result.data).toMatchObject({ ok: false, effects: 'none', results: [] });
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(0);
    expect((await tool(0, '/tools/session_actions', { actions: [start('Corrected')] })).data.ok).toBe(true);
  });
  it('reports partial effects and rejects whole-operation retry', async () => {
    const { service, tool } = await fixture();
    await service.submit('Start two');
    const original = service.startChild.bind(service);
    vi.spyOn(service, 'startChild')
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error('Synthetic failure'));
    const data = { actions: [start('Orchid'), start('Flint')] };
    const result = await tool(0, '/tools/session_actions', data);
    expect(result.data).toMatchObject({ ok: false, effects: 'possible' });
    expect(result.data.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, false]);
    expect((await tool(0, '/tools/session_actions', data)).data.effects).toBe('none');
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(1);
  });
  it.each(['cancel', 'replace', 'silence', 'approval'] as const)(
    'reports the truth when %s occurs during awaited effects',
    async (mode) => {
      const voice = new FakeVoice();
      const { service, tool, children } = await fixture({ voice });
      const task = await service.submit('Start work');
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((r) => {
        entered = r;
      });
      const original = service.startChild.bind(service);
      vi.spyOn(service, 'startChild').mockImplementationOnce(async (...args) => {
        const child = await original(...args);
        entered();
        await new Promise<void>((r) => {
          release = r;
        });
        return child;
      });
      const pending = tool(0, '/tools/session_actions', { actions: [start('Orchid'), start('Flint')] });
      await ready;
      if (mode === 'cancel') await service.cancel(task.id);
      if (mode === 'replace') await service.submit('New question');
      if (mode === 'silence') service.silence();
      if (mode === 'approval') {
        children[0].rpc({ type: 'extension_ui_request', method: 'confirm', id: 'a', title: 'Approve', message: 'Go?' });
        await settle();
      }
      release();
      const result = await pending;
      if (mode === 'silence') expect(result.data.ok).toBe(true);
      else expect(result.data).toMatchObject({ ok: false, effects: 'possible' });
      expect(voice.utterances).toHaveLength(0);
    },
  );
  it('reports shutdown during awaited effects without speaking', async () => {
    const voice = new FakeVoice();
    const { service, tool } = await fixture({ voice });
    await service.submit('Start work');
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const original = service.startChild.bind(service);
    vi.spyOn(service, 'startChild').mockImplementationOnce(async (...args) => {
      const child = await original(...args);
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
      return child;
    });
    const pending = tool(0, '/tools/session_actions', { actions: [start('Orchid'), start('Flint')] });
    void pending.catch(() => {});
    await ready;
    await service.shutdown();
    release();
    const result = await pending.catch(() => undefined);
    if (result) expect(result.data.ok).toBe(false);
    expect(voice.utterances).toHaveLength(0);
  });
  it('rejects a parallel batch while another is pending', async () => {
    const { service, tool } = await fixture();
    await service.submit('Start work');
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const original = service.startChild.bind(service);
    vi.spyOn(service, 'startChild').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
      return result;
    });
    const first = tool(0, '/tools/session_actions', { actions: [start('Orchid')] });
    await ready;
    expect((await tool(0, '/tools/session_actions', { actions: [start('Flint')] })).data.effects).toBe('none');
    release();
    expect((await first).data.ok).toBe(true);
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(1);
  });
  it('isolates targeted update and stop from the other child, and children cannot act', async () => {
    const { service, tool, children } = await fixture();
    await service.submit('Start two');
    expect((await tool(0, '/tools/session_actions', { actions: [start('Orchid'), start('Flint')] })).data.ok).toBe(
      true,
    );
    const finish = async () => {
      children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Done.' }] });
      children[0].rpc({ type: 'agent_settled' });
      await settle();
    };
    const [a, b] = service.state().sessions.filter((s) => s.role === 'child');
    expect((await tool(1, '/tools/session_actions', { actions: [start('Forbidden')] })).status).toBe(400);
    await finish();
    await service.submit('Update Orchid');
    const update = await tool(0, '/tools/session_actions', {
      actions: [{ kind: 'update', id: a.id, prompt: 'New numbers' }],
    });
    expect(update.data).toMatchObject({ ok: true });
    await finish();
    await service.submit('Stop Orchid');
    expect((await tool(0, '/tools/session_actions', { actions: [{ kind: 'stop', id: a.id }] })).data).toMatchObject({
      ok: true,
    });
    expect(service.state().sessions.find((s) => s.id === b.id)).toMatchObject({
      status: 'running',
      latestTaskId: b.latestTaskId,
    });
  });
  it('reports failure if an earlier child failed while a later action was pending', async () => {
    const { service, tool, children } = await fixture();
    await service.submit('Start two');
    const original = service.startChild.bind(service);
    vi.spyOn(service, 'startChild')
      .mockImplementationOnce(original)
      .mockImplementationOnce(async (...args) => {
        children[1].finish(1);
        await settle();
        return original(...args);
      });
    expect((await tool(0, '/tools/session_actions', { actions: [start('Orchid'), start('Flint')] })).data.ok).toBe(
      false,
    );
  });
  it('rejects a replaced child identity after awaiting an action', async () => {
    const { service, tool } = await fixture();
    await service.submit('Start work');
    const original = service.startChild.bind(service);
    vi.spyOn(service, 'startChild')
      .mockImplementationOnce(original)
      .mockImplementationOnce(async (...args) => {
        const a = service.state().sessions.find((s) => s.role === 'child')!;
        await service.updateChild(a.id, 'Replacement request');
        return original(...args);
      });
    expect((await tool(0, '/tools/session_actions', { actions: [start('Orchid'), start('Flint')] })).data.ok).toBe(
      false,
    );
  });
  it('prevalidates capacity and refuses parent IDs before effects', async () => {
    const { service, tool } = await fixture({ maxChildren: 1 });
    const parent = await service.submit('Start work');
    for (const actions of [[start('A'), start('B')], [{ kind: 'stop', id: parent.conversationId }]]) {
      expect((await tool(0, '/tools/session_actions', { actions })).data.effects).toBe('none');
      expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(0);
    }
  });
  it('reports failure when child approval is pending and preserves the approval controls', async () => {
    const { service, tool, children } = await fixture();
    await service.submit('Start work');
    const original = service.startChild.bind(service);
    vi.spyOn(service, 'startChild').mockImplementationOnce(async (...args) => {
      const child = await original(...args);
      children[1].rpc({
        type: 'extension_ui_request',
        method: 'confirm',
        id: 'p',
        title: 'Approve',
        message: 'Allow?',
      });
      await settle();
      return child;
    });
    expect((await tool(0, '/tools/session_actions', { actions: [start('Orchid')] })).data.ok).toBe(false);
    const child = service.list().find((t) => t.role === 'child')!;
    expect(child.status).toBe('awaiting_approval');
  });
  it('checks the returned action identity rather than adopting a replacement during the await', async () => {
    const { service, tool } = await fixture();
    await service.submit('Start work');
    const original = service.startChild.bind(service);
    vi.spyOn(service, 'startChild').mockImplementationOnce(async (...args) => {
      const accepted = await original(...args);
      await service.updateChild(accepted.id, 'A different request');
      return accepted;
    });
    expect((await tool(0, '/tools/session_actions', { actions: [start('Orchid')] })).data.ok).toBe(false);
  });
  it('preserves approval and Stop checks before any effects', async () => {
    const { service, tool, children } = await fixture();
    const task = await service.submit('Start work');
    children[0].rpc({ type: 'extension_ui_request', method: 'confirm', id: 'a', title: 'Approve', message: 'Go?' });
    await settle();
    expect((await tool(0, '/tools/session_actions', { actions: [start('A')] })).data.effects).toBe('none');
    await service.cancel(task.id);
    expect((await tool(0, '/tools/session_actions', { actions: [start('A')] })).status).toBe(401);
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(0);
  });
});

describe('interact through the parent runtime', () => {
  const say = (text: string) => ({ tool: 'speak_tool', args: { text } });
  const show = (text: string) => ({ tool: 'show_text_tool', args: { text } });
  const circle = { kind: 'circle', x: 100, y: 100, width: 80, height: 40 };
  const observation = () => ({
    id: 'obs-1',
    display: { id: 'display-1', x: 0, y: 0, width: 1000, height: 800, scale: 1 },
    width: 1000,
    height: 800,
    capturedAt: Date.now(),
    focus: 'window',
    scene: 1,
  });
  async function screen(options: { observed?: boolean; drawError?: string } = {}) {
    const voice = new FakeVoice();
    const drawings: unknown[] = [];
    const log: string[] = [];
    const current = options.observed === false ? undefined : observation();
    voice.instant = true;
    const f = await fixture({ voice, interactSyncWaitMs: 1000 }, {
      latestObservation: () => current,
      presentDrawing: async (_runId: string, drawing: { items: Array<{ id: string }> }) => {
        log.push('draw');
        if (options.drawError) throw new Error(options.drawError);
        drawings.push(drawing);
        return { ids: drawing.items.map((item) => item.id) };
      },
    } as never);
    /** Calls a runtime tool as the current parent worker (a replaced busy turn gets a new worker). */
    const ask = (path: string, data = {}) => {
      const index = f.invocations.findLastIndex(
        (args) => (args[2] as { env: Record<string, string> }).env.LINUX_BUDDY_ROLE === 'parent',
      );
      return f.tool(index, path, data);
    };
    return { ...f, voice, drawings, log, ask };
  }
  it('speaks voice requests and shows typed requests as text unless the user opted in', async () => {
    const { service, ask, voice } = await screen();
    await service.submit('What time is it?', { source: 'voice' });
    const spoken = await ask('/tools/interact', { actions: [say('It is noon.')] });
    expect(spoken.data.actions[0].status).toBe('scheduled');
    expect(voice.started).toEqual(['It is noon.']);
    await service.submit('And tomorrow?', { source: 'typed' });
    const typed = await ask('/tools/interact', { actions: [say('Tomorrow is Friday.')] });
    expect(typed.data.actions[0]).toMatchObject({ status: 'suppressed', reason: expect.stringContaining('Typed') });
    expect(service.state().presentation).toMatchObject({ text: 'Tomorrow is Friday.', expanded: true });
    expect(voice.utterances).toHaveLength(1);
    await service.updateSettings({ speakTypedReplies: true });
    await service.submit('And after?', { source: 'typed' });
    await ask('/tools/interact', { actions: [say('Then Saturday.')] });
    expect(voice.started).toEqual(['It is noon.', 'Then Saturday.']);
    await service.updateSettings({ autoSpeak: false });
    await service.submit('Muted?', { source: 'voice' });
    const muted = await ask('/tools/interact', { actions: [say('Spoken replies are off.')] });
    expect(muted.data.actions[0].status).toBe('suppressed');
    expect(voice.started).toHaveLength(2);
  });
  it('validates the whole batch before any effect', async () => {
    const { service, ask, voice, log } = await screen({ observed: false });
    await service.submit('Show me', { source: 'voice' });
    const before = structuredClone(service.state().presentation);
    const result = await ask('/tools/interact', {
      actions: [say('Look here.'), show('Details'), { tool: 'draw_tool', args: { items: [circle] } }],
    });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ status: 'rejected', effects: 'none' });
    expect(result.data.errors[0]).toMatchObject({ code: 'observe_required', path: 'actions[2].args.items' });
    expect(voice.utterances).toHaveLength(0);
    expect(log).toEqual([]);
    expect(service.state().presentation.text).toBe(before.text);
    expect(service.list()[0].interactions ?? []).toHaveLength(0);
  });
  it('binds the latest observation, assigns annotation IDs and reveals together at speech start', async () => {
    const { service, ask, voice, drawings, log } = await screen();
    voice.instant = false;
    await service.submit('Where is save?', { source: 'voice' });
    const pending = ask('/tools/interact', {
      actions: [say('Click Save here.'), { tool: 'draw_tool', args: { items: [circle] } }],
      timing: 'together',
    });
    await vi.waitFor(() => expect(voice.utterances).toHaveLength(1));
    expect(log).toEqual([]);
    voice.last!.arrive();
    const result = await pending;
    expect(drawings[0]).toMatchObject({ observationId: 'obs-1', displayId: 'display-1' });
    expect(result.data.actions.find((a: { tool: string }) => a.tool === 'draw_tool')).toMatchObject({
      status: 'completed',
      ids: [expect.stringMatching(/^friday-ix-/)],
    });
    expect(result.data.actions.find((a: { tool: string }) => a.tool === 'speak_tool').status).toBe('scheduled');
    expect(service.list()[0].timings.firstDrawingMs).toBeGreaterThanOrEqual(0);
  });
  it('returns a duplicate for an exact retry and never repeats audio', async () => {
    const { service, ask, voice } = await screen();
    await service.submit('Hello', { source: 'voice' });
    const call = { actions: [say('Hello there.'), show('Hi')] };
    const first = await ask('/tools/interact', call);
    const again = await ask('/tools/interact', call);
    expect(again.data).toMatchObject({ status: 'duplicate', effects: 'none', duplicateOf: first.data.interactionId });
    const reworded = await ask('/tools/interact', { actions: [say('Hello there.'), show('Different text')] });
    expect(reworded.data).toMatchObject({ status: 'rejected', errors: [{ code: 'duplicate_speech' }] });
    expect(voice.utterances).toHaveLength(1);
    expect(service.list()[0].interactions).toHaveLength(1);
  });
  it('rejects new speech while this request is still speaking, but allows visuals', async () => {
    const { service, ask, voice } = await screen();
    await service.submit('Explain', { source: 'voice' });
    await ask('/tools/interact', { actions: [say('First part.')] });
    const busy = await ask('/tools/interact', { actions: [say('Second part.')] });
    expect(busy.data).toMatchObject({ status: 'rejected', errors: [{ code: 'busy' }] });
    expect(voice.last!.text).toBe('First part.');
    expect(voice.last!.state()).toBe('playing');
    const visual = await ask('/tools/interact', { actions: [show('Extra detail')] });
    expect(visual.data.status).toBe('completed');
    voice.last!.finish();
    await settle();
    expect((await ask('/tools/interact', { actions: [say('Second part.')] })).data.status).toBe('in_progress');
  });
  it('rejects a second group while an earlier one of the same request is still revealing', async () => {
    const { service, ask, voice } = await screen();
    voice.instant = false;
    await service.submit('Explain', { source: 'voice' });
    const first = ask('/tools/interact', { actions: [say('Look.'), show('One')], timing: 'together' });
    await vi.waitFor(() => expect(voice.utterances).toHaveLength(1));
    const second = await ask('/tools/interact', { actions: [show('Two')] });
    expect(second.data).toMatchObject({ status: 'rejected', errors: [{ code: 'busy' }] });
    voice.last!.arrive();
    expect((await first).data.status).toBe('in_progress');
  });
  it('allows one speech rewrite, then requires text, without any effect from the rejected batches', async () => {
    const { service, ask, voice, log } = await screen();
    await service.submit('Explain', { source: 'voice' });
    const before = structuredClone(service.state().presentation);
    const mixed = (text: string) => ({
      actions: [say(text), show('Detail'), { tool: 'draw_tool', args: { items: [circle] } }],
      timing: 'together',
    });
    const bad = await ask('/tools/interact', mixed('**Markup**'));
    expect(bad.data).toMatchObject({ status: 'rejected', effects: 'none', errors: [{ code: 'speech_policy' }] });
    expect(bad.data.errors[0].retry).toContain('Rewrite');
    const worse = await ask('/tools/interact', mixed('`code`'));
    expect(worse.data).toMatchObject({ status: 'rejected', effects: 'none' });
    expect(worse.data.errors[0].retry).toContain('used up');
    const after = await ask('/tools/interact', mixed('Now valid.'));
    expect(after.data.errors[0]).toMatchObject({ code: 'speech_exhausted' });
    expect(service.state().presentation).toEqual(before);
    expect(log).toEqual([]);
    expect(voice.utterances).toHaveLength(0);
    expect(service.list()[0].interactions ?? []).toHaveLength(0);
    expect((await ask('/tools/interact', { actions: [show('Now valid.')] })).data.status).toBe('completed');
    expect(service.state().presentation).toMatchObject({ text: 'Now valid.', expanded: true });
    expect(service.list()[0].speechIssue).toBe('Spoken reply unavailable for this request.');
  });
  it('keeps speaking after the turn settles, and a new request interrupts it in the same conversation', async () => {
    const { service, ask, voice, children } = await screen();
    const first = await service.submit('Tell me a story', { source: 'voice' });
    await ask('/tools/interact', { actions: [say('Once upon a time.')] });
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Once upon a time.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(voice.last!.state()).toBe('playing');
    expect(service.state().presentation.speaking).toBe(true);
    const second = await service.submit('Actually, stop and tell me the time', { source: 'voice' });
    expect(second.conversationId).toBe(first.conversationId);
    expect(voice.utterances[0].state()).toBe('cancelled');
    await settle();
    const record = service.list().find((t) => t.id === first.id)!.interactions![0];
    expect(record.actions[0]).toMatchObject({
      status: 'interrupted',
      playback: { interrupted: true, heardWords: 'unknown' },
    });
    const prompt = JSON.parse(children[0].stdin.read().toString().trim().split('\n').at(-1)!).message as string;
    expect(prompt).toContain('"source":"voice"');
    expect(prompt).toContain('"interrupted":true');
    expect(prompt).toContain('"heardWords":"unknown"');
  });
  it('replaces an unfinished busy turn when a voice correction arrives', async () => {
    const { service, children } = await screen();
    const first = await service.submit('Open the settings', { source: 'voice' });
    const second = await service.submit('No, the other settings', { source: 'voice' });
    expect(service.list().find((t) => t.id === first.id)?.status).toBe('cancelled');
    expect(second.status).toBe('thinking');
    expect(children).toHaveLength(2);
    const prompt = JSON.parse(children[1].stdin.read().toString().trim().split('\n').at(-1)!).message as string;
    expect(prompt).toContain('Replaced by this request');
  });
  it('barge-in stops audio and keeps the old turn silent until a new request, without touching children', async () => {
    const { service, ask, voice } = await screen();
    await service.submit('Explain', { source: 'voice' });
    await service.startChild('Research', 'Look it up');
    await ask('/tools/interact', { actions: [say('Here is a long answer.')] });
    service.interrupt();
    expect(voice.last!.state()).toBe('cancelled');
    expect(service.state().presentation.speaking).toBe(false);
    const late = await ask('/tools/interact', { actions: [say('And another thing.')] });
    expect(late.data.actions[0]).toMatchObject({ status: 'suppressed', reason: expect.stringContaining('stopped') });
    service.controlProgress(service.list()[0].id, 'Working', 'Still going.');
    expect(voice.started).toEqual(['Here is a long answer.']);
    expect(service.state().sessions.find((s) => s.role === 'child')?.status).toBe('running');
    await service.submit('What I meant was this', { source: 'voice' });
    await ask('/tools/interact', { actions: [say('Got it.')] });
    expect(voice.started).toEqual(['Here is a long answer.', 'Got it.']);
  });
  it('barge-in during a together wait cancels the unrevealed group with no effects', async () => {
    const { service, ask, voice, log } = await screen();
    voice.instant = false;
    await service.submit('Show me', { source: 'voice' });
    const pending = ask('/tools/interact', {
      actions: [say('Right here.'), { tool: 'draw_tool', args: { items: [circle] } }],
      timing: 'together',
    });
    await vi.waitFor(() => expect(voice.utterances).toHaveLength(1));
    service.interrupt();
    const result = await pending;
    expect(result.data).toMatchObject({ status: 'cancelled', effects: 'none' });
    expect(log).toEqual([]);
    expect(voice.started).toEqual([]);
  });
  it('a drawing failure suppresses paired speech with actionable guidance', async () => {
    const { service, ask, voice } = await screen({ drawError: 'Observe again: a newer screenshot replaced this one' });
    voice.instant = false;
    await service.submit('Show me', { source: 'voice' });
    const pending = ask('/tools/interact', {
      actions: [say('Right here.'), { tool: 'draw_tool', args: { items: [circle] } }],
      timing: 'together',
    });
    await vi.waitFor(() => expect(voice.utterances).toHaveLength(1));
    voice.last!.arrive();
    const result = await pending;
    expect(result.data.actions).toMatchObject([
      { tool: 'speak_tool', status: 'suppressed' },
      { tool: 'draw_tool', status: 'failed' },
    ]);
    expect(result.data.guidance).toContain('Observe again');
    expect(voice.started).toEqual([]);
  });
  it('validates a new submission before interrupting current speech', async () => {
    const { service, ask, voice } = await screen();
    await service.submit('Explain', { source: 'voice' });
    await ask('/tools/interact', { actions: [say('Still talking.')] });
    const stops = voice.stops;
    await expect(service.submit('   ', { source: 'voice' })).rejects.toThrow();
    await expect(service.submit('Hi', { source: 'shout' as never })).rejects.toThrow('source');
    await expect(service.submit('Hi', { selectedChildId: 'missing' })).rejects.toThrow('Unknown session');
    expect(voice.last!.state()).toBe('playing');
    expect(voice.stops).toBe(stops);
  });
  it('replays only validated reply speech through the shared channel', async () => {
    const { service, ask, voice, children } = await screen();
    const task = await service.submit('Explain', { source: 'voice' });
    await ask('/tools/interact', { actions: [say('Short answer.')] });
    voice.last!.finish();
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Short answer.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    const replay = service.readAloud(task.id);
    expect(voice.started).toEqual(['Short answer.', 'Short answer.']);
    voice.last!.finish();
    await replay;
  });
  it('publishes current speech for renderer echo suppression', async () => {
    const { service, ask, voice } = await screen();
    await service.submit('Explain', { source: 'voice' });
    await ask('/tools/interact', { actions: [say('Click the blue button.')] });
    expect(service.state().presentation.echo).toEqual([{ text: 'Click the blue button.' }]);
    const before = Date.now();
    voice.last!.finish();
    await settle();
    const [ended] = service.state().presentation.echo!;
    expect(ended.text).toBe('Click the blue button.');
    expect(ended.endedAt).toBeGreaterThanOrEqual(before);
    expect(ended.endedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('mixed spoken answer and action-only work', () => {
  const actions = [{ kind: 'start', title: 'Disk report', prompt: 'Report disk usage.' }];
  const say = (text: string) => ({ actions: [{ tool: 'speak_tool', args: { text } }] });
  it.each([false, true])(
    'runs actions once after an interact answer and never speaks the final (muted: %s)',
    async (muted) => {
      const voice = new FakeVoice();
      voice.instant = true;
      const { service, tool, children } = await fixture({ voice, interactSyncWaitMs: 1000 });
      await service.updateSettings({ autoSpeak: !muted });
      await service.submit('What time zone am I in, and start a disk report', { source: 'voice' });
      const answer = await tool(0, '/tools/interact', say('You are in India Standard Time.'));
      expect(answer.data.actions[0].status).toBe(muted ? 'suppressed' : 'scheduled');
      expect((await tool(0, '/tools/session_actions', { actions })).data).toMatchObject({
        ok: true,
        effects: 'applied',
      });
      expect((await tool(0, '/tools/session_actions', { actions })).data).toMatchObject({ ok: false, effects: 'none' });
      expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(1);
      children[0].rpc({
        type: 'agent_end',
        messages: [{ role: 'assistant', content: 'The disk report has started.' }],
      });
      children[0].rpc({ type: 'agent_settled' });
      await settle();
      expect(voice.started).toEqual(muted ? [] : ['You are in India Standard Time.']);
    },
  );
  it('retains non-repeat protection after partial action-only effects', async () => {
    const voice = new FakeVoice();
    voice.instant = true;
    const { service, tool } = await fixture({ voice, interactSyncWaitMs: 1000 });
    await service.submit('Answer and start two reports', { source: 'voice' });
    await tool(0, '/tools/interact', say('Your answer is four.'));
    const original = service.startChild.bind(service);
    vi.spyOn(service, 'startChild')
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error('Synthetic failure'));
    const batch = { actions: [...actions, { kind: 'start', title: 'Second report', prompt: 'Report memory usage.' }] };
    expect((await tool(0, '/tools/session_actions', batch)).data).toMatchObject({
      ok: false,
      effects: 'possible',
      results: [{ ok: true }, { ok: false }],
    });
    expect((await tool(0, '/tools/session_actions', batch)).data.effects).toBe('none');
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(1);
  });
  it('preserves approval and Stop checks before action-only effects after an answer', async () => {
    const voice = new FakeVoice();
    voice.instant = true;
    const { service, tool, children } = await fixture({ voice, interactSyncWaitMs: 1000 });
    const task = await service.submit('Answer and start work', { source: 'voice' });
    await tool(0, '/tools/interact', say('Your answer is four.'));
    children[0].rpc({ type: 'extension_ui_request', method: 'confirm', id: 'a', title: 'Approve', message: 'Go?' });
    await settle();
    expect((await tool(0, '/tools/session_actions', { actions })).data.effects).toBe('none');
    expect(service.list().find((t) => t.id === task.id)?.status).toBe('awaiting_approval');
    await service.cancel(task.id);
    expect((await tool(0, '/tools/session_actions', { actions })).status).toBe(401);
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(0);
  });
  it('does not reset exhausted speech recovery when actions follow', async () => {
    const voice = new FakeVoice();
    voice.instant = true;
    const { service, tool } = await fixture({ voice, interactSyncWaitMs: 1000 });
    await service.submit('Answer and start work', { source: 'voice' });
    await tool(0, '/tools/interact', say('**invalid**'));
    await tool(0, '/tools/interact', say('**invalid**'));
    expect((await tool(0, '/tools/session_actions', { actions })).data.ok).toBe(true);
    expect((await tool(0, '/tools/interact', say('The report has started.'))).data.errors[0].code).toBe(
      'speech_exhausted',
    );
    expect(voice.utterances).toHaveLength(0);
  });
});

describe('acknowledgement clips', () => {
  const say = (text: string) => ({ actions: [{ tool: 'speak_tool', args: { text } }] });
  async function acked(options: ConstructorParameters<typeof AgentService>[4] = {}) {
    const voice = new FakeVoice();
    voice.instant = true;
    const clips = new FakeVoice();
    clips.instant = true;
    let offered = 0;
    const acknowledgements = {
      next: () => {
        offered++;
        return clips.prepare('Hmm okay.');
      },
    };
    const setup = await fixture({ voice, acknowledgements, interactSyncWaitMs: 1000, ...options });
    return { ...setup, voice, clips, offered: () => offered };
  }
  it('plays one clip while the model works; the reply preempts it without overlap', async () => {
    const { service, tool, voice, clips } = await acked();
    await service.submit('What time is it?', { source: 'voice' });
    expect(clips.started).toEqual(['Hmm okay.']);
    expect(service.state().presentation).toMatchObject({ speaking: true, acknowledging: true });
    expect(service.state().presentation.echo).toEqual([{ text: 'Hmm okay.' }]);
    await tool(0, '/tools/interact', say('It is four o’clock.'));
    // The clip was stopped before the reply was handed any audio.
    expect(clips.last!.state()).toBe('cancelled');
    expect(voice.started).toEqual(['It is four o’clock.']);
    expect(service.state().presentation.acknowledging).toBeUndefined();
    voice.last!.finish();
    await settle();
    expect(clips.utterances).toHaveLength(1);
    expect(clips.started).toEqual(['Hmm okay.']);
  });
  it('never queues a clip behind a reply that already finished', async () => {
    const { service, tool, voice, clips, children } = await acked();
    await service.submit('Hello', { source: 'voice' });
    await tool(0, '/tools/interact', say('Hi there.'));
    voice.last!.finish();
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Hi there.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(clips.utterances).toHaveLength(1);
    expect(clips.last!.state()).toBe('cancelled');
  });
  it('Stop and a replacing request cancel the clip', async () => {
    const { service, clips } = await acked();
    await service.submit('Open settings', { source: 'voice' });
    await service.stop();
    expect(clips.utterances[0].state()).toBe('cancelled');
    await service.submit('Open the browser', { source: 'voice' });
    await service.submit('Open the browser settings', { source: 'voice' });
    expect(clips.utterances[1].state()).toBe('cancelled');
    expect(clips.utterances.filter((u) => u.state() === 'playing')).toHaveLength(1);
  });
  it('barge-in over a clip stops only the clip, so the reply still speaks', async () => {
    const { service, tool, voice, clips } = await acked();
    await service.submit('Open settings', { source: 'voice' });
    service.interrupt();
    expect(clips.last!.state()).toBe('cancelled');
    await settle();
    expect(service.state().presentation.speaking).toBe(false);
    await tool(0, '/tools/interact', say('Opening settings.'));
    expect(voice.started).toEqual(['Opening settings.']);
    // Barge-in over the reply itself still silences the whole turn.
    service.interrupt();
    expect(voice.last!.state()).toBe('cancelled');
  });
  it.each(['typed', 'muted'])('follows the reply speech policy (%s)', async (mode) => {
    const { service, clips, offered } = await acked();
    if (mode === 'muted') await service.updateSettings({ autoSpeak: false });
    await service.submit('Open settings', { source: mode === 'typed' ? 'typed' : 'voice' });
    expect(offered()).toBe(0);
    expect(clips.utterances).toHaveLength(0);
  });
  it('acknowledges typed requests when typed replies are spoken', async () => {
    const { service, clips } = await acked();
    await service.updateSettings({ speakTypedReplies: true });
    await service.submit('Open settings', { source: 'typed' });
    expect(clips.started).toEqual(['Hmm okay.']);
  });
  it('does not acknowledge background children', async () => {
    const { service, offered } = await acked();
    await service.startChild('Research', 'Find the answer');
    expect(offered()).toBe(0);
  });
});
