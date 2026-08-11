import { describe, expect, it } from 'vitest';
import { evaluateTool } from '../electron/policy.js';

const shell = (command: string, args: string[] = []) => ({
  kind: 'shell' as const,
  command,
  args,
  cwd: '/tmp',
  timeoutMs: 1000,
});
describe('command policy', () => {
  it('allows known read-only commands', () =>
    expect(evaluateTool(shell('ls', ['-la']))).toMatchObject({ risk: 'low', approval: false }));
  it('requires approval for destructive commands', () =>
    expect(evaluateTool(shell('rm', ['-rf', 'notes']))).toMatchObject({ risk: 'high', approval: true }));
  it('requires approval for privilege escalation', () =>
    expect(evaluateTool(shell('sudo', ['apt', 'upgrade']))).toMatchObject({ risk: 'high', approval: true }));
  it('requires approval for unknown state-changing commands', () =>
    expect(evaluateTool(shell('touch', ['file']))).toMatchObject({ risk: 'medium', approval: true }));
  it('protects sensitive filesystem paths', () =>
    expect(evaluateTool({ kind: 'file', operation: 'read', path: '/home/me/.ssh/id_ed25519' })).toMatchObject({
      risk: 'high',
      approval: true,
    }));
});
