import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexComputerRunner, type ComputerRuntime } from '../electron/computer-runner.js';
import { DesktopError } from '../electron/desktop-status.js';

const runners: CodexComputerRunner[] = [];
afterEach(() => runners.splice(0).forEach((r) => r.close()));
function fixture(
  options: {
    wait?: boolean;
    ask?: boolean;
    actionError?: boolean;
    validationError?: boolean;
    maxBatches?: number;
    minResultGapMs?: number;
    mixed?: boolean;
  } = {},
) {
  type Message = {
    id?: string;
    method?: string;
    params?: Record<string, unknown>;
    result?: { success?: boolean; contentItems: { type: string }[] };
  };
  const messages: Message[] = [];
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit('close'));
    return true;
  });
  const emit = (message: unknown) => child.stdout.write(JSON.stringify(message) + '\n');
  const call = () =>
    emit({
      id: 'tool-1',
      method: 'item/tool/call',
      params: {
        threadId: 't1',
        tool: options.ask ? 'computer_ask' : 'computer',
        arguments: options.ask
          ? { question: 'Which account?' }
          : {
              progress: 'Typing',
              observationId: 'obs',
              displayId: 'screen',
              actions: [{ type: 'type', text: 'hello' }],
              ...(options.mixed ? { items: [{ id: 'mark', kind: 'circle', x: 1, y: 1, width: 50, height: 30 }] } : {}),
            },
      },
    });
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const m = JSON.parse(chunk.toString());
      messages.push(m);
      callback();
      queueMicrotask(() => {
        if (m.method === 'initialize') emit({ id: m.id, result: {} });
        if (m.method === 'config/read')
          emit({
            id: m.id,
            result: {
              config: { mcp_servers: { private: { command: 'secret-tool' } }, plugins: { private: { enabled: true } } },
            },
          });
        if (m.method === 'thread/start') emit({ id: m.id, result: { thread: { id: 't1' } } });
        if (m.method === 'turn/start') {
          emit({ id: m.id, result: { turn: { id: 'turn1' } } });
          if (!options.wait) call();
        }
        if (m.method === 'thread/unsubscribe') emit({ id: m.id, result: {} });
        if (m.id === 'tool-1' && m.result?.success === false && options.validationError) call();
        else if (m.id === 'tool-1' && m.result?.success === false)
          emit({ method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } });
        if (m.id === 'tool-1' && m.result?.success && !options.ask) {
          if (options.maxBatches) call();
          else {
            emit({
              method: 'item/completed',
              params: { threadId: 't1', item: { type: 'agentMessage', text: 'Typed and verified.' } },
            });
            emit({ method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } });
          }
        }
      });
    },
  });
  const runner = new CodexComputerRunner({
    spawn: vi.fn(() => child) as unknown as typeof spawn,
    maxBatches: options.maxBatches,
    minResultGapMs: options.minResultGapMs ?? 0,
  });
  runners.push(runner);
  let attempted = false;
  const runtime: ComputerRuntime = {
    observe: vi.fn(async () => ({ id: 'obs', display: { id: 'screen' }, width: 1440, height: 810, data: 'synthetic' })),
    act: vi.fn(async () => {
      if (options.actionError) throw new Error('Stale screenshot');
      if (options.validationError && !attempted) {
        attempted = true;
        throw new DesktopError('Observe again', 'invalid_action');
      }
      return {};
    }),
    draw: vi.fn(async () => ({ rendered: true })),
    progress: vi.fn(),
  };
  return { runner, runtime, messages, child };
}
it('uses authenticated Codex with only desktop tools, returns screenshots and measured completion', async () => {
  const f = fixture();
  const result = await f.runner.run('Type hello', f.runtime, new AbortController().signal);
  expect(result).toMatchObject({ status: 'completed', summary: 'Typed and verified.', batches: 1 });
  expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
  expect(f.runtime.observe).toHaveBeenCalledTimes(2);
  expect(f.runtime.act).toHaveBeenCalledOnce();
  expect(f.messages.find((m) => m.method === 'thread/start')?.params).toMatchObject({
    model: 'gpt-6-sol',
    developerInstructions: expect.stringContaining("image(r.slice(i + 1), 'original')"),
    ephemeral: true,
    environments: [],
    config: {
      mcp_servers: { private: { enabled: false } },
      plugins: { private: { enabled: false } },
      'features.shell_tool': false,
    },
  });
  expect(f.messages.find((m) => m.id === 'tool-1')?.result?.contentItems.map((x) => x.type)).toEqual([
    'inputText',
    'inputImage',
  ]);
  expect(f.messages.filter((m) => m.method === 'turn/start')).toHaveLength(1);
});
it('refreshes after a rejected validation without retrying uncertain input', async () => {
  const f = fixture({ validationError: true });
  expect(await f.runner.run('Type', f.runtime, new AbortController().signal)).toMatchObject({ status: 'completed' });
  expect(f.runtime.act).toHaveBeenCalledTimes(2);
  expect(f.runtime.observe).toHaveBeenCalledTimes(3);
  expect(f.messages.find((m) => m.result?.success === false)?.result?.contentItems.at(-1)?.type).toBe('inputImage');
});
it('rejects action/drawing mixtures before input and reports unresolved work honestly', async () => {
  const f = fixture({ mixed: true });
  expect(await f.runner.run('Click and draw', f.runtime, new AbortController().signal)).toMatchObject({
    status: 'incomplete',
  });
  expect(f.runtime.act).not.toHaveBeenCalled();
  expect(f.runtime.draw).not.toHaveBeenCalled();
});
it('rejects immediate same-script action chaining until the model can inspect a frame', async () => {
  const f = fixture({ maxBatches: 2, minResultGapMs: 250 });
  expect(await f.runner.run('Click twice', f.runtime, new AbortController().signal)).toMatchObject({
    status: 'incomplete',
  });
  expect(f.runtime.act).toHaveBeenCalledOnce();
});
it('releases the operator when it needs input without waiting for another model response', async () => {
  const f = fixture({ ask: true });
  expect(await f.runner.run('Choose an account', f.runtime, new AbortController().signal)).toMatchObject({
    status: 'needs_input',
    summary: 'Which account?',
    batches: 0,
  });
  expect(f.runtime.act).not.toHaveBeenCalled();
  expect(f.child.kill).toHaveBeenCalled();
});
it('cancels a pending model call immediately', async () => {
  const f = fixture({ wait: true });
  const controller = new AbortController();
  const result = f.runner.run('Wait', f.runtime, controller.signal);
  await vi.waitFor(() => expect(f.runtime.observe).toHaveBeenCalled());
  controller.abort();
  await expect(result).rejects.toThrow('stopped');
  expect(f.child.kill).toHaveBeenCalled();
  expect(f.runtime.act).not.toHaveBeenCalled();
});
it('stops after a native failure and never retries uncertain input', async () => {
  const f = fixture({ actionError: true });
  await expect(f.runner.run('Type', f.runtime, new AbortController().signal)).rejects.toThrow('Stale screenshot');
  expect(f.runtime.act).toHaveBeenCalledOnce();
  expect(f.child.kill).toHaveBeenCalled();
});
it('bounds repeated action batches', async () => {
  const f = fixture({ maxBatches: 2 });
  await expect(f.runner.run('Type', f.runtime, new AbortController().signal)).rejects.toThrow('action limit');
  expect(f.runtime.act).toHaveBeenCalledTimes(2);
  expect(f.child.kill).toHaveBeenCalled();
});
