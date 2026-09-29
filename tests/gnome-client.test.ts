import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { GnomeClient } from '../electron/gnome-client.js';

it('preserves the native error in both a stop event and the pending command reply', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'friday-native-error-'));
  const script = join(dir, 'native.py');
  await writeFile(
    script,
    `import sys,json
for line in sys.stdin:
 c=json.loads(line)
 error='Control action 1 (click): System dialog opened; computer control stopped'
 print(json.dumps(dict(event='stopped',runId=c['runId'],code='control_failed',error=error)),flush=True)
 print(json.dumps(dict(_requestId=c['_requestId'],code='control_failed',error=error)),flush=True)
`,
  );
  const client = new GnomeClient(script);
  client.onStopped = vi.fn();
  try {
    await expect(client.command({ op: 'act', runId: 'test' })).rejects.toMatchObject({
      code: 'control_failed',
      message: expect.stringContaining('System dialog opened'),
    });
    expect(client.onStopped).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ code: 'control_failed', message: expect.stringContaining('System dialog opened') }),
    );
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
