import { describe, expect, it } from 'vitest';
import { childPrompt, parentPrompt } from '../electron/agent-prompts';

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe('agent prompts', () => {
  it('teaches the parent its tools and when to use them', () => {
    for (const tool of [
      'desktop_observe',
      'camera_look',
      'camera_off',
      'draw_tool',
      'desktop_control',
      'session_actions',
      'interact',
      'show_text_tool',
    ])
      expect(parentPrompt).toContain(tool);
    expect(parentPrompt).toMatch(/observe again before drawing on or acting on the screen/);
    expect(parentPrompt).toMatch(/timing "together"/);
  });

  it('allows fixing a rejected reply without looping on failures', () => {
    expect(parentPrompt).toMatch(/rejected, nothing ran: fix what it lists and send it again/);
    expect(parentPrompt).not.toMatch(/Don't retry in the same request/);
    expect(parentPrompt).toMatch(/Never redo an action that already took effect/);
  });

  it('keeps permissions and roles', () => {
    for (const prompt of [parentPrompt, childPrompt]) {
      expect(prompt).toMatch(/approval before consequential actions/);
      expect(prompt).toMatch(/GUI input goes only through desktop_control/);
    }
    expect(parentPrompt).toMatch(/only part of Friday that talks to the user/);
    expect(childPrompt).toMatch(/no speech, drawing, screen access or UI/);
  });

  it('stays short', () => {
    expect(wordCount(parentPrompt)).toBeLessThan(500);
    expect(wordCount(childPrompt)).toBeLessThan(200);
  });
});
