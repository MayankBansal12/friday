import { createHash } from 'node:crypto';
import { drawing as validDrawing, type Drawing, type Observation } from './desktop-protocol.js';
import type { SpeechOutcome, SpeechPlayback } from './speech-channel.js';
import { validateSpeech } from './speech-policy.js';
import type { InteractActionRecord, InteractTool, InteractionRecord } from './types.js';

export const interactTools: readonly InteractTool[] = ['speak_tool', 'draw_tool', 'show_text_tool'];
export type InteractTiming = 'parallel' | 'together';
export interface InteractError {
  path: string;
  code: string;
  message: string;
  retry: string;
}
export interface InteractRejection {
  status: 'rejected';
  effects: 'none';
  errors: InteractError[];
}
export interface InteractPlan {
  timing: InteractTiming;
  order: InteractTool[];
  speech?: string;
  drawing?: Drawing;
  text?: string;
  /** Stable identity of the requested effects, including the bound observation. */
  fingerprint: string;
}
export interface InteractContext {
  /** Latest observation of the current request's desktop lease; host-bound, never model-supplied. */
  observation?: Observation;
  now?: number;
  /** Prefix for host-generated annotation IDs, unique per interaction. */
  idPrefix: string;
}

const retry = {
  shape: 'Fix the listed fields and send the whole interact call again. Nothing ran.',
  observe:
    'Nothing ran. Call desktop_observe, then send interact again using coordinates from that new screenshot. Do not pass observation or annotation IDs.',
  item: 'Nothing ran. Correct this item using the latest screenshot coordinates and send the whole interact call again.',
  speech:
    'Nothing ran. Rewrite speak_tool.args.text once to satisfy the reason, or drop speak_tool and put the reply in show_text_tool.',
};
const itemFields = new Set([
  'kind',
  'x',
  'y',
  'width',
  'height',
  'toX',
  'toY',
  'text',
  'title',
  'step',
  'color',
  'points',
]);
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Validate the entire batch before any effect. Returns every problem found, with its path. */
export function parseInteract(value: unknown, context: InteractContext): InteractPlan | InteractRejection {
  const errors: InteractError[] = [];
  const add = (path: string, code: string, message: string, advice = retry.shape) =>
    errors.push({ path, code, message, retry: advice });
  const input = object(value);
  if (!input) {
    add('', 'invalid', 'Expected an object with an actions array.');
    return { status: 'rejected', effects: 'none', errors };
  }
  for (const key of Object.keys(input))
    if (key !== 'actions' && key !== 'timing') add(key, 'unknown_field', `Unknown field "${key}".`);
  let timing: InteractTiming = 'parallel';
  if (input.timing !== undefined) {
    if (input.timing === 'parallel' || input.timing === 'together') timing = input.timing;
    else add('timing', 'invalid', 'timing must be "parallel" or "together".');
  }
  const plan: InteractPlan = { timing, order: [], fingerprint: '' };
  if (!Array.isArray(input.actions) || !input.actions.length || input.actions.length > interactTools.length) {
    add('actions', 'invalid', 'actions must contain one to three actions, at most one of each tool.');
    return { status: 'rejected', effects: 'none', errors };
  }
  input.actions.forEach((raw, index) => {
    const path = `actions[${index}]`;
    const action = object(raw);
    if (!action) return add(path, 'invalid', 'Each action is an object: {tool, args}.');
    for (const key of Object.keys(action))
      if (key !== 'tool' && key !== 'args') add(`${path}.${key}`, 'unknown_field', `Unknown field "${key}".`);
    const tool = action.tool as InteractTool;
    if (!interactTools.includes(tool))
      return add(`${path}.tool`, 'unknown_tool', 'tool must be speak_tool, draw_tool or show_text_tool.');
    if (plan.order.includes(tool))
      return add(`${path}.tool`, 'duplicate_tool', `Use ${tool} at most once per interact call; combine its content.`);
    plan.order.push(tool);
    const args = object(action.args);
    if (!args) return add(`${path}.args`, 'invalid', 'args must be an object.');
    const allowed = tool === 'draw_tool' ? ['items'] : ['text'];
    for (const key of Object.keys(args))
      if (!allowed.includes(key))
        add(
          `${path}.args.${key}`,
          'unknown_field',
          ['observationId', 'displayId', 'id', 'ids', 'replace'].includes(key)
            ? `Do not send "${key}"; the host binds the latest observation and assigns IDs.`
            : `Unknown field "${key}".`,
        );
    if (tool === 'speak_tool') {
      const decision = validateSpeech(args.text);
      if (decision.ok) plan.speech = decision.text;
      else add(`${path}.args.text`, 'speech_policy', decision.reason, retry.speech);
    }
    if (tool === 'show_text_tool') {
      if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 6000)
        add(`${path}.args.text`, 'invalid', 'text must be 1–6000 characters of plain text.');
      else plan.text = args.text.trim();
    }
    if (tool === 'draw_tool') {
      const items = args.items;
      if (!Array.isArray(items) || !items.length || items.length > 64)
        return add(`${path}.args.items`, 'invalid', 'items must contain 1–64 annotations.');
      const observation = context.observation;
      if (!observation)
        return add(
          `${path}.args.items`,
          'observe_required',
          'There is no screenshot for this request yet.',
          retry.observe,
        );
      if ((context.now ?? Date.now()) - observation.capturedAt > 60_000)
        return add(
          `${path}.args.items`,
          'observation_stale',
          'The latest screenshot is over 60 seconds old.',
          retry.observe,
        );
      const bound = { observationId: observation.id, displayId: observation.display.id };
      const ids: string[] = [];
      items.forEach((item, itemIndex) => {
        const itemPath = `${path}.args.items[${itemIndex}]`;
        const fields = object(item);
        if (!fields) return add(itemPath, 'invalid', 'Each item is an annotation object.', retry.item);
        if ('id' in fields)
          return add(
            `${itemPath}.id`,
            'unknown_field',
            'Do not send annotation IDs; the host assigns them.',
            retry.item,
          );
        const unknown = Object.keys(fields).filter((key) => !itemFields.has(key));
        if (unknown.length)
          return add(
            `${itemPath}.${unknown[0]}`,
            'unknown_field',
            `Unknown annotation field "${unknown[0]}".`,
            retry.item,
          );
        const id = `${context.idPrefix}-${itemIndex + 1}`;
        try {
          validDrawing({ ...bound, items: [{ ...fields, id }] }, observation);
          ids.push(id);
        } catch (error) {
          add(itemPath, 'invalid_item', error instanceof Error ? error.message : 'Invalid annotation.', retry.item);
        }
      });
      if (ids.length === items.length)
        plan.drawing = validDrawing(
          { ...bound, items: items.map((item, itemIndex) => ({ ...object(item), id: ids[itemIndex] })) },
          observation,
        );
    }
  });
  if (errors.length) return { status: 'rejected', effects: 'none', errors };
  plan.fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        timing,
        speech: plan.speech,
        text: plan.text,
        observation: plan.drawing?.observationId,
        // IDs are host-generated per call; identity is the requested geometry.
        items: plan.drawing?.items.map((item) => ({ ...item, id: undefined })),
      }),
    )
    .digest('hex');
  return plan;
}

