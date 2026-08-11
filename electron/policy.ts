import type { Risk, ToolCall } from './types.js';
export interface PolicyDecision {
  risk: Risk;
  approval: boolean;
  reason: string;
}

const BLOCKED = new Set(['su', 'pkexec']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'python', 'python3', 'node', 'perl', 'ruby']);
const DESTRUCTIVE = new Set(['rm', 'rmdir', 'mkfs', 'shred', 'dd', 'wipefs', 'reboot', 'shutdown', 'poweroff']);
const SAFE = new Set([
  'ls',
  'pwd',
  'whoami',
  'date',
  'uname',
  'df',
  'du',
  'ps',
  'rg',
  'find',
  'head',
  'tail',
  'wc',
  'cat',
  'stat',
  'file',
  'which',
  'printenv',
]);
const SAFE_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'branch']);

export function evaluateTool(call: ToolCall): PolicyDecision {
  if (call.kind === 'browser') return { risk: 'low', approval: false, reason: 'Open a web URL' };
  if (call.kind === 'file') {
    const sensitive = /(^|\/)(\.ssh|\.gnupg|\.aws|\.env|keyring|secrets?)(\/|$)/i.test(call.path);
    return sensitive
      ? { risk: 'high', approval: true, reason: 'Read a potentially sensitive path' }
      : { risk: 'low', approval: false, reason: 'Read-only filesystem inspection' };
  }
  const cmd = (call.command.split('/').pop() || call.command).toLowerCase();
  if (BLOCKED.has(cmd)) return { risk: 'blocked', approval: true, reason: 'Direct privilege switching is blocked' };
  if (INTERPRETERS.has(cmd) && call.args.some((arg) => ['-c', '-e', '--eval'].includes(arg)))
    return { risk: 'blocked', approval: true, reason: 'Interpreter code strings are blocked; use typed tools instead' };
  if (cmd === 'sudo' || cmd === 'doas') return { risk: 'high', approval: true, reason: 'Privilege escalation' };
  if (DESTRUCTIVE.has(cmd)) return { risk: 'high', approval: true, reason: 'Potentially destructive command' };
  if (cmd === 'git')
    return SAFE_GIT.has(call.args[0] || 'status')
      ? { risk: 'low', approval: false, reason: 'Read-only git command' }
      : { risk: 'high', approval: true, reason: 'May change or publish repository state' };
  if (['gh', 'curl', 'wget', 'scp', 'rsync', 'ssh'].includes(cmd))
    return { risk: 'high', approval: true, reason: 'May transmit data or modify remote systems' };
  if (/token|password|secret|api[_-]?key/i.test(call.args.join(' ')))
    return { risk: 'high', approval: true, reason: 'Command may expose secrets' };
  if (SAFE.has(cmd)) return { risk: 'low', approval: false, reason: 'Read-only command' };
  return { risk: 'medium', approval: true, reason: 'Command can modify local state' };
}
