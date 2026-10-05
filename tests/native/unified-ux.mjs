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
  await pause(600);
  assert.equal(
    await evaluate('Boolean(document.querySelector(\'[aria-label="Open workspace"]\'))'),
    false,
    'Workspace control stays hidden at rest',
  );
  assert.equal(
    await evaluate('Boolean(document.querySelector(\'[aria-label="Stop Friday"]\'))'),
    false,
    'Idle Friday has no stop control',
  );
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
  // Keep the workspace faded out until the main process confirms the resize.
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await evaluate(`window.originalSetExpanded = window.buddy.setExpanded;
    window.buddy.setExpanded = async value => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return window.originalSetExpanded(value);
    };
    document.querySelector('[aria-label="Back to pill"]').click()`);
  await pause(220);
  assert(await evaluate("document.querySelector('.friday-window').classList.contains('is-closing')"));
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.friday-window')).opacity"), '0');
  await pause(600);
  assert(await evaluate("Boolean(document.querySelector('.presence-heading'))"));
  await evaluate('window.buddy.setExpanded = window.originalSetExpanded');
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  await click('[aria-label="Open workspace"]');
  await click('[aria-label="Back to pill"]');
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  await click('.presence-composer.is-idle');
  assert.equal(
    await evaluate('document.querySelector(\'input[aria-label="Ask Friday"]\').value'),
    'Keep this draft across sizes',
  );
  // Switching apps releases typing/wake suppression without discarding the draft.
  await click('[aria-label="Turn microphone on"]');
  await evaluate("window.dispatchEvent(new Event('blur'))");
  await pause(550);
  assert.notEqual(await evaluate('fixture.listening'), 'paused');
  assert.equal(await evaluate(`Boolean(document.querySelector('input[aria-label="Ask Friday"]'))`), false);
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  assert.equal(
    await evaluate("document.querySelector('.presence-composer.is-idle').textContent"),
    'Keep this draft across sizes',
  );
  // Escape reaches the pill even when the hotkey focuses only the window/body.
  await evaluate(
    "document.activeElement.blur();document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))",
  );
  await pause();
  assert.equal(await evaluate("Boolean(document.querySelector('.presence-body'))"), false);
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
  await click('.view-switcher button:nth-child(2)');
  await evaluate("document.querySelector('.content-scroll').scrollTop=0");
  await pause();
  await click('.view-switcher button:nth-child(1)');
  assert(
    await evaluate(
      "(()=>{const el=document.querySelector('.content-scroll');return el.scrollHeight-el.scrollTop-el.clientHeight<48})()",
    ),
    'Conversation reopens at the latest turn after History',
  );
  await click('[aria-label="Open settings"]');
  await screenshot('settings');
  await evaluate(`fixture.task({id:'failed',role:'parent',conversationId:'parent',prompt:'Fail this request',error:'Unique regression error',status:'failed',steps:[],createdAt:200,updatedAt:200});
    fixture.runtime.presentation = {text:'', expanded:false, speaking:false, taskId:'failed'};fixture.emit()`);
  await click('[aria-label="Back to pill"]');
  await evaluate("document.querySelector('.presence-heading').focus()");
  await pause();
  assert.equal(
    await evaluate(
      "Array.from(document.querySelectorAll('[role=alert]')).filter(el=>el.textContent==='Unique regression error').length",
    ),
    1,
    'A failed conversation turn has one error alert',
  );
  await evaluate(
    `fixture.task({id:'active',role:'parent',conversationId:'parent',prompt:'Do this task',status:'thinking',steps:[],createdAt:300,updatedAt:300});fixture.emit()`,
  );
  await pause();
  assert(
    await evaluate('Boolean(document.querySelector(\'[aria-label="Stop Friday"]\'))'),
    'Stop is available during work',
  );
  await click('[aria-label="Stop Friday"]');
  assert(
    await evaluate("Boolean(document.querySelector('.presence-heading'))"),
    'Stopping work keeps Friday available',
  );
  console.log(`Unified UX regression checks passed. Screenshots: ${output}`);
} finally {
  close();
}
