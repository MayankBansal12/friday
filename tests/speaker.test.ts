import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
import { Speaker } from '../electron/speaker.js';

function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  });
}
beforeEach(() => spawn.mockReset());
describe('local speech boundary', () => {
  it('rejects a long or formatted reply before starting or interrupting playback', async () => {
    const speaker = new Speaker();
    await expect(speaker.speak('Long '.repeat(50))).rejects.toThrow('Nothing was spoken');
    await expect(speaker.speak('Run `command`.')).rejects.toThrow('Nothing was spoken');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('writes the entire approved text and keeps replacement ownership through stale close', async () => {
    const first = child(),
      second = child();
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const speaker = new Speaker();
    const a = speaker.speak('Open Settings.');
    expect(first.stdin.read().toString()).toBe('Open Settings.');
    const b = speaker.speak('Choose Sound.');
    expect(first.kill).toHaveBeenCalledWith('SIGKILL');
    first.emit('close', null, 'SIGKILL');
    await a;
    speaker.stop();
    expect(second.kill).toHaveBeenCalledWith('SIGKILL');
    second.emit('close', null, 'SIGKILL');
    await b;
  });
});
