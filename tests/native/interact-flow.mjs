// Actual React renderer with synthetic capture/IPC. Start Vite :5174 and headless Chrome :9333 first.
import assert from 'node:assert/strict';
import { connectRenderer } from './cdp.mjs';

const { call, close } = await connectRenderer(process.env.CDP_PORT || 9333);
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression, message) {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(expression)) return;
    await pause();
  }
  throw new Error(message || expression);
}
async function open() {
  await call('Page.navigate', {
    url: `${process.env.VITE_TEST_URL || 'http://127.0.0.1:5174'}/tests/presence-preview.html?state=quiet`,
  });
  await until('Boolean(window.fixture?.capture && document.querySelector(".presence-heading"))');
  // Let the quiet scenario advance its synthetic idle clock before engaging voice.
  await pause(900);
  // Exercise the renderer with a controlled IPC boundary, including the new preload method.
  await evaluate("window.buddy.interrupt=async()=>{fixture.calls.push(['interrupt']);}");
  await evaluate('fixture.listen()');
  await pause(150);
}
async function activeSpeech() {
  await evaluate(`(() => {
    fixture.task({id:'review-request',role:'parent',conversationId:'parent',status:'thinking',prompt:'Where is Settings?',steps:[],createdAt:Date.now(),updatedAt:Date.now()});
    fixture.runtime.presentation={taskId:'review-request',text:'The settings button is at the top right.',expanded:false,speaking:true};
    fixture.emit();
  })()`);
  await pause(250);
}
async function say(text) {
  await evaluate('fixture.level=1');
  await pause(550);
  await evaluate('fixture.capture.endUtterance()');
  await until('fixture.pending.length > 0', 'A spoken correction must reach transcription');
  await evaluate(`fixture.finish({text:${JSON.stringify(text)},wakeDetected:false})`);
  await pause(350);
}
try {
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await open();
  await activeSpeech();
  await evaluate('fixture.calls.length=0;fixture.level=1');
  await until('fixture.pending.length>0', 'A live partial must reach transcription');
  await evaluate("fixture.finish({text:'No, I meant the browser settings',wakeDetected:false})");
  await until(
    'fixture.calls.some(c=>c[0]==="interrupt")',
    'A meaningful partial must interrupt before the final transcript',
  );
  assert.equal(await evaluate('fixture.calls.some(c=>c[0]==="submit")'), false);
  await evaluate('fixture.capture.endUtterance()');
  await until('fixture.calls.some(c=>c[0]==="submit")', 'Voice correction was discarded while parent was busy');
  const voice = await evaluate('fixture.calls.filter(c=>c[0]==="submit").at(-1)');
  assert.equal(voice[1], 'No, I meant the browser settings');
  assert.equal(voice[2].source, 'voice');
  assert.equal(await evaluate('fixture.calls.some(c=>c[0]==="stop" || c[0]==="stopChild")'), false);

  await open();
  await activeSpeech();
  await evaluate(`window.buddy.silence=async()=>{fixture.calls.push(['silence']);};fixture.calls.length=0`);
  const point = await evaluate(
    `(()=>{const r=document.querySelector('.presence-heading').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await pause(500);
  await until('Boolean(document.querySelector("button.presence-composer.is-idle"))', 'The composer must be visible');
  await evaluate('document.querySelector("button.presence-composer.is-idle").click()');
  await pause(250);
  const opened = await evaluate('fixture.calls');
  assert(!opened.some((c) => /silence|interrupt|stop/i.test(c[0])), 'Opening the text composer interrupted the reply');
  await evaluate(`(() => {
    const input=document.querySelector('[aria-label="Ask Friday"]');
    const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(input,'Actually show the browser settings');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await pause();
  await evaluate(`document.querySelector('[aria-label="Send request"]').click()`);
  await until('fixture.calls.some(c=>c[0]==="submit")', 'Typed correction could not submit while parent was busy');
  const typed = await evaluate('fixture.calls.filter(c=>c[0]==="submit").at(-1)');
  assert.equal(typed[1], 'Actually show the browser settings');
  assert.equal(typed[2].source, 'typed');
  assert.equal(await evaluate('fixture.calls.some(c=>c[0]==="stop" || c[0]==="stopChild")'), false);
  await open();
  await activeSpeech();
  await evaluate(
    "fixture.runtime.presentation.echo=[{text:'Click the blue Save button in the top right corner.'}];fixture.emit();fixture.calls.length=0",
  );
  await say('Click the blue Save button in the top right corner.');
  assert.equal(
    await evaluate('fixture.calls.some(c=>c[0]==="submit" || c[0]==="interrupt")'),
    false,
    'Friday must not submit or interrupt itself on an echoed final',
  );

  await open();
  await activeSpeech();
  await evaluate('fixture.calls.length=0;fixture.level=1');
  await until('fixture.pending.length>0');
  await evaluate("fixture.stopMic();fixture.finish({text:'No, open the browser settings',wakeDetected:false})");
  await pause(350);
  assert.equal(await evaluate('fixture.listening'), 'idle');
  assert.equal(
    await evaluate('fixture.calls.some(c=>c[0]==="submit" || c[0]==="interrupt")'),
    false,
    'A late transcript after mic-off must be inert',
  );
  console.log(
    JSON.stringify({
      status: 'passed',
      checks: [
        'barge-in on partial before final',
        'voice correction while parent busy/speaking',
        'voice source preserved',
        'opening composer does not interrupt',
        'typed correction while parent busy',
        'typed source preserved',
        'no Stop-all/child cancellation',
        'echoed final ignored',
        'late transcript after mic-off ignored',
      ],
      method: 'Actual React renderer with synthetic capture and IPC fixture; no physical microphone or hosted calls',
    }),
  );
} finally {
  close();
}
