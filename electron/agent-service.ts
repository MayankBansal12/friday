import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { parentPrompt, childPrompt } from './agent-prompts.js';
import { desktopInterruption } from './desktop-status.js';
import { TaskStore } from './store.js';
import type { AgentStep, BuddySettings, FridayState, PresentationState, SessionRecord, TaskRecord } from './types.js';
import { validSettings } from './validation.js';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const fileTools = 'read,bash,edit,write,grep,find,ls';
const parentTools = `${fileTools},desktop_observe,desktop_draw,desktop_clear,desktop_control,speak,show_text,set_presentation,session_start,session_list,session_read,session_search,session_update,session_stop`;
interface RpcMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}
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
  assistantMessageEvent?: { type?: string; delta?: string };
  message?: RpcMessage | string;
  messages?: RpcMessage[];
}
interface Worker {
  child: ChildProcessWithoutNullStreams;
  session: SessionRecord;
  token: string;
  task?: TaskRecord;
  desktopToken?: string;
  buffer: string;
  assistantText: string;
  toolSteps: Map<string, string>;
  events: Promise<void>;
  error?: string;
  cwd: string;
  model: string;
}
export interface AgentServiceOptions {
  spawn?: typeof spawn;
  persistDebounceMs?: number;
  terminateGraceMs?: number;
  maxHistory?: number;
  maxChildren?: number;
  speak?: (text: string) => Promise<void>;
  silence?: () => void;
}
function messageText(message: RpcMessage | string | undefined) {
  if (!message || typeof message === 'string' || message.role !== 'assistant') return '';
  if (typeof message.content === 'string') return message.content.slice(-200_000);
  return Array.isArray(message.content)
    ? message.content
        .flatMap((block) =>
          block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'
            ? [block.text]
            : [],
        )
        .join('\n\n')
        .slice(-200_000)
    : '';
}
function shortText(value: unknown, name: string, max = 8000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value.trim();
}
function toolTitle(name: string) {
  if (name === 'desktop_observe') return 'Looking at the screen';
  if (name === 'desktop_draw') return 'Using desktop draw';
  if (name === 'session_start') return 'Starting background work';
  if (name === 'speak') return 'Speaking';
  if (name === 'show_text') return 'Showing details';
  return `Using ${name.replaceAll('_', ' ')}`;
}

export class AgentService extends EventEmitter {
  private tasks: TaskRecord[] = [];
  private sessions: SessionRecord[] = [];
  private parentId: string = randomUUID();
  private workers = new Map<string, Worker>();
  private approvalOwners = new Map<string, Worker>();
  private shuttingDown = false;
  private persistTimer?: NodeJS.Timeout;
  private submissions: Promise<unknown> = Promise.resolve();
  private presentation: PresentationState = { text: '', expanded: false, speaking: false };
  private speechGeneration = 0;
  private shownTextTask?: string;
  private server = createServer((request, response) => void this.handle(request, response));
  private runtimeUrl = '';
  private readonly spawnProcess: typeof spawn;
  private readonly grace: number;
  constructor(
    private readonly store: TaskStore,
    private settings: BuddySettings,
    private readonly extensionPath: string,
    private readonly bridge: {
      url: string;
      beginRun?(id: string): string;
      revokeRun?(id: string, preserveDrawing?: boolean): void;
    },
    private readonly options: AgentServiceOptions = {},
  ) {
    super();
    this.spawnProcess = options.spawn ?? spawn;
    this.grace = options.terminateGraceMs ?? 1200;
  }

