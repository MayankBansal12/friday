// Installed ONLY into the isolated headless test session by tests/native/run.py.
// Never included by the desktop installer or application package.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
const XML =
  '<node><interface name="dev.Friday.Test"><method name="Command"><arg type="s" direction="in"/><arg type="s" direction="out"/></method></interface></node>';
export default class Driver extends Extension {
  enable() {
    if (!GLib.getenv('FRIDAY_ISOLATED_TEST')) throw new Error('Test driver requires an isolated test session');
    const seat = Clutter.get_default_backend().get_default_seat();
    this.pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    this.keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    this.dbus = Gio.DBusExportedObject.wrapJSObject(XML, this);
    this.dbus.export(Gio.DBus.session, '/dev/Friday/Test');
  }
  disable() {
    this.dbus?.unexport();
    this.dbus = null;
    this.pointer = null;
    this.keyboard = null;
  }
  async CommandAsync([raw], invocation) {
    try {
      const c = JSON.parse(raw);
      let result = {};
      if (c.op === 'ready') result = { ready: !Main.layoutManager._startingUp };
      if (c.op === 'markStatus') {
        const f = Main.extensionManager.lookup('friday-desktop@linux-buddy.local')?.stateObj;
        result = {
          mark: f?._mark,
          visible: f?._area.visible,
          reactive: f?._area.reactive,
          grabbed: f?._grab?.get_seat_state(),
        };
      }
      if (c.op === 'inputState') {
        const f = Main.extensionManager.lookup('friday-desktop@linux-buddy.local')?.stateObj;
        result = { keys: f?._keys.size, buttons: f?._buttons.size };
      }
      if (c.op === 'drawingGeometry') {
        const friday = Main.extensionManager.lookup('friday-desktop@linux-buddy.local')?.stateObj;
        const target = global
          .get_window_actors()
          .find((a) => a.meta_window.get_title() === 'Friday native smoke target');
        if (!target) throw new Error('No test target window');
        const { x, y, width, height } = target.meta_window.get_frame_rect();
        result = {
          items: [...friday._items.values()],
          frame: { x, y, width, height },
          fullscreen: target.meta_window.is_fullscreen(),
        };
      }
      if (c.op === 'windows') result = { titles: global.get_window_actors().map((a) => a.meta_window.get_title()) };
      if (c.op === 'fullscreen') {
        const target = global
          .get_window_actors()
          .find((a) => a.meta_window.get_title() === 'Friday native smoke target');
        if (!target) throw new Error('No test target');
        if (c.enabled) target.meta_window.make_fullscreen();
        else target.meta_window.unmake_fullscreen();
      }
      if (c.op === 'fridayWindow') {
        const target = global.get_window_actors().find((a) => a.meta_window.get_title().startsWith('Friday —'));
        if (!target) throw new Error('Friday window is missing');
        if (c.activate) target.meta_window.activate(global.get_current_time());
        result = {
          minimized: target.meta_window.minimized,
          skipTaskbar: target.meta_window.skip_taskbar,
          showing: target.meta_window.showing_on_its_workspace(),
          focused: global.display.focus_window === target.meta_window,
          mapped: target.is_mapped(),
          opacity: target.get_paint_opacity(),
          scale: [target.scale_x, target.scale_y],
        };
      }
      if (c.op === 'overlayState') {
        const friday = Main.extensionManager.lookup('friday-desktop@linux-buddy.local')?.stateObj;
        result = {
          presentation: friday?._presentation(),
          drawingMapped: friday?._area.is_mapped(),
          captionMapped: friday?._caption?.is_mapped(),
          captionVisible: friday?._caption?.visible,
          captionPosition: friday?._caption?.get_transformed_position(),
          captionSize: friday?._caption?.get_transformed_size(),
          fullscreen: global.display.focus_window?.is_fullscreen(),
        };
      }
      if (c.op === 'blockPainting') {
        const friday = Main.extensionManager.lookup('friday-desktop@linux-buddy.local')?.stateObj;
        if (c.enabled) {
          friday._testPaint = friday._paint;
          friday._paint = () => {};
        } else if (friday._testPaint) {
          friday._paint = friday._testPaint;
          delete friday._testPaint;
        }
      }
      if (c.op === 'overview') {
        if (c.show) Main.overview.show();
        else Main.overview.hide();
      }
      if (c.op === 'capture') {
        const stream = Gio.MemoryOutputStream.new_resizable();
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
        result = { data: GLib.base64_encode(stream.steal_as_bytes().get_data()) };
      }
      if (c.op === 'pick') {
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, c.x, c.y);
        result = {
          type: actor?.constructor.name,
          name: actor?.name,
          pointer: global.get_pointer(),
          focus: global.display.focus_window?.get_title(),
          friday: actor === Main.extensionManager.lookup('friday-desktop@linux-buddy.local')?.stateObj?._area,
        };
      }
      if (c.op === 'click' || c.op === 'move' || c.op === 'press' || c.op === 'release') {
        this.pointer.notify_absolute_motion(GLib.get_monotonic_time(), c.x, c.y);
        await new Promise((resolve) =>
          GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
          }),
        );
        if (c.op === 'click' || c.op === 'press')
          this.pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.PRESSED);
        await new Promise((resolve) =>
          GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
          }),
        );
        if (c.op === 'click' || c.op === 'release')
          this.pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED);
        result = {
          requested: c,
          pointer: global.get_pointer(),
          monitors: Main.layoutManager.monitors.map((m) => [m.x, m.y, m.width, m.height]),
        };
      }
      if (c.op === 'key') {
        this.keyboard.notify_keyval(GLib.get_monotonic_time(), c.key, Clutter.KeyState.PRESSED);
        this.keyboard.notify_keyval(GLib.get_monotonic_time(), c.key, Clutter.KeyState.RELEASED);
      }
      if (c.op === 'reveal') {
        const friday = Main.extensionManager.lookup('friday-desktop@linux-buddy.local')?.stateObj;
        if (!friday?._replyButton) throw new Error('No companion reply button');
        friday._replyButton.emit('clicked', 1);
      }
      if (c.op === 'approve') {
        // Invoke the actual dialog button, exactly as a user would, only in the isolated session.
        const friday = Main.extensionManager.lookup('friday-desktop@linux-buddy.local')?.stateObj;
        if (!friday?._confirmDialog) throw new Error('No approval dialog');
        const buttons = friday._confirmDialog.buttonLayout.get_children();
        if (c.bounded && buttons.length !== 3) throw new Error('Bounded permission was not offered');
        buttons.at(c.bounded ? -2 : -1).emit('clicked', 1);
      }
      invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(result)]));
    } catch (e) {
      invocation.return_value(new GLib.Variant('(s)', [JSON.stringify({ error: e.message })]));
    }
  }
}
