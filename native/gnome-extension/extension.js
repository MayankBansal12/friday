import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import St from 'gi://St';
import { classifyMark, paintAnnotations, strokeDuration } from './drawing.js';
import { ComputerControl } from './control.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { computerBatch, drawing, identifier, protocolVersion, record } from './protocol.js';

const IFACE = `<node><interface name="dev.Friday.Desktop1">
<method name="Command"><arg type="s" direction="in" name="token"/><arg type="s" direction="in" name="command"/><arg type="s" direction="out" name="result"/></method>
<signal name="Event"><arg type="s" name="event"/></signal></interface></node>`;
const PATH = '/dev/Friday/Desktop';

export default class FridayDesktop extends Extension {
  enable() {
    this._alive = true;
    this._scene = 0;
    this._items = new Map();
    this._timers = new Map();
    this._anims = new Map();
    this._signals = [];
    this._compositingHeld = false;
    this._paintSerial = 0;
    this._paintError = null;
    const secret = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_config_dir(), 'friday-desktop', 'token']));
    const [, bytes] = secret.load_contents(null);
    this._token = new TextDecoder().decode(bytes).trim();
    if (!/^[0-9a-f]{64}$/.test(this._token)) throw new Error('Friday setup token is missing or invalid');
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
    connect(global.display, 'accelerator-activated', (_display, actionId, _device, time) => {
      if (actionId === this._escapeAction) {
        if (this._control) this._control.escape(time);
        else this._stop(true, 'escape');
      }
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
      // Wayland application button events do not always reach Shell's stage handler.
      if (
        (this._observation || this._items.size) &&
        !this._busy &&
        !this._mark &&
        !this._control &&
        Date.now() > (this._ignorePointerUntil ?? 0) &&
        pointer[2] !== this._lastPointer[2]
      )
        this._invalidate();
      this._lastPointer = pointer;
      return GLib.SOURCE_CONTINUE;
    });
    this._watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
      if (this._lease && Date.now() > this._deadline) this._stop(true, 'lease_expired');
      if (this._expires && Date.now() > this._expires) this._clear();
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

  _companionWindow(pid) {
    return global
      .get_window_actors()
      .map((actor) => actor.meta_window)
      .find(
        (candidate) =>
          candidate.get_pid() === pid &&
          /linux.buddy|friday|electron/i.test(candidate.get_wm_class() || candidate.get_title() || ''),
      );
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
    if (c.op === 'place_companion') {
      if (!Number.isInteger(c.pid) || !['orb', 'tasks', 'quiet', 'bar', 'panel', 'details'].includes(c.layout))
        throw new Error('Invalid companion placement');
      const win = this._companionWindow(c.pid);
      if (!win) return { placed: false };
      const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
      const notch = ['quiet', 'bar', 'panel'].includes(c.layout);
      const width = Math.min(Math.max(Number(c.width) || 96, 76), Math.min(800, area.width - 24));
      const height = Math.min(Math.max(Number(c.height) || 96, notch ? 1 : 60), Math.min(850, area.height - 24));
      let x = ['orb', 'tasks'].includes(c.layout)
        ? area.x + area.width - width - 18
        : area.x + Math.round((area.width - width) / 2);
      // The notch surfaces hug the top of the usable screen; the renderer adds no top padding.
      let y = area.y + (notch ? 5 : 12);
      // A user drag offset applies only to notch surfaces and is clamped to the work area.
      if (notch && Number.isFinite(Number(c.notchOffsetX)) && Number.isFinite(Number(c.notchOffsetY))) {
        x = Math.min(Math.max(x + Number(c.notchOffsetX), area.x), area.x + area.width - width);
        if (c.anchor === 'bottom') {
          // Lower-half notches grow upward, keeping their 42px resting bar's bottom edge fixed
          // (mirrors electron/notch-placement.ts).
          const barTop = Math.min(Math.max(y + Number(c.notchOffsetY), area.y), area.y + area.height - 54);
          y = Math.max(area.y, barTop + 42 - height);
        } else y = Math.min(Math.max(y + Number(c.notchOffsetY), area.y), area.y + area.height - height);
      }
      win.move_resize_frame(false, x, y, width, height);
      return { placed: true, layout: c.layout, x, y, width, height };
    }
    // The companion's eyes follow the pointer; frame coordinates let the app place it relative to itself.
    if (c.op === 'pointer') {
      const [x, y] = global.get_pointer();
      const frame = Number.isInteger(c.pid) ? this._companionWindow(c.pid)?.get_frame_rect() : null;
      return { x, y, window: frame ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height } : null };
    }
    if (c.op === 'status')
      return {
        ready: true,
        protocolVersion,
        companionLayout: true,
        presentation: this._presentation(),
        lastStop: this._lastStop ?? null,
        display: this._display(),
        annotations: this._items.size,
        marking: Boolean(this._mark),
        lastMark: this._lastMark ?? null,
        active: Boolean(this._lease),
        controlling: Boolean(this._control),
        inputBlocked: this._control?.shield.visible ?? false,
        inputState: { keys: this._control?.keys.size ?? 0, buttons: this._control?.buttons.size ?? 0 },
      };
    if (c.op === 'begin') {
      if (this._busy) throw new Error('Previous desktop operation is stopping; retry shortly');
      if (this._lease && sender !== this._owner) throw new Error('Another Friday client is using the desktop');
      this._display();
      if (Main.sessionMode.isLocked || Main.overview.visible)
        throw new Error('Unlock the desktop and leave overview first');
      this._stop(true, 'superseded');
      this._lease = identifier(c.runId);
      this._owner = sender;
      this._deadline = Date.now() + 15000;
      this._armEscape();
      this._ownerWatch = Gio.bus_watch_name_on_connection(
        Gio.DBus.session,
        sender,
        Gio.BusNameWatcherFlags.NONE,
        null,
        () => this._stop(true, 'disconnected'),
      );
      return { ready: true, protocolVersion };
    }
    // stop is never placed behind capture work; it revokes the lease immediately.
    if (c.op === 'stop' || c.op === 'finish') {
      if ((!this._lease && !this._owner) || (sender === this._owner && (!c.runId || c.runId === this._lease)))
        this._stop(c.op !== 'finish', c.op === 'finish' ? 'completed' : 'user_stop');
      return { stopped: true };
    }
    this._check(c, sender);
    if (c.op === 'heartbeat') {
      this._deadline = Date.now() + (this._control ? 3000 : 15000);
      return { alive: true };
    }
    if (c.op === 'control_begin') {
      if (this._busy || this._mark || this._control) throw new Error('Desktop is already busy');
      if (Main.modalCount) throw new Error('Close the system dialog before computer control');
      try {
        this._control = new ComputerControl(this);
        this._companionPid = Number.isInteger(c.companionPid) ? c.companionPid : null;
        this._control.excludeCompanion();
        // Voice/typed requests can leave the companion focused. Restore an app
        // before the first observation; never raise/focus the pill mid-action.
        if (this._companionPid && global.display.focus_window?.get_pid() === this._companionPid) {
          const target = global.display
            .get_tab_list(Meta.TabList.NORMAL, global.workspace_manager.get_active_workspace())
            .find((win) => win.get_pid() !== this._companionPid && !win.minimized);
          if (!target) throw new Error('Open the app you want Friday to control first');
          target.activate(global.get_current_time());
          const deadline = Date.now() + 300;
          while (
            (!global.display.focus_window || global.display.focus_window.get_pid() === this._companionPid) &&
            Date.now() < deadline
          ) {
            await this._wait(20);
            this._check(c, sender);
          }
          if (!global.display.focus_window || global.display.focus_window.get_pid() === this._companionPid)
            throw new Error('Could not focus the target app; try again');
          this._control.block();
        }
        this._deadline = Date.now() + 3000;
        this._check(c, sender);
        return { controlling: true, inputPolicy: 'blocked-between-actions' };
      } catch (error) {
        this._stop(true, error.code || 'control_failed', error.message?.slice(0, 1000));
        throw error;
      }
    }
    if (c.op === 'control_end') {
      if (this._busy) throw new Error('Stop the active action before ending computer control');
      this._endControl();
      this._deadline = Date.now() + 15000;
      return { controlling: false };
    }
    if (c.op === 'act') {
      if (!this._control || this._busy) throw new Error('Computer control is not ready');
      let batch;
      try {
        if (!this._observation || this._observation.scene !== this._scene || this._observation.focus !== this._focus())
          throw new Error('Observe again: the focused app or desktop changed');
        batch = computerBatch(c, this._observation);
      } catch (error) {
        throw Object.assign(error, { code: 'invalid_action' });
      }
      const control = this._control;
      this._busy = true;
      this._invalidate();
      const started = Date.now();
      try {
        const result = await control.execute(batch.actions, () => {
          this._check(c, sender);
          if (Main.modalCount) throw new Error('System dialog opened; computer control stopped');
        });
        await this._wait(100);
        this._check(c, sender);
        return { executed: batch.actions.length, ...result, actionMs: Date.now() - started };
      } catch (error) {
        const failure = Object.assign(
          new Error(
            `Control action ${(control.actionIndex ?? 0) + 1} (${control.actionType ?? 'unknown'}): ${error.message}`.slice(
              0,
              1000,
            ),
          ),
          { code: error.code || 'control_failed' },
        );
        // A user stop may already have revoked this lease while execute awaited.
        if (this._lease === c.runId) this._stop(true, failure.code, failure.message);
        throw failure;
      } finally {
        control.release();
        this._busy = false;
        this._lastPointer = global.get_pointer();
      }
    }
    if (c.op === 'clear') {
      if (c.forgetMark) this._lastMark = null;
      this._clear(c.ids);
      return { cleared: true };
    }
    if (c.op === 'observe') return this._observe(c, sender);
    if (c.op === 'mark') {
      if (this._busy || this._control) throw new Error('Wait for the current desktop operation');
      this._startMark();
      return { marking: true };
    }
    if (!this._observation || this._observation.scene !== this._scene || this._observation.focus !== this._focus())
      throw new Error('Observe again: the focused app or desktop changed');
    if (c.op === 'draw') {
      const d = drawing(c, this._observation);
      if (d.replace) this._items.clear();
      for (const item of d.items) this._items.set(item.id, item);
      if (this._items.size > 64) {
        this._clear();
        throw new Error('Too many annotations');
      }
      this._expires = Date.now() + 30000;
      this._animatePointer();
      this._animateDraw(d.items.map((item) => item.id));
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
    throw new Error('Unknown desktop command');
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

  // New annotations reveal progressively (Rough Notation style) instead of popping in;
  // once every reveal finishes, one final repaint draws the settled, crisp artwork.
  _animateDraw(ids) {
    const now = Date.now();
    ids.forEach((id, i) => {
      const item = this._items.get(id);
      if (item) this._anims.set(id, { born: now + i * 140, duration: strokeDuration(item) });
    });
    this._area.queue_repaint();
    if (this._drawTimer) return;
    this._drawTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
      const tick = Date.now();
      for (const [id, anim] of this._anims) if (tick - anim.born >= anim.duration) this._anims.delete(id);
      this._area?.queue_repaint();
      if (!this._alive || !this._area || !this._anims.size) {
        this._drawTimer = 0;
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  async _observe(c, sender) {
    this._control?.excludeCompanion();
    if (this._busy || this._mark) throw new Error('Finish the current desktop operation first');
    this._busy = true;
    // Retain guidance across observations when the scene is unchanged. Hide only
    // for Shell's synchronous offscreen paint, not the asynchronous PNG encode.
    const areaVisible = this._area.visible;
    // Exclude the app pill only from the offscreen paint, keeping its client
    // mapped so captures do not change focus or blink the window.
    const companion =
      this._control && this._companionPid
        ? global
            .get_window_actors()
            .find(
              (actor) =>
                actor.meta_window.get_pid() === this._companionPid &&
                /linux.buddy|friday|electron/i.test(
                  actor.meta_window.get_wm_class() || actor.meta_window.get_title() || '',
                ),
            )
        : null;
    const companionVisible = companion?.visible;
    const scene = this._scene;
    const focus = this._focus();
    const stream = Gio.MemoryOutputStream.new_resizable();
    // Outside computer control the pointer is the user's: capture it so "this one" can be resolved.
    const pointer = this._control ? null : global.get_pointer();
    try {
      const shooter = new Shell.Screenshot();
      this._area.hide();
      companion?.hide();
      let capture;
      try {
        capture = shooter.screenshot(Boolean(pointer), stream);
      } finally {
        if (areaVisible) this._area.show();
        if (companionVisible) companion.show();
      }
      await capture;
      stream.close(null);
      this._check(c, sender);
      if (scene !== this._scene || focus !== this._focus())
        throw new Error('Desktop changed during capture; observe again');
      const display = this._display();
      const frame = global.display.focus_window?.get_frame_rect();
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
        pointer: pointer ? { x: pointer[0], y: pointer[1] } : null,
        data: GLib.base64_encode(stream.steal_as_bytes().get_data()),
        lastMark:
          this._lastMark && Date.now() - this._lastMark.createdAt < 300000
            ? { ...this._lastMark, current: this._lastMark.focus === focus }
            : null,
      };
    } finally {
      if (!stream.is_closed()) stream.close(null);
      this._busy = false;
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

  _stop(clear = true, reason = 'user_stop', error) {
    this._endControl();
    const runId = this._lease;
    if (runId && !['completed', 'superseded'].includes(reason))
      this._dbus?.emit_signal(
        'Event',
        new GLib.Variant('(s)', [JSON.stringify({ event: 'stopped', runId, code: reason, error })]),
      );
    if (this._lease) this._lastStop = { runId: this._lease, reason, error, at: Date.now() };
    this._lease = null;
    this._observation = null;
    if (this._ownerWatch) Gio.bus_unwatch_name(this._ownerWatch);
    this._ownerWatch = 0;
    this._owner = null;
    this._endMark();
    if (clear) this._clear();
    for (const [id, resolve] of this._timers ?? []) {
      GLib.source_remove(id);
      resolve();
    }
    this._timers?.clear();
    if (!this._items?.size) this._disarmEscape();
  }

  _endControl() {
    if (!this._control) return;
    const control = this._control;
    this._control = null;
    this._companionPid = null;
    control.end();
  }

  _syncCompositing() {
    // Fullscreen Wayland surfaces may be scanned out directly to the display.
    // Shell chrome alone does not prevent that. Match GNOME's own OSD lifecycle:
    // inhibit unredirect for as long as Friday's overlay is visible.
    const needed = Boolean(this._alive && this._area?.visible);
    if (needed === this._compositingHeld) return;
    if (needed) global.compositor.disable_unredirect();
    else global.compositor.enable_unredirect();
    this._compositingHeld = needed;
  }

  _raiseOverlays() {
    if (this._area?.visible) this._area.get_parent()?.set_child_above_sibling(this._area, null);
  }

  _presentation() {
    return {
      compositingHeld: this._compositingHeld,
      drawingMapped: this._area?.is_mapped() ?? false,
      drawingSize: this._area?.get_size() ?? [0, 0],
      paintSerial: this._paintSerial,
      paintError: this._paintError,
    };
  }

  async _waitForPresentation(actor, afterPaint) {
    const deadline = Date.now() + 1500;
    while (this._alive && Date.now() < deadline) {
      await this._wait(32);
      if (actor !== this._area || !actor.visible) break;
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
    this._scene++;
    this._observation = null;
    if (!this._mark) this._clear();
  }

  _clear(ids) {
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')))
      throw new Error('Invalid annotation IDs');
    if (ids)
      for (const id of ids) {
        this._items.delete(id);
        this._anims?.delete(id);
      }
    else {
      this._items?.clear();
      this._anims?.clear();
    }
    this._area?.queue_repaint();
    if (!this._items?.size) {
      if (!this._mark) this._area?.hide();
      this._expires = 0;
      if (this._pulseTimer) GLib.source_remove(this._pulseTimer);
      this._pulseTimer = 0;
      if (this._drawTimer) GLib.source_remove(this._drawTimer);
      this._drawTimer = 0;
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
    if (this._control) return this._control.event(event);
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
        // A stroke that reads as a rough-notation gesture becomes that annotation;
        // anything else stays freehand ink. Freehand keeps its attention gold.
        const gesture = classifyMark(this._mark.points);
        this._items.set(
          'user-mark',
          gesture
            ? { id: 'user-mark', ...gesture }
            : {
                id: 'user-mark',
                kind: 'path',
                x: point.x,
                y: point.y,
                points: this._mark.points,
                color: '#ffcf70',
              },
        );
        this._endMark();
        this._ignorePointerUntil = Date.now() + 200;
        this._expires = Date.now() + 30000;
        if (gesture) this._animateDraw(['user-mark']);
      }
      this._area.queue_repaint();
      return Clutter.EVENT_STOP;
    }
    return [Clutter.EventType.KEY_PRESS, Clutter.EventType.KEY_RELEASE, Clutter.EventType.SCROLL].includes(type)
      ? Clutter.EVENT_STOP
      : Clutter.EVENT_PROPAGATE;
  }

  // Eased 0..1 reveal per animating annotation; annotations without one render fully drawn.
  _drawProgress() {
    if (!this._anims?.size) return undefined;
    const progress = new Map();
    for (const [id, anim] of this._anims) {
      const t = Math.max(0, Math.min(1, (Date.now() - anim.born) / anim.duration));
      progress.set(id, t * (2 - t)); // ease-out so strokes settle instead of stopping dead
    }
    return progress;
  }

  _paint() {
    const cr = this._area.get_context();
    try {
      this._paintError = null;
      const items = [...this._items.values()];
      if (this._mark) {
        cr.setSourceRGBA(0.05, 0.08, 0.12, 0.15);
        cr.paint();
        items.push({
          kind: 'label',
          x: 650,
          y: 65,
          text: 'Circle, underline, scrub to highlight, X to cross out · release to finish · Esc to stop',
        });
        if (this._mark.points.length > 1) items.push({ kind: 'path', points: this._mark.points });
      }
      paintAnnotations(
        cr,
        items,
        global.screen_width,
        global.screen_height,
        this._pulseTimer ? ((Date.now() - this._pulseStarted) % 1000) / 1000 : undefined,
        this._drawProgress(),
      );
      this._paintSerial++;
    } catch (error) {
      this._paintError = error.message;
    } finally {
      cr.$dispose();
    }
  }
}
