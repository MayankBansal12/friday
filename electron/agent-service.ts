import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { TaskStore } from './store.js';
import type { AgentStep, BuddySettings, TaskRecord } from './types.js';
import { validSettings } from './validation.js';

const systemPrompt = `You are Friday, a local desktop agent working directly on the user's Linux computer.
Complete the user's task autonomously using the desktop, files, applications, browser, and shell as needed. Use desktop_observe before GUI actions and after actions when the result is not certain. Prefer direct file and shell tools when appropriate.
Never expose private chain-of-thought. Keep user-facing text brief, concrete, and conversational. Say what was achieved or what blocked you.
Ask for approval for consequential actions: deletion or irreversible changes, privilege escalation, purchases, sending messages, publishing, or disclosing sensitive data. For desktop_action set confirmationReason before any such action. The shell safety check is a conservative heuristic, not a security sandbox, so you remain responsible for identifying consequential commands it may not recognize.
Do not claim success until you have verified the result.`;

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

interface RpcEvent {
  type: string;
  id?: string;
  method?: string;
  title?: string;
  success?: boolean;
  error?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  assistantMessageEvent?: { type?: string; delta?: string };
  message?: { role?: string; content?: unknown } | string;
}

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  task: TaskRecord;
  buffer: string;
  assistantText: string;
  toolSteps: Map<string, string>;
  events: Promise<void>;
  terminationTimer?: NodeJS.Timeout;
}

export interface AgentServiceOptions {
  spawn?: typeof spawn;
  persistDebounceMs?: number;
  terminateGraceMs?: number;
  maxHistory?: number;
}

function toolTitle(name: string, args: Record<string, unknown> = {}) {
  if (name === 'desktop_observe') return 'Looking at the screen';
  if (name === 'desktop_action') {
    const action = String(args.action ?? 'interact');
    return action === 'type' ? 'Typing in the active app' : `${action.replace('_', ' ')} on the desktop`;
  }
  if (name === 'bash') return 'Running a system task';
  if (name === 'read') return 'Reading a file';
  if (name === 'write' || name === 'edit') return 'Updating a file';
  return `Using ${name.replaceAll('_', ' ')}`;
}

export class AgentService extends EventEmitter {
  private tasks: TaskRecord[] = [];
  private activeRun?: ActiveRun;
  private approvalOwners = new Map<string, ActiveRun>();
  private shuttingDown = false;
  private persistTimer?: NodeJS.Timeout;
  private readonly spawnProcess: typeof spawn;
  private readonly persistDebounceMs: number;
  private readonly terminateGraceMs: number;
  private readonly maxHistory: number;

  constructor(
    private readonly store: TaskStore,
    private settings: BuddySettings,
    private readonly extensionPath: string,
    private readonly bridge: { url: string; token: string },
    options: AgentServiceOptions = {},
  ) {
    super();
    this.spawnProcess = options.spawn ?? spawn;
    this.persistDebounceMs = options.persistDebounceMs ?? 300;
    this.terminateGraceMs = options.terminateGraceMs ?? 1_200;
    this.maxHistory = options.maxHistory ?? 100;
  }

  async init() {
    const stored = await this.store.loadState();
    if (stored.settings) {
      try {
        this.settings = { ...this.settings, ...validSettings(stored.settings) };
      } catch {
        /* Ignore invalid persisted settings and retain safe defaults. */
      }
    }
    this.tasks = stored.tasks
      .filter((task) => task && typeof task.id === 'string' && typeof task.prompt === 'string')
      .map((task) => ({ ...task, steps: Array.isArray(task.steps) ? task.steps : [] }))
      .slice(0, this.maxHistory);
    for (const task of this.tasks) {
      if (!terminalStatuses.has(task.status)) {
        task.status = 'failed';
        task.error = 'Friday was interrupted when the app closed.';
        task.approval = undefined;
        task.updatedAt = Date.now();
      }
    }
    await this.safePersist();
  }

  list() {
    return [...this.tasks].sort((a, b) => b.createdAt - a.createdAt).map((task) => structuredClone(task));
  }

  getSettings() {
    return { ...this.settings };
  }

  async updateSettings(next: Partial<BuddySettings>) {
    const previous = this.settings;
    this.settings = { ...this.settings, ...next };
    try {
      await this.persistNow();
    } catch (error) {
      this.settings = previous;
      throw new Error(`Settings could not be saved: ${error instanceof Error ? error.message : 'unknown error'}`, {
        cause: error,
      });
    }
    return this.getSettings();
  }

  async submit(prompt: string) {
    if (this.shuttingDown) throw new Error('Friday is shutting down.');
    if (!prompt.trim()) throw new Error('Tell Friday what you want done.');
    const task: TaskRecord = {
      id: randomUUID(),
      prompt: prompt.trim().slice(0, 8000),
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [],
    };
    this.tasks.unshift(task);
    this.trimHistory();
    await this.changed(task);
    this.pump();
    return structuredClone(task);
  }

