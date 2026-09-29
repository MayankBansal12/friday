import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { RumikSpeaker } from './rumik-speaker.js';
import { validateSpeech, speechRecovery } from './speech-policy.js';
import {
  refusedUtterance,
  SpeechCancelled,
  type PcmSink,
  type PlaybackMetrics,
  type Utterance,
  type UtteranceState,
  type VoiceOutput,
} from './speech-output.js';

// Deliberate local voice option; hosted failures never silently switch to it.
export class Speaker {
  private disposed = false;
  dispose() {
    this.disposed = true;
    this.stop();
  }
  private child?: ChildProcessWithoutNullStreams;
  private cancelCurrent?: () => void;
  stop() {
    this.cancelCurrent?.();
    this.child?.kill('SIGKILL');
    this.child = undefined;
  }
  speak(text: string): Promise<void> {
    const utterance = this.prepare(text);
    utterance.start();
    return utterance.done;
  }
  /** espeak synthesizes and plays in one process: `ready` means the text was accepted, not that audio exists. */
  prepare(text: string): Utterance {
    const decision = validateSpeech(text);
    const failed = (error: Error) => refusedUtterance(String(text), error, 'espeak');
    if (!decision.ok) return failed(new Error(`${decision.reason} ${speechRecovery}`));
    if (this.disposed) return failed(new Error('Voice output is closed.'));
    this.stop();
    const began = performance.now();
    const since = () => Math.round(performance.now() - began);
    const metrics: PlaybackMetrics = { sink: 'espeak', scheduledAudioMs: 0, evidence: 'none' };
    let state: UtteranceState = 'ready';
    let child: ChildProcessWithoutNullStreams | undefined;
    let resolveDone!: () => void, rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    done.catch(() => {});
    let scheduledResolve!: () => void, scheduledReject!: (error: Error) => void;
    const scheduled = new Promise<void>((yes, no) => {
      scheduledResolve = yes;
      scheduledReject = no;
    });
    scheduled.catch(() => {});
    void done.then(
      () => scheduledReject(new SpeechCancelled()),
      (error: Error) => scheduledReject(error),
    );
    const cancel = () => {
      if (state === 'completed' || state === 'failed' || state === 'cancelled') return;
      state = 'cancelled';
      metrics.endedMs = since();
      child?.kill('SIGKILL');
      if (!child) resolveDone();
    };
    this.cancelCurrent = cancel;
    return {
      text: decision.text,
      ready: Promise.resolve(),
      scheduled,
      done,
      cancel,
      state: () => state,
      metrics: () => ({ ...metrics }),
      start: () => {
        if (state !== 'ready' || this.disposed) return;
        state = 'playing';
        metrics.startRequestedMs = metrics.sinkScheduledMs = since();
        const spawned = spawn('espeak-ng', ['--stdin', '-s', '175'], { stdio: ['pipe', 'pipe', 'pipe'] });
        child = this.child = spawned;
        scheduledResolve();
        spawned.stdout.resume();
        spawned.stderr.resume();
        spawned.once('error', (error) => {
          if (state === 'playing') state = 'failed';
          rejectDone(error);
        });
        spawned.once('close', (code, signal) => {
          if (this.child === spawned) this.child = undefined;
          metrics.endedMs ??= since();
          if (code && !signal) {
            state = 'failed';
            rejectDone(new Error('Local speech output failed'));
          } else {
            if (state === 'playing') state = 'completed';
            resolveDone();
          }
        });
        spawned.stdin.on('error', () => {});
        spawned.stdin.end(decision.text);
      },
    };
  }
}

// Called only after dotenv has loaded in the main process. Remove the credential
// from inherited process environments before starting agents or audio utilities.
export function createSpeakerFromEnvironment(env: NodeJS.ProcessEnv = process.env): VoiceOutput & {
  sink?: PcmSink;
} {
  const apiKey = env.RUMIK_API_KEY ?? '';
  delete env.RUMIK_API_KEY;
  const provider = env.LINUX_BUDDY_TTS_PROVIDER || (apiKey ? 'rumik' : 'espeak');
  if (provider === 'espeak') return new Speaker();
  if (provider === 'rumik')
    return new RumikSpeaker({ apiKey, speaker: env.RUMIK_VOICE, description: env.RUMIK_VOICE_DESCRIPTION });
  const unknown = () =>
    refusedUtterance(
      '',
      new Error('Unknown voice provider. Choose rumik or espeak in the environment settings.'),
      'pw-cat',
    );
  return {
    stop() {},
    dispose() {},
    prepare: unknown,
    speak: () => unknown().done,
  };
}
