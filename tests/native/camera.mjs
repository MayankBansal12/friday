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
    const child = spawn(command, synthetic, options);
    children.push(child);
    return child;
  },
  device: '/dev/video0',
});
for (let i = 0; i < 2; i++) {
  const photo = await camera.capture(new AbortController().signal);
  assert.equal(photo.mimeType, 'image/jpeg');
  assert.equal(children[i].exitCode, 0, 'camera must be closed before returning');
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', 'pipe:0'], {
      input: Buffer.from(photo.data, 'base64'),
    }),
  );
  assert.equal(probe.streams.length, 1);
  assert.equal(probe.streams[0].width, 1280);
  assert.equal(probe.streams[0].height, 720);
  assert.equal(probe.streams[0].nb_read_frames, '1');
}
console.log('Camera: real FFmpeg captured one scaled JPEG, exited, and reopened successfully (synthetic video only).');

// A wrapper and descendant both ignore SIGTERM and hold stdout open. Cancellation must kill both.
let wrapper;
const abort = new AbortController();
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
    wrapper.stdout.once('data', () => abort.abort());
    return wrapper;
  },
});
const emergency = setTimeout(() => {
  if (wrapper?.pid) process.kill(-wrapper.pid, 'SIGKILL');
}, 5000);
const started = Date.now();
try {
  await assert.rejects(wrapped.capture(abort.signal), /cancelled/);
  assert(Date.now() - started < 4000, 'camera cancellation must close wrapper and descendant promptly');
  assert.equal(wrapper.signalCode, 'SIGKILL');
} finally {
  clearTimeout(emergency);
}
console.log('Camera: SIGKILL closed a wrapper and its child after both ignored SIGTERM.');

// The wrapper exits on SIGTERM while its child survives with separate output pipes.
// Wrapper "close" must not cancel escalation or release the capture lock early.
let earlyWrapper;
let descendant;
const earlyAbort = new AbortController();
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
      earlyAbort.abort();
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
  await assert.rejects(earlyClose.capture(earlyAbort.signal), /cancelled/);
  assert(Date.now() - earlyStarted < 4000, 'capture must finish before emergency cleanup');
  assert.equal(earlyWrapper.signalCode, 'SIGTERM', 'wrapper must exit before escalation');
  assert(Number.isInteger(descendant) && descendant > 0, 'descendant must start before cancellation');
  assert.equal(await cameraGroupActive(earlyWrapper.pid), false, 'no group member may retain resources');
  try {
    const stat = await readFile(`/proc/${descendant}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[0];
    assert(['Z', 'X'].includes(state), 'descendant must have exited before capture settles');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
} finally {
  clearTimeout(earlyEmergency);
  killEarlyGroup();
}
console.log('Camera: early wrapper exit preserved SIGKILL escalation until its separate-pipe child exited.');
