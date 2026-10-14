// Full App voice recovery in the controlled browser fixture: hosted recognition (no interim
// decodes), the local wake detector, recognition budgets, segment traces, cut-off sentences,
// capture rebuilds and stuck graph opens. Synthetic audio and mocked recognition only.
import assert from 'node:assert/strict';
import { connectRenderer } from './cdp.mjs';

const base = process.env.VITE_TEST_URL || process.env.FRIDAY_PREVIEW_URL || 'http://127.0.0.1:5174';
const { call, close } = await connectRenderer(process.env.CDP_PORT || 9337);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function open(query = 'localWake=1&partials=0&trace=1', engaged = true) {
  await call('Page.navigate', { url: `${base}/tests/presence-preview.html?state=quiet&${query}` });
  await call('Page.bringToFront', {});
  for (let i = 0; i < 100; i++) {
    if (await evaluate("Boolean(window.fixture?.surface && document.querySelector('#root')?.textContent)")) break;
    await pause(100);
  }
  await pause(900);
  if (engaged) await evaluate("document.querySelector('.presence-heading').click()");
  await pause(100);
}
/** Frames of speech (or silence) with the renderer's monotonic clock advancing 20 ms each. */
async function talk(ms, loud = true) {
  await evaluate(`{ fixture.level = ${loud ? 1 : 0};
    for (let i = 0; i < ${ms / 20}; i++) { fixture.clock += 20; fixture.capture.frame(); }
    fixture.level = 0; }`);
  await pause(30);
}
const state = () => evaluate('fixture.listening');
const status = () => evaluate("document.querySelector('.presence-status-copy')?.textContent ?? ''");
const pending = () => evaluate('fixture.pending.length');
const submissions = () => evaluate("fixture.calls.filter(c=>c[0]==='submit').map(c=>c[1])");
async function resolveAll(text) {
  while (await pending()) {
    await evaluate(
      `{const j=fixture.pending.shift();j.resolve({...j.request,text:${JSON.stringify(text)},inferenceMs:300})}`,
    );
    await pause(40);
  }
}
/** Talks through the 25 s recording limit, until the next overrun. */
async function talkPastLimit() {
  const overruns = () => evaluate("fixture.traces.filter(t=>t.event==='overrun').length");
  const before = await overruns();
  for (let i = 0; i < 30; i++) {
    await talk(1000);
    // Hosted recognition probes a long turn once; it hears words, so the turn goes on.
    if (await pending()) await resolveAll('words still going');
    if ((await overruns()) > before) return;
  }
  assert.fail('no overrun');
}

