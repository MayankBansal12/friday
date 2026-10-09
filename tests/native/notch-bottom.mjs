// A notch dragged to the bottom of the screen opens upward, keeping its bar under the pointer.
// Uses the real React app with simulated IPC; run with Vite and headless Chromium (see README).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { connectRenderer } from './cdp.mjs';
const { call, close } = await connectRenderer(process.env.CDP_PORT || 9338);
const pause = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const rect = (selector) =>
  evaluate(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && { top: Math.round(r.top), bottom: Math.round(r.bottom), x: r.x + r.width / 2 }; })()`,
  );
try {
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 20 });
  await call('Page.navigate', {
    url: `${process.env.FRIDAY_PREVIEW_URL || 'http://127.0.0.1:5178'}/tests/presence-preview.html?state=quiet&anchor=bottom`,
  });
  for (let i = 0; i < 60 && !(await evaluate("Boolean(document.querySelector('.anchor-bottom .presence-bar'))")); i++)
    await pause(100);
  assert.equal(await evaluate("Boolean(document.querySelector('.presence-root.anchor-bottom'))"), true);
  await pause(1200);
  const resting = await rect('.presence-bar');
  // Hover the bar: the panel opens above it and the bar stays exactly where the pointer is.
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: resting.x, y: resting.bottom - 10 });
  for (let i = 0; i < 30 && !(await evaluate("Boolean(document.querySelector('.presence-body'))")); i++)
    await pause(100);
  await pause(400);
  const bar = await rect('.presence-bar');
  const body = await rect('.presence-body');
  assert(body, 'hovering the bar must open the panel');
  assert.equal(bar.bottom, resting.bottom, 'the bar must not move while the panel opens');
  assert(body.bottom <= bar.top + 1, 'the panel must open above the bar');
  assert.equal(await evaluate("Boolean(document.querySelector('.presence-body'))"), true, 'the panel must stay open');
  await pause(1000);
  assert.equal(
    await evaluate("Boolean(document.querySelector('.presence-body'))"),
    true,
    'the panel must not flap shut',
  );
  if (process.env.FRIDAY_SCREENSHOTS) {
    await mkdir(process.env.FRIDAY_SCREENSHOTS, { recursive: true });
    const image = await call('Page.captureScreenshot', {});
    await writeFile(`${process.env.FRIDAY_SCREENSHOTS}/notch-bottom.png`, Buffer.from(image.data, 'base64'));
  }
  console.log('Notch bottom: the panel opened upward with its bar fixed under the pointer, and stayed open.');
} finally {
  close();
}
