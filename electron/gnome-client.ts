import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DesktopError, desktopErrorMessage } from './desktop-status.js';

export interface NativeDesktop {
  command(value: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}
export class GnomeClient implements NativeDesktop {
  onReveal?: () => void;
  onStopped?: (runId: string, error: DesktopError) => void;
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private buffer = '';
  constructor(private readonly script: string) {}
  private start() {
    if (this.child) return this.child;
    const child = spawn('python3', ['-u', this.script], {
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || 'unix:path=/run/user/1000/bus',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      if (this.buffer.length > 32 * 1024 * 1024) {
        this.close();
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const result = JSON.parse(line) as Record<string, unknown>;
          if (result.event === 'reveal') {
            this.onReveal?.();
            continue;
          }
          if (result.event === 'stopped' && typeof result.runId === 'string') {
            this.onStopped?.(result.runId, new DesktopError('Desktop session ended', String(result.code)));
            continue;
          }
          if (result.fatal) {
            this.rejectAll(new Error(desktopErrorMessage(result.fatal)));
            continue;
          }
          const pending = this.pending.get(String(result._requestId));
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(String(result._requestId));
          if (result.error)
            pending.reject(
              new DesktopError(
                desktopErrorMessage(result.error),
                typeof result.code === 'string' ? result.code : undefined,
              ),
            );
          else {
            delete result._requestId;
            pending.resolve(result);
          }
        } catch {
          this.rejectAll(new Error('Invalid native desktop response'));
        }
      }
    });
    // Diagnostics must never include protocol frames (screenshots/token).
    child.stderr.on('data', () => {});
    child.on('error', (error) => this.rejectAll(error));
    child.on('close', () => {
      if (this.child === child) {
        this.child = undefined;
        this.buffer = '';
        this.rejectAll(new Error('Native desktop connection closed'));
      }
    });
    return child;
  }
  command(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = this.start();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Native desktop command timed out'));
        this.close();
      }, 28_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ ...value, _requestId: id })}\n`);
    });
  }
  private rejectAll(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  close() {
    this.child?.kill();
    this.child = undefined;
    this.buffer = '';
    this.rejectAll(new Error('Native desktop connection closed'));
  }
}
