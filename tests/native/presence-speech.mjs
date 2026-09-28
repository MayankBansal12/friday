// Full React app with controlled media/IPC. Start Vite and headless Chrome on :9333 first.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { connectRenderer } from './cdp.mjs';
const { call, close } = await connectRenderer(process.env.CDP_PORT || 9333);
const output = process.env.FRIDAY_SCREENSHOTS || '/tmp/friday-speech';
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
try {
  await open('multiple');
  await evaluate("document.querySelector('.friday-orb').focus()");
  await pause();
  await click('.background-task-copy');
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  await speech({ text: 'What did you find?', wakeDetected: false });
  assert.equal(await evaluate('fixture.listening'), 'paused');
  await evaluate(
    "fixture.runtime.presentation={taskId:'request',text:'I found three options.',expanded:true,speaking:true};fixture.emit()",
  );
  await evaluate(
    "fixture.task({id:'request',role:'parent',status:'completed',response:'I found three options.',speechText:'I found three options.',prompt:'What did you find?',steps:[],createdAt:1,updatedAt:2});fixture.emit()",
  );
  await pause();
  assert.equal(await evaluate('fixture.listening'), 'paused', 'terminal task must wait for audio drain');
  await evaluate(
    "fixture.runtime.sessions[1].status='completed';fixture.task({id:'child-result',role:'child',status:'completed',prompt:'child',steps:[],createdAt:1,updatedAt:2});fixture.emit()",
  );
  await pause();
  assert.equal(await evaluate('fixture.listening'), 'paused', 'quiet child completion must not reopen capture');
  await screenshot('waiting-for-audio');
  await evaluate('fixture.runtime.presentation.speaking=false;fixture.emit()');
  await pause();
  assert.equal(await evaluate('fixture.listening'), 'armed');
  assert.match(await evaluate("document.querySelector('.task-context').textContent"), /train options/);
  await speech({ text: 'Which is cheapest?', wakeDetected: false });
  assert.deepEqual(await evaluate("fixture.calls.filter(c=>c[0]==='submit').at(-1).slice(1)"), [
    'Which is cheapest?',
    { selectedChildId: 'a' },
  ]);
  await evaluate(
    "fixture.runtime.presentation.speaking=true;fixture.emit();fixture.task({id:'request',role:'parent',status:'completed',prompt:'Which is cheapest?',steps:[],createdAt:1,updatedAt:3});fixture.emit()",
  );
  await pause();
  await click('[aria-label="Turn microphone off"]');
  await evaluate('fixture.runtime.presentation.speaking=false;fixture.emit()');
  await pause();
  assert.equal(await evaluate('fixture.listening'), 'idle', 'audio completion must preserve microphone off');
  await screenshot('mic-off-after-audio');
  // Details replay is an ID-based short-utterance action, with host-owned playback state.
  await evaluate(
    "fixture.task({id:'request',role:'parent',conversationId:'parent',status:'completed',response:'Long visible detail.',prompt:'Details',steps:[],createdAt:1,updatedAt:4});fixture.runtime.presentation.text='Long visible detail.';fixture.emit();window.buddy.setExpanded(true)",
  );
  await pause();
  assert.equal(await evaluate('document.querySelector(\'[aria-label="Read short reply"]\').disabled'), true);
  await evaluate(
    "fixture.task({id:'request',role:'parent',conversationId:'parent',status:'completed',response:'Long visible detail.',speechText:'A concise summary.',prompt:'Details',steps:[],createdAt:1,updatedAt:5});window.buddy.speak=(id)=>{fixture.calls.push(['replay',id]);fixture.runtime.presentation.speaking=true;fixture.emit();return new Promise(r=>fixture.replayDone=r)}",
  );
  await pause();
  await click('[aria-label="Read short reply"]');
  assert.deepEqual(await evaluate("fixture.calls.find(c=>c[0]==='replay')"), ['replay', 'request']);
  assert.equal(await evaluate('Boolean(document.querySelector(\'[aria-label="Stop speaking"]\'))'), true);
  await evaluate(
    "fixture.runtime.presentation.taskId='new-reply';fixture.runtime.presentation.speaking=true;fixture.emit();fixture.replayDone()",
  );
  await pause();
  assert.equal(
    await evaluate('Boolean(document.querySelector(\'[aria-label="Stop speaking"]\'))'),
    true,
    'stale replay promise must not clear current host playback state',
  );
  await screenshot('short-reply-details');
  // Rejected replay must never act like Stop or change microphone intent.
  await open('multiple');
  await evaluate("document.querySelector('.friday-orb').focus()");
  await pause();
  await click('.background-task-copy');
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  await evaluate(
    "window.buddy.silence=async()=>fixture.calls.push(['silence']);window.buddy.speak=async(id)=>fixture.calls.push(['replay',id]);fixture.task({id:'active',role:'parent',conversationId:'parent',status:'acting',response:'Checking now.',speechText:'I am checking.',prompt:'Compare',steps:[],createdAt:1,updatedAt:9});fixture.emit();window.buddy.setExpanded(true)",
  );
  await pause();
  assert.equal(await evaluate('document.querySelector(\'[aria-label="Read short reply"]\').disabled'), true);
  await evaluate('fixture.calls.length=0');
  await click('[aria-label="Read short reply"]');
  assert.deepEqual(await evaluate('fixture.calls'), []);
  assert.equal(await evaluate('fixture.listening'), 'paused');
  await screenshot('replay-disabled-during-turn');
  await evaluate(
    "fixture.task({id:'active',role:'parent',conversationId:'parent',status:'completed',response:'Done.',speechText:'Done.',prompt:'Compare',steps:[],createdAt:1,updatedAt:10});window.buddy.updateSettings=async(next)=>({wakeWord:'Friday',defaultCwd:'/tmp',model:'test',launchAtLogin:false,...next})",
  );
  await click('[aria-label="Open settings"]');
  await click('.setting-toggle input[type="checkbox"]');
  await click('.setting-toggle input[type="checkbox"]');
  await click('[aria-label="Close settings"]');
  assert.equal(await evaluate('document.querySelector(\'[aria-label="Read short reply"]\').disabled'), true);
  assert.equal(
    await evaluate('document.querySelector(\'[aria-label="Read short reply"]\').title'),
    'Spoken replies are off',
  );
  await evaluate('fixture.calls.length=0');
  await click('[aria-label="Read short reply"]');
  assert.deepEqual(await evaluate('fixture.calls'), []);
  assert.equal(await evaluate('fixture.listening'), 'armed');
  await screenshot('replay-disabled-when-muted');
  // Replay pending on the host must not be interrupted by the listener-resume effect.
  await open('quiet');
  await evaluate(
    "fixture.task({id:'replay-ready',role:'parent',conversationId:'parent',status:'completed',response:'Ready.',speechText:'A concise answer.',prompt:'Replay',steps:[],createdAt:1,updatedAt:20});window.buddy.setExpanded(true)",
  );
  await pause();
  await evaluate(`window.buddy.silence=async()=>fixture.calls.push(['silence']);
    window.buddy.speak=(id)=>{fixture.calls.push(['replay',id]);return new Promise(r=>{
      fixture.replayDone=r;setTimeout(()=>{fixture.runtime.presentation.speaking=true;fixture.emit()},350)
    })};fixture.calls.length=0`);
  await click('[aria-label="Read short reply"]');
  assert.equal(await evaluate('fixture.listening'), 'paused');
  assert.equal(await evaluate('fixture.capture.state'), 'recording');
  assert.equal(
    await evaluate("fixture.calls.some(c=>c[0]==='silence')"),
    false,
    'pending replay must not resume/silence',
  );
  await pause(450);
  assert.equal(
    await evaluate("fixture.calls.some(c=>c[0]==='silence')"),
    false,
    'host playback must not resume/silence',
  );
  await speech({ text: 'Friday stop' });
  assert.equal(await evaluate("fixture.calls.some(c=>c[0]==='stop')"), true);
  assert.equal(await evaluate('fixture.listening'), 'listening');
  await evaluate('fixture.replayDone()');
  await pause();
  assert.equal(await evaluate('fixture.listening'), 'listening', 'stale replay completion cannot reopen engagement');
  console.log(
    'PASS: audio drain, selected follow-up, quiet children, mic-off, task-ID/stale replay; active/muted replay has no side effects',
  );
} finally {
  close();
}
