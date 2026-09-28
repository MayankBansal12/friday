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
    { url: 'http://127.0.0.1:1', beginRun: () => 'token' },
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
    const silence = vi.fn();
    const { service, children, tool } = await fixture({ silence });
    await service.submit('Guide me');
    await tool(0, '/tools/show_text', { text: 'Look here.' });
    await service.startChild('Research', 'Find the answer');
    const queued = service.submit('A queued request');
    const rejection = expect(queued).rejects.toThrow('Request stopped');
    await service.stop();
    await rejection;
    expect(service.list().every((task) => task.status === 'cancelled')).toBe(true);
    expect(service.state().presentation).toEqual({ text: '', expanded: false, speaking: false });
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.signals.includes('SIGTERM'))).toBe(true);
    expect((await tool(0, '/tools/session_start', { title: 'Late', prompt: 'Must not run' })).status).toBe(401);
    expect((await service.submit('A fresh voice request')).status).toBe('thinking');
    expect(children).toHaveLength(3);
    expect(silence).toHaveBeenCalled();
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
    expect(args[args.indexOf('--tools') + 1]).toContain('desktop_draw');
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

describe('concise parent speech', () => {
  it('rejects over-budget speech with recovery, then accepts an intact rewrite without a duplicate final', async () => {
    const speak = vi.fn(async () => {});
    const { service, tool, children } = await fixture({ speak });
    await service.submit('Explain deletion');
    const long = Array(25).fill('detail').join(' ') + '. Only delete after approval.';
    const rejected = await tool(0, '/tools/speak', { text: long });
    expect(rejected.data).toMatchObject({ accepted: false, started: false });
    expect(rejected.data.recovery).toContain('approval');
    expect(speak).not.toHaveBeenCalled();
    const short = 'Review the deletion details on screen. Use the approval controls only if you want to proceed.';
    expect((await tool(0, '/tools/speak', { text: short })).data.accepted).toBe(true);
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: long }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(speak).toHaveBeenCalledExactlyOnceWith(short);
    expect(service.state().presentation.text).toBe(long);
    expect(service.list()[0]).toMatchObject({ response: long, speechText: short });
  });

  it('keeps an over-budget final intact and silent, and cannot replay child or arbitrary text', async () => {
    const speak = vi.fn(async () => {});
    const { service, children } = await fixture({ speak });
    const task = await service.submit('Details');
    const long = 'Do not act yet. ' + Array(80).fill('detail').join(' ') + '. Approval is required.';
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: long }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(speak).not.toHaveBeenCalled();
    expect(service.state().presentation).toMatchObject({ text: long, expanded: true, speaking: false });
    expect(service.list()[0].speechIssue).toContain('on screen');
    expect(() => service.readAloud(task.id)).toThrow('on screen');
    expect(() => service.readAloud('Say arbitrary text.')).toThrow('on screen');
  });

  it('honors autoSpeak off for tools, final fallback and replay', async () => {
    const speak = vi.fn(async () => {});
    const { service, tool, children } = await fixture({ speak });
    await service.updateSettings({ autoSpeak: false });
    const task = await service.submit('Hello');
    expect((await tool(0, '/tools/speak', { text: 'Hello there.' })).data).toMatchObject({
      accepted: true,
      started: false,
    });
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Details are here.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    await service.readAloud(task.id);
    expect(speak).not.toHaveBeenCalled();
    await service.submit('Another');
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'A short answer.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(speak).not.toHaveBeenCalled();
  });

  it('isolates replaced playback, keeps two children running, and suppresses speech after Stop', async () => {
    const ends: Array<() => void> = [];
    const speak = vi.fn(() => new Promise<void>((resolve) => ends.push(resolve)));
    const silence = vi.fn();
    const { service, tool, children } = await fixture({ speak, silence });
    await service.submit('Work');
    const a = await service.startChild('One', 'Research one');
    const b = await service.startChild('Two', 'Research two');
    await tool(0, '/tools/speak', { text: 'I am checking.' });
    await tool(0, '/tools/speak', { text: 'The first result is ready.' });
    ends[0]();
    await settle();
    expect(service.state().presentation.speaking).toBe(true);
    expect(silence).toHaveBeenCalled();
    children[1].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Child details.' }] });
    children[1].rpc({ type: 'agent_settled' });
    await settle();
    expect(service.state().presentation.speaking).toBe(true);
    expect(service.state().sessions.find((s) => s.id === a.id)?.status).toBe('completed');
    expect(service.state().sessions.find((s) => s.id === b.id)?.status).toBe('running');
    expect(speak).toHaveBeenCalledTimes(2);
    service.silence();
    await tool(0, '/tools/speak', { text: 'A late reply.' });
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Another late reply.' }] });
    children[0].rpc({ type: 'agent_settled' });
    ends[1]();
    await settle();
    expect(speak).toHaveBeenCalledTimes(2);
    expect(service.state().presentation.speaking).toBe(false);
    await service.submit('New request');
    await tool(0, '/tools/speak', { text: 'New answer.' });
    expect(speak).toHaveBeenCalledTimes(3);
    ends[2]();
  });

  it('a new request cancels old audio and stale completion cannot finish the new reply', async () => {
    const ends: Array<() => void> = [];
    const speak = vi.fn(() => new Promise<void>((resolve) => ends.push(resolve)));
    const silence = vi.fn();
    const { service, tool } = await fixture({ speak, silence });
    const old = await service.submit('First');
    await tool(0, '/tools/speak', { text: 'First answer.' });
    await service.submit('Second');
    await tool(1, '/tools/speak', { text: 'Second answer.' });
    ends[0]();
    await settle();
    expect(service.list().find((t) => t.id === old.id)?.status).toBe('cancelled');
    expect(service.state().presentation.speaking).toBe(true);
    expect((await tool(0, '/tools/speak', { text: 'Stale answer.' })).status).toBe(401);
    ends[1]();
    await settle();
    expect(service.state().presentation.speaking).toBe(false);
  });
});

