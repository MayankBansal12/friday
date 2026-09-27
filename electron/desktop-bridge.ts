import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  action,
  drawing,
  mode,
  nativeAction,
  nativeDrawing,
  record,
  type CompanionMode,
  type Observation,
} from './desktop-protocol.js';
import type { NativeDesktop } from './gnome-client.js';
import { desktopErrorMessage, desktopUpdateMessage, type DesktopStatus } from './desktop-status.js';

interface Run {
  id: string;
  token: string;
  mode: CompanionMode;
  revoked: boolean;
  request: string;
  ready?: Promise<void>;
  observation?: Observation;
  nativeObservation?: Observation;
}
interface CompanionWindow {
  isVisible(): boolean;
  hide(): void;
  showInactive(): void;
  showCompanion?(): void;
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > 128 * 1024) throw new Error('Desktop request too large');
    chunks.push(value);
  }
  return record(JSON.parse(Buffer.concat(chunks).toString()));
}

export class DesktopBridge {
  private server = createServer((request, response) => void this.handle(request, response));
  private port = 0;
  private operationChain: Promise<unknown> = Promise.resolve();
  private active?: Run;
  private heartbeat?: NodeJS.Timeout;
  private hiddenForDesktop = false;
  private captionRunId?: string;
  private returnTimer?: NodeJS.Timeout;
  private markTimer?: NodeJS.Timeout;
  onStopped?: (runId: string, error: unknown) => void;
  onMark?: (mark: Record<string, unknown>) => void;

