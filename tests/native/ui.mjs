import { connectRenderer } from './cdp.mjs';
// CDP is enabled only by the isolated native test harness, never by Friday itself.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

if (!process.env.FRIDAY_ISOLATED_TEST) throw new Error('Requires the isolated native harness');
const [port, state] = process.argv.slice(2);
const { call, close } = await connectRenderer(port);
try {
  const result = await call('Runtime.evaluate', {
    expression: `(async () => {
      window.dispatchEvent(new Event('focus'));
      const ready = ${state !== 'unavailable'};
      for (let attempt = 0; attempt < 80; attempt++) {
        const mark = document.querySelector('[aria-label="Mark screen"]');
        if (mark && mark.disabled === !ready && !document.querySelector('.loading-state')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return {
        status: await window.buddy.desktopStatus(),
        markingDisabled: document.querySelector('[aria-label="Mark screen"]')?.disabled,
        modeSelector: Boolean(document.querySelector('[aria-label="Friday capabilities"]')),
        compact: Boolean(document.querySelector('.compact-shell')),
        requestBox: Boolean(document.querySelector('textarea[aria-label="Ask Friday"]')),
        setup: document.querySelector('.desktop-notice')?.textContent || '',
        microphoneActive: Boolean(document.querySelector('.mic-button.active')),
        error: document.querySelector('.error-toast')?.textContent || '',
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  const view = result.result.value;
  assert.equal(view.status.ready, state !== 'unavailable');
  assert.equal(view.markingDisabled, state === 'unavailable');
  assert.equal(view.modeSelector, false);
  assert.equal(view.requestBox, true);
  assert.equal(view.compact, true);
  assert.equal(view.microphoneActive, false, 'Opening Friday must not start recording');
  assert.equal(view.error, '');
  if (state === 'unavailable') {
    assert.match(view.setup, /sign out of GNOME/);
    assert.doesNotMatch(view.setup, /GDBus|ServiceUnknown|remote method/);
  } else assert.equal(view.setup, '');
  const screenshot = await call('Page.captureScreenshot', {});
  await writeFile(join(process.env.FRIDAY_TEST_STAGE, `ui-${state}.png`), Buffer.from(screenshot.data, 'base64'));
  console.log(
    `PASS: packaged request UI (${state}), screen marking availability, no mode selector or automatic microphone`,
  );
} finally {
  close();
}
