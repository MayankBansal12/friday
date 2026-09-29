import { describe, expect, it, vi } from 'vitest';
import type { Drawing, Observation } from '../electron/desktop-protocol.js';
import {
  executeInteract,
  parseInteract,
  type InteractPlan,
  type InteractRejection,
  type InteractRuntime,
} from '../electron/interact.js';
import { SpeechChannel } from '../electron/speech-channel.js';
import type { InteractionRecord } from '../electron/types.js';
import { FakeVoice } from './fake-voice.js';

const observation = (capturedAt = Date.now()): Observation => ({
  id: 'obs-1',
  display: { id: 'display-1', x: 0, y: 0, width: 1000, height: 800, scale: 1 },
  width: 1000,
  height: 800,
  capturedAt,
  focus: 'window',
  scene: 1,
});
const circle = { kind: 'circle', x: 100, y: 120, width: 80, height: 40 };
const speak = (text = 'Click the Save button.') => ({ tool: 'speak_tool', args: { text } });
const draw = (items: unknown[] = [circle]) => ({ tool: 'draw_tool', args: { items } });
const show = (text = 'Save is in the top right.') => ({ tool: 'show_text_tool', args: { text } });
const plan = (value: unknown, obs: Observation | undefined = observation()) => {
  const parsed = parseInteract(value, { observation: obs, idPrefix: 'friday-ix-1' });
  if ('errors' in parsed) throw new Error(JSON.stringify(parsed.errors));
  return parsed;
};
const record = (timing: InteractionRecord['timing'] = 'parallel'): InteractionRecord => ({
  id: 'ix-1',
  createdAt: 0,
  updatedAt: 0,
  timing,
  status: 'in_progress',
  actions: [],
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(options: { evidence?: 'transport' | 'dispatch-estimate'; syncWaitMs?: number } = {}) {
  const voice = new FakeVoice(options.evidence ?? 'transport');
  const channel = new SpeechChannel(() => voice);
  const log: string[] = [];
  const abort = new AbortController();
  let live = true;
  const originalStart = voice.prepare.bind(voice);
  voice.prepare = (text: string) => {
    const utterance = originalStart(text);
    const start = utterance.start.bind(utterance);
    utterance.start = () => {
      log.push(`speech:start:${text}`);
      start();
    };
    return utterance;
  };
  let drawImpl: (drawing: Drawing) => Promise<{ ids: string[] }> = async (drawing) => {
    log.push('draw');
    return { ids: drawing.items.map((item) => item.id) };
  };
  const updates: InteractionRecord[] = [];
  const runtime: InteractRuntime = {
    current: () => live && !abort.signal.aborted,
    cancelled: abort.signal,
    prepareSpeech: (text) => channel.prepare(text, 'reply', 'task-1'),
    draw: (drawing) => drawImpl(drawing),
    showText: (text, kind) => log.push(`text:${kind}:${text}`),
    syncWaitMs: options.syncWaitMs ?? 1000,
    update: (value) => updates.push(structuredClone(value)),
  };
  return {
    voice,
    channel,
    log,
    runtime,
    updates,
    abort,
    stop() {
      live = false;
    },
    setDraw(fn: typeof drawImpl) {
      drawImpl = fn;
    },
  };
}

describe('interact validation', () => {
  it('defaults to parallel timing and accepts drawing alone without text or speech', () => {
    const parsed = plan({ actions: [draw([{ kind: 'arrow', x: 300, y: 200 }])] });
    expect(parsed.timing).toBe('parallel');
    expect(parsed.order).toEqual(['draw_tool']);
    expect(parsed.speech).toBeUndefined();
    expect(parsed.text).toBeUndefined();
    expect(parsed.drawing).toMatchObject({ observationId: 'obs-1', displayId: 'display-1' });
    expect(parsed.drawing!.items[0].id).toBe('friday-ix-1-1');
  });
  it('accepts speech alone and text alone, and together timing', () => {
    expect(plan({ actions: [speak()] }, undefined).speech).toBe('Click the Save button.');
    expect(plan({ actions: [show()] }, undefined).text).toBe('Save is in the top right.');
    expect(plan({ actions: [speak(), draw()], timing: 'together' }).timing).toBe('together');
  });
  it('rejects the whole batch with every problem and its path before any effect', () => {
    const result = parseInteract(
      {
        actions: [
          { tool: 'speak_tool', args: { text: '**Bold** markup' } },
          {
            tool: 'draw_tool',
            args: {
              observationId: 'obs-1',
              items: [
                { ...circle, id: 'mine' },
                { ...circle, label: 'x' },
              ],
            },
          },
          { tool: 'speak_tool', args: { text: 'Again.' } },
        ],
        timing: 'later',
        extra: 1,
      },
      { observation: observation(), idPrefix: 'p' },
    ) as InteractRejection;
    expect(result).toMatchObject({ status: 'rejected', effects: 'none' });
    const paths = result.errors.map((e) => `${e.path}:${e.code}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        'extra:unknown_field',
        'timing:invalid',
        'actions[0].args.text:speech_policy',
        'actions[1].args.observationId:unknown_field',
        'actions[1].args.items[0].id:unknown_field',
        'actions[1].args.items[1].label:unknown_field',
        'actions[2].tool:duplicate_tool',
      ]),
    );
    expect(result.errors.every((e) => e.retry.includes('Nothing ran') || e.retry.includes('send'))).toBe(true);
  });
  it('requires a fresh host-bound observation before drawing', () => {
    const missing = parseInteract({ actions: [draw()] }, { idPrefix: 'p' }) as InteractRejection;
    expect(missing.errors[0]).toMatchObject({ code: 'observe_required', path: 'actions[0].args.items' });
    expect(missing.errors[0].retry).toContain('desktop_observe');
    const stale = parseInteract(
      { actions: [draw()] },
      { observation: observation(Date.now() - 61_000), idPrefix: 'p' },
    ) as InteractRejection;
    expect(stale.errors[0].code).toBe('observation_stale');
    const outside = parseInteract(
      { actions: [draw([{ kind: 'circle', x: 5000, y: 10 }])] },
      { observation: observation(), idPrefix: 'p' },
    ) as InteractRejection;
    expect(outside.errors[0]).toMatchObject({ path: 'actions[0].args.items[0]', code: 'invalid_item' });
  });
  it('fingerprints requested effects independently of host-generated IDs', () => {
    const value = { actions: [speak(), draw()], timing: 'together' };
    const a = parseInteract(value, { observation: observation(), idPrefix: 'a' }) as InteractPlan;
    const b = parseInteract(value, { observation: observation(), idPrefix: 'b' }) as InteractPlan;
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(
      plan({ actions: [speak('Something else.'), draw()], timing: 'together' }).fingerprint,
    );
  });
});

describe('interact execution', () => {
  it('parallel: text and drawing start promptly without waiting for voice audio', async () => {
    const h = harness({ syncWaitMs: 30 });
    const pending = executeInteract(plan({ actions: [speak(), draw(), show()] }), record(), h.runtime);
    await tick();
    expect(h.log).toEqual(['speech:start:Click the Save button.', 'text:text:Save is in the top right.', 'draw']);
    const result = await pending;
    expect(result.status).toBe('in_progress');
    expect(result.actions.find((a) => a.tool === 'speak_tool')).toMatchObject({ status: 'accepted', late: true });
    expect(result.actions.find((a) => a.tool === 'draw_tool')).toMatchObject({
      status: 'completed',
      rendered: true,
      ids: ['friday-ix-1-1'],
    });
    h.voice.last!.arrive();
    await tick();
    expect(h.updates.at(-1)!.actions[0].status).toBe('scheduled');
    h.voice.last!.finish(900);
    await tick();
    expect(h.updates.at(-1)).toMatchObject({ status: 'completed' });
    expect(h.updates.at(-1)!.actions[0].playback).toMatchObject({
      evidence: 'transport',
      heardWords: 'unknown',
      interrupted: false,
      playedMs: 900,
    });
    expect(h.updates.at(-1)!.actions[0].playback?.localPlayoutDrained).toBeUndefined();
  });
  it('parallel: speech alone shows a compact caption and reports scheduled, not heard', async () => {
    const h = harness();
    h.voice.instant = true;
    const result = await executeInteract(plan({ actions: [speak()] }, undefined), record(), h.runtime);
    expect(h.log).toEqual(['speech:start:Click the Save button.', 'text:caption:Click the Save button.']);
    expect(result).toMatchObject({ status: 'in_progress', effects: 'applied' });
    expect(result.actions[0].status).toBe('scheduled');
  });
  it('together: prepares voice while waiting, reveals at speech start and returns before synthesis ends', async () => {
    const h = harness();
    const pending = executeInteract(
      plan({ actions: [speak(), draw(), show()], timing: 'together' }),
      record('together'),
      h.runtime,
    );
    await tick();
    expect(h.voice.utterances).toHaveLength(1);
    expect(h.log).toEqual([]);
    h.voice.last!.arrive();
    const result = await pending;
    expect(h.log).toEqual(['draw', 'speech:start:Click the Save button.', 'text:text:Save is in the top right.']);
    expect(h.voice.last!.state()).toBe('playing');
    expect(result.status).toBe('in_progress');
    expect(result.actions.find((a) => a.tool === 'speak_tool')!.status).toBe('scheduled');
    expect(result.actions.find((a) => a.tool === 'speak_tool')!.late).toBeUndefined();
  });
  it('together: a stalled voice releases visuals at the bound and speech follows late', async () => {
    const h = harness({ syncWaitMs: 20 });
    const result = await executeInteract(
      plan({ actions: [speak(), draw()], timing: 'together' }),
      record('together'),
      h.runtime,
    );
    expect(h.log).toEqual(['draw', 'speech:start:Click the Save button.', 'text:caption:Click the Save button.']);
    expect(result.actions[0]).toMatchObject({ status: 'accepted', late: true });
    expect(result.guidance).toContain('Do not resend speech');
    h.voice.last!.arrive();
    await tick();
    expect(h.updates.at(-1)!.actions[0].status).toBe('scheduled');
  });
  it('together: a voice failure before audio releases the visuals and reports the failure', async () => {
    const h = harness();
    const pending = executeInteract(
      plan({ actions: [speak(), draw(), show()], timing: 'together' }),
      record('together'),
      h.runtime,
    );
    await tick();
    h.voice.last!.fail(new Error('Rumik unavailable'));
    const result = await pending;
    expect(h.log).toEqual(['draw', 'text:text:Save is in the top right.']);
    expect(result.actions.find((a) => a.tool === 'speak_tool')).toMatchObject({
      status: 'failed',
      error: 'Rumik unavailable',
    });
    expect(result).toMatchObject({ status: 'partial', effects: 'partial' });
  });
  it('together: a drawing failure suppresses its speech but keeps explicit text', async () => {
    const h = harness();
    h.setDraw(async () => {
      throw new Error('Observe again: a newer screenshot replaced this one');
    });
    const pending = executeInteract(
      plan({ actions: [speak(), draw(), show()], timing: 'together' }),
      record('together'),
      h.runtime,
    );
    h.voice.last!.arrive();
    const result = await pending;
    expect(h.voice.started).toEqual([]);
    expect(h.voice.last!.state()).toBe('cancelled');
    expect(h.log).toEqual(['text:text:Save is in the top right.']);
    expect(result.actions.find((a) => a.tool === 'speak_tool')).toMatchObject({
      status: 'suppressed',
      reason: expect.stringContaining('drawing failed'),
    });
    expect(result.actions.find((a) => a.tool === 'draw_tool')!.status).toBe('failed');
    expect(result.guidance).toContain('Observe again');
    await tick();
    expect(h.updates.at(-1)!.actions[0].status).toBe('suppressed');
  });
  it('together: cancellation before reveal has no visible or audible effect', async () => {
    const h = harness();
    const pending = executeInteract(
      plan({ actions: [speak(), draw(), show()], timing: 'together' }),
      record('together'),
      h.runtime,
    );
    await tick();
    h.abort.abort();
    const result = await pending;
    expect(h.log).toEqual([]);
    expect(h.voice.started).toEqual([]);
    expect(result).toMatchObject({ status: 'cancelled', effects: 'none' });
    expect(result.actions.every((a) => a.status === 'cancelled')).toBe(true);
  });
  it('cancels everything when the request is no longer current before any effect', async () => {
    const h = harness();
    h.stop();
    const result = await executeInteract(plan({ actions: [speak(), show()] }, undefined), record(), h.runtime);
    expect(h.voice.utterances).toHaveLength(0);
    expect(h.log).toEqual([]);
    expect(result).toMatchObject({ status: 'cancelled', effects: 'none' });
  });
  it('mid-playback failure keeps visuals and never replays', async () => {
    const h = harness();
    h.voice.instant = true;
    const result = await executeInteract(
      plan({ actions: [speak(), draw()], timing: 'together' }),
      record('together'),
      h.runtime,
    );
    expect(result.actions[0].status).toBe('scheduled');
    h.voice.last!.fail(new Error('Device vanished'));
    await tick();
    const final = h.updates.at(-1)!;
    expect(final.actions).toMatchObject([
      { tool: 'speak_tool', status: 'failed', playback: { heardWords: 'unknown' } },
      { tool: 'draw_tool', status: 'completed' },
    ]);
    expect(final.status).toBe('partial');
    expect(h.voice.utterances).toHaveLength(1);
    expect(h.voice.last!.startCalls).toBe(1);
  });
  it('an interrupted utterance reports duration evidence only, never heard words', async () => {
    const h = harness();
    h.voice.instant = true;
    await executeInteract(plan({ actions: [speak()] }, undefined), record(), h.runtime);
    h.channel.silence();
    await tick();
    expect(h.updates.at(-1)!.actions[0]).toMatchObject({
      status: 'interrupted',
      playback: { interrupted: true, heardWords: 'unknown' },
    });
    expect(h.updates.at(-1)!.status).toBe('partial');
  });
  it('catches a text failure per action without losing completed effects', async () => {
    const h = harness();
    h.runtime.showText = () => {
      throw new Error('Window closed');
    };
    const result = await executeInteract(plan({ actions: [draw(), show()] }), record(), h.runtime);
    expect(result.actions).toMatchObject([
      { tool: 'draw_tool', status: 'completed' },
      { tool: 'show_text_tool', status: 'failed', error: 'Window closed' },
    ]);
    expect(result).toMatchObject({ status: 'partial', effects: 'partial' });
  });
  it('suppressed speech is shown as text and reported with the reason', async () => {
    const h = harness();
    h.runtime.speechSuppressed = 'Typed request: the reply is shown as text by default.';
    const result = await executeInteract(plan({ actions: [speak()] }, undefined), record(), h.runtime);
    expect(h.voice.utterances).toHaveLength(0);
    expect(h.log).toEqual(['text:speech:Click the Save button.']);
    expect(result.actions[0]).toMatchObject({ status: 'suppressed', reason: expect.stringContaining('Typed') });
  });
  it("an older group's observer never changes a newer group's speech", async () => {
    const h = harness();
    h.voice.instant = true;
    const first = record();
    await executeInteract(plan({ actions: [speak('First reply.')] }, undefined), first, h.runtime);
    const second = { ...record(), id: 'ix-2' };
    await executeInteract(plan({ actions: [speak('Second reply.')] }, undefined), second, h.runtime);
    await tick();
    expect(first.actions[0].status).toBe('interrupted');
    expect(second.actions[0].status).toBe('scheduled');
    h.voice.last!.finish();
    await tick();
    expect(second.actions[0].status).toBe('completed');
    expect(first.actions[0].status).toBe('interrupted');
  });
  it('a stale screen at reveal fails the drawing through the host revalidation', async () => {
    const h = harness();
    const draw$ = vi.fn(async () => {
      throw new Error('Observe again: this screenshot is over 60 seconds old');
    });
    h.setDraw(draw$);
    const result = await executeInteract(plan({ actions: [draw()] }), record(), h.runtime);
    expect(draw$).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'failed', effects: 'none' });
    expect(result.guidance).toContain('Observe again');
  });
});
