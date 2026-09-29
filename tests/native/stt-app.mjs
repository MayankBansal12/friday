// Full App adversarial PCM timing, using the controlled browser fixture.
import assert from 'node:assert/strict';
import { connectRenderer } from './cdp.mjs';
const { call, close } = await connectRenderer(process.env.CDP_PORT || 9337);
await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function open(engaged = true) {
  await call('Page.navigate', { url: 'http://127.0.0.1:5174/tests/presence-preview.html?state=quiet' });
  await call('Page.bringToFront', {});
  for (let i = 0; i < 100; i++) {
    if (await evaluate("Boolean(window.fixture?.surface && document.querySelector('#root')?.textContent)")) break;
    await pause(100);
  }
  await pause(900);
  if (engaged) await evaluate("document.querySelector('.presence-heading').click()");
  await pause(100);
}
async function speak() {
  await evaluate('fixture.level=1');
  await pause(100);
}
async function end() {
  await evaluate('fixture.capture.endUtterance()');
  await pause(50);
}
async function resolve(text) {
  await evaluate(
    `{const j=fixture.pending.shift();j.resolve({...j.request,text:${JSON.stringify(text)},inferenceMs:100})}`,
  );
  await pause(60);
}
async function submissions() {
  return evaluate("fixture.calls.filter(c=>c[0]==='submit')");
}
try {
  await open();
  await speak();
  await end();
  assert.equal(await evaluate('fixture.listening'), 'transcribing');
  await speak();
  assert.equal(await evaluate('fixture.listening'), 'armed');
  await resolve('Delete it.');
  assert.deepEqual(await submissions(), []);
  await end();
  await resolve('Do not delete it.');
  assert.deepEqual(await submissions(), [['submit', 'Do not delete it.', {}]]);
  await open();
  await speak();
  await end();
  await evaluate('fixture.stopMic()');
  await resolve('Stale command');
  assert.deepEqual(await submissions(), []);
  assert.equal(await evaluate('fixture.listening'), 'idle');
  await open();
  await speak();
  await end();
  await evaluate('fixture.disconnect()');
  await resolve('Disconnected command');
  assert.deepEqual(await submissions(), []);
  assert.equal(await evaluate('fixture.listening'), 'error');
  await open();
  await speak();
  await evaluate('fixture.capture.onprocessorerror()');
  assert.equal(await evaluate('fixture.listening'), 'error');
  assert.deepEqual(await submissions(), []);
  await open();
  await speak();
  await end();
  await resolve('Hey Friday');
  await speak();
  await end();
  await resolve('What time is it?');
  assert.deepEqual(await submissions(), [['submit', 'What time is it?', {}]]);
  // PTT via the expanded App composer; no command until the explicit release.
  await open();
  await evaluate('window.buddy.setExpanded(true)');
  await pause(100);
  await evaluate(
    `document.querySelector('[aria-label="Hold to talk"]').dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}))`,
  );
  await pause(100);
  await speak();
  assert.deepEqual(await submissions(), []);
  await evaluate(
    `document.querySelector('[aria-label="Hold to talk"]').dispatchEvent(new KeyboardEvent('keyup',{key:' ',bubbles:true}))`,
  );
  await pause(60);
  await resolve('Tell me the time');
  assert.deepEqual(await submissions(), [['submit', 'Tell me the time', {}]]);
  // L2: revoked endpoint retains the context captured at original speech start.
  await call('Page.navigate', { url: 'http://127.0.0.1:5174/tests/presence-preview.html?state=multiple' });
  await call('Page.bringToFront', {});
  for (let i = 0; i < 100; i++) {
    if (await evaluate("Boolean(window.fixture?.surface && document.querySelector('#root')?.textContent)")) break;
    await pause(100);
  }
  await pause(900);
  await evaluate("document.querySelector('.friday-orb').focus()");
  await pause(250);
  await evaluate("document.querySelector('.background-task-copy').click()");
  await pause(180);
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause(180);
  await speak();
  await end();
  assert.equal(await evaluate('fixture.listening'), 'transcribing');
  await evaluate('document.querySelector(\'[aria-label="Clear task context"]\').click()');
  await speak();
  assert.equal(await evaluate('fixture.listening'), 'armed');
  await resolve('Delete the notes');
  assert.deepEqual(await submissions(), []);
  await end();
  await resolve('Do not delete the notes');
  assert.deepEqual(await submissions(), [['submit', 'Do not delete the notes', { selectedChildId: 'a' }]]);

  // M2: 26 s of ambient sound with 600 ms gaps never constitutes an endpoint.
  const noise = `(frames = 1300) => { for (let i=0;i<frames;i++) {
    fixture.level = i % 100 < 70 ? 1 : 0; fixture.capture.frame();
  } fixture.level=0; }`;
  await open(false);
  const token = await evaluate('fixture.capture.token');
  const micCalls = await evaluate("fixture.calls.filter(c => c[0] === 'microphone').length");
  await evaluate(`(${noise})()`);
  await pause(60);
  assert.equal(await evaluate('fixture.listening'), 'listening');
  assert.equal(await evaluate('fixture.capture.state'), 'recording');
  assert((await evaluate('fixture.capture.token')) > token);
  assert.equal(await evaluate("Boolean(document.querySelector('[role=alert]'))"), false);
  assert.deepEqual(await submissions(), []);
  await resolve('Hey Friday, execute the old truncated command');
  assert.deepEqual(await submissions(), []);
  await end();
  await evaluate("fixture.finish({text:'Hey Friday, what time is it?'})");
  await pause(180);
  assert.deepEqual(await submissions(), [['submit', 'what time is it?', {}]]);
  assert.equal(await evaluate("fixture.calls.filter(c => c[0] === 'microphone').length"), micCalls);

  // Restart never overrides explicit mic-off or Escape (Stop listening).
  for (const action of [
    'fixture.stopMic()',
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  ]) {
    await open(false);
    await evaluate(`(${noise})(1220)`);
    await evaluate(action);
    await pause(60);
    const stoppedToken = await evaluate('fixture.capture.token');
    // Deliver already-queued old-token frames even though the source is stopped.
    await evaluate(`{ const c=fixture.capture; for(let i=0;i<100;i++) c.port.onmessage({data:{
      type:'frame',token:c.token,audio:new Int16Array(320).fill(4300).buffer
    }}); }`);
    await resolve('Hey Friday, stale words');
    assert.equal(await evaluate('fixture.capture.token'), stoppedToken);
    assert.equal(await evaluate('fixture.listening'), 'idle');
    assert.deepEqual(await submissions(), []);
  }
  await open(false);
  await evaluate(`(${noise})()`);
  await evaluate('fixture.stopMic()');
  await resolve('Hey Friday, stale after restart');
  assert.equal(await evaluate('fixture.listening'), 'idle');
  assert.equal(await evaluate('fixture.capture.state'), 'inactive');
  assert.deepEqual(await submissions(), []);

  // Engaged and PTT caps remain fail-closed; neither submits any pending partial.
  for (const direct of [false, true]) {
    await open();
    if (direct) {
      await evaluate('window.buddy.setExpanded(true)');
      await pause(100);
      await evaluate(
        `document.querySelector('[aria-label="Hold to talk"]').dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}))`,
      );
      await pause(100);
    }
    await evaluate(`(${noise})()`);
    await resolve('Do something truncated');
    assert.equal(await evaluate('fixture.listening'), 'error');
    assert.equal(await evaluate('fixture.capture.state'), 'inactive');
    assert.deepEqual(await submissions(), []);
  }
  // L1: overflow is terminal for incomplete capture; a late decode cannot submit.
  await open();
  await speak();
  await end();
  await evaluate("fixture.capture.port.onmessage({data:{type:'overflow',token:fixture.capture.token}})");
  await resolve('Do something incomplete');
  assert.equal(await evaluate('fixture.listening'), 'error');
  assert.deepEqual(await submissions(), []);
  console.log(
    'PASS: M2 ambient cap restart/wake/stale/mic-off/Stop, engaged/PTT fail-closed; L1 overflow rejects incomplete input; L2 UI/context/correction; existing voice lifecycle probes.',
  );
} finally {
  close();
}
