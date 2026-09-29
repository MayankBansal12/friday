import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { RumikSpeaker } from './rumik-speaker.js';
import { validateSpeech, speechRecovery } from './speech-policy.js';

// Deliberate local voice option; hosted failures never silently switch to it.
export class Speaker {
  private disposed = false;
  dispose() {
    this.disposed = true;
    this.stop();
  }
  private child?: ChildProcessWithoutNullStreams;
  stop() {
    this.child?.kill('SIGKILL');
    this.child = undefined;
  }
  speak(text: string): Promise<void> {
    const decision = validateSpeech(text);
    if (!decision.ok) return Promise.reject(new Error(`${decision.reason} ${speechRecovery}`));
    if (this.disposed) return Promise.reject(new Error('Voice output is closed.'));
    this.stop();
    return new Promise((resolve, reject) => {
      const child = spawn('espeak-ng', ['--stdin', '-s', '175'], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stdout.resume();
      child.stderr.resume();
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (this.child === child) this.child = undefined;
        if (code && !signal) reject(new Error('Local speech output failed'));
        else resolve();
      });
      child.stdin.on('error', () => {});
      child.stdin.end(decision.text);
    });
  }
}

// Called only after dotenv has loaded in the main process. Remove the credential
// from inherited process environments before starting agents or audio utilities.
export function createSpeakerFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.RUMIK_API_KEY ?? '';
  delete env.RUMIK_API_KEY;
  const provider = env.LINUX_BUDDY_TTS_PROVIDER || (apiKey ? 'rumik' : 'espeak');
  if (provider === 'espeak') return new Speaker();
  if (provider === 'rumik')
    return new RumikSpeaker({ apiKey, speaker: env.RUMIK_VOICE, description: env.RUMIK_VOICE_DESCRIPTION });
  return {
    stop() {},
    dispose() {},
    speak: () =>
      Promise.reject(new Error('Unknown voice provider. Choose rumik or espeak in the environment settings.')),
  };
}
