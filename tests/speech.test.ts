import { describe, expect, it } from 'vitest';
import { SpeechService, detectWakeCommand } from '../electron/speech-service.js';
import { ParakeetClient } from '../electron/parakeet-client.js';
import { GroqClient } from '../electron/groq-client.js';
import { fromWakeWord } from '../electron/wake-command.js';

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

describe('local wake transcripts', () => {
  it('keeps speech from the last wake phrase on', () => {
    expect(fromWakeWord('so anyway. Hey Friday, open my calendar', 'Friday')).toBe('Hey Friday, open my calendar');
    expect(fromWakeWord('hey friday. Hey, Friday! what time is it', 'Friday')).toBe('Hey, Friday! what time is it');
  });
  it('accepts accented spellings of the name once the detector fired', () => {
    for (const heard of ['Freddy', 'Fred', 'Fray', 'Friday'])
      expect(fromWakeWord(`Hey, ${heard}. What time is it?`, 'Friday')).toBe('Hey, Friday. What time is it?');
    expect(fromWakeWord('uh hey Freddy open my calendar', 'Friday')).toBe('hey Friday open my calendar');
  });
  it('rejects a detector false alarm without the phrase', () => {
    expect(fromWakeWord('see you on Friday', 'Friday')).toBeUndefined();
    expect(fromWakeWord('Hey, ready?', 'Friday')).toBeUndefined();
    expect(fromWakeWord('hey there', 'Friday')).toBeUndefined();
  });
});

describe('STT provider selection', () => {
  const restore = () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.LINUX_BUDDY_STT_PROVIDER;
    delete process.env.LINUX_BUDDY_GROQ_STT_MODEL;
    delete process.env.LINUX_BUDDY_GROQ_STT_LANGUAGE;
  };

  it('selects hosted Groq when a key is present and unsets it', () => {
    restore();
    process.env.GROQ_API_KEY = 'test-groq-key';
    const service = new SpeechService('Friday');
    expect(service.client).toBeInstanceOf(GroqClient);
    expect((service.client as GroqClient).model).toBe('whisper-large-v3-turbo');
    expect(process.env.GROQ_API_KEY).toBeUndefined();
    service.close();
  });

  it('keeps local Parakeet without a key and honors an explicit provider', () => {
    restore();
    const local = new SpeechService('Friday');
    expect(local.client).toBeInstanceOf(ParakeetClient);
    local.close();
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.LINUX_BUDDY_STT_PROVIDER = 'parakeet';
    const forcedLocal = new SpeechService('Friday');
    expect(forcedLocal.client).toBeInstanceOf(ParakeetClient);
    forcedLocal.close();
    restore();
  });

  it('honors Groq overrides and rejects broken provider configuration', () => {
    restore();
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.LINUX_BUDDY_GROQ_STT_MODEL = 'whisper-large-v3';
    process.env.LINUX_BUDDY_GROQ_STT_LANGUAGE = 'hi';
    const service = new SpeechService('Friday');
    expect((service.client as GroqClient).model).toBe('whisper-large-v3');
    service.close();
    restore();
    process.env.LINUX_BUDDY_STT_PROVIDER = 'groq';
    expect(() => new SpeechService('Friday')).toThrow('GROQ_API_KEY is missing');
    process.env.LINUX_BUDDY_STT_PROVIDER = 'nope';
    expect(() => new SpeechService('Friday')).toThrow('Unknown STT provider');
    restore();
  });
});