it('retains a speak-only caption and does not count Stop as an answer', async () => {
  const speak = vi.fn(async () => {});
  const { service, tool, children } = await fixture({ speak });
  await service.submit('Guide me');
  await tool(0, '/tools/speak', { text: 'Open Settings.' });
  children[0].rpc({ type: 'agent_settled' });
  await settle();
  expect(service.state().presentation.text).toBe('Open Settings.');
  expect(speak).toHaveBeenCalledExactlyOnceWith('Open Settings.');
  await service.submit('Another request');
  service.silence();
  children[0].rpc({ type: 'agent_settled' });
  await settle();
  expect(service.list()[0]).toMatchObject({ status: 'failed' });
});

it('turning autoSpeak off stops playback and a stale completion cannot restart it', async () => {
  let finish!: () => void;
  const speak = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const silence = vi.fn();
  const { service, tool, children } = await fixture({ speak, silence });
  await service.submit('Answer');
  await tool(0, '/tools/speak', { text: 'Here is the answer.' });
  silence.mockClear();
  await service.updateSettings({ autoSpeak: false });
  expect(silence).toHaveBeenCalledOnce();
  expect(service.state().presentation.speaking).toBe(false);
  finish();
  children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Here are more details.' }] });
  children[0].rpc({ type: 'agent_settled' });
  await settle();
  expect(speak).toHaveBeenCalledOnce();
  expect(service.state().presentation.speaking).toBe(false);
});

it('keeps a short symbolic final visible with an accurate neutral notice', async () => {
  const speak = vi.fn(async () => {});
  const { service, children } = await fixture({ speak });
  await service.submit('What does it cost?');
  children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'It costs $12.' }] });
  children[0].rpc({ type: 'agent_settled' });
  await settle();
  expect(speak).not.toHaveBeenCalled();
  expect(service.list()[0]).toMatchObject({ response: 'It costs $12.', speechIssue: 'Reply shown on screen.' });
  expect(service.state().presentation).toMatchObject({ text: 'It costs $12.', expanded: true });
});

