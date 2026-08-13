import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { shell, type BrowserWindow } from 'electron';
import { Key, Point, keyboard, mouse, screen } from '@nut-tree-fork/nut-js';

interface DesktopAction {
  action: 'click' | 'double_click' | 'right_click' | 'type' | 'key' | 'scroll' | 'open';
  x?: number;
  y?: number;
  text?: string;
  keys?: string[];
  amount?: number;
  target?: string;
}

const keyNames: Record<string, Key> = {
  ctrl: Key.LeftControl,
  control: Key.LeftControl,
  shift: Key.LeftShift,
  alt: Key.LeftAlt,
  super: Key.LeftSuper,
  meta: Key.LeftSuper,
  enter: Key.Enter,
  return: Key.Return,
  escape: Key.Escape,
  esc: Key.Escape,
  tab: Key.Tab,
  space: Key.Space,
  backspace: Key.Backspace,
  delete: Key.Delete,
  up: Key.Up,
  down: Key.Down,
  left: Key.Left,
  right: Key.Right,
  home: Key.Home,
  end: Key.End,
  pageup: Key.PageUp,
  pagedown: Key.PageDown,
};
for (const letter of 'abcdefghijklmnopqrstuvwxyz')
  keyNames[letter] = Key[letter.toUpperCase() as keyof typeof Key] as Key;
for (let number = 0; number <= 9; number++) keyNames[String(number)] = Key[`Num${number}` as keyof typeof Key] as Key;

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as DesktopAction;
}

export class DesktopBridge {
  readonly token = randomBytes(32).toString('hex');
  private server = createServer((request, response) => void this.handle(request, response));
  private port = 0;

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    mouse.config.autoDelayMs = 40;
    keyboard.config.autoDelayMs = 12;
  }

  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Desktop bridge failed to bind');
    this.port = address.port;
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  close() {
    this.server.close();
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.authorization !== `Bearer ${this.token}`) return json(response, 401, { error: 'Unauthorized' });
    try {
      if (request.method === 'GET' && request.url === '/screenshot')
        return json(response, 200, await this.screenshot());
      if (request.method === 'POST' && request.url === '/action')
        return json(response, 200, await this.action(await body(request)));
      return json(response, 404, { error: 'Not found' });
    } catch (error) {
      return json(response, 500, { error: error instanceof Error ? error.message : 'Desktop action failed' });
    }
  }

  private async screenshot() {
    const friday = this.getWindow();
    const wasVisible = friday?.isVisible() ?? false;
    if (wasVisible) {
      friday?.hide();
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
    const name = `friday-${randomBytes(8).toString('hex')}`;
    let path = '';
    try {
      path = await screen.capture(name, undefined, tmpdir());
      const [data, width, height] = await Promise.all([readFile(path), screen.width(), screen.height()]);
      return { data: data.toString('base64'), width, height };
    } finally {
      if (path) await rm(path, { force: true });
      if (wasVisible) friday?.showInactive();
    }
  }

  private async action(value: DesktopAction) {
    if (value.action === 'open') {
      if (!value.target) throw new Error('Missing URL or application target');
      if (/^https?:\/\//i.test(value.target)) await shell.openExternal(value.target);
      else await shell.openPath(value.target);
      return { message: `Opened ${value.target}` };
    }
    if (value.action === 'type') {
      if (value.text === undefined) throw new Error('Missing text');
      await keyboard.type(value.text);
      return { message: 'Typed text into the active application.' };
    }
    if (value.action === 'key') {
      const keys = (value.keys ?? []).map((name) => keyNames[name.toLowerCase()]);
      if (!keys.length || keys.some((key) => key === undefined))
        throw new Error(`Unsupported key combination: ${(value.keys ?? []).join('+')}`);
      await keyboard.pressKey(...keys);
      await keyboard.releaseKey(...[...keys].reverse());
      return { message: `Pressed ${(value.keys ?? []).join('+')}.` };
    }
    if (value.action === 'scroll') {
      const amount = Math.max(-20, Math.min(20, Math.round(value.amount ?? 0)));
      if (amount >= 0) await mouse.scrollDown(amount);
      else await mouse.scrollUp(-amount);
      return { message: `Scrolled ${amount >= 0 ? 'down' : 'up'}.` };
    }
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Error('Missing click coordinates');
    await mouse.setPosition(new Point(Math.round(value.x!), Math.round(value.y!)));
    if (value.action === 'double_click') await mouse.doubleClick(0);
    else if (value.action === 'right_click') await mouse.rightClick();
    else await mouse.leftClick();
    return { message: `${value.action.replace('_', ' ')} at ${Math.round(value.x!)}, ${Math.round(value.y!)}.` };
  }
}
