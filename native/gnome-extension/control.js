import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { keyNames } from './protocol.js';

// The shield blocks local input between action bursts. It must be hidden while
// Mutter delivers virtual-device events: GNOME cannot selectively pass them
// through a grab. This is interference reduction, not an exclusive input lock.
export class ComputerControl {
  constructor(host) {
    this.host = host;
    this.keys = new Set();
    this.buttons = new Set();
    this.pendingKeys = new Map();
    this.escapeTimes = new Set();
    this.inputMethod = Main.inputMethod;
    this.originalNotify = this.inputMethod.notify_key_event;
    this.notify = (event, filtered) => {
      this.lastKeyReplyAt = Date.now();
      const id = this.keyId(event.get_time(), event.type() === Clutter.EventType.KEY_PRESS);
      const pending = this.pendingKeys.get(id) || 0;
      if (pending > 1) this.pendingKeys.set(id, pending - 1);
      else this.pendingKeys.delete(id);
      this.originalNotify.call(this.inputMethod, event, filtered);
    };
    const seat = Clutter.get_default_backend().get_default_seat();
    this.pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    this.keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    this.shield = new St.Widget({ reactive: true, can_focus: true, visible: false });
    this.shield.set_size(global.screen_width, global.screen_height);
    Main.layoutManager.addTopChrome(this.shield, {
      affectsInputRegion: true,
      affectsStruts: false,
      trackFullscreen: false,
    });
    this.active = true;
    this.block();
    this.inputMethod.notify_key_event = this.notify;
  }
  block() {
    if (!this.active) return;
    this.shield.show();
    this.shield.get_parent()?.set_child_above_sibling(this.shield, null);
    this.shield.grab_key_focus();
    this.host._raiseOverlays();
  }
  unblock() {
    if (global.stage.get_key_focus() === this.shield) global.stage.set_key_focus(null);
    this.shield.hide();
  }
  escape(time) {
    if (this.escapeTimes.has(time)) return;
    // A grabbed accelerator and captured-event may describe the same keypress.
    if (time && time === this.lastEscapeEvent) return;
    this.lastEscapeEvent = time;
    const now = Date.now();
    if (this.escapeAt && now - this.escapeAt < 1500) this.host._stop(true, 'escape');
    else {
      this.escapeAt = now;
      const previous = this.host._captionLabel?.text;
      this.host._showCaption('Press Esc again to stop computer control.', false);
      if (this.escapeTimer) GLib.source_remove(this.escapeTimer);
      this.escapeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
        this.escapeTimer = 0;
        if (this.active && this.host._captionLabel?.text === 'Press Esc again to stop computer control.')
          this.host._showCaption(previous || 'Working on your computer…', false);
        return GLib.SOURCE_REMOVE;
      });
    }
  }
  event(event) {
    if (!this.active) return Clutter.EVENT_PROPAGATE;
    if (
      event.type() === Clutter.EventType.KEY_PRESS &&
      event.get_key_symbol() === Clutter.KEY_Escape &&
      !this.escapeTimes.has(event.get_time())
    ) {
      this.escape(event.get_time());
      return Clutter.EVENT_STOP;
    }
    return this.shield.visible ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
  }
  release() {
    for (const key of [...this.keys].reverse()) this.key(key, false);
    for (const button of this.buttons)
      this.pointer.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.RELEASED);
    this.keys.clear();
    this.buttons.clear();
  }
  keyId(time, pressed) {
    return `${time}:${pressed}`;
  }
  key(key, pressed) {
    const us = GLib.get_monotonic_time();
    const time = Math.floor(us / 1000) % 0x100000000;
    if (this.inputMethod.currentFocus && this.inputMethod._context && this.inputMethod._currentSource) {
      const id = this.keyId(time, pressed);
      this.pendingKeys.set(id, (this.pendingKeys.get(id) || 0) + 1);
    }
    if (key === keyNames.escape) {
      this.escapeTimes.add(time);
      if (this.escapeTimes.size > 128) this.escapeTimes.delete(this.escapeTimes.values().next().value);
    }
    this.keyboard.notify_keyval(us, key, pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
  }
  async drain(pause) {
    const deadline = Date.now() + 300;
    // IM callbacks requeue keys asynchronously. Keep the shield open until those
    // replies have arrived and Shell has had a frame to dispatch their copies.
    do {
      await pause(35);
      if (!this.pendingKeys.size) {
        await pause(20);
        if (!this.pendingKeys.size && Date.now() - (this.lastKeyReplyAt || 0) >= 20) return;
      }
    } while (Date.now() < deadline);
    throw new Error('Keyboard delivery unconfirmed; computer control stopped');
  }
  end() {
    this.active = false;
    this.release();
    this.unblock();
    this.shield.destroy();
    if (this.escapeTimer) GLib.source_remove(this.escapeTimer);
    this.escapeTimer = 0;
    if (this.inputMethod.notify_key_event === this.notify) this.inputMethod.notify_key_event = this.originalNotify;
  }
  async execute(actions, check) {
    let openMs = 0;
    const pause = async (ms) => {
      await this.host._wait(ms);
      check();
      if (!this.active) throw new Error('Computer control stopped');
    };
    const move = async (p) => {
      this.pointer.notify_absolute_motion(GLib.get_monotonic_time(), p.x, p.y);
      await pause(35);
      const [x, y] = global.get_pointer();
      if (Math.abs(x - p.x) > 2 || Math.abs(y - p.y) > 2) throw new Error('Pointer did not reach target; stopped');
    };
    const button = (id, pressed) => {
      if (pressed) this.buttons.add(id);
      else this.buttons.delete(id);
      this.pointer.notify_button(
        GLib.get_monotonic_time(),
        id,
        pressed ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED,
      );
    };
    for (const a of actions) {
      check();
      if (!this.active) throw new Error('Computer control stopped');
      if (a.type === 'wait') {
        await pause(a.ms);
        continue;
      }
      // Keep long typing interruptible and limit each open input window.
      const chunks = a.type === 'type' ? a.text.match(/[^\n\t]{1,20}|[\n\t]/g) : [null];
      for (const chunk of chunks) {
        const focus = this.host._focus();
        if (a.type === 'type' && this.inputMethod.currentFocus && !/[\n\t]/.test(chunk)) {
          // Same path as GNOME's on-screen keyboard. No input opening or IBus
          // key filtering is needed to commit literal text to a Wayland entry.
          this.inputMethod.commit(chunk);
          await pause(20);
          if (this.host._focus() !== focus) throw new Error('Target window changed while typing; stopped');
          continue;
        }
        this.unblock();
        const opened = Date.now();
        try {
          await pause(20);
          if (['click', 'double_click', 'move', 'scroll'].includes(a.type)) await move(a);
          if (a.type === 'click' || a.type === 'double_click') {
            const id = { left: 1, middle: 2, right: 3 }[a.button];
            for (let n = 0; n < (a.type === 'double_click' ? 2 : 1); n++) {
              button(id, true);
              await pause(15);
              button(id, false);
              await pause(25);
            }
          } else if (a.type === 'drag') {
            await move(a.path[0]);
            button(1, true);
            for (const p of a.path.slice(1)) await move(p);
            button(1, false);
          } else if (a.type === 'type') {
            for (const c of chunk) {
              check();
              if (this.host._focus() !== focus) throw new Error('Target window changed while typing; stopped');
              const key =
                c === '\n' ? keyNames.enter : c === '\t' ? keyNames.tab : Clutter.unicode_to_keysym(c.codePointAt(0));
              this.keys.add(key);
              this.key(key, true);
              this.key(key, false);
              this.keys.delete(key);
              await pause(3);
            }
          } else if (a.type === 'keypress') {
            const sendsEscape = a.keys.some((k) => keyNames[k] === keyNames.escape);
            // A global Escape grab would swallow the model's own Escape as well.
            if (sendsEscape) this.host._disarmEscape();
            for (const k of a.keys) {
              this.keys.add(keyNames[k]);
              this.key(keyNames[k], true);
            }
            await pause(20);
          } else if (a.type === 'scroll') {
            for (let n = 0; n < a.amount; n++) {
              this.pointer.notify_discrete_scroll(
                GLib.get_monotonic_time(),
                Clutter.ScrollDirection[a.direction.toUpperCase()],
                Clutter.ScrollSource.WHEEL,
              );
              await pause(10);
            }
          }
          this.release();
          await this.drain(pause);
        } finally {
          this.release();
          openMs += Date.now() - opened;
          if (this.active) {
            this.host._armEscape();
            this.block();
          }
        }
      }
    }
    return { inputOpenMs: openMs };
  }
}
