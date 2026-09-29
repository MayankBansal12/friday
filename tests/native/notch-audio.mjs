// Synthetic speech -> real local Parakeet -> real renderer wake/stop state machine.
// Uses the isolated preview submit stub, never the user's microphone or a hosted agent.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SpeechService } from '../../dist-electron/speech-service.js';
import { connectRenderer } from './cdp.mjs';
const service = new SpeechService('Friday', { workerPath: resolve('native/parakeet-worker.py') });
const directory = await mkdtemp(join(tmpdir(), 'friday-notch-audio-'));
const recognized = [];
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5174');
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const buffer = Buffer.from(input.audio, 'base64');
    const result = await service.transcribePcm({
      ...input,
      audio: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    });
    recognized.push(result.text);
    response.end(JSON.stringify(result));
  } catch {
    response.writeHead(500);
    response.end('Local transcription failed');
  }
});
let cdp;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function waitFor(expression) {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(expression)) return;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${expression}; synthetic recognition: ${JSON.stringify(recognized)}`);
}
async function say(text) {
  const path = join(directory, 'phrase.wav');
  execFileSync('espeak-ng', ['-v', 'en-us', '-s', '145', '-w', path, text]);
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1']);
  await evaluate(`(async()=>{
    clearInterval(fixture.capture.timer);
    const bytes=Uint8Array.from(atob('${pcm.toString('base64')}'),c=>c.charCodeAt(0));
    const samples=new Int16Array(bytes.buffer);
    const capture=fixture.capture;
    for(let i=0;i<samples.length+16000;i+=320){
      const frame=new Int16Array(320);frame.set(samples.subarray(i,i+320));
      capture.port.onmessage({data:{type:'frame',token:capture.token,audio:frame.buffer}});
      await new Promise(r=>setTimeout(r,20));
    }
  })()`);
}
try {
  await service.prepare();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cdp = await connectRenderer(process.env.CDP_PORT || 9333);
  await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp.call('Page.navigate', { url: 'http://127.0.0.1:5174/tests/presence-preview.html?state=quiet' });
  await pause(1000);
  assert.equal(await evaluate('fixture.listening'), 'listening');
  await evaluate(`window.buddy.transcribePcm=async(request)=>{
    const audio=btoa(Array.from(new Uint8Array(request.audio),b=>String.fromCharCode(b)).join(''));
    const r=await fetch('http://127.0.0.1:${server.address().port}',{method:'POST',body:JSON.stringify({...request,audio})});
    if(!r.ok) throw new Error('ASR unavailable');return r.json();
  }`);
  await say('Hey Friday');
  await waitFor("fixture.listening==='armed'");
  await say('What time is it?');
  await waitFor("fixture.calls.some(c=>c[0]==='submit')");
  assert.equal(await evaluate('fixture.listening'), 'armed');
  await evaluate('fixture.runtime.presentation.speaking=true;fixture.emit()');
  await say('Actually, open the browser settings.');
  await waitFor("fixture.calls.filter(c=>c[0]==='submit').length===2");
  assert.match(await evaluate("fixture.calls.filter(c=>c[0]==='submit').at(-1)[1]"), /browser settings/i);
  assert.equal(await evaluate("fixture.calls.filter(c=>c[0]==='submit').at(-1)[2].source"), 'voice');
  assert.equal(await evaluate('fixture.listening'), 'armed');
  await say('Friday stop');
  await waitFor("fixture.calls.some(c=>c[0]==='stop') && fixture.listening==='listening'");
  await say('Hey Friday');
  await waitFor("fixture.listening==='armed'");
  assert.equal(await evaluate("fixture.calls.filter(c=>c[0]==='submit').length"), 2);
  console.log(
    JSON.stringify({
      outcome: 'passed',
      method:
        'Synthetic English audio through local Parakeet and full React app; simulated work/playback, no physical microphone',
      recognized,
    }),
  );
} finally {
  cdp?.close();
  service.close();
  server.closeAllConnections();
  server.close();
  await rm(directory, { recursive: true, force: true });
}
