// Real renderer → IPC → agent → native GNOME regression, only in the isolated desktop.
import assert from 'node:assert/strict';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectRenderer } from './cdp.mjs';

if (!process.env.FRIDAY_ISOLATED_TEST) throw new Error('Requires the isolated native harness');
const stage = process.env.FRIDAY_TEST_STAGE;
const { call, close } = await connectRenderer(process.argv[2]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function request(prompt) {
  await evaluate(`document.querySelector('[aria-label="Show Friday updates"]')?.click()`);
  await delay(200);
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Type instead'))?.click()`);
  await delay(200);
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Ask Friday"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(prompt)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(100);
  await evaluate(`document.querySelector('input[aria-label="Ask Friday"]').form.requestSubmit()`);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const task = await evaluate(
      `window.buddy.listTasks().then(tasks => tasks.find(t => t.prompt === ${JSON.stringify(prompt)}))`,
    );
    if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) {
      assert.equal(task.status, 'completed', JSON.stringify(task));
      console.log(
        JSON.stringify({
          timings: task.timings,
          tools: task.steps
            .filter((s) => s.kind === 'tool')
            .map((s) => ({ title: s.title, status: s.status, durationMs: s.durationMs, metrics: s.metrics })),
        }),
      );
      return task;
    }
    await delay(250);
  }
  throw new Error('Real UI request timed out');
}
try {
  await evaluate(`document.querySelector('[aria-label="Show Friday updates"]')?.click()`);
  await delay(200);
  await evaluate(`document.querySelector('[aria-label="Open settings and history"]').click()`);
  await delay(200);
  await evaluate(`document.querySelector('[aria-label="Open settings"]').click()`);
  await delay(300);
  await evaluate(`(() => {
    const option = [...document.querySelectorAll('label')].find(label => label.textContent.includes('Read replies aloud'))?.querySelector('input');
    if (!option) throw Error('Spoken reply setting missing');
    if (!option.checked) option.click();
    document.querySelector('[aria-label="Close settings"]').click();
  })()`);
  await evaluate('window.buddy.setExpanded(false)');
  await delay(200);
  assert.equal(await evaluate('window.buddy.getSettings().then(settings => settings.autoSpeak)'), true);
  const first = await request('Look at my screen and circle the main button.');
  assert(first.steps.some((s) => s.title === 'Using desktop draw' && s.status === 'done'));
  const status = await evaluate('window.buddy.desktopStatus()');
  assert(status.annotations >= 1, 'The drawing disappeared when Friday completed');
  assert.equal(await evaluate("Boolean(document.querySelector('[data-surface]'))"), true);
  for (let i = 0; i < 30; i++) {
    if (
      await stat(join(stage, 'auto-speech.wav')).then(
        (info) => info.size > 1000,
        () => false,
      )
    )
      break;
    await delay(100);
  }
  const spoken = await readFile(join(stage, 'auto-speech.wav'));
  assert.equal(spoken.subarray(0, 4).toString(), 'RIFF');
  assert(
    spoken.length > 1000 && spoken.subarray(44).some((byte) => byte !== 0),
    'Automatic spoken reply contained no audio',
  );
  console.log(`PASS: automatic reply synthesized ${spoken.length} bytes of local speech`);
  await writeFile(join(stage, 'ui-drawing-ready'), 'ready');
  for (let i = 0; i < 400; i++) {
    if (
      await access(join(stage, 'ui-drawing-captured')).then(
        () => true,
        () => false,
      )
    )
      break;
    await delay(100);
  }
  await access(join(stage, 'ui-drawing-captured'));
  const second = await request(
    'Which button did we discuss? Look again and point to it with an arrow. Guide me without clicking.',
  );
  assert.equal(second.conversationId, first.conversationId);
  assert(second.steps.some((s) => s.title === 'Using desktop draw' && s.status === 'done'));
  assert.match(second.response, /button|open/i);
  await writeFile(join(stage, 'ui-agent-results.json'), JSON.stringify({ first, second }, null, 2));
  console.log(
    'PASS: exact user request → fullscreen screenshot → visible caption and drawing → automatic window return → same-parent follow-up → fresh observation → guidance',
  );
} finally {
  close();
}

// Electron can defer a WebSocket close handshake while its window is minimized.
// All assertions and artifact writes have completed; do not keep the test alive for that socket.
process.exit(0);
