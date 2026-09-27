import { describe, expect, it } from 'vitest';
import type { RunStatus, TaskRecord } from '../electron/types.js';
import { VoiceFollowUp } from '../src/voice-follow-up.js';

function task(id: string, status: RunStatus): TaskRecord {
  return { id, status, prompt: 'test', createdAt: 1, updatedAt: 1, steps: [] };
}

describe('voice follow-up listening', () => {
  it('resumes once when the voice-originated task completes', () => {
    const followUp = new VoiceFollowUp();
    followUp.beginSubmission();
    followUp.submitted('voice-task');

    expect(followUp.taskChanged(task('voice-task', 'thinking'))).toBe(false);
    expect(followUp.taskChanged(task('voice-task', 'completed'))).toBe(true);
    expect(followUp.taskChanged(task('voice-task', 'completed'))).toBe(false);
  });

  it('ignores other tasks and handles a thinking event before submit resolves', () => {
    const followUp = new VoiceFollowUp();
    followUp.beginSubmission();

    expect(followUp.taskChanged(task('voice-task', 'thinking'))).toBe(false);
    expect(followUp.taskChanged(task('typed-task', 'completed'))).toBe(false);
    expect(followUp.taskChanged(task('voice-task', 'failed'))).toBe(true);
  });

  it('does not resume after the user cancels follow-up listening', () => {
    const followUp = new VoiceFollowUp();
    followUp.beginSubmission();
    followUp.submitted('voice-task');
    followUp.cancel();

    expect(followUp.taskChanged(task('voice-task', 'completed'))).toBe(false);
  });
});

it('accepts the new parent thinking event before IPC resolves, ignoring children', () => {
  const followUp = new VoiceFollowUp();
  followUp.beginSubmission();
  expect(followUp.taskChanged({ ...task('child', 'thinking'), role: 'child' })).toBe(false);
  expect(followUp.taskChanged({ ...task('parent', 'thinking'), role: 'parent' })).toBe(false);
  expect(followUp.taskChanged({ ...task('child', 'completed'), role: 'child' })).toBe(false);
  expect(followUp.taskChanged({ ...task('parent', 'completed'), role: 'parent' })).toBe(true);
  followUp.submitted('parent');
  expect(followUp.taskChanged(task('parent', 'completed'))).toBe(false);
});
