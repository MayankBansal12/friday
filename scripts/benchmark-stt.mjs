// Exercises Friday's real conversion, persistent worker, and wake-word pipeline.
import { execFileSync } from 'node:child_process';
import { log } from 'node:console';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { SpeechService } from '../dist-electron/speech-service.js';

const directory = await mkdtemp(join(tmpdir(), 'friday-stt-benchmark-'));
const speech = new SpeechService('Friday');
try {
  const supplied = process.argv[2];
  const file = supplied ? resolve(supplied) : join(directory, 'sample.webm');
  if (!supplied) {
    const wav = join(directory, 'sample.wav');
    execFileSync('espeak-ng', [
      '-s',
      '160',
      '-w',
      wav,
      'Friday, open the settings and help me connect to my wireless network.',
    ]);
    // Match the browser recorder's usual format, including the conversion cost.
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', wav, '-c:a', 'libopus', file]);
  }
  const duration = Number(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
      { encoding: 'utf8' },
    ).trim(),
  );
  const buffer = await readFile(file);
  const audio = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const trials = [];
  for (let i = 0; i < 6; i++) {
    const result = await speech.transcribe(audio, supplied ? 'audio/wav' : 'audio/webm');
    if (!result.text.trim()) throw new Error('Parakeet returned an empty transcript.');
    if (!supplied && (!result.wakeDetected || !/wireless network/i.test(result.command || '')))
      throw new Error(`Synthetic speech smoke test failed: ${result.text}`);
    trials.push({ phase: i === 0 ? 'cold' : 'warm', ...result });
  }
  const warm = trials
    .slice(1)
    .map((trial) => trial.timings.totalMs)
    .sort((a, b) => a - b);
  log(
    JSON.stringify(
      {
        sample: supplied ? file : 'Synthetic espeak-ng sentence (not a microphone accuracy test)',
        cpu: cpus()[0]?.model,
        durationSeconds: duration,
        warmMedianMs: warm[Math.floor(warm.length / 2)],
        warmRangeMs: [warm[0], warm.at(-1)],
        trials,
      },
      null,
      2,
    ),
  );
} finally {
  speech.close();
  await rm(directory, { recursive: true, force: true });
}
