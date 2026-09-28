import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from '../electron/store.js';
import type { TaskRecord } from '../electron/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe('task persistence', () => {
  it('round-trips task history through an atomic local store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'buddy-store-'));
    dirs.push(dir);
    const path = join(dir, 'tasks.json');
    const store = new TaskStore(path);
    const task: TaskRecord = {
      id: '1',
      prompt: 'hello',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      response: 'Done.',
      steps: [],
    };
    await store.save([task]);
    expect(await store.load()).toEqual([task]);
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1);
  });
  it('starts empty when no store exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'buddy-store-'));
    dirs.push(dir);
    expect(await new TaskStore(join(dir, 'missing.json')).load()).toEqual([]);
  });
  it('persists settings with tasks and preserves compatibility with task-only loading', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'buddy-store-'));
    dirs.push(dir);
    const store = new TaskStore(join(dir, 'state.json'));
    const settings = { defaultCwd: '/tmp', launchAtLogin: true, wakeWord: 'Computer', model: 'gpt-6-luna' };
    await store.save([], settings);
    expect(await store.loadState()).toEqual({ tasks: [], settings });
    expect(await store.load()).toEqual([]);
  });

  it('recovers from a corrupt file and keeps a backup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'buddy-store-'));
    dirs.push(dir);
    const path = join(dir, 'tasks.json');
    await writeFile(path, '{not json');
    expect(await new TaskStore(path).loadState()).toEqual({ tasks: [] });
    expect((await readdir(dir)).some((name) => name.startsWith('tasks.json.corrupt-'))).toBe(true);
  });
});

it('pages and searches Pi transcripts without exposing reasoning or image data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'friday-history-'));
  dirs.push(dir);
  const store = new TaskStore(join(dir, 'state.json'));
  await mkdir(store.sessionDirectory);
  await writeFile(
    store.sessionPath('session-1'),
    [
      { type: 'session', id: 'session-1' },
      { message: { role: 'user', content: 'Find the invoice' } },
      {
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private' },
            { type: 'text', text: 'I found invoice 42' },
          ],
        },
      },
      {
        message: {
          role: 'toolResult',
          content: [
            { type: 'image', data: 'secret-image' },
            { type: 'text', text: 'Document path' },
          ],
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n'),
  );
  const first = await store.history('session-1', 0, 2);
  expect(first.entries.map((entry) => entry.text)).toEqual(['Find the invoice', 'I found invoice 42']);
  expect(first.nextOffset).toBe(2);
  const second = await store.history('session-1', first.nextOffset!, 2);
  expect(second.entries.map((entry) => entry.text)).toEqual(['Document path']);
  expect(second.nextOffset).toBeNull();
  expect((await store.history('session-1', 0, 2, 'INVOICE 42')).entries).toHaveLength(1);
  expect((await store.history('missing')).entries).toEqual([]);
  expect(() => store.sessionPath('../outside')).toThrow('Invalid session');
});
