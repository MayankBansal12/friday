import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stageRuntimeExtension } from '../electron/runtime-extension.js';

const exec = promisify(execFile);
let directory: string;
let emitted: string;
const env = { ...process.env };
delete env.RUMIK_API_KEY;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'friday-runtime-test-'));
  emitted = join(directory, 'emitted');
  await exec(
    process.execPath,
    [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.node.json', '--outDir', emitted],
    { env },
  );
}, 30_000);
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('production runtime extension staging', () => {
  it('imports emitted code outside the app and preserves role tools and approval guard', async () => {
    const extension = await stageRuntimeExtension(emitted, join(directory, 'runtime'));
    // Native Node import avoids Vitest resolution/transforms masking missing emitted dependencies.
    const script = `
      import assert from 'node:assert/strict';
      const { default: install } = await import(${JSON.stringify(pathToFileURL(extension).href)});
      for (const role of ['parent', 'child']) {
        process.env.LINUX_BUDDY_ROLE = role;
        const tools = []; let guard;
        install({ registerTool(tool) { tools.push(tool.name); }, on(event, handler) { assert.equal(event, 'tool_call'); guard = handler; } });
        if (role === 'parent') {
          for (const name of ['speak', 'show_text', 'set_presentation', 'session_start', 'session_actions', 'session_list', 'session_read', 'session_search', 'session_update', 'session_stop', 'desktop_observe', 'desktop_draw', 'desktop_clear']) assert(tools.includes(name), name);
          assert(!tools.includes('task_report'));
        } else {
          assert.deepEqual(tools, ['task_report']);
          for (const toolName of ['speak', 'show_text', 'session_start', 'session_actions', 'desktop_observe'])
            assert.equal((await guard({ toolName, input: {} }, {})).block, true);
        }
        let confirmations = 0;
        const context = { ui: { async confirm() { confirmations++; return false; } } };
        assert.equal((await guard({ toolName: 'bash', input: { command: 'rm synthetic-file' } }, context)).block, true);
        assert.equal(confirmations, 1);
        assert.equal(await guard({ toolName: 'bash', input: { command: 'printf hello' } }, context), undefined);
      }
      console.log('Staged parent/child tools and approval guard passed');
    `;
    const result = await exec(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, env });
    expect(result.stdout).toContain('passed');
  });
  it('rejects staging when a dependency is absent instead of returning a tool-less launch path', async () => {
    await rm(join(emitted, 'speech-policy.js'));
    await expect(stageRuntimeExtension(emitted, join(directory, 'incomplete'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
