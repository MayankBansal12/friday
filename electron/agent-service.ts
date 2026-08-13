import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { TaskStore } from './store.js';
import type { AgentStep, BuddySettings, TaskRecord } from './types.js';

const systemPrompt = `You are Friday, a local desktop agent working directly on the user's Linux computer.
Complete the user's task autonomously using the desktop, files, applications, browser, and shell as needed. Use desktop_observe before GUI actions and after actions when the result is not certain. Prefer direct file and shell tools when appropriate.
Never expose private chain-of-thought. Keep user-facing text brief, concrete, and conversational. Say what was achieved or what blocked you.
Only ask for approval for consequential actions: deletion or irreversible changes, privilege escalation, purchases, sending messages, publishing, or disclosing sensitive data. For desktop_action set confirmationReason before any such action. Ordinary navigation, typing drafts, opening apps, editing local files, and reversible work do not require approval.
Do not claim success until you have verified the result.`;

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
  private active = new Map<string, ActiveRun>();
  private approvalOwners = new Map<string, ActiveRun>();

  constructor(
    private readonly store: TaskStore,
    private settings: BuddySettings,
    private readonly extensionPath: string,
    private readonly bridge: { url: string; token: string },
  ) {
    super();
  }

  async init() {
    const stored = await this.store.load();
    this.tasks = stored
      .filter((task) => task && typeof task.id === 'string' && typeof task.prompt === 'string')
      .map((task) => ({ ...task, steps: Array.isArray(task.steps) ? task.steps : [] }));
    for (const task of this.tasks) {
      if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
        task.status = 'failed';
        task.error = 'Friday was interrupted when the app closed.';
        task.approval = undefined;
      }
    }
    await this.persist();
  }

  list() {
    return [...this.tasks].sort((a, b) => b.createdAt - a.createdAt);
  }

  getSettings() {
    return { ...this.settings };
  }

  updateSettings(next: Partial<BuddySettings>) {
    this.settings = { ...this.settings, ...next };
  }

  async submit(prompt: string) {
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
    await this.changed(task);
    this.start(task);
    return task;
  }

  async cancel(id: string) {
    const task = this.find(id);
    const run = this.active.get(id);
    if (run) {
      this.send(run, { type: 'abort' });
      setTimeout(() => run.child.kill('SIGTERM'), 1200).unref();
    }
    if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
      task.status = 'cancelled';
      task.approval = undefined;
      this.addStep(task, 'status', 'Stopped by you', undefined, 'done');
      await this.changed(task);
    }
  }

  async resolveApproval(id: string, approved: boolean) {
    const run = this.approvalOwners.get(id);
    if (!run) throw new Error('This approval is no longer active.');
    this.send(run, { type: 'extension_ui_response', id, confirmed: approved });
    this.approvalOwners.delete(id);
    run.task.approval = undefined;
    run.task.status = 'acting';
    this.addStep(run.task, 'status', approved ? 'Approved by you' : 'Action declined', undefined, 'done');
    await this.changed(run.task);
  }

  private start(task: TaskRecord) {
    const child = spawn(
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
        env: {
          ...process.env,
          LINUX_BUDDY_BRIDGE_URL: this.bridge.url,
          LINUX_BUDDY_BRIDGE_TOKEN: this.bridge.token,
        },
      },
    );
    const run: ActiveRun = { child, task, buffer: '', assistantText: '', toolSteps: new Map() };
    this.active.set(task.id, run);
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
      if (this.active.get(task.id) !== run) return;
      if (!['completed', 'failed', 'cancelled'].includes(task.status))
        void this.fail(run, code === 0 ? 'Friday stopped before finishing.' : this.friendlyError(stderr, code));
      this.active.delete(task.id);
    });
    this.send(run, { id: randomUUID(), type: 'prompt', message: task.prompt });
  }

  private consume(run: ActiveRun, value: string) {
    run.buffer += value;
    while (true) {
      const newline = run.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = run.buffer.slice(0, newline).replace(/\r$/, '');
      run.buffer = run.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        void this.event(run, JSON.parse(line) as RpcEvent);
      } catch {
        // Pi RPC stdout is JSONL; ignore malformed diagnostic lines defensively.
      }
    }
  }

  private async event(run: ActiveRun, event: RpcEvent) {
    const task = run.task;
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
      run.assistantText += event.assistantMessageEvent.delta ?? '';
      task.response = run.assistantText;
      await this.changed(task);
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
      if (step) step.status = 'done';
      await this.changed(task);
      return;
    }
    if (event.type === 'extension_ui_request' && event.method === 'confirm' && event.id) {
      task.status = 'awaiting_approval';
      task.approval = {
        id: event.id,
        title: event.title || 'Friday needs your approval',
        message: typeof event.message === 'string' ? event.message : 'Allow this consequential action?',
        createdAt: Date.now(),
      };
      this.approvalOwners.set(event.id, run);
      await this.changed(task);
      return;
    }
    if (event.type === 'agent_end') {
      task.status = 'completed';
      if (!task.response?.trim()) task.response = 'Done.';
      for (const step of task.steps) if (step.status === 'running') step.status = 'done';
      this.addStep(task, 'status', 'Task complete', undefined, 'done');
      await this.changed(task);
      this.active.delete(task.id);
      run.child.stdin.end();
      return;
    }
    if (event.type === 'response' && event.success === false)
      await this.fail(run, event.error || 'Pi rejected the request.');
  }

  private async fail(run: ActiveRun, message: string) {
    if (['completed', 'failed', 'cancelled'].includes(run.task.status)) return;
    run.task.status = 'failed';
    run.task.error = this.friendlyError(message);
    run.task.approval = undefined;
    for (const step of run.task.steps) if (step.status === 'running') step.status = 'failed';
    await this.changed(run.task);
    this.active.delete(run.task.id);
  }

  private friendlyError(message: string, code?: number | null) {
    if (/OPENCODE_API_KEY|api key|unauthorized|authentication/i.test(message))
      return 'OpenCode Go is not connected yet. Add the OPENCODE_API_KEY secret, then try again.';
    return message.trim().slice(-1200) || `Pi exited with code ${code ?? 'unknown'}.`;
  }

  private send(run: ActiveRun, value: Record<string, unknown>) {
    if (run.child.stdin.writable) run.child.stdin.write(`${JSON.stringify(value)}\n`);
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
    await this.persist();
    this.emit('task', structuredClone(task));
  }

  private persist() {
    return this.store.save(this.tasks);
  }
}
