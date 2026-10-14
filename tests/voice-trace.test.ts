import { describe, expect, it } from 'vitest';
import { validVoiceTrace } from '../electron/voice-trace.js';

describe('voice segment diagnostics', () => {
  it('keeps only allowlisted metadata, rounded and bounded', () => {
    expect(
      validVoiceTrace({
        event: 'noise-steady',
        segment: '9fcddb38-4b11-4392-8831-2a96f73bd0e2',
        atMs: 1234.56,
        revision: 2,
        coverage: 40_000,
        decodeCount: 1,
        coalesced: 0,
        peakQueued: 1,
        floorDb: -48.04,
        levelDb: -41.26,
        quietMs: 2400,
        reason: 'cap',
        text: 'open my bank account',
        audio: new ArrayBuffer(8),
      }),
    ).toEqual({
      event: 'noise-steady',
      segment: '9fcddb38-4b11-4392-8831-2a96f73bd0e2',
      atMs: 1235,
      revision: 2,
      coverageMs: 2500,
      decodeCount: 1,
      coalesced: 0,
      floorDb: -48,
      levelDb: -41.3,
      quietMs: 2400,
      reason: 'cap',
    });
  });

  it('keeps the tail reason a cut-off sentence marks its next turn with', () => {
    expect(validVoiceTrace({ event: 'speech-start', reason: 'tail', coverage: 6400 })).toEqual({
      event: 'speech-start',
      reason: 'tail',
      coverageMs: 400,
    });
  });

  it('rejects unknown events and drops malformed fields', () => {
    for (const bad of [null, 'speech-start', {}, { event: 'transcript' }, { event: 'toString' }])
      expect(validVoiceTrace(bad)).toBeUndefined();
    expect(
      validVoiceTrace({
        event: 'capture-failed',
        segment: '../../etc/passwd',
        floorDb: 'loud',
        levelDb: Number.NaN,
        quietMs: -1,
        coverage: 1e9,
        reason: 'my words here',
      }),
    ).toEqual({ event: 'capture-failed' });
  });
});
