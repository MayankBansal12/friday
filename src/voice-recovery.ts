/** Small, testable pieces of how listening recovers from noise and capture failures. */

/** Counts events inside a sliding time window (overruns, capture restarts). */
export class RecentEvents {
  private times: number[] = [];
  constructor(private readonly windowMs: number) {}
  /** Records one event and returns how many happened within the window, this one included. */
  record(now: number) {
    this.times = this.times.filter((time) => now - time < this.windowMs);
    this.times.push(now);
    return this.times.length;
  }
  clear() {
    this.times = [];
  }
}

/** Engaged turns that overran this often in a row mean the room is too noisy for open listening. */
export const overrunFallbackCount = 2;
export const overrunWindowMs = 120_000;
/** Capture graphs rebuilt this often within a minute is a broken device, not a hiccup. */
export const captureRecoveryLimit = 3;
export const captureRecoveryWindowMs = 60_000;
/** No microphone frame for this long while a segment listens means capture stalled. */
export const captureStallMs = 2500;

/** Notices when microphone frames stop arriving. */
export class FrameWatch {
  private last = 0;
  constructor(private readonly limitMs = captureStallMs) {}
  /** A segment started (or capture restarted): the clock starts now. */
  begin(now: number) {
    this.last = now;
  }
  frame(now: number) {
    this.last = now;
  }
  stalled(now: number) {
    return now - this.last > this.limitMs;
  }
}

/**
 * Where listening rests while a turn is open or resumes. A turn opened by the local wake word
 * is engaged until it ends: reporting plain 'listening' would reset the host recognizer and
 * cancel the turn's own pending decode.
 */
export function openTurnState(turn: { interruptOnly: boolean; engaged: boolean; woken: boolean }) {
  if (turn.interruptOnly) return 'paused' as const;
  return turn.engaged || turn.woken ? ('armed' as const) : ('listening' as const);
}

interface Closable {
  close(): void;
}

/**
 * Replaces a failed capture graph on the same live stream. The failed graph is always closed
 * first, so two graphs never feed the segmenter; a replacement that finishes opening after
 * listening moved on (mic off, Stop, a newer activation) is closed instead of adopted.
 */
export async function replaceCapture<C extends Closable>(options: {
  failed: Closable;
  stream: { active: boolean };
  open(): Promise<C>;
  current(): boolean;
}): Promise<{ status: 'replaced'; capture: C } | { status: 'stale' | 'failed' }> {
  options.failed.close();
  if (!options.current()) return { status: 'stale' };
  if (!options.stream.active) return { status: 'failed' };
  let capture: C;
  try {
    capture = await options.open();
  } catch {
    return { status: options.current() ? 'failed' : 'stale' };
  }
  if (!options.current() || !options.stream.active) {
    capture.close();
    return { status: options.current() ? 'failed' : 'stale' };
  }
  return { status: 'replaced', capture };
}
