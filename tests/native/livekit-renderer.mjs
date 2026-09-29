// Real browser SDK -> LiveKit -> main and back, with synthetic audio only.
// Start a dev LiveKit server, Vite :5174 and MUTED headless Chrome CDP :9335 first.
// Compile electron/ with pnpm desktop:build. No model, TTS service or physical mic is used.
import assert from 'node:assert/strict';
import { dispose } from '@livekit/rtc-node';
import { WebSocketServer } from 'ws';
import { LiveKitVoice, liveKitToken, listenerIdentity, voiceIdentity } from '../../dist-electron/livekit.js';
import { connectRenderer } from './cdp.mjs';

const config = {
  url: process.env.LIVEKIT_TEST_URL || 'ws://127.0.0.1:18780',
  apiKey: process.env.LIVEKIT_TEST_KEY || 'devkey',
  apiSecret: process.env.LIVEKIT_TEST_SECRET || 'secret',
  room: `friday-browser-test-${process.pid}`,
};
const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((resolve) => server.once('listening', resolve));
let client;
let microphoneFrames = 0;
let microphonePeak = 0;
let observed = 0;
const send = (event, value) => {
  if (client?.readyState === 1) client.send(JSON.stringify({ event, value }));
};
const voice = new LiveKitVoice(config, {
  expect: (id) => send('expect', id || 0),
  cancelled: () => send('cancelled'),
  routable: () => {},
  microphoneReady: (sid) => send('ready', sid),
  microphone: (frame) => {
    microphoneFrames++;
    for (const value of frame) microphonePeak = Math.max(microphonePeak, Math.abs(value));
    send('microphone', [...frame]);
  },
});
server.on('connection', (socket) => {
  client = socket;
  socket.on('message', async (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'session') {
      try {
        await voice.connect();
        socket.send(
          JSON.stringify({
            id: message.id,
            value: {
              url: config.url,
              token: await liveKitToken(config, listenerIdentity),
              voice: voiceIdentity,
            },
          }),
        );
      } catch (error) {
        socket.send(JSON.stringify({ id: message.id, error: String(error) }));
      }
    } else if (message.method === 'listener') voice.listener(message.value);
    else if (message.method === 'observed') {
      observed++;
      voice.observed(message.value);
    }
  });
});
const { call, close } = await connectRenderer(process.env.CDP_PORT || 9335);
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(check, label) {
  const deadline = Date.now() + 9000;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await pause();
  }
}
function tone(ms, hz) {
  return Buffer.from(
    Int16Array.from({ length: 24 * ms }, (_, i) => Math.round(9000 * Math.sin((i * hz * 2 * Math.PI) / 24000))).buffer,
  );
}
try {
  await call('Page.navigate', {
    url: `${process.env.VITE_TEST_URL || 'http://127.0.0.1:5174'}/tests/livekit-preview.html`,
  });
  await until(() => evaluate('document.title.includes("synthetic")'), 'Fixture did not load');
  await evaluate(`(async () => {
    const {LiveKitLink}=await import('/src/livekit-link.ts');
    const socket=new WebSocket(${JSON.stringify(`ws://127.0.0.1:${server.address().port}`)});
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
    const handlers=new Map(), calls=new Map();let sequence=0;
    const listen=event=>fn=>{const set=handlers.get(event)||new Set();handlers.set(event,set);set.add(fn);return()=>set.delete(fn)};
    socket.onmessage=({data})=>{const message=JSON.parse(data);if(message.id){const call=calls.get(message.id);calls.delete(message.id);message.error?call.reject(new Error(message.error)):call.resolve(message.value)}else{const value=message.event==='microphone'?new Int16Array(message.value).buffer:message.value;for(const fn of handlers.get(message.event)||[])fn(value)}};
    const api={
      session:()=>new Promise((resolve,reject)=>{const id=++sequence;calls.set(id,{resolve,reject});socket.send(JSON.stringify({id,method:'session'}))}),
      listener:value=>socket.send(JSON.stringify({method:'listener',value})),
      observed:value=>socket.send(JSON.stringify({method:'observed',value})),
      onExpect:listen('expect'),onCancelled:listen('cancelled'),onMicrophone:listen('microphone'),onMicrophoneReady:listen('ready')
    };
    const link=new LiveKitLink(api);window.probe={link,socket,frames:0,peak:0};await link.start();
  })()`);
  await until(() => voice.routable, 'Browser voice output was never ready');
  const playback = voice.sink.open();
  let drained;
  playback.onClose((ok) => {
    drained = ok;
  });
  playback.write(tone(1200, 440));
  playback.end();
  await until(() => observed > 0, 'Browser never observed voice energy during active playback');
  await until(() => drained !== undefined, 'Voice output never drained');
  assert.equal(drained, true);

  await evaluate(`(async()=>{
    const p=window.probe;p.context=new AudioContext();await p.context.resume();
    p.oscillator=p.context.createOscillator();p.oscillator.frequency.value=660;
    const gain=p.context.createGain();gain.gain.value=.25;
    p.destination=p.context.createMediaStreamDestination();p.oscillator.connect(gain).connect(p.destination);p.oscillator.start();
    p.track=p.destination.stream.getAudioTracks()[0];p.capture=await p.link.capture(p.track);
    if(!p.capture)throw new Error('Synthetic mic capture fell back');
    p.capture.start(frame=>{p.frames++;for(const value of frame)p.peak=Math.max(p.peak,Math.abs(value))},()=>{p.failed=true});
  })()`);
  await until(
    async () => microphoneFrames > 10 && (await evaluate('probe.frames>10 && probe.peak>500')),
    'Browser mic did not reach main and the segmenter',
  );
  assert(microphonePeak > 500);
  const active = voice.sink.open();
  active.write(tone(3000, 440));
  await until(() => evaluate('document.querySelector("audio")?.muted === false'), 'New playback remained muted');
  active.abort();
  await until(
    () => evaluate('document.querySelector("audio")?.muted === true'),
    'Cancellation did not mute buffered browser audio',
  );
  await evaluate('probe.capture.close()');
  assert.equal(await evaluate('probe.track.readyState'), 'live', 'LiveKit stopped the caller-owned synthetic track');
  await evaluate('probe.link.close()');
  await until(() => !voice.routable, 'Closed browser still routed voice');
  assert.equal(await evaluate('document.querySelectorAll("audio").length'), 0);
  console.log(
    JSON.stringify({
      status: 'passed',
      checks: [
        'browser output and onset',
        'synthetic mic round trip',
        'cancel mutes buffered audio',
        'capture preserves track ownership',
        'disconnect cleans output',
      ],
      microphoneFrames,
      microphonePeak,
      observed,
    }),
  );
} finally {
  await evaluate(
    'if(window.probe){probe.capture?.close();probe.link.close();probe.track?.stop();probe.oscillator?.stop();await probe.context?.close();probe.socket.close()}',
  ).catch(() => {});
  close();
  await voice.close();
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
  await dispose();
}
