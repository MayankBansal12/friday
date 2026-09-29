// Regression probes for the independent UX review. Uses the same preview as presence.mjs.
import assert from 'node:assert/strict';
import { connectRenderer } from './cdp.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
const { call, close } = await connectRenderer(process.env.CDP_PORT || 9334);
const output = process.env.FRIDAY_SCREENSHOTS || '/tmp/friday-review-fixes';
await mkdir(output, { recursive: true });
const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function open(state) {
  await call('Page.navigate', {
    url: `${process.env.FRIDAY_PREVIEW_URL || 'http://127.0.0.1:5174'}/tests/presence-preview.html?state=${state}`,
  });
  await call('Page.bringToFront', {});
  for (let i = 0; i < 100; i++) {
    if (await evaluate("Boolean(window.fixture?.surface && document.querySelector('#root')?.textContent)")) break;
    await pause(100);
  }
  await pause(900);
}
async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await pause();
}
async function shot(name) {
  const r = await call('Page.captureScreenshot', {});
  await writeFile(`${output}/${name}.png`, Buffer.from(r.data, 'base64'));
}
async function select() {
  await open('multiple');
  await evaluate("document.querySelector('.friday-orb').focus()");
  await pause();
  await click('.background-task-copy');
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
}
async function type(text) {
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Type instead')).click()");
  await pause();
  await evaluate(
    `(()=>{const input=document.querySelector('input[aria-label="Ask Friday"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await pause();
}
async function done() {
  await evaluate(
    "fixture.task({id:'request',role:'parent',conversationId:'parent',status:'completed',prompt:'request',steps:[],createdAt:1,updatedAt:2});fixture.emit()",
  );
  await pause();
}
try {
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await select();
  await click('[aria-label="Talk to Friday"]');
  assert.match(await evaluate("document.querySelector('.task-context').textContent"), /train options/);
  await type('What did you find?');
  assert.equal(await evaluate('fixture.listening'), 'paused');
  assert.equal(await evaluate('fixture.capture.state'), 'recording');
  await evaluate('fixture.level=1');
  await pause(300);
  assert.equal(await evaluate("fixture.calls.some(c=>c[0]==='submit')"), false);
  assert.equal(
    await evaluate("document.querySelector('[aria-pressed=true]').textContent.includes('Close text input')"),
    true,
  );
  await evaluate('fixture.level=0');
  await evaluate('fixture.clock+=11000');
  await pause();
  assert.match(await evaluate("document.querySelector('.task-context').textContent"), /train options/);
  const bounds = await evaluate(
    "(()=>{const f=document.querySelector('.friday-presence').getBoundingClientRect();const c=document.querySelector('.presence-composer').getBoundingClientRect();const t=document.querySelector('.presence-footer').getBoundingClientRect();return {bottom:f.bottom,inputBottom:c.bottom,footerBottom:t.bottom,height:f.height}})()",
  );
  assert(bounds.inputBottom < bounds.bottom && bounds.footerBottom < bounds.bottom && bounds.height <= 400);
  await shot('typing-context');
  await click('[aria-label="Send request"]');
  assert.equal(await evaluate("fixture.calls.find(c=>c[0]==='submit')[2].selectedChildId"), 'a');
  await done();
  assert.equal(await evaluate('fixture.listening'), 'listening');
  assert.match(
    await evaluate("document.querySelector('.presence-heading [role=status]').textContent"),
    /Say “hey friday”/,
  );
  await shot('typed-task-follow-up');
  await click('[aria-label="Talk to Friday"]');
  assert.equal(await evaluate('fixture.listening'), 'armed');
  assert.match(await evaluate("document.querySelector('.task-context').textContent"), /train options/);
  // Mic off doesn't clear a text subject; clearing that subject never enables audio.
  await click('[aria-label="Turn microphone off"]');
  assert.equal(await evaluate('fixture.listening'), 'idle');
  const micCalls = await evaluate("fixture.calls.filter(c=>c[0]==='microphone').length");
  await click('[aria-label="Clear task context"]');
  assert.equal(await evaluate("fixture.calls.filter(c=>c[0]==='microphone').length"), micCalls);
  assert.equal(await evaluate('fixture.listening'), 'idle');
  // Text-only context expires after the reply, even with audio disabled.
  await select();
  await click('[aria-label="Turn microphone off"]');
  await type('Summarize it');
  await click('[aria-label="Send request"]');
  await done();
  await pause(10200);
  assert.equal(await evaluate("Boolean(document.querySelector('.task-context'))"), false);
  // Typed general requests preserve mic intent; Stop returns to quiet recognition.
  await open('quiet');
  await click('.presence-heading');
  assert.equal(
    await evaluate("fixture.calls.filter(c=>c[0]==='microphone').length"),
    1,
    'activation must reuse live device',
  );
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  await type('Hello');
  await click('[aria-label="Send request"]');
  await done();
  assert.equal(await evaluate('fixture.listening'), 'listening');
  await click('[aria-label="Talk to Friday"]');
  await click('[aria-label="Stop Friday"]');
  assert.equal(await evaluate('fixture.listening'), 'listening');
  // Background errors stay invisible, and incidental Friday speech is ignored.
  await open('quiet');
  await evaluate("window.buddy.transcribePcm=async()=>{throw new Error('technical decoder crash')};fixture.level=1");
  await pause(80);
  await evaluate('fixture.capture.endUtterance()');
  await pause();
  assert.equal(await evaluate('fixture.surface'), 'quiet');
  assert.equal(await evaluate("Boolean(document.querySelector('[role=alert]'))"), false);
  await open('quiet');
  await evaluate('fixture.level=1');
  await pause(80);
  await evaluate('fixture.capture.endUtterance()');
  await pause();
  await evaluate('fixture.finish({text:"Friday\'s meeting moved",wakeDetected:false})');
  await pause();
  assert.equal(await evaluate("fixture.calls.some(c=>c[0]==='submit')"), false);
  // First activation is honest about device readiness; no mic-off flash.
  await open('off');
  await evaluate(
    '{const get=navigator.mediaDevices.getUserMedia;navigator.mediaDevices.getUserMedia=async()=>{await new Promise(r=>setTimeout(r,400));return get()}}',
  );
  await click('.presence-heading');
  assert.equal(await evaluate('fixture.listening'), 'starting');
  await shot('opening-microphone');
  await pause(450);
  assert.equal(await evaluate('fixture.listening'), 'armed');
  // Clearing a subject affects future speech, never an already-spoken pending utterance.
  await select();
  await evaluate('fixture.level=1');
  await pause(80);
  await evaluate('fixture.capture.endUtterance()');
  await pause();
  await click('[aria-label="Clear task context"]');
  await evaluate("fixture.finish({text:'What did you find?',wakeDetected:false})");
  await pause();
  assert.equal(await evaluate("fixture.calls.find(c=>c[0]==='submit')[2].selectedChildId"), 'a');
  await select();
  await click('[aria-label="Clear task context"]');
  await evaluate('fixture.level=1');
  await pause(80);
  await evaluate('fixture.capture.endUtterance()');
  await pause();
  await evaluate("fixture.finish({text:'A general question',wakeDetected:false})");
  await pause();
  assert.deepEqual(await evaluate("fixture.calls.find(c=>c[0]==='submit')[2]"), { source: 'voice' });
  // A new explicit greeting clears task-specific follow-up context.
  await select();
  await evaluate('fixture.level=1');
  await pause(80);
  await evaluate('fixture.capture.endUtterance()');
  await pause();
  await evaluate("fixture.finish({text:'Hey Friday, what time is it?',wakeDetected:true,command:'what time is it?'})");
  await pause();
  assert.deepEqual(await evaluate("fixture.calls.find(c=>c[0]==='submit')"), [
    'submit',
    'what time is it?',
    { source: 'voice' },
  ]);
  await open('updates');
  await evaluate("document.querySelector('.friday-orb').focus()");
  await pause();
  await shot('attention');
  assert.match(
    await evaluate("document.querySelector('.friday-orb').getAttribute('aria-label')"),
    /2 need attention, microphone on/,
  );
  await evaluate(
    "[...document.querySelectorAll('.background-task-copy')].find(b=>b.textContent.includes('Which')).click()",
  );
  await pause();
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  assert.match(await evaluate("document.querySelector('.selected-question').textContent"), /Which/);
  assert.equal(await evaluate("Boolean(document.querySelector('.presence-content .background-list'))"), false);
  await shot('selected-question');
  await call('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: false });
  await select();
  await type('Keep the short details here');
  await shot('narrow-typing');
  console.log(`PASS: Opus H1-H3, M1-M8 regression probes; screenshots ${output}`);
} finally {
  close();
}
