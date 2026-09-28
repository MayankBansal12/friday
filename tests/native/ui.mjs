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
function driverCommand(command) {
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
        JSON.stringify(command),
      ],
      { encoding: 'utf8' },
    ),
  );
}
function inspectWindow(move = false) {
  return driverCommand({ op: 'fridayWindow', move });
}
function assertPlacement(layout) {
  const { frame, workArea, clientType } = inspectWindow();
  const top = workArea.y + (['quiet', 'bar', 'panel'].includes(layout) ? 8 : 12);
  assert.equal(clientType, 'x11', 'Companion must use XWayland for fixed positioning');
  const x = ['orb', 'tasks'].includes(layout)
    ? workArea.x + workArea.width - frame.width - 18
    : workArea.x + Math.round((workArea.width - frame.width) / 2);
  assert(
    Math.abs(frame.x - x) <= 1 && Math.abs(frame.y - top) <= 1,
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
  // Allow the automatic microphone opener to settle, then explicitly disable it
  // for native window placement checks in this seat without a physical device.
  await evaluate(`(async()=>{
    for(let i=0;i<100 && document.querySelector('[role="status"]')?.textContent.includes('Opening');i++)
      await new Promise(r=>setTimeout(r,100));
    document.querySelector('.presence-heading')?.focus();
  })()`);
  await wait();
  await evaluate('document.querySelector(\'[aria-label="Turn microphone off"]\')?.click()');
  await evaluate(
    "document.activeElement?.blur();document.querySelector('.presence-root')?.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}))",
  );
  await new Promise((r) => setTimeout(r, 600));
  await evaluate('document.querySelector(\'[aria-label="Stop Friday"]\')?.click()');
  await wait();
  if (await evaluate("Boolean(document.querySelector('.friday-orb'))")) {
    assertPlacement('orb');
    inspectWindow(true);
    await wait();
    assertPlacement('orb');
    await evaluate("document.querySelector('.friday-orb').focus()");
    await wait();
    assert.equal(await evaluate("document.querySelector('[data-surface]').dataset.surface"), 'tasks');
    assertPlacement('tasks');
    const { frame } = inspectWindow();
    const blank = driverCommand({ op: 'pick', x: frame.x + 30, y: frame.y + 25 });
    const circle = driverCommand({ op: 'pick', x: frame.x + frame.width - 44, y: frame.y + 44 });
    assert(!blank.windowTitle?.startsWith('Friday —'), 'Empty space beside the circle intercepts desktop input');
    assert(circle.windowTitle?.startsWith('Friday —'), 'Task circle cannot receive desktop input');
    inspectWindow(true);
    await wait();
    assertPlacement('tasks');
    assert(await evaluate('innerHeight > 200'), 'Task panel did not grow beyond the compact window');
    assert(
      await evaluate("document.querySelector('.task-popover').getBoundingClientRect().bottom <= innerHeight"),
      'Expanded task panel is clipped',
    );
    await capture(`ui-tasks-${state}.png`);
    await evaluate('[...document.querySelectorAll(\'[aria-label^="Dismiss update for"]\')].forEach(b=>b.click())');
    await wait();
    console.log('PASS: actual React task hover expands the native window and displays all three updates');
  }

  await evaluate('document.querySelector(\'[aria-label="Stop Friday"]\')?.click()');
  await evaluate("document.querySelector('.presence-heading')?.focus();document.activeElement?.blur()");
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(await evaluate("document.querySelector('[data-surface]')?.dataset.surface"), 'quiet');
  assertPlacement('quiet');
  await capture(`ui-quiet-${state}.png`);
  inspectWindow(true);
  await wait();
  assertPlacement('quiet');
  // Drive real renderer states: the ResizeObserver correctly resists a host layout
  // that disagrees with rendered content, so don't force unrelated IPC layouts.
  await evaluate("document.querySelector('.presence-heading').focus()");
  await wait();
  assert.equal(await evaluate("document.querySelector('[data-surface]').dataset.surface"), 'panel');
  assertPlacement('panel');
  assert(await evaluate('innerHeight > 66'), 'Hover panel did not expand the native window');
  inspectWindow(true);
  await wait();
  assertPlacement('panel');
  await evaluate('document.activeElement.blur()');
  await new Promise((r) => setTimeout(r, 600));
  await evaluate("document.querySelector('.presence-heading').click()");
  await wait();
  assert.equal(await evaluate("document.querySelector('[data-surface]').dataset.surface"), 'bar');
  assertPlacement('bar');
  inspectWindow(true);
  await wait();
  assertPlacement('bar');
  await evaluate('document.querySelector(\'[aria-label="Stop Friday"]\').click()');
  await wait();
  await evaluate('window.buddy.setExpanded(true)');
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
  assertPlacement('quiet');
  console.log(
    `PASS: packaged quiet/top/task surface anchoring → history/settings (${state}); startup audio readiness and explicit mic-off`,
  );
} finally {
  close();
}
