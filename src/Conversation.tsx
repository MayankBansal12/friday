import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { activeStatuses, type FridayState, type TaskRecord } from '../electron/types';

function conversationReply(task: TaskRecord, state?: FridayState) {
  return (
    task.interactions
      ?.flatMap((interaction) => interaction.actions)
      .filter((action) => action.tool === 'show_text_tool' && action.status === 'completed')
      .map((action) => action.text)
      .filter(Boolean)
      .join('\n\n') ||
    task.response ||
    (state?.presentation.taskId === task.id ? state.presentation.text : '')
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
