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
async function screenshot(name) {
  if (!process.env.FRIDAY_SCREENSHOTS) return;
  await mkdir(process.env.FRIDAY_SCREENSHOTS, { recursive: true });
  const image = await call('Page.captureScreenshot', {});
  await writeFile(`${process.env.FRIDAY_SCREENSHOTS}/${name}.png`, Buffer.from(image.data, 'base64'));
}
const status = "document.querySelector('.presence-heading [role=status]').textContent";
const exists = (selector) => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
const camera = async (state, activity) => {
  await evaluate(
    `fixture.runtime.camera = ${JSON.stringify(state)}; fixture.runtime.cameraActivity = ${activity ?? 'undefined'}; fixture.emit()`,
  );
  await pause();
};
try {
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', {
    url: `${process.env.FRIDAY_PREVIEW_URL || 'http://127.0.0.1:5178'}/tests/presence-preview.html?state=camera`,
  });
  for (let i = 0; i < 100; i++) {
    if (await exists('.friday-presence.is-camera .camera-stage')) break;
    await pause();
  }
  // A live camera keeps the notch expanded, without hover, with its video above the conversation.
  assert.equal(await exists('.friday-presence.is-camera.is-expanded .camera-stage'), true);
  assert.equal(await exists('[aria-label="Collapse to pill"]'), false);
  await evaluate('fixture.cameraFrame()');
  await pause();
  assert.match(await evaluate("document.querySelector('.camera-stage img')?.src ?? ''"), /^blob:/);
  assert.equal(await evaluate("document.querySelectorAll('.presence-content .conversation-answer').length"), 2);
  assert.match(
    await evaluate("document.querySelector('.presence-content').textContent"),
    /green face[\s\S]*right face up once/,
  );
  await screenshot('camera-notch');

  // Every camera step is narrated in the status line, and the video shows when Friday is looking.
  await camera('opening');
  assert.match(await evaluate(status), /Starting your camera to see/);
  assert.match(await evaluate("document.querySelector('.camera-stage').textContent"), /Starting camera/);
  await camera('live', "{ kind: 'looking', at: Date.now() }");
  assert.match(await evaluate(status), /Looking through your camera/);
  assert.equal(await exists('.camera-stage.is-looking'), true);
  await camera('live', "{ kind: 'watching', seconds: 5, at: Date.now() }");
  assert.match(await evaluate(status), /Watching for 5s/);
  await camera('live', "{ kind: 'looked', frames: 1, at: Date.now() }");
  assert.match(await evaluate(status), /Looked through your camera/);
  assert.equal(await exists('.camera-stage.is-looking'), false);
  await camera('live', "{ kind: 'looked', frames: 1, at: Date.now() - 10000 }");
  assert.doesNotMatch(await evaluate(status), /Looked through your camera/);
  // While idle, the video says plainly that a live preview is not Friday watching.
  assert.match(await evaluate("document.querySelector('.camera-activity').textContent"), /only sees when it looks/);
  // Closing always leads, even right after a look.
  await camera('closing', "{ kind: 'looked', frames: 1, at: Date.now() }");
  assert.match(await evaluate(status), /Turning your camera off/);
  await camera('live');

  // Stop releases the camera; a slow device keeps the camera UI until it actually closes.
  await evaluate('fixture.deferCameraClose = true');
  await evaluate('document.querySelector(\'[aria-label="Stop Friday"]\')?.click() ?? window.buddy.stop()');
  await pause();
  assert.equal(await evaluate("fixture.calls.some(c => c[0] === 'stop')"), true);
  assert.match(await evaluate(status), /Turning your camera off/);
  await camera('off');
  assert.doesNotMatch(await evaluate(status), /camera/i);
  assert.equal(await exists('.camera-stage'), false);
  assert.equal(await exists('.friday-presence.is-camera'), false);

  // A camera that stops on its own explains why instead of just vanishing.
  await evaluate(
    "fixture.runtime.camera = 'off'; fixture.runtime.cameraError = { message: 'The camera stopped sending video.', at: Date.now() }; fixture.emit()",
  );
  await pause();
  assert.match(await evaluate('document.body.textContent'), /The camera stopped sending video/);

  await camera('live');
  await evaluate('document.querySelector(\'.camera-stage [aria-label="Turn camera off"]\').click()');
  await pause();
  assert.equal(await evaluate("fixture.calls.some(c => c[0] === 'camera' && c[1] === false)"), true);
  assert.equal(await exists('.camera-stage'), false);

  // The workspace shows the same video above its transcript, and marks turns where Friday used the camera.
  await evaluate('window.buddy.setExpanded(true)');
  await pause(300);
  assert.equal(await evaluate("document.querySelectorAll('.conversation-answer').length"), 2);
  assert.match(
    await evaluate("document.querySelector('.conversation-camera').textContent"),
    /Looked through your camera · 2 frames/,
  );
  // Camera notes are Friday's: they align with its replies on the left, not with the user's messages.
  assert.equal(
    await evaluate(
      "Math.round(document.querySelector('.conversation-camera').getBoundingClientRect().left - document.querySelector('.conversation-answer').getBoundingClientRect().left)",
    ),
    0,
  );
  await evaluate('document.querySelector(\'[aria-label="Turn camera on"]\').click()');
  await pause();
  assert.equal(await evaluate("fixture.calls.some(c => c[0] === 'camera' && c[1] === true)"), true);
  await evaluate('fixture.cameraFrame()');
  await pause();
  assert.equal(await exists('.workspace-camera .camera-stage img'), true);
  assert.match(await evaluate("document.querySelector('.brand-copy').textContent"), /Camera on/);
  await camera('live', "{ kind: 'looking', at: Date.now() }");
  assert.match(await evaluate("document.querySelector('.brand-copy').textContent"), /Looking through your camera/);
  assert.equal(await evaluate("document.querySelector('.composer-tools .camera-button').ariaPressed"), 'true');
  await screenshot('camera-workspace');

  await evaluate('document.querySelector(\'[aria-label="Open settings"]\').click()');
  await pause();
  const toggle =
    "[...document.querySelectorAll('label')].find(l => l.textContent.includes('Friday turns the camera on')).querySelector('input')";
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
    /turns off when Friday goes back to sleep/,
  );
  await screenshot('camera-settings');
  console.log('Camera UI: camera mode, narration, look ring, Stop, off button, workspace, Settings passed.');
} finally {
  close();
}
