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
  ArrowUp,
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
  Minimize2,
  Plus,
  RotateCcw,
  Search,
  Scan,
  Volume2,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import {
  activeStatuses,
  type BuddySettings,
  type FridayState,
  type ListeningState,
  type RunStatus,
  type RequestContext,
  type TaskRecord,
  type VoiceGate,
} from '../electron/types';
import { openCodeGoModelOptions } from './model-options';
import { desktopErrorMessage, type DesktopStatus } from '../electron/desktop-status';
import { PcmCapture, type FrameCapture } from './pcm-capture';
import { LiveKitLink } from './livekit-link';
import { NoiseFloor, ProgressiveTranscription } from './progressive-transcription';
import { VoiceFollowUp } from './voice-follow-up';
import { detectWakeCommand, fromWakeWord } from '../electron/wake-command';
import { FridayPresence } from './FridayPresence';
import { Conversation } from './Conversation';
import { FridayMascot, type FridayMood } from './FridayMascot';
import { fridayMood } from './friday-mood';
import { isEcho, shouldBargeIn } from './echo-guard';
import { continuation, ignoredFinal, needsTurnGate, type VoiceSubmission } from './voice-turns';

/** How long the user's submitted words stay in the notch. */
const transcriptMs = 3000;
/** Friday's voice can still be in the room this long after playback reports it ended. */
const playbackTailMs = 300;
/** Share of a partial's words that must follow Friday's wording to be held back as echo. */
const bargeInEchoSimilarity = 0.5;
/** 100 ms of 16 kHz audio per local wake word check (matches the main-process spotter). */
const wakeChunkSamples = 1600;
/** Audio kept before a wake so the detector's ~0.5 s delay never clips the phrase: 2 s. */
const wakeReplayFrames = 100;
/** A wake with no speech after it lapses back to local listening. */
const wakeSilenceMs = 3000;

const starterIdeas = [
  'Look at my screen and explain what I am seeing',
  'Circle the main action in the current app',
  'Show me where to click with an arrow',
];

type ProductView = 'now' | 'history' | 'detail';

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? desktopErrorMessage(error) : fallback;
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
  if (status === 'thinking') return 'Planning';
  if (status === 'acting') return 'Working';
  if (status === 'awaiting_approval') return 'Needs approval';
  if (status === 'completed') return 'Complete';
  if (status === 'cancelled') return 'Stopped';
  return 'Needs attention';
}

function voiceCopy(state: ListeningState, wakeWord: string) {
  if (state === 'paused')
    return {
      eyebrow: 'Microphone paused',
      title: 'Voice is paused.',
      detail: 'Friday will listen again when you’re done.',
    };
  if (state === 'starting')
    return { eyebrow: 'Opening microphone…', title: 'One moment…', detail: 'Getting ready to listen.' };
  if (state === 'listening') {
    return {
      eyebrow: 'Microphone on',
      title: `Say “Hey ${wakeWord}”.`,
      detail: `Try “Hey ${wakeWord}, open my calendar.”`,
    };
  }
  if (state === 'armed') {
    return { eyebrow: 'Go ahead…', title: 'Go ahead.', detail: 'I’m ready for the task.' };
  }
  if (state === 'transcribing') {
    return { eyebrow: 'One moment…', title: 'Making sense of that…', detail: 'Making sense of that…' };
  }
  if (state === 'error') {
    return {
      eyebrow: 'Microphone unavailable',
      title: 'Voice needs attention.',
      detail: 'Check microphone access and try again.',
    };
  }
  return {
    eyebrow: 'Voice ready',
    title: 'Start listening',
    detail: `Then say “Hey ${wakeWord}” before your request.`,
  };
}

function FridayMark({ compact = false, mood = 'idle' }: { compact?: boolean; mood?: FridayMood }) {
  return <FridayMascot mood={mood} className={compact ? 'friday-mark compact' : 'friday-mark'} />;
}

function StatusIcon({ status }: { status: RunStatus }) {
  if (status === 'completed') return <Check size={13} />;
  if (status === 'failed') return <X size={13} />;
  if (status === 'cancelled') return <CircleStop size={13} />;
  if (status === 'awaiting_approval') return <ShieldAlert size={13} />;
  return <LoaderCircle className="spin" size={13} />;
}

