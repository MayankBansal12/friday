import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import {
  ArrowUp,
  CircleHelp,
  TriangleAlert,
  Square,
  Check,
  CircleStop,
  Keyboard,
  LoaderCircle,
  Mic,
  MicOff,
  Settings,
  X,
} from 'lucide-react';
import {
  activeStatuses,
  type FridayState,
  type ListeningState,
  type SurfaceLayout,
  type TaskRecord,
} from '../electron/types';
import './presence.css';

const notchSpring = { type: 'spring', stiffness: 420, damping: 40, mass: 1 } as const;

function NotchBody({
  children,
  reducedMotion,
  onStart,
  onComplete,
}: {
  children: ReactNode;
  reducedMotion: boolean;
  onStart(): void;
  onComplete(): void;
}) {
  const present = useIsPresent();
  return (
    <motion.div
      className="presence-reveal"
      inert={!present}
      aria-hidden={!present}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={reducedMotion ? { duration: 0 } : { ...notchSpring, opacity: { duration: 0.18 } }}
      onAnimationStart={onStart}
      onAnimationComplete={onComplete}
    >
      <div className="presence-body">{children}</div>
    </motion.div>
  );
}

interface Props {
  state?: FridayState;
  task?: TaskRecord;
  tasks: TaskRecord[];
  listening: ListeningState;
  speaking: boolean;
  guiding: boolean;
  level: number;
  heard: string;
  error?: string;
  selectedChildId?: string;
  onSelectTask(id: string): void;
  onClearContext(): void;
  micEnabled: boolean;
  wakeWord: string;
  onMicOff(): void;
  typing: boolean;
  onTypingChange(value: boolean): void;
  onTalk(): void;
  onContinue(): void;
  onMicOn(): void;
  onStop(): void;
  onDismiss(): void;
  onSubmit(text: string): void;
  onDetails(): void;
  onStopChild(id: string): void;
  onApprove(id: string, approved: boolean): void;
}

