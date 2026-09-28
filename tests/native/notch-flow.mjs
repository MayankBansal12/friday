// Full renderer lifecycle with deterministic PCM and IPC; no agent/network side effects.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { connectRenderer } from './cdp.mjs';
const { call, close } = await connectRenderer(process.env.CDP_PORT || 9333);
const output = process.env.FRIDAY_SCREENSHOTS || '/tmp/friday-notch-flow';
await mkdir(output, { recursive: true });
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function open(state) {
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 500 });
  await call('Page.navigate', { url: `http://127.0.0.1:5174/tests/presence-preview.html?state=${state}` });
  await pause(1000);
}
async function speech(text) {
  await evaluate('fixture.level=1');
  await pause(80);
  await evaluate('fixture.capture.endUtterance()');
  await pause();
  await evaluate(`fixture.finish({text:${JSON.stringify(text)}})`);
  await pause(250);
}
async function check(state, surface) {
  assert.equal(await evaluate('fixture.listening'), state);
  assert.equal(await evaluate('fixture.surface'), surface);
  assert.equal(await evaluate('document.querySelectorAll(\'[aria-label="Stop Friday"]\').length'), 1);
}
async function hover() {
  const p = await evaluate(
    "(()=>{const r=document.querySelector('.presence-bar').getBoundingClientRect();return {x:r.x+100,y:r.y+20}})()",
  );
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
  await pause();
}
async function leave() {
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 500 });
  await pause(600);
}
async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await pause(300);
}
async function shot(name) {
  const { data } = await call('Page.captureScreenshot', {});
  await writeFile(`${output}/${name}.png`, Buffer.from(data, 'base64'));
}
async function complete(speaking = false) {
  await evaluate(
    `fixture.runtime.presentation={text:'Here is the result.',expanded:true,speaking:${speaking}};fixture.task({...fixture.request,status:'completed'});fixture.emit()`,
  );
  await pause(250);
}
try {
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await open('startup');
  await check('armed', 'bar');
  assert.equal(await evaluate("document.querySelector('.friday-presence').getBoundingClientRect().top"), 8);
  assert.equal(await evaluate("document.querySelectorAll('.presence-bar button').length"), 2);
  assert.match(await evaluate("document.querySelector('[role=status]').textContent"), /Listening/);
  await shot('01-startup-listening');
  await hover();
  await check('armed', 'panel');
  await leave();
  await check('armed', 'bar');
  await evaluate('fixture.clock+=11000');
  await pause();
  await check('listening', 'quiet');
  assert.equal(await evaluate('fixture.capture.state'), 'recording');
  assert.match(
    await evaluate("document.querySelector('[role=status]').textContent"),
    /Say “hey friday” to wake her up/,
  );
  await shot('02-rest');
  await speech('The meeting is on Friday.');
  await check('listening', 'quiet');
  assert.equal(await evaluate("fixture.calls.filter(c=>c[0]==='submit').length"), 0);
  await speech('Hey Friday');
  await check('armed', 'bar');
  await shot('03-wake');
  await speech('Open my calendar');
  await check('paused', 'bar');
  assert.equal(await evaluate('fixture.capture.state'), 'recording');
  await speech('Hey Friday, this should not run during another request');
  assert.equal(await evaluate("fixture.calls.filter(c=>c[0]==='submit').length"), 1);
  await complete(true);
  await check('paused', 'bar');
  await shot('04-speaking');
  await speech('Friday stop');
  await check('listening', 'quiet');
  assert.equal(await evaluate("fixture.calls.filter(c=>c[0]==='stop').length"), 1);
  await shot('05-voice-stop');
  await speech('Hey Friday, draw a circle');
  await check('paused', 'bar');
  await evaluate('fixture.guiding=true;fixture.emit()');
  await pause();
  assert.match(await evaluate("document.querySelector('[role=status]').textContent"), /Guiding you/);
  await check('paused', 'bar');
  await shot('06-guiding-collapsed');
  await hover();
  await check('paused', 'panel');
  await shot('07-guiding-hover');
  await leave();
  await check('paused', 'bar');
  await click('[aria-label="Stop Friday"]');
  await check('listening', 'quiet');
  assert.equal(await evaluate('fixture.guiding'), false);
  await speech('Hey Friday');
  await check('armed', 'bar');
  await evaluate('fixture.clock+=11000');
  await pause();
  await check('listening', 'quiet');
  await speech('Hey Friday, what time is it?');
  await check('paused', 'bar');
  await complete();
  await check('armed', 'bar');
  await evaluate('fixture.clock+=11000');
  await pause();
  assert.equal(await evaluate('fixture.listening'), 'listening');
  await speech('Hey Friday');
  assert.equal(await evaluate('fixture.listening'), 'armed');
  // Hover departure collapses even after a footer button was clicked.
  await hover();
  await click('[aria-label="Turn microphone off"]');
  await leave();
  assert.equal(await evaluate('fixture.listening'), 'idle');
  assert.equal(await evaluate("Boolean(document.querySelector('.presence-body'))"), false);
  await evaluate('fixture.clock+=11000;fixture.emit()');
  await pause();
  assert.equal(await evaluate('fixture.listening'), 'idle');
  await hover();
  await click('[aria-label="Turn microphone on"]');
  await leave();
  assert.equal(await evaluate('fixture.listening'), 'listening');
  await speech('Hey Friday');
  assert.equal(await evaluate('fixture.listening'), 'armed');
  // Enabling audio during text entry must create capture for addressed Stop too.
  await open('off');
  await hover();
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Type instead')).click()");
  await pause();
  await click('[aria-label="Turn microphone on"]');
  assert.equal(await evaluate('fixture.capture.state'), 'recording');
  assert.equal(await evaluate('fixture.listening'), 'paused');
  await speech('Hey Friday, ignore this while I type');
  assert.equal(await evaluate("fixture.calls.filter(c=>c[0]==='submit').length"), 0);
  await speech('Friday stop');
  assert.equal(await evaluate("fixture.calls.filter(c=>c[0]==='stop').length"), 1);
  assert.equal(await evaluate('fixture.listening'), 'listening');
  // Approval/error content stays discoverable without automatic expansion.
  for (const state of ['approval', 'error', 'guidance']) {
    await open(state);
    assert.equal(await evaluate('fixture.surface'), 'bar');
    assert.equal(await evaluate("Boolean(document.querySelector('.presence-body'))"), false);
    await hover();
    assert.equal(await evaluate('fixture.surface'), 'panel');
    if (state === 'approval')
      assert.equal(await evaluate("document.querySelectorAll('.presence-approval button').length"), 2);
    if (state === 'error')
      assert.match(await evaluate("document.querySelector('[role=alert]').textContent"), /couldn’t open/);
    await leave();
    assert.equal(await evaluate('fixture.surface'), 'bar');
  }
  await open('multiple');
  assert.equal(await evaluate('fixture.surface'), 'orb');
  const orb = await evaluate(
    "(()=>{const r=document.querySelector('.friday-orb').getBoundingClientRect();return {x:r.x+32,y:r.y+32}})()",
  );
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...orb });
  await pause();
  assert.equal(await evaluate('fixture.surface'), 'tasks');
  await shot('08-background-tasks');
  await leave();
  await speech('Hey Friday');
  await check('armed', 'bar');
  await call('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: false });
  await open('startup');
  await shot('09-narrow');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  assert.equal(
    await evaluate('document.querySelector(\'[aria-label="Stop Friday"]\').getBoundingClientRect().right<=innerWidth'),
    true,
  );
  console.log(
    `PASS: startup, hover/leave, rest, wake-only, wake+command, ambient filtering, speech/work stop, drawing, repeat wake, mic off/on, approval/error, orb, narrow layout. Screenshots: ${output}`,
  );
} finally {
  close();
}
