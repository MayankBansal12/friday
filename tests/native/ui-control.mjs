// Full packaged app → parent → Codex → native input, only in the synthetic seat.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { connectRenderer } from './cdp.mjs';
assert.equal(process.env.FRIDAY_ISOLATED_TEST, '1');
const stage = process.env.FRIDAY_TEST_STAGE;
const { call, close } = await connectRenderer(process.argv[2]);
const pause = () => new Promise((r) => setTimeout(r, 150));
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
function driver(value) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `
import gi,json,sys
from gi.repository import Gio,GLib
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
r=bus.call_sync('org.gnome.Shell','/dev/Friday/Test','dev.Friday.Test','Command',GLib.Variant('(s)',(sys.argv[1],)),GLib.VariantType.new('(s)'),Gio.DBusCallFlags.NONE,5000,None)
print(r.unpack()[0])`,
        JSON.stringify(value),
      ],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    ),
  );
}
async function run(prompt, inject = false) {
  const task = await evaluate(`window.buddy.submit(${JSON.stringify(prompt)})`);
  let sawControl = false;
  const deadline = Date.now() + 260_000;
  while (Date.now() < deadline) {
    const controlling = await evaluate('window.buddy.controlling()');
    if (controlling && !sawControl) {
      // Let the renderer paint the new status and settle its existing pill.
      await new Promise((r) => setTimeout(r, 600));
      const state = await evaluate(
        `({surface:document.querySelector('[data-surface]')?.dataset.surface,text:document.querySelector('[role=status]')?.textContent,count:document.querySelectorAll('.friday-presence').length})`,
      );
      assert.equal(state.surface, 'bar', JSON.stringify(state));
      assert.equal(state.count, 1);
      assert.match(state.text, /Controlling your computer/);
      assert.match(state.text, /Esc twice/);
      const w = driver({ op: 'fridayWindow' });
      assert(w.mapped && w.showing && !w.focused, JSON.stringify(w));
      assert(w.frame.height <= 70, JSON.stringify(w));
      // Actor picking ignores the shield for this one read, without opening input.
      const pick = driver({ op: 'controlPillPick', x: w.frame.x + w.frame.width / 2, y: w.frame.y + 20 });
      assert.equal(pick.friday, false, JSON.stringify(pick));
      assert.equal(pick.keyboardBlocked, true, 'Keyboard shield lost focus during the initial model wait');
      await writeFile(join(stage, 'ui-control-composed.png'), Buffer.from(driver({ op: 'capture' }).data, 'base64'));
      sawControl = true;
      if (inject) driver({ op: 'failControl' });
    }
    const current = await evaluate(`window.buddy.listTasks().then(ts=>ts.find(t=>t.id===${JSON.stringify(task.id)}))`);
    if (['completed', 'failed', 'cancelled'].includes(current.status)) {
      assert(sawControl, JSON.stringify(current));
      assert.equal(current.status, 'completed', JSON.stringify(current));
      const step = current.steps.find((s) => s.title === 'Using desktop control');
      assert(step, JSON.stringify(current));
      assert.equal(step.status, inject ? 'failed' : 'done', JSON.stringify(current));
      if (inject) {
        assert.match(JSON.stringify(current), /Synthetic input delivery failure/);
        const history = await readFile(
          join(stage, 'config/linux-buddy/conversations', current.conversationId + '.jsonl'),
          'utf8',
        );
        const results = history
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((x) => x.message?.role === 'toolResult' && x.message?.toolName === 'desktop_control');
        assert.match(JSON.stringify(results.at(-1)), /Synthetic input delivery failure/);
      }
      assert.equal(await evaluate('window.buddy.controlling()'), false);
      return current;
    }
    await pause();
  }
  throw new Error('Packaged control request timed out');
}
try {
  await evaluate('window.buddy.updateSettings({autoSpeak:false})');
  driver({ op: 'recordControlCapture' });
  await run(
    'Use desktop_control to replace the text in the input field of the Friday native smoke target window with exactly "Pill verified 42", then draw a circle around that field. These are synthetic test controls. Do not use another application.',
  );
  assert.equal(await readFile(join(stage, 'typed'), 'utf8'), 'Pill verified 42');
  // Screenshots must exclude the actual pill while the user still sees it.
  execFileSync('python3', [
    '-c',
    `
from PIL import Image,ImageChops
import sys,json
from pathlib import Path
p=Path(sys.argv[1]); a=Image.open(p/'ui-control-clean.png').convert('RGB'); b=Image.open(p/'ui-control-composed.png').convert('RGB')
assert ImageChops.difference(a.crop((750,35,1150,85)),b.crop((750,35,1150,85))).getbbox(), 'Pill leaked into model screenshot or disappeared'
`,
    stage,
  ]);
  console.log(
    'PASS: packaged parent + Codex control, one visible click-through pill, clean screenshot, typing and drawing',
  );
  await run(
    'Use desktop_control to click the main button in the synthetic Friday native smoke target window. If it fails, report the returned error and do not retry.',
    true,
  );
  console.log('PASS: native failure reaches parent, completed reply and saved tool result; input released');
} finally {
  close();
}
// Chromium can leave its remote-debug socket open after a long agent turn.
// All assertions and artifact writes above have finished before this CLI exits.
process.exit(0);
