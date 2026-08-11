import { app, BrowserWindow, globalShortcut, Notification, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskService } from '../task-service.js';
import { TaskStore } from '../store.js';
import type { BuddySettings } from '../types.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
let window: BrowserWindow | null = null,
  tray: Tray | null = null,
  quitting = false;
let service: TaskService;
function toggle() {
  if (!window) return;
  if (window.isVisible() && window.isFocused()) window.hide();
  else {
    window.show();
    window.focus();
    window.webContents.send('window:focus-input');
  }
}
function createWindow() {
  window = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: 560,
    minHeight: 540,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(root, 'dist-electron/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(root, 'dist/index.html'));
  window.once('ready-to-show', () => window?.show());
}
function createTray() {
  const iconPath = join(root, 'assets/icon.png');
  tray = new Tray(existsSync(iconPath) ? iconPath : nativeImage.createEmpty());
  tray.setToolTip('Linux Buddy');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Linux Buddy', click: toggle },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', toggle);
}
app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
app.whenReady().then(async () => {
  const settings: BuddySettings = {
    provider: process.env.LINUX_BUDDY_PROVIDER === 'codex' ? 'codex' : 'demo',
    defaultCwd: process.env.HOME || process.cwd(),
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
  };
  service = new TaskService(new TaskStore(join(app.getPath('userData'), 'tasks.json')), settings, (url) =>
    shell.openExternal(url),
  );
  await service.init();
  createWindow();
  createTray();
  if (!globalShortcut.register('CommandOrControl+Shift+Space', toggle))
    console.warn('Global shortcut Ctrl+Shift+Space is unavailable');
  service.on('task', (task) => {
    window?.webContents.send('task:changed', task);
    if ((task.status === 'completed' || task.status === 'failed') && Notification.isSupported())
      new Notification({
        title: task.status === 'completed' ? 'Buddy finished' : 'Buddy task failed',
        body: task.prompt,
      }).show();
  });
  ipcMain.handle('tasks:list', () => service.list());
  ipcMain.handle('tasks:submit', (_, prompt: string) => service.submit(prompt));
  ipcMain.handle('tasks:cancel', (_, id: string) => service.cancel(id));
  ipcMain.handle('tasks:approve', (_, id: string, approved: boolean) => service.resolveApproval(id, approved));
  ipcMain.handle('settings:get', () => service.getSettings());
  ipcMain.handle('settings:update', (_, value: Partial<BuddySettings>) => {
    if (typeof value.launchAtLogin === 'boolean') app.setLoginItemSettings({ openAtLogin: value.launchAtLogin });
    return service.updateSettings(value);
  });
  ipcMain.handle('window:hide', () => window?.hide());
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {});
