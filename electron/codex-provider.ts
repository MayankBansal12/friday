import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProvider, ProviderContext } from './providers.js';
import type { ToolCall } from './types.js';

const schema = {
  type: 'object',
  properties: {
    calls: {
      type: 'array',
      maxItems: 6,
      items: {
        oneOf: [
          {
            type: 'object',
            properties: {
              kind: { const: 'shell' },
              command: { type: 'string' },
              args: { type: 'array', items: { type: 'string' } },
              cwd: { type: 'string' },
              timeoutMs: { type: 'number' },
            },
            required: ['kind', 'command', 'args', 'cwd', 'timeoutMs'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              kind: { const: 'file' },
              operation: { enum: ['list', 'read', 'stat'] },
              path: { type: 'string' },
              maxBytes: { type: 'number' },
            },
            required: ['kind', 'operation', 'path'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { kind: { const: 'browser' }, url: { type: 'string' } },
            required: ['kind', 'url'],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ['calls'],
  additionalProperties: false,
};

export class SafeCodexProvider implements AgentProvider {
  name = 'codex';
  constructor(private readonly binary = process.env.LINUX_BUDDY_CODEX_BIN || 'codex') {}
  async plan(prompt: string, context: ProviderContext): Promise<ToolCall[]> {
    const temp = await mkdtemp(join(tmpdir(), 'linux-buddy-'));
    const schemaPath = join(temp, 'schema.json');
    const outputPath = join(temp, 'answer.json');
    await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    const instruction = `Plan typed Linux tool calls for this request: ${prompt}\nNever use shell syntax/operators. Use argv entries. Working directory: ${context.cwd}`;
    try {
      await new Promise<void>((done, fail) => {
        const child = spawn(
          this.binary,
          [
            'exec',
            '--sandbox',
            'read-only',
            '--output-schema',
            schemaPath,
            '--output-last-message',
            outputPath,
            instruction,
          ],
          { cwd: context.cwd, shell: false, signal: context.signal },
        );
        let errorText = '';
        child.stderr.on('data', (chunk) => {
          errorText += chunk;
        });
        child.on('error', fail);
        child.on('close', (code) =>
          code === 0 ? done() : fail(new Error(`Codex exited ${code}: ${errorText.slice(-1000)}`)),
        );
      });
      const { readFile } = await import('node:fs/promises');
      return (JSON.parse(await readFile(outputPath, 'utf8')) as { calls: ToolCall[] }).calls;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}
