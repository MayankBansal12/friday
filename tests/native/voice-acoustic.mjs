// Full App acoustic checks in the controlled browser fixture: real mixed PCM goes through App
// capture, mocked recognition answers after 0/400/1500 ms, and every request reaching
// `transcribePcm` is kept so delivered audio can be compared byte for byte with the source.
// Run with: node --experimental-transform-types tests/native/voice-acoustic.mjs
// Speech is the repository's synthetic generator; set FRIDAY_SPEECH_DIR to a directory with
// english.pcm/hindi.pcm (mono PCM16, 16 kHz) to also run recorded samples. No hosted APIs.
// Frame injection and the acting-task check follow Astra's independent App acoustic review.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectRenderer } from './cdp.mjs';
import { mix, noise, speech } from '../voice-signals.ts';

const base = process.env.VITE_TEST_URL || process.env.FRIDAY_PREVIEW_URL || 'http://127.0.0.1:5174';
const { call, close } = await connectRenderer(process.env.CDP_PORT || 9337);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
const rms = (pcm, at) => Math.sqrt(pcm.subarray(at, at + 320).reduce((sum, v) => sum + v * v, 0) / 320);
const peak = (pcm) => {
  let max = 0;
  for (let at = 0; at + 320 <= pcm.length; at += 320) max = Math.max(max, rms(pcm, at));
  return max;
};

/** Opens App, replaces recognition with a delayed mock and marks every submitted task acting. */
async function open(query, delay) {
  await call('Page.navigate', { url: `${base}/tests/presence-preview.html?state=quiet&${query}` });
  await call('Page.bringToFront', {});
  for (let i = 0; i < 100; i++) {
    if (await evaluate("Boolean(window.fixture?.surface && document.querySelector('#root')?.textContent)")) break;
    await pause(100);
  }
  await pause(900);
  await evaluate("document.querySelector('.presence-heading').click()");
  await pause(100);
  await evaluate(`{
    clearInterval(fixture.capture.timer);
    fixture.sampleClock = 0; fixture.jobs = []; fixture.decodes = []; fixture.ends = []; fixture.submittedAt = [];
    fixture.gates = 0;
    const trace = window.buddy.voiceTrace;
    window.buddy.voiceTrace = (t) => { trace(t); if (t.event === 'final-delivered') fixture.ends.push({ ...t }); };
    window.buddy.transcribePcm = (request) => {
      fixture.decodes.push(request);
      // fixture.rejecting: recognition fails at once; fixture.delay overrides the latency.
      if (fixture.rejecting) return Promise.reject(new Error('busy'));
      return new Promise((resolve) =>
        fixture.jobs.push({ request, resolve, at: fixture.sampleClock + (fixture.delay ?? ${delay}) }),
      );
    };
    const submit = window.buddy.submit;
    window.buddy.submit = async (text, context) => {
      fixture.submittedAt.push(fixture.sampleClock);
      const task = await submit(text, context);
      fixture.task({ ...task, status: 'acting' });
      return task;
    };
    window.buddy.turnGate = async () => { fixture.gates++; return { interrupt: true }; };
  }`);
}
/** Feeds PCM frames in time order, answering recognition when its latency has passed. */
async function feed(pcm) {
  for (let offset = 0; offset < pcm.length; offset += 16000) {
    const chunk = Buffer.from(pcm.slice(offset, offset + 16000).buffer).toString('base64');
    await evaluate(`(async () => {
      const audio = new Int16Array(Uint8Array.from(atob('${chunk}'), (c) => c.charCodeAt(0)).buffer);
      for (let i = 0; i + 320 <= audio.length; i += 320) {
        fixture.sampleClock += 20; fixture.clock += 20;
        fixture.capture.port.onmessage({ data: { type: 'frame', token: fixture.capture.token, audio: audio.slice(i, i + 320).buffer } });
        for (let j = fixture.jobs.length - 1; j >= 0; j--)
          if (fixture.jobs[j].at <= fixture.sampleClock) {
            const job = fixture.jobs.splice(j, 1)[0];
            job.resolve({ ...job.request, text: 'PCM fragment ' + (fixture.submittedAt.length + 1) + '.', inferenceMs: 1 });
          }
        await Promise.resolve();
      }
    })()`);
  }
  await pause(60);
}
/** Delivered request audio (base64) for each final. */
async function deliveredAudio() {
  const encoded = await evaluate(`fixture.ends.map((e) => {
    const r = fixture.decodes.find((d) => d.segment === e.segment && d.revision === e.revision);
    return r ? btoa(Array.from(new Uint8Array(r.audio), (v) => String.fromCharCode(v)).join('')) : '';
  })`);
  return encoded.map((b) => Buffer.from(b, 'base64'));
}

