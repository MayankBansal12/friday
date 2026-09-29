// Use the real browser clock: native Motion animations and requestAnimationFrame
// must share a timeline. Lifecycle tests accelerate idle time with motion reduced.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { connectRenderer } from './cdp.mjs';

const { call, close } = await connectRenderer(process.env.CDP_PORT || 9333);
const output = process.env.FRIDAY_SCREENSHOTS || '/tmp/friday-notch-motion';
await mkdir(output, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function open() {
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 500 });
  await call('Page.navigate', { url: 'http://127.0.0.1:5174/tests/presence-preview.html?state=off&motion=1' });
  await wait(1200);
}
async function record() {
  await evaluate(`fixture.frames=[];fixture.surfaceChanges=[];fixture.recording=true;
    requestAnimationFrame(function frame(time){
      if(!fixture.recording)return;
      const r=document.querySelector('.friday-presence').getBoundingClientRect();
      fixture.frames.push({time,x:r.x,top:r.top,width:r.width,height:r.height,canvas:fixture.height});
      requestAnimationFrame(frame);
    });`);
}
async function frames() {
  return evaluate('fixture.recording=false;fixture.frames');
}
function continuous(samples, from, to) {
  assert(samples.length > 5, 'Animation frames were not sampled');
  assert(
    samples.every((f) => Math.abs(f.top - 5) < 1),
    'Top edge moved during transition',
  );
  assert(
    samples.every((f) => Math.abs(f.x + f.width / 2 - 640) < 1),
    'Pill drifted off center',
  );
  assert(
    samples.every((f) => f.height >= 43 && f.width >= 359 && f.width <= 501),
    'Pill collapsed or overshot',
  );
  assert(
    samples.every((f) => f.height <= f.canvas),
    'Canvas clips the opening animation',
  );
  assert(new Set(samples.map((f) => Math.round(f.width))).size > 5, 'Width snapped instead of animating');
  assert(Math.abs(samples[0].width - from) < 3, `Unexpected starting width ${samples[0].width}`);
  assert(Math.abs(samples.at(-1).width - to) < 1, `Unexpected ending width ${samples.at(-1).width}`);
}
async function hover() {
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 25 });
}
async function leave() {
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 500 });
}
async function shot(name) {
  const { data } = await call('Page.captureScreenshot', {});
  await writeFile(`${output}/${name}.png`, Buffer.from(data, 'base64'));
}
try {
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await open();
  assert.equal(await evaluate('fixture.surface'), 'quiet');
  await shot('01-rest');
  await record();
  await hover();
  await wait(800);
  const expanding = await frames();
  continuous(expanding, 360, 500);
  assert(await evaluate('fixture.surfaceChanges.length < 8'), 'Native window still resizes on every frame');
  assert(new Set(expanding.map((f) => Math.round(f.height))).size > 5, 'Hover height snapped');
  await shot('02-hover');
  await record();
  await leave();
  await wait(510);
  assert.equal(
    await evaluate("document.querySelector('.presence-reveal')?.inert"),
    true,
    'Exiting controls remain interactive',
  );
  await wait(750);
  continuous(await frames(), 500, 360);
  assert.equal(await evaluate("Boolean(document.querySelector('.presence-body'))"), false);

  // Shortcut activation exercises the same rest -> listening geometry as voice wake.
  await record();
  await evaluate('fixture.listen()');
  await wait(800);
  continuous(await frames(), 360, 500);
  assert.equal(await evaluate('fixture.listening'), 'armed');
  await shot('03-listening');
  await record();
  await wait(11000);
  continuous(await frames(), 500, 360);
  assert.equal(await evaluate('fixture.listening'), 'listening');
  assert.equal(await evaluate('fixture.capture.state'), 'recording');
  const hint = await evaluate(
    `(()=>{const e=document.querySelector('[role=status]');return {text:e.textContent,fits:e.scrollWidth<=e.clientWidth}})()`,
  );
  assert.match(hint.text, /Say “hey friday” to wake her up/);
  assert(hint.fits, 'Compact pill truncates the wake hint');
  await shot('04-rest-with-wake-hint');

  // Reverse an in-flight close, then close again; no blank frames or remounted bar.
  await hover();
  await wait(800);
  await record();
  await leave();
  await wait(520);
  await hover();
  await wait(120);
  await leave();
  await wait(1250);
  const interrupted = await frames();
  continuous(interrupted, 500, 360);
  assert(
    interrupted.slice(1).every((f, i) => Math.abs(f.width - interrupted[i].width) < 65),
    'Interrupted spring jumped',
  );
  assert.equal(await evaluate('document.querySelectorAll(\'[aria-label="Stop Friday"]\').length'), 1);

  // Dismissing the last background update mounts a fresh, already-expanded notch.
  // initial={false} means there is no completion callback to release a reservation.
  await open();
  await evaluate(
    `fixture.runtime.sessions=[{id:'motion-child',role:'child',status:'completed',title:'Done',updatedAt:Date.now(),createdAt:1}];fixture.emit()`,
  );
  await wait(200);
  await evaluate("document.querySelector('.friday-orb').focus()");
  await wait(200);
  await evaluate('document.querySelector(\'[aria-label="Dismiss update for Done"]\').click()');
  await wait(100);
  await evaluate("document.querySelector('.presence-heading').focus()");
  await wait(700);
  assert.equal(await evaluate('fixture.surface'), 'panel');
  assert(await evaluate('fixture.height < 410'), 'Remounted notch kept the animation canvas indefinitely');

  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await open();
  await record();
  await hover();
  await wait(100);
  const reduced = await frames();
  assert(
    reduced.every((f) => Math.abs(f.width - 360) < 1 || Math.abs(f.width - 500) < 1),
    'Reduced motion still animates width',
  );
  assert.equal(reduced.at(-1).width, 500);
  console.log(
    `PASS: compact rest, animated hover/leave, active/idle, interrupted springs, stable top/center, wake hint, reduced motion. Screenshots: ${output}`,
  );
} finally {
  close();
}
