/**
 * Microphone segment diagnostics from the renderer, for the opt-in debug log. Only explicit,
 * bounded metadata crosses this boundary: event names from a fixed list, a random segment id,
 * counts, durations and levels. Never audio, transcripts, or arbitrary renderer fields.
 */
export const voiceTraceEvents = [
  // Segmenter (src/progressive-transcription.ts)
  'speech-start',
  'inference-start',
  'inference-end',
  'inference-retry',
  'inference-timeout',
  'final-ready',
  'final-delivered',
  'endpoint',
  'endpoint-revoked',
  'endpoint-extended',
  'noise-steady',
  'noise-discarded',
  'noise-trimmed',
  'turn-boundary',
  'probe',
  'capacity-sealed',
  'overrun',
  'tail-discarded',
  // Renderer recovery (src/App.tsx)
  'overrun-retry',
  'overrun-fallback',
  'recognition-error',
  'capture-stall',
  'capture-recovering',
  'capture-recovered',
  'capture-failed',
] as const;
export type VoiceTraceEvent = (typeof voiceTraceEvents)[number];

export const voiceTraceReasons = [
  'timeout',
  'error',
  'cancelled',
  'cap',
  'capture',
  'stall',
  'budget',
  'open',
  'tail',
] as const;

export interface VoiceTrace {
  event: VoiceTraceEvent;
  segment?: string;
  /** Renderer monotonic clock (performance.now), ms. */
  atMs?: number;
  revision?: number;
  /** Audio in the segment buffer or request, ms. */
  coverageMs?: number;
  decodeCount?: number;
  coalesced?: number;
  floorDb?: number;
  levelDb?: number;
  quietMs?: number;
  reason?: (typeof voiceTraceReasons)[number];
}

const events = new Set<string>(voiceTraceEvents);
const reasons = new Set<string>(voiceTraceReasons);

function number(value: unknown, min: number, max: number, digits = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return undefined;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** A sanitized copy of a renderer trace, or undefined when it is not one. */
export function validVoiceTrace(value: unknown): VoiceTrace | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.event !== 'string' || !events.has(input.event)) return undefined;
  const trace: VoiceTrace = { event: input.event as VoiceTraceEvent };
  if (typeof input.segment === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(input.segment)) trace.segment = input.segment;
  const coverage = number(input.coverage, 0, 400_000);
  const fields: Partial<VoiceTrace> = {
    atMs: number(input.atMs, 0, 1e12),
    revision: number(input.revision, 0, 1e6),
    coverageMs: coverage === undefined ? undefined : Math.round(coverage / 16),
    decodeCount: number(input.decodeCount, 0, 1e6),
    coalesced: number(input.coalesced, 0, 1e6),
    floorDb: number(input.floorDb, -120, 0, 1),
    levelDb: number(input.levelDb, -120, 0, 1),
    quietMs: number(input.quietMs, 0, 600_000),
  };
  for (const [key, field] of Object.entries(fields)) if (field !== undefined) Object.assign(trace, { [key]: field });
  if (typeof input.reason === 'string' && reasons.has(input.reason))
    trace.reason = input.reason as VoiceTrace['reason'];
  return trace;
}
