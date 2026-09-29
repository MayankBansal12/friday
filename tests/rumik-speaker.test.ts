import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RumikSpeaker, type RumikOptions } from '../electron/rumik-speaker.js';
import { createSpeakerFromEnvironment, Speaker } from '../electron/speaker.js';
import type { PcmSink } from '../electron/speech-output.js';

const tick = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function fixture(extra: Partial<RumikOptions> = {}) {
  const socket = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  });
  const player = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ ws_url: 'wss://silk-api.rumik.ai/ws/tts', token: 'synthetic-token' }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  const spawn = vi.fn(() => player);
  const connect = vi.fn(() => socket as unknown as WebSocket);
  const observe = vi.fn();
  const options = {
    apiKey: 'synthetic-key',
    fetch: fetch as unknown as typeof globalThis.fetch,
    spawn: spawn as unknown as RumikOptions['spawn'],
    connect,
    observe,
    ...extra,
  };
  const speaker = new RumikSpeaker(options);
  const audio = (data = Buffer.alloc(480, 1)) => socket.emit('message', data, true);
  const done = () => socket.emit('message', Buffer.from('{"type":"done"}'), false);
  return { speaker, socket, player, fetch, spawn, connect, observe, audio, done };
}
afterEach(() => vi.useRealTimers());
describe('Rumik streaming boundary', () => {
  it('reuses one connection with separate players despite redundant idle stops', async () => {
    const a = fixture(),
      b = fixture();
    a.spawn.mockReturnValueOnce(a.player).mockReturnValueOnce(b.player);
    const first = a.speaker.speak('First sample.');
    await tick();
    a.socket.emit('open');
    a.audio();
    a.done();
    expect(a.socket.terminate).not.toHaveBeenCalled();
    a.player.emit('close', 0, null);
    await first;
    a.speaker.stop();
    a.speaker.stop();
    const second = a.speaker.speak('Second sample.');
    a.audio();
    a.done();
    b.player.emit('close', 0, null);
    await second;
    expect(a.fetch).toHaveBeenCalledOnce();
    expect(a.connect).toHaveBeenCalledOnce();
    expect(a.socket.send).toHaveBeenCalledTimes(2);
    expect(a.spawn).toHaveBeenCalledTimes(2);
    expect(a.observe.mock.calls.filter(([s]) => s === 'socketReused')).toHaveLength(1);
    a.speaker.dispose();
    expect(a.socket.terminate).toHaveBeenCalledOnce();
    await expect(a.speaker.speak('Closed sample.')).rejects.toThrow('closed');
  });
  it.each(['binary', 'duplicate done', 'error', 'close', 'timeout', 'idle deadline'])(
    'retires idle transport on %s and reconnects only on an explicit request',
    async (reason) => {
      vi.useFakeTimers();
      const a = fixture({ connectionIdleMs: 50 }),
        b = fixture();
      a.connect
        .mockReturnValueOnce(a.socket as unknown as WebSocket)
        .mockReturnValueOnce(b.socket as unknown as WebSocket);
      const first = a.speaker.speak('First sample.');
      await tick();
      a.socket.emit('open');
      a.audio();
      a.done();
      a.player.emit('close', 0, null);
      await first;
      if (reason === 'binary') a.audio();
      if (reason === 'duplicate done') a.done();
      if (reason === 'error') a.socket.emit('error', new Error('private'));
      if (reason === 'close') a.socket.emit('close');
      if (reason === 'timeout') a.socket.emit('message', Buffer.from('{"type":"timeout"}'), false);
      if (reason === 'idle deadline') await vi.advanceTimersByTimeAsync(51);
      expect(a.socket.terminate).toHaveBeenCalledOnce();
      expect(a.fetch).toHaveBeenCalledOnce();
      const next = a.speaker.speak('Next sample.');
      await tick();
      b.socket.emit('open');
      expect(a.fetch).toHaveBeenCalledTimes(2);
      a.audio();
      a.done();
      expect(a.spawn).toHaveBeenCalledOnce();
      a.speaker.dispose();
      await next;
    },
  );
  it.each(['binary', 'done', 'error', 'close'])(
    'retirement after done on %s preserves drain but prevents reuse',
    async (reason) => {
      const a = fixture();
      const p = a.speaker.speak('First sample.');
      await tick();
      a.socket.emit('open');
      a.audio();
      a.done();
      if (reason === 'binary') a.audio();
      if (reason === 'done') a.done();
      if (reason === 'error') a.socket.emit('error', new Error('private'));
      if (reason === 'close') a.socket.emit('close');
      expect(a.player.kill).not.toHaveBeenCalled();
      a.player.emit('close', 0, null);
      await p;
      expect(a.socket.terminate).toHaveBeenCalledOnce();
      a.speaker.dispose();
    },
  );
  it('disposes connecting transport and rejects unsolicited pre-open audio', async () => {
    const a = fixture();
    const p = a.speaker.speak('First sample.');
    await tick();
    a.speaker.dispose();
    a.socket.emit('open');
    a.audio();
    await p;
    expect(a.socket.send).not.toHaveBeenCalled();
    expect(a.spawn).not.toHaveBeenCalled();
    const b = fixture();
    const q = b.speaker.speak('Next sample.');
    const rejected = expect(q).rejects.toThrow('interrupted');
    await tick();
    b.audio();
    await rejected;
    expect(b.spawn).not.toHaveBeenCalled();
  });
  it('masks synchronous socket send failures without escaping the event handler', async () => {
    const f = fixture();
    f.socket.send.mockImplementation(() => {
      throw new Error('private transport detail');
    });
    const p = f.speaker.speak('First sample.');
    const rejected = expect(p).rejects.toThrow('Voice connection failed');
    await tick();
    expect(() => f.socket.emit('open')).not.toThrow();
    await rejected;
    expect(f.socket.terminate).toHaveBeenCalledOnce();
  });
  it('terminal disposal aborts mint and ignores its late success', async () => {
    let complete!: (response: Response) => void;
    const f = fixture({
      fetch: vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    });
    const p = f.speaker.speak('First sample.');
    f.speaker.dispose();
    await p;
    complete(Response.json({ ws_url: 'wss://silk-api.rumik.ai/ws/tts', token: 'synthetic' }));
    await tick();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(['', '   \t'])('defaults blank optional voice settings: %j', async (blank) => {
    const f = fixture({ speaker: blank, description: blank });
    const p = f.speaker.speak('Hello there.');
    await tick();
    f.socket.emit('open');
    f.socket.emit('open');
    expect(JSON.parse(f.socket.send.mock.calls[0][0])).toMatchObject({
      speaker: 'ira',
      description: 'A warm female voice with an Indian accent and conversational pacing.',
    });
    f.speaker.stop();
    await p;
  });
  it.each([
    [401, 'application/json', 'Voice authentication failed. Check the Rumik key.'],
    [200, 'text/html', 'Voice service returned an invalid session.'],
  ])(
    'handles already-errored HTTP %s body cancellation without leaking transport errors',
    async (status, mime, message) => {
      const unhandled = vi.fn();
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.on('unhandledRejection', unhandled);
      try {
        const f = fixture({
          fetch: vi.fn(
            async () =>
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.error(new Error('synthetic-private-transport-error'));
                  },
                }),
                { status: Number(status), headers: { 'content-type': String(mime) } },
              ),
          ),
        });
        await expect(f.speaker.speak('Hello there.')).rejects.toThrow(String(message));
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
        expect(f.spawn).not.toHaveBeenCalled();
        expect(f.connect).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
        log.mockRestore();
      }
    },
  );
  it('starts PCM before done, applies backpressure, and resolves only after player drain', async () => {
    const f = fixture();
    let settled = false;
    const p = f.speaker.speak('The sample is ready.').then(() => {
      settled = true;
    });
    await tick();
    f.socket.emit('open');
    f.socket.emit('open');
    expect(f.socket.send).toHaveBeenCalledWith(expect.stringContaining('"speaker":"ira"'));
    f.audio(Buffer.alloc(80_000, 1));
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.socket.pause).toHaveBeenCalled();
    expect(settled).toBe(false);
    f.player.stdin.read();
    await tick();
    f.socket.emit('open');
    expect(f.socket.resume).toHaveBeenCalled();
    f.done();
    await tick();
    f.socket.emit('open');
    expect(settled).toBe(false);
    f.player.emit('close', 0, null);
    await p;
    expect(f.observe.mock.calls.map((x) => x[0])).toEqual([
      'sessionHeaders',
      'sessionReady',
      'socketOpen',
      'firstPcm',
      'playerWrite',
      'synthesisDone',
      'playerDrained',
    ]);
  });
  it('cancels pending mint immediately and ignores late session data', async () => {
    let complete!: (r: Response) => void;
    const f = fixture({
      fetch: vi.fn(
        () =>
          new Promise<Response>((r) => {
            complete = r;
          }),
      ),
    });
    const p = f.speaker.speak('Hello there.');
    f.speaker.stop();
    await p;
    complete(new Response('{}'));
    await tick();
    f.socket.emit('open');
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(['before audio', 'during audio', 'during drain'])(
    'cancels %s and discards late chunks/errors',
    async (phase) => {
      const f = fixture();
      const p = f.speaker.speak('Hello there.');
      await tick();
      f.socket.emit('open');
      if (phase !== 'before audio') f.audio();
      if (phase === 'during drain') f.done();
      f.speaker.stop();
      f.audio();
      f.socket.emit('error', new Error('synthetic secret'));
      f.done();
      if (phase !== 'before audio') {
        expect(f.player.kill).toHaveBeenCalledWith('SIGKILL');
        f.player.emit('close', null, 'SIGKILL');
      }
      await p;
      expect(f.spawn).toHaveBeenCalledTimes(phase === 'before audio' ? 0 : 1);
      expect(f.socket.terminate).toHaveBeenCalled();
    },
  );
  it('ignores socket errors after synthesis done while valid audio drains', async () => {
    const f = fixture();
    const p = f.speaker.speak('Hello there.');
    await tick();
    f.socket.emit('open');
    f.audio();
    f.done();
    f.socket.emit('error', new Error('late reset'));
    expect(f.player.kill).not.toHaveBeenCalled();
    f.player.emit('close', 0, null);
    await p;
  });
  it('invalid speech does not interrupt current audio', async () => {
    const f = fixture();
    const p = f.speaker.speak('Hello there.');
    await tick();
    f.socket.emit('open');
    f.audio();
    await expect(f.speaker.speak('Long '.repeat(50))).rejects.toThrow('Nothing was spoken');
    expect(f.player.kill).not.toHaveBeenCalled();
    f.done();
    f.player.emit('close', 0, null);
    await p;
  });
  it.each([401, 403, 429, 503, 422])('masks response bodies for HTTP %s without retry or fallback', async (status) => {
    const f = fixture({ fetch: vi.fn(async () => new Response('synthetic-secret-do-not-echo', { status })) });
    await expect(f.speaker.speak('Hello there.')).rejects.not.toThrow('synthetic-secret');
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([
    'https://evil.example/ws',
    'wss://evil.example/ws',
    'wss://silk-api.rumik.ai/ws?secret=x',
    'wss://user@silk-api.rumik.ai/ws',
  ])('rejects unsafe returned socket address %s', async (ws_url) => {
    const f = fixture({ fetch: vi.fn(async () => Response.json({ ws_url, token: 'synthetic' })) });
    await expect(f.speaker.speak('Hello there.')).rejects.toThrow('unsupported streaming address');
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(['wrong mime', 'empty', 'oversize', 'malformed'])('rejects %s mint response', async (kind) => {
    const f = fixture({
      fetch: vi.fn(
        async () =>
          new Response(kind === 'empty' ? '' : kind === 'oversize' ? 'a'.repeat(17_000) : '{', {
            headers: { 'content-type': kind === 'wrong mime' ? 'text/html' : 'application/json' },
          }),
      ),
    });
    await expect(f.speaker.speak('Hello there.')).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(['empty', 'odd', 'wrong format', 'malformed control', 'error', 'early close', 'oversize'])(
    'cleans up %s audio',
    async (kind) => {
      const f = fixture();
      const p = f.speaker.speak('Hello there.');
      const rejected = expect(p).rejects.toThrow();
      await tick();
      f.socket.emit('open');
      if (kind === 'odd') f.audio(Buffer.alloc(1, 1));
      if (kind === 'wrong format') f.audio(Buffer.from('RIFFbad!'));
      if (kind === 'malformed control') f.socket.emit('message', Buffer.from('{'), false);
      if (kind === 'error') f.socket.emit('message', Buffer.from('{"error":"synthetic-secret"}'), false);
      if (kind === 'early close') {
        f.audio();
        f.socket.emit('close');
      }
      if (kind === 'oversize') f.audio(Buffer.alloc(2_160_002));
      f.done();
      if (f.spawn.mock.calls.length) f.player.emit('close', null, 'SIGKILL');
      await rejected;
      expect(f.socket.terminate).toHaveBeenCalled();
    },
  );
  it('handles odd chunk boundaries without losing a sample', async () => {
    const f = fixture();
    const p = f.speaker.speak('Hello there.');
    await tick();
    f.socket.emit('open');
    f.audio(Buffer.from([1]));
    f.audio(Buffer.from([2, 3, 4]));
    expect(f.player.stdin.read()).toEqual(Buffer.from([1, 2, 3, 4]));
    f.done();
    f.player.emit('close', 0, null);
    await p;
  });
  it('bounds stalled network and drain waits', async () => {
    vi.useFakeTimers();
    const f = fixture({ idleMs: 50, totalMs: 100 });
    const p = f.speaker.speak('Hello there.');
    const rejected = expect(p).rejects.toThrow('stalled');
    await tick();
    f.socket.emit('open');
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    const g = fixture({ idleMs: 50, totalMs: 100 });
    const q = g.speaker.speak('Hello there.');
    const rejectedQ = expect(q).rejects.toThrow('timed out');
    await tick();
    g.socket.emit('open');
    g.audio();
    g.done();
    await vi.advanceTimersByTimeAsync(101);
    expect(g.player.kill).toHaveBeenCalled();
    g.player.emit('close', null, 'SIGKILL');
    await rejectedQ;
  });
  it('rejects missing device, masks underlying error, and does not retry', async () => {
    const f = fixture();
    const p = f.speaker.speak('Hello there.');
    const rejected = expect(p).rejects.toThrow('audio device');
    await tick();
    f.socket.emit('open');
    f.audio();
    f.player.emit('error', new Error('synthetic-secret'));
    f.player.emit('close', -2, null);
    await rejected;
    expect(f.spawn).toHaveBeenCalledOnce();
  });
  it('replacement keeps new playback owned through old close and late data', async () => {
    const a = fixture(),
      b = fixture();
    const connect = vi.fn().mockReturnValueOnce(a.socket).mockReturnValueOnce(b.socket);
    const spawn = vi.fn().mockReturnValueOnce(a.player).mockReturnValueOnce(b.player);
    const speaker = new RumikSpeaker({ apiKey: 'synthetic', fetch: a.fetch, connect, spawn });
    const old = speaker.speak('First sample.');
    await tick();
    a.socket.emit('open');
    a.audio();
    const current = speaker.speak('Second sample.');
    await tick();
    b.socket.emit('open');
    b.audio();
    a.player.emit('close', null, 'SIGKILL');
    a.audio();
    await old;
    speaker.stop();
    expect(b.player.kill).toHaveBeenCalledWith('SIGKILL');
    b.player.emit('close', null, 'SIGKILL');
    await current;
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it('rejects a wrong container split across frames before playback', async () => {
    const f = fixture();
    const p = f.speaker.speak('Hello there.');
    const rejected = expect(p).rejects.toThrow('wrong audio format');
    await tick();
    f.socket.emit('open');
    f.audio(Buffer.from('R'));
    f.audio(Buffer.from('IFF'));
    await rejected;
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('aborts mint transport on timeout and never logs nested errors', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url, init) => {
      signal = init.signal;
      return new Promise<Response>(() => {});
    });
    const f = fixture({ fetch, idleMs: 20 });
    const p = f.speaker.speak('Hello there.');
    const rejected = expect(p).rejects.toThrow('stalled');
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
  });
  it('bounds queued playback even if a transport ignores pause', async () => {
    const f = fixture();
    const p = f.speaker.speak('Hello there.');
    const rejected = expect(p).rejects.toThrow('could not keep up');
    await tick();
    f.socket.emit('open');
    for (let i = 0; i < 4; i++) f.audio(Buffer.alloc(200_000, 1));
    expect(f.player.kill).toHaveBeenCalled();
    f.player.emit('close', null, 'SIGKILL');
    await rejected;
  });
  it('missing key and unknown voice fail before any network request', async () => {
    for (const options of [{ apiKey: '' }, { speaker: 'made-up' }]) {
      const f = fixture(options);
      await expect(f.speaker.speak('Hello there.')).rejects.toThrow('not configured');
      expect(f.fetch).not.toHaveBeenCalled();
    }
  });
  it('consumes credential into main-process adapter and supports explicit local selection', () => {
    const env = { RUMIK_API_KEY: 'synthetic', LINUX_BUDDY_TTS_PROVIDER: 'espeak' };
    expect(createSpeakerFromEnvironment(env)).toBeInstanceOf(Speaker);
    expect(env).not.toHaveProperty('RUMIK_API_KEY');
    expect(createSpeakerFromEnvironment({ RUMIK_API_KEY: 'synthetic' })).toBeInstanceOf(RumikSpeaker);
  });
});

describe('Rumik prepare/play split', () => {
  type Behaviour = { open?: 'throw'; write?: 'throw' | 'block'; closeOnAbort?: boolean };
  function testSink(behaviour: Behaviour = {}) {
    const written: Buffer[] = [];
    const calls = { open: 0, abort: 0, end: 0 };
    let drain: (() => void) | undefined;
    let close: ((ok: boolean) => void) | undefined;
    const sink: PcmSink = {
      kind: 'livekit',
      open() {
        calls.open++;
        if (behaviour.open === 'throw') throw new Error('Room disconnected');
        return {
          evidence: 'transport',
          write(pcm) {
            if (behaviour.write === 'throw') throw new Error('Track unpublished');
            written.push(pcm);
            return behaviour.write !== 'block';
          },
          pending: () => 0,
          end() {
            calls.end++;
          },
          abort() {
            calls.abort++;
            if (behaviour.closeOnAbort) close?.(false);
          },
          onDrain: (callback) => (drain = callback),
          onClose: (callback) => (close = callback),
          onFailure() {},
        };
      },
    };
    return { sink, written, calls, drain: () => drain?.(), close: (ok = true) => close?.(ok) };
  }
  async function staged(behaviour: Behaviour = {}) {
    const f = fixture();
    const s = testSink(behaviour);
    f.speaker.sink = s.sink;
    const utterance = f.speaker.prepare('The sample is ready.');
    await tick();
    f.socket.emit('open');
    f.audio(Buffer.alloc(4800, 1));
    await utterance.ready;
    return { f, s, utterance };
  }
  it('stages first playable PCM without playing, then plays it on start before synthesis ends', async () => {
    const { f, s, utterance } = await staged();
    expect(utterance.state()).toBe('ready');
    expect(s.calls.open).toBe(0);
    expect(utterance.metrics()).toMatchObject({ scheduledAudioMs: 0, evidence: 'none' });
    expect(utterance.metrics().pcmArrivedMs).toBeGreaterThanOrEqual(0);
    utterance.start();
    await utterance.scheduled;
    expect(s.calls.open).toBe(1);
    expect(Buffer.concat(s.written).length).toBe(4800);
    expect(utterance.metrics()).toMatchObject({ scheduledAudioMs: 100, evidence: 'transport' });
    f.audio(Buffer.alloc(4800, 1));
    f.done();
    await tick();
    expect(s.calls.end).toBe(1);
    s.close(true);
    await utterance.done;
    expect(utterance.state()).toBe('completed');
    expect(utterance.metrics().scheduledAudioMs).toBe(200);
  });
  it.each(['open', 'write'] as const)('settles as failed when the sink throws on %s at start', async (where) => {
    const { s, utterance } = await staged(where === 'open' ? { open: 'throw' } : { write: 'throw' });
    utterance.start();
    await expect(utterance.done).rejects.toThrow('Voice output failed');
    await expect(utterance.scheduled).rejects.toThrow('Voice output failed');
    expect(utterance.state()).toBe('failed');
    // Nothing was accepted by the sink, so nothing may be reported as scheduled.
    expect(utterance.metrics().sinkScheduledMs).toBeUndefined();
    expect(utterance.metrics().scheduledAudioMs).toBe(0);
    expect(s.written).toHaveLength(0);
  });
  it('cancels a staged utterance before start without opening the sink', async () => {
    const { s, utterance } = await staged();
    utterance.cancel();
    await utterance.done;
    await expect(utterance.scheduled).rejects.toThrow('cancelled');
    expect(utterance.state()).toBe('cancelled');
    expect(s.calls.open).toBe(0);
    utterance.start();
    expect(s.calls.open).toBe(0);
  });
  it('cancels during a blocked drain without leaving a reap timer when the sink closes synchronously', async () => {
    const { f, s, utterance } = await staged({ write: 'block', closeOnAbort: true });
    utterance.start();
    await utterance.scheduled;
    expect(f.socket.pause).toHaveBeenCalled();
    f.audio(Buffer.alloc(4800, 1));
    vi.useFakeTimers();
    utterance.cancel();
    expect(s.calls.abort).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    await utterance.done;
    expect(utterance.state()).toBe('cancelled');
    s.drain();
    expect(s.written).toHaveLength(1);
  });
  it('bounds a sink that never closes after cancellation during a blocked drain', async () => {
    const { s, utterance } = await staged({ write: 'block' });
    utterance.start();
    await utterance.scheduled;
    vi.useFakeTimers();
    utterance.cancel();
    expect(s.calls.abort).toBe(1);
    vi.advanceTimersByTime(1500);
    vi.useRealTimers();
    await expect(utterance.done).rejects.toThrow('did not stop');
  });
});