export interface InteractRuntime {
  /** False once the request is superseded, stopped or no longer the active parent turn. */
  current(): boolean;
  /** Fires when current() becomes false, so waits end promptly. */
  cancelled: AbortSignal;
  /** Why speech will not play (mute, typed request, no voice); undefined when it may play. */
  speechSuppressed?: string;
  prepareSpeech(text: string): SpeechPlayback | undefined;
  draw(drawing: Drawing): Promise<{ ids: string[] }>;
  showText(text: string, kind: 'text' | 'speech' | 'caption'): void;
  /** Bound on waiting for the first playable audio before releasing visuals. */
  syncWaitMs: number;
  /** Receives every later change, including final speech delivery after this call returns. */
  update(record: InteractionRecord): void;
  now?: () => number;
}
export interface InteractResult {
  /** in_progress: some action (usually speech) is still accepted or scheduled, not yet terminal. */
  status: InteractionRecord['status'];
  interactionId: string;
  timing: InteractTiming;
  effects: 'applied' | 'partial' | 'none';
  actions: InteractActionRecord[];
  guidance?: string;
}

function playbackRecord(outcome: SpeechOutcome): InteractActionRecord['playback'] {
  const m = outcome.metrics;
  return {
    evidence: outcome.evidence,
    ...(m.pcmArrivedMs !== undefined ? { pcmArrivedMs: m.pcmArrivedMs } : {}),
    ...(m.sinkScheduledMs !== undefined ? { sinkScheduledMs: m.sinkScheduledMs } : {}),
    ...(m.playbackObservedMs !== undefined ? { playbackObservedMs: m.playbackObservedMs } : {}),
    scheduledAudioMs: m.scheduledAudioMs,
    ...(outcome.playedMs !== undefined ? { playedMs: outcome.playedMs } : {}),
    interrupted: outcome.interrupted,
    // Without text alignment, which words were heard is unknown, even after a completed transport.
    heardWords: outcome.scheduled ? 'unknown' : 'none',
    ...(outcome.status === 'completed' && outcome.evidence === 'dispatch-estimate'
      ? { localPlayoutDrained: true }
      : {}),
  };
}
const pending = new Set<InteractActionRecord['status']>(['accepted', 'scheduled']);
const delivered = new Set<InteractActionRecord['status']>(['accepted', 'scheduled', 'completed', 'interrupted']);
function summarize(actions: InteractActionRecord[]): InteractionRecord['status'] {
  if (actions.some((a) => pending.has(a.status))) return 'in_progress';
  if (actions.every((a) => a.status === 'cancelled')) return 'cancelled';
  const effective = actions.some((a) => delivered.has(a.status));
  const shortfall = actions.some((a) => ['failed', 'cancelled', 'interrupted'].includes(a.status));
  if (!effective) return actions.some((a) => a.status === 'failed') ? 'failed' : 'completed';
  return shortfall ? 'partial' : 'completed';
}
function effectsOf(actions: InteractActionRecord[]): InteractResult['effects'] {
  const relevant = actions.filter((a) => a.status !== 'suppressed');
  if (!relevant.some((a) => delivered.has(a.status))) return 'none';
  return relevant.every((a) => delivered.has(a.status) && a.status !== 'interrupted') ? 'applied' : 'partial';
}