  async init() {
    await mkdir(this.store.sessionDirectory, { recursive: true, mode: 0o700 });
    const saved = await this.store.loadState();
    if (saved.settings) {
      try {
        this.settings = { ...this.settings, ...validSettings(saved.settings) };
      } catch {
        /* Keep defaults. */
      }
    }
    this.tasks = saved.tasks
      .filter((task) => task && typeof task.id === 'string' && typeof task.prompt === 'string')
      .map((task) => ({ ...task, role: task.role ?? 'parent', steps: Array.isArray(task.steps) ? task.steps : [] }));
    this.sessions = (saved.sessions ?? []).filter((s) => s && /^[a-zA-Z0-9_-]{1,128}$/.test(s.id));
    for (const task of this.tasks) {
      if (
        task.conversationId &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(task.conversationId) &&
        !this.sessions.some((s) => s.id === task.conversationId)
      )
        this.sessions.push({
          id: task.conversationId,
          role: 'parent',
          title: 'Friday',
          status: 'idle',
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          latestTaskId: task.id,
        });
      if (!terminal.has(task.status)) {
        task.status = 'failed';
        task.error = 'Friday was interrupted when the app closed.';
        task.approval = undefined;
      }
    }
    for (const s of this.sessions)
      if (s.status === 'running' || s.status === 'needs_input') {
        s.status = 'interrupted';
        s.summary = 'Interrupted when Friday closed. Resume explicitly to continue.';
      }
    this.parentId =
      this.sessions.find((s) => s.id === saved.parentId && s.role === 'parent')?.id ??
      this.sessions.find((s) => s.role === 'parent')?.id ??
      this.parentId;
    if (!this.sessions.some((s) => s.id === this.parentId))
      this.sessions.unshift(this.newSession('parent', 'Friday', this.parentId));
    this.session(this.parentId).status = 'idle';
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 5000;
    await new Promise<void>((yes, no) => {
      this.server.once('error', no);
      this.server.listen(0, '127.0.0.1', yes);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Friday session bridge could not start');
    this.runtimeUrl = `http://127.0.0.1:${address.port}`;
    await this.persist();
  }
  list() {
    return this.tasks.map((t) => structuredClone(t)).sort((a, b) => b.createdAt - a.createdAt);
  }
  state(): FridayState {
    return structuredClone({ parentId: this.parentId, sessions: this.sessions, presentation: this.presentation });
  }
  getSettings() {
    return { ...this.settings };
  }
  async updateSettings(next: Partial<BuddySettings>) {
    const old = this.settings;
    this.settings = { ...old, ...next };
    try {
      await this.persist();
    } catch (error) {
      this.settings = old;
      throw error;
    }
    return this.getSettings();
  }
  async newConversation() {
    const worker = this.workers.get(this.parentId);
    if (worker?.task) await this.cancel(worker.task.id);
    else if (worker) await this.retire(worker);
    this.parentId = randomUUID();
    this.sessions.unshift(this.newSession('parent', 'Friday', this.parentId));
    this.silence();
    this.presentation = { text: '', expanded: false, speaking: false };
    await this.persist();
    this.publish();
    return this.parentId;
  }
  submit(prompt: string) {
    const operation = this.submissions
      .catch(() => undefined)
      .then(async () => {
        if (this.shuttingDown) throw new Error('Friday is shutting down.');
        const text = shortText(prompt, 'request');
        const worker = this.workers.get(this.parentId);
        if (worker?.task) await this.cancel(worker.task.id);
        this.silence();
        this.presentation = { text: '', expanded: false, speaking: false };
        return this.turn(this.session(this.parentId), text);
      });
    this.submissions = operation;
    return operation;
  }
  async startChild(title: string, prompt: string) {
    if (this.shuttingDown) throw new Error('Friday is shutting down.');
    if (
      this.sessions.filter((s) => s.role === 'child' && ['running', 'needs_input'].includes(s.status)).length >=
      (this.options.maxChildren ?? 3)
    )
      throw new Error('Three background tasks are already active. Finish or stop one first.');
    const text = shortText(prompt, 'task');
    const session = this.newSession('child', shortText(title, 'title', 100));
    this.sessions.push(session);
    await this.turn(session, text);
    return structuredClone(session);
  }
  async updateChild(id: string, prompt: string) {
    const session = this.childSession(id);
    const text = shortText(prompt, 'instruction');
    if (
      this.sessions.filter((s) => s.id !== id && s.role === 'child' && ['running', 'needs_input'].includes(s.status))
        .length >= (this.options.maxChildren ?? 3)
    )
      throw new Error('Background task limit reached. Finish or stop one first.');
    const worker = this.workers.get(id);
    if (worker?.task) await this.cancel(worker.task.id);
    if (this.shuttingDown) throw new Error('Friday is shutting down.');
    session.parentId = this.parentId;
    return this.turn(session, text);
  }
  async stopChild(id: string) {
    const session = this.childSession(id);
    const worker = this.workers.get(id);
    if (worker?.task) await this.cancel(worker.task.id);
    else if (worker) await this.retire(worker);
    session.status = 'cancelled';
    session.updatedAt = Date.now();
    session.question = undefined;
    await this.persist();
    this.publish();
    return structuredClone(session);
  }
  async readSession(id: string, offset = 0) {
    return {
      session: structuredClone(this.session(id)),
      tasks: this.list()
        .filter((t) => t.conversationId === id)
        .slice(0, 10),
      history: await this.store.history(id, Math.max(0, Math.floor(offset)), 20),
    };
  }
  async searchSessions(query: string) {
    const needle = shortText(query, 'query', 200);
    const results = [];
    for (const session of [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const matches = await this.store.history(session.id, 0, 3, needle);
      const tasks = this.tasks
        .filter(
          (t) =>
            t.conversationId === session.id &&
            `${t.prompt} ${t.response || ''}`.toLocaleLowerCase().includes(needle.toLocaleLowerCase()),
        )
        .slice(0, 3);
      if (
        matches.entries.length ||
        tasks.length ||
        `${session.title} ${session.summary ?? ''}`.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
      )
        results.push({
          session: structuredClone(session),
          matches: matches.entries,
          tasks: tasks.map((t) => ({ prompt: t.prompt, response: t.response?.slice(0, 6000) })),
        });
      if (results.length >= 12) break;
    }
    return results;
  }
  async cancel(id: string, source: 'user' | 'escape' = 'user') {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error('Task not found');
    if (terminal.has(task.status)) return;
    task.status = 'cancelled';
    task.stopReason = source;
    task.approval = undefined;
    this.addStep(task, 'status', source === 'escape' ? 'Stopped with Escape' : 'Stopped by you', 'done');
    const session = this.session(task.conversationId!);
    session.status = session.role === 'parent' ? 'idle' : 'cancelled';
    session.question = undefined;
    const worker = this.workers.get(session.id);
    if (task.role === 'parent') {
      this.bridge.revokeRun?.(id);
      this.silence();
    }
    if (worker?.task === task) {
      this.send(worker, { type: 'abort' });
      await this.retire(worker);
    }
    await this.changed(task);
  }
  async desktopInterrupted(id: string, error: unknown) {
    const worker = this.workers.get(this.parentId);
    if (!worker?.task || worker.task.id !== id || terminal.has(worker.task.status)) return;
    const interruption = desktopInterruption(error);
    if (interruption.user) await this.cancel(id, interruption.source);
    else await this.fail(worker, interruption.message);
  }
  async resolveApproval(id: string, approved: boolean) {
    const worker = this.approvalOwners.get(id);
    const task = worker?.task;
    if (
      !worker ||
      !task ||
      this.workers.get(worker.session.id) !== worker ||
      task.approval?.id !== id ||
      task.status !== 'awaiting_approval'
    )
      throw new Error('This approval is no longer active.');
    this.approvalOwners.delete(id);
    task.approval = undefined;
    task.status = 'acting';
    worker.session.status = 'running';
    worker.session.question = undefined;
    this.send(worker, { type: 'extension_ui_response', id, confirmed: approved });
    await this.changed(task);
  }
  silence() {
    this.speechGeneration++;
    this.options.silence?.();
    this.presentation.speaking = false;
    this.publish();
  }
  controlProgress(id: string, text: string, speech?: string) {
    const worker = this.workers.get(this.parentId);
    const task = worker?.task;
    if (!task || task.id !== id || terminal.has(task.status)) return;
    this.addStep(task, 'status', text, 'done');
    if (speech) {
      const spoken = task.spoken;
      this.speak(task, speech);
      task.spoken = spoken; // Progress is not the final spoken answer.
    }
    this.changedDeferred(task);
  }
  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.silence();
    await Promise.all(
      [...this.workers.values()].map(async (worker) => {
        if (worker.task && !terminal.has(worker.task.status)) {
          worker.task.status = 'failed';
          worker.task.error = 'Interrupted when Friday closed.';
          worker.task.approval = undefined;
          worker.session.status = 'interrupted';
          worker.session.summary = worker.task.error;
          if (worker.session.role === 'parent') this.bridge.revokeRun?.(worker.task.id);
        }
        this.send(worker, { type: 'abort' });
        await this.retire(worker);
      }),
    );
    this.approvalOwners.clear();
    await this.persist();
    this.server.closeAllConnections();
    await new Promise<void>((done) => this.server.close(() => done()));
  }
  private newSession(role: 'parent' | 'child', title: string, id: string = randomUUID()): SessionRecord {
    return {
      id,
      role,
      title,
      ...(role === 'child' ? { parentId: this.parentId } : {}),
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  private session(id: string) {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) throw new Error('Unknown session');
    return session;
  }
  private childSession(id: string) {
    const session = this.session(id);
    if (session.role !== 'child') throw new Error('This operation requires a background child session');
    return session;
  }
  private async turn(session: SessionRecord, prompt: string) {
    if (this.shuttingDown) throw new Error('Friday is shutting down.');
    let worker = this.workers.get(session.id);
    if (worker?.task) throw new Error('This session is still working.');
    if (worker && (worker.cwd !== this.settings.defaultCwd || worker.model !== this.settings.model)) {
      await this.retire(worker);
      worker = undefined;
    }
    const task: TaskRecord = {
      id: randomUUID(),
      conversationId: session.id,
      role: session.role,
      parentId: session.parentId,
      prompt,
      status: 'thinking',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [],
      timings: {},
    };
    this.tasks.unshift(task);
    session.latestTaskId = task.id;
    session.status = 'running';
    session.question = undefined;
    session.updatedAt = Date.now();
    this.addStep(task, 'status', 'Understanding your request', 'running');
    try {
      worker ??= this.launch(session);
      worker.task = task;
      worker.assistantText = '';
      worker.error = undefined;
      worker.toolSteps.clear();
      if (session.role === 'parent') worker.desktopToken = this.bridge.beginRun?.(task.id);
      await this.changed(task);
      const context =
        session.role === 'parent'
          ? `\n\n[Friday task registry; inspect session_read for details]\n${JSON.stringify(
              this.sessions
                .filter((s) => s.role === 'child')
                .slice(-20)
                .map(({ id, title, status, question }) => ({ id, title, status, question })),
            )}`
          : '';
      this.send(worker, { id: randomUUID(), type: 'prompt', message: `${prompt}${context}` });
    } catch (error) {
      if (worker) await this.fail(worker, error instanceof Error ? error.message : String(error));
      else {
        task.status = 'failed';
        task.error = String(error);
        session.status = 'failed';
        await this.changed(task);
      }
    }
    return structuredClone(task);
  }
  private launch(session: SessionRecord) {
    const token = randomBytes(32).toString('hex');
    const child = this.spawnProcess(
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
        this.store.sessionPath(session.id),
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--no-approve',
        '--tools',
        session.role === 'parent' ? parentTools : `${fileTools},task_report`,
        '--extension',
        this.extensionPath,
        '--system-prompt',
        session.role === 'parent' ? parentPrompt : childPrompt,
      ],
      {
        cwd: resolve(this.settings.defaultCwd),
        shell: false,
        env: {
          ...process.env,
          LINUX_BUDDY_RUNTIME_URL: this.runtimeUrl,
          LINUX_BUDDY_RUNTIME_TOKEN: token,
          LINUX_BUDDY_ROLE: session.role,
        },
      },
    ) as ChildProcessWithoutNullStreams;
    const worker: Worker = {
      child,
      session,
      token,
      buffer: '',
      assistantText: '',
      toolSteps: new Map(),
      events: Promise.resolve(),
      cwd: this.settings.defaultCwd,
      model: this.settings.model,
    };
    this.workers.set(session.id, worker);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (value: string) => this.consume(worker, value));
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-3000);
    });
    child.on('error', (error) => void this.fail(worker, error.message));
    child.stdin.on('error', (error) => void this.fail(worker, error.message));
    child.on('close', () => {
      void worker.events.finally(async () => {
        if (this.workers.get(session.id) !== worker) return;
        if (worker.task && !terminal.has(worker.task.status))
          await this.fail(worker, stderr || 'Pi stopped before finishing.');
        else this.workers.delete(session.id);
      });
    });
    return worker;
  }
  private consume(worker: Worker, chunk: string) {
    if (this.workers.get(worker.session.id) !== worker) return;
    worker.buffer += chunk;
    if (worker.buffer.length > 32 * 1024 * 1024) {
      void this.fail(worker, 'Pi returned an oversized event.');
      return;
    }
    let newline: number;
    while ((newline = worker.buffer.indexOf('\n')) !== -1) {
      const line = worker.buffer.slice(0, newline);
      worker.buffer = worker.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as RpcEvent;
        const task = worker.task;
        worker.events = worker.events
          .then(async () => {
            if (
              task &&
              worker.task === task &&
              this.workers.get(worker.session.id) === worker &&
              !terminal.has(task.status)
            )
              await this.event(worker, task, event);
          })
          .catch((error) => this.fail(worker, String(error)));
      } catch {
        /* Ignore non-protocol diagnostics. */
      }
    }
  }
  private async event(worker: Worker, task: TaskRecord, event: RpcEvent) {
    const elapsed = () => Date.now() - task.createdAt;
    task.timings ??= {};
    if (event.type === 'agent_start') {
      worker.error = undefined;
      task.timings.startupMs ??= elapsed();
      task.status = 'thinking';
      await this.changed(task);
    }
    if (event.type === 'message_start' && typeof event.message === 'object' && event.message?.role === 'assistant')
      worker.assistantText = '';
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      task.timings.firstTextMs ??= elapsed();
      worker.assistantText = `${worker.assistantText}${event.assistantMessageEvent.delta ?? ''}`.slice(-200_000);
      task.response = worker.assistantText;
      this.changedDeferred(task);
    }
    if (event.type === 'message_end') {
      const text = messageText(event.message);
      if (text) task.response = worker.assistantText = text;
      if (typeof event.message === 'object' && event.message?.stopReason === 'error')
        worker.error = event.message.errorMessage || 'The model could not finish.';
      await this.changed(task);
    }
    if (event.type === 'tool_execution_start' && event.toolCallId) {
      task.timings.firstModelMs ??= elapsed();
      task.status = 'acting';
      const step = this.addStep(task, 'tool', toolTitle(event.toolName || 'tool'), 'running');
      worker.toolSteps.set(event.toolCallId, step.id);
      await this.changed(task);
    }
    if (event.type === 'tool_execution_end' && event.toolCallId) {
      const step = task.steps.find((item) => item.id === worker.toolSteps.get(event.toolCallId!));
      if (step) {
        step.status = event.success === false || event.isError ? 'failed' : 'done';
        step.durationMs = Date.now() - step.createdAt;
        step.metrics = event.result?.details?.timings;
        if (step.status === 'done' && step.title === 'Using desktop draw') task.timings.firstDrawingMs ??= elapsed();
        if (step.status === 'failed')
          step.detail = event.result?.content
            ?.filter((item) => item.type === 'text')
            .map((item) => item.text || '')
            .join('\n')
            .slice(0, 2000);
      }
      worker.toolSteps.delete(event.toolCallId);
      await this.changed(task);
    }
    if (event.type === 'extension_ui_request' && event.method === 'confirm' && event.id) {
      const id = `${worker.session.id}:${event.id}`;
      task.status = 'awaiting_approval';
      task.approval = {
        id,
        title: event.title || 'Friday needs approval',
        message: typeof event.message === 'string' ? event.message.slice(0, 4000) : 'Allow this action?',
        createdAt: Date.now(),
      };
      worker.session.status = 'needs_input';
      worker.session.question = task.approval.message;
      this.approvalOwners.set(id, worker);
      await this.changed(task);
    }
    if (event.type === 'agent_end') {
      const text = [...(event.messages ?? [])]
        .reverse()
        .map(messageText)
        .find((value) => value.trim());
      if (text) task.response = text;
      // Pi may retry or compact after agent_end; only agent_settled finishes the turn.
    }
    if (event.type === 'agent_settled') {
      if (
        worker.error ||
        (!task.response?.trim() && !task.spoken && !worker.session.question && this.presentation.taskId !== task.id)
      ) {
        await this.fail(worker, worker.error || 'Friday finished without returning an answer.');
        return;
      }
      task.status = 'completed';
      task.timings.totalMs = elapsed();
      task.approval = undefined;
      for (const step of task.steps) if (step.status === 'running') step.status = 'done';
      worker.session.status =
        worker.session.role === 'parent' ? 'idle' : worker.session.question ? 'needs_input' : 'completed';
      worker.session.summary = task.response?.slice(0, 6000) || this.presentation.text;
      if (worker.session.role === 'parent') {
        this.bridge.revokeRun?.(task.id, true);
        worker.desktopToken = undefined;
        if (this.presentation.taskId !== task.id)
          this.presentation = {
            ...this.presentation,
            taskId: task.id,
            text: task.response?.slice(0, 6000) || '',
            expanded: this.presentation.expanded || this.settings.autoSpeak === false,
          };
        if (!task.spoken && this.settings.autoSpeak !== false && task.response)
          this.speak(task, task.response.slice(0, 800), true);
      }
      worker.task = undefined;
      this.clearApprovals(worker);
      await this.changed(task);
      if (worker.session.role === 'child') await this.retire(worker);
    }
    if (event.type === 'response' && event.success === false)
      await this.fail(worker, event.error || 'Pi rejected the request.');
  }
  private speak(task: TaskRecord, text: string, preserveText = false) {
    task.spoken = true;
    this.presentation = {
      ...this.presentation,
      taskId: task.id,
      text: preserveText || this.shownTextTask === task.id ? this.presentation.text : text,
    };
    if (!this.options.speak || this.settings.autoSpeak === false) {
      this.presentation.expanded = true;
      this.publish();
      return;
    }
    const generation = ++this.speechGeneration;
    this.presentation.speaking = true;
    this.publish();
    void this.options
      .speak(text)
      .catch((error) => {
        if (generation === this.speechGeneration) {
          this.addStep(task, 'status', 'Speech unavailable; reply shown as text', 'failed', String(error));
          this.changedDeferred(task);
        }
      })
      .finally(() => {
        if (generation === this.speechGeneration) {
          this.presentation.speaking = false;
          this.publish();
        }
      });
  }
  private async fail(worker: Worker, message: string) {
    if (this.workers.get(worker.session.id) !== worker) return;
    const task = worker.task;
    if (task && !terminal.has(task.status)) {
      task.status = 'failed';
      task.error = /API_KEY|unauthorized|authentication/i.test(message)
        ? 'The model provider is not connected. Check Friday’s credentials.'
        : message.slice(-2000);
      task.approval = undefined;
      worker.session.status = 'failed';
      worker.session.summary = task.error;
      for (const step of task.steps) if (step.status === 'running') step.status = 'failed';
      if (task.role === 'parent') {
        this.bridge.revokeRun?.(task.id);
        this.silence();
      }
    }
    await this.retire(worker);
    if (task) await this.changed(task);
  }
  private async retire(worker: Worker) {
    if (this.workers.get(worker.session.id) === worker) this.workers.delete(worker.session.id);
    this.clearApprovals(worker);
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        worker.child.kill('SIGKILL');
        done();
      }, this.grace);
      worker.child.once('close', () => {
        clearTimeout(timer);
        done();
      });
      worker.child.kill('SIGTERM');
    });
  }
  private clearApprovals(worker: Worker) {
    for (const [id, owner] of this.approvalOwners) if (owner === worker) this.approvalOwners.delete(id);
  }
  private send(worker: Worker, value: Record<string, unknown>) {
    if (value.type === 'extension_ui_response' && typeof value.id === 'string')
      value.id = value.id.slice(worker.session.id.length + 1);
    if (worker.child.stdin.writable && !worker.child.stdin.destroyed)
      worker.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  private addStep(
    task: TaskRecord,
    kind: AgentStep['kind'],
    title: string,
    status: AgentStep['status'],
    detail?: string,
  ) {
    const step: AgentStep = { id: randomUUID(), kind, title, status, detail, createdAt: Date.now() };
    task.steps.push(step);
    return step;
  }
  private publish() {
    this.emit('state', this.state());
  }
  private async changed(task: TaskRecord) {
    task.updatedAt = Date.now();
    this.session(task.conversationId!).updatedAt = task.updatedAt;
    this.emit('task', structuredClone(task));
    this.publish();
    try {
      await this.persist();
    } catch (error) {
      this.emit('store-error', error);
    }
  }
  private changedDeferred(task: TaskRecord) {
    task.updatedAt = Date.now();
    this.emit('task', structuredClone(task));
    if (!this.persistTimer)
      this.persistTimer = setTimeout(() => {
        this.persistTimer = undefined;
        void this.persist().catch((error) => this.emit('store-error', error));
      }, this.options.persistDebounceMs ?? 300);
  }
  private persist() {
    const active = this.tasks.filter((t) => !terminal.has(t.status));
    const done = this.tasks
      .filter((t) => terminal.has(t.status))
      .slice(0, Math.max(0, (this.options.maxHistory ?? 200) - active.length));
    this.tasks = [...active, ...done].sort((a, b) => b.createdAt - a.createdAt);
    return this.store.save(this.tasks, this.settings, this.sessions, this.parentId);
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    const reply = (status: number, data: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    const worker = [...this.workers.values()].find((w) => request.headers.authorization === `Bearer ${w.token}`);
    const task = worker?.task;
    if (!worker || !task || terminal.has(task.status)) return reply(401, { error: 'Session is not active' });
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 128 * 1024) throw new Error('Request too large');
        chunks.push(Buffer.from(chunk));
      }
      const data: Record<string, unknown> = size ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid tool arguments');
      if (worker.task !== task || this.workers.get(worker.session.id) !== worker || terminal.has(task.status))
        throw new Error('Request was interrupted');
      if (request.url?.startsWith('/desktop/')) {
        if (worker.session.role !== 'parent' || !worker.desktopToken)
          throw new Error('Only the parent can use the screen');
        const route = request.url.slice('/desktop'.length);
        if (!['/screenshot', '/draw', '/clear', '/control'].includes(route)) throw new Error('Unknown desktop route');
        const disconnect = new AbortController();
        response.on('close', () => {
          if (!response.writableEnded) disconnect.abort();
        });
        const result = await fetch(`${this.bridge.url}${route}`, {
          method: request.method,
          headers: { authorization: `Bearer ${worker.desktopToken}`, 'content-type': 'application/json' },
          ...(request.method === 'POST' ? { body: JSON.stringify(data) } : {}),
          signal: AbortSignal.any([disconnect.signal, AbortSignal.timeout(route === '/control' ? 330_000 : 90_000)]),
        });
        return reply(result.status, await result.json());
      }
      if (request.method !== 'POST') throw new Error('Expected a tool call');
      if (request.url === '/tools/task_report') {
        if (worker.session.role !== 'child') throw new Error('Only children report task progress');
        if (!['running', 'needs_input'].includes(String(data.status))) throw new Error('Invalid task status');
        worker.session.summary = shortText(data.text, 'progress', 4000);
        if (data.status === 'needs_input') {
          worker.session.question = worker.session.summary;
          worker.session.status = 'needs_input';
        }
        await this.changed(task);
        return reply(200, { saved: true });
      }
      if (worker.session.role !== 'parent') throw new Error('This tool belongs to the parent session');
      let result: unknown;
      switch (request.url) {
        case '/tools/session_start':
          result = await this.startChild(shortText(data.title, 'title', 100), shortText(data.prompt, 'task'));
          break;
        case '/tools/session_list':
          result = this.state().sessions;
          break;
        case '/tools/session_read':
          result = await this.readSession(
            shortText(data.id, 'session ID', 128),
            typeof data.offset === 'number' && Number.isFinite(data.offset) ? data.offset : 0,
          );
          break;
        case '/tools/session_search':
          result = await this.searchSessions(shortText(data.query, 'query', 200));
          break;
        case '/tools/session_update':
          result = await this.updateChild(shortText(data.id, 'session ID', 128), shortText(data.prompt, 'instruction'));
          break;
        case '/tools/session_stop':
          result = await this.stopChild(shortText(data.id, 'session ID', 128));
          break;
        case '/tools/speak': {
          const text = shortText(data.text, 'speech', 800);
          this.speak(task, text);
          result = { started: this.presentation.speaking, text };
          break;
        }
        case '/tools/show_text':
          this.shownTextTask = task.id;
          this.presentation = {
            ...this.presentation,
            taskId: task.id,
            text: shortText(data.text, 'text', 6000),
            expanded: data.expanded !== false,
          };
          this.publish();
          result = { shown: true };
          break;
        case '/tools/set_presentation':
          if (typeof data.expanded !== 'boolean') throw new Error('Expected expanded boolean');
          this.presentation.expanded = data.expanded;
          this.publish();
          result = { expanded: data.expanded };
          break;
        default:
          throw new Error('Unknown Friday tool');
      }
      reply(200, result);
    } catch (error) {
      reply(400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
