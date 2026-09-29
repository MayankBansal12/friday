// Main-process LiveKit transport probe: LiveKitVoice (compiled) against a local dev server,
// with an rtc-node stand-in for the renderer. Synthetic tones only: no physical microphone,
// speaker, model or TTS service. Timings are transport-level (capture -> remote frame), not
// acoustic latency. Run `pnpm desktop:build` first and start a dev server, e.g.
// `livekit-server --dev --bind 127.0.0.1`.
import assert from 'node:assert/strict';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  dispose,
} from '@livekit/rtc-node';
import { LiveKitVoice, liveKitToken, listenerIdentity, voiceIdentity } from '../../dist-electron/livekit.js';

const config = {
  url: process.env.LIVEKIT_TEST_URL || 'ws://127.0.0.1:18780',
  apiKey: process.env.LIVEKIT_TEST_KEY || 'devkey',
  apiSecret: process.env.LIVEKIT_TEST_SECRET || 'secret',
  room: `friday-transport-test-${process.pid}`,
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const peak = (samples) => samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
function tone(rate, ms, hz, amplitude = 8000) {
  const samples = new Int16Array((rate * ms) / 1000);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / rate));
  return samples;
}
async function until(check, ms, what) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}`);
    await pause(10);
  }
}

const main = { frames: 0, peak: 0, firstLoudAt: 0, ready: [], expects: [], cancelled: 0, routes: [] };
const voice = new LiveKitVoice(config, {
  expect: (id) => main.expects.push(id),
  cancelled: () => main.cancelled++,
  routable: (ready) => main.routes.push(ready),
  microphoneReady: (sid) => main.ready.push(sid),
  microphone: (frame) => {
    main.frames++;
    if (peak(frame) > 1000) main.firstLoudAt ||= Date.now();
    main.peak = Math.max(main.peak, peak(frame));
  },
});
const listener = new Room();
const heard = { frames: 0, loud: [], reader: undefined };
const results = {};
try {
  await voice.connect();
  // Renderer stand-in: subscribes to Friday's voice and reports it as listening.
  listener.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (participant.identity !== voiceIdentity || track.kind !== TrackKind.KIND_AUDIO) return;
    heard.reader = new AudioStream(track, { sampleRate: 24000, numChannels: 1, frameSizeMs: 20 }).getReader();
    void (async () => {
      for (;;) {
        const next = await heard.reader.read().catch(() => ({ done: true }));
        if (next.done) break;
        heard.frames++;
        if (peak(next.value.data) > 1000) heard.loud.push(Date.now());
      }
    })();
    voice.listener(true);
  });
  await listener.connect(config.url, await liveKitToken(config, listenerIdentity), { autoSubscribe: true });
  await until(() => voice.routable, 10_000, 'voice route');

  // 1. Microphone: renderer publishes, main receives 16 kHz frames by track SID.
  const microphone = new AudioSource(16000, 1);
  const track = LocalAudioTrack.createAudioTrack('microphone', microphone);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  const publication = await listener.localParticipant.publishTrack(track, options);
  await until(() => main.ready.includes(publication.sid), 10_000, 'microphone ready');
  const micTone = tone(16000, 1000, 300);
  const micStarted = Date.now();
  for (let offset = 0; offset < micTone.length; offset += 320)
    await microphone.captureFrame(new AudioFrame(micTone.slice(offset, offset + 320), 16000, 1, 320));
  await until(() => main.frames >= 40 && main.peak > 4000, 10_000, 'microphone frames');
  results.microphone = {
    sid: publication.sid === main.ready.at(-1),
    frames: main.frames,
    peak: main.peak,
    firstLoudMs: main.firstLoudAt - micStarted,
  };

  // 2. Voice: a full playback reaches the listener and closes ok after playout.
  const playback = voice.sink.open();
  const closed = new Promise((resolve) => playback.onClose(resolve));
  const loudBefore = heard.loud.length;
  const voiceStarted = Date.now();
  const pcm = Buffer.from(tone(24000, 1000, 440).buffer);
  for (let offset = 0; offset < pcm.length; offset += 9600) {
    if (!playback.write(pcm.subarray(offset, offset + 9600))) await new Promise((resolve) => playback.onDrain(resolve));
  }
  playback.end();
  const ok = await closed;
  await until(() => heard.loud.length > loudBefore + 30, 10_000, 'voice frames');
  results.voice = {
    evidence: playback.evidence,
    closedOk: ok,
    firstLoudMs: heard.loud[loudBefore] - voiceStarted,
    loudFrames: heard.loud.length - loudBefore,
    expected: main.expects.filter(Boolean).length,
  };
  assert.equal(ok, true);

  // 3. Abort: a long playback cut after 300 ms stops arriving promptly.
  await pause(300);
  const cut = voice.sink.open();
  const cutClosed = new Promise((resolve) => cut.onClose(resolve));
  const long = Buffer.from(tone(24000, 5000, 440).buffer);
  let written = 0;
  const writing = (async () => {
    for (; written < long.length; written += 9600) {
      if (!cut.write(long.subarray(written, written + 9600))) {
        const drained = await Promise.race([
          new Promise((resolve) => cut.onDrain(() => resolve(true))),
          cutClosed.then(() => false),
        ]);
        if (!drained) break;
      }
    }
  })();
  await pause(300);
  const abortedAt = Date.now();
  cut.abort();
  const cutOk = await cutClosed;
  await writing.catch(() => {});
  await pause(1000);
  const trailing = heard.loud.filter((at) => at > abortedAt + 250).length;
  results.abort = { closedOk: cutOk, cancelled: main.cancelled, writtenMs: Math.round(written / 48), trailing };
  assert.equal(cutOk, false);
  assert.equal(main.cancelled >= 1, true);
  assert.equal(trailing, 0, 'voice frames still arriving 250 ms after abort');

  // 4. Unpublishing the microphone clears main's readiness.
  await listener.localParticipant.unpublishTrack(publication.sid);
  await until(() => main.ready.at(-1) === '', 5_000, 'microphone released');
  results.release = { ready: main.ready };

  assert.equal(results.microphone.sid, true);
  assert.equal(results.microphone.frames >= 40, true);
  console.log(JSON.stringify(results, null, 2));
  console.log('PASS: LiveKit transport (synthetic mic -> main, voice -> listener, abort, release)');
} finally {
  await heard.reader?.cancel().catch(() => {});
  await listener.disconnect().catch(() => {});
  await voice.close();
  await dispose().catch(() => {});
}
