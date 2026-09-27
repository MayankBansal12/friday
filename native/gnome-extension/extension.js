import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { action, drawing, identifier, keyNames, mode, record, stagePoint } from './protocol.js';

const IFACE = `<node><interface name="dev.Friday.Desktop1">
<method name="Command"><arg type="s" direction="in" name="token"/><arg type="s" direction="in" name="command"/><arg type="s" direction="out" name="result"/></method>
<signal name="Event"><arg type="s" name="event"/></signal></interface></node>`;
const PATH = '/dev/Friday/Desktop';

export default class FridayDesktop extends Extension {
  enable() {
    this._alive = true;
    this._scene = 0;
    this._items = new Map();
    this._keys = new Set();
    this._buttons = new Set();
    this._timers = new Map();
    this._signals = [];
    this._compositingHeld = false;
    this._paintSerial = 0;
    this._paintError = null;
    const secret = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_config_dir(), 'friday-desktop', 'token']));
    const [, bytes] = secret.load_contents(null);
    this._token = new TextDecoder().decode(bytes).trim();
    if (!/^[0-9a-f]{64}$/.test(this._token)) throw new Error('Friday setup token is missing or invalid');
    const seat = Clutter.get_default_backend().get_default_seat();
    this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    this._area = new St.DrawingArea({ reactive: false, can_focus: false, visible: false });
    this._area.set_position(0, 0);
    this._area.set_size(global.screen_width, global.screen_height);
    Main.layoutManager.addTopChrome(this._area, {
      affectsInputRegion: false,
      affectsStruts: false,
      trackFullscreen: false,
    });
    this._area.connect('repaint', () => this._paint());
    this._area.connect('notify::visible', () => this._syncCompositing());
    this._area.connect('event', (_actor, event) => (this._mark ? this._event(event) : Clutter.EVENT_PROPAGATE));
    const connect = (obj, name, fn) => this._signals.push([obj, obj.connect(name, fn)]);
    connect(global.display, 'notify::focus-window', () => {
      this._invalidate();
      this._watchWindow();
    });
    connect(global.display, 'accelerator-activated', (_display, actionId) => {
      if (actionId === this._escapeAction) this._stop(true, 'escape');
    });
    this._watchWindow();
    connect(global.workspace_manager, 'active-workspace-changed', () => this._invalidate());
    connect(Main.layoutManager, 'monitors-changed', () => {
      this._stop(true, 'monitors_changed');
      this._area.set_size(global.screen_width, global.screen_height);
    });
    connect(Main.sessionMode, 'updated', () => {
      if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter) this._stop(true, 'locked');
    });
    connect(Main.overview, 'showing', () => this._stop(true, 'overview'));
    connect(global.stage, 'captured-event', (_stage, event) => this._event(event));
    this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
    this._dbus.export(Gio.DBus.session, PATH);
    this._name = Gio.bus_own_name_on_connection(
      Gio.DBus.session,
      'dev.Friday.Desktop',
      Gio.BusNameOwnerFlags.NONE,
      null,
      null,
    );
    this._lastPointer = global.get_pointer();
    this._pointerWatch = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
      const pointer = global.get_pointer();
      if (
        (this._observation || this._items.size) &&
        !this._busy &&
        !this._mark &&
        !this._confirmDialog &&
        Date.now() > (this._ignorePointerUntil ?? 0) &&
        pointer.some((v, i) => v !== this._lastPointer[i])
      ) {
        // Wayland application button events do not always reach Shell's stage handler.
        // Pointer motion can invalidate an input target without erasing the visual guide.
        if (pointer[2] !== this._lastPointer[2]) this._invalidate();
        else this._inputInvalidated = true;
      }
      this._lastPointer = pointer;
      return GLib.SOURCE_CONTINUE;
    });
    this._watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
      if (this._lease && Date.now() > this._deadline) this._stop(true, 'lease_expired');
      if (this._expires && Date.now() > this._expires) this._clear();
      if (this._captionExpires && Date.now() > this._captionExpires && !this._lease) this._clearCaption();
      return GLib.SOURCE_CONTINUE;
    });
  }

  disable() {
    this._alive = false;
    this._stop(true, 'extension_disabled');
    for (const [obj, id] of this._signals ?? []) obj.disconnect(id);
    this._signals = [];
    for (const [obj, id] of this._windowSignals ?? []) obj.disconnect(id);
    this._windowSignals = [];
    if (this._pointerWatch) GLib.source_remove(this._pointerWatch);
    this._pointerWatch = 0;
    if (this._watchdog) GLib.source_remove(this._watchdog);
    this._watchdog = 0;
    this._dbus?.unexport();
    this._dbus = null;
    if (this._name) Gio.bus_unown_name(this._name);
    this._name = 0;
    this._area?.destroy();
    this._area = null;
    this._syncCompositing();
    this._pointer = null;
    this._keyboard = null;
    this._token = null;
  }

  async CommandAsync([token, raw], invocation) {
    try {
      if (!this._alive || token !== this._token) throw new Error('Unauthorized Friday desktop client');
      if (raw.length > 131072) throw new Error('Command too large');
      const command = record(JSON.parse(raw));
      const result = await this._command(command, invocation.get_sender());
      invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(result)]));
    } catch (e) {
      invocation.return_value(new GLib.Variant('(s)', [JSON.stringify({ error: e.message, code: e.code })]));
    }
  }

  _display() {
    const monitors = Main.layoutManager.monitors;
    if (
      monitors.length !== 1 ||
      monitors[0].x !== 0 ||
      monitors[0].y !== 0 ||
      monitors[0].width !== 1920 ||
      monitors[0].height !== 1080 ||
      global.display.get_monitor_scale(0) !== 1
    )
      throw new Error('This demo expects the built-in 1920×1080 display at 100% scale');
    return { id: 'eDP-1:1920x1080:1', x: 0, y: 0, width: 1920, height: 1080, scale: 1 };
  }

  _focus() {
    const win = global.display.focus_window;
    if (!win) return '';
    const r = win.get_frame_rect();
    return `${win.get_id()}:${r.x},${r.y},${r.width},${r.height}`;
  }

  _check(command, sender) {
    if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter || Main.overview.visible)
      throw Object.assign(new Error('Desktop unavailable while locked or in overview'), {
        code: Main.overview.visible ? 'overview' : 'locked',
      });
    if (!this._lease || command.runId !== this._lease || sender !== this._owner || Date.now() > this._deadline)
      throw Object.assign(
        new Error(
          this._lastStop?.runId === command.runId
            ? `Desktop session ended: ${this._lastStop.reason}`
            : 'Desktop permission expired or was stopped',
        ),
        { code: this._lastStop?.runId === command.runId ? this._lastStop.reason : 'lease_expired' },
      );
    this._display();
  }

  async _command(c, sender) {
    if (c.op === 'caption') {
      if (sender !== this._captionOwner || c.runId !== this._captionRun) throw new Error('Caption permission expired');
      this._showCaption(String(c.text ?? '').slice(0, 220), c.finished === true);
      await this._waitForPresentation(this._caption);
      return { visible: true };
    }
    if (c.op === 'status')
      return {
        ready: true,
        protocolVersion: 3,
        presentation: this._presentation(),
        lastStop: this._lastStop ?? null,
        display: this._display(),
        annotations: this._items.size,
        marking: Boolean(this._mark),
        lastMark: this._lastMark ?? null,
        active: Boolean(this._lease),
        permission: this._grant ? { remaining: this._grant.remaining, expiresAt: this._grant.expiresAt } : null,
      };
    if (c.op === 'begin') {
      if (this._busy) throw new Error('Previous desktop operation is stopping; retry shortly');
      if (this._lease && sender !== this._owner) throw new Error('Another Friday client is using the desktop');
      this._display();
      if (Main.sessionMode.isLocked || Main.overview.visible)
        throw new Error('Unlock the desktop and leave overview first');
      this._stop(true, 'superseded');
      this._lease = identifier(c.runId);
      this._mode = mode(c.mode);
      this._request = typeof c.request === 'string' ? c.request.slice(0, 1200) : '';
      this._owner = sender;
      this._captionOwner = sender;
      this._captionRun = this._lease;
      this._deadline = Date.now() + 15000;
      this._armEscape();
      this._ownerWatch = Gio.bus_watch_name_on_connection(
        Gio.DBus.session,
        sender,
        Gio.BusNameWatcherFlags.NONE,
        null,
        () => this._stop(true, 'disconnected'),
      );
      return { ready: true, protocolVersion: 3 };
    }
    // stop is never placed behind capture/input work; it revokes the lease immediately.
    if (c.op === 'stop' || c.op === 'finish') {
      if ((!this._lease && !this._owner) || (sender === this._owner && (!c.runId || c.runId === this._lease)))
        this._stop(c.op !== 'finish', c.op === 'finish' ? 'completed' : 'user_stop');
      return { stopped: true };
    }
    this._check(c, sender);
    if (c.op === 'heartbeat') {
      this._deadline = Date.now() + 15000;
      return { alive: true };
    }
    if (c.op === 'clear') {
      if (c.forgetMark) this._lastMark = null;
      this._clear(c.ids);
      return { cleared: true };
    }
    if (c.op === 'observe') return this._observe(c, sender);
    if (c.op === 'confirm') return this._confirm(c, sender);
    if (c.op === 'mark') {
      if (this._mode === 'explain') throw new Error('Choose Guide or Act to mark the screen');
      if (this._busy) throw new Error('Wait for the current desktop operation');
      this._startMark();
      return { marking: true };
    }
    if (!this._observation || this._observation.scene !== this._scene || this._observation.focus !== this._focus())
      throw new Error('Observe again: the focused app or desktop changed');
    if (c.op === 'draw') {
      if (this._mode === 'explain') throw new Error('Choose Guide or Act to draw');
      const d = drawing(c, this._observation);
      if (d.replace) this._items.clear();
      for (const item of d.items) this._items.set(item.id, item);
      if (this._items.size > 64) {
        this._clear();
        throw new Error('Too many annotations');
      }
      this._expires = Date.now() + 30000;
      this._animatePointer();
      // Re-read the stage dimensions: this actor can be created during login.
      this._area.set_size(global.screen_width, global.screen_height);
      this._area.show();
      this._raiseOverlays();
      this._syncCompositing();
      const serial = this._paintSerial;
      this._area.queue_repaint();
      try {
        await this._waitForPresentation(this._area, serial);
        this._check(c, sender);
        if (!d.items.every((item) => this._items.has(item.id)))
          throw new Error('Desktop changed before the drawing appeared');
      } catch (error) {
        this._clear();
        throw error;
      }
      return { ids: [...this._items.keys()], expiresInMs: 30000, rendered: true };
    }
    if (c.op === 'action') {
      if (this._mode !== 'act') throw new Error('Desktop input requires Act mode');
      if (this._busy || this._mark) throw new Error('Finish the current desktop operation first');
      const a = action(c, this._observation);
      if (this._approvedAction !== JSON.stringify(a)) throw new Error('Approve this exact action first');
      this._approvedAction = null;
      if (this._usesGrant && this._grant) this._grant.remaining--;
      this._usesGrant = false;
      const observation = this._observation;
      this._observation = null;
      this._clear();
      this._busy = true;
      try {
        await this._input(a, observation, c, sender);
        return { message: `${a.action} completed. Observe again to verify.` };
      } finally {
        this._release();
        await this._wait(50);
        this._lastPointer = global.get_pointer();
        this._busy = false;
      }
    }
    throw new Error('Unknown desktop command');
  }

  _canGrant(a) {
    const win = global.display.focus_window;
    if (!win || !['click', 'scroll'].includes(a.action) || a.forceConfirmation) return false;
    const r = win.get_frame_rect();
    const [pointerX, pointerY] = global.get_pointer();
    if (a.action === 'scroll')
      return pointerX >= r.x && pointerY >= r.y && pointerX < r.x + r.width && pointerY < r.y + r.height;
    return a.x >= r.x && a.y >= r.y && a.x < r.x + r.width && a.y < r.y + r.height;
  }

  _animatePointer() {
    this._pulseStarted = Date.now();
    if (this._pulseTimer) return;
    this._pulseTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
      this._area?.queue_repaint();
      if (!this._alive || !this._items.size || Date.now() - this._pulseStarted > 3000) {
        this._pulseTimer = 0;
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  _confirm(c, sender) {
    if (this._inputInvalidated) throw new Error('Observe again: the pointer moved before input');
    if (this._mode !== 'act' || this._confirmDialog || this._busy) throw new Error('Desktop confirmation unavailable');
    const a = action(c.action, this._observation);
    if (!this._observation || this._observation.scene !== this._scene || this._observation.focus !== this._focus())
      throw new Error('Observe again: the focused app or desktop changed');
    const grant = this._grant;
    this._usesGrant = false;
    if (
      grant &&
      grant.runId === this._lease &&
      grant.focus === this._focus() &&
      grant.expiresAt > Date.now() &&
      grant.remaining > 0 &&
      this._canGrant(a)
    ) {
      this._approvedAction = JSON.stringify(a);
      this._usesGrant = true;
      return { approved: true, scoped: true, remaining: grant.remaining };
    }
    return new Promise((resolve) => {
      const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true });
      this._confirmDialog = dialog;
      dialog.contentLayout.add_child(
        new St.Label({ text: 'Friday wants to act on your desktop', style: 'font-size: 20px; font-weight: bold;' }),
      );
      const detail = new St.Label({
        text: `${this._request ? `Your request: ${this._request}\n\n` : ''}In “${global.display.focus_window?.get_title() || 'the active app'}”:\n${
          a.action === 'type'
            ? `Type: ${a.text}`
            : a.action === 'key'
              ? `Press ${a.keys.join(' + ')}`
              : a.action === 'scroll'
                ? `Scroll ${Math.abs(a.amount)} steps ${a.amount > 0 ? 'down' : 'up'}`
                : `${a.action === 'double_click' ? 'Double-click' : a.action === 'right_click' ? 'Right-click' : 'Click'} at (${Math.round(a.x)}, ${Math.round(a.y)})`
        }`,
        style: 'font-size: 14px;',
      });
      detail.clutter_text.line_wrap = true;
      dialog.contentLayout.add_child(detail);
      if (this._canGrant(a)) {
        const scope = new St.Label({
          text: `Optional permission: up to 5 clicks or scrolls, only in “${global.display.focus_window?.get_title() || 'this window'}”, for this request and at most 60 seconds. Typing and key presses still ask each time. Stop or Escape revokes it.`,
          style: 'font-size: 13px;',
        });
        scope.clutter_text.line_wrap = true;
        dialog.contentLayout.add_child(scope);
      }
      let timeout = 0;
      const done = (approved, bounded = false) => {
        if (this._confirmDialog !== dialog) return;
        if (timeout) GLib.source_remove(timeout);
        this._confirmDialog = null;
        this._dismissConfirmation = null;
        this._ignorePointerUntil = Date.now() + 250;
        dialog.close();
        try {
          this._check(c, sender);
        } catch {
          approved = false;
        }
        // Authorizes this exact validated payload once, inside Shell as well as in the host.
        this._approvedAction = approved ? JSON.stringify(a) : null;
        if (!approved) this._grant = null;
        if (approved && bounded && this._canGrant(a)) {
          this._grant = { runId: this._lease, focus: this._focus(), remaining: 5, expiresAt: Date.now() + 60000 };
          this._usesGrant = true;
        }
        resolve({ approved });
      };
      this._dismissConfirmation = done;
      dialog.setButtons([
        { label: 'Decline', action: () => done(false), key: Clutter.KEY_Escape },
        ...(this._canGrant(a) ? [{ label: 'Allow 5 clicks/scrolls · 60s', action: () => done(true, true) }] : []),
        { label: 'Allow once', action: () => done(true) },
      ]);
      timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 22000, () => {
        timeout = 0;
        done(false);
        return GLib.SOURCE_REMOVE;
      });
      if (!dialog.open()) done(false);
    });
  }

  async _observe(c, sender) {
    if (this._busy || this._mark) throw new Error('Finish the current desktop operation first');
    this._busy = true;
    this._clear();
    this._caption?.hide();
    const scene = this._scene;
    const focus = this._focus();
    const stream = Gio.MemoryOutputStream.new_resizable();
    try {
      const shooter = new Shell.Screenshot();
      await shooter.screenshot(false, stream);
      stream.close(null);
      this._check(c, sender);
      if (scene !== this._scene || focus !== this._focus())
        throw new Error('Desktop changed during capture; observe again');
      const display = this._display();
      const frame = global.display.focus_window?.get_frame_rect();
      this._inputInvalidated = false;
      this._observation = {
        id: GLib.uuid_string_random(),
        display,
        width: display.width,
        height: display.height,
        capturedAt: Date.now(),
        focus,
        scene,
      };
      return {
        ...this._observation,
        windowTitle: global.display.focus_window?.get_title() ?? '',
        windowBounds: frame ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height } : null,
        data: GLib.base64_encode(stream.steal_as_bytes().get_data()),
        lastMark:
          this._lastMark && Date.now() - this._lastMark.createdAt < 300000
            ? { ...this._lastMark, current: this._lastMark.focus === focus }
            : null,
      };
    } finally {
      if (!stream.is_closed()) stream.close(null);
      this._busy = false;
      if (this._lease) this._caption?.show();
    }
  }

  async _input(a, observation, command, sender) {
    const check = () => {
      this._check(command, sender);
      if (['type', 'key', 'scroll'].includes(a.action) && this._focus() !== observation.focus)
        throw new Error('The target window changed during input; stopped');
    };
    const pause = async (ms) => {
      await this._wait(ms);
      check();
    };
    check();
    if (['click', 'double_click', 'right_click'].includes(a.action)) {
      const p = stagePoint(a, observation);
      this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), p.x, p.y);
      await pause(40);
      const [actualX, actualY] = global.get_pointer();
      if (Math.abs(actualX - p.x) > 1 || Math.abs(actualY - p.y) > 1)
        throw new Error(
          'Pointer did not reach the observed target; no click was sent. Move it away from screen edges and observe again.',
        );
      const button = a.action === 'right_click' ? 3 : 1;
      for (let n = 0; n < (a.action === 'double_click' ? 2 : 1); n++) {
        check();
        this._buttons.add(button);
        this._pointer.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.PRESSED);
        await pause(30);
        this._pointer.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.RELEASED);
        this._buttons.delete(button);
        if (a.action === 'double_click') await pause(80);
      }
    } else if (a.action === 'key') {
      for (const name of a.keys) {
        check();
        const key = keyNames[name];
        this._keys.add(key);
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
      }
      await pause(30);
    } else if (a.action === 'type') {
      for (const char of a.text) {
        check();
        const key =
          char === '\n'
            ? keyNames.enter
            : char === '\t'
              ? keyNames.tab
              : Clutter.unicode_to_keysym(char.codePointAt(0));
        this._keys.add(key);
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
        this._keys.delete(key);
        await pause(8);
      }
    } else if (a.action === 'scroll') {
      for (let n = 0; n < Math.abs(Math.round(a.amount)); n++) {
        check();
        this._pointer.notify_discrete_scroll(
          GLib.get_monotonic_time(),
          a.amount > 0 ? Clutter.ScrollDirection.DOWN : Clutter.ScrollDirection.UP,
          Clutter.ScrollSource.WHEEL,
        );
        await pause(30);
      }
    }
  }

  _wait(ms) {
    return new Promise((resolve) => {
      const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        this._timers.delete(id);
        resolve();
        return GLib.SOURCE_REMOVE;
      });
      this._timers.set(id, resolve);
    });
  }

  _release() {
    for (const key of [...(this._keys ?? [])].reverse())
      this._keyboard?.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
    for (const button of this._buttons ?? [])
      this._pointer?.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.RELEASED);
    this._keys?.clear();
    this._buttons?.clear();
  }

  _stop(clear = true, reason = 'user_stop') {
    const runId = this._lease;
    if (runId && !['completed', 'superseded'].includes(reason))
      this._dbus?.emit_signal(
        'Event',
        new GLib.Variant('(s)', [JSON.stringify({ event: 'stopped', runId, code: reason })]),
      );
    if (clear) this._clearCaption();
    this._grant = null;
    this._usesGrant = false;
    if (this._lease) this._lastStop = { runId: this._lease, reason, at: Date.now() };
    this._lease = null;
    this._observation = null;
    this._approvedAction = null;
    if (this._ownerWatch) Gio.bus_unwatch_name(this._ownerWatch);
    this._ownerWatch = 0;
    this._owner = null;
    if (!clear && this._captionOwner && !this._captionWatch)
      this._captionWatch = Gio.bus_watch_name_on_connection(
        Gio.DBus.session,
        this._captionOwner,
        Gio.BusNameWatcherFlags.NONE,
        null,
        () => this._clearCaption(),
      );
    this._dismissConfirmation?.(false);
    this._endMark();
    if (clear) this._clear();
    this._release();
    for (const [id, resolve] of this._timers ?? []) {
      GLib.source_remove(id);
      resolve();
    }
    this._timers?.clear();
    if (!this._items?.size) this._disarmEscape();
  }

  _clearCaption() {
    this._caption?.destroy();
    this._caption = null;
    this._captionLabel = null;
    this._replyButton = null;
    this._captionStop = null;
    this._captionOwner = null;
    this._captionRun = null;
    this._captionExpires = 0;
    if (this._captionWatch) Gio.bus_unwatch_name(this._captionWatch);
    this._captionWatch = 0;
    this._syncCompositing();
  }

  _syncCompositing() {
    // Fullscreen Wayland surfaces may be scanned out directly to the display.
    // Shell chrome alone does not prevent that. Match GNOME's own OSD lifecycle:
    // inhibit unredirect for as long as either Friday overlay is visible.
    const needed = Boolean(this._alive && (this._area?.visible || this._caption?.visible));
    if (needed === this._compositingHeld) return;
    if (needed) global.compositor.disable_unredirect();
    else global.compositor.enable_unredirect();
    this._compositingHeld = needed;
  }

  _raiseOverlays() {
    for (const actor of [this._area, this._caption]) {
      if (actor?.visible) actor.get_parent()?.set_child_above_sibling(actor, null);
    }
  }

  _presentation() {
    return {
      compositingHeld: this._compositingHeld,
      drawingMapped: this._area?.is_mapped() ?? false,
      drawingSize: this._area?.get_size() ?? [0, 0],
      captionMapped: this._caption?.is_mapped() ?? false,
      paintSerial: this._paintSerial,
      paintError: this._paintError,
    };
  }

  async _waitForPresentation(actor, afterPaint) {
    const deadline = Date.now() + 1500;
    while (this._alive && Date.now() < deadline) {
      await this._wait(32);
      if (actor !== this._area && actor !== this._caption) break;
      // Capture temporarily hides the caption; concurrent progress updates must
      // wait for it to return instead of turning a successful capture into Stop.
      if (!actor.visible && !(actor === this._caption && this._busy)) break;
      if (afterPaint !== undefined && this._paintError) throw new Error(`Drawing failed: ${this._paintError}`);
      if (
        this._compositingHeld &&
        actor.is_mapped() &&
        actor.get_paint_opacity() > 0 &&
        actor.width > 0 &&
        actor.height > 0 &&
        (afterPaint === undefined || this._paintSerial > afterPaint)
      )
        return;
    }
    throw new Error('Friday could not display its screen overlay. Clear it and try again.');
  }

  _showCaption(text, finished) {
    if (!this._caption) {
      this._caption = new St.BoxLayout({
        vertical: true,
        reactive: false,
        can_focus: false,
        style:
          'background-color: rgba(27,31,27,0.96); color: #fbfaf4; border: 1px solid #748042; border-radius: 18px; padding: 16px; spacing: 10px;',
        width: 420,
      });
      this._caption.connect('notify::visible', () => this._syncCompositing());
      this._captionTitle = new St.Label({
        text: 'Friday',
        style: 'font-size: 13px; font-weight: bold; color: #d9ff63;',
      });
      this._caption.add_child(this._captionTitle);
      this._captionLabel = new St.Label({ text, style: 'font-size: 15px; color: #fbfaf4;' });
      this._captionLabel.clutter_text.line_wrap = true;
      this._caption.add_child(this._captionLabel);
      const buttons = new St.BoxLayout({ style: 'spacing: 14px;' });
      this._replyButton = new St.Button({
        label: 'Reply',
        can_focus: false,
        style: 'background-color: #d9ff63; color: #1d1f1b; border-radius: 8px; padding: 6px 14px;',
      });
      this._replyButton.connect('clicked', () => {
        this._dbus?.emit_signal('Event', new GLib.Variant('(s)', [JSON.stringify({ event: 'reveal' })]));
        this._caption?.hide();
      });
      this._captionStop = new St.Button({
        label: 'Stop',
        can_focus: false,
        style: 'color: #fbfaf4; padding: 6px 14px;',
      });
      this._captionStop.connect('clicked', () => this._stop(true, 'user_stop'));
      buttons.add_child(this._replyButton);
      buttons.add_child(this._captionStop);
      this._caption.add_child(buttons);
      Main.layoutManager.addTopChrome(this._caption, {
        affectsInputRegion: true,
        affectsStruts: false,
        trackFullscreen: false,
      });
    }
    this._captionTitle.text = finished ? 'Friday' : 'Friday · Working';
    this._captionLabel.text = text || 'Friday is working…';
    this._captionStop.label = finished ? 'Clear' : 'Stop';
    this._captionExpires = Date.now() + 90000;
    const height = 240;
    const candidates = [
      { x: 1480, y: 820 },
      { x: 20, y: 820 },
      { x: 1480, y: 50 },
      { x: 20, y: 50 },
    ];
    const box =
      candidates.find((candidate) =>
        [...this._items.values()].every((item) => {
          const xs = [item.x, item.toX ?? item.x, item.x + (item.width ?? 0), ...(item.points?.map((p) => p.x) ?? [])];
          const ys = [item.y, item.toY ?? item.y, item.y + (item.height ?? 0), ...(item.points?.map((p) => p.y) ?? [])];
          return (
            Math.max(...xs) + 20 < candidate.x ||
            Math.min(...xs) - 20 > candidate.x + 420 ||
            Math.max(...ys) + 20 < candidate.y ||
            Math.min(...ys) - 20 > candidate.y + height
          );
        }),
      ) ?? candidates[0];
    this._caption.set_position(box.x, box.y);
    this._caption.show();
    this._raiseOverlays();
    this._syncCompositing();
  }

  _watchWindow() {
    for (const [obj, id] of this._windowSignals ?? []) obj.disconnect(id);
    this._windowSignals = [];
    const window = global.display.focus_window;
    if (window)
      for (const name of ['position-changed', 'size-changed', 'unmanaged'])
        this._windowSignals.push([window, window.connect(name, () => this._invalidate())]);
  }

  _armEscape() {
    if (this._escapeAction) return;
    this._escapeAction = global.display.grab_accelerator('Escape', Meta.KeyBindingFlags.NONE);
    if (this._escapeAction)
      Main.wm.allowKeybinding(Meta.external_binding_name_for_action(this._escapeAction), Shell.ActionMode.ALL);
  }

  _disarmEscape() {
    if (this._escapeAction) {
      Main.wm.allowKeybinding(Meta.external_binding_name_for_action(this._escapeAction), Shell.ActionMode.NONE);
      global.display.ungrab_accelerator(this._escapeAction);
    }
    this._escapeAction = 0;
  }

  _invalidate() {
    this._grant = null;
    this._scene++;
    this._observation = null;
    if (!this._mark) this._clear();
  }

  _clear(ids) {
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')))
      throw new Error('Invalid annotation IDs');
    if (ids) for (const id of ids) this._items.delete(id);
    else this._items?.clear();
    this._area?.queue_repaint();
    if (!this._items?.size) {
      if (!this._mark) this._area?.hide();
      this._expires = 0;
      if (this._pulseTimer) GLib.source_remove(this._pulseTimer);
      this._pulseTimer = 0;
      if (!this._lease) this._disarmEscape();
    }
  }

  _startMark() {
    this._clear();
    this._lastMark = null;
    this._mark = { points: [], focus: this._focus(), scene: this._scene };
    this._area.set_size(global.screen_width, global.screen_height);
    this._area.show();
    this._raiseOverlays();
    this._area.reactive = true;
    this._area.can_focus = true;
    this._grab = Main.pushModal(this._area, { actionMode: Shell.ActionMode.ALL });
    if (!this._grab || !(this._grab.get_seat_state() & Clutter.GrabState.POINTER)) {
      this._endMark();
      throw new Error('Could not enter drawing mode');
    }
    this._area.grab_key_focus();
    this._area.queue_repaint();
    this._markTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30000, () => {
      this._markTimer = 0;
      this._endMark();
      return GLib.SOURCE_REMOVE;
    });
  }

  _endMark() {
    this._mark = null;
    if (this._markTimer) GLib.source_remove(this._markTimer);
    this._markTimer = 0;
    if (this._grab) Main.popModal(this._grab);
    this._grab = null;
    if (this._area) {
      this._area.reactive = false;
      this._area.can_focus = false;
      if (!this._items.size) this._area.hide();
      this._area.queue_repaint();
    }
  }

  _event(event) {
    const type = event.type();
    if (
      type === Clutter.EventType.KEY_PRESS &&
      event.get_key_symbol() === Clutter.KEY_Escape &&
      (this._lease || this._items.size || this._mark)
    ) {
      this._stop(true, 'escape');
      return Clutter.EVENT_STOP;
    }
    if (!this._mark) {
      if (
        !this._busy &&
        !this._confirmDialog &&
        [Clutter.EventType.BUTTON_PRESS, Clutter.EventType.SCROLL, Clutter.EventType.KEY_PRESS].includes(type)
      )
        this._invalidate();
      return Clutter.EVENT_PROPAGATE;
    }
    if ([Clutter.EventType.BUTTON_PRESS, Clutter.EventType.MOTION, Clutter.EventType.BUTTON_RELEASE].includes(type)) {
      const [x, y] = event.get_coords();
      const point = { x: Math.max(0, Math.min(1919, x)), y: Math.max(0, Math.min(1079, y)) };
      if (type === Clutter.EventType.BUTTON_PRESS) this._mark.points = [point];
      else if (this._mark.points.length && this._mark.points.length < 512) this._mark.points.push(point);
      if (type === Clutter.EventType.BUTTON_RELEASE && this._mark.points.length > 1) {
        this._lastMark = {
          id: GLib.uuid_string_random(),
          points: this._mark.points,
          focus: this._mark.focus,
          scene: this._mark.scene,
          createdAt: Date.now(),
          display: this._display(),
        };
        this._items.set('user-mark', {
          id: 'user-mark',
          kind: 'path',
          x: point.x,
          y: point.y,
          points: this._mark.points,
          color: '#ffcf70',
        });
        this._endMark();
        this._ignorePointerUntil = Date.now() + 200;
        this._expires = Date.now() + 30000;
      }
      this._area.queue_repaint();
      return Clutter.EVENT_STOP;
    }
    return [Clutter.EventType.KEY_PRESS, Clutter.EventType.KEY_RELEASE, Clutter.EventType.SCROLL].includes(type)
      ? Clutter.EVENT_STOP
      : Clutter.EVENT_PROPAGATE;
  }

  _paint() {
    const cr = this._area.get_context();
    try {
      this._paintError = null;
      cr.setLineWidth(4);
      cr.setLineCap(1);
      cr.setLineJoin(1);
      const items = [...this._items.values()];
      if (this._mark) {
        cr.setSourceRGBA(0.05, 0.08, 0.12, 0.15);
        cr.paint();
        items.push({ kind: 'label', x: 650, y: 65, text: 'Draw around something · release to finish · Esc to stop' });
        if (this._mark.points.length > 1) items.push({ kind: 'path', points: this._mark.points });
      }
      for (const a of items) {
        const color = a.color ?? '#70e3cd';
        const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
        cr.setSourceRGBA(...rgb, a.kind === 'highlight' ? 0.24 : 0.96);
        if (a.kind === 'ellipse') {
          cr.save();
          cr.translate(a.x + a.width / 2, a.y + a.height / 2);
          cr.scale(a.width / 2, a.height / 2);
          cr.arc(0, 0, 1, 0, Math.PI * 2);
          cr.restore();
          cr.stroke();
        } else if (a.kind === 'rectangle' || a.kind === 'highlight') {
          cr.rectangle(a.x, a.y, a.width, a.height);
          if (a.kind === 'highlight') cr.fill();
          else cr.stroke();
        } else if (a.kind === 'arrow') {
          cr.moveTo(a.x, a.y);
          cr.lineTo(a.toX, a.toY);
          cr.stroke();
          const angle = Math.atan2(a.toY - a.y, a.toX - a.x);
          for (const delta of [-0.5, 0.5]) {
            cr.moveTo(a.toX, a.toY);
            cr.lineTo(a.toX - 20 * Math.cos(angle + delta), a.toY - 20 * Math.sin(angle + delta));
            cr.stroke();
          }
          if (this._pulseTimer) {
            const progress = ((Date.now() - this._pulseStarted) % 1000) / 1000;
            cr.setSourceRGBA(...rgb, 0.65 * (1 - progress));
            cr.arc(a.toX, a.toY, 6 + progress * 18, 0, Math.PI * 2);
            cr.stroke();
          }
        } else if (a.kind === 'path') {
          a.points.forEach((p, i) => (i ? cr.lineTo(p.x, p.y) : cr.moveTo(p.x, p.y)));
          cr.stroke();
        }
        if (a.text) {
          cr.selectFontFace('Sans', 0, 1);
          cr.setFontSize(16);
          const w = Math.min(1800, cr.textExtents(a.text).width + 20);
          const x = Math.max(4, Math.min(a.x, 1916 - w));
          const y = Math.max(28, Math.min(a.y, 1070));
          cr.setSourceRGBA(0.04, 0.08, 0.11, 0.95);
          cr.rectangle(x - 6, y - 22, w, 30);
          cr.fill();
          cr.setSourceRGBA(1, 1, 1, 1);
          cr.moveTo(x + 4, y);
          cr.showText(a.text);
        }
      }
      this._paintSerial++;
    } catch (error) {
      this._paintError = error.message;
    } finally {
      cr.$dispose();
    }
  }
}
