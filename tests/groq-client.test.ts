import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroqClient, wavFromPcm } from '../electron/groq-client.js';

type FetchCall = { url: string; init: RequestInit };
const clients: GroqClient[] = [];
const fetches: ReturnType<typeof trackFetch>[] = [];

function trackFetch(handler: (call: FetchCall, attempt: number) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn((_url: unknown, init: RequestInit) => {
    const call = { url: String(_url), init };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length));
  });
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function setup(options: Partial<ConstructorParameters<typeof GroqClient>[0]> & { apiKey: string }) {
  const tracked = trackFetch(() => jsonResponse({ text: 'नमस्ते' }));
  const client = new GroqClient({ fetch: tracked.fetchFn, ...options });
  clients.push(client);
  fetches.push(tracked);
  return { client, ...tracked };
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.close());
  fetches.length = 0;
});

describe('Groq transcription', () => {
  it('uploads PCM as a WAV container with the turbo model', async () => {
    const { client, calls, fetchFn } = setup({ apiKey: 'groq-key' });
    const audio = new Int16Array([0, 1000, -1000, 5]).buffer;
    await expect(client.transcribePcm(audio)).resolves.toEqual({ text: 'नमस्ते', inferenceMs: expect.any(Number) });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    const headers = new Headers(calls[0].init.headers as HeadersInit);
    expect(headers.get('authorization')).toBe('Bearer groq-key');
    expect(calls[0].init.method).toBe('POST');
    const form = calls[0].init.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('temperature')).toBe('0');
    expect(form.get('language')).toBeNull();
    const file = form.get('file') as File;
    const wav = Buffer.from(await file.arrayBuffer());
    expect(wav.subarray(0, 4)).toEqual(Buffer.from('RIFF'));
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(40)).toBe(8);
    expect(wav.subarray(44)).toEqual(Buffer.from(audio));
  });

  it('honors a model and language override', async () => {
    const { client, calls } = setup({ apiKey: 'k', model: 'whisper-large-v3', language: 'hi' });
    await client.transcribePcm(new Int16Array([1, -1]).buffer);
    const form = calls[0].init.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('language')).toBe('hi');
  });

  it('uploads the converted file path directly', async () => {
    const { client, calls } = setup({ apiKey: 'k' });
    const file = new Blob([wavFromPcm(new Int16Array([2, 3]).buffer)]);
    const wavPath = `/tmp/opencode/groq-test-${Date.now()}.wav`;
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir('/tmp/opencode', { recursive: true });
    await writeFile(wavPath, Buffer.from(await file.arrayBuffer()));
    await expect(client.transcribe(wavPath)).resolves.toMatchObject({ text: 'नमस्ते' });
    const form = calls[0].init.body as FormData;
    expect(form.get('file')).toBeInstanceOf(File);
  });

  it('rejects invalid PCM before any request', async () => {
    const { client } = setup({ apiKey: 'k' });
    await expect(client.transcribePcm(new ArrayBuffer(3))).rejects.toThrow('Invalid PCM');
    await expect(client.transcribePcm(new ArrayBuffer(800002))).rejects.toThrow('Invalid PCM');
    await expect(client.transcribePcm(new ArrayBuffer(0))).rejects.toThrow('Invalid PCM');
    expect(fetches[0].fetchFn).not.toHaveBeenCalled();
  });

  it('retries once on 429 and 5xx, honoring retry-after', async () => {
    const sleeps: number[] = [];
    const tracked = trackFetch((call, attempt) =>
      attempt === 1 ? jsonResponse({ error: 'busy' }, 429, { 'retry-after': '2' }) : jsonResponse({ text: 'ok' }),
    );
    const client = new GroqClient({
      apiKey: 'k',
      fetch: tracked.fetchFn,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    clients.push(client);
    await expect(client.transcribePcm(new Int16Array([1, -1]).buffer)).resolves.toMatchObject({ text: 'ok' });
    expect(tracked.calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it('surfaces auth, rejection, and busy errors without retrying 4xx other than 429', async () => {
    for (const [status, message] of [
      [401, 'authentication failed'],
      [403, 'access denied'],
      [400, 'rejected'],
    ] as const) {
      const tracked = trackFetch(() => jsonResponse({ error: 'x' }, status));
      const client = new GroqClient({ apiKey: 'k', fetch: tracked.fetchFn });
      clients.push(client);
      await expect(client.transcribePcm(new Int16Array([1, -1]).buffer)).rejects.toThrow(message);
      expect(tracked.calls).toHaveLength(1);
    }
    const busy = trackFetch(() => jsonResponse({}, 429, { 'retry-after': '1' }));
    const client = new GroqClient({
      apiKey: 'k',
      fetch: busy.fetchFn,
      sleep: () => Promise.resolve(),
    });
    clients.push(client);
    await expect(client.transcribePcm(new Int16Array([1, -1]).buffer)).rejects.toThrow('Speech service is busy');
    expect(busy.calls).toHaveLength(2);
  });

  it('keeps retries and waits inside one total budget', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    // A slow first attempt leaves too little budget for a 5 s retry-after: fail now, not later.
    const tracked = trackFetch(() => {
      clock += 4000;
      return jsonResponse({}, 503, { 'retry-after': '5' });
    });
    const client = new GroqClient({
      apiKey: 'k',
      fetch: tracked.fetchFn,
      budgetMs: 10_000,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });
    clients.push(client);
    await expect(client.transcribePcm(new Int16Array([1, -1]).buffer)).rejects.toThrow('Speech service is busy');
    expect(tracked.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('aborts a hung request at the budget, including a stalled response body', async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
    const hung = trackFetch((call) => hang(call.init));
    const client = new GroqClient({ apiKey: 'k', fetch: hung.fetchFn, budgetMs: 40 });
    clients.push(client);
    await expect(client.transcribePcm(new Int16Array([1, -1]).buffer)).rejects.toThrow('timed out');
    expect(hung.calls).toHaveLength(1);
    const stalled = trackFetch(
      (call) =>
        new Response(
          new ReadableStream({
            start(controller) {
              call.init.signal!.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
          }),
        ),
    );
    const slowBody = new GroqClient({ apiKey: 'k', fetch: stalled.fetchFn, budgetMs: 40 });
    clients.push(slowBody);
    await expect(slowBody.transcribePcm(new Int16Array([1, -1]).buffer)).rejects.toThrow('timed out');
  });

  it('retries a network failure once, then fails with context', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    const client = new GroqClient({ apiKey: 'k', fetch: fetchFn, sleep: () => Promise.resolve() });
    clients.push(client);
    await expect(client.transcribePcm(new Int16Array([1, -1]).buffer)).rejects.toThrow(
      'Groq transcription request failed',
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('drops what Whisper invents for noise, keeping real speech', async () => {
    const replies = [
      { text: ' Thank you.', segments: [{ text: ' Thank you.', avg_logprob: -0.4 }] },
      { text: ' you', segments: [{ text: ' you', avg_logprob: -0.72 }] },
      { text: ' .', segments: [{ text: ' .', avg_logprob: -0.8 }] },
      {
        text: ' Hey Friday, open my calendar. Thank you.',
        segments: [
          { text: ' Hey Friday, open my calendar.', avg_logprob: -0.1 },
          { text: ' Thank you.', avg_logprob: -1.4 },
        ],
      },
      { text: ' Thank you, that is all.', segments: [{ text: ' Thank you, that is all.', avg_logprob: -0.2 }] },
    ];
    const tracked = trackFetch(() => jsonResponse(replies.shift()));
    const client = new GroqClient({ apiKey: 'k', fetch: tracked.fetchFn });
    clients.push(client);
    const heard = [];
    for (let i = 0; i < 5; i++) heard.push((await client.transcribePcm(new Int16Array([1, -1]).buffer)).text);
    expect(heard).toEqual(['', '', '', 'Hey Friday, open my calendar.', 'Thank you, that is all.']);
  });

  it('rejects invalid and oversized responses', async () => {
    const invalid = trackFetch(() => jsonResponse({ segments: [] }));
    const client = new GroqClient({ apiKey: 'k', fetch: invalid.fetchFn });
    clients.push(client);
    await expect(client.transcribePcm(new Int16Array([1, -1]).buffer)).rejects.toThrow(
      'invalid transcription response',
    );
    expect(invalid.calls).toHaveLength(1);
    const oversized = trackFetch(() => Promise.resolve(new Response('x'.repeat(70_000), { status: 200 })));
    const client2 = new GroqClient({ apiKey: 'k', fetch: oversized.fetchFn });
    clients.push(client2);
    await expect(client2.transcribePcm(new Int16Array([1, -1]).buffer)).rejects.toThrow('oversized');
  });
});
