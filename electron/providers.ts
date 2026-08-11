import { resolve } from 'node:path';
import type { ToolCall } from './types.js';

export interface ProviderContext {
  cwd: string;
  signal: AbortSignal;
}
export interface AgentProvider {
  name: string;
  plan(prompt: string, context: ProviderContext): Promise<ToolCall[]>;
}

function tokenize(input: string): string[] {
  const result: string[] = [];
  let current = '',
    quote = '';
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"' && input[i + 1]) current += input[++i];
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = '';
      }
    } else if ('|;&><`'.includes(char))
      throw new Error('Shell operators are not accepted; use one command and arguments.');
    else current += char;
  }
  if (quote) throw new Error('Unclosed quote in command');
  if (current) result.push(current);
  return result;
}

export class DemoProvider implements AgentProvider {
  name = 'demo';
  async plan(prompt: string, context: ProviderContext): Promise<ToolCall[]> {
    const text = prompt.trim();
    const run = text.match(/^(?:run|execute)\s+(.+)$/i);
    if (run) {
      const [command, ...args] = tokenize(run[1]);
      if (!command) throw new Error('No command supplied');
      return [{ kind: 'shell', command, args, cwd: context.cwd, timeoutMs: 30_000 }];
    }
    const open = text.match(/^(?:open|browse(?: to)?)\s+(https?:\/\/\S+)$/i);
    if (open) return [{ kind: 'browser', url: open[1] }];
    if (/process|what.*running/i.test(text))
      return [{ kind: 'shell', command: 'ps', args: ['aux'], cwd: context.cwd, timeoutMs: 10_000 }];
    if (/disk|storage/i.test(text))
      return [{ kind: 'shell', command: 'df', args: ['-h'], cwd: context.cwd, timeoutMs: 10_000 }];
    const read = text.match(/^(?:read|show)\s+(?:file\s+)?(.+)$/i);
    if (read) return [{ kind: 'file', operation: 'read', path: resolve(context.cwd, read[1]), maxBytes: 64_000 }];
    const list = text.match(/^(?:list|show)\s+(?:files|directory)(?:\s+(?:in\s+)?(.+))?$/i);
    if (list) return [{ kind: 'file', operation: 'list', path: resolve(context.cwd, list[1] || '.') }];
    return [{ kind: 'shell', command: 'uname', args: ['-a'], cwd: context.cwd, timeoutMs: 10_000 }];
  }
}
