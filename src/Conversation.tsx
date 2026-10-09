import ReactMarkdown from 'react-markdown';
import { Camera } from 'lucide-react';
import remarkGfm from 'remark-gfm';
import { activeStatuses, type FridayState, type TaskRecord } from '../electron/types';

const said = new Set(['scheduled', 'completed', 'interrupted', 'suppressed']);

/** Shown text, else what Friday said (or would have said, when speech was off), so no reply vanishes. */
function conversationReply(task: TaskRecord, state?: FridayState) {
  const actions = task.interactions?.flatMap((interaction) => interaction.actions) ?? [];
  const texts = (tool: string, statuses: Set<string>) =>
    actions
      .filter((action) => action.tool === tool && statuses.has(action.status))
      .map((action) => action.text)
      .filter(Boolean)
      .join('\n\n');
  return (
    texts('show_text_tool', new Set(['completed'])) ||
    task.response ||
    (state?.presentation.taskId === task.id ? state.presentation.text : '') ||
    texts('speak_tool', said)
  );
}

/** The same transcript and reply precedence at both sizes. */
export function Conversation({
  tasks,
  state,
  onApprove,
}: {
  tasks: TaskRecord[];
  state?: FridayState;
  onApprove?: (id: string, approved: boolean) => void;
}) {
  return (
    <div className="conversation-transcript" aria-label="Conversation transcript">
      {tasks.map((task) => {
        const reply = conversationReply(task, state);
        return (
          <article className="conversation-turn" key={task.id}>
            <div className="conversation-user">{task.prompt}</div>
            {Boolean(task.cameraFrames) && (
              <p className="conversation-camera">
                <Camera size={12} strokeWidth={1.5} />
                Looked through your camera
                {task.cameraFrames! > 1 ? ` · ${task.cameraFrames} frames` : ''}
              </p>
            )}
            {reply && (
              <div className="conversation-answer presence-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{reply}</ReactMarkdown>
              </div>
            )}
            {!reply && activeStatuses.has(task.status) && (
              <p role="status">{task.approval ? 'Waiting for your approval' : 'Working on it…'}</p>
            )}
            {task.error && <p role="alert">{task.error}</p>}
            {task.approval && onApprove && (
              <div className="presence-approval">
                <strong>{task.approval.title}</strong>
                <p>{task.approval.message}</p>
                <button onClick={() => onApprove(task.approval!.id, true)}>Allow</button>
                <button onClick={() => onApprove(task.approval!.id, false)}>Decline</button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