export function FridayPresence(props: Props) {
  const { state, task, listening, speaking } = props;
  const reducedMotion = Boolean(useReducedMotion());
  const [hovered, setHovered] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const { typing, onTypingChange: setTyping } = props;
  const [text, setText] = useState('');
  const [dismissed, setDismissed] = useState<string>();
  const [acknowledged, setAcknowledged] = useState<Record<string, number>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('friday.taskUpdates') || '{}');
      return saved && typeof saved === 'object' && !Array.isArray(saved)
        ? Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'number'))
        : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        'friday.taskUpdates',
        JSON.stringify(Object.fromEntries(Object.entries(acknowledged).slice(-200))),
      );
    } catch {
      /* Dismissal still works for this view if storage is unavailable. */
    }
  }, [acknowledged]);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panelRef = useRef<HTMLElement>(null);
  const previousPanel = useRef<HTMLElement | null>(null);
  const activeMotions = useRef(new Set<string>());
  const previousExpanded = useRef(false);
  const transitioning = useRef(false);
  const syncSurface = useRef<() => void>(() => {});
  const keyboardFocus = useRef(false);
  const busy = task && activeStatuses.has(task.status);
  const listeningToRequest = ['starting', 'armed', 'transcribing'].includes(listening);
  const children = (state?.sessions ?? []).filter((s) => s.role === 'child').sort((a, b) => b.updatedAt - a.updatedAt);
  const visible = children.filter(
    (s) =>
      ['running', 'needs_input'].includes(s.status) ||
      (['completed', 'failed', 'interrupted'].includes(s.status) && acknowledged[s.id] !== s.updatedAt),
  );
  const running = children.filter((s) => s.status === 'running');
  const attention = visible.filter((s) => ['needs_input', 'failed', 'interrupted'].includes(s.status)).length;
  const selected = children.find((s) => s.id === props.selectedChildId);
  const detail = props.error || task?.error || state?.presentation.text || '';
  const contentKey = `${state?.presentation.taskId ?? ''}:${detail}`;
  const approvals = props.tasks.filter((t) => t.approval);
  const important = Boolean(
    approvals.length || ((props.error || task?.error || state?.presentation.expanded) && dismissed !== contentKey),
  );
  const engaged = Boolean(busy || speaking || props.guiding || listeningToRequest || typing || important || selected);
  const background = !engaged && visible.length > 0;
  const expanded = !background && hovered;
  const resting = !engaged && !expanded;
  const surface: SurfaceLayout = background
    ? hovered
      ? 'tasks'
      : 'orb'
    : expanded
      ? 'panel'
      : engaged
        ? 'bar'
        : 'quiet';
  const status = typing
    ? 'Type your request…'
    : approvals.length
      ? 'Needs your approval'
      : props.guiding
        ? 'Guiding you'
        : speaking
          ? 'Speaking…'
          : listening === 'starting'
            ? 'Opening microphone…'
            : listening === 'transcribing'
              ? 'One moment…'
              : busy
                ? 'Working on it…'
                : listening === 'armed'
                  ? 'Listening…'
                  : listening === 'error'
                    ? 'Check your microphone'
                    : !props.micEnabled
                      ? 'Microphone off'
                      : `Say “hey ${props.wakeWord.toLowerCase()}” to wake her up`;

  function motionStarted(part: string) {
    activeMotions.current.add(part);
    transitioning.current = true;
  }
  function motionCompleted(part: string) {
    activeMotions.current.delete(part);
    if (activeMotions.current.size) return;
    transitioning.current = false;
    syncSurface.current();
  }

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const mounted = previousPanel.current !== panel;
    previousPanel.current = panel;
    let previous = '';
    const resize = () => {
      if (transitioning.current && !background) return;
      const rect = panel?.getBoundingClientRect();
      const height = rect ? Math.ceil(rect.height) + (background ? 24 : 10) : undefined;
      const width = rect && !background ? Math.ceil(rect.width) : undefined;
      const measurement = `${height}:${width}`;
      if (measurement === previous) return;
      previous = measurement;
      void window.buddy.setSurface(surface, height, width);
    };
    syncSurface.current = resize;
    if (background || reducedMotion || mounted) {
      activeMotions.current.clear();
      transitioning.current = false;
    }
    const rect = panel?.getBoundingClientRect();
    const targetWidth = Math.min(resting ? 360 : 500, (panel?.parentElement?.clientWidth ?? 520) - 20);
    const barHeight = panel?.querySelector('.presence-bar')?.getBoundingClientRect().height;
    const changingSize =
      !mounted &&
      rect &&
      (Math.abs(rect.width - targetWidth) > 0.5 ||
        Math.abs((barHeight ?? 0) - (resting ? 42 : 54)) > 0.5 ||
        previousExpanded.current !== expanded);
    previousExpanded.current = expanded;
    if (!background && !reducedMotion && (changingSize || activeMotions.current.size)) {
      // Reserve the canvas before opening. Resizing/shaping a native window every
      // frame lags behind the spring and clips its edges on XWayland.
      transitioning.current = true;
      void window.buddy.setSurface(
        surface,
        Math.max(Math.ceil(rect?.height ?? 0) + 10, expanded ? 420 : resting ? 54 : 66),
        Math.max(Math.ceil(rect?.width ?? 0), resting ? 360 : 500),
      );
    } else {
      transitioning.current = false;
      resize();
    }
    // Completions shrink to the actual size; content changes are observed only
    // after motion settles. Initial renders with matching dimensions need no animation.
    const observer = new ResizeObserver(resize);
    if (panel) observer.observe(panel);
    return () => {
      observer.disconnect();
      syncSurface.current = () => {};
    };
  }, [surface, background, expanded, resting, reducedMotion]);
  useEffect(
    () => () => {
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    },
    [],
  );

  function enter() {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    setHovered(true);
  }
  function leave() {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      if (!keyboardFocus.current || !panelRef.current?.contains(document.activeElement)) {
        setHovered(false);
        if (typing) setTyping(false);
        if (panelRef.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      }
    }, 450);
  }
  function collapse() {
    setHovered(false);
    setTyping(false);
    setDismissed(contentKey);
    props.onDismiss();
  }
  const mark = (
    <span className={`presence-mark ${busy ? 'working' : ''} ${speaking ? 'speaking' : ''}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
  const taskList = (
    <section className="background-list" aria-label="Background tasks">
      <h2>
        Background tasks <span>{running.length ? `${running.length} running` : 'Updates'}</span>
      </h2>
      {visible.map((session) => (
        <div className="background-task" key={session.id}>
          <span className={`task-dot ${session.status}`}>
            {session.status === 'running' ? (
              <LoaderCircle size={14} className="spin" />
            ) : session.status === 'completed' ? (
              <Check size={14} />
            ) : session.status === 'needs_input' ? (
              <CircleHelp size={16} />
            ) : (
              <TriangleAlert size={16} />
            )}
          </span>
          <button
            className="background-task-copy"
            onClick={() => {
              setHovered(false);
              props.onSelectTask(session.id);
            }}
            title={`Talk about ${session.title}`}
          >
            <strong>{session.title}</strong>
            <small>
              {session.status === 'needs_input'
                ? session.question || 'Needs your input'
                : session.status === 'failed'
                  ? 'Couldn’t finish'
                  : session.status === 'interrupted'
                    ? 'Interrupted'
                    : session.status === 'completed'
                      ? session.summary || 'Done'
                      : session.summary || 'Working on it…'}
            </small>
          </button>
          {['running', 'needs_input'].includes(session.status) ? (
            <button
              className="presence-action"
              aria-label={`Stop ${session.title}`}
              title="Stop task"
              onClick={(e) => {
                e.stopPropagation();
                props.onStopChild(session.id);
              }}
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              className="presence-action"
              aria-label={`Dismiss update for ${session.title}`}
              title="Dismiss update"
              onClick={() => setAcknowledged((v) => ({ ...v, [session.id]: session.updatedAt }))}
            >
              <X size={16} />
            </button>
          )}
        </div>
      ))}
    </section>
  );

  return (
    <main
      className={`presence-root ${background ? 'background-root' : surface === 'quiet' ? 'quiet-root' : ''}`}
      data-surface={surface}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onPointerDown={() => {
        keyboardFocus.current = false;
      }}
      onFocus={(e) => {
        if (e.target.matches(':focus-visible')) {
          keyboardFocus.current = true;
          enter();
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          keyboardFocus.current = false;
          leave();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          collapse();
        }
      }}
    >
      {background ? (
        <section ref={panelRef} className="background-group">
          <button
            className="friday-orb"
            aria-label={`Talk to Friday, ${visible.length} background ${visible.length === 1 ? 'task' : 'tasks'}${attention ? `, ${attention} need attention` : ''}, microphone ${props.micEnabled ? 'on' : 'off'}`}
            aria-expanded={hovered}
            aria-controls={hovered ? 'task-popover' : undefined}
            onClick={props.onTalk}
          >
            {mark}
            <span className={`orb-badge ${attention ? 'attention' : ''}`}>{visible.length}</span>
            <span className={`orb-mic ${props.micEnabled ? 'on' : ''}`} aria-hidden="true">
              {props.micEnabled ? <Mic size={11} /> : <MicOff size={11} />}
            </span>
          </button>
          {hovered && (
            <div className="task-popover" id="task-popover">
              {taskList}
              <footer className="presence-footer">
                <button
                  onClick={props.micEnabled ? props.onMicOff : props.onMicOn}
                  aria-label={props.micEnabled ? 'Turn microphone off' : 'Turn microphone on'}
                >
                  {props.micEnabled ? <Mic size={14} /> : <MicOff size={14} />}Microphone{' '}
                  {props.micEnabled ? 'on' : 'off'}
                </button>
              </footer>
            </div>
          )}
        </section>
      ) : (
        <motion.section
          ref={panelRef}
          className={`friday-presence ${expanded ? 'is-expanded' : ''}`}
          aria-label="Friday companion"
          initial={false}
          animate={{ width: resting ? 360 : 500, borderRadius: expanded ? 28 : resting ? 22 : 28 }}
          transition={reducedMotion ? { duration: 0 } : notchSpring}
          onAnimationStart={() => motionStarted('shell')}
          onAnimationComplete={() => motionCompleted('shell')}
        >
          <motion.header
            className="presence-bar"
            initial={false}
            animate={{ height: resting ? 42 : 54 }}
            transition={reducedMotion ? { duration: 0 } : notchSpring}
            onAnimationStart={() => motionStarted('bar')}
            onAnimationComplete={() => motionCompleted('bar')}
          >
            {mark}
            <button
              className="presence-heading"
              onClick={props.onContinue}
              aria-label="Talk to Friday"
              aria-expanded={expanded}
            >
              <strong>Friday</strong>
              <span role="status">
                <motion.span
                  className="presence-status-copy"
                  key={status}
                  initial={reducedMotion ? false : { opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.18 }}
                >
                  {status}
                </motion.span>
              </span>
            </button>
            {listeningToRequest && !typing && (
              <div className="voice-meter" aria-hidden="true">
                {[0.4, 0.9, 0.6, 1, 0.5].map((scale, i) => (
                  <i key={i} style={{ transform: `scaleY(${0.15 + props.level * scale})` }} />
                ))}
              </div>
            )}
            {visible.length > 0 && (
              <button
                className="task-count"
                aria-label={`Show ${visible.length} background tasks`}
                aria-expanded={expanded}
                onClick={() => {
                  setShowTasks(!showTasks);
                  enter();
                }}
              >
                {visible.length}
                <span> tasks</span>
              </button>
            )}
            <button
              className="presence-action"
              aria-label="Stop Friday"
              title="Stop speech and all tasks"
              onClick={() => {
                setDismissed(contentKey);
                props.onStop();
              }}
            >
              <CircleStop size={18} />
            </button>
          </motion.header>
          <AnimatePresence initial={false}>
            {expanded && (
              <NotchBody
                key="details"
                reducedMotion={reducedMotion}
                onStart={() => motionStarted('body')}
                onComplete={() => motionCompleted('body')}
              >
                {selected && (
                  <div className="task-context">
                    <span>About: {selected.title}</span>
                    <button className="presence-action" aria-label="Clear task context" onClick={props.onClearContext}>
                      <X size={14} />
                    </button>
                  </div>
                )}
                {selected?.question && <p className="selected-question">{selected.question}</p>}
                <div className="presence-content">
                  {props.heard && listeningToRequest && <p className="heard-text">{props.heard}</p>}
                  {detail && (
                    <p
                      className={`presence-reply ${props.error || task?.error ? 'is-error' : ''}`}
                      role={props.error || task?.error ? 'alert' : undefined}
                    >
                      {detail}
                    </p>
                  )}
                  {approvals.map((item) => (
                    <div className="presence-approval" key={item.id}>
                      <strong>{item.approval!.title}</strong>
                      <p>{item.approval!.message}</p>
                      <button onClick={() => props.onApprove(item.approval!.id, true)}>Allow</button>
                      <button onClick={() => props.onApprove(item.approval!.id, false)}>Decline</button>
                    </div>
                  ))}
                  {visible.length > 0 && !typing && (!selected || showTasks) && taskList}
                </div>
                {typing && (
                  <form
                    className="presence-composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (text.trim()) {
                        props.onSubmit(text);
                        setText('');
                        setTyping(false);
                      }
                    }}
                  >
                    <input
                      autoFocus
                      aria-label="Ask Friday"
                      placeholder="Type a request…"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                    <button aria-label="Send request" disabled={!text.trim()}>
                      <ArrowUp size={16} />
                    </button>
                  </form>
                )}
                <footer className="presence-footer">
                  <button onClick={() => setTyping(!typing)} aria-pressed={typing}>
                    <Keyboard size={14} />
                    {typing ? 'Close text input' : 'Type instead'}
                  </button>
                  <button
                    className="footer-mic"
                    onClick={props.micEnabled ? props.onMicOff : props.onMicOn}
                    aria-label={props.micEnabled ? 'Turn microphone off' : 'Turn microphone on'}
                    title={props.micEnabled ? 'Turn microphone off' : 'Turn microphone on'}
                  >
                    {props.micEnabled ? <Mic size={14} /> : <MicOff size={14} />}
                    {props.micEnabled ? 'Mic on' : 'Mic off'}
                  </button>
                  <button onClick={props.onDetails} aria-label="Open settings and history">
                    <Settings size={14} />
                    Settings & history
                  </button>
                </footer>
              </NotchBody>
            )}
          </AnimatePresence>
        </motion.section>
      )}
    </main>
  );
}
