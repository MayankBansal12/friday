import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from '../electron/store.js';
import { TaskService } from '../electron/task-service.js';
import type { TaskRecord, TaskStatus } from '../electron/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-service-'));
  dirs.push(dir);
  const service = new TaskService(
    new TaskStore(join(dir, 'tasks.json')),
    { provider: 'demo', defaultCwd: dir, launchAtLogin: false },
    async () => {},
  );
  await service.init();
  return service;
}
function waitFor(service: TaskService, status: TaskStatus) {
  return new Promise<TaskRecord>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Timed out waiting for ${status}`)), 3000);
    service.on('task', (task: TaskRecord) => {
      if (task.status === status) {
        clearTimeout(timer);
        done(task);
      }
    });
  });
}
describe('task lifecycle', () => {
  it('runs a safe command to completion and persists output', async () => {
    const service = await setup();
    const finished = waitFor(service, 'completed');
    await service.submit('Run uname -s');
    const task = await finished;
    expect(task.output.join('\n')).toContain('Linux');
    expect(service.list()[0].status).toBe('completed');
  });
  it('pauses consequential work for approval', async () => {
    const service = await setup();
    const waiting = waitFor(service, 'awaiting_approval');
    await service.submit('Run touch approved-file');
    const task = await waiting;
    expect(task.approval?.risk).toBe('medium');
    const finished = waitFor(service, 'completed');
    service.resolveApproval(task.approval!.id, true);
    await finished;
  });
  it('cancels work denied at approval', async () => {
    const service = await setup();
    const waiting = waitFor(service, 'awaiting_approval');
    const submitted = await service.submit('Run touch denied-file');
    const task = await waiting;
    const cancelled = waitFor(service, 'cancelled');
    service.resolveApproval(task.approval!.id, false);
    await cancelled;
    expect(service.list().find((x) => x.id === submitted.id)?.status).toBe('cancelled');
  });
});
