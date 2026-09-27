import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { desktopInterruption } from './desktop-status.js';
import type { CompanionMode } from './desktop-protocol.js';
import { TaskStore } from './store.js';
import type { AgentStep, BuddySettings, TaskRecord } from './types.js';
import { validSettings } from './validation.js';

const systemPrompt = `You are Friday, a local desktop agent working directly on the user's Linux computer.
Complete the user's task autonomously using the desktop, files, applications, browser, and shell as needed. Use desktop_observe before GUI actions and after actions when the result is not certain. Prefer direct file and shell tools when appropriate.
Never expose private chain-of-thought. Keep user-facing text brief, concrete, and conversational. Say what was achieved or what blocked you.
Ask for approval for consequential actions: deletion or irreversible changes, privilege escalation, purchases, sending messages, publishing, or disclosing sensitive data. The host confirms desktop input. The user can explicitly approve up to five clicks/scrolls in the same window for this request, lasting at most 60 seconds. Always use forceConfirmation=true for consequential desktop actions, even when a bounded permission exists. Describe the intended effect before invoking desktop_action. The shell safety check is a conservative heuristic, not a security sandbox, so you remain responsible for identifying consequential commands it may not recognize.
You share a persistent conversation with the user. Follow-ups such as "open that" refer to prior exchanges and user marks. All observation IDs from earlier requests have expired. Always call desktop_observe in the current request before drawing or acting, including when repeating an earlier request. Never reuse remembered observation IDs or coordinates.
Choose the tools that fit the user's request. Answer directly when no tools are needed, observe when screen context is needed, draw when a visual explanation helps, and act when the user asks you to do something. An explanation request does not authorize changing things. Never ask the user to choose a mode.
Use desktop_draw for visual guidance: prefer circle, arrow, highlight, numbered step, or note. Usually use only 1–3 marks and omit text when the visual is enough. Optional text limits: circle/ellipse/rectangle/highlight/underline 40 characters, arrow/bracket/path 60, step 80, note/label 160; a note may also have a 40-character title. Keep text brief, plain, and useful; the renderer handles formatting and placement. Put longer explanations in the conversation. Use the default style unless color is meaningful. When marking a button or control, use the full outer visible control bounds, including its padded clickable area; never draw around only its text or icon. Arrow x/y alone points at that pixel; step requires a number from 1–9. Drawing never moves the pointer. Screenshots include an observation ID and display ID: use those exact IDs and screenshot pixel coordinates for drawing and input. An action consumes its observation; observe after every action to verify. Screenshots hide Friday until the turn ends. If screen access is unavailable, explain the setup step returned by the tool. Do not repeatedly retry or attempt to bypass the desktop integration through shell input tools.
For simple screen guidance, identify the target and draw promptly. A successful desktop_draw is the verification for a drawing; do not take another screenshot just to verify it because capture clears annotations. Keep final explanations short and describe which element you marked in the past tense. The user may read the reply after the drawing expires, so do not promise the highlight is still visible or will appear later.
Do not claim success until you have verified the result.`;

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

interface RpcEvent {
  type: string;
  id?: string;
  method?: string;
  title?: string;
  success?: boolean;
  isError?: boolean;
  result?: { content?: Array<{ type: string; text?: string }>; details?: { timings?: Record<string, number> } };
  error?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  assistantMessageEvent?: { type?: string; delta?: string };
  message?: RpcMessage | string;
  messages?: RpcMessage[];
}

interface RpcMessage {
  role?: string;
  content?: unknown;
}

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  task: TaskRecord;
  buffer: string;
  assistantText: string;
  toolSteps: Map<string, string>;
  events: Promise<void>;
  terminationTimer?: NodeJS.Timeout;
  startedAt: number;
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

