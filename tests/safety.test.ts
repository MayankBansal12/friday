import { describe, expect, it } from 'vitest';
import { isConsequentialCommand } from '../electron/friday-extension.js';

describe('Friday safety gate', () => {
  it.each(['sudo apt update', 'rm -rf old-folder', 'git push origin main', 'npm publish', 'shutdown now'])(
    'requires confirmation for %s',
    (command) => expect(isConsequentialCommand(command)).toBe(true),
  );

  it.each(['ls -la', 'git status', 'curl https://example.com', 'npm test', 'mkdir notes'])(
    'allows ordinary work for %s',
    (command) => expect(isConsequentialCommand(command)).toBe(false),
  );
});
