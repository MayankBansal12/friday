// Real signed-in Codex, restricted to a synthetic GTK app in the isolated seat.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DesktopBridge } from '../../dist-electron/desktop-bridge.js';
import { GnomeClient } from '../../dist-electron/gnome-client.js';

assert.equal(process.env.FRIDAY_ISOLATED_TEST, '1');
const stage = process.env.FRIDAY_TEST_STAGE;
const native = new GnomeClient(new URL('../../native/desktop-client.py', import.meta.url).pathname);
const bridge = new DesktopBridge(
  native,
  () => null,
  (data) => {
    const result = spawnSync(
      'python3',
      [
        '-c',
        'import sys,io,json,base64; from PIL import Image; im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB"); im=im.resize((1440,810)); out=io.BytesIO(); im.save(out,format="JPEG",quality=82); print(base64.b64encode(out.getvalue()).decode())',
      ],
      { input: Buffer.from(data, 'base64'), maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, result.stderr.toString());
    return { data: result.stdout.toString().trim(), width: 1440, height: 810, mimeType: 'image/jpeg' };
  },
);
native.onStopped = (id, error) => bridge.nativeStopped(id, error);
bridge.onControlProgress = (_id, text) => console.log('Computer:', text);
await bridge.start();
try {
  const token = bridge.beginRun('codex-computer-smoke');
  const response = await fetch(bridge.url + '/control', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      goal: 'In the Friday native smoke target window, replace the text in the input field with exactly "Codex verified 42". Open "Choose a demo option" and click "Select this option". Then draw a circle around the text field and report the NEW verification code displayed after selecting the option. These are synthetic local test controls; do not use any other application.',
    }),
    signal: AbortSignal.timeout(315_000),
  });
  const result = await response.json();
  console.log('Codex result:', JSON.stringify(result));
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(await readFile(join(stage, 'typed'), 'utf8'), 'Codex verified 42');
  assert.equal(await readFile(join(stage, 'menu-result'), 'utf8'), 'selected');
  assert.ok(
    result.summary.includes(await readFile(join(stage, 'verification-code'), 'utf8')),
    'Codex did not read the fresh verification code from the returned screenshot',
  );
  const status = await native.command({ op: 'status' });
  assert.equal(status.controlling, false);
  assert.equal(status.inputBlocked, false);
  assert.ok(status.annotations > 0, 'Final drawing was not preserved');
  await writeFile(join(stage, 'computer-timings.json'), JSON.stringify(result, null, 2));
  console.log('PASS: real Codex login → native click/type/menu → verified drawing; no API key');
} finally {
  bridge.close();
}