  async cancel(id: string) {
    const task = this.find(id);
    if (terminalStatuses.has(task.status)) return;
    const run = this.activeRun?.task.id === id ? this.activeRun : undefined;
    // Commit the terminal state before signalling the child so late output cannot win the race.
    task.status = 'cancelled';
    task.approval = undefined;
    this.clearApprovals(run);
    for (const step of task.steps) if (step.status === 'running') step.status = 'failed';
    this.addStep(task, 'status', 'Stopped by you', undefined, 'done');
    await this.changed(task);
    if (run) {
      this.send(run, { type: 'abort' });
      this.scheduleTermination(run);
    } else this.pump();
  }

  async resolveApproval(id: string, approved: boolean) {
    const run = this.approvalOwners.get(id);
    if (!run || this.activeRun !== run || run.task.status !== 'awaiting_approval' || run.task.approval?.id !== id)
      throw new Error('This approval is no longer active.');
    this.approvalOwners.delete(id);
    run.task.approval = undefined;
    run.task.status = 'acting';
    this.addStep(run.task, 'status', approved ? 'Approved by you' : 'Action declined', undefined, 'done');
    this.send(run, { type: 'extension_ui_response', id, confirmed: approved });
    await this.changed(run.task);
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    for (const task of this.tasks) {
      if (terminalStatuses.has(task.status)) continue;
      task.status = 'cancelled';
      task.error = undefined;
      task.approval = undefined;
      task.updatedAt = Date.now();
      for (const step of task.steps) if (step.status === 'running') step.status = 'failed';
    }
    this.approvalOwners.clear();
    await this.safePersist();
    const run = this.activeRun;
    if (!run) return;
    this.send(run, { type: 'abort' });
    await this.terminateAndWait(run);
  }

