// Optional real-Pi smoke test; uses a temporary task store and no microphone/screen.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { AgentService } from '../../dist-electron/agent-service.js';
import { TaskStore } from '../../dist-electron/store.js';

config({ path: '.env.local', quiet: true });
const dir = await mkdtemp(join(tmpdir(), 'friday-sessions-'));
const service = new AgentService(
  new TaskStore(join(dir, 'state.json')),
  {
    defaultCwd: dir,
    launchAtLogin: false,
    wakeWord: 'Friday',
    autoSpeak: false,
    model: process.env.LINUX_BUDDY_MODEL || 'glm-5.3-flash',
  },
  fileURLToPath(new URL('../../dist-electron/friday-extension.js', import.meta.url)),
  { url: 'http://127.0.0.1:1' },
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function finished(id) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const task = service.list().find((t) => t.id === id);
    if (['completed', 'failed', 'cancelled'].includes(task?.status)) {
      assert.equal(task.status, 'completed', task.error);
      console.log(
        JSON.stringify({
          role: task.role,
          tools: task.steps.filter((s) => s.kind === 'tool').map((s) => `${s.title}: ${s.status}`),
          durationMs: task.timings.totalMs,
        }),
      );
      return task;
    }
    await delay(150);
  }
  throw new Error('Session smoke test timed out');
}
try {
  await service.init();
  const first = await service.submit(
    'Start one background task titled "Sample calculation". Tell the child to use bash to run sleep 12, then calculate 19 * 23, and return the number with the phrase "sample complete". Start it with session_start and immediately show_text "Calculation started" expanded true. Do not wait or poll.',
  );
  await finished(first.id);
  const child = service.state().sessions.find((s) => s.role === 'child');
  assert(child, 'Parent did not delegate');
  const second = await service.submit(
    'While that runs, briefly tell me what 2 + 2 is. Do not cancel or wait for the child.',
  );
  assert.equal(second.conversationId, first.conversationId);
  assert.match((await finished(second.id)).response, /4|four/i);
  const childResult = await finished(child.latestTaskId);
  assert.match(childResult.response, /437/);
  const third = await service.submit(
    'Check the Sample calculation background session with session_read and show me its result using show_text.',
  );
  await finished(third.id);
  assert.match(service.state().presentation.text, /437/);
  assert(
    service
      .list()
      .find((t) => t.id === third.id)
      .steps.some((s) => s.title === 'Using session read' && s.status === 'done'),
  );
  assert((await service.searchSessions('437')).some((result) => result.session.id === child.id));
  console.log(
    'PASS: real Pi parent → child → concurrent parent reply → saved child result → parent presentation and history search',
  );
} finally {
  await service.shutdown();
  await rm(dir, { recursive: true, force: true });
}
