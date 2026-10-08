// Uses the real React app with simulated IPC/media; never opens a camera.
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
try {
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', {
    url: `${process.env.FRIDAY_PREVIEW_URL || 'http://127.0.0.1:5178'}/tests/presence-preview.html?state=camera`,
  });
  for (let i = 0; i < 100; i++) {
    if (await evaluate("document.querySelector('.presence-heading')?.textContent.includes('Camera on')")) break;
    await pause();
  }
  assert.match(await evaluate("document.querySelector('.presence-heading [role=status]').textContent"), /Camera on/);
  assert.equal(await evaluate('Boolean(document.querySelector(\'[aria-label="Stop Friday"]\'))'), true);
  await evaluate('fixture.deferCameraClose = true');
  await evaluate('document.querySelector(\'[aria-label="Stop Friday"]\').click()');
  await pause();
  assert.equal(await evaluate("fixture.calls.some(c => c[0] === 'stop')"), true);
  assert.match(
    await evaluate("document.querySelector('.presence-heading [role=status]').textContent"),
    /Camera on · Waiting to close/,
  );
  await evaluate('fixture.runtime.cameraActive = false; fixture.runtime.cameraClosing = false; fixture.emit()');
  await pause();
  assert.doesNotMatch(
    await evaluate("document.querySelector('.presence-heading [role=status]').textContent"),
    /Camera on/,
  );
  await evaluate('fixture.runtime.cameraActive = true; fixture.emit(); window.buddy.setExpanded(true)');
  await pause();
  assert.match(await evaluate("document.querySelector('.brand-copy').textContent"), /Camera on/);
  await evaluate('document.querySelector(\'[aria-label="Open settings"]\').click()');
  await pause();
  const toggle =
    "[...document.querySelectorAll('label')].find(l => l.textContent.includes('Camera snapshots')).querySelector('input')";
  assert.equal(await evaluate(`${toggle}.checked`), true);
  await evaluate(`${toggle}.click()`);
  await pause();
  assert.equal(await evaluate(`${toggle}.checked`), false);
  assert.equal(await evaluate("fixture.calls.some(c => c[0] === 'settings' && c[1].cameraEnabled === false)"), true);
  await evaluate(`${toggle}.click()`);
  await pause();
  assert.equal(await evaluate(`${toggle}.checked`), true);
  assert.equal(await evaluate("fixture.calls.some(c => c[0] === 'settings' && c[1].cameraEnabled === true)"), true);
  assert.match(
    await evaluate("document.querySelector('.settings-dialog').textContent"),
    /Earlier photos may be sent again in this conversation, even with access off/,
  );
  if (process.env.FRIDAY_SCREENSHOTS) {
    await mkdir(process.env.FRIDAY_SCREENSHOTS, { recursive: true });
    const screenshot = await call('Page.captureScreenshot', {});
    await writeFile(`${process.env.FRIDAY_SCREENSHOTS}/camera-settings.png`, Buffer.from(screenshot.data, 'base64'));
  }
  console.log('Camera UI: active status in notch/workspace, Stop, default-on, disable and re-enable passed.');
} finally {
  close();
}