  constructor(
    private readonly native: NativeDesktop,
    private readonly getWindow: () => CompanionWindow | null,
    private readonly prepareImage?: (data: string) => { data: string; width: number; height: number; mimeType: string },
  ) {}
  async start() {
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Desktop bridge failed to bind');
    this.port = address.port;
  }
  get url() {
    return `http://127.0.0.1:${this.port}`;
  }
  beginRun(id: string, selectedMode: CompanionMode, request = '') {
    if (this.returnTimer) clearTimeout(this.returnTimer);
    this.returnTimer = undefined;
    if (this.active) this.revokeRun(this.active.id);
    this.active = {
      id,
      token: randomBytes(32).toString('hex'),
      mode: mode(selectedMode),
      revoked: false,
      request: request.slice(0, 1200),
    };
    return this.active.token;
  }
  private assert(run: Run) {
    if (run.revoked || this.active !== run) throw new Error('Desktop permission was stopped');
  }
  private async ready(run: Run) {
    this.assert(run);
    run.ready ??= this.native
      .command({ op: 'begin', runId: run.id, mode: run.mode, request: run.request })
      .then((result) => {
        this.assert(run);
        if (result.protocolVersion !== 3) throw new Error(desktopUpdateMessage);
        this.heartbeat = setInterval(() => {
          void this.native.command({ op: 'heartbeat', runId: run.id }).catch((error: unknown) => {
            if (this.active !== run) return;
            this.revokeRun(run.id);
            this.onStopped?.(run.id, error);
          });
        }, 4000);
        this.heartbeat.unref();
      });
    await run.ready;
    this.assert(run);
  }
  revokeRun(id: string, preserveDrawing = false) {
    const run = this.active;
    if (!run || run.id !== id) return;
    run.revoked = true;
    this.active = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (this.markTimer) clearTimeout(this.markTimer);
    this.markTimer = undefined;
    // Deliberately outside the serialized input queue. Native code checks this lease between input events.
    void this.native.command({ op: preserveDrawing ? 'finish' : 'stop', runId: id }).catch(() => {});
    if (!preserveDrawing) this.captionRunId = undefined;
    if (!preserveDrawing || this.captionRunId !== id || !this.getWindow()?.showCompanion) this.restore();
    else this.returnAfterDrawing(id, Date.now() + 35_000);
  }
  private returnAfterDrawing(id: string, deadline: number) {
    this.returnTimer = setTimeout(() => {
      this.returnTimer = undefined;
      if (this.active || this.captionRunId !== id || !this.hiddenForDesktop) return;
      void this.native
        .command({ op: 'status' })
        .then((status) => {
          if (this.active || this.captionRunId !== id) return;
          if (Number(status.annotations) > 0 && Date.now() < deadline) {
            this.returnAfterDrawing(id, deadline);
            return;
          }
          // The guide has cleared/expired: return the answer instead of leaving Friday lost in the tray.
          void this.native.command({ op: 'stop', runId: id }).catch(() => {});
          this.captionRunId = undefined;
          this.restore();
        })
        .catch(() => {
          if (!this.active && this.captionRunId === id) this.restore();
        });
    }, 500);
    this.returnTimer.unref();
  }
  private hide() {
    const window = this.getWindow();
    if (window?.isVisible()) {
      this.hiddenForDesktop = true;
      window.hide();
    }
  }
  restore() {
    if (this.returnTimer) clearTimeout(this.returnTimer);
    this.returnTimer = undefined;
    if (this.hiddenForDesktop) this.getWindow()?.showInactive();
    this.hiddenForDesktop = false;
  }
  private enqueue<T>(run: Run, operation: () => Promise<T>) {
    const queued = this.operationChain
      .catch(() => undefined)
      .then(async () => {
        this.assert(run);
        await this.ready(run);
        this.assert(run);
        return operation();
      });
    this.operationChain = queued;
    return queued;
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    const run = this.active;
    if (!run || request.headers.authorization !== `Bearer ${run.token}`)
      return json(response, 401, { error: 'Desktop permission expired' });
    try {
      const value = request.method === 'POST' ? await body(request) : {};
      this.assert(run);
      const route = request.url;
      if (request.method === 'GET' && route === '/screenshot')
        return json(response, 200, await this.enqueue(run, () => this.observe(run)));
      if (request.method === 'POST' && ['/draw', '/clear', '/action'].includes(route ?? '')) {
        return json(
          response,
          200,
          await this.enqueue(run, async () => {
            if (route === '/draw') {
              if (run.mode === 'explain') throw new Error('Drawing requires Guide or Act mode');
              const d = drawing(value, run.observation);
              this.hide();
              const result = await this.native.command({
                ...nativeDrawing(d, run.observation!, run.nativeObservation!),
                op: 'draw',
                runId: run.id,
              });
              if (result.rendered !== true) throw new Error('GNOME did not confirm that the drawing rendered');
              this.getWindow()?.showCompanion?.();
              return result;
            }
            if (route === '/clear') return this.native.command({ op: 'clear', runId: run.id, ids: value.ids });
            if (run.mode !== 'act') throw new Error('Desktop input requires Act mode');
            const a = nativeAction(action(value, run.observation), run.observation!, run.nativeObservation!);
            // The host gates every GUI action. No optional model-supplied safety flag can bypass it.
            await this.approve(run, a);
            this.assert(run);
            action(value, run.observation); // approval delays must not revive stale coordinates
            this.hide();
            await new Promise((resolve) => setTimeout(resolve, 180));
            this.assert(run);
            const result = await this.native.command({ ...a, op: 'action', runId: run.id });
            run.observation = undefined;
            this.getWindow()?.showCompanion?.();
            return result;
          }),
        );
      }
      return json(response, 404, { error: 'Not found' });
    } catch (error) {
      return json(response, 400, { error: desktopErrorMessage(error) });
    }
  }
  private async observe(run: Run) {
    this.captionRunId = run.id;
    if (this.getWindow()?.showCompanion) {
      const visible = await this.setCaption(
        run.id,
        'Looking at your screen… Friday will return when the highlight clears.',
      );
      if (!visible)
        throw new Error('Could not show Friday’s on-screen controls. The request window has been restored.');
      this.assert(run);
    }
    this.hide();
    await new Promise((resolve) => setTimeout(resolve, 180));
    this.assert(run);
    const started = performance.now();
    const result = await this.native.command({ op: 'observe', runId: run.id });
    const captured = performance.now();
    this.assert(run);
    run.nativeObservation = { ...result } as unknown as Observation;
    const inputBytes = typeof result.data === 'string' ? Buffer.byteLength(result.data, 'base64') : 0;
    if (this.prepareImage && typeof result.data === 'string') {
      const prepared = this.prepareImage(result.data);
      Object.assign(result, prepared);
      if (result.windowBounds && typeof result.windowBounds === 'object') {
        const bounds = result.windowBounds as { x: number; y: number; width: number; height: number };
        const sx = prepared.width / run.nativeObservation.width;
        const sy = prepared.height / run.nativeObservation.height;
        result.windowBounds = {
          x: bounds.x * sx,
          y: bounds.y * sy,
          width: bounds.width * sx,
          height: bounds.height * sy,
        };
      }
      if (result.lastMark && typeof result.lastMark === 'object') {
        const mark = result.lastMark as Record<string, unknown>;
        if (Array.isArray(mark.points))
          result.lastMark = {
            ...mark,
            points: mark.points.map((point: { x: number; y: number }) => ({
              x: (point.x * prepared.width) / run.nativeObservation!.width,
              y: (point.y * prepared.height) / run.nativeObservation!.height,
            })),
          };
      }
    }
    result.timings = {
      captureMs: Math.round(captured - started),
      imageProcessingMs: Math.round(performance.now() - captured),
      inputBytes,
      outputBytes: typeof result.data === 'string' ? Buffer.byteLength(result.data, 'base64') : 0,
    };
    run.observation = result as unknown as Observation;
    this.getWindow()?.showCompanion?.();
    return result;
  }
  private async approve(run: Run, value: unknown) {
    const result = await this.native.command({ op: 'confirm', runId: run.id, action: value });
    this.assert(run);
    if (!result.approved) throw new Error('Desktop action was declined or stopped');
  }
  async setCaption(runId: string, text: string, finished = false) {
    if (runId !== this.captionRunId) return false;
    try {
      const result = await this.native.command({ op: 'caption', runId, text, finished });
      if (result.visible !== true) throw new Error('Desktop caption did not become visible');
      return true;
    } catch (error) {
      if (runId !== this.captionRunId) return false;
      const active = this.active?.id === runId;
      this.restore();
      if (active) {
        this.revokeRun(runId);
        this.onStopped?.(
          runId,
          new Error(`Could not display Friday’s on-screen controls: ${desktopErrorMessage(error)}`),
        );
      }
      return false;
    }
  }
  nativeStopped(runId: string, error: unknown) {
    if (this.active?.id !== runId) return;
    this.revokeRun(runId);
    this.onStopped?.(runId, error);
  }

