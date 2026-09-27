import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

// espeak-ng is already installed on this Fedora machine. No network voice service.
export class Speaker {
  private child?: ChildProcessWithoutNullStreams;
  stop() {
    this.child?.kill('SIGKILL');
    this.child = undefined;
  }
  speak(text: string): Promise<void> {
    this.stop();
    if (!text.trim()) return Promise.resolve();
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
      child.stdin.end(text.slice(0, 8000));
    });
  }
}
