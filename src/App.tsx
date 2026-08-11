import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleStop,
  Clock3,
  Command,
  Folder,
  History,
  LoaderCircle,
  Minus,
  Play,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import type { BuddySettings, TaskRecord, TaskStatus, ToolCall } from '../electron/types';

const active = new Set<TaskStatus>(['queued', 'planning', 'awaiting_approval', 'running']);
const labels: Record<TaskStatus, string> = {
  queued: 'Queued',
  planning: 'Planning',
  awaiting_approval: 'Needs approval',
  running: 'Running',
  completed: 'Complete',
  failed: 'Failed',
  cancelled: 'Stopped',
};
function describe(call: ToolCall) {
  if (call.kind === 'shell') return [call.command, ...call.args].join(' ');
  if (call.kind === 'browser') return call.url;
  return `${call.operation} ${call.path}`;
}

function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === 'completed') return <Check size={14} />;
  if (status === 'failed' || status === 'cancelled') return <X size={14} />;
  if (status === 'awaiting_approval') return <AlertTriangle size={14} />;
  return <LoaderCircle className="spin" size={14} />;
}

export default function App() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selected, setSelected] = useState<string>();
  const [prompt, setPrompt] = useState('');
  const [settings, setSettings] = useState<BuddySettings>();
  const [showSettings, setShowSettings] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const output = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void Promise.all([window.buddy.listTasks(), window.buddy.getSettings()]).then(([history, config]) => {
      setTasks(history);
      setSettings(config);
      setSelected(history[0]?.id);
    });
    return window.buddy.onTask((task) => {
      setTasks((old) => [task, ...old.filter((x) => x.id !== task.id)].sort((a, b) => b.createdAt - a.createdAt));
      setSelected((id) => id || task.id);
    });
  }, []);
  useEffect(() => {
    output.current?.scrollTo({ top: output.current.scrollHeight, behavior: 'smooth' });
  }, [tasks, selected]);
  const task = useMemo(() => tasks.find((item) => item.id === selected), [tasks, selected]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value) return;
    setPrompt('');
    const created = await window.buddy.submit(value);
    setSelected(created.id);
  }
  async function update(next: Partial<BuddySettings>) {
    if (!settings) return;
    const value = { ...settings, ...next };
    setSettings(value);
    await window.buddy.updateSettings(next);
  }
  return (
    <main className="shell">
      <section className="buddy">
        <header className="titlebar">
          <div className="brand">
            <div className="orb">
              <Sparkles size={16} />
            </div>
            <div>
              <strong>Linux Buddy</strong>
              <span>local desktop agent</span>
            </div>
          </div>
          <div className="window-actions">
            <span className="shortcut">
              <Command size={11} /> Ctrl Shift Space
            </span>
            <button aria-label="Settings" onClick={() => setShowSettings(!showSettings)}>
              <Settings size={17} />
            </button>
            <button aria-label="Hide" onClick={() => window.buddy.hide()}>
              <Minus size={18} />
            </button>
          </div>
        </header>
        {showSettings && settings && (
          <aside className="settings-panel">
            <div className="settings-title">
              <ShieldCheck size={17} />
              <strong>Assistant settings</strong>
            </div>
            <label>
              Provider
              <select
                value={settings.provider}
                onChange={(e) => void update({ provider: e.target.value as BuddySettings['provider'] })}
              >
                <option value="demo">Demo · no key</option>
                <option value="codex">Codex CLI</option>
              </select>
            </label>
            <label>
              Working directory
              <div className="field-icon">
                <Folder size={15} />
                <input
                  value={settings.defaultCwd}
                  onChange={(e) => setSettings({ ...settings, defaultCwd: e.target.value })}
                  onBlur={(e) => void update({ defaultCwd: e.target.value })}
                />
              </div>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.launchAtLogin}
                onChange={(e) => void update({ launchAtLogin: e.target.checked })}
              />
              <span /> Launch at login
            </label>
            <p>Commands run as argv without a shell. Consequential actions always pause for approval.</p>
          </aside>
        )}
        <form className="composer" onSubmit={submit}>
          <div className="prompt-orb">
            <Sparkles size={18} />
          </div>
          <textarea
            ref={input}
            rows={1}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Ask Buddy to inspect files, run a command, or open a page…"
          />
          <button className="run" aria-label="Run" disabled={!prompt.trim()}>
            <Play size={16} fill="currentColor" />
          </button>
        </form>
        <div className="suggestions">
          <button onClick={() => setPrompt('Show disk usage')}>
            <span>Disk space</span>
          </button>
          <button onClick={() => setPrompt('List files')}>
            <span>List files</span>
          </button>
          <button onClick={() => setPrompt('Show running processes')}>
            <span>Processes</span>
          </button>
          <button onClick={() => setPrompt('Run git status')}>
            <span>Git status</span>
          </button>
        </div>
        <div className="workspace">
          <nav className="history">
            <div className="section-label">
              <History size={13} /> Recent
            </div>
            {tasks.length === 0 ? (
              <div className="empty-history">Your completed work will appear here.</div>
            ) : (
              tasks.map((item) => (
                <button
                  className={item.id === selected ? 'task selected' : 'task'}
                  key={item.id}
                  onClick={() => setSelected(item.id)}
                >
                  <span className={`status ${item.status}`}>
                    <StatusIcon status={item.status} />
                  </span>
                  <span className="task-copy">
                    <strong>{item.prompt}</strong>
                    <small>
                      <Clock3 size={10} />{' '}
                      {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
                      {labels[item.status]}
                    </small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))
            )}
          </nav>
          <article className="detail">
            {task ? (
              <>
                <div className="detail-head">
                  <div>
                    <span className={`pill ${task.status}`}>
                      <StatusIcon status={task.status} /> {labels[task.status]}
                    </span>
                    <h2>{task.prompt}</h2>
                  </div>
                  {active.has(task.status) && (
                    <button className="stop" onClick={() => void window.buddy.cancel(task.id)}>
                      <CircleStop size={15} /> Stop
                    </button>
                  )}
                </div>
                {task.approval && (
                  <div className="approval">
                    <div className="approval-icon">
                      <AlertTriangle size={20} />
                    </div>
                    <div>
                      <strong>Approval required</strong>
                      <p>{task.approval.reason}</p>
                      <code>{describe(task.approval.call)}</code>
                      <div className="approval-actions">
                        <button className="deny" onClick={() => void window.buddy.approve(task.approval!.id, false)}>
                          Deny
                        </button>
                        <button className="allow" onClick={() => void window.buddy.approve(task.approval!.id, true)}>
                          Allow once
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="output" ref={output}>
                  {task.output.length ? (
                    task.output.map((line, i) => (
                      <div className="line" key={`${i}-${line}`}>
                        <span>{String(i + 1).padStart(2, '0')}</span>
                        <code>{line}</code>
                      </div>
                    ))
                  ) : (
                    <div className="waiting">
                      <LoaderCircle className="spin" /> Starting task…
                    </div>
                  )}
                  {task.error && (
                    <div className="error">
                      <AlertTriangle size={15} /> {task.error}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="empty">
                <div className="empty-orb">
                  <Sparkles />
                </div>
                <h2>Ready when you are</h2>
                <p>Try “Show disk usage” or “Run git status”.</p>
              </div>
            )}
          </article>
        </div>
        <footer>
          <span>
            <span className="online" /> Background service ready
          </span>
          <span>Outputs are bounded · secrets redacted</span>
        </footer>
      </section>
    </main>
  );
}