describe('attached action confirmations', () => {
  const start = (title: string) => ({ kind: 'start', title, prompt: 'Wait, then calculate.' });
  it('speaks once after both starts without another model event and does not wait for playback', async () => {
    let finish!: () => void;
    const sink = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { service, tool, children } = await fixture({ speak: sink });
    const task = await service.submit('Start two calculations');
    sink.mockImplementationOnce(() => {
      expect(service.state().sessions.filter((s) => s.role === 'child' && s.status === 'running')).toHaveLength(2);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const result = await tool(0, '/tools/session_actions', {
      actions: [start('Orchid'), start('Flint')],
      confirmation: 'Both calculations have started.',
    });
    expect(result.data).toMatchObject({ ok: true, effects: 'applied', speech: { accepted: true, started: true } });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(service.state().presentation.speaking).toBe(true);
    expect(service.list().find((t) => t.id === task.id)).toMatchObject({
      speechText: 'Both calculations have started.',
      spoken: true,
    });
    expect((await tool(0, '/tools/speak', { text: 'Both calculations have started.' })).data).toMatchObject({
      accepted: false,
      handled: true,
    });
    children[0].rpc({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: 'Both calculations have started.' }],
    });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(sink).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    sink.mockResolvedValue(undefined);
    await service.readAloud(task.id);
    expect(sink).toHaveBeenCalledTimes(2);
  });
  it.each([
    { actions: [start('Valid')], confirmation: '**Invalid**' },
    { actions: [start('Valid'), { kind: 'stop', id: 'missing' }], confirmation: 'Both tasks have stopped.' },
    { actions: [start('Valid'), { kind: 'update', id: 4, prompt: 'Go' }] },
    { actions: [start('Valid'), { kind: 'erase' }] },
    { actions: [start('Valid')], extra: true },
    { actions: [start('Valid'), { ...start('Bad'), surprise: true }] },
    { actions: [] },
  ])('prevalidates all input with no effects: %j', async (data) => {
    const sink = vi.fn(async () => {});
    const { service, tool } = await fixture({ speak: sink });
    await service.submit('Start work');
    const result = await tool(0, '/tools/session_actions', data);
    expect(result.data).toMatchObject({ ok: false, effects: 'none', results: [], speech: { accepted: false } });
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(0);
    expect(sink).not.toHaveBeenCalled();
    expect(
      (
        await tool(0, '/tools/session_actions', {
          actions: [start('Corrected')],
          confirmation: 'The calculation has started.',
        })
      ).data.ok,
    ).toBe(true);
  });
  it('reports partial effects and permits a truthful failure reply, but rejects whole-operation retry', async () => {
    const sink = vi.fn(async () => {});
    const { service, tool } = await fixture({ speak: sink });
    await service.submit('Start two');
    const original = service.startChild.bind(service);
    vi.spyOn(service, 'startChild')
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error('Synthetic failure'));
    const data = { actions: [start('Orchid'), start('Flint')], confirmation: 'Both calculations have started.' };
    const result = await tool(0, '/tools/session_actions', data);
    expect(result.data).toMatchObject({ ok: false, effects: 'possible', speech: { accepted: false } });
    expect(result.data.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, false]);
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(1);
    expect(sink).not.toHaveBeenCalled();
    expect((await tool(0, '/tools/session_actions', data)).data.effects).toBe('none');
    expect((await tool(0, '/tools/speak', { text: 'Only Orchid started. Flint could not start.' })).data.accepted).toBe(
      true,
    );
  });
  it.each(['cancel', 'replace', 'silence', 'shutdown', 'approval'] as const)(
    'suppresses confirmation when %s occurs during awaited effects',
    async (mode) => {
      const sink = vi.fn(async () => {});
      const { service, tool, children } = await fixture({ speak: sink });
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
      const pending = tool(0, '/tools/session_actions', {
        actions: [start('Orchid'), start('Flint')],
        confirmation: 'Both calculations have started.',
      });
      await ready;
      if (mode === 'cancel') await service.cancel(task.id);
      if (mode === 'replace') await service.submit('New question');
      if (mode === 'silence') service.silence();
      if (mode === 'shutdown') {
        void pending.catch(() => {});
        await service.shutdown();
      }
      if (mode === 'approval') {
        children[0].rpc({
          type: 'extension_ui_request',
          method: 'confirm',
          id: 'approval',
          title: 'Approve',
          message: 'Proceed?',
        });
        await settle();
      }
      release();
      const result = await pending.catch((error) => {
        if (mode !== 'shutdown') throw error;
        return undefined;
      });
      if (result) expect(result.data.speech.accepted).toBe(false);
      expect(sink).not.toHaveBeenCalled();
      expect(service.list().find((t) => t.id === task.id)?.speechText).toBeUndefined();
    },
  );
  it('does not race parallel confirmations or speak while the batch is pending', async () => {
    const sink = vi.fn(async () => {});
    const { service, tool } = await fixture({ speak: sink });
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
    const first = tool(0, '/tools/session_actions', {
      actions: [start('Orchid')],
      confirmation: 'Orchid has started.',
    });
    await ready;
    expect(
      (await tool(0, '/tools/session_actions', { actions: [start('Flint')], confirmation: 'Flint has started.' })).data
        .effects,
    ).toBe('none');
    expect((await tool(0, '/tools/speak', { text: 'Both calculations have started.' })).data.accepted).toBe(false);
    release();
    await first;
    expect(sink).toHaveBeenCalledExactlyOnceWith('Orchid has started.');
  });
  it('keeps muted confirmations for replay and isolates update/stop from the other child', async () => {
    const sink = vi.fn(async () => {});
    const { service, tool, children } = await fixture({ speak: sink });
    await service.updateSettings({ autoSpeak: false });
    const first = await service.submit('Start two');
    const batch = await tool(0, '/tools/session_actions', {
      actions: [start('Orchid'), start('Flint')],
      confirmation: 'Both calculations have started.',
    });
    expect(batch.data.speech).toMatchObject({ accepted: true, started: false });
    const [a, b] = service.state().sessions.filter((s) => s.role === 'child');
    expect((await tool(1, '/tools/session_actions', { actions: [start('Forbidden')] })).status).toBe(400);
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    await service.readAloud(first.id);
    expect(sink).not.toHaveBeenCalled();
    await service.updateSettings({ autoSpeak: true });
    await service.readAloud(first.id);
    expect(sink).toHaveBeenCalledTimes(1);
    await service.submit('Update Orchid');
    expect(
      (
        await tool(0, '/tools/session_actions', {
          actions: [{ kind: 'update', id: a.id, prompt: 'New numbers' }],
          confirmation: 'Orchid now uses your new numbers.',
        })
      ).data.ok,
    ).toBe(true);
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    await service.submit('Stop Orchid');
    expect(
      (
        await tool(0, '/tools/session_actions', {
          actions: [{ kind: 'stop', id: a.id }],
          confirmation: 'Orchid has stopped.',
        })
      ).data.ok,
    ).toBe(true);
    expect(service.state().sessions.find((s) => s.id === b.id)).toMatchObject({
      status: 'running',
      latestTaskId: b.latestTaskId,
    });
  });
  it('withholds aggregate speech if an earlier child failed while a later action was pending', async () => {
    const sink = vi.fn(async () => {});
    const { service, tool, children } = await fixture({ speak: sink });
    await service.submit('Start two');
    const original = service.startChild.bind(service);
    vi.spyOn(service, 'startChild')
      .mockImplementationOnce(original)
      .mockImplementationOnce(async (...args) => {
        children[1].finish(1);
        await settle();
        return original(...args);
      });
    const result = await tool(0, '/tools/session_actions', {
      actions: [start('Orchid'), start('Flint')],
      confirmation: 'Both calculations have started.',
    });
    expect(result.data.ok).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });
  it('prevalidates capacity and refuses parent IDs before effects', async () => {
    const { service, tool } = await fixture({ maxChildren: 1 });
    const parent = await service.submit('Start work');
    for (const actions of [[start('A'), start('B')], [{ kind: 'stop', id: parent.conversationId }]]) {
      expect((await tool(0, '/tools/session_actions', { actions })).data.effects).toBe('none');
      expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(0);
    }
  });
  it('withholds confirmation when child approval is pending and preserves the approval controls', async () => {
    const sink = vi.fn(async () => {});
    const { service, tool, children } = await fixture({ speak: sink });
    await service.submit('Start work');
    const original = service.startChild.bind(service);
    vi.spyOn(service, 'startChild').mockImplementationOnce(async (...args) => {
      const child = await original(...args);
      children[1].rpc({
        type: 'extension_ui_request',
        method: 'confirm',
        id: 'permission',
        title: 'Approve',
        message: 'Allow work?',
      });
      await settle();
      return child;
    });
    const result = await tool(0, '/tools/session_actions', {
      actions: [start('Orchid')],
      confirmation: 'Orchid has started.',
    });
    expect(result.data).toMatchObject({ ok: false, speech: { accepted: false } });
    const child = service.list().find((t) => t.role === 'child')!;
    expect(child.status).toBe('awaiting_approval');
    await service.resolveApproval(child.approval!.id, false);
    expect(sink).not.toHaveBeenCalled();
  });
  it('rejects a replaced child identity after awaiting an action', async () => {
    const sink = vi.fn(async () => {});
    const { service, tool } = await fixture({ speak: sink });
    await service.submit('Start work');
    const original = service.startChild.bind(service);
    vi.spyOn(service, 'startChild')
      .mockImplementationOnce(original)
      .mockImplementationOnce(async (...args) => {
        const a = service.state().sessions.find((s) => s.role === 'child')!;
        await service.updateChild(a.id, 'Replacement request');
        return original(...args);
      });
    expect(
      (
        await tool(0, '/tools/session_actions', {
          actions: [start('Orchid'), start('Flint')],
          confirmation: 'Both calculations have started.',
        })
      ).data.ok,
    ).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });
  it('keeps asynchronous output failures visible without retrying accepted speech', async () => {
    const sink = vi.fn(async () => {
      throw new Error('Synthetic output failure');
    });
    const { service, tool, children } = await fixture({ speak: sink });
    const task = await service.submit('Start work');
    expect(
      (await tool(0, '/tools/session_actions', { actions: [start('Orchid')], confirmation: 'Orchid has started.' }))
        .data.speech.accepted,
    ).toBe(true);
    await settle();
    expect(
      service
        .list()
        .find((t) => t.id === task.id)
        ?.steps.some((s) => s.title === 'Speech unavailable; reply shown as text'),
    ).toBe(true);
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Orchid has started.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(sink).toHaveBeenCalledTimes(1);
  });
  it('checks the returned action identity rather than adopting a replacement during the await', async () => {
    const sink = vi.fn(async () => {});
    const { service, tool } = await fixture({ speak: sink });
    await service.submit('Start work');
    const original = service.startChild.bind(service);
    vi.spyOn(service, 'startChild').mockImplementationOnce(async (...args) => {
      const accepted = await original(...args);
      await service.updateChild(accepted.id, 'A different request');
      return accepted;
    });
    expect(
      (await tool(0, '/tools/session_actions', { actions: [start('Orchid')], confirmation: 'Orchid has started.' }))
        .data.ok,
    ).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('shared bounded speech recovery', () => {
  const actions = [{ kind: 'start', title: 'Willow', prompt: 'Wait, then calculate.' }];
  const invalid = '**Too much markup**';
  it('rejects before effects, then runs and speaks a valid attached rewrite once', async () => {
    const sink = vi.fn(async () => {});
    const { service, tool, children } = await fixture({ speak: sink });
    await service.submit('Start Willow');
    const first = await tool(0, '/tools/session_actions', { actions, confirmation: invalid });
    expect(first.data).toMatchObject({
      effects: 'none',
      results: [],
      speech: { accepted: false, recoveryExhausted: false, rewritesRemaining: 1 },
    });
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(0);
    const rewrite = await tool(0, '/tools/session_actions', { actions, confirmation: 'Willow has started.' });
    expect(rewrite.data).toMatchObject({ ok: true, speech: { accepted: true } });
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Willow has started.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(sink).toHaveBeenCalledExactlyOnceWith('Willow has started.');
  });
  it('requires explicit action-only resubmission after exhaustion and keeps final text silent', async () => {
    const sink = vi.fn(async () => {});
    const { service, tool, children } = await fixture({ speak: sink });
    const task = await service.submit('Start Willow');
    for (let i = 0; i < 2; i++) {
      const result = await tool(0, '/tools/session_actions', { actions, confirmation: invalid });
      expect(result.data).toMatchObject({
        effects: 'none',
        results: [],
        speech: { accepted: false, recoveryExhausted: i === 1 },
      });
    }
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(0);
    expect(
      (await tool(0, '/tools/session_actions', { actions, confirmation: 'Willow has started.' })).data,
    ).toMatchObject({ effects: 'none', results: [], speech: { recoveryExhausted: true } });
    expect((await tool(0, '/tools/session_actions', { actions: [{ kind: 'stop', id: 'missing' }] })).data.effects).toBe(
      'none',
    );
    expect((await tool(0, '/tools/session_actions', { actions })).data.ok).toBe(true);
    expect((await tool(0, '/tools/session_actions', { actions })).data.effects).toBe('none');
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(1);
    expect((await tool(0, '/tools/speak', { text: 'Willow has started.' })).data.recoveryExhausted).toBe(true);
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Willow has started.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(sink).not.toHaveBeenCalled();
    expect(service.state().presentation).toMatchObject({ text: 'Willow has started.', expanded: true });
    expect(service.list().find((t) => t.id === task.id)).toMatchObject({
      status: 'completed',
      response: 'Willow has started.',
      speechIssue: 'Reply shown on screen.',
    });
    expect(service.list().find((t) => t.id === task.id)?.speechText).toBeUndefined();
  });
  it.each([true, false])('shares exhaustion across tool paths (attached first: %s)', async (attachedFirst) => {
    const sink = vi.fn(async () => {});
    const { service, tool } = await fixture({ speak: sink });
    await service.submit('Start Willow');
    const attached = () => tool(0, '/tools/session_actions', { actions, confirmation: invalid });
    const explicit = () => tool(0, '/tools/speak', { text: invalid });
    const first = await (attachedFirst ? attached() : explicit());
    const second = await (attachedFirst ? explicit() : attached());
    expect((first.data.speech ?? first.data).rewritesRemaining).toBe(1);
    expect((second.data.speech ?? second.data).recoveryExhausted).toBe(true);
    expect((await tool(0, '/tools/speak', { text: 'Ready.' })).data.accepted).toBe(false);
    expect(
      (await tool(0, '/tools/session_actions', { actions, confirmation: 'Willow has started.' })).data.effects,
    ).toBe('none');
    expect((await tool(0, '/tools/session_actions', { actions })).data.ok).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  });
  it('lets a valid explicit rewrite follow a rejected attached utterance', async () => {
    const sink = vi.fn(async () => {});
    const { service, tool } = await fixture({ speak: sink });
    await service.submit('Start Willow');
    await tool(0, '/tools/session_actions', { actions, confirmation: invalid });
    expect((await tool(0, '/tools/session_actions', { actions })).data.ok).toBe(true);
    expect((await tool(0, '/tools/speak', { text: 'Willow has started.' })).data.accepted).toBe(true);
    expect(sink).toHaveBeenCalledExactlyOnceWith('Willow has started.');
  });
  it('does not reset recovery on silence or mute and rejects stale calls after Stop', async () => {
    const sink = vi.fn(async () => {});
    const { service, tool } = await fixture({ speak: sink });
    const old = await service.submit('Start Willow');
    await tool(0, '/tools/session_actions', { actions, confirmation: invalid });
    service.silence();
    await service.updateSettings({ autoSpeak: false });
    await service.updateSettings({ autoSpeak: true });
    expect((await tool(0, '/tools/speak', { text: invalid })).data.recoveryExhausted).toBe(true);
    await service.cancel(old.id);
    expect((await tool(0, '/tools/speak', { text: invalid })).status).toBe(401);
    await service.submit('A new request');
    expect((await tool(0, '/tools/session_actions', { actions, confirmation: invalid })).status).toBe(401);
    expect((await tool(1, '/tools/speak', { text: invalid })).data).toMatchObject({
      recoveryExhausted: false,
      rewritesRemaining: 1,
    });
    expect(
      (await tool(1, '/tools/session_actions', { actions, confirmation: 'Willow has started.' })).data.speech.accepted,
    ).toBe(true);
    expect(sink).toHaveBeenCalledExactlyOnceWith('Willow has started.');
  });
  it('resets on a warm next turn and preserves previously validated manual replay', async () => {
    const sink = vi.fn(async () => {});
    const { service, tool, children } = await fixture({ speak: sink });
    const old = await service.submit('Say ready');
    await tool(0, '/tools/speak', { text: 'Ready.' });
    await tool(0, '/tools/speak', { text: invalid });
    await tool(0, '/tools/speak', { text: invalid });
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'Visible final detail.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    await service.readAloud(old.id);
    expect(sink).toHaveBeenCalledTimes(2);
    await service.submit('Start Willow');
    expect(
      (await tool(0, '/tools/session_actions', { actions, confirmation: 'Willow has started.' })).data.speech.accepted,
    ).toBe(true);
    expect(sink).toHaveBeenCalledTimes(3);
  });
  it('serializes concurrent rejections in the shared budget without reserving actions', async () => {
    const { service, tool } = await fixture();
    await service.submit('Start Willow');
    const results = await Promise.all([
      tool(0, '/tools/session_actions', { actions, confirmation: invalid }),
      tool(0, '/tools/speak', { text: invalid }),
    ]);
    expect(results.map((r) => (r.data.speech ?? r.data).rewritesRemaining).sort()).toEqual([0, 1]);
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(0);
    expect((await tool(0, '/tools/session_actions', { actions })).data.ok).toBe(true);
  });
});

describe('mixed spoken answer and action', () => {
  const actions = [{ kind: 'start', title: 'Disk report', prompt: 'Report disk usage.' }];
  it.each([false, true])('executes an action-only batch once after an accepted answer (muted: %s)', async (muted) => {
    const sink = vi.fn(async () => {});
    const { service, tool, children } = await fixture({ speak: sink });
    await service.updateSettings({ autoSpeak: !muted });
    await service.submit('What time zone am I in, and start a disk report');
    expect((await tool(0, '/tools/speak', { text: 'You are in India Standard Time.' })).data).toMatchObject({
      accepted: true,
      started: !muted,
    });
    expect((await tool(0, '/tools/session_actions', { actions })).data).toMatchObject({
      ok: true,
      effects: 'applied',
      speech: { accepted: false },
    });
    expect((await tool(0, '/tools/session_actions', { actions })).data).toMatchObject({ ok: false, effects: 'none' });
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(1);
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'The disk report has started.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(sink).toHaveBeenCalledTimes(muted ? 0 : 1);
    expect(service.state().presentation.text).toBe('The disk report has started.');
  });
  it('rejects another confirmation and malformed actions without reserving effects, then recovers action-only', async () => {
    const sink = vi.fn(async () => {});
    const { service, tool } = await fixture({ speak: sink });
    await service.submit('Answer and start work');
    await tool(0, '/tools/speak', { text: 'Your answer is four.' });
    const rejected = await tool(0, '/tools/session_actions', { actions, confirmation: 'The disk report has started.' });
    expect(rejected.data).toMatchObject({ ok: false, effects: 'none', results: [], speech: { accepted: false } });
    expect(rejected.data.recovery).toContain('without confirmation');
    expect(
      (await tool(0, '/tools/session_actions', { actions: [...actions, { kind: 'stop', id: 'missing' }] })).data
        .effects,
    ).toBe('none');
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(0);
    expect((await tool(0, '/tools/session_actions', { actions })).data.ok).toBe(true);
    expect(sink).toHaveBeenCalledExactlyOnceWith('Your answer is four.');
  });
  it('retains non-repeat protection after partial action-only effects', async () => {
    const { service, tool } = await fixture({ speak: async () => {} });
    await service.submit('Answer and start two reports');
    await tool(0, '/tools/speak', { text: 'Your answer is four.' });
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
  it('preserves approval and Stop checks before any action-only effects', async () => {
    const { service, tool, children } = await fixture({ speak: async () => {} });
    const task = await service.submit('Answer and start work');
    await tool(0, '/tools/speak', { text: 'Your answer is four.' });
    children[0].rpc({
      type: 'extension_ui_request',
      method: 'confirm',
      id: 'approval',
      title: 'Approve',
      message: 'Proceed?',
    });
    await settle();
    expect((await tool(0, '/tools/session_actions', { actions })).data.effects).toBe('none');
    expect(service.list().find((t) => t.id === task.id)?.status).toBe('awaiting_approval');
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(0);
    await service.cancel(task.id);
    expect((await tool(0, '/tools/session_actions', { actions })).status).toBe(401);
    expect(service.state().sessions.filter((s) => s.role === 'child')).toHaveLength(0);
  });
  it('does not reset exhausted speech recovery when an answer preceded action-only work', async () => {
    const sink = vi.fn(async () => {});
    const { service, tool, children } = await fixture({ speak: sink });
    await service.submit('Answer and start work');
    await tool(0, '/tools/speak', { text: 'Your answer is four.' });
    await tool(0, '/tools/speak', { text: '**invalid**' });
    expect((await tool(0, '/tools/speak', { text: '**invalid**' })).data.recoveryExhausted).toBe(true);
    expect((await tool(0, '/tools/session_actions', { actions })).data.ok).toBe(true);
    expect((await tool(0, '/tools/speak', { text: 'The report has started.' })).data.recoveryExhausted).toBe(true);
    children[0].rpc({ type: 'agent_end', messages: [{ role: 'assistant', content: 'The report has started.' }] });
    children[0].rpc({ type: 'agent_settled' });
    await settle();
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
