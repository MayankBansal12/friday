import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { BuddySettings, SessionRecord, TaskRecord } from './types.js';

export interface StoredState {
  tasks: TaskRecord[];
  settings?: BuddySettings;
  sessions?: SessionRecord[];
  parentId?: string;
}

type StoreShape = StoredState & { version: 1 | 2 | 3 };

export interface HistoryEntry {
  index: number;
  role: string;
  text: string;
}

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
        ...(Array.isArray(value.sessions) ? { sessions: value.sessions, parentId: value.parentId } : {}),
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

  sessionPath(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid session ID');
    return join(this.sessionDirectory, `${id}.jsonl`);
  }

  async history(id: string, offset = 0, limit = 30, query = '') {
    const entries: HistoryEntry[] = [];
    let index = 0;
    let more = false;
    const stream = createReadStream(this.sessionPath(id), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        const message = value.message;
        if (!message || !['user', 'assistant', 'toolResult'].includes(message.role)) continue;
        const text =
          typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                  .filter((block: { type?: string }) => block.type === 'text')
                  .map((block: { text?: string }) => block.text || '')
                  .join('\n')
              : '';
        if (!text) continue;
        const entryIndex = index++;
        if (entryIndex < offset || (query && !text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) continue;
        if (entries.length >= limit) {
          more = true;
          break;
        }
        const match = query ? Math.max(0, text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 150) : 0;
        entries.push({ index: entryIndex, role: message.role, text: text.slice(match, match + 6000) });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      lines.close();
      stream.destroy();
    }
    return { entries, nextOffset: more ? entries.at(-1)!.index + 1 : null };
  }

  async save(
    tasks: TaskRecord[],
    settings?: BuddySettings,
    sessions?: SessionRecord[],
    parentId?: string,
  ): Promise<void> {
    const snapshot = JSON.stringify(
      {
        version: sessions ? 3 : settings ? 2 : 1,
        tasks,
        ...(settings ? { settings } : {}),
        ...(sessions ? { sessions, parentId } : {}),
      },
      null,
      2,
    );
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
