import { describe, expect, it } from 'vitest';
import { detectWakeCommand } from '../electron/speech-service.js';
import { detectStopCommand } from '../electron/wake-command.js';

it('recognizes addressed stop commands without treating incidental speech as stop', () => {
  for (const text of ['Friday stop', 'Hey Friday, stop!', 'Friday, please stop.', 'Friday stop please'])
    expect(detectStopCommand(text, 'Friday')).toBe(true);
  for (const text of [
    'stop',
    'stop on Friday',
    'Friday stop by the shop',
    'Say Friday stop to interrupt',
    'Hey Friday, do not stop',
  ])
    expect(detectStopCommand(text, 'Friday')).toBe(false);
  expect(detectStopCommand('Computer, stop', 'Computer')).toBe(true);
  expect(detectStopCommand('Friday, stop', 'Computer')).toBe(false);
});

describe('Friday wake word', () => {
  it('accepts Hey Friday with a request in the same utterance', () => {
    const detected = detectWakeCommand('Hey Friday, open my calendar', 'Friday', false);
    expect(detected.result).toEqual({
      text: 'Hey Friday, open my calendar',
      wakeDetected: true,
      command: 'open my calendar',
    });
    expect(detected.armed).toBe(false);
  });

  it('ignores incidental mentions of Friday', () => {
    expect(detectWakeCommand('the meeting is on Friday, open my calendar', 'Friday', false).result.wakeDetected).toBe(
      false,
    );
  });

  it('ignores an utterance without the wake word', () => {
    expect(detectWakeCommand('open my calendar', 'Friday', false).result).toEqual({
      text: 'open my calendar',
      wakeDetected: false,
    });
  });

  it('arms on a wake-only utterance and accepts the following utterance', () => {
    const wake = detectWakeCommand('Friday!', 'Friday', false);
    expect(wake.result.command).toBeUndefined();
    expect(wake.armed).toBe(true);
    expect(detectWakeCommand('please open my calendar', 'Friday', wake.armed).result.command).toBe(
      'please open my calendar',
    );
  });

  it('supports a custom wake word and punctuation', () => {
    expect(detectWakeCommand('Hey Computer—show me downloads', 'Computer', false).result.command).toBe(
      'show me downloads',
    );
  });
});

it('requires a greeting before commands and rejects possessive or incidental names', () => {
  for (const text of [
    'Friday works for me.',
    'Hey Friday-night plans',
    'Friday’s meeting moved',
    "Friday's meeting moved",
    "Hey Friday's meeting moved",
    'Friday-night plans',
  ]) {
    expect(detectWakeCommand(text, 'Friday', false).result.wakeDetected).toBe(false);
  }
  expect(detectWakeCommand('Hey Friday, what is next?', 'Friday', false).result.command).toBe('what is next?');
});

// Exercise the public queue/reset boundary without running ffmpeg or a speech model.
// The injected conversion stage represents slow local inference.
it('serializes overlapping transcriptions and drops obsolete queued interactions', async () => {
  const { SpeechService } = await import('../electron/speech-service.js');
  const service = new SpeechService('Friday');
  const stage = service as unknown as {
    transcribeAudio(
      audio: ArrayBuffer,
      type: string,
      generation: number,
    ): Promise<{ text: string; wakeDetected: boolean }>;
  };
  const calls: number[] = [];
  let finish: (() => void) | undefined;
  stage.transcribeAudio = async (_audio, _type, generation) => {
    calls.push(generation);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { text: 'request', wakeDetected: false };
  };
  const first = service.transcribe(new ArrayBuffer(2000), 'audio/webm');
  const obsolete = service.transcribe(new ArrayBuffer(2000), 'audio/webm');
  await Promise.resolve();
  await Promise.resolve();
  service.reset();
  const current = service.transcribe(new ArrayBuffer(2000), 'audio/webm');
  expect(calls).toEqual([0]);
  finish!();
  await first;
  expect(await obsolete).toEqual({ text: '', wakeDetected: false });
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toEqual([0, 1]);
  finish!();
  await current;
  service.close();
});

it('bounds host PCM work to active plus newest, and reset cannot turn late replies into new work', async () => {
  const { SpeechService } = await import('../electron/speech-service.js');
  const service = new SpeechService('Friday');
  const calls: Array<{ resolve: (r: { text: string; inferenceMs: number }) => void }> = [];
  const internals = service as unknown as {
    client: { transcribePcm(a: ArrayBuffer): Promise<{ text: string; inferenceMs: number }> };
  };
  internals.client.transcribePcm = () => new Promise((resolve) => calls.push({ resolve }));
  const req = (revision: number) => ({ segment: 'one', revision, coverage: 320, audio: new ArrayBuffer(640) });
  const first = service.transcribePcm(req(1));
  await Promise.resolve();
  await Promise.resolve();
  const old = service.transcribePcm(req(2));
  const newest = service.transcribePcm(req(3));
  expect(await old).toMatchObject({ cancelled: true, revision: 2 });
  expect(calls).toHaveLength(1);
  service.reset();
  expect(await newest).toMatchObject({ cancelled: true });
  calls[0].resolve({ text: 'late', inferenceMs: 1 });
  expect(await first).toMatchObject({ cancelled: true });
  await Promise.resolve();
  expect(calls).toHaveLength(1);
  service.close();
});
