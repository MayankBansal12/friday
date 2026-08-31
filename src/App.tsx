import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Archive,
  ArrowRight,
  Check,
  ChevronDown,
  CircleStop,
  Cloud,
  Copy,
  Folder,
  HardDrive,
  History,
  Laptop,
  LoaderCircle,
  Mic,
  MicOff,
  Minus,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import type { BuddySettings, ListeningState, RunStatus, TaskRecord } from '../electron/types';

const activeStatuses = new Set<RunStatus>(['queued', 'thinking', 'acting', 'awaiting_approval']);
const modelOptions = [
  { value: 'kimi-k2.6', label: 'Kimi K2.6' },
  { value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
  { value: 'glm-5.2', label: 'GLM 5.2' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
];
const starterIdeas = [
  'Find the largest files in Downloads',
  'Open my calendar and show today',
  'Tidy screenshots into a new folder',
];

type ProductView = 'now' | 'history';

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatRelativeTime(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp);
}

function statusLabel(status: RunStatus) {
  if (status === 'queued') return 'Queued';
  if (status === 'thinking') return 'Planning';
  if (status === 'acting') return 'Working';
  if (status === 'awaiting_approval') return 'Needs approval';
  if (status === 'completed') return 'Complete';
  if (status === 'cancelled') return 'Stopped';
  return 'Needs attention';
}

function voiceCopy(state: ListeningState, wakeWord: string) {
  if (state === 'listening') {
    return { eyebrow: 'Microphone live', title: `Say “${wakeWord}”`, detail: 'Then tell me what you need.' };
  }
  if (state === 'armed') {
    return { eyebrow: 'Wake word heard', title: 'Go ahead.', detail: 'I’m ready for the task.' };
  }
  if (state === 'transcribing') {
    return { eyebrow: 'On-device speech', title: 'Making sense of that…', detail: 'Canary is transcribing locally.' };
  }
  if (state === 'error') {
    return {
      eyebrow: 'Microphone unavailable',
      title: 'Voice needs attention.',
      detail: 'Check microphone access and try again.',
    };
  }
  return { eyebrow: 'Voice ready', title: 'Start listening', detail: `Then say “${wakeWord}” and a task.` };
}

function FridayMark({ compact = false }: { compact?: boolean }) {
  return (
    <svg className={compact ? 'friday-mark compact' : 'friday-mark'} viewBox="0 0 42 42" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="40" height="40" rx="13" fill="currentColor" />
      <path d="M13 30V12H29" stroke="var(--mark-ink, #1d1f1b)" strokeWidth="3.6" strokeLinecap="round" />
      <path d="M13 21H24" stroke="var(--mark-ink, #1d1f1b)" strokeWidth="3.6" strokeLinecap="round" />
      <circle cx="29" cy="12" r="3.2" fill="var(--mark-pop, #ff6f59)" />
    </svg>
  );
}

function StatusIcon({ status }: { status: RunStatus }) {
  if (status === 'completed') return <Check size={13} />;
  if (status === 'failed') return <X size={13} />;
  if (status === 'cancelled') return <CircleStop size={13} />;
  if (status === 'awaiting_approval') return <ShieldAlert size={13} />;
  return <LoaderCircle className="spin" size={13} />;
}

function VoiceStage({
  state,
  wakeWord,
  voiceLevel,
  heard,
  onToggle,
}: {
  state: ListeningState;
  wakeWord: string;
  voiceLevel: number;
  heard: string;
  onToggle: () => void;
}) {
  const copy = voiceCopy(state, wakeWord);
  const active = state !== 'idle' && state !== 'error';
  const bars = [38, 63, 48, 82, 55, 92, 68, 44, 76, 52, 34];

  return (
    <div className="voice-stage" data-state={state} style={{ '--voice-level': voiceLevel } as React.CSSProperties}>
      <button
        className="voice-card pressable"
        type="button"
        onClick={onToggle}
        aria-label={active ? 'Stop listening' : 'Start listening'}
      >
        <span className="voice-card-top">
          <span className="signal-label">
            <i /> {copy.eyebrow}
          </span>
          <span className="signal-code">FR / 01</span>
        </span>
        <span className="signal-screen" aria-hidden="true">
          <span className="signal-bars">
            {bars.map((height, index) => (
              <i
                key={`${height}-${index}`}
                style={
                  {
                    height: `${height}%`,
                    '--meter-scale': Math.max(0.28, 0.42 + voiceLevel * (0.56 + (index % 3) * 0.18)),
                    '--bar-delay': `${index * -42}ms`,
                  } as React.CSSProperties
                }
              />
            ))}
          </span>
          <span className="signal-centerline" />
        </span>
        <span className="voice-card-copy">
          <strong>{copy.title}</strong>
          <small>{copy.detail}</small>
        </span>
        <span className="voice-control" aria-hidden="true">
          {active ? <MicOff size={17} /> : <Mic size={17} />}
          {active ? 'Stop' : 'Talk to Friday'}
        </span>
      </button>
      {heard && (
        <p className="heard-caption" aria-live="polite">
          <span>Last heard</span> “{heard}”
        </p>
      )}
    </div>
  );
}

function WelcomeView({
  listenState,
  wakeWord,
  voiceLevel,
  heard,
  onToggleVoice,
  onTryIdea,
}: {
  listenState: ListeningState;
  wakeWord: string;
  voiceLevel: number;
  heard: string;
  onToggleVoice: () => void;
  onTryIdea: (value: string) => void;
}) {
  const active = listenState !== 'idle' && listenState !== 'error';

  return (
    <section className="welcome-view">
      <div className="welcome-hero">
        <div className="welcome-copy">
          <p className="eyebrow">
            <span>Linux native</span>
            <span aria-hidden="true">/</span>
            Voice first
          </p>
          <h1>
            Your desktop.
            <br />
            <em>Handled.</em>
          </h1>
          <p className="welcome-lede">
            Ask Friday to navigate apps, work with files, or run terminal tasks while you stay in control.
          </p>
          <button className="hero-action pressable" type="button" onClick={onToggleVoice}>
            <span>{active ? <MicOff size={18} /> : <Mic size={18} />}</span>
            {active ? 'Stop listening' : 'Talk to Friday'}
            <ArrowRight size={17} />
          </button>
        </div>
        <VoiceStage
          state={listenState}
          wakeWord={wakeWord}
          voiceLevel={voiceLevel}
          heard={heard}
          onToggle={onToggleVoice}
        />
      </div>

      <div className="starter-row" aria-label="Example tasks">
        <span className="starter-label">Try a job</span>
        <div className="starter-ideas">
          {starterIdeas.map((idea) => (
            <button type="button" key={idea} onClick={() => onTryIdea(idea)}>
              <span>{idea}</span>
              <ArrowRight size={13} />
            </button>
          ))}
        </div>
      </div>

      <div className="data-route" aria-label="How Friday handles your data">
        <div className="data-node">
          <span className="data-icon local">
            <Laptop size={16} />
          </span>
          <span>
            <strong>Speech stays local</strong>
            <small>Canary transcribes on this computer</small>
          </span>
        </div>
        <ArrowRight className="route-arrow" size={15} aria-hidden="true" />
        <div className="data-node">
          <span className="data-icon cloud">
            <Cloud size={16} />
          </span>
          <span>
            <strong>Agent work uses cloud</strong>
            <small>Your request goes to OpenCode Go</small>
          </span>
        </div>
      </div>
    </section>
  );
}

function TaskView({
  task,
  showActivity,
  onToggleActivity,
  onNewTask,
  onRetry,
  onApprove,
  approvalPending,
}: {
  task: TaskRecord;
  showActivity: boolean;
  onToggleActivity: () => void;
  onNewTask: () => void;
  onRetry: () => void;
  onApprove: (approved: boolean) => void;
  approvalPending: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const active = activeStatuses.has(task.status);
  const currentStep = [...task.steps].reverse().find((step) => step.status === 'running') ?? task.steps.at(-1);

  async function copyResponse() {
    if (!task.response) return;
    await navigator.clipboard.writeText(task.response);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <section className="task-view">
      <header className="task-hero">
        <div className="task-meta">
          <span className={`status-pill ${task.status}`}>
            <StatusIcon status={task.status} /> {statusLabel(task.status)}
          </span>
          <time dateTime={new Date(task.createdAt).toISOString()}>{formatRelativeTime(task.createdAt)}</time>
          <span aria-hidden="true">/</span>
          <span>{task.steps.filter((step) => step.kind === 'tool').length} actions</span>
        </div>
        <div className="task-title-row">
          <h1>{task.prompt}</h1>
          <button className="quiet-button pressable" type="button" onClick={onNewTask}>
            <Plus size={15} /> New
          </button>
        </div>
      </header>

      <article className="answer-card">
        <header className="answer-heading">
          <span>
            <FridayMark compact />
            <span>
              <strong>Friday</strong>
              <small>{active ? 'On the job' : 'Desktop agent'}</small>
            </span>
          </span>
          {task.response && (
            <button className="copy-button pressable" type="button" onClick={() => void copyResponse()}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
        </header>

        {task.response ? (
          <p className="answer-copy">{task.response}</p>
        ) : task.status === 'failed' ? null : (
          <div className="working-state" aria-live="polite">
            <span className="working-signal" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>
              <strong>{task.status === 'awaiting_approval' ? 'Paused for your approval' : 'Working it through'}</strong>
              <small>{currentStep?.title || 'Understanding what needs to happen…'}</small>
            </span>
          </div>
        )}
      </article>

      {task.approval && (
        <section className="approval-card" aria-labelledby="approval-title">
          <div className="approval-topline">
            <span className="approval-icon">
              <ShieldAlert size={18} />
            </span>
            <span className="approval-kicker">Friday is paused</span>
            <span className="approval-tag">Approval required</span>
          </div>
          <h2 id="approval-title">{task.approval.title}</h2>
          <p>{task.approval.message}</p>
          <div className="approval-actions">
            <button
              type="button"
              className="secondary-button pressable"
              disabled={approvalPending}
              onClick={() => onApprove(false)}
            >
              Don’t allow
            </button>
            <button
              type="button"
              className="primary-button pressable"
              disabled={approvalPending}
              onClick={() => onApprove(true)}
            >
              {approvalPending ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}
              Allow once
            </button>
          </div>
        </section>
      )}

      {task.steps.length > 0 && (
        <section className="activity-card">
          <button type="button" className="activity-toggle" onClick={onToggleActivity} aria-expanded={showActivity}>
            <span className="activity-title">
              <span className={`activity-icon ${active ? 'active' : ''}`}>
                {active ? <LoaderCircle className="spin" size={14} /> : <History size={14} />}
              </span>
              <span>
                <strong>Activity</strong>
                <small>{currentStep?.title || `${task.steps.length} updates recorded`}</small>
              </span>
            </span>
            <span className="activity-count">
              {task.steps.length}
              <ChevronDown className={showActivity ? 'rotated' : ''} size={15} />
            </span>
          </button>
          {showActivity && (
            <div className="activity-list">
              {task.steps.map((step) => (
                <div className={`activity-row ${step.status}`} key={step.id}>
                  <span className="activity-rail">
                    {step.status === 'running' ? (
                      <LoaderCircle className="spin" size={12} />
                    ) : step.status === 'failed' ? (
                      <X size={12} />
                    ) : (
                      <Check size={12} />
                    )}
                  </span>
                  <span>
                    <strong>{step.title}</strong>
                    {step.detail && <small>{step.detail}</small>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {task.error && (
        <section className="error-card" role="alert">
          <span className="error-icon">
            <X size={17} />
          </span>
          <div>
            <span className="error-kicker">The task stopped safely</span>
            <h2>Friday couldn’t finish this one.</h2>
            <p>{task.error}</p>
            <div className="error-actions">
              <button className="secondary-button pressable" type="button" onClick={onNewTask}>
                New task
              </button>
              <button className="retry-button pressable" type="button" onClick={onRetry}>
                <RotateCcw size={14} /> Try again
              </button>
            </div>
          </div>
        </section>
      )}

      {task.status === 'cancelled' && (
        <div className="stopped-note">
          <CircleStop size={15} />
          <span>
            <strong>Stopped by you</strong>
            <small>No more actions will run for this task.</small>
          </span>
        </div>
      )}
    </section>
  );
}

function HistoryView({
  tasks,
  onOpenTask,
  onNewTask,
}: {
  tasks: TaskRecord[];
  onOpenTask: (id: string) => void;
  onNewTask: () => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return tasks;
    return tasks.filter((task) => `${task.prompt} ${task.response || ''}`.toLocaleLowerCase().includes(needle));
  }, [query, tasks]);

  return (
    <section className="history-view">
      <header className="history-heading">
        <div>
          <p className="eyebrow">Local task history</p>
          <h1>The archive</h1>
          <p>
            {tasks.length
              ? `${tasks.length} task${tasks.length === 1 ? '' : 's'}, kept on this computer.`
              : 'Your work will collect here.'}
          </p>
        </div>
        <button className="hero-action compact pressable" type="button" onClick={onNewTask}>
          <Plus size={17} /> New task
        </button>
      </header>

      <label className="history-search">
        <Search size={17} />
        <span className="sr-only">Search task history</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tasks and answers…"
        />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
            <X size={14} />
          </button>
        )}
      </label>

      {filtered.length ? (
        <div className="history-list">
          {filtered.map((item) => (
            <button className="history-row" type="button" key={item.id} onClick={() => onOpenTask(item.id)}>
              <span className={`history-status ${item.status}`}>
                <StatusIcon status={item.status} />
              </span>
              <span className="history-row-copy">
                <strong>{item.prompt}</strong>
                <small>{item.response || item.error || item.steps.at(-1)?.title || 'No result recorded yet.'}</small>
              </span>
              <span className="history-row-meta">
                <time dateTime={new Date(item.createdAt).toISOString()}>{formatRelativeTime(item.createdAt)}</time>
                <span>{statusLabel(item.status)}</span>
              </span>
              <ArrowRight className="history-arrow" size={16} />
            </button>
          ))}
        </div>
      ) : (
        <div className="history-empty">
          <span>
            <Archive size={22} />
          </span>
          <h2>{tasks.length ? 'No matching tasks' : 'Nothing in the archive yet'}</h2>
          <p>{tasks.length ? 'Try a different search.' : 'Give Friday a job and its outcome will show up here.'}</p>
        </div>
      )}
    </section>
  );
}

function SettingsDialog({
  settings,
  onChange,
  onSave,
  onClose,
}: {
  settings: BuddySettings;
  onChange: (next: BuddySettings) => void;
  onSave: (next: Partial<BuddySettings>) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const priorFocus = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>('input, select')?.focus());
    return () => {
      cancelAnimationFrame(frame);
      priorFocus?.focus();
    };
  }, []);

  function trapFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button, input, select') ?? [])].filter(
      (element) => !element.hasAttribute('disabled'),
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const customModel = !modelOptions.some((option) => option.value === settings.model);

  return (
    <div className="settings-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        className="settings-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        aria-describedby="settings-description"
        onKeyDown={trapFocus}
      >
        <header className="settings-heading">
          <div>
            <p className="eyebrow">Friday control room</p>
            <h1 id="settings-title">Settings</h1>
            <p id="settings-description">Changes save automatically on this computer.</p>
          </div>
          <button
            className="icon-button settings-close pressable"
            type="button"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X size={18} />
          </button>
        </header>

        <div className="settings-section">
          <div className="settings-section-title">
            <span className="settings-section-icon citron">
              <Mic size={16} />
            </span>
            <span>
              <strong>Voice</strong>
              <small>How Friday knows you’re speaking to it</small>
            </span>
          </div>
          <label className="field-label">
            <span>Wake word</span>
            <input
              value={settings.wakeWord}
              onChange={(event) => onChange({ ...settings, wakeWord: event.target.value })}
              onBlur={(event) => onSave({ wakeWord: event.target.value.trim() || 'Friday' })}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
            />
            <small>Say this before your command. “Friday” is the default.</small>
          </label>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">
            <span className="settings-section-icon warm">
              <Folder size={16} />
            </span>
            <span>
              <strong>Workspace</strong>
              <small>Where new agent tasks begin</small>
            </span>
          </div>
          <label className="field-label">
            <span>Default working folder</span>
            <input
              value={settings.defaultCwd}
              spellCheck={false}
              onChange={(event) => onChange({ ...settings, defaultCwd: event.target.value })}
              onBlur={(event) => onSave({ defaultCwd: event.target.value })}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
            />
            <small>Friday can still work elsewhere when you ask.</small>
          </label>
          <label className="field-label">
            <span>OpenCode Go model</span>
            <select value={settings.model} onChange={(event) => onSave({ model: event.target.value })}>
              {customModel && <option value={settings.model}>{settings.model}</option>}
              {modelOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small>The cloud model used for reasoning and computer work.</small>
          </label>
        </div>

        <div className="settings-section launch-section">
          <label className="switch-row">
            <span className="settings-section-icon blue">
              <Sparkles size={16} />
            </span>
            <span className="switch-copy">
              <strong>Launch at login</strong>
              <small>Keep Friday one shortcut away after you sign in.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.launchAtLogin}
              onChange={(event) => onSave({ launchAtLogin: event.target.checked })}
            />
            <span className="switch-control" aria-hidden="true">
              <i />
            </span>
          </label>
        </div>

        <section className="privacy-card" aria-labelledby="privacy-title">
          <div className="privacy-card-heading">
            <span>
              <ShieldCheck size={17} />
            </span>
            <div>
              <strong id="privacy-title">A clear line around your data</strong>
              <small>No vague “private AI” claims.</small>
            </div>
          </div>
          <div className="privacy-facts">
            <div>
              <Laptop size={15} />
              <span>
                <strong>Audio</strong>
                <small>Transcribed locally with Handy + Canary.</small>
              </span>
            </div>
            <div>
              <Cloud size={15} />
              <span>
                <strong>Requests &amp; vision</strong>
                <small>Commands—and screenshots only when needed—go to your selected OpenCode Go model.</small>
              </span>
            </div>
            <div>
              <HardDrive size={15} />
              <span>
                <strong>History</strong>
                <small>Task records and settings are stored locally by Friday.</small>
              </span>
            </div>
          </div>
        </section>
      </section>
    </div>
  );
}

export default function App() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<ProductView>('now');
  const [settings, setSettings] = useState<BuddySettings>();
  const [prompt, setPrompt] = useState('');
  const [listenState, setListenState] = useState<ListeningState>('idle');
  const [heard, setHeard] = useState('');
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [approvalPending, setApprovalPending] = useState(false);

  const streamRef = useRef<MediaStream | undefined>(undefined);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const audioContextRef = useRef<AudioContext | undefined>(undefined);
  const animationRef = useRef<number | undefined>(undefined);
  const generationRef = useRef(0);
  const beginSegmentRef = useRef<
    ((stream: MediaStream, analyser: AnalyserNode, generation: number) => void) | undefined
  >(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const task = useMemo(() => (selected ? tasks.find((item) => item.id === selected) : undefined), [selected, tasks]);
  const activeTask = useMemo(() => tasks.find((item) => activeStatuses.has(item.status)), [tasks]);
  const wakeWord = settings?.wakeWord || 'Friday';

  const updateListening = useCallback((state: ListeningState) => {
    setListenState(state);
    window.buddy.listening(state);
  }, []);

  const stopListening = useCallback(() => {
    generationRef.current += 1;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close();
    recorderRef.current = undefined;
    streamRef.current = undefined;
    audioContextRef.current = undefined;
    setVoiceLevel(0);
    updateListening('idle');
  }, [updateListening]);

  const runPrompt = useCallback(
    async (value: string) => {
      const cleaned = value.trim();
      if (!cleaned || submitting) return;
      stopListening();
      setSubmitting(true);
      setActionError(undefined);
      try {
        const created = await window.buddy.submit(cleaned);
        setSelected(created.id);
        setView('now');
        setShowActivity(false);
        setPrompt('');
      } catch (error) {
        setPrompt(cleaned);
        setActionError(errorMessage(error, 'Friday could not start that task.'));
      } finally {
        setSubmitting(false);
      }
    },
    [stopListening, submitting],
  );

  const beginSegment = useCallback(
    (stream: MediaStream, analyser: AnalyserNode, generation: number) => {
      if (generation !== generationRef.current || !stream.active) return;
      const chunks: Blob[] = [];
      const supported = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(stream, supported ? { mimeType: supported } : undefined);
      recorderRef.current = recorder;
      let hasSpeech = false;
      let silenceStarted = 0;
      const startedAt = performance.now();
      const samples = new Uint8Array(analyser.fftSize);
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onstop = async () => {
        if (generation !== generationRef.current || !stream.active) return;
        if (!hasSpeech) {
          beginSegmentRef.current?.(stream, analyser, generation);
          return;
        }
        updateListening('transcribing');
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          const result = await window.buddy.transcribe(await blob.arrayBuffer(), blob.type);
          if (generation !== generationRef.current) return;
          if (result.text) setHeard(result.text);
          if (result.command) {
            stopListening();
            await runPrompt(result.command);
            return;
          }
          updateListening(result.wakeDetected ? 'armed' : 'listening');
          beginSegmentRef.current?.(stream, analyser, generation);
        } catch (error) {
          setActionError(errorMessage(error, 'Local speech transcription failed.'));
          updateListening('error');
        }
      };
      recorder.start(250);
      const monitor = () => {
        if (generation !== generationRef.current || recorder.state !== 'recording') return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) {
          const normalized = (value - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / samples.length);
        setVoiceLevel(Math.min(1, rms * 9));
        const now = performance.now();
        if (rms > 0.025) {
          hasSpeech = true;
          silenceStarted = 0;
        } else if (hasSpeech) {
          if (!silenceStarted) silenceStarted = now;
          if (now - silenceStarted > 850) {
            recorder.stop();
            return;
          }
        } else if (now - startedAt > 10_000) {
          recorder.stop();
          return;
        }
        if (now - startedAt > 25_000) {
          recorder.stop();
          return;
        }
        animationRef.current = requestAnimationFrame(monitor);
      };
      animationRef.current = requestAnimationFrame(monitor);
    },
    [runPrompt, stopListening, updateListening],
  );

  useEffect(() => {
    beginSegmentRef.current = beginSegment;
  }, [beginSegment]);

  const startListening = useCallback(async () => {
    if (streamRef.current?.active) return;
    setActionError(undefined);
    setHeard('');
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      if (generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.72;
      context.createMediaStreamSource(stream).connect(analyser);
      streamRef.current = stream;
      audioContextRef.current = context;
      updateListening('listening');
      beginSegment(stream, analyser, generation);
    } catch (error) {
      setActionError(errorMessage(error, 'Allow microphone access to talk to Friday.'));
      updateListening('error');
    }
  }, [beginSegment, updateListening]);

  useEffect(() => {
    let disposed = false;
    void Promise.all([window.buddy.listTasks(), window.buddy.getSettings()])
      .then(([history, config]) => {
        if (disposed) return;
        setTasks(history);
        setSettings(config);
        setSelected(history[0]?.id);
      })
      .catch((error) => setActionError(errorMessage(error, 'Friday could not load.')))
      .finally(() => setLoading(false));
    const removeTask = window.buddy.onTask((next) => {
      setTasks((current) =>
        [next, ...current.filter((item) => item.id !== next.id)].sort((a, b) => b.createdAt - a.createdAt),
      );
      setSelected((current) => current || next.id);
    });
    const removeListen = window.buddy.onListen(() => {
      setView('now');
      void startListening();
    });
    return () => {
      disposed = true;
      removeTask();
      removeListen();
      stopListening();
    };
  }, [startListening, stopListening]);

  useEffect(() => {
    if (!contentRef.current || view !== 'now') return;
    contentRef.current.scrollTop = contentRef.current.scrollHeight;
  }, [task?.response, task?.steps.length, task?.status, view]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${Math.min(input.scrollHeight, 104)}px`;
  }, [prompt]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (showSettings) setShowSettings(false);
        else if (listenState !== 'idle') stopListening();
        else void window.buddy.hide();
        return;
      }
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [listenState, showSettings, stopListening]);

  async function saveSettings(next: Partial<BuddySettings>) {
    if (!settings) return;
    setSettings({ ...settings, ...next });
    try {
      await window.buddy.updateSettings(next);
    } catch (error) {
      setActionError(errorMessage(error, 'Settings could not be saved.'));
    }
  }

  async function resolveApproval(approved: boolean) {
    if (!task?.approval || approvalPending) return;
    setApprovalPending(true);
    setActionError(undefined);
    try {
      await window.buddy.approve(task.approval.id, approved);
    } catch (error) {
      setActionError(errorMessage(error, 'That approval is no longer active.'));
    } finally {
      setApprovalPending(false);
    }
  }

  function newTask() {
    setSelected(undefined);
    setView('now');
    setShowActivity(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function tryIdea(value: string) {
    setPrompt(value);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(value.length, value.length);
    });
  }

  const listeningActive = listenState !== 'idle' && listenState !== 'error';
  const presence = listeningActive
    ? { label: listenState === 'transcribing' ? 'Transcribing' : 'Mic live', tone: 'voice' }
    : activeTask?.status === 'awaiting_approval'
      ? { label: 'Waiting on you', tone: 'approval' }
      : activeTask
        ? { label: 'Working', tone: 'working' }
        : { label: 'Standing by', tone: 'ready' };

  return (
    <main className="shell">
      <section className="friday-window" aria-label="Friday desktop agent">
        <header className="titlebar">
          <button className="brand-button" type="button" onClick={() => setView('now')} aria-label="Open Friday now">
            <FridayMark />
            <span className="brand-copy">
              <strong>friday</strong>
              <small>desktop agent</small>
            </span>
          </button>

          <nav className="view-switcher" aria-label="Friday views">
            <button type="button" className={view === 'now' ? 'active' : ''} onClick={() => setView('now')}>
              <Sparkles size={14} /> <span>Now</span>
            </button>
            <button type="button" className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>
              <Archive size={14} /> <span>Archive</span>
              {tasks.length > 0 && <small>{tasks.length}</small>}
            </button>
          </nav>

          <div className="title-actions">
            <span className={`presence ${presence.tone}`} aria-live="polite">
              <i /> {presence.label}
            </span>
            <button
              className="icon-button pressable"
              type="button"
              aria-label="Open settings"
              title="Settings"
              onClick={() => setShowSettings(true)}
            >
              <Settings size={17} />
            </button>
            <button
              className="icon-button pressable"
              type="button"
              aria-label="Hide Friday"
              title="Hide Friday"
              onClick={() => window.buddy.hide()}
            >
              <Minus size={18} />
            </button>
          </div>
        </header>

        <div className="content-scroll" ref={contentRef}>
          {loading ? (
            <div className="loading-state">
              <FridayMark />
              <span>
                <strong>Friday is getting ready</strong>
                <small>Loading your local workspace…</small>
              </span>
            </div>
          ) : view === 'history' ? (
            <HistoryView
              tasks={tasks}
              onOpenTask={(id) => {
                setSelected(id);
                setView('now');
                setShowActivity(false);
              }}
              onNewTask={newTask}
            />
          ) : task ? (
            <TaskView
              task={task}
              showActivity={showActivity}
              onToggleActivity={() => setShowActivity((value) => !value)}
              onNewTask={newTask}
              onRetry={() => void runPrompt(task.prompt)}
              onApprove={(approved) => void resolveApproval(approved)}
              approvalPending={approvalPending}
            />
          ) : (
            <WelcomeView
              listenState={listenState}
              wakeWord={wakeWord}
              voiceLevel={voiceLevel}
              heard={heard}
              onToggleVoice={() => (listeningActive ? stopListening() : void startListening())}
              onTryIdea={tryIdea}
            />
          )}
        </div>

        {actionError && (
          <div className="error-toast" role="alert">
            <span>
              <ShieldAlert size={15} />
              {actionError}
            </span>
            <button type="button" aria-label="Dismiss message" onClick={() => setActionError(undefined)}>
              <X size={14} />
            </button>
          </div>
        )}

        <footer className="composer-area">
          {listenState !== 'idle' && (
            <div className={`listening-bar ${listenState}`} aria-live="polite">
              <span className="listening-indicator">
                <i />
                {voiceCopy(listenState, wakeWord).eyebrow}
              </span>
              <span>{heard ? `“${heard}”` : voiceCopy(listenState, wakeWord).detail}</span>
            </div>
          )}
          <form
            className="command-bar"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void runPrompt(prompt);
            }}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={prompt}
              aria-label="Ask Friday"
              placeholder={
                view === 'history'
                  ? 'Start a new task…'
                  : activeTask
                    ? 'Give Friday another task…'
                    : 'Ask Friday to do something…'
              }
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button
              className={`mic-button pressable ${listeningActive ? 'active' : ''}`}
              type="button"
              aria-label={listeningActive ? 'Stop listening' : 'Start listening'}
              title={listeningActive ? 'Stop listening' : 'Start listening'}
              onClick={() => (listeningActive ? stopListening() : void startListening())}
            >
              {listeningActive ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            {activeTask && (
              <button
                className="stop-button pressable"
                type="button"
                onClick={() => void window.buddy.cancel(activeTask.id)}
              >
                <CircleStop size={15} /> <span>Stop</span>
              </button>
            )}
            <button
              className="send-button pressable"
              type="submit"
              disabled={!prompt.trim() || submitting}
              aria-label="Send request"
            >
              {submitting ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
            </button>
          </form>
          <div className="composer-meta">
            <span>
              <kbd>Ctrl</kbd>
              <kbd>Shift</kbd>
              <kbd>Space</kbd> to talk
            </span>
            <span>
              Local voice <i aria-hidden="true" /> Cloud agent
            </span>
          </div>
        </footer>

        {showSettings && settings && (
          <SettingsDialog
            settings={settings}
            onChange={setSettings}
            onSave={(next) => void saveSettings(next)}
            onClose={() => setShowSettings(false)}
          />
        )}
      </section>
    </main>
  );
}
