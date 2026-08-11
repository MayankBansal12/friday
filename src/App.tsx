import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, CircleStop, Clock3, Folder, LoaderCircle, Minus, Play, Settings, X } from 'lucide-react';
import type { BuddySettings, TaskRecord, TaskStatus, ToolCall } from '../electron/types';

const activeStatuses = new Set<TaskStatus>(['queued', 'planning', 'awaiting_approval', 'running']);
const statusLabels: Record<TaskStatus, string> = {
  queued: 'Queued',
  planning: 'Planning',
  awaiting_approval: 'Approval needed',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Stopped',
};
const suggestions = [
  ['Disk usage', 'Show disk usage'],
  ['List files', 'List files'],
  ['Processes', 'Show running processes'],
  ['Git status', 'Run git status'],
] as const;
const timeFormatter = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });

function describe(call: ToolCall) {
  if (call.kind === 'shell') return [call.command, ...call.args].join(' ');
  if (call.kind === 'browser') return call.url;
  return `${call.operation} ${call.path}`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function progressMessage(status: TaskStatus) {
  if (status === 'queued') return 'Queued';
  if (status === 'planning') return 'Preparing task';
  if (status === 'awaiting_approval') return 'Waiting for approval';
  if (status === 'running') return 'Running';
  return 'No output was produced';
}

function StatusIcon({ status, size = 14 }: { status: TaskStatus; size?: number }) {
  if (status === 'completed') return <Check aria-hidden="true" size={size} />;
  if (status === 'failed') return <X aria-hidden="true" size={size} />;
  if (status === 'cancelled') return <CircleStop aria-hidden="true" size={size} />;
  if (status === 'awaiting_approval') return <AlertTriangle aria-hidden="true" size={size} />;
  if (status === 'queued') return <Clock3 aria-hidden="true" size={size} />;
  return <LoaderCircle aria-hidden="true" className="spin" size={size} />;
}

export default function App() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selected, setSelected] = useState<string>();
  const [prompt, setPrompt] = useState('');
  const [settings, setSettings] = useState<BuddySettings>();
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [settingsError, setSettingsError] = useState<string>();
  const [savingSettings, setSavingSettings] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const output = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsPanel = useRef<HTMLElement>(null);
  const firstSetting = useRef<HTMLSelectElement>(null);
  const savedSettings = useRef<BuddySettings | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const [history, config] = await Promise.all([window.buddy.listTasks(), window.buddy.getSettings()]);
      setTasks(history);
      setSettings(config);
      savedSettings.current = config;
      setSelected((current) => (current && history.some((item) => item.id === current) ? current : history[0]?.id));
    } catch (error) {
      setLoadError(errorMessage(error, 'Linux Buddy could not load its local state.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const removeTaskListener = window.buddy.onTask((task) => {
      setTasks((current) =>
        [task, ...current.filter((item) => item.id !== task.id)].sort((a, b) => b.createdAt - a.createdAt),
      );
      setSelected((id) => id || task.id);
    });
    const removeFocusListener = window.buddy.onFocusInput(() => {
      setShowSettings(false);
      input.current?.focus();
    });
    return () => {
      window.clearTimeout(initialLoad);
      removeTaskListener();
      removeFocusListener();
    };
  }, [load]);

  const task = useMemo(() => tasks.find((item) => item.id === selected), [tasks, selected]);
  const outputLength = task?.output.length ?? 0;
  const taskStatus = task?.status;

  useEffect(() => {
    if (!output.current) return;
    output.current.scrollTop = output.current.scrollHeight;
  }, [outputLength, selected, taskStatus]);

  const closeSettings = useCallback(() => {
    setShowSettings(false);
    settingsButton.current?.focus();
  }, []);

  useEffect(() => {
    if (!showSettings) return;
    firstSetting.current?.focus();
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (settingsPanel.current?.contains(target) || settingsButton.current?.contains(target)) return;
      setShowSettings(false);
    };
    document.addEventListener('pointerdown', closeFromOutside);
    return () => document.removeEventListener('pointerdown', closeFromOutside);
  }, [showSettings]);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (showSettings) closeSettings();
      else void window.buddy.hide();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [closeSettings, showSettings]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || submitting) return;
    setActionError(undefined);
    setSubmitting(true);
    setPrompt('');
    try {
      const created = await window.buddy.submit(value);
      setSelected(created.id);
    } catch (error) {
      setPrompt(value);
      setActionError(errorMessage(error, 'The task could not be started.'));
      input.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  async function updateSettings(next: Partial<BuddySettings>) {
    if (!settings || savingSettings) return;
    const value = { ...settings, ...next };
    setSettings(value);
    setSettingsError(undefined);
    setSavingSettings(true);
    try {
      await window.buddy.updateSettings(next);
      savedSettings.current = value;
    } catch (error) {
      if (savedSettings.current) setSettings(savedSettings.current);
      setSettingsError(errorMessage(error, 'Settings could not be saved.'));
    } finally {
      setSavingSettings(false);
    }
  }

  async function cancelTask(id: string) {
    setActionError(undefined);
    try {
      await window.buddy.cancel(id);
    } catch (error) {
      setActionError(errorMessage(error, 'The task could not be stopped.'));
    }
  }

  async function resolveApproval(id: string, approved: boolean) {
    setActionError(undefined);
    try {
      await window.buddy.approve(id, approved);
    } catch (error) {
      setActionError(errorMessage(error, 'The approval response could not be sent.'));
    }
  }

  function fillSuggestion(value: string) {
    setPrompt(value);
    setActionError(undefined);
    input.current?.focus();
  }

  return (
    <main className="shell">
      <section className="buddy" aria-label="Linux Buddy">
        <header className="titlebar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              &gt;_
            </span>
            <strong>Linux Buddy</strong>
          </div>
          <div className="window-actions">
            <kbd className="shortcut">Ctrl ⇧ Space</kbd>
            <button
              ref={settingsButton}
              className="icon-button"
              type="button"
              aria-label="Settings"
              aria-controls="settings-panel"
              aria-expanded={showSettings}
              disabled={!settings}
              onClick={() => (showSettings ? closeSettings() : setShowSettings(true))}
            >
              <Settings aria-hidden="true" size={16} strokeWidth={1.8} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="Hide Linux Buddy"
              onClick={() => window.buddy.hide()}
            >
              <Minus aria-hidden="true" size={17} strokeWidth={1.8} />
            </button>
          </div>
        </header>

        {showSettings && settings && (
          <aside
            ref={settingsPanel}
            id="settings-panel"
            className="settings-panel"
            role="dialog"
            aria-labelledby="settings-title"
            aria-busy={savingSettings}
          >
            <div className="settings-heading">
              <div>
                <h2 id="settings-title">Settings</h2>
                <span>{savingSettings ? 'Saving…' : 'On this device'}</span>
              </div>
              <button className="icon-button" type="button" aria-label="Close settings" onClick={closeSettings}>
                <X aria-hidden="true" size={15} />
              </button>
            </div>
            <label className="field-label" htmlFor="provider">
              Provider
            </label>
            <select
              ref={firstSetting}
              id="provider"
              value={settings.provider}
              disabled={savingSettings}
              onChange={(event) => void updateSettings({ provider: event.target.value as BuddySettings['provider'] })}
            >
              <option value="demo">Demo (offline)</option>
              <option value="codex">Codex CLI</option>
            </select>

            <label className="field-label" htmlFor="working-directory">
              Working directory
            </label>
            <div className="field-with-icon">
              <Folder aria-hidden="true" size={14} />
              <input
                id="working-directory"
                value={settings.defaultCwd}
                disabled={savingSettings}
                spellCheck="false"
                onChange={(event) => setSettings({ ...settings, defaultCwd: event.target.value })}
                onBlur={(event) => void updateSettings({ defaultCwd: event.target.value })}
              />
            </div>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={settings.launchAtLogin}
                disabled={savingSettings}
                onChange={(event) => void updateSettings({ launchAtLogin: event.target.checked })}
              />
              <span>
                <strong>Launch at login</strong>
                <small>Start Linux Buddy when you sign in.</small>
              </span>
            </label>

            {settingsError && (
              <p className="settings-error" role="alert">
                {settingsError}
              </p>
            )}
            <p className="settings-note">Commands run without a shell. Changes pause for approval.</p>
          </aside>
        )}

        <section className="command-area" aria-label="New task">
          <form className="composer" onSubmit={submit}>
            <textarea
              ref={input}
              rows={1}
              value={prompt}
              autoFocus
              disabled={submitting}
              aria-label="Task or command"
              placeholder="Type a task or command"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button
              className="run"
              aria-label={submitting ? 'Starting task' : 'Run task'}
              disabled={!prompt.trim() || submitting}
            >
              {submitting ? (
                <LoaderCircle aria-hidden="true" className="spin" size={16} />
              ) : (
                <Play aria-hidden="true" size={14} fill="currentColor" />
              )}
            </button>
          </form>
          <div className="composer-meta">
            <div className="suggestions" aria-label="Example tasks">
              <span>Try</span>
              {suggestions.map(([label, value]) => (
                <button type="button" key={label} onClick={() => fillSuggestion(value)}>
                  {label}
                </button>
              ))}
            </div>
            <span className="enter-hint">
              <kbd>Enter</kbd> to run
            </span>
          </div>
          {actionError && (
            <div className="action-error" role="alert">
              <AlertTriangle aria-hidden="true" size={14} />
              <span>{actionError}</span>
              <button type="button" aria-label="Dismiss error" onClick={() => setActionError(undefined)}>
                <X aria-hidden="true" size={13} />
              </button>
            </div>
          )}
        </section>

        <div className="workspace">
          <nav className="history" aria-label="Task history">
            <div className="section-heading">
              <h2>Tasks</h2>
              {!loading && !loadError && <span>{tasks.length}</span>}
            </div>
            {loading ? (
              <div className="history-state">
                <LoaderCircle aria-hidden="true" className="spin" size={14} />
                Loading tasks
              </div>
            ) : loadError ? (
              <div className="history-state history-error">
                <span>Tasks unavailable</span>
                <button type="button" onClick={() => void load()}>
                  Retry
                </button>
              </div>
            ) : tasks.length === 0 ? (
              <div className="history-state">No tasks yet</div>
            ) : (
              tasks.map((item) => (
                <button
                  type="button"
                  className={item.id === selected ? 'task selected' : 'task'}
                  key={item.id}
                  aria-current={item.id === selected ? 'true' : undefined}
                  onClick={() => setSelected(item.id)}
                >
                  <span className={`status-icon ${item.status}`}>
                    <StatusIcon status={item.status} size={13} />
                  </span>
                  <span className="task-copy">
                    <strong>{item.prompt}</strong>
                    <small>
                      <time dateTime={new Date(item.createdAt).toISOString()}>
                        {timeFormatter.format(item.createdAt)}
                      </time>
                      <span aria-hidden="true">·</span>
                      {statusLabels[item.status]}
                    </small>
                  </span>
                </button>
              ))
            )}
          </nav>

          <article className="detail">
            {loading ? (
              <div className="empty-state">
                <LoaderCircle aria-hidden="true" className="spin" size={17} />
                <h2>Loading tasks</h2>
              </div>
            ) : loadError ? (
              <div className="empty-state error-state">
                <AlertTriangle aria-hidden="true" size={18} />
                <h2>Could not load local data</h2>
                <p>{loadError}</p>
                <button type="button" onClick={() => void load()}>
                  Try again
                </button>
              </div>
            ) : task ? (
              <>
                <header className="detail-head">
                  <div className="task-heading">
                    <div className="task-meta">
                      <span className={`status-label ${task.status}`} aria-live="polite">
                        <StatusIcon status={task.status} size={13} />
                        {statusLabels[task.status]}
                      </span>
                      <span aria-hidden="true">·</span>
                      <time dateTime={new Date(task.createdAt).toISOString()}>
                        {timeFormatter.format(task.createdAt)}
                      </time>
                      <span aria-hidden="true">·</span>
                      <span>{task.provider}</span>
                    </div>
                    <h1>{task.prompt}</h1>
                  </div>
                  {activeStatuses.has(task.status) && (
                    <button className="stop" type="button" onClick={() => void cancelTask(task.id)}>
                      <CircleStop aria-hidden="true" size={14} />
                      Stop
                    </button>
                  )}
                </header>

                {task.approval && (
                  <section className="approval" aria-labelledby="approval-title" aria-live="polite">
                    <AlertTriangle className="approval-icon" aria-hidden="true" size={18} />
                    <div className="approval-copy">
                      <h2 id="approval-title">Approval required</h2>
                      <p>{task.approval.reason}</p>
                      <code>{describe(task.approval.call)}</code>
                      <div className="approval-actions">
                        <button
                          className="deny"
                          type="button"
                          onClick={() => void resolveApproval(task.approval!.id, false)}
                        >
                          Deny
                        </button>
                        <button
                          className="allow"
                          type="button"
                          onClick={() => void resolveApproval(task.approval!.id, true)}
                        >
                          Allow once
                        </button>
                      </div>
                    </div>
                  </section>
                )}

                {task.error && (
                  <div className="task-error" role="alert">
                    <AlertTriangle aria-hidden="true" size={15} />
                    <div>
                      <strong>Task failed</strong>
                      <span>{task.error}</span>
                    </div>
                  </div>
                )}

                <section className="output-section" aria-label="Task output">
                  <div className="output-heading">
                    <h2>Output</h2>
                    <span>
                      {task.output.length
                        ? `${task.output.length} ${task.output.length === 1 ? 'line' : 'lines'}`
                        : 'Live'}
                    </span>
                  </div>
                  <div className="output" ref={output} tabIndex={0}>
                    {task.output.length ? (
                      task.output.map((line, index) => (
                        <div className="line" key={`${index}-${line}`}>
                          <span>{String(index + 1).padStart(2, '0')}</span>
                          <code>{line}</code>
                        </div>
                      ))
                    ) : (
                      <div className="waiting">
                        {activeStatuses.has(task.status) && task.status !== 'awaiting_approval' && (
                          <StatusIcon status={task.status} size={15} />
                        )}
                        <span>{progressMessage(task.status)}</span>
                      </div>
                    )}
                  </div>
                </section>
              </>
            ) : (
              <div className="empty-state">
                <h2>{tasks.length ? 'Select a task' : 'No tasks yet'}</h2>
                <p>
                  {tasks.length
                    ? 'Choose a task to inspect its output.'
                    : 'Enter a request above. Output and approvals will appear here.'}
                </p>
              </div>
            )}
          </article>
        </div>

        <footer className="statusbar">
          <span className="service-status">
            <span className="service-dot" /> Local service ready
          </span>
          <span>Changes pause for approval</span>
        </footer>
      </section>
    </main>
  );
}
