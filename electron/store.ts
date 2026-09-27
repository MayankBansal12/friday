import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BuddySettings, TaskRecord } from './types.js';

export interface StoredState {
  tasks: TaskRecord[];
  settings?: BuddySettings;
}

type StoreShape = { version: 1 | 2; tasks: TaskRecord[]; settings?: BuddySettings };

export class TaskStore {
  private writeChain: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  get sessionDirectory() {
    return join(dirname(this.path), 'conversations');
  }

  async load(): Promise<TaskRecord[]> {
    return (await this.loadState()).tasks;
  }

  async loadState(): Promise<StoredState> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as StoreShape;
      return {
        tasks: Array.isArray(value.tasks) ? value.tasks : [],
        settings: value.settings && typeof value.settings === 'object' ? value.settings : undefined,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tasks: [] };
      if (error instanceof SyntaxError || error instanceof TypeError) {
        await rename(this.path, `${this.path}.corrupt-${Date.now()}`).catch(() => undefined);
        return { tasks: [] };
      }
      throw error;
    }
  }

  async save(tasks: TaskRecord[], settings?: BuddySettings): Promise<void> {
    const snapshot = JSON.stringify({ version: settings ? 2 : 1, tasks, ...(settings ? { settings } : {}) }, null, 2);
    // A failed write must not poison every subsequent write queued on the chain.
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
        try {
          await writeFile(temp, snapshot, { mode: 0o600 });
          await rename(temp, this.path);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => undefined);
          throw error;
        }
      });
    return this.writeChain;
  }
}
