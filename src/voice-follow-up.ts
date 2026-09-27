import type { TaskRecord } from '../electron/types';

const terminalStatuses = new Set<TaskRecord['status']>(['completed', 'failed', 'cancelled']);

/** Tracks the task started by voice so listening can resume after that task settles. */
export class VoiceFollowUp {
  private awaitingSubmission = false;
  private taskId?: string;

  beginSubmission() {
    this.awaitingSubmission = true;
    this.taskId = undefined;
  }

  submitted(taskId: string) {
    if (!this.awaitingSubmission) return;
    this.awaitingSubmission = false;
    this.taskId = taskId;
  }

  cancel() {
    this.awaitingSubmission = false;
    this.taskId = undefined;
  }

  taskChanged(task: TaskRecord) {
    // The first event can arrive before the submit IPC promise resolves.
    if (
      this.awaitingSubmission &&
      !this.taskId &&
      task.role !== 'child' &&
      ['queued', 'thinking'].includes(task.status)
    )
      this.taskId = task.id;
    if (task.id !== this.taskId || !terminalStatuses.has(task.status)) return false;
    this.cancel();
    return true;
  }
}
