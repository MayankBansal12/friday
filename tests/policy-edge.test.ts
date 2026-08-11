import { describe, expect, it } from 'vitest';
import { evaluateTool } from '../electron/policy.js';

const shell = (command: string, args: string[] = []) => ({
  kind: 'shell' as const,
  command,
  args,
  cwd: '/tmp',
  timeoutMs: 1000,
});
describe('command policy escape resistance', () => {
  it('normalizes absolute executable paths', () =>
    expect(evaluateTool(shell('/usr/bin/rm', ['notes']))).toMatchObject({ risk: 'high', approval: true }));
  it('blocks shell code strings', () =>
    expect(evaluateTool(shell('/bin/bash', ['-c', 'rm -rf notes']))).toMatchObject({ risk: 'blocked' }));
  it('requires approval for git mutations', () =>
    expect(evaluateTool(shell('git', ['commit', '-m', 'change']))).toMatchObject({ risk: 'high', approval: true }));
});
