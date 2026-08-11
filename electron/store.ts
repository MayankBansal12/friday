import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TaskRecord } from './types.js';

type StoreShape = { version: 1; tasks: TaskRecord[] };

export class TaskStore {
  private writeChain: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  async load(): Promise<TaskRecord[]> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as StoreShape;
      return Array.isArray(value.tasks) ? value.tasks : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async save(tasks: TaskRecord[]): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, tasks }, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, this.path);
    });
    return this.writeChain;
  }
}
