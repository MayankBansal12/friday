import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
});
