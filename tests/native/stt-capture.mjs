// Real browser AudioWorklet + MediaStream source from generated oscillator, no microphone.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { connectRenderer } from './cdp.mjs';
const { call, close } = await connectRenderer(process.env.CDP_PORT || 9337);
try {
  await call('Page.navigate', { url: 'http://127.0.0.1:5174/tests/stt-capture.html' });
  await new Promise((r) => setTimeout(r, 500));
  const r = await call('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
    const { PcmCapture } = await import('/src/pcm-capture.ts');
    const context = new AudioContext({ sampleRate: 44100 });
    await context.resume();
    const destination = context.createMediaStreamDestination();
    const oscillator = context.createOscillator(); oscillator.frequency.value = 1000;
    const gain = context.createGain(); gain.gain.value = 0.2;
    oscillator.connect(gain).connect(destination); oscillator.start();
    const capture = await PcmCapture.open(destination.stream);
    const frames = []; let errors = 0;
    capture.start(frame => frames.push(...frame), () => errors++);
    await new Promise(r => setTimeout(r, 100));
    const beforeStall = frames.length;
    const stallStart = performance.now();
    while (performance.now() - stallStart < 650) { /* deliberately block the renderer, not the worklet */ }
    const stallMs = performance.now() - stallStart;
    await new Promise(r => setTimeout(r, 350));
    const recoveredSamples = frames.length - beforeStall;
    await new Promise(r => capture.flush(r));
    const n = frames.length;
    await new Promise(r => setTimeout(r, 100));
    const stableAfterFlush = frames.length === n;
    capture.start(frame => frames.push(...frame), () => errors++);
    await new Promise(r => setTimeout(r, 100));
    capture.pause(); const paused = frames.length;
    await new Promise(r => setTimeout(r, 100));
    const stableAfterPause = frames.length === paused;
    capture.close(); oscillator.stop(); destination.stream.getTracks().forEach(t => t.stop()); await context.close();
    const a = frames.slice(1600, n - 320);
    const crossings = a.filter((v, i) => i && a[i-1] <= 0 && v > 0).length;
    return { sourceRate: context.sampleRate, capturedSamples: n, frequency: crossings * 16000 / a.length,
      rms: Math.sqrt(a.reduce((s,v) => s + (v/32768)**2,0)/a.length), errors, stableAfterFlush, stableAfterPause,
      resumed: paused > n, stallMs, recoveredSamples };
  })()`,
  });
  assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
  const result = r.result.value;
  assert.equal(result.errors, 0);
  assert(result.stallMs >= 650 && result.recoveredSamples >= 12000);
  assert(result.stableAfterFlush && result.stableAfterPause && result.resumed);
  assert(result.capturedSamples > 14000 && result.capturedSamples < 21000);
  assert(Math.abs(result.frequency - 1000) < 5);
  assert(Math.abs(result.rms - 0.1414) < 0.01);
  console.log(JSON.stringify(result));
  if (process.env.STT_EVIDENCE)
    await writeFile(`${process.env.STT_EVIDENCE}/browser-capture.json`, JSON.stringify(result, null, 2));
} finally {
  close();
}
