import { describe, expect, it, vi } from 'vitest';
import { JevClient, validTurn } from '../electron/jev-client.js';

function client(respond: (init: RequestInit) => Response | Promise<Response>) {
  const fetchFn = vi.fn((_url: unknown, init: RequestInit) => Promise.resolve(respond(init)));
  return { jev: new JevClient({ apiKey: 'test-key', fetch: fetchFn as unknown as typeof fetch }), fetchFn };
}
const answer = (choice: string, confidence: number) =>
  new Response(JSON.stringify({ answers: { turn: { type: 'choice', choice, confidence } } }));
const turn = { heard: 'Okay, talk later mom.', task: 'Find flights to Goa', speaking: false };

describe('JevClient', () => {
  it('sends the busy state and a choice question to the systemone endpoint', async () => {
    const { jev, fetchFn } = client(() => answer('ignore', 0.9));
    await jev.decide({ ...turn, lastSaid: 'Looking now.' });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('jev-latest');
    expect(body.state).toMatchObject({
      current_task: 'Find flights to Goa',
      friday_speaking: false,
      friday_last_said: 'Looking now.',
      heard: 'Okay, talk later mom.',
    });
    expect(Object.keys(body.questions.turn.criteria)).toEqual(['interrupt', 'ignore']);
  });

  it('ignores only on a confident ignore verdict', async () => {
    expect(await client(() => answer('ignore', 0.9)).jev.decide(turn)).toMatchObject({ interrupt: false });
    expect(await client(() => answer('ignore', 0.4)).jev.decide(turn)).toMatchObject({ interrupt: true });
    expect(await client(() => answer('interrupt', 0.95)).jev.decide(turn)).toMatchObject({ interrupt: true });
  });

  it('has no decision when the service fails, times out or answers oddly', async () => {
    expect(await client(() => new Response('nope', { status: 401 })).jev.decide(turn)).toBeUndefined();
    expect(await client(() => new Response('not json')).jev.decide(turn)).toBeUndefined();
    expect(await client(() => answer('maybe', 1)).jev.decide(turn)).toBeUndefined();
    const fetchFn = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('abort')))),
    );
    const slow = new JevClient({ apiKey: 'k', timeoutMs: 20, fetch: fetchFn as unknown as typeof fetch });
    expect(await slow.decide(turn)).toBeUndefined();
  });
});

describe('validTurn', () => {
  it('bounds renderer input', () => {
    expect(() => validTurn({ heard: '  ' })).toThrow();
    expect(() => validTurn('hi')).toThrow();
    const valid = validTurn({ heard: 'x'.repeat(900), speaking: 'yes', task: 3 });
    expect(valid.heard).toHaveLength(500);
    expect(valid).toMatchObject({ speaking: false, task: undefined });
  });
});
