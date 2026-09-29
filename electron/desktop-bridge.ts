import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { drawing, nativeDrawing, protocolVersion, record, type Observation } from './desktop-protocol.js';
import type { NativeDesktop } from './gnome-client.js';
import { desktopErrorMessage, desktopUpdateMessage, type DesktopStatus } from './desktop-status.js';

interface Run {
  id: string;
  token: string;
  revoked: boolean;
  ready?: Promise<void>;
  observation?: Observation;
  nativeObservation?: Observation;
}
interface CompanionWindow {
  isVisible(): boolean;
  hide(): void;
  showInactive(): void;
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
  private markTimer?: NodeJS.Timeout;
  private guidance = false;
  // Bumped on every guidance transition so late draw/status replies cannot resurrect an old state.
  private guidanceGeneration = 0;
  private guidanceTimer?: NodeJS.Timeout;
  onStopped?: (runId: string, error: unknown) => void;
  onMark?: (mark: Record<string, unknown>) => void;
  /** Fires only on transitions. True means GNOME confirmed a nonempty drawing is on screen. */
  onGuidanceChanged?: (active: boolean) => void;

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
  get guiding() {
    return this.guidance;
  }
  beginRun(id: string) {
    if (this.active) this.revokeRun(this.active.id);
    this.active = { id, token: randomBytes(32).toString('hex'), revoked: false };
    return this.active.token;
  }
  private assert(run: Run) {
    if (run.revoked || this.active !== run) throw new Error('Desktop permission was stopped');
  }
  private async ready(run: Run) {
    this.assert(run);
    run.ready ??= this.native.command({ op: 'begin', runId: run.id }).then((result) => {
      this.assert(run);
      if (result.protocolVersion !== protocolVersion) throw new Error(desktopUpdateMessage);
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
    // Deliberately outside the serialized operation queue so Stop never waits behind a capture.
    void this.native.command({ op: preserveDrawing ? 'finish' : 'stop', runId: id }).catch(() => {});
    // A completed task leaves its guide on screen; status polling ends guidance when it clears or expires.
    if (!preserveDrawing) this.setGuidance(false);
    this.restore();
  }
  private setGuidance(active: boolean) {
    this.guidanceGeneration++;
    if (this.guidanceTimer) clearTimeout(this.guidanceTimer);
    this.guidanceTimer = undefined;
    const changed = this.guidance !== active;
    this.guidance = active;
    if (active) this.watchGuidance();
    if (changed) this.onGuidanceChanged?.(active);
  }
  // GNOME clears drawings itself (expiry, clicks, focus/workspace changes, Escape) without telling the app.
  private watchGuidance(delay = 500) {
    if (!this.guidance) return;
    if (this.guidanceTimer) clearTimeout(this.guidanceTimer);
    const generation = this.guidanceGeneration;
    this.guidanceTimer = setTimeout(() => {
      this.guidanceTimer = undefined;
      void this.native.command({ op: 'status' }).then(
        (status) => {
          if (generation !== this.guidanceGeneration) return;
          if (typeof status.annotations === 'number' && status.annotations > 0) this.watchGuidance();
          else this.setGuidance(false);
        },
        () => {
          if (generation === this.guidanceGeneration) this.setGuidance(false);
        },
      );
    }, delay);
    this.guidanceTimer.unref();
  }
  private hide() {
    const window = this.getWindow();
    if (window?.isVisible()) {
      this.hiddenForDesktop = true;
      window.hide();
    }
  }
  restore() {
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
      if (request.method === 'POST' && route === '/draw')
        return json(
          response,
          200,
          await this.enqueue(run, async () => {
            const d = drawing(value, run.observation);
            let result: Record<string, unknown>;
            try {
              result = await this.native.command({
                ...nativeDrawing(d, run.observation!, run.nativeObservation!),
                op: 'draw',
                runId: run.id,
              });
            } catch (error) {
              // GNOME clears everything when a draw fails after touching the overlay; confirm now.
              this.watchGuidance(0);
              throw error;
            }
            // Stop/revoke fences a confirmation that arrives after the run ended.
            this.assert(run);
            if (result.rendered !== true) throw new Error('GNOME did not confirm that the drawing rendered');
            this.setGuidance(Array.isArray(result.ids) && result.ids.length > 0);
            return result;
          }),
        );
      if (request.method === 'POST' && route === '/clear')
        return json(
          response,
          200,
          await this.enqueue(run, async () => {
            const result = await this.native.command({ op: 'clear', runId: run.id, ids: value.ids });
            this.assert(run);
            if (value.ids === undefined) this.setGuidance(false);
            else this.watchGuidance(0);
            return result;
          }),
        );
      return json(response, 404, { error: 'Not found' });
    } catch (error) {
      return json(response, 400, { error: desktopErrorMessage(error) });
    }
  }
  private async observe(run: Run) {
    // GNOME clears any guide before capturing; a screenshot is never guidance.
    this.setGuidance(false);
    // Only the capture itself hides the companion, so Friday never appears in its own screenshot.
    this.hide();
    try {
      return await this.capture(run);
    } finally {
      this.restore();
    }
  }
  private async capture(run: Run) {
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
    return result;
  }
  nativeStopped(runId: string, error: unknown) {
    if (this.active?.id !== runId) return;
    this.revokeRun(runId);
    this.onStopped?.(runId, error);
  }

  async status(): Promise<DesktopStatus> {
    try {
      const status = await this.native.command({ op: 'status' });
      const compatible = status.protocolVersion === protocolVersion;
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
    if (this.active) {
      const run = this.active;
      return this.enqueue(run, async () => {
        const result = await this.native.command({ op: 'clear', runId: run.id, forgetMark: true });
        this.assert(run);
        this.setGuidance(false);
        return result;
      });
    }
    const id = `clear-${randomUUID()}`;
    this.beginRun(id);
    try {
      await this.enqueue(this.active!, () => this.native.command({ op: 'clear', runId: id, forgetMark: true }));
    } finally {
      // Revoking this non-preserving run stops/clears GNOME and ends guidance.
      this.revokeRun(id);
    }
  }
  async mark() {
    if (this.active) throw new Error('Stop the current task before marking the screen');
    const id = `mark-${randomUUID()}`;
    this.beginRun(id);
    const run = this.active!;
    try {
      await this.enqueue(run, async () => {
        // Marking replaces any guide with the user's own stroke, which is not Friday guidance.
        this.setGuidance(false);
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
    if (this.active) this.revokeRun(this.active.id);
    else void this.native.command({ op: 'stop' }).catch(() => {});
    this.setGuidance(false);
    this.restore();
  }
  close() {
    this.stop();
    this.server.close();
    this.native.close();
  }
}
