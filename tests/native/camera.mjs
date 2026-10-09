// Exercises the real capture command with synthetic video, never a physical camera or model.
// Run after pnpm desktop:build: node tests/native/camera.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Camera, cameraGroupActive } from '../../dist-electron/camera.js';

const children = [];
const camera = new Camera({
  spawn(command, args, options) {
    const input = args.indexOf('-i');
    assert.equal(args[input - 1], 'video4linux2');
    assert.equal(args[input + 1], '/dev/video0');
    const synthetic = [...args];
    synthetic[input - 1] = 'lavfi';
    synthetic[input + 1] = 'testsrc2=size=1920x1080:rate=30';
    // A real camera delivers frames in real time; make the synthetic source do the same.
    synthetic.splice(input - 2, 0, '-re');
    const child = spawn(command, synthetic, options);
    children.push(child);
    return child;
  },
  device: '/dev/video0',
});
for (let i = 0; i < 2; i++) {
  await camera.open();
  assert.equal(camera.state, 'live');
  const first = await camera.frame(0, new AbortController().signal);
  const second = await camera.frame(first.capturedAt, new AbortController().signal);
  assert(second.capturedAt > first.capturedAt, 'a later look must get a fresh frame');
  for (const frame of [first, second]) {
    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', 'pipe:0'], {
        input: frame.data,
      }),
    );
    assert.equal(probe.streams.length, 1);
    assert.equal(probe.streams[0].width, 1024);
    assert.equal(probe.streams[0].height, 576);
    assert.equal(probe.streams[0].nb_read_frames, '1');
  }
  await camera.close();
  assert.equal(camera.state, 'off');
  assert.notEqual(children[i].exitCode ?? children[i].signalCode, null, 'camera must be closed before close() returns');
}
console.log('Camera: real FFmpeg streamed fresh scaled JPEG frames, closed, and reopened (synthetic video only).');

// A wrapper and descendant both ignore SIGTERM and hold stdout open. Cancellation must kill both.
let wrapper;
let wrapperReady;
const ready = new Promise((resolve) => (wrapperReady = resolve));
const wrapped = new Camera({
  spawn(_command, _args, options) {
    wrapper = spawn(
      process.execPath,
      [
        '-e',
        `
      process.on('SIGTERM', () => {});
      require('node:child_process').spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"
      ], {stdio: ['ignore', 'inherit', 'inherit']});
      setInterval(() => {}, 1000);
    `,
      ],
      options,
    );
    wrapper.stdout.once('data', () => wrapperReady());
    return wrapper;
  },
});
const emergency = setTimeout(() => {
  if (wrapper?.pid) process.kill(-wrapper.pid, 'SIGKILL');
}, 5000);
const started = Date.now();
try {
  const opening = wrapped.open().catch((error) => error);
  await ready;
  await wrapped.close();
  assert.match(String(await opening), /closed/);
  assert(Date.now() - started < 4000, 'closing the camera must stop wrapper and descendant promptly');
  assert.equal(wrapper.signalCode, 'SIGKILL');
} finally {
  clearTimeout(emergency);
}
console.log('Camera: SIGKILL closed a wrapper and its child after both ignored SIGTERM.');

// The wrapper exits on SIGTERM while its child survives with separate output pipes.
// Wrapper "close" must not cancel escalation or report the camera off early.
let earlyWrapper;
let descendant;
let descendantReady;
const descendantStarted = new Promise((resolve) => (descendantReady = resolve));
const earlyClose = new Camera({
  spawn(_command, _args, options) {
    const childCode = "process.on('SIGTERM', () => {}); process.send(process.pid); setInterval(() => {}, 1000);";
    const wrapperCode = `
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}],
        {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
      child.on('message', pid => process.stdout.write(String(pid)));
      setInterval(() => {}, 1000);
    `;
    earlyWrapper = spawn(process.execPath, ['-e', wrapperCode], options);
    earlyWrapper.stdout.once('data', (data) => {
      descendant = Number(data.toString());
      descendantReady();
    });
    return earlyWrapper;
  },
});
const killEarlyGroup = () => {
  if (earlyWrapper?.pid) {
    try {
      process.kill(-earlyWrapper.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
};
const earlyEmergency = setTimeout(killEarlyGroup, 5000);
const earlyStarted = Date.now();
try {
  const opening = earlyClose.open().catch((error) => error);
  await descendantStarted;
  await earlyClose.close();
  assert.match(String(await opening), /closed/);
  assert.equal(earlyClose.state, 'off');
  assert(Date.now() - earlyStarted < 4000, 'close must finish before emergency cleanup');
  assert.equal(earlyWrapper.signalCode, 'SIGTERM', 'wrapper must exit before escalation');
  assert(Number.isInteger(descendant) && descendant > 0, 'descendant must start before cancellation');
  assert.equal(await cameraGroupActive(earlyWrapper.pid), false, 'no group member may retain resources');
  try {
    const stat = await readFile(`/proc/${descendant}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[0];
    assert(['Z', 'X'].includes(state), 'descendant must have exited before close() returns');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
} finally {
  clearTimeout(earlyEmergency);
  killEarlyGroup();
}
console.log('Camera: early wrapper exit preserved SIGKILL escalation until its separate-pipe child exited.');