/**
 * Execute a validated plan. Resolves once visuals are resolved and speech is scheduled,
 * failed or deferred; playback continues afterwards and is reported through update().
 * Nothing is rolled back: the result lists what actually happened, per action.
 */
export async function executeInteract(
  plan: InteractPlan,
  record: InteractionRecord,
  runtime: InteractRuntime,
): Promise<InteractResult> {
  const now = runtime.now ?? Date.now;
  const actions = new Map<InteractTool, InteractActionRecord>();
  for (const tool of plan.order) actions.set(tool, { tool, status: 'accepted' });
  record.actions = plan.order.map((tool) => actions.get(tool)!);
  const touch = () => {
    record.updatedAt = now();
    record.status = summarize(record.actions);
    runtime.update(record);
  };
  const speechAction = actions.get('speak_tool');
  const drawAction = actions.get('draw_tool');
  const textAction = actions.get('show_text_tool');
  const cancelPending = (reason: string) => {
    playback?.utterance.cancel();
    for (const action of record.actions)
      if (action.status === 'accepted') {
        action.status = 'cancelled';
        action.reason = reason;
      }
  };
  let playback: SpeechPlayback | undefined;
  const result = (): InteractResult => {
    const failedDraw = drawAction?.status === 'failed';
    const guidance = failedDraw
      ? `The drawing failed: ${drawAction.error ?? 'unknown error'}. Listed effects that happened are not rolled back. Observe again, then send only the still-needed actions.`
      : speechAction?.status === 'failed'
        ? 'Speech failed; do not resend it. Put the reply in show_text_tool if the user still needs it.'
        : textAction?.status === 'failed'
          ? 'Showing text failed; other listed effects already happened. Resend only show_text_tool if still needed.'
          : speechAction?.late && speechAction.status === 'accepted'
            ? 'Visuals were released while voice audio is still preparing; it will play when ready. Do not resend speech.'
            : undefined;
    return {
      status: record.status,
      interactionId: record.id,
      timing: plan.timing,
      effects: effectsOf(record.actions),
      actions: record.actions.map((a) => structuredClone(a)),
      ...(guidance ? { guidance } : {}),
    };
  };
  if (!runtime.current() || runtime.cancelled.aborted) {
    cancelPending('The request was superseded or stopped before any effect.');
    touch();
    return result();
  }
  if (speechAction && plan.speech) {
    speechAction.text = plan.speech;
    if (runtime.speechSuppressed) {
      speechAction.status = 'suppressed';
      speechAction.reason = runtime.speechSuppressed;
    } else {
      playback = runtime.prepareSpeech(plan.speech);
      if (!playback) {
        speechAction.status = 'suppressed';
        speechAction.reason = 'Voice output is unavailable.';
      }
    }
  }
  let speechStarted = false;
  const startSpeech = () => {
    if (!playback || speechStarted || speechAction!.status !== 'accepted') return;
    speechStarted = playback.start();
    if (!speechStarted) {
      speechAction!.status = 'cancelled';
      speechAction!.reason = 'Superseded before playback.';
    }
  };
  if (playback) {
    const owned = playback;
    const action = speechAction!;
    // Only this group's own utterance updates this group's action.
    void owned.utterance.scheduled.then(
      () => {
        if (action.status === 'accepted') {
          action.status = 'scheduled';
          touch();
        }
      },
      () => {},
    );
    void owned.outcome.then((outcome) => {
      action.playback = playbackRecord(outcome);
      if (outcome.status === 'completed') action.status = 'completed';
      else if (outcome.status === 'failed') {
        if (pending.has(action.status)) {
          action.status = 'failed';
          action.error = outcome.error;
        }
      } else if (pending.has(action.status)) {
        action.status = outcome.interrupted && outcome.scheduled ? 'interrupted' : 'cancelled';
        action.reason ??= 'Stopped by a newer request, barge-in or Stop.';
      }
      touch();
    });
  }
  const doDraw = async () => {
    if (!drawAction || !plan.drawing) return true;
    try {
      const drawn = await runtime.draw(plan.drawing);
      if (drawAction.status !== 'accepted') return false;
      drawAction.status = 'completed';
      drawAction.rendered = true;
      drawAction.ids = drawn.ids;
      return true;
    } catch (error) {
      if (drawAction.status === 'accepted') {
        drawAction.status = 'failed';
        drawAction.error = error instanceof Error ? error.message : String(error);
      }
      return false;
    }
  };
  // Explicit text is the visible reply; otherwise suppressed speech is shown instead,
  // or scheduled speech becomes a compact caption.
  const showText = (speechVisible: boolean) => {
    if (!runtime.current()) return;
    try {
      if (plan.text !== undefined && textAction?.status === 'accepted') {
        runtime.showText(plan.text, 'text');
        textAction.status = 'completed';
      } else if (speechVisible && plan.speech !== undefined && speechAction && plan.text === undefined)
        runtime.showText(plan.speech, speechAction.status === 'suppressed' ? 'speech' : 'caption');
    } catch (error) {
      if (textAction?.status === 'accepted') {
        textAction.status = 'failed';
        textAction.error = error instanceof Error ? error.message : String(error);
      }
    }
  };
  // Wait for first playable audio, a bound, or cancellation — whichever is first.
  const awaitReady = async () => {
    if (!playback) return 'none' as const;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        playback.utterance.ready.then(
          () => 'ready' as const,
          () => 'failed' as const,
        ),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), runtime.syncWaitMs);
        }),
        new Promise<'cancelled'>((resolve) => {
          onAbort = () => resolve('cancelled');
          if (runtime.cancelled.aborted) onAbort();
          else runtime.cancelled.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) runtime.cancelled.removeEventListener('abort', onAbort);
    }
  };
  if (plan.timing === 'parallel') {
    startSpeech();
    showText(true);
    await doDraw();
    // Report honestly whether audio is flowing, without delaying other effects.
    const readiness = await awaitReady();
    if (readiness === 'timeout' && speechAction) speechAction.late = true;
    if (readiness === 'failed') await playback?.outcome;
  } else {
    const readiness = await awaitReady();
    if (readiness === 'cancelled' || !runtime.current()) cancelPending('Superseded or stopped before reveal.');
    else {
      if (readiness === 'timeout' && speechAction) speechAction.late = true;
      if (readiness === 'failed') await playback?.outcome;
      // Reveal: the draw revalidates the lease and observation after the wait.
      const drawn = await doDraw();
      if (!runtime.current()) cancelPending('Superseded or stopped during reveal.');
      else if (!drawn && playback && speechAction!.status === 'accepted') {
        // Speech attached to a visual that failed would describe something not on screen.
        speechAction!.status = 'suppressed';
        speechAction!.reason = 'The drawing failed, so its speech was not played.';
        playback.utterance.cancel();
        showText(false);
      } else {
        startSpeech();
        showText(true);
      }
    }
  }
  // A sink with staged audio schedules synchronously on start; let that settle into the result.
  if (speechStarted && playback)
    await Promise.race([
      playback.utterance.scheduled.catch(() => {}),
      new Promise<void>((resolve) => setImmediate(resolve)),
    ]);
  if (!runtime.current()) cancelPending('Superseded or stopped.');
  touch();
  return result();
}
