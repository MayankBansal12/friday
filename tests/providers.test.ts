import { describe, expect, it } from 'vitest';
import { DemoProvider } from '../electron/providers.js';

const context = { cwd: '/home/test', signal: new AbortController().signal };

describe('demo provider', () => {
  it('maps the disk usage example to a read-only disk command', async () => {
    await expect(new DemoProvider().plan('Show disk usage', context)).resolves.toEqual([
      { kind: 'shell', command: 'df', args: ['-h'], cwd: context.cwd, timeoutMs: 10_000 },
    ]);
  });

  it('maps the running processes example to a read-only process command', async () => {
    await expect(new DemoProvider().plan('Show running processes', context)).resolves.toEqual([
      { kind: 'shell', command: 'ps', args: ['aux'], cwd: context.cwd, timeoutMs: 10_000 },
    ]);
  });

  it('keeps explicit file reads intact', async () => {
    await expect(new DemoProvider().plan('Read README.md', context)).resolves.toMatchObject([
      { kind: 'file', operation: 'read', path: '/home/test/README.md' },
    ]);
  });
});
