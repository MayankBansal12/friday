import { connectRenderer } from './cdp.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

if (!process.env.FRIDAY_ISOLATED_TEST) throw new Error('Requires the isolated native harness');
const [port, state] = process.argv.slice(2);
const { call, close } = await connectRenderer(port);
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 350));
function inspectWindow(move = false) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `
import gi,json,sys
from gi.repository import Gio,GLib
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
reply=bus.call_sync('org.gnome.Shell','/dev/Friday/Test','dev.Friday.Test','Command',GLib.Variant('(s)',(sys.argv[1],)),GLib.VariantType.new('(s)'),Gio.DBusCallFlags.NONE,5000,None)
print(reply.unpack()[0])`,
        JSON.stringify({ op: 'fridayWindow', move }),
      ],
      { encoding: 'utf8' },
    ),
  );
}
function assertPlacement(layout) {
  const { frame, workArea, clientType } = inspectWindow();
  assert.equal(clientType, 'x11', 'Companion must use XWayland for fixed positioning');
  const x =
    layout === 'orb'
      ? workArea.x + workArea.width - frame.width - 18
      : workArea.x + Math.round((workArea.width - frame.width) / 2);
  assert(
    Math.abs(frame.x - x) <= 1 && Math.abs(frame.y - workArea.y - 12) <= 1,
    `${layout} misplaced: ${JSON.stringify({ frame, workArea })}`,
  );
  console.log(`PASS: ${layout} anchored at ${frame.x},${frame.y} (${frame.width}×${frame.height}, ${state})`);
}
async function capture(name) {
  const screenshot = await call('Page.captureScreenshot', {});
  await writeFile(join(process.env.FRIDAY_TEST_STAGE, name), Buffer.from(screenshot.data, 'base64'));
}
try {
  await evaluate('window.buddy.setExpanded(false)');
  await wait();
  assert.equal(await evaluate("document.querySelector('[data-surface]')?.dataset.surface"), 'orb');
  assertPlacement('orb');
  inspectWindow(true);
  await wait();
  assertPlacement('orb');
  await evaluate("window.buddy.setSurface('bar')");
  await wait();
  assertPlacement('bar');
  await evaluate('window.buddy.setExpanded(false)');
  await wait();
  assert.equal(await evaluate('Boolean(document.querySelector(\'[aria-label="Ask Friday"]\'))'), false);
  await capture(`ui-orb-${state}.png`);
  await evaluate('document.querySelector(\'[aria-label="Show Friday updates"]\').click()');
  await wait();
  assert.equal(await evaluate("document.querySelector('[data-surface]')?.dataset.surface"), 'panel');
  assertPlacement('panel');
  assert.equal(await evaluate('Boolean(document.querySelector(\'[aria-label="Ask Friday"]\'))'), false);
  assert.equal(
    await evaluate(
      'Math.abs(innerHeight - document.querySelector(".friday-presence").getBoundingClientRect().height - 20) < 3',
    ),
    true,
    'Panel has unused transparent space that would intercept desktop clicks',
  );
  await capture(`ui-panel-${state}.png`);
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Type instead')).click()");
  await wait();
  assert.equal(await evaluate('Boolean(document.querySelector(\'input[aria-label="Ask Friday"]\'))'), true);
  assert.equal(
    await evaluate("Boolean(document.querySelector('.presence-action.lit'))"),
    false,
    'Opening Friday must not start recording',
  );
  await evaluate('document.querySelector(\'[aria-label="Open settings and history"]\').click()');
  await wait();
  const view = await evaluate(`(async () => {
    window.dispatchEvent(new Event('focus'));
    const ready = ${state !== 'unavailable'};
    for (let attempt = 0; attempt < 80; attempt++) {
      const mark = document.querySelector('[aria-label="Mark screen"]');
      if (mark && mark.disabled === !ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return {
      status: await window.buddy.desktopStatus(),
      markingDisabled: document.querySelector('[aria-label="Mark screen"]')?.disabled,
      modeSelector: Boolean(document.querySelector('[aria-label="Friday capabilities"]')),
      setup: document.querySelector('.desktop-notice')?.textContent || '',
      microphoneActive: Boolean(document.querySelector('.mic-button.active')),
      error: document.querySelector('.error-toast')?.textContent || '',
    };
  })()`);
  assert.equal(view.status.ready, state !== 'unavailable');
  assert.equal(view.markingDisabled, state === 'unavailable');
  assert.equal(view.modeSelector, false);
  assert.equal(view.microphoneActive, false);
  assert.equal(view.error, '');
  if (state === 'unavailable') {
    assert.match(view.setup, /sign out of GNOME/);
    assert.doesNotMatch(view.setup, /GDBus|ServiceUnknown|remote method/);
  } else assert.equal(view.setup, '');
  await evaluate('window.buddy.setExpanded(false)');
  await wait();
  await evaluate('window.buddy.hide()');
  execFileSync(join(process.cwd(), 'release/linux-unpacked/linux-buddy'), ['--no-sandbox'], {
    stdio: 'ignore',
    timeout: 10000,
  });
  await wait();
  assertPlacement('orb');
  console.log(`PASS: packaged orb → panel → optional typing → history/settings (${state}); no automatic recording`);
} finally {
  close();
}