const samples = [['synthetic', speech(12_000, { level: 900, seed: 8, pauses: 0.15 })]];
const dir = process.env.FRIDAY_SPEECH_DIR;
for (const language of ['english', 'hindi'])
  if (dir && existsSync(join(dir, `${language}.pcm`))) {
    const bytes = readFileSync(join(dir, `${language}.pcm`));
    samples.push([language, new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))]);
  }

const results = [];
try {
  // Constant and louder-start speech, local and hosted recognition, fast to slow results.
  for (const [name, source] of samples)
    for (const dynamic of [false, true])
      for (const delay of [0, 400, 1500])
        for (const partials of [false, true]) {
          const gain = 600 / peak(source);
          const speechPcm = Int16Array.from(source, (v, n) => Math.round(v * gain * (dynamic && n < 16000 ? 3 : 1)));
          const lead = 48_000;
          const total = lead + Math.ceil(speechPcm.length / 320) * 320 + 48_000;
          const room = noise('hiss', total / 16, { level: 120, seed: 77 });
          const input = mix(
            room,
            Int16Array.from({ length: total }, (_, n) => (n >= lead ? (speechPcm[n - lead] ?? 0) : 0)),
          );
          await open(`localWake=1&partials=${partials ? 1 : 0}&trace=1`, delay);
          await feed(input);
          const audio = await deliveredAudio();
          const submittedAt = await evaluate('fixture.submittedAt');
          const missing = [];
          for (let at = 0; at + 320 <= speechPcm.length; at += 320)
            if (rms(speechPcm, at) > 50) {
              const frame = Buffer.from(input.slice(lead + at, lead + at + 320).buffer);
              if (!audio.some((b) => b.indexOf(frame) >= 0)) missing.push(at / 16);
            }
          const speechEndMs = (lead + speechPcm.length) / 16;
          results.push({ name, dynamic, delay, partials, submissions: submittedAt.length, missing: missing.length });
          assert.equal(submittedAt.length, 1, `${name} dynamic=${dynamic} delay=${delay}: one submission`);
          assert(submittedAt[0] > speechEndMs, `${name}: not submitted before the speech ended`);
          assert.deepEqual(missing, [], `${name} dynamic=${dynamic} delay=${delay}: every speech frame delivered`);
          assert.equal(await evaluate('fixture.gates'), 0);
        }

  // A soft continuation after a capture rebuild is not a request, with or without local wake.
  for (const localWake of [true, false]) {
    await open(`localWake=${localWake ? 1 : 0}&partials=0&trace=1`, 0);
    const calm = noise('hiss', 3000, { level: 120, seed: 5 });
    await feed(calm);
    await feed(mix(speech(1000, { level: 3000, seed: 3 }), noise('hiss', 1000, { level: 120, seed: 6 })));
    await evaluate('fixture.capture.onprocessorerror()');
    await pause(200);
    await evaluate('clearInterval(fixture.capture.timer)');
    const murmur = Int16Array.from({ length: 48_000 }, (_, n) =>
      Math.round(
        120 * (1.45 + 0.45 * Math.abs(Math.sin((2 * Math.PI * 2.25 * n) / 16000))) * (Math.random() * 2 - 1) * 1.73,
      ),
    );
    await feed(murmur);
    await feed(mix(speech(1500, { level: 3000, seed: 9 }), noise('hiss', 1500, { level: 120, seed: 7 })));
    await feed(noise('hiss', 1500, { level: 120, seed: 8 }));
    assert.deepEqual(await evaluate("fixture.calls.filter(c=>c[0]==='submit')"), [], `localWake=${localWake}`);
    results.push({ softContinuationAfterRebuild: true, localWake, submissions: 0 });
  }
  // Narrow-band continuation (60 ms levels 1.45-1.49x the room, just over the voicing bar) after
  // each way a sentence can be cut off, in both wake modes: never a request; real room quiet then
  // lets a fresh request through.
  const room = (ms, seed) => noise('hiss', ms, { level: 120, seed });
  const words = (ms, seed) => mix(speech(ms, { level: 3000, seed }), room(ms, seed + 1));
  const narrow = (ms) => {
    const out = new Int16Array(ms * 16);
    let state = 12345;
    const next = () => ((state = (1664525 * state + 1013904223) >>> 0) + 1) / 4294967297;
    for (let n = 0; n < out.length; n++) {
      const level = 120 * (1.47 + 0.02 * Math.sin((2 * Math.PI * Math.floor(n / 320)) / 11));
      out[n] = Math.round(level * Math.sqrt(-2 * Math.log(next())) * Math.cos(2 * Math.PI * next()));
    }
    return out;
  };
  const submitted = () => evaluate("fixture.calls.filter(c=>c[0]==='submit').length");
  for (const origin of ['cap', 'reject', 'timeout', 'rebuild'])
    for (const localWake of [true, false]) {
      await open(`localWake=${localWake ? 1 : 0}&partials=0&trace=1&recognitionMs=1500`, 0);
      await feed(room(3000, 11));
      if (origin === 'cap') {
        // 26 s of talking; the 8 s probe hears words, so the turn runs into the recording limit.
        for (let i = 0; i < 26; i++) await feed(words(1000, 20 + i));
        assert(await evaluate("fixture.traces.some((t) => t.event === 'overrun')"), 'overrun');
      } else {
        if (origin === 'reject') await evaluate('fixture.rejecting = true');
        if (origin === 'timeout') await evaluate('fixture.delay = 1e9');
        await feed(words(1200, 3));
        await feed(room(300, 4)); // a pause decode starts
        await feed(words(600, 5));
        if (origin === 'timeout') await pause(1900); // the 1.5 s recognition limit passes mid-sentence
        if (origin === 'rebuild') {
          await evaluate('fixture.capture.onprocessorerror()');
          await pause(200);
          await evaluate('clearInterval(fixture.capture.timer)');
        }
        await evaluate('fixture.rejecting = false; fixture.delay = undefined');
      }
      await feed(narrow(3200));
      await feed(words(1500, 9));
      await feed(room(1500, 12));
      assert.equal(await submitted(), 0, `${origin} localWake=${localWake}: continuation submitted`);
      // Real room quiet, then a fresh request.
      await feed(room(1000, 13));
      await feed(words(1500, 14));
      await feed(room(1500, 15));
      assert.equal(await submitted(), 1, `${origin} localWake=${localWake}: fresh request after quiet`);
      results.push({ narrowContinuation: origin, localWake, guardedSubmissions: 0, freshAfterQuiet: 1 });
    }
  console.log(JSON.stringify(results));
  console.log(
    'PASS: one complete, on-time submission for constant and louder-start speech at 0/400/1500 ms, local and hosted; soft and narrow-band continuations after a cap, rejection, timeout or capture rebuild are never submitted (both wake modes), and real quiet reopens listening.',
  );
} finally {
  close();
}
