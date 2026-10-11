// Moving the pill is not hovering it: a drag closes the hover panel, which stays closed after the
// drop until the pointer leaves and returns. Real React app with simulated IPC (see README).
import assert from 'node:assert/strict';
import { connectRenderer } from './cdp.mjs';
const { call, close } = await connectRenderer(process.env.CDP_PORT || 9338);
const pause = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const open = () => evaluate("Boolean(document.querySelector('.presence-body'))");
const mouse = (type, x, y, extra = {}) => call('Input.dispatchMouseEvent', { type, x, y, ...extra });
const press = { button: 'left', buttons: 1, clickCount: 1 };
try {
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await mouse('mouseMoved', 20, 600);
  await call('Page.navigate', {
    url: `${process.env.FRIDAY_PREVIEW_URL || 'http://127.0.0.1:5178'}/tests/presence-preview.html?state=quiet`,
  });
  for (let i = 0; i < 60 && !(await evaluate("Boolean(document.querySelector('.presence-bar'))")); i++)
    await pause(100);
  await pause(1200);
  // Grab the bar by its mascot, away from its buttons.
  const grip = await evaluate(
    "(() => { const r = document.querySelector('.presence-bar').firstElementChild.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()",
  );
  await mouse('mouseMoved', grip.x, grip.y);
  await pause(400);
  assert.equal(await open(), true, 'hovering opens the panel');

  await mouse('mousePressed', grip.x, grip.y, press);
  for (let step = 1; step <= 8; step++) {
    await mouse('mouseMoved', grip.x + step * 6, grip.y + step * 4, { buttons: 1 });
    await pause(30);
  }
  await pause(200);
  assert.equal(await open(), false, 'dragging closes the panel');
  assert(await evaluate("fixture.calls.some(c => c[0] === 'notchOffset')"), 'the drag must still move the pill');
  await mouse('mouseReleased', grip.x + 48, grip.y + 32, press);
  await pause(600);
  assert.equal(await open(), false, 'dropping does not reopen the panel');
  await mouse('mouseMoved', grip.x + 40, grip.y + 30);
  await pause(600);
  assert.equal(await open(), false, 'moving over the dropped pill keeps it closed');

  await mouse('mouseMoved', 20, 600);
  await pause(700);
  await mouse('mouseMoved', grip.x, grip.y);
  await pause(400);
  assert.equal(await open(), true, 'leaving and coming back opens it again');
  console.log('Notch drag: dragging closed the panel, the drop kept it closed, and hover worked again after leaving.');
} finally {
  close();
}
