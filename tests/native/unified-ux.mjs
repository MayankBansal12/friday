// Run against an isolated Chrome CDP page and the simulated presence preview.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { connectRenderer } from './cdp.mjs';

const { call, close } = await connectRenderer(process.env.CDP_PORT || 9338);
const base = process.env.FRIDAY_PREVIEW_URL || 'http://127.0.0.1:5178';
const output = process.env.FRIDAY_SCREENSHOTS || '/tmp/opencode/friday-unified-ux';
const pause = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await pause();
}
async function screenshot(name) {
  const result = await call('Page.captureScreenshot', {});
  await writeFile(`${output}/${name}.png`, Buffer.from(result.data, 'base64'));
}
try {
  await mkdir(output, { recursive: true });
  await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await call('Page.navigate', { url: `${base}/tests/presence-preview.html?state=off` });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate("Boolean(document.querySelector('.presence-heading'))")) break;
    await pause(100);
  }
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  await click('.presence-composer.is-idle');
  await call('Input.insertText', { text: 'Keep this draft across sizes' });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 550, y: 80 });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 850 });
  await pause(650);
  assert.equal(await evaluate("document.activeElement?.getAttribute('aria-label')"), 'Ask Friday');
  await screenshot('compact-draft');
  await click('[aria-label="Open workspace"]');
  assert.equal(await evaluate("document.querySelector('textarea').value"), 'Keep this draft across sizes');
  await screenshot('workspace-draft');
  await click('[aria-label="Back to pill"]');
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  await click('.presence-composer.is-idle');
  assert.equal(
    await evaluate('document.querySelector(\'input[aria-label="Ask Friday"]\').value'),
    'Keep this draft across sizes',
  );
  await click('[aria-label="Collapse to pill"]');
  const before = await evaluate('fixture.calls.length');
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  await click('[aria-label="Collapse to pill"]');
  assert.deepEqual(
    await evaluate(
      `fixture.calls.slice(${before}).filter(c => ['silence','stop','microphone','interrupt'].includes(c[0]))`,
    ),
    [],
  );
  await evaluate(
    "fixture.task({id:'reply',role:'parent',conversationId:'parent',prompt:'Show me a list',response:'**Shared answer**\\n\\n- First\\n- Second',status:'completed',steps:[],createdAt:1,updatedAt:2});fixture.emit();document.activeElement.blur();document.querySelector('.presence-heading').focus()",
  );
  await pause();
  assert.equal(await evaluate("document.querySelector('.conversation-answer strong').textContent"), 'Shared answer');
  await screenshot('compact-answer');
  await click('[aria-label="Open workspace"]');
  assert.equal(await evaluate("document.querySelector('.conversation-answer strong').textContent"), 'Shared answer');
  assert.equal(await evaluate("document.querySelectorAll('.conversation-answer li').length"), 2);
  await screenshot('workspace-answer');
  await evaluate(
    "for(let i=0;i<14;i++) fixture.task({id:'long-'+i,role:'parent',conversationId:'parent',prompt:'Question '+i,response:'A longer response to read. '.repeat(20),status:'completed',steps:[],createdAt:i+10,updatedAt:i+10});fixture.emit()",
  );
  await pause();
  await evaluate("document.querySelector('.content-scroll').scrollTop=0");
  await pause();
  await evaluate(
    "fixture.task({id:'last',role:'parent',conversationId:'parent',prompt:'Latest question',response:'The newest reply',status:'completed',steps:[],createdAt:100,updatedAt:100});fixture.emit()",
  );
  await pause();
  assert.equal(
    await evaluate("document.querySelector('.content-scroll').scrollTop"),
    0,
    'stream updates must not move a reader who scrolled up',
  );
  await click('[aria-label="Back to pill"]');
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  assert(
    await evaluate(
      "(()=>{const el=document.querySelector('.presence-content');return el.scrollHeight-el.scrollTop-el.clientHeight<48})()",
    ),
    'reopened panel starts at latest turn',
  );
  await screenshot('compact-long');
  await click('[aria-label="Open workspace"]');
  await click('[aria-label="Open settings"]');
  await screenshot('settings');
  console.log(`Unified UX regression checks passed. Screenshots: ${output}`);
} finally {
  close();
}