function WelcomeView({ onTryIdea }: { onTryIdea: (value: string) => void }) {
  return (
    <section className="welcome-simple">
      <FridayMark />
      <h1>What can I help with?</h1>
      <p>Ask a question, explore an idea, or tell me what you’d like done.</p>
      <div className="starter-ideas" aria-label="Example requests">
        {starterIdeas.map((idea) => (
          <button type="button" key={idea} onClick={() => onTryIdea(idea)}>
            <span>{idea}</span>
            <ArrowRight size={13} />
          </button>
        ))}
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
  speaking,
  replayDisabledReason,
  onSpeak,
}: {
  task: TaskRecord;
  showActivity: boolean;
  onToggleActivity: () => void;
  onNewTask: () => void;
  onRetry: () => void;
  onApprove: (approved: boolean) => void;
  approvalPending: boolean;
  speaking: boolean;
  replayDisabledReason?: string;
  onSpeak: () => void;
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
            <div className="answer-actions">
              <button
                className="copy-button pressable"
                type="button"
                onClick={onSpeak}
                disabled={!speaking && (!task.speechText || Boolean(replayDisabledReason))}
                aria-label={speaking ? 'Stop speaking' : 'Read short reply'}
                title={
                  speaking
                    ? 'Stop speaking'
                    : replayDisabledReason ||
                      (task.speechText ? 'Read short reply' : 'This reply is available on screen')
                }
              >
                {speaking ? <CircleStop size={14} /> : <Volume2 size={14} />}
              </button>
              <button className="copy-button pressable" type="button" onClick={() => void copyResponse()}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
        </header>

        {task.speechIssue && <p className="answer-copy">{task.speechIssue}</p>}
        {task.response ? (
          <p className="answer-copy">{task.response}</p>
        ) : task.status === 'failed' || task.status === 'cancelled' ? null : (
          <div className="working-state" aria-live="polite">
            <span className="working-signal" aria-hidden="true">
              <FridayMascot mood={task.status === 'awaiting_approval' ? 'worried' : 'thinking'} />
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
              {task.timings && (
                <p className="timing-summary">
                  {Object.entries(task.timings)
                    .map(
                      ([name, ms]) =>
                        `${({ startupMs: 'Agent startup', firstModelMs: 'First model action', firstTextMs: 'First words', firstDrawingMs: 'First drawing', totalMs: 'Total' } as Record<string, string>)[name] || name}: ${(ms / 1000).toFixed(1)}s`,
                    )
                    .join(' · ')}
                </p>
              )}
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
                    {step.durationMs !== undefined && (
                      <small>
                        {(step.durationMs / 1000).toFixed(2)}s
                        {step.metrics
                          ? ` · Capture ${step.metrics.captureMs}ms · Image prep ${step.metrics.imageProcessingMs}ms · ${Math.round(step.metrics.outputBytes / 1024)}KB`
                          : ''}
                      </small>
                    )}
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
            <strong>
              {task.stopReason === 'user'
                ? 'Stopped by you'
                : task.stopReason === 'escape'
                  ? 'Stopped with Escape'
                  : 'Task stopped'}
            </strong>
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
            <small>Friday listens for this before accepting a voice command.</small>
          </label>
          <label className="setting-toggle">
            <span>
              <strong>Read replies aloud</strong>
              <small>Speak replies to voice requests. You can talk over Friday to interrupt.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.autoSpeak === true}
              onChange={(event) => onSave({ autoSpeak: event.target.checked })}
            />
          </label>
          <label className="setting-toggle">
            <span>
              <strong>Speak replies to typed requests</strong>
              <small>Typed requests are answered on screen unless this is on.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.speakTypedReplies === true}
              disabled={settings.autoSpeak !== true}
              onChange={(event) => onSave({ speakTypedReplies: event.target.checked })}
            />
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
            <span>OpenCode Go model ID</span>
            <input
              list="opencode-models"
              value={settings.model}
              spellCheck={false}
              placeholder="provider/model"
              onChange={(event) => onChange({ ...settings, model: event.target.value })}
              onBlur={(event) => onSave({ model: event.target.value })}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
            />
            <datalist id="opencode-models">
              {openCodeGoModelOptions.map((option) => (
                <option value={option.value} label={option.label} key={option.value} />
              ))}
            </datalist>
            <small>Any valid model ID accepted by your OpenCode Go account.</small>
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
                <small>Speech is transcribed on your computer.</small>
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
  const [friday, setFriday] = useState<FridayState>();
  const [selected, setSelected] = useState<string>();
  const [foregroundTaskId, setForegroundTaskId] = useState<string>();
  const [view, setView] = useState<ProductView>('now');
  const [expanded, setExpanded] = useState(false);
  const [closingWorkspace, setClosingWorkspace] = useState(false);
  const closeWorkspace = useCallback(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      void window.buddy.setExpanded(false);
    } else setClosingWorkspace(true);
  }, []);
  useEffect(() => {
    if (!closingWorkspace) return;
    const timer = setTimeout(() => {
      void window.buddy.setExpanded(false).catch(() => setClosingWorkspace(false));
    }, 160);
    return () => clearTimeout(timer);
  }, [closingWorkspace]);
  const [settings, setSettings] = useState<BuddySettings>();
  const [prompt, setPrompt] = useState('');
  const [listenState, setListenState] = useState<ListeningState>('idle');
  const [heard, setHeard] = useState('');
  // Heard while Friday was busy and judged not meant for it; shown dimmed, never submitted.
  const [ignoredHeard, setIgnoredHeard] = useState('');
  const ignoredRef = useRef<{ text: string; at: number; childId?: string }>(undefined);
  // The user's own words in the notch: live while they speak, then briefly after submission.
  const [transcript, setTranscript] = useState<{ text: string; final: boolean }>();
  const transcriptTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [micEnabled, setMicEnabled] = useState(false);
  const micEnabledRef = useRef(false);
  const [typing, setTyping] = useState(false);
  const typingRef = useRef(false);
  const typingTransitionRef = useRef<((value: boolean) => void) | undefined>(undefined);
  const changeTyping = useCallback((value: boolean) => {
    if (typingRef.current === value) return;
    typingRef.current = value;
    setTyping(value);
    typingTransitionRef.current?.(value);
  }, []);
  const [showSettings, setShowSettings] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [approvalPending, setApprovalPending] = useState(false);
  const [notchDrag, setNotchDrag] = useState<{ x: number; y: number }>();

  const persistedSettingsRef = useRef<BuddySettings | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const captureRef = useRef<FrameCapture | undefined>(undefined);
  const liveKitRef = useRef<LiveKitLink | undefined>(undefined);
  const transcriptionRef = useRef<ProgressiveTranscription | undefined>(undefined);
  const generationRef = useRef(0);
  const beginSegmentRef = useRef<
    ((stream: MediaStream, capture: FrameCapture, generation: number) => void) | undefined
  >(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [desktopState, setDesktopState] = useState<DesktopStatus>();
  const [checkingDesktop, setCheckingDesktop] = useState(true);
  const [marking, setMarking] = useState(false);
  const [marked, setMarked] = useState(false);
  const directVoiceRef = useRef(false);
  const [directVoice, setDirectVoice] = useState(false);
  const pttHeldRef = useRef(false);
  const [speaking, setSpeaking] = useState(false);
  const speakingRef = useRef(false);
  const speakingEndedAtRef = useRef<number | undefined>(undefined);
  // An acknowledgement clip ("Hmm, okay") is playing: audio for the echo guard, not an answer.
  const [acknowledging, setAcknowledging] = useState(false);
  // Room noise learned across segments, so each new segment starts calibrated.
  const noiseFloorRef = useRef(new NoiseFloor());
  const voiceGateRef = useRef<VoiceGate>({ localWake: false, partials: true });
  const lastVoiceRef = useRef<VoiceSubmission | undefined>(undefined);
  const taskStatusRef = useRef(new Map<string, string>());
  const childRequestRef = useRef(new Map<string, string>());
  const [reportedChildren, setReportedChildren] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem('friday.reportedChildren') || '{}');
    } catch {
      return {};
    }
  });
  useEffect(() => {
    localStorage.setItem('friday.reportedChildren', JSON.stringify(reportedChildren));
  }, [reportedChildren]);
  // What Friday is saying or just said, for dropping its own voice from the microphone.
  const echoRef = useRef<FridayState['presentation']['echo']>(undefined);
  // Thinking, submitting, or speaking: listening continues, but the idle timeout is held.
  const busyRef = useRef(false);
  const activePromptRef = useRef<string>(undefined);
  const [replayPending, setReplayPending] = useState(false);
  const replayGenerationRef = useRef(0);
  const [guiding, setGuiding] = useState(false);
  const [controlling, setControlling] = useState(false);
  const interruptOnlyRef = useRef(false);
  const requestEpochRef = useRef(0);
  const stoppingRef = useRef(false);
  const voiceFollowUpRef = useRef(new VoiceFollowUp());
  const submittingRef = useRef(false);
  const conversationOpenRef = useRef(false);
  const followUpPendingRef = useRef(false);
  const followUpEngagedRef = useRef(true);
  const startListeningRef = useRef<
    ((direct?: boolean, engaged?: boolean, interrupt?: boolean) => Promise<void>) | undefined
  >(undefined);
  const [selectedChildId, setSelectedChildId] = useState<string>();
  const selectedChildRef = useRef<string | undefined>(undefined);
  const selectChild = useCallback((id?: string) => {
    selectedChildRef.current = id;
    setSelectedChildId(id);
  }, []);

  const task = useMemo(() => (selected ? tasks.find((item) => item.id === selected) : undefined), [selected, tasks]);
  const activeTask = useMemo(
    () => tasks.find((item) => item.role !== 'child' && activeStatuses.has(item.status)),
    [tasks],
  );
  const wakeWord = settings?.wakeWord || 'Friday';
  // Friday is voicing an answer; a playing acknowledgement clip does not count.
  const answering = speaking && !acknowledging;

  const showTranscript = useCallback((next?: { text: string; final: boolean }) => {
    if (transcriptTimerRef.current) clearTimeout(transcriptTimerRef.current);
    transcriptTimerRef.current = undefined;
    setTranscript(next);
    if (next?.final)
      transcriptTimerRef.current = setTimeout(() => {
        transcriptTimerRef.current = undefined;
        setTranscript(undefined);
      }, transcriptMs);
  }, []);
  /** Drops live words that turned out not to be a request, keeping a submitted transcript. */
  const dropPartialTranscript = useCallback(() => {
    setTranscript((current) => (current?.final ? current : undefined));
  }, []);
  useEffect(
    () => () => {
      if (transcriptTimerRef.current) clearTimeout(transcriptTimerRef.current);
    },
    [],
  );

  const listeningRef = useRef<ListeningState>('idle');
  const updateListening = useCallback((state: ListeningState) => {
    if (listeningRef.current === state) return;
    listeningRef.current = state;
    setListenState(state);
    window.buddy.listening(state);
  }, []);

  const stopCapture = useCallback((release = true) => {
    generationRef.current += 1;
    transcriptionRef.current?.close();
    transcriptionRef.current = undefined;
    captureRef.current?.pause();
    if (release) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      captureRef.current?.close();
      // Also fence a microphone publication still waiting for the startup room join.
      void liveKitRef.current?.release();
      streamRef.current = undefined;
      captureRef.current = undefined;
    }
    setVoiceLevel(0);
  }, []);

  const stopListening = useCallback(() => {
    micEnabledRef.current = false;
    setMicEnabled(false);
    voiceFollowUpRef.current.cancel();
    followUpPendingRef.current = false;
    conversationOpenRef.current = false;
    selectChild();
    void window.buddy.silence();
    setSpeaking(false);
    showTranscript();
    lastVoiceRef.current = undefined;
    stopCapture();
    updateListening('idle');
  }, [updateListening, selectChild, stopCapture, showTranscript]);

  const disableMicrophone = useCallback(() => {
    micEnabledRef.current = false;
    setMicEnabled(false);
    voiceFollowUpRef.current.cancel();
    followUpPendingRef.current = false;
    conversationOpenRef.current = false;
    showTranscript();
    lastVoiceRef.current = undefined;
    stopCapture();
    updateListening('idle');
  }, [stopCapture, updateListening, showTranscript]);

  // Text interactions also expire when audio is explicitly off. Editing and active
  // work hold this timer; panel expansion is deliberately independent of it.
  useEffect(() => {
    if (!selectedChildId || typing || activeTask || speaking || submitting || listenState !== 'idle') return;
    const timer = setTimeout(() => selectChild(), 10_000);
    return () => clearTimeout(timer);
  }, [selectedChildId, typing, activeTask, speaking, submitting, listenState, selectChild]);

  const runPrompt = useCallback(
    async (value: string, resumeVoice = false, context?: RequestContext) => {
      const cleaned = value.trim();
      if (!cleaned || submittingRef.current) return;
      const childId = context ? context.selectedChildId : selectedChildRef.current;
      const resumeMic = micEnabledRef.current;
      voiceFollowUpRef.current.cancel();
      followUpPendingRef.current = false;
      // A voice request keeps the conversation engaged, so the user can correct or
      // interrupt Friday while it works or speaks. A typed request returns to wake gating.
      conversationOpenRef.current = resumeVoice;
      interruptOnlyRef.current = typingRef.current;
      updateListening(resumeMic ? (typingRef.current ? 'paused' : resumeVoice ? 'armed' : 'listening') : 'idle');
      // The host silences the current reply only after validating this submission.
      followUpEngagedRef.current = resumeVoice;
      if (resumeMic) voiceFollowUpRef.current.beginSubmission();
      submittingRef.current = true;
      setSubmitting(true);
      setActionError(undefined);
      // PTT flush ends its capture segment. Start an ordinary endpointed segment
      // so an addressed Stop still works while that request runs or speaks.
      stopCapture(false);
      directVoiceRef.current = false;
      setDirectVoice(false);
      if (resumeMic && streamRef.current?.active && captureRef.current)
        beginSegmentRef.current?.(streamRef.current, captureRef.current, generationRef.current);
      const epoch = requestEpochRef.current;
      try {
        const created = await window.buddy.submit(cleaned, {
          selectedChildId: childId,
          source: resumeVoice ? 'voice' : 'typed',
        });
        if (epoch !== requestEpochRef.current) return;
        if (childId) childRequestRef.current.set(created.id, childId);
        if (resumeVoice && lastVoiceRef.current?.text === cleaned) lastVoiceRef.current.taskId = created.id;
        if (resumeMic) voiceFollowUpRef.current.submitted(created.id);
        setSelected(created.id);
        setMarked(false);
        setView('now');
        setShowActivity(false);
        if (!resumeVoice) setPrompt((draft) => (draft.trim() === cleaned ? '' : draft));
      } catch (error) {
        if (epoch !== requestEpochRef.current) return;
        voiceFollowUpRef.current.cancel();
        if (resumeMic && micEnabledRef.current) void startListeningRef.current?.(false, true);
        if (!resumeVoice) setPrompt((draft) => draft || cleaned);
        setActionError(
          error instanceof Error && /Unknown session|background child/.test(error.message)
            ? 'That task is no longer available. Choose another task.'
            : 'Friday couldn’t start that request. Please try again.',
        );
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [stopCapture, updateListening],
  );

  const beginSegment = useCallback(
    (stream: MediaStream, capture: FrameCapture, generation: number) => {
      if (generation !== generationRef.current || !stream.active) return;
      let spokenChildId = selectedChildRef.current;
      let waitingSince = performance.now();
      // Wall clock, comparable with the host's echo timestamps.
      let speechStartedAt = Date.now();
      let startedDuringPlayback = false;
      let bargedIn = false;
      const gate = voiceGateRef.current;
      // Local wake gating: until "Hey Friday" is heard, audio goes only to the on-device
      // detector plus a short replay buffer, and nothing is transcribed.
      let woken = false;
      let wokenAt = 0;
      let replay: Int16Array[] = [];
      let wakeChunk = new Int16Array(wakeChunkSamples);
      let wakeFilled = 0;
      // Friday's voice (or its acoustic tail) may be in the microphone right now.
      const playback = () =>
        speakingRef.current ||
        (speakingEndedAtRef.current !== undefined && Date.now() - speakingEndedAtRef.current < playbackTailMs);
      const currentWakeWord = () => persistedSettingsRef.current?.wakeWord || wakeWord;
      const echoCheck = (text: string, startedAt: number) => ({
        text,
        speechStartedAt: startedAt,
        now: Date.now(),
        wakeWord: currentWakeWord(),
        speakingEndedAt: speakingRef.current ? undefined : speakingEndedAtRef.current,
      });
      const failed = () => {
        if (generation !== generationRef.current) return;
        stopCapture();
        micEnabledRef.current = false;
        setMicEnabled(false);
        setActionError('I couldn’t hear that. Please tap the microphone to try again.');
        updateListening('error');
      };
      const transcription = new ProgressiveTranscription({
        direct: directVoiceRef.current,
        partials: gate.partials,
        floor: noiseFloorRef.current,
        playback,
        decode: (request) => window.buddy.transcribePcm(request),
        speechStart: () => {
          spokenChildId = selectedChildRef.current;
          speechStartedAt = Date.now();
          startedDuringPlayback = playback();
          bargedIn = false;
        },
        partial: (text) => {
          if (generation !== generationRef.current) return;
          if (interruptOnlyRef.current || typingRef.current || stoppingRef.current) return;
          const engaged = conversationOpenRef.current || directVoiceRef.current;
          const addressed = detectWakeCommand(text, currentWakeWord(), false).result.wakeDetected;
          // Barge-in: stop Friday's voice as soon as the user is clearly talking over it.
          // The final transcript then replaces the unfinished request. Partials of leaked
          // playback are often half-mangled, so a looser echo match holds them back.
          if (
            !bargedIn &&
            speakingRef.current &&
            !isEcho(echoRef.current, echoCheck(text, speechStartedAt), bargeInEchoSimilarity) &&
            shouldBargeIn(text, engaged, addressed)
          ) {
            bargedIn = true;
            void window.buddy.interrupt();
          }
          // Live words only while nothing Friday says could be mistaken for them.
          if ((engaged || addressed) && (bargedIn || !startedDuringPlayback)) showTranscript({ text, final: false });
        },
        endpoint: () => {
          if (!interruptOnlyRef.current && (conversationOpenRef.current || directVoiceRef.current))
            updateListening('transcribing');
        },
        endpointRevoked: () => {
          if (generation !== generationRef.current || !micEnabledRef.current || typingRef.current) return;
          updateListening(
            interruptOnlyRef.current
              ? 'paused'
              : conversationOpenRef.current || directVoiceRef.current
                ? 'armed'
                : 'listening',
          );
        },
        error: (_error, requireRestart) => {
          if (generation !== generationRef.current) return;
          woken = false;
          if (requireRestart) {
            // Ambient sound is not an engaged request. The capped controller is
            // already closed, so drop its hypotheses and start a fresh segment
            // on the existing capture graph. Never reactivate disabled audio.
            if (interruptOnlyRef.current || (!conversationOpenRef.current && !directVoiceRef.current)) {
              if (micEnabledRef.current && stream.active) beginSegmentRef.current?.(stream, capture, generation);
              return;
            }
            failed();
            setActionError('That request was too long. Tap the microphone and try a shorter request.');
            return;
          }
          if (!interruptOnlyRef.current && (conversationOpenRef.current || directVoiceRef.current))
            setActionError('I couldn’t hear that. Please try again.');
          if (directVoiceRef.current) {
            stopListening();
            return;
          }
          updateListening(interruptOnlyRef.current ? 'paused' : conversationOpenRef.current ? 'armed' : 'listening');
          beginSegmentRef.current?.(stream, capture, generation);
        },
        final: (heardText) => {
          if (generation !== generationRef.current) return;
          waitingSince = performance.now();
          const heardWake = woken;
          woken = false;
          // The replay buffer may begin with unrelated words; a transcript without the wake
          // phrase means the detector fired on something else.
          const text = heardWake ? (fromWakeWord(heardText, currentWakeWord()) ?? '') : heardText;
          const echo = isEcho(echoRef.current, echoCheck(text, speechStartedAt));
          // While typing or stopping, speech is ignored. During work and playback, listening
          // stays live: Friday's own voice is dropped as echo, and a new request replaces the
          // unfinished one. Friday decides from the request itself whether to stop its work.
          if (typingRef.current || stoppingRef.current) return;
          // After a typed request, only speech addressed to Friday is a request.
          if (
            interruptOnlyRef.current &&
            (echo || !detectWakeCommand(text, currentWakeWord(), false).result.wakeDetected)
          )
            return;
          const resume = () => {
            dropPartialTranscript();
            if (directVoiceRef.current) stopListening();
            else updateListening(conversationOpenRef.current ? 'armed' : 'listening');
          };
          if (echo) {
            resume();
            return;
          }
          const wake = detectWakeCommand(text, currentWakeWord(), false).result;
          const wasEngaged = conversationOpenRef.current || directVoiceRef.current;
          // A hesitation, or a lone "yeah" while Friday talks, must not replace the request.
          if (
            ignoredFinal({
              text,
              addressed: wake.wakeDetected,
              duringPlayback: startedDuringPlayback && !directVoiceRef.current,
            })
          ) {
            resume();
            return;
          }
          if (text && (wasEngaged || wake.wakeDetected)) setHeard(text);
          if (wake.wakeDetected) {
            selectChild();
            conversationOpenRef.current = true;
          }
          let command = wake.wakeDetected ? wake.command : wasEngaged ? text : undefined;
          if (command) {
            // The user paused mid-request and kept going before Friday did anything:
            // resubmit the whole request instead of replacing it with its second half.
            const previous = lastVoiceRef.current;
            const merged = continuation(
              previous,
              { text: command, speechStartedAt, addressed: wake.wakeDetected },
              previous?.taskId ? taskStatusRef.current.get(previous.taskId) : undefined,
            );
            command = merged ?? command.trim();
            const childId = merged ? previous?.childId : wake.wakeDetected ? undefined : spokenChildId;
            const submit = (request: string) => {
              lastVoiceRef.current = { text: request, at: Date.now(), childId };
              showTranscript({ text: request, final: true });
              void runPrompt(request, true, { selectedChildId: childId });
            };
            // Unaddressed speech while Friday works or talks may be someone else, media or
            // filler. A decision model judges it before it can cancel the current turn; a
            // correction ("no, wait…") or repeating ignored speech skips the round trip.
            if (
              !needsTurnGate({
                text: command,
                addressed: wake.wakeDetected,
                continued: Boolean(merged),
                direct: directVoiceRef.current,
                busy: busyRef.current,
                ignored: ignoredRef.current,
                now: Date.now(),
              })
            ) {
              ignoredRef.current = undefined;
              submit(command);
              return;
            }
            const request = command;
            void window.buddy
              .turnGate({
                heard: request,
                task: activePromptRef.current,
                speaking: speakingRef.current,
                lastSaid: echoRef.current?.at(-1)?.text,
              })
              .catch(() => undefined)
              .then((decision) => {
                if (generation !== generationRef.current || typingRef.current || stoppingRef.current) return;
                if (decision && !decision.interrupt) {
                  ignoredRef.current = { text: request, at: Date.now(), childId };
                  setIgnoredHeard(request);
                  resume();
                } else submit(request);
              });
            return;
          }
          dropPartialTranscript();
          if (directVoiceRef.current) {
            stopListening();
            return;
          }
          updateListening(interruptOnlyRef.current ? 'paused' : conversationOpenRef.current ? 'armed' : 'listening');
        },
      });
      transcriptionRef.current = transcription;
      capture.start((frame) => {
        if (generation !== generationRef.current) return;
        let sum = 0;
        for (const value of frame) sum += (value / 32768) ** 2;
        setVoiceLevel(Math.min(1, Math.sqrt(sum / frame.length) * 9));
        if (voiceGateRef.current.localWake && (typingRef.current || stoppingRef.current)) return;
        const gated =
          voiceGateRef.current.localWake &&
          !woken &&
          !transcription.hasSpeech &&
          !directVoiceRef.current &&
          !conversationOpenRef.current;
        if (gated) {
          noiseFloorRef.current.add(sum / frame.length, true);
          replay.push(frame.slice());
          if (replay.length > wakeReplayFrames) replay.shift();
          wakeChunk.set(frame, wakeFilled);
          wakeFilled += frame.length;
          if (wakeFilled < wakeChunkSamples) return;
          const chunk = wakeChunk;
          wakeChunk = new Int16Array(wakeChunkSamples);
          wakeFilled = 0;
          void window.buddy.feedWakeWord(chunk.buffer).then(
            (detected) => {
              if (
                !detected ||
                woken ||
                generation !== generationRef.current ||
                transcriptionRef.current !== transcription
              )
                return;
              woken = true;
              wokenAt = performance.now();
              // Replay the wake phrase and whatever followed it while the detector decided.
              const frames = replay;
              replay = [];
              for (const item of frames) transcription.push(item);
              if (!conversationOpenRef.current && !typingRef.current) updateListening('armed');
            },
            () => undefined,
          );
          return;
        }
        // A wake that never turned into speech (a knock, a cough) returns to local gating.
        if (woken && !transcription.hasSpeech && performance.now() - wokenAt > wakeSilenceMs) {
          woken = false;
          updateListening(interruptOnlyRef.current ? 'paused' : 'listening');
          return;
        }
        transcription.push(frame);
        if (transcription.hasSpeech || directVoiceRef.current || interruptOnlyRef.current || stoppingRef.current)
          return;
        const now = performance.now();
        if (typingRef.current || busyRef.current) waitingSince = now;
        if (
          (conversationOpenRef.current || selectedChildRef.current) &&
          !typingRef.current &&
          now - waitingSince > 10_000
        ) {
          waitingSince = now;
          conversationOpenRef.current = false;
          selectChild();
          setHeard('');
          updateListening('listening');
        }
      }, failed);
      if (directVoiceRef.current && !pttHeldRef.current) capture.flush(() => transcription.finish());
    },
    [
      runPrompt,
      stopListening,
      stopCapture,
      updateListening,
      selectChild,
      wakeWord,
      showTranscript,
      dropPartialTranscript,
    ],
  );

  useEffect(() => {
    beginSegmentRef.current = beginSegment;
  }, [beginSegment]);

  // Friday's voice and the microphone travel over LiveKit when main has it configured.
  useEffect(() => {
    if (!window.buddy.livekit) return;
    const link = new LiveKitLink();
    liveKitRef.current = link;
    void link.start();
    return () => {
      if (liveKitRef.current === link) liveKitRef.current = undefined;
      link.close();
    };
  }, []);

  const startListening = useCallback(
    async (direct = false, engaged = false, interrupt = false) => {
      micEnabledRef.current = true;
      setMicEnabled(true);
      voiceFollowUpRef.current.cancel();
      followUpPendingRef.current = false;
      stopCapture(false);
      // Reset host wake-only state even when this activation keeps the live stream.
      window.buddy.listening('paused');
      listeningRef.current = 'paused';
      interruptOnlyRef.current = typingRef.current;
      conversationOpenRef.current = !typingRef.current && (engaged || direct);
      directVoiceRef.current = direct;
      setDirectVoice(direct);
      // Only an explicit "talk to Friday" interrupts its voice; resuming the mic after typing,
      // Stop or an error must not cut off a reply.
      if (interrupt) void window.buddy.interrupt();
      setActionError(undefined);
      setHeard('');
      showTranscript();
      lastVoiceRef.current = undefined;
      const generation = generationRef.current;
      if (streamRef.current?.active && captureRef.current) {
        updateListening(typingRef.current ? 'paused' : engaged || direct ? 'armed' : 'listening');
        beginSegmentRef.current?.(streamRef.current, captureRef.current, generation);
        return;
      }
      updateListening('starting');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true, channelCount: 1 },
        });
        if (generation !== generationRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        let capture: FrameCapture;
        try {
          // Prefer the microphone as received over LiveKit; direct capture is the local fallback.
          const [track] = stream.getAudioTracks();
          const remote = track ? await liveKitRef.current?.capture(track) : undefined;
          if (remote && generation !== generationRef.current) {
            remote.close();
            stream.getTracks().forEach((item) => item.stop());
            return;
          }
          capture = remote ?? (await PcmCapture.open(stream));
        } catch (error) {
          stream.getTracks().forEach((track) => track.stop());
          throw error;
        }
        if (generation !== generationRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          capture.close();
          return;
        }
        streamRef.current = stream;
        captureRef.current = capture;
        stream.getAudioTracks().forEach((track) => {
          track.addEventListener(
            'ended',
            () => {
              if (streamRef.current !== stream) return;
              stopCapture();
              setVoiceLevel(0);
              micEnabledRef.current = false;
              setMicEnabled(false);
              setActionError('The microphone disconnected. Tap the microphone to try again.');
              updateListening('error');
            },
            { once: true },
          );
        });
        updateListening(typingRef.current ? 'paused' : engaged || direct ? 'armed' : 'listening');
        beginSegmentRef.current?.(stream, capture, generation);
      } catch (error) {
        if (generation !== generationRef.current) return;
        micEnabledRef.current = false;
        setMicEnabled(false);
        setActionError(
          error instanceof DOMException && error.name === 'NotAllowedError'
            ? 'Allow microphone access to talk to Friday.'
            : 'The microphone isn’t available. Please try again.',
        );
        updateListening('error');
      }
    },
    [updateListening, stopCapture, showTranscript],
  );

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  useEffect(() => {
    typingTransitionRef.current = (value) => {
      if (value) {
        interruptOnlyRef.current = true;
        conversationOpenRef.current = false;
        updateListening(micEnabledRef.current ? 'paused' : 'idle');
      } else if (micEnabledRef.current && !submittingRef.current && !stoppingRef.current) {
        // Closing the text input never cancels Friday; only Send does.
        void startListening(false, false);
      }
    };
  }, [updateListening, startListening]);

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      window.buddy.listTasks(),
      window.buddy.getSettings(),
      window.buddy.fridayState(),
      window.buddy.voiceGate(),
    ])
      .then(([history, config, runtime, gate]) => {
        if (disposed) return;
        voiceGateRef.current = gate;
        setTasks(history);
        persistedSettingsRef.current = config;
        setSettings(config);
        setFriday(runtime);
        setSelected(history.find((item) => item.role !== 'child')?.id);
        if (!micEnabledRef.current) void startListening(false, true);
      })
      .catch((error) => setActionError(errorMessage(error, 'Friday could not load.')))
      .finally(() => setLoading(false));
    const removeTask = window.buddy.onTask((next) => {
      taskStatusRef.current.set(next.id, next.status);
      const reportedChild = childRequestRef.current.get(next.id);
      if (reportedChild && next.status === 'completed' && (next.interactions?.length || next.response)) {
        setReportedChildren((current) => ({ ...current, [reportedChild]: Date.now() }));
        childRequestRef.current.delete(next.id);
      }
      setTasks((current) =>
        [next, ...current.filter((item) => item.id !== next.id)].sort((a, b) => b.createdAt - a.createdAt),
      );
      if (next.role !== 'child') {
        setForegroundTaskId(next.id);
        setSelected((current) => current || next.id);
        if (voiceFollowUpRef.current.taskChanged(next)) followUpPendingRef.current = true;
      }
    });
    const removeState = window.buddy.onFridayState((runtime) => {
      setFriday(runtime);
      if (speakingRef.current && !runtime.presentation.speaking) speakingEndedAtRef.current = Date.now();
      speakingRef.current = runtime.presentation.speaking;
      echoRef.current = runtime.presentation.echo;
      setSpeaking(runtime.presentation.speaking);
      setAcknowledging(Boolean(runtime.presentation.acknowledging));
    });
    const removeListen = window.buddy.onListen(() => {
      setView('now');
      selectChild();
      void startListening(false, true, true);
    });
    const removeStopListen = window.buddy.onStopListening(stopListening);
    return () => {
      disposed = true;
      removeTask();
      removeState();
      removeListen();
      removeStopListen();
      stopListening();
    };
  }, [startListening, stopListening, selectChild]);

  const stopFriday = useCallback(() => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    requestEpochRef.current++;
    replayGenerationRef.current++;
    setReplayPending(false);
    voiceFollowUpRef.current.cancel();
    followUpPendingRef.current = false;
    conversationOpenRef.current = false;
    interruptOnlyRef.current = true;
    typingRef.current = false;
    setTyping(false);
    selectChild();
    setHeard('');
    showTranscript();
    lastVoiceRef.current = undefined;
    setActionError(undefined);
    setSpeaking(false);
    setGuiding(false);
    // Invalidate any older recognition result before cancelling desktop actions.
    stopCapture(false);
    void window.buddy
      .stop()
      .catch(() => setActionError('Friday couldn’t stop. Please try again.'))
      .finally(() => {
        stoppingRef.current = false;
        if (micEnabledRef.current) void startListening(false, false);
        else updateListening('idle');
      });
  }, [selectChild, startListening, stopCapture, updateListening, showTranscript]);

  useEffect(() => {
    // Listening stays live through work and playback on the same capture graph (engaged
    // listening). Busy time only holds the conversation's idle timeout.
    busyRef.current = Boolean(activeTask || speaking || submitting || replayPending);
    activePromptRef.current = activeTask?.prompt;
    if (busyRef.current) return;
    if (followUpPendingRef.current) {
      followUpPendingRef.current = false;
      if (followUpEngagedRef.current && micEnabledRef.current && !typing && !stoppingRef.current)
        conversationOpenRef.current = true;
    }
    // A typed request held Stop-only listening; once it is done and the composer is
    // closed, return to wake gating.
    if (interruptOnlyRef.current && micEnabledRef.current && !typing && !stoppingRef.current) {
      interruptOnlyRef.current = false;
      if (listeningRef.current === 'paused') updateListening(conversationOpenRef.current ? 'armed' : 'listening');
    }
  }, [activeTask, speaking, submitting, replayPending, typing, updateListening]);

  useEffect(() => {
    let disposed = false;
    const remove = window.buddy.onGuidance(setGuiding);
    void window.buddy.guidance().then((value) => {
      if (!disposed) setGuiding(value);
    });
    return () => {
      disposed = true;
      remove();
    };
  }, []);

  useEffect(
    () =>
      window.buddy.onExpanded((value) => {
        changeTyping(false);
        setExpanded(value);
        setClosingWorkspace(false);
      }),
    [changeTyping],
  );
  useEffect(() => {
    let disposed = false;
    let received = false;
    const remove = window.buddy.onControlling((active) => {
      received = true;
      setControlling(active);
    });
    void window.buddy.controlling().then((active) => {
      if (!disposed && !received) setControlling(active);
    });
    return () => {
      disposed = true;
      remove();
    };
  }, []);

  const refreshDesktop = useCallback(
    () =>
      window.buddy
        .desktopStatus()
        .then(setDesktopState)
        .catch((error: unknown) =>
          setDesktopState({
            ready: false,
            error: errorMessage(error, 'Screen access is unavailable. Try checking again.'),
          }),
        )
        .finally(() => setCheckingDesktop(false)),
    [],
  );

  useEffect(() => {
    void refreshDesktop();
    const onFocus = () => void refreshDesktop();
    window.addEventListener('focus', onFocus);
    const removeMark = window.buddy.onMark(() => {
      setMarked(true);
      setPrompt((current) => (current.trim() ? current : 'What is this?'));
      inputRef.current?.focus();
      void refreshDesktop();
    });
    return () => {
      window.removeEventListener('focus', onFocus);
      removeMark();
    };
  }, [refreshDesktop]);

  const selectedStatus = task?.status;
  useEffect(() => {
    if (selectedStatus && !activeStatuses.has(selectedStatus)) void refreshDesktop();
  }, [selectedStatus, refreshDesktop]);

  useEffect(() => {
    if (view === 'now' && expanded) followLatest.current = true;
  }, [view, expanded]);

  useEffect(() => {
    if (!contentRef.current || view !== 'now' || !followLatest.current) return;
    contentRef.current.scrollTop = contentRef.current.scrollHeight;
  }, [tasks, friday?.presentation.text, view, expanded]);

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
        else if (expanded) closeWorkspace();
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
  }, [expanded, showSettings, closeWorkspace]);

  async function saveSettings(next: Partial<BuddySettings>) {
    if (!settings) return;
    const previous = persistedSettingsRef.current ?? settings;
    setSettings({ ...settings, ...next });
    try {
      const updated = await window.buddy.updateSettings(next);
      persistedSettingsRef.current = updated;
      setSettings(updated);
      // A wake word the local detector cannot spell falls back to transcript matching.
      if (next.wakeWord !== undefined) voiceGateRef.current = await window.buddy.voiceGate();
    } catch (error) {
      setSettings(previous);
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

  async function stopAll() {
    setActionError(undefined);
    stopListening();
    try {
      await window.buddy.stop();
      setMarked(false);
      await refreshDesktop();
    } catch (error) {
      setActionError(errorMessage(error, 'Friday could not stop that task.'));
    }
  }

  async function speakResponse() {
    if (answering) {
      await window.buddy.silence();
      return;
    }
    if (!task?.speechText || activeTask || settings?.autoSpeak === false) return;
    const replay = ++replayGenerationRef.current;
    setReplayPending(true);
    try {
      await window.buddy.speak(task.id);
    } catch (error) {
      if (replay === replayGenerationRef.current) setActionError(errorMessage(error, 'Could not read aloud.'));
    } finally {
      if (replay === replayGenerationRef.current) setReplayPending(false);
    }
  }

  async function markScreen() {
    setActionError(undefined);
    setMarking(true);
    try {
      await window.buddy.mark();
    } catch (error) {
      setActionError(errorMessage(error, 'Could not mark the screen.'));
    } finally {
      setMarking(false);
      await refreshDesktop();
    }
  }

  async function clearDrawing() {
    setActionError(undefined);
    try {
      await window.buddy.clearDrawing();
      setMarked(false);
      await refreshDesktop();
    } catch (error) {
      setActionError(errorMessage(error, 'Could not clear the drawing.'));
    }
  }

  const setNotchOffset = useCallback((offset: { x: number; y: number }) => {
    setNotchDrag(offset);
    try {
      void window.buddy.setNotchOffset(offset);
    } catch (error) {
      setActionError(errorMessage(error, 'Friday will reset its notch position.'));
    }
  }, []);

  async function newTask() {
    try {
      await window.buddy.newConversation();
    } catch (error) {
      setActionError(errorMessage(error, 'Could not start a new conversation'));
      return;
    }
    setMarked(false);
    void refreshDesktop();
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
    ? { label: listenState === 'transcribing' ? 'One moment…' : 'Mic on', tone: 'voice' }
    : activeTask?.status === 'awaiting_approval'
      ? { label: 'Waiting on you', tone: 'approval' }
      : activeTask
        ? { label: 'Working', tone: 'working' }
        : { label: 'Standing by', tone: 'ready' };

  const composer = (
    <footer className="composer-area">
      <div className="composer-column">
        {desktopState && !desktopState.ready && (
          <div className="desktop-notice" role="status">
            <span>{desktopState.error}</span>
            <button
              type="button"
              onClick={() => {
                setCheckingDesktop(true);
                void refreshDesktop();
              }}
              disabled={checkingDesktop}
            >
              {checkingDesktop ? 'Checking…' : 'Check again'}
            </button>
          </div>
        )}
        {(marked || (desktopState?.annotations ?? 0) > 0) && (
          <div className="drawing-context">
            <span>{marked ? 'Screen mark attached' : 'Drawing on screen'}</span>
            <button type="button" onClick={() => void clearDrawing()}>
              Clear <X size={12} />
            </button>
          </div>
        )}
        {(['armed', 'transcribing', 'error'].includes(listenState) || heard) && (
          <div className={`listening-bar ${listenState}`} aria-live="polite">
            <span className="listening-indicator">
              <i style={{ transform: `scale(${1 + voiceLevel})` }} />
              {directVoice && listenState === 'listening' ? 'Listening' : voiceCopy(listenState, wakeWord).eyebrow}
            </span>
            <span>
              {heard
                ? `“${heard}”`
                : directVoice && listenState === 'listening'
                  ? 'Listening to your request…'
                  : voiceCopy(listenState, wakeWord).detail}
            </span>
          </div>
        )}
        <form
          className="command-bar"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void runPrompt(prompt);
            changeTyping(false);
          }}
        >
          <textarea
            ref={inputRef}
            autoFocus
            rows={1}
            value={prompt}
            aria-label="Ask Friday"
            placeholder={
              view === 'history' ? 'Start a conversation…' : activeTask ? 'Add to your request…' : 'Message Friday…'
            }
            onChange={(event) => {
              setPrompt(event.target.value);
              changeTyping(Boolean(event.target.value.trim()));
            }}
            onFocus={() => {
              if (prompt.trim()) changeTyping(true);
            }}
            onBlur={() => changeTyping(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="composer-toolbar">
            <div className="composer-tools">
              <button
                className="mark-button pressable"
                type="button"
                aria-label="Mark screen"
                title={desktopState?.ready ? 'Mark screen' : desktopState?.error || 'Checking screen access…'}
                disabled={!desktopState?.ready || Boolean(activeTask) || marking}
                onClick={() => void markScreen()}
              >
                {marking ? <LoaderCircle className="spin" size={15} /> : <Scan size={15} strokeWidth={1.5} />}
              </button>
              <button
                className={`mic-button pressable ${micEnabled ? 'active' : ''}`}
                type="button"
                aria-label={micEnabled ? 'Turn microphone off' : 'Turn microphone on'}
                aria-pressed={micEnabled}
                title={micEnabled ? 'Turn microphone off' : 'Turn microphone on'}
                onClick={() => (micEnabled ? disableMicrophone() : void startListening(false, false))}
              >
                {micEnabled ? <Mic size={15} strokeWidth={1.5} /> : <MicOff size={15} strokeWidth={1.5} />}
              </button>
              {(activeTask ||
                answering ||
                controlling ||
                guiding ||
                friday?.sessions.some((session) => session.status === 'running') ||
                listenState === 'transcribing') && (
                <button
                  className="stop-button pressable"
                  type="button"
                  onClick={() => void stopAll()}
                  title="Stop speech and all tasks"
                >
                  <CircleStop size={15} strokeWidth={1.5} /> <span>Stop</span>
                </button>
              )}
            </div>
            <button
              className="send-button pressable"
              type="submit"
              disabled={!prompt.trim() || submitting}
              aria-label="Send request"
              title="Send · Enter"
            >
              {submitting ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={16} />}
            </button>
          </div>
        </form>
      </div>
    </footer>
  );
  if (!expanded)
    return (
      <FridayPresence
        state={friday}
        task={
          activeTask ||
          tasks.find(
            (item) =>
              item.role !== 'child' &&
              item.conversationId === friday?.parentId &&
              (item.id === foregroundTaskId || item.id === friday?.presentation.taskId),
          )
        }
        tasks={tasks}
        listening={listenState}
        speaking={answering}
        transcript={transcript}
        guiding={guiding}
        controlling={controlling}
        onWindowDrag={setNotchOffset}
        notchOffset={notchDrag ?? settings?.notchOffset}
        level={voiceLevel}
        heard={heard}
        heardIgnored={Boolean(heard) && heard === ignoredHeard}
        onSendIgnored={() => {
          const ignored = ignoredRef.current;
          if (!ignored) return;
          ignoredRef.current = undefined;
          setIgnoredHeard('');
          lastVoiceRef.current = { text: ignored.text, at: Date.now(), childId: ignored.childId };
          showTranscript({ text: ignored.text, final: true });
          void runPrompt(ignored.text, true, { selectedChildId: ignored.childId });
        }}
        error={actionError}
        selectedChildId={selectedChildId}
        reportedChildren={reportedChildren}
        typing={typing}
        draft={prompt}
        onDraftChange={setPrompt}
        onTypingChange={changeTyping}
        micEnabled={micEnabled}
        wakeWord={wakeWord}
        onClearContext={() => selectChild()}
        onContinue={() => {
          typingRef.current = false;
          setTyping(false);
          void startListening(false, true, true);
        }}
        onMicOn={() => {
          void startListening(false, false);
        }}
        onMicOff={disableMicrophone}
        onSelectTask={(id) => {
          typingRef.current = false;
          setTyping(false);
          selectChild(id);
          void startListening(false, true, true);
        }}
        onTalk={() => {
          typingRef.current = false;
          setTyping(false);
          selectChild();
          void startListening(false, true, true);
        }}
        onSubmit={(value) => {
          void runPrompt(value);
        }}
        onStop={stopFriday}
        onDetails={() => {
          changeTyping(false);
          followLatest.current = true;
          setView('now');
          void window.buddy.setExpanded(true);
        }}
        onStopChild={(id) => {
          void window.buddy
            .stopChild(id)
            .catch(() => setActionError('That task couldn’t be stopped. Please try again.'));
        }}
        onApprove={(id, approved) => {
          void window.buddy.approve(id, approved).catch(() => setActionError('That approval is no longer available.'));
        }}
      />
    );
  return (
    <main className="shell">
      <section className={`friday-window ${closingWorkspace ? 'is-closing' : ''}`} aria-label="Friday desktop agent">
        <header className="titlebar">
          <button className="brand-button" type="button" onClick={() => setView('now')} aria-label="Open Friday now">
            <FridayMark
              mood={fridayMood({
                attention: Boolean(actionError || activeTask?.approval || activeTask?.error),
                speaking: answering,
                working: Boolean(activeTask || controlling),
                listening: listenState,
                typing,
                micEnabled,
              })}
            />
            <span className="brand-copy">
              <strong>Friday</strong>
              <small aria-live="polite">{presence.label}</small>
            </span>
          </button>

          <nav className="view-switcher" aria-label="Friday views">
            <button type="button" className={view === 'now' ? 'active' : ''} onClick={() => setView('now')}>
              <span>Conversation</span>
            </button>
            <button type="button" className={view !== 'now' ? 'active' : ''} onClick={() => setView('history')}>
              <span>History</span>
            </button>
          </nav>

          <div className="title-actions">
            <button
              className="icon-button pressable"
              type="button"
              aria-label="New conversation"
              title="New conversation"
              onClick={() => void newTask()}
            >
              <Plus size={15} strokeWidth={1.5} />
            </button>
            <button
              className="icon-button pressable"
              type="button"
              aria-label="Open settings"
              title="Settings"
              onClick={() => setShowSettings(true)}
            >
              <Settings size={15} strokeWidth={1.5} />
            </button>
            <button
              className="icon-button pressable"
              type="button"
              aria-label="Back to pill"
              title="Back to pill"
              onClick={closeWorkspace}
            >
              <Minimize2 size={15} strokeWidth={1.5} />
            </button>
          </div>
        </header>

        <div
          className="content-scroll"
          ref={contentRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
        >
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
                setView('detail');
                setShowActivity(false);
              }}
              onNewTask={newTask}
            />
          ) : view === 'detail' && task ? (
            <TaskView
              task={task}
              showActivity={showActivity}
              onToggleActivity={() => setShowActivity((value) => !value)}
              onNewTask={newTask}
              onRetry={() => void runPrompt(task.prompt)}
              onApprove={(approved) => void resolveApproval(approved)}
              approvalPending={approvalPending}
              speaking={answering}
              replayDisabledReason={
                activeTask
                  ? 'Wait for this reply to finish'
                  : settings?.autoSpeak === false
                    ? 'Spoken replies are off'
                    : undefined
              }
              onSpeak={() => void speakResponse()}
            />
          ) : tasks.some((item) => item.role !== 'child' && item.conversationId === friday?.parentId) ? (
            <section className="workspace-conversation">
              <Conversation
                tasks={tasks
                  .filter((item) => item.role !== 'child' && item.conversationId === friday?.parentId)
                  .sort((a, b) => a.createdAt - b.createdAt)}
                state={friday}
                onApprove={(id, approved) => {
                  void window.buddy
                    .approve(id, approved)
                    .catch(() => setActionError('That approval is no longer available.'));
                }}
              />
            </section>
          ) : (
            <WelcomeView onTryIdea={tryIdea} />
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

        {composer}

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