  private pump() {
    if (this.shuttingDown || this.activeRun) return;
    const next = [...this.tasks]
      .filter((task) => task.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (next) this.start(next);
  }

  private start(task: TaskRecord) {
    if (this.activeRun || this.shuttingDown || task.status !== 'queued') return;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(
        process.env.LINUX_BUDDY_PI_BIN || 'pi',
        [
          '--mode',
          'rpc',
          '--provider',
          'opencode-go',
          '--model',
          this.settings.model,
          '--thinking',
          'medium',
          '--no-session',
          '--approve',
          '--extension',
          this.extensionPath,
          '--system-prompt',
          systemPrompt,
        ],
        {
          cwd: resolve(this.settings.defaultCwd),
          shell: false,
          env: { ...process.env, LINUX_BUDDY_BRIDGE_URL: this.bridge.url, LINUX_BUDDY_BRIDGE_TOKEN: this.bridge.token },
        },
      ) as ChildProcessWithoutNullStreams;
    } catch (error) {
      task.status = 'failed';
      task.error = this.friendlyError(error instanceof Error ? error.message : String(error));
      void this.changed(task).then(() => this.pump());
      return;
    }
    const run: ActiveRun = {
      child,
      task,
      buffer: '',
      assistantText: '',
      toolSteps: new Map(),
      events: Promise.resolve(),
    };
    this.activeRun = run;
    task.status = 'thinking';
    this.addStep(task, 'status', 'Friday is understanding the task', undefined, 'running');
    void this.changed(task);
    child.stdout.on('data', (chunk: Buffer) => this.consume(run, chunk.toString('utf8')));
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-5000);
    });
    child.on('error', (error) => void this.fail(run, error.message));
    child.on('close', (code) => {
      void run.events.finally(async () => {
        if (run.terminationTimer) clearTimeout(run.terminationTimer);
        if (this.activeRun !== run) return;
        if (!terminalStatuses.has(task.status))
          await this.fail(run, code === 0 ? 'Friday stopped before finishing.' : this.friendlyError(stderr, code));
        this.clearApprovals(run);
        this.activeRun = undefined;
        this.pump();
      });
    });
    this.send(run, { id: randomUUID(), type: 'prompt', message: task.prompt });
  }

  private consume(run: ActiveRun, value: string) {
    if (this.activeRun !== run) return;
    run.buffer = `${run.buffer}${value}`.slice(-1_000_000);
    while (true) {
      const newline = run.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = run.buffer.slice(0, newline).replace(/\r$/, '');
      run.buffer = run.buffer.slice(newline + 1);
      if (!line || line.length > 512_000) continue;
      try {
        const event = JSON.parse(line) as RpcEvent;
        run.events = run.events
          .then(() => this.event(run, event))
          .catch((error) => console.error('Friday RPC event failed', error));
      } catch {
        /* Ignore malformed diagnostic lines on Pi's JSONL stdout. */
      }
    }
  }

  private async event(run: ActiveRun, event: RpcEvent) {
    const task = run.task;
    if (this.activeRun !== run || terminalStatuses.has(task.status)) return;
    if (event.type === 'agent_start') {
      task.status = 'thinking';
      await this.changed(task);
      return;
    }
    if (event.type === 'message_start' && typeof event.message === 'object' && event.message?.role === 'assistant') {
      run.assistantText = '';
      return;
    }
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      run.assistantText = `${run.assistantText}${event.assistantMessageEvent.delta ?? ''}`.slice(-200_000);
      task.response = run.assistantText;
      this.changedDeferred(task);
      return;
    }
    if (event.type === 'tool_execution_start' && event.toolCallId) {
      task.status = 'acting';
      const step = this.addStep(task, 'tool', toolTitle(event.toolName || 'tool', event.args), undefined, 'running');
      run.toolSteps.set(event.toolCallId, step.id);
      await this.changed(task);
      return;
    }
    if (event.type === 'tool_execution_end' && event.toolCallId) {
      const stepId = run.toolSteps.get(event.toolCallId);
      const step = stepId ? task.steps.find((item) => item.id === stepId) : undefined;
      if (step) step.status = event.success === false ? 'failed' : 'done';
      run.toolSteps.delete(event.toolCallId);
      await this.changed(task);
      return;
    }
    if (event.type === 'extension_ui_request' && event.method === 'confirm' && event.id) {
      this.clearApprovals(run);
      task.status = 'awaiting_approval';
      task.approval = {
        id: event.id,
        title: event.title || 'Friday needs your approval',
        message: typeof event.message === 'string' ? event.message.slice(0, 4000) : 'Allow this consequential action?',
        createdAt: Date.now(),
      };
      this.approvalOwners.set(event.id, run);
      await this.changed(task);
      return;
    }
    if (event.type === 'agent_end') {
      task.status = 'completed';
      task.approval = undefined;
      this.clearApprovals(run);
      if (!task.response?.trim()) task.response = 'Done.';
      for (const step of task.steps) if (step.status === 'running') step.status = 'done';
      this.addStep(task, 'status', 'Task complete', undefined, 'done');
      await this.changed(task);
      run.child.stdin.end();
      this.scheduleTermination(run);
      return;
    }
    if (event.type === 'response' && event.success === false)
      await this.fail(run, event.error || 'Pi rejected the request.');
  }

  private async fail(run: ActiveRun, message: string) {
    if (terminalStatuses.has(run.task.status)) return;
    run.task.status = 'failed';
    run.task.error = this.friendlyError(message);
    run.task.approval = undefined;
    this.clearApprovals(run);
    for (const step of run.task.steps) if (step.status === 'running') step.status = 'failed';
    await this.changed(run.task);
    this.scheduleTermination(run);
  }

  private friendlyError(message: string, code?: number | null) {
    if (/OPENCODE_API_KEY|api key|unauthorized|authentication/i.test(message))
      return 'OpenCode Go is not connected yet. Add the OPENCODE_API_KEY secret, then try again.';
    return message.trim().slice(-1200) || `Pi exited with code ${code ?? 'unknown'}.`;
  }

  private send(run: ActiveRun, value: Record<string, unknown>) {
    if (run.child.stdin.writable && !run.child.stdin.destroyed) run.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private scheduleTermination(run: ActiveRun) {
    if (run.terminationTimer) return;
    run.terminationTimer = setTimeout(() => {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGTERM');
      run.terminationTimer = setTimeout(() => {
        if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
      }, this.terminateGraceMs);
      run.terminationTimer.unref();
    }, this.terminateGraceMs);
    run.terminationTimer.unref();
  }

  private async terminateAndWait(run: ActiveRun) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) return;
    const closed = new Promise<void>((resolveClose) => run.child.once('close', () => resolveClose()));
    run.child.kill('SIGTERM');
    const first = await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), this.terminateGraceMs)),
    ]);
    if (first) return;
    run.child.kill('SIGKILL');
    await Promise.race([
      closed,
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, this.terminateGraceMs)),
    ]);
  }

  private clearApprovals(run?: ActiveRun) {
    if (!run) return;
    for (const [id, owner] of this.approvalOwners) if (owner === run) this.approvalOwners.delete(id);
    run.task.approval = undefined;
  }

  private find(id: string) {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) throw new Error('Task not found.');
    return task;
  }

  private addStep(
    task: TaskRecord,
    kind: AgentStep['kind'],
    title: string,
    detail?: string,
    status: AgentStep['status'] = 'done',
  ) {
    const step: AgentStep = { id: randomUUID(), kind, title, detail, status, createdAt: Date.now() };
    task.steps.push(step);
    return step;
  }

  private async changed(task: TaskRecord) {
    task.updatedAt = Date.now();
    this.emit('task', structuredClone(task));
    await this.safePersist();
  }

  private changedDeferred(task: TaskRecord) {
    task.updatedAt = Date.now();
    this.emit('task', structuredClone(task));
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.safePersist();
    }, this.persistDebounceMs);
    this.persistTimer.unref();
  }

  private trimHistory() {
    if (this.tasks.length <= this.maxHistory) return;
    const removable = this.tasks
      .filter((task) => terminalStatuses.has(task.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (this.tasks.length > this.maxHistory && removable.length) {
      const old = removable.shift();
      this.tasks = this.tasks.filter((task) => task !== old);
    }
  }

  private async safePersist() {
    try {
      await this.persistNow();
    } catch (error) {
      console.error('Friday could not persist local state', error);
      this.emit('store-error', error);
    }
  }

  private persistNow() {
    return this.store.save(this.tasks, this.settings);
  }
}
