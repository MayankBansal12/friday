import { describe, expect, it } from 'vitest';
import { openCodeGoModelOptions } from '../src/model-options.js';

describe('OpenCode Go model picker', () => {
  it('offers every model in the OpenCode Go provider catalog', () => {
    expect(openCodeGoModelOptions.map(({ value }) => value)).toEqual([
      'gpt-6-luna',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'glm-5.1',
      'glm-5.2',
      'glm-5.3',
      'glm-5.3-flash',
      'kimi-k2.7-code',
      'mimo-v2.5',
      'mimo-v2.5-pro',
      'minimax-m2.7',
      'minimax-m3',
      'qwen3.6-plus',
      'qwen3.7-max',
      'qwen3.7-plus',
    ]);
  });

  it('does not expose duplicate model IDs', () => {
    const values = openCodeGoModelOptions.map(({ value }) => value);
    expect(new Set(values).size).toBe(values.length);
  });
});