  async status(): Promise<DesktopStatus> {
    try {
      const status = await this.native.command({ op: 'status' });
      const compatible = status.protocolVersion === 3;
      return {
        ready: status.ready === true && compatible,
        protocolVersion: typeof status.protocolVersion === 'number' ? status.protocolVersion : 1,
        annotations: typeof status.annotations === 'number' ? status.annotations : 0,
        marking: status.marking === true,
        error: !compatible
          ? desktopUpdateMessage
          : status.ready === true
            ? undefined
            : 'Screen access is not ready. Try checking again.',
      };
    } catch (error) {
      return { ready: false, error: desktopErrorMessage(error) };
    }
  }
  async clear() {
    if (this.active)
      return this.enqueue(this.active, () =>
        this.native.command({ op: 'clear', runId: this.active!.id, forgetMark: true }),
      );
    const id = `clear-${randomUUID()}`;
    this.beginRun(id, 'guide');
    try {
      await this.enqueue(this.active!, () => this.native.command({ op: 'clear', runId: id, forgetMark: true }));
    } finally {
      this.revokeRun(id);
    }
  }
  async mark() {
    if (this.active) throw new Error('Stop the current task before marking the screen');
    const id = `mark-${randomUUID()}`;
    this.beginRun(id, 'guide');
    const run = this.active!;
    try {
      await this.enqueue(run, async () => {
        this.hide();
        await new Promise((resolve) => setTimeout(resolve, 180));
        this.assert(run);
        await this.native.command({ op: 'mark', runId: id });
      });
      const poll = async () => {
        if (this.active !== run) return;
        try {
          const status = await this.native.command({ op: 'status' });
          if (status.marking) {
            this.markTimer = setTimeout(() => void poll(), 250);
            return;
          }
          this.revokeRun(id, true);
          if (status.lastMark) this.onMark?.(record(status.lastMark));
        } catch {
          this.revokeRun(id);
        }
      };
      this.markTimer = setTimeout(() => void poll(), 250);
    } catch (error) {
      this.revokeRun(id);
      throw new Error(desktopErrorMessage(error), { cause: error });
    }
  }
  stop() {
    this.captionRunId = undefined;
    if (this.active) this.revokeRun(this.active.id);
    else void this.native.command({ op: 'stop' }).catch(() => {});
    this.restore();
  }
  close() {
    this.stop();
    this.server.close();
    this.native.close();
  }
}