function assistantText(message: RpcMessage | string | undefined) {
  if (!message || typeof message === 'string' || message.role !== 'assistant') return '';
  if (typeof message.content === 'string') return message.content.slice(-200_000);
  if (!Array.isArray(message.content)) return '';
  return message.content
    .flatMap((block) => {
      if (typeof block === 'string') return [block];
      if (!block || typeof block !== 'object') return [];
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === 'text' && typeof candidate.text === 'string' ? [candidate.text] : [];
    })
    .join('\n\n')
    .slice(-200_000);
}

export class AgentService extends EventEmitter {
  private tasks: TaskRecord[] = [];
  private conversationId: string = randomUUID();
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
    private readonly bridge: {
      url: string;
      token?: string;
      beginRun?(id: string, mode: CompanionMode, request?: string): string;
      revokeRun?(id: string, preserveDrawing?: boolean): void;
    },
    options: AgentServiceOptions = {},
  ) {
    super();
    this.spawnProcess = options.spawn ?? spawn;
    this.persistDebounceMs = options.persistDebounceMs ?? 300;
    this.terminateGraceMs = options.terminateGraceMs ?? 1_200;
    this.maxHistory = options.maxHistory ?? 100;
  }

  async init() {
    await mkdir(this.store.sessionDirectory, { recursive: true, mode: 0o700 });
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
    this.conversationId = this.tasks.find((task) => task.conversationId)?.conversationId ?? this.conversationId;
    await this.safePersist();
  }

  newConversation() {
    if (this.tasks.some((task) => !terminalStatuses.has(task.status)))
      throw new Error('Stop the current task before starting a new conversation.');
    this.conversationId = randomUUID();
    return this.conversationId;
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

  async submit(prompt: string, conversationId = this.conversationId) {
    if (conversationId !== this.conversationId && !this.tasks.some((t) => t.conversationId === conversationId))
      throw new Error('Unknown conversation');
    if (this.shuttingDown) throw new Error('Friday is shutting down.');
    if (!prompt.trim()) throw new Error('Tell Friday what you want done.');
    const task: TaskRecord = {
      id: randomUUID(),
      conversationId,
      mode: 'act',
      prompt: prompt.trim().slice(0, 8000),
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [],
      timings: {},
    };
    this.tasks.unshift(task);
    this.trimHistory();
    await this.changed(task);
    this.pump();
    return structuredClone(task);
  }

  async desktopInterrupted(id: string, error: unknown) {
    const run = this.activeRun;
    if (!run || run.task.id !== id || terminalStatuses.has(run.task.status)) return;
    const interruption = desktopInterruption(error);
    if (interruption.user) await this.cancel(id, interruption.source);
    else {
      this.addStep(run.task, 'status', 'Desktop interrupted', interruption.message, 'failed');
      await this.fail(run, interruption.message);
    }
  }

  async cancel(id: string, source: 'user' | 'escape' = 'user') {
    const task = this.find(id);
    if (terminalStatuses.has(task.status)) return;
    const run = this.activeRun?.task.id === id ? this.activeRun : undefined;
    // Commit the terminal state before signalling the child so late output cannot win the race.
    task.status = 'cancelled';
    task.stopReason = source;
    if (run) this.bridge.revokeRun?.(run.task.id);
    task.approval = undefined;
    this.clearApprovals(run);
    for (const step of task.steps) if (step.status === 'running') step.status = 'failed';
    this.addStep(task, 'status', source === 'escape' ? 'Stopped with Escape' : 'Stopped by you', undefined, 'done');
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
    this.bridge.revokeRun?.(run.task.id);
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
    const startedAt = Date.now();
    task.timings ??= {};
    task.timings.queueMs = startedAt - task.createdAt;
    const runToken = this.bridge.beginRun?.(task.id, task.mode ?? 'guide', task.prompt) ?? this.bridge.token;
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
          'low',
          '--session',
          join(this.store.sessionDirectory, `${task.conversationId}.jsonl`),
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-context-files',
          '--no-approve',
          '--tools',
          task.mode === 'act'
            ? 'read,bash,edit,write,grep,find,ls,desktop_observe,desktop_draw,desktop_clear,desktop_action'
            : task.mode === 'explain'
              ? 'desktop_observe'
              : 'desktop_observe,desktop_draw,desktop_clear',
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
            LINUX_BUDDY_BRIDGE_TOKEN: runToken,
            LINUX_BUDDY_MODE: task.mode ?? 'guide',
          },
        },
      ) as ChildProcessWithoutNullStreams;
    } catch (error) {
      this.bridge.revokeRun?.(task.id);
      task.status = 'failed';
      task.error = this.friendlyError(error instanceof Error ? error.message : String(error));
      void this.changed(task).then(() => this.pump());
      return;
    }
    const run: ActiveRun = {
      startedAt,
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
        this.bridge.revokeRun?.(task.id, task.status === 'completed');
        this.clearApprovals(run);
        this.activeRun = undefined;
        this.pump();
      });
    });
    this.send(run, { id: randomUUID(), type: 'prompt', message: task.prompt });
  }

  private consume(run: ActiveRun, value: string) {
    if (this.activeRun !== run) return;
    // Pi includes PNG tool results in JSONL events; a desktop frame can exceed 1 MB.
    run.buffer = `${run.buffer}${value}`.slice(-32 * 1024 * 1024);
    while (true) {
      const newline = run.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = run.buffer.slice(0, newline).replace(/\r$/, '');
      run.buffer = run.buffer.slice(newline + 1);
      if (!line || line.length > 32 * 1024 * 1024) continue;
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
    task.timings ??= {};
    if (event.type === 'agent_start') {
      task.timings.startupMs ??= Date.now() - run.startedAt;
      task.status = 'thinking';
      await this.changed(task);
      return;
    }
    if (event.type === 'message_start' && typeof event.message === 'object' && event.message?.role === 'assistant') {
      run.assistantText = '';
      return;
    }
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      task.timings.firstTextMs ??= Date.now() - task.createdAt;
      run.assistantText = `${run.assistantText}${event.assistantMessageEvent.delta ?? ''}`.slice(-200_000);
      task.response = run.assistantText;
      this.changedDeferred(task);
      return;
    }
    if (event.type === 'message_end') {
      const text = assistantText(typeof event.message === 'string' ? undefined : event.message);
      if (text.trim()) {
        run.assistantText = text;
        task.response = text;
        await this.changed(task);
      }
      return;
    }
    if (event.type === 'tool_execution_start' && event.toolCallId) {
      task.timings.firstModelMs ??= Date.now() - task.createdAt;
      task.status = 'acting';
      const step = this.addStep(task, 'tool', toolTitle(event.toolName || 'tool', event.args), undefined, 'running');
      run.toolSteps.set(event.toolCallId, step.id);
      await this.changed(task);
      return;
    }
    if (event.type === 'tool_execution_end' && event.toolCallId) {
      const stepId = run.toolSteps.get(event.toolCallId);
      const step = stepId ? task.steps.find((item) => item.id === stepId) : undefined;
      if (step) {
        step.durationMs = Date.now() - step.createdAt;
        if (event.result?.details?.timings) step.metrics = event.result.details.timings;
        step.status = event.success === false || event.isError ? 'failed' : 'done';
        if (step.status === 'done' && step.title === 'Using desktop draw')
          task.timings.firstDrawingMs ??= Date.now() - task.createdAt;
        if (step.status === 'failed')
          step.detail = event.result?.content
            ?.filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('\n')
            .slice(0, 2000);
      }
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
      const finalText = [...(event.messages ?? [])]
        .reverse()
        .map(assistantText)
        .find((text) => text.trim());
      if (finalText) task.response = finalText;
      if (!task.response?.trim()) {
        await this.fail(run, 'Friday finished without returning an answer. Please try that request again.');
        return;
      }
      this.bridge.revokeRun?.(task.id, true);
      task.status = 'completed';
      task.timings.totalMs = Date.now() - task.createdAt;
      task.approval = undefined;
      this.clearApprovals(run);
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
    this.bridge.revokeRun?.(run.task.id);
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
