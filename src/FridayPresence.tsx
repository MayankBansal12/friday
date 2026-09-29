import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
import { FridayMascot, type FridayMood } from './FridayMascot';
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
  controlling: boolean;
  level: number;
  heard: string;
  /** The user's recognized words: live while they speak, final briefly after submission. */
  transcript?: { text: string; final: boolean };
  error?: string;
  selectedChildId?: string;
  reportedChildren?: Record<string, number>;
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
  notchOffset?: { x: number; y: number };
  onWindowDrag?(offset: { x: number; y: number }): void;
}

/** Quoted user words; live words keep their newest end visible in the narrow notch. */
function spokenLine(text: string, final: boolean) {
  const clean = text.trim().replace(/\s+/g, ' ');
  const shown = !final && clean.length > 56 ? `…${clean.slice(-55).trimStart()}` : clean;
  return `“${shown}”`;
}

function taskPreview(text: string) {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('|'))
      ?.replace(/^#{1,6}\s+/, '')
      .replace(/[*_`]/g, '')
      .slice(0, 180) || 'Done'
  );
}

export function FridayPresence(props: Props) {
  const { state, task, listening, speaking } = props;
  const reducedMotion = Boolean(useReducedMotion());
  const [hovered, setHovered] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const { typing, onTypingChange: setTyping } = props;
  const [text, setText] = useState('');
  const [dismissed, setDismissed] = useState<string>();
  const [autoOpen, setAutoOpen] = useState(false);
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
  const contentRef = useRef<HTMLDivElement>(null);
  const busy = task && activeStatuses.has(task.status);
  const listeningToRequest = ['starting', 'armed', 'transcribing'].includes(listening);
  const children = (state?.sessions ?? []).filter((s) => s.role === 'child').sort((a, b) => b.updatedAt - a.updatedAt);
  const visible = children.filter(
    (s) =>
      ['running', 'needs_input'].includes(s.status) ||
      (['completed', 'failed', 'interrupted'].includes(s.status) &&
        acknowledged[s.id] !== s.updatedAt &&
        (props.reportedChildren?.[s.id] ?? 0) < s.updatedAt),
  );
  const running = children.filter((s) => s.status === 'running');
  const attention = visible.filter((s) => ['needs_input', 'failed', 'interrupted'].includes(s.status)).length;
  const selected = children.find((s) => s.id === props.selectedChildId);
  const detail = props.error || task?.error || state?.presentation.text || '';
  const contentKey = `${state?.presentation.taskId ?? ''}:${detail}`;
  useEffect(() => {
    if (!state?.presentation.expanded || !detail || dismissed === contentKey) return;
    const opening = setTimeout(() => setAutoOpen(true), 0);
    const timer = setTimeout(() => setAutoOpen(false), 15_000);
    return () => {
      clearTimeout(opening);
      clearTimeout(timer);
    };
  }, [contentKey, state?.presentation.expanded, detail, dismissed]);
  const approvals = props.tasks.filter((t) => t.approval);
  const important = Boolean(
    approvals.length || ((props.error || task?.error || state?.presentation.expanded) && dismissed !== contentKey),
  );
  // The user's words take the status line until Friday answers or needs something.
  const userWords =
    props.transcript?.text.trim() && !props.controlling && !typing && !approvals.length && !props.guiding && !speaking
      ? props.transcript
      : undefined;
  const engaged = Boolean(
    props.controlling ||
    busy ||
    speaking ||
    props.guiding ||
    listeningToRequest ||
    typing ||
    important ||
    selected ||
    userWords,
  );
  const background = !engaged && visible.length > 0;
  const expanded = !props.controlling && !background && (hovered || (autoOpen && dismissed !== contentKey));
  const conversation = props.tasks
    .filter((item) => item.role !== 'child' && item.conversationId === state?.parentId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const resting = !engaged && !expanded;
  // The expanded panel's own scroll stays at the newest content instead of a mid-scroll position.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !expanded) return;
    content.scrollTop = content.scrollHeight;
  }, [expanded, detail, conversation.length, approvals.length, props.heard, listeningToRequest]);
  const surface: SurfaceLayout = background
    ? hovered
      ? 'tasks'
      : 'orb'
    : expanded
      ? 'panel'
      : engaged
        ? 'bar'
        : 'quiet';
  const status = props.controlling
    ? 'Controlling your computer · Esc twice to stop'
    : typing
      ? 'Type your request…'
      : approvals.length
        ? 'Needs your approval'
        : props.guiding
          ? 'Guiding you'
          : speaking
            ? 'Speaking…'
            : userWords
              ? spokenLine(userWords.text, userWords.final)
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
  }, [surface, background, expanded, resting, reducedMotion, props.controlling]);
  // Drag the notch by its bar. Deltas use screen coordinates: the window moves
  // under the pointer, so client coordinates would cancel the drag. Offsets
  // compose over the last committed anchor; main clamps to the work area.
  const dragRef = useRef(props.onWindowDrag);
  const offsetRef = useRef(props.notchOffset);
  const controllingRef = useRef(props.controlling);
  useEffect(() => {
    dragRef.current = props.onWindowDrag;
    offsetRef.current = props.notchOffset;
    controllingRef.current = props.controlling;
  });
  useEffect(() => {
    if (!props.onWindowDrag) return;
    const root = panelRef.current?.closest('main') ?? document.body;
    let origin: { x: number; y: number } | undefined;
    let base: { x: number; y: number } | undefined;
    let pending: { x: number; y: number } | undefined;
    let moved = false;
    let frame = 0;
    const flush = () => {
      frame = 0;
      const latest = pending;
      pending = undefined;
      // With no pending frame the last rAF already sent the final offset.
      if (latest) dragRef.current?.(latest);
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || controllingRef.current) return;
      if (!event.target || !(event.target as Element).closest?.('.presence-bar')) return;
      origin = { x: event.screenX, y: event.screenY };
      base = { ...(offsetRef.current ?? { x: 0, y: 0 }) };
      moved = false;
      // Keep receiving moves if the pointer leaves the narrow window mid-drag.
      // Never capture on buttons: pointer capture would retarget their clicks.
      if (event.target instanceof Element && !event.target.closest('button, input, a'))
        event.target.setPointerCapture?.(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!origin || !base) return;
      const dx = Math.round(event.screenX - origin.x);
      const dy = Math.round(event.screenY - origin.y);
      if (!moved && Math.hypot(dx, dy) < 6) return;
      moved = true;
      event.preventDefault();
      if (!panelRef.current?.hasPointerCapture?.(event.pointerId))
        panelRef.current?.setPointerCapture?.(event.pointerId);
      pending = { x: base.x + dx, y: base.y + dy };
      if (frame) return;
      frame = requestAnimationFrame(flush);
    };
    const up = (event: PointerEvent) => {
      if (panelRef.current?.hasPointerCapture?.(event.pointerId))
        panelRef.current.releasePointerCapture(event.pointerId);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (moved) flush();
      origin = undefined;
      base = undefined;
      moved = false;
    };
    root.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      root.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, [props.onWindowDrag]);
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
    setAutoOpen(false);
    setTyping(false);
    setDismissed(contentKey);
    props.onDismiss();
  }
  const mood: FridayMood =
    approvals.length || props.error || task?.error || listening === 'error'
      ? 'worried'
      : speaking
        ? 'speaking'
        : busy || props.controlling || listening === 'transcribing'
          ? 'thinking'
          : listeningToRequest || typing
            ? 'listening'
            : !props.micEnabled
              ? 'sleepy'
              : 'idle';
  const mark = <FridayMascot mood={mood} className="presence-mark" />;
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
                      ? taskPreview(session.summary || 'Done')
                      : taskPreview(session.summary || 'Working on it…')}
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
                  className={`presence-status-copy ${userWords ? 'presence-transcript' : ''}`}
                  // Live words update in place; only a change of kind animates.
                  key={userWords ? 'transcript' : status}
                  aria-label={userWords ? `You said: ${userWords.text}` : undefined}
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
                <div className="presence-content" ref={contentRef}>
                  {props.heard && listeningToRequest && <p className="heard-text">{props.heard}</p>}
                  {conversation.length > 0 && (
                    <div className="presence-conversation" aria-label="Conversation transcript">
                      {conversation.map((item) => {
                        const reply =
                          item.interactions
                            ?.flatMap((interaction) => interaction.actions)
                            .filter((action) => action.tool === 'show_text_tool' && action.status === 'completed')
                            .map((action) => action.text)
                            .filter(Boolean)
                            .join('\n\n') ||
                          item.response ||
                          (state?.presentation.taskId === item.id ? state.presentation.text : '');
                        return (
                          <div className="presence-turn" key={item.id}>
                            <div className="presence-turn-user">{item.prompt}</div>
                            {reply && (
                              <div className="presence-reply presence-markdown">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{reply}</ReactMarkdown>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {detail &&
                    (props.error ||
                      task?.error ||
                      !conversation.some((item) => item.id === state?.presentation.taskId)) && (
                      <div
                        className={`presence-reply presence-markdown ${props.error || task?.error ? 'is-error' : ''}`}
                        role={props.error || task?.error ? 'alert' : undefined}
                      >
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail}</ReactMarkdown>
                      </div>
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