try {
  // The first request after a local wake has not opened a conversation yet. If it overruns,
  // both capture and the status must return to wake waiting, with a visible retry instruction.
  // Cover hosted and local recognition, including the next successful wake on the same mic.
  for (const partials of [false, true]) {
    await open(`localWake=1&partials=${partials ? 1 : 0}&trace=1`, false);
    assert.equal(await state(), 'listening');
    const microphones = await evaluate("fixture.calls.filter(c=>c[0]==='microphone').length");
    await evaluate('fixture.wakeNext = true');
    await talk(1000);
    await pause(60);
    assert.equal(await state(), 'armed');
    await talkPastLimit();
    assert.equal(await state(), 'listening', `wake-started overrun, partials=${partials}`);
    assert.match(await status(), /Say “Hey Friday” to try again/);
    assert.equal(await evaluate('fixture.capture.state'), 'recording');
    assert.equal(await evaluate("fixture.traces.filter(t=>t.event==='overrun-fallback').length"), 1);
    assert.deepEqual(await submissions(), []);

    const decodes = await evaluate("fixture.traces.filter(t=>t.event==='inference-start').length");
    await talk(1000, false);
    await talk(1500);
    await talk(900, false);
    await resolveAll('Do not submit this old fragment.');
    assert.equal(await evaluate("fixture.traces.filter(t=>t.event==='inference-start').length"), decodes);
    assert.deepEqual(await submissions(), []);

    await evaluate('fixture.wakeNext = true');
    await talk(1000);
    await pause(60);
    await talk(500);
    await talk(900, false);
    await resolveAll('Hey Friday, what time is it?');
    assert.deepEqual(await submissions(), ['what time is it?']);
    assert.doesNotMatch(await status(), /Too noisy/);
    assert.equal(await evaluate("fixture.calls.filter(c=>c[0]==='microphone').length"), microphones);
  }

  // R5/R6: an engaged turn overruns with real elapsed time. The first cap keeps the conversation
  // engaged and says so in the compact status (no hover); the rest of the sentence that goes on
  // is never decoded or submitted; after a real pause a fresh request is heard.
  await open();
  assert.equal(await state(), 'armed');
  await talkPastLimit();
  assert.equal(await state(), 'armed');
  assert.match(await status(), /Too noisy to hear the end/);
  const decodes = await evaluate("fixture.traces.filter(t=>t.event==='inference-start').length");
  await talk(1500); // "...and then delete the old folder"
  await talk(900, false);
  assert.equal(await evaluate("fixture.traces.filter(t=>t.event==='tail-discarded').length"), 1);
  assert.equal(await evaluate("fixture.traces.filter(t=>t.event==='inference-start').length"), decodes);
  assert.equal(await pending(), 0);
  assert.deepEqual(await submissions(), []);
  await talk(2000, false); // still engaged after real idle time well under the 10 s timeout
  assert.equal(await state(), 'armed');
  await talk(1500);
  await talk(900, false);
  await resolveAll('Open my downloads.');
  assert.deepEqual(await submissions(), ['Open my downloads.']);
  assert.doesNotMatch(await status(), /noisy/);

  // A second consecutive cap falls back to the wake word; gated audio is not decoded until
  // "Hey Friday" is heard, and the wake vouches for the next turn.
  await open();
  await talkPastLimit();
  await talk(1000, false);
  await talkPastLimit();
  assert.equal(await state(), 'listening');
  assert.match(await status(), /Say “Hey Friday” to try again/);
  await talk(900, false);
  await resolveAll('');
  const gatedDecodes = await evaluate("fixture.traces.filter(t=>t.event==='inference-start').length");
  await talk(1500);
  await talk(900, false);
  assert.equal(await evaluate("fixture.traces.filter(t=>t.event==='inference-start').length"), gatedDecodes);
  await evaluate('fixture.wakeNext = true');
  await talk(1000);
  await pause(60);
  assert.equal(await state(), 'armed');
  await talk(500);
  await talk(900, false);
  await resolveAll('Hey Friday, what time is it?');
  assert.deepEqual(await submissions(), ['what time is it?']);

  // With the local detector, "Hey Friday" during a cut-off sentence starts a fresh turn at once.
  await open();
  await talkPastLimit();
  await talk(400); // the sentence goes on...
  await evaluate('fixture.wakeNext = true');
  await talk(1200); // ...and turns into "Hey Friday, open my downloads"
  await pause(60);
  await talk(900, false);
  await resolveAll('and the old one hey Friday open my downloads');
  assert.deepEqual(await submissions(), ['open my downloads']);

  // R1: the capture graph fails mid-sentence and is rebuilt; the rest of that sentence is not
  // a request. A real pause later, a fresh request is.
  await open();
  await talk(1000);
  await evaluate('window.failedGraph=fixture.capture; fixture.capture.onprocessorerror()');
  await pause(200);
  assert.equal(await evaluate('fixture.capture !== window.failedGraph'), true);
  assert.equal(await state(), 'armed');
  assert.match(await status(), /Mic dropped out/);
  await talk(1500); // "...the folder."
  await talk(900, false);
  await resolveAll('Delete the folder.');
  assert.deepEqual(await submissions(), []);
  await talk(1000, false);
  await talk(1500);
  await talk(900, false);
  await resolveAll('Rename the folder.');
  assert.deepEqual(await submissions(), ['Rename the folder.']);

  // R1: recognition fails while the user is still talking; the rest is not a request either.
  await open();
  await talk(1200);
  await talk(300, false); // a pause decode starts
  await talk(800);
  assert.equal(await pending(), 1);
  await evaluate("fixture.pending.shift().reject(new Error('busy'))");
  await pause(60);
  assert.match(await status(), /Didn’t catch that/);
  await talk(1000);
  await talk(900, false);
  await resolveAll('Delete the folder.');
  assert.deepEqual(await submissions(), []);

  // Local recognition shows live words; when the turn then fails, they give way to the notice.
  for (const fail of ['reject', 'timeout']) {
    await open(`partials=1&trace=1&recognitionMs=${fail === 'timeout' ? 1500 : 22000}`);
    await talk(1400);
    await resolveAll('Delete the');
    assert.match(await status(), /Delete the/);
    await talk(600);
    if (fail === 'reject') {
      while (!(await pending())) await talk(200);
      await evaluate("fixture.pending.shift().reject(new Error('busy'))");
    } else await pause(1800);
    await pause(60);
    assert.match(await status(), fail === 'reject' ? /Didn’t catch that/ : /Recognition timed out/);
    assert.doesNotMatch(await status(), /Delete the/);
    assert.equal(await state(), 'armed');
    await resolveAll('Delete the folder.');
    await talk(900, false);
    await resolveAll('Delete the folder.');
    assert.deepEqual(await submissions(), []);
  }

  // Recognition budget from the gate: an unanswered final fails recoverably and visibly; its
  // late answer is ignored and listening goes on.
  await open('localWake=1&partials=0&trace=1&recognitionMs=1500');
  await talk(1500);
  await talk(900, false);
  assert.equal(await state(), 'transcribing');
  await pause(1800);
  assert.equal(await state(), 'armed');
  assert.match(await status(), /Recognition timed out/);
  await resolveAll('Late command');
  assert.deepEqual(await submissions(), []);
  await talk(1000, false);
  await talk(1500);
  await talk(900, false);
  await resolveAll('Open my calendar.');
  assert.deepEqual(await submissions(), ['Open my calendar.']);

  // Segment traces reach main as metadata only.
  const traces = await evaluate('fixture.traces');
  for (const event of ['speech-start', 'endpoint', 'final-delivered', 'inference-timeout', 'recognition-error'])
    assert(
      traces.some((t) => t.event === event),
      `trace ${event}`,
    );
  for (const trace of traces) for (const key of ['text', 'audio', 'heard']) assert(!(key in trace), key);

  // R4: a replacement graph that never starts fails within its deadline and closes its context;
  // the mic does not claim to be listening.
  await open();
  await evaluate('fixture.hangOpen = true; fixture.capture.onprocessorerror()');
  await pause(500);
  const closedBefore = await evaluate('fixture.closedContexts');
  await pause(3200);
  assert.equal(await state(), 'error');
  assert(await evaluate(`fixture.closedContexts > ${closedBefore}`));
  // Mic-off while a graph hangs: it stays off, and the stuck context is still closed.
  await open();
  await evaluate('fixture.hangOpen = true; fixture.capture.onprocessorerror(); fixture.stopMic()');
  const closedAtOff = await evaluate('fixture.closedContexts');
  await pause(3500);
  assert.equal(await state(), 'idle');
  assert(await evaluate(`fixture.closedContexts > ${closedAtOff}`));

  console.log(
    'PASS: wake-started overrun returns to visible wake waiting and hears the next wake; engaged overrun keeps engagement with a visible notice, drops the cut-off tail, hears the next request; repeated cap falls back to the wake word; wake vouches mid-tail; capture rebuild and recognition failure never submit the rest of a sentence; recognition budget; metadata-only traces; stuck graph open is bounded and closed.',
  );
} finally {
  close();
}
