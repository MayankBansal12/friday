import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SafeCodexProvider } from './codex-provider.js';
import { evaluateTool } from './policy.js';
import { DemoProvider, type AgentProvider } from './providers.js';
import { TaskStore } from './store.js';
import type { Approval, BuddySettings, TaskRecord, ToolCall } from './types.js';

const REDACT = /((?:api[_-]?key|token|password|secret)\s*[=:]\s*)\S+/gi;

export class TaskService extends EventEmitter {
  private tasks: TaskRecord[] = [];
  private controllers = new Map<string, AbortController>();
  private approvals = new Map<string, (approved: boolean) => void>();
  constructor(
    private readonly store: TaskStore,
    private settings: BuddySettings,
    private readonly openUrl: (url: string) => Promise<void>,
  ) {
    super();
  }

  async init() {
    this.tasks = await this.store.load();
    for (const task of this.tasks)
      if (['queued', 'planning', 'running', 'awaiting_approval'].includes(task.status)) {
        task.status = 'failed';
        task.error = 'Interrupted when the background service stopped';
        task.updatedAt = Date.now();
      }
    await this.persist();
  }
  list() {
    return [...this.tasks].sort((a, b) => b.createdAt - a.createdAt);
  }
  getSettings() {
    return { ...this.settings };
  }
  async updateSettings(next: Partial<BuddySettings>) {
    this.settings = { ...this.settings, ...next };
  }
  async submit(prompt: string): Promise<TaskRecord> {
    if (!prompt.trim()) throw new Error('Request cannot be empty');
    const task: TaskRecord = {
      id: randomUUID(),
      prompt: prompt.trim().slice(0, 4000),
      status: 'queued',
      provider: this.settings.provider,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      output: [],
    };
    this.tasks.unshift(task);
    await this.changed(task);
    void this.run(task);
    return task;
  }
  async cancel(id: string) {
    const task = this.find(id);
    this.controllers.get(id)?.abort();
    if (task.approval) this.approvals.get(task.approval.id)?.(false);
    if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
      task.status = 'cancelled';
      task.approval = undefined;
      await this.changed(task);
    }
  }
  resolveApproval(id: string, approved: boolean) {
    this.approvals.get(id)?.(approved);
  }
  private provider(): AgentProvider {
    return this.settings.provider === 'codex' ? new SafeCodexProvider() : new DemoProvider();
  }
  private async run(task: TaskRecord) {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    try {
      task.status = 'planning';
      this.append(task, `Planning with ${task.provider} provider…`);
      await this.changed(task);
      const calls = await this.provider().plan(task.prompt, {
        cwd: this.settings.defaultCwd,
        signal: controller.signal,
      });
      this.append(task, `Planned ${calls.length} tool ${calls.length === 1 ? 'call' : 'calls'}.`);
      await this.changed(task);
      for (const call of calls) {
        if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const decision = evaluateTool(call);
        if (decision.risk === 'blocked') throw new Error(decision.reason);
        if (decision.approval) {
          const approval: Approval = {
            id: randomUUID(),
            taskId: task.id,
            reason: decision.reason,
            risk: decision.risk,
            call,
            createdAt: Date.now(),
          };
          const approvalResult = new Promise<boolean>((done) => this.approvals.set(approval.id, done));
          task.status = 'awaiting_approval';
          task.approval = approval;
          await this.changed(task);
          const allowed = await approvalResult;
          this.approvals.delete(approval.id);
          task.approval = undefined;
          if (!allowed) throw new DOMException('Approval denied', 'AbortError');
        }
        task.status = 'running';
        await this.changed(task);
        await this.execute(task, call, controller.signal);
      }
      task.status = 'completed';
      this.append(task, 'Done.');
      await this.changed(task);
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      task.status = aborted ? 'cancelled' : 'failed';
      task.error = aborted ? undefined : this.clean((error as Error).message);
      await this.changed(task);
    } finally {
      this.controllers.delete(task.id);
    }
  }
  private async execute(task: TaskRecord, call: ToolCall, signal: AbortSignal) {
    if (call.kind === 'browser') {
      const url = new URL(call.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are allowed');
      this.append(task, `Opening ${url.toString()}`);
      await this.openUrl(url.toString());
      return;
    }
    if (call.kind === 'file') {
      const path = resolve(call.path);
      this.append(task, `${call.operation} ${path}`);
      if (call.operation === 'list')
        this.append(
          task,
          (await readdir(path, { withFileTypes: true }))
            .slice(0, 500)
            .map((x) => `${x.isDirectory() ? 'd' : '-'} ${x.name}`)
            .join('\n'),
        );
      else if (call.operation === 'stat') this.append(task, JSON.stringify(await stat(path), null, 2));
      else {
        const data = await readFile(path);
        this.append(task, data.subarray(0, Math.min(call.maxBytes ?? 64_000, 256_000)).toString('utf8'));
      }
      await this.changed(task);
      return;
    }
    this.append(task, `$ ${[call.command, ...call.args].join(' ')}`);
    await this.changed(task);
    await new Promise<void>((done, fail) => {
      let settled = false;
      const child = spawn(call.command, call.args, {
        cwd: resolve(call.cwd),
        shell: false,
        signal,
        env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat' },
      });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) fail(error);
        else done();
      };
      const timer = setTimeout(
        () => {
          child.kill('SIGTERM');
          finish(new Error(`Command timed out after ${call.timeoutMs}ms`));
        },
        Math.min(Math.max(call.timeoutMs, 1000), 300_000),
      );
      const onData = (chunk: Buffer) => {
        this.append(task, chunk.toString());
        void this.changed(task);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (error) => finish(error));
      child.on('close', (code, sig) => (code === 0 ? finish() : finish(new Error(`Command exited ${code ?? sig}`))));
    });
  }
  private find(id: string) {
    const task = this.tasks.find((x) => x.id === id);
    if (!task) throw new Error('Task not found');
    return task;
  }
  private clean(value: string) {
    return value.replace(REDACT, '$1[REDACTED]');
  }
  private append(task: TaskRecord, value: string) {
    for (const line of this.clean(value).split(/\r?\n/)) if (line) task.output.push(line.slice(0, 4000));
    while (task.output.length > 500 || task.output.join('\n').length > 120_000) task.output.shift();
  }
  private async changed(task: TaskRecord) {
    task.updatedAt = Date.now();
    await this.persist();
    this.emit('task', { ...task, output: [...task.output] });
  }
  private persist() {
    return this.store.save(this.tasks);
  }
}
