// Full React app with controlled media/IPC. Start Vite and headless Chrome on :9333 first.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { connectRenderer } from './cdp.mjs';
const { call, close } = await connectRenderer(process.env.CDP_PORT || 9333);
const output = process.env.FRIDAY_SCREENSHOTS || '/tmp/friday-presence';
await mkdir(output, { recursive: true });
const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function open(state) {
  await call('Page.navigate', { url: `http://127.0.0.1:5174/tests/presence-preview.html?state=${state}` });
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
async function screenshot(name) {
  const s = await call('Page.captureScreenshot', {});
  await writeFile(`${output}/${name}.png`, Buffer.from(s.data, 'base64'));
}
async function speech(result) {
  await evaluate('fixture.level=1');
  await pause(80);
  await evaluate('fixture.capture.endUtterance()');
  await pause();
  await evaluate(`fixture.finish(${JSON.stringify(result)})`);
  await pause();
}
async function surface(expected) {
  assert.equal(await evaluate('fixture.surface'), expected);
}
try {
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  // A restored failure belongs in history, not a new startup alert or foreground surface.
  const oldError = 'The desktop connection timed out. Please try again.';
  for (const state of ['startup-error', 'startup-error-background']) {
    await open(state);
    await surface(state === 'startup-error' ? 'quiet' : 'orb');
    assert.equal(
      await evaluate(`document.querySelector('#root').textContent.includes(${JSON.stringify(oldError)})`),
      false,
    );
    assert.equal(await evaluate("fixture.calls.some(c=>c[0]==='submit')"), false);
    await evaluate('window.buddy.setExpanded(true)');
    await pause();
    await evaluate(
      "[...document.querySelectorAll('.view-switcher button')].find(b=>b.querySelector('span')?.textContent==='Archive').click()",
    );
    await pause();
    await click('.history-row');
    assert.match(await evaluate("document.querySelector('.error-card').textContent"), /desktop connection timed out/);
  }
  // New failures must still appear even before the model has produced presentation text.
  await open('startup-error');
  await evaluate("fixture.task({...fixture.tasks[0],id:'new-parent',status:'thinking',error:undefined})");
  await pause();
  await surface('bar');
  await evaluate("fixture.task({...fixture.tasks[0],id:'new-parent',status:'failed',error:'The new request failed.'})");
  await pause();
  await surface('bar');
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  await surface('panel');
  assert.match(await evaluate("document.querySelector('#root').textContent"), /The new request failed\./);
  await evaluate("fixture.runtime.parentId='another-conversation';fixture.emit()");
  await pause();
  await evaluate('document.activeElement.blur()');
  await pause(600);
  await surface('quiet');
  assert.equal(
    await evaluate("document.querySelector('#root').textContent.includes('The new request failed.')"),
    false,
  );
  for (const state of [
    'off',
    'quiet',
    'one',
    'multiple',
    'listening',
    'thinking',
    'speaking',
    'guidance',
    'approval',
    'updates',
    'error',
  ]) {
    await open(state);
    if (['one', 'multiple', 'updates'].includes(state)) {
      await evaluate("document.querySelector('.friday-orb').focus()");
      await pause();
    }
    await screenshot(state);
  }
  await open('multiple');
  // Real pointer transition from the fixed circle into its inward panel.
  const rect = await evaluate(
    "(()=>{const r=document.querySelector('.friday-orb').getBoundingClientRect();return {x:r.x+32,y:r.y+32}})()",
  );
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect });
  await pause();
  await surface('tasks');
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 140 });
  await pause(650);
  await surface('tasks');
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 400 });
  await pause(650);
  await surface('orb');
  await evaluate("document.querySelector('.friday-orb').focus()");
  await pause();
  await surface('tasks');
  await pause(550);
  await surface('tasks');
  await click('[aria-label="Stop Compare train options"]');
  assert.deepEqual(await evaluate("fixture.calls.filter(c=>c[0]!=='microphone')"), [['stopChild', 'a']]);
  await click('.background-task-copy');
  assert.equal(await evaluate("fixture.calls.filter(c=>c[0]==='submit').length"), 0);
  assert.equal(await evaluate('fixture.listening'), 'armed');
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  assert.match(await evaluate("document.querySelector('.task-context').textContent"), /release notes/);
  await screenshot('selected');
  await speech({ text: 'What did you find?', wakeDetected: false });
  assert.deepEqual(await evaluate("fixture.calls.find(c=>c[0]==='submit')"), [
    'submit',
    'What did you find?',
    { selectedChildId: 'b' },
  ]);
  await click('[aria-label="Stop Friday"]');
  assert.equal(await evaluate("fixture.calls.filter(c=>c[0]==='stopChild').length"), 1);
  // Voice follow-ups keep the selected subject; explicit mic-off cancels automatic reopening.
  await open('multiple');
  await evaluate("document.querySelector('.friday-orb').focus()");
  await pause();
  await click('.background-task-copy');
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  await speech({ text: 'How is it going?', wakeDetected: false });
  await evaluate(
    "fixture.task({id:'request',role:'parent',conversationId:'parent',status:'completed',prompt:'How is it going?',steps:[],createdAt:1,updatedAt:2}); fixture.emit()",
  );
  await pause();
  assert.equal(await evaluate('fixture.listening'), 'armed');
  assert.match(await evaluate("document.querySelector('.task-context').textContent"), /train options/);
  await speech({ text: 'What about tomorrow?', wakeDetected: false });
  assert.equal(await evaluate("fixture.calls.filter(c=>c[0]==='submit').at(-1)[2].selectedChildId"), 'a');
  await evaluate(
    "fixture.stopMic(); fixture.task({id:'request',role:'parent',conversationId:'parent',status:'completed',prompt:'What about tomorrow?',steps:[],createdAt:1,updatedAt:3}); fixture.emit()",
  );
  await pause();
  assert.equal(await evaluate('fixture.listening'), 'idle');
  // Timeout clears context, never stops children, never fires during speech.
  await open('multiple');
  await evaluate("document.querySelector('.friday-orb').focus()");
  await pause();
  await click('.background-task-copy');
  await evaluate('fixture.level=1');
  await pause(80);
  await evaluate('fixture.clock+=11000');
  await pause();
  assert.equal(await evaluate('fixture.listening'), 'armed');
  await evaluate('fixture.level=0');
  await pause(100);
  await evaluate('fixture.capture.endUtterance();fixture.clock+=1000');
  await pause();
  await evaluate("fixture.finish({text:'',wakeDetected:false})");
  await pause();
  await evaluate('fixture.clock+=11000');
  await pause();
  assert.equal(await evaluate('fixture.listening'), 'listening');
  assert.equal(await evaluate("Boolean(document.querySelector('.task-context'))"), false);
  assert.equal(await evaluate("fixture.calls.some(c=>c[0]==='stopChild')"), false);
  // A background transcription stays quiet; a click supersedes it and its context.
  await open('quiet');
  await surface('quiet');
  await evaluate('fixture.level=1');
  await pause(80);
  await evaluate('fixture.capture.endUtterance()');
  await pause();
  await surface('quiet');
  await click('.presence-heading');
  await evaluate("fixture.finish({text:'old background words',wakeDetected:false})");
  await pause();
  assert.equal(await evaluate("fixture.calls.some(c=>c[0]==='submit')"), false);
  assert.equal(await evaluate('fixture.listening'), 'armed');
  await open('quiet');
  await speech({ text: 'Hey Friday', wakeDetected: true });
  assert.equal(await evaluate('fixture.listening'), 'armed');
  await speech({ text: 'Tell me the time', wakeDetected: false });
  assert.deepEqual(await evaluate("fixture.calls.find(c=>c[0]==='submit')"), ['submit', 'Tell me the time', {}]);
  // Approval stays available on hover without automatically opening the panel.
  await open('approval');
  await evaluate('fixture.listen()');
  await pause();
  await evaluate('fixture.clock+=11000');
  await pause();
  await surface('bar');
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  await surface('panel');
  assert.equal(await evaluate("document.querySelectorAll('.presence-approval button').length"), 2);
  await call('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: false });
  await open('updates');
  await evaluate("document.querySelector('.friday-orb').focus()");
  await pause();
  await screenshot('narrow-updates');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  await click('.background-task-copy');
  await screenshot('narrow-selected');
  assert.equal(
    await evaluate('document.querySelector(\'[aria-label="Stop Friday"]\').getBoundingClientRect().right<=innerWidth'),
    true,
  );
  console.log(
    `PASS: selection, no auto-submit, context submission, stop isolation, timeout, speech protection, wake and transcription races, hover/focus, narrow states. Screenshots: ${output}`,
  );
} finally {
  close();
}
