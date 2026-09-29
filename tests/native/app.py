import gi
import os
from pathlib import Path
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
w = Gtk.Window(title='Friday native smoke target')
w.set_default_size(900, 600)
w.set_position(Gtk.WindowPosition.CENTER)
w.connect('destroy', Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=40)
box.set_border_width(50)
w.add(box)
label = Gtk.Label(label='Friday desktop test: observe → highlight → click → verify')
box.pack_start(label, False, False, 0)
button = Gtk.Button(label='Open the demo')
button.set_size_request(600, 100)
box.pack_start(button, False, False, 0)
button.connect('button-press-event', lambda _b, e: print('BUTTON PRESS', e.button, e.x, e.y, flush=True))
button.connect('button-release-event', lambda _b, e: print('BUTTON RELEASE', e.button, e.x, e.y, flush=True))
def clicked(_button):
    button.set_label('Opened — verified')
    Path(os.environ['FRIDAY_TEST_RESULT']).write_text('clicked')
button.connect('clicked', clicked)
entry = Gtk.Entry(placeholder_text='Computer control test input')
box.pack_start(entry, False, False, 0)
entry.connect('changed', lambda e: Path(os.environ['FRIDAY_TEST_RESULT']).with_name('typed').write_text(e.get_text()))
entry.connect('activate', lambda e: Path(os.environ['FRIDAY_TEST_RESULT']).with_name('entered').write_text(e.get_text()))
menu_button = Gtk.MenuButton(label='Choose a demo option')
popup = Gtk.Menu()
choice = Gtk.MenuItem(label='Select this option')
verification = Gtk.Label(label='Verification code appears after selecting the option')
def selected(_choice):
    import secrets
    code = secrets.token_hex(3).upper()
    verification.set_text('Verification code: ' + code)
    Path(os.environ['FRIDAY_TEST_RESULT']).with_name('verification-code').write_text(code)
    Path(os.environ['FRIDAY_TEST_RESULT']).with_name('menu-result').write_text('selected')
choice.connect('activate', selected)
popup.append(choice)
choice.show()
menu_button.set_use_popover(False)
menu_button.set_popup(popup)
popup.connect('show', lambda _m: Path(os.environ['FRIDAY_TEST_RESULT']).with_name('menu-open').write_text('open'))
popup.connect('hide', lambda _m: Path(os.environ['FRIDAY_TEST_RESULT']).with_name('menu-open').unlink(missing_ok=True))
box.pack_start(menu_button, False, False, 0)
box.pack_start(verification, False, False, 0)
def geometry(*_args):
    import json
    if not w.get_window(): return
    items = {}
    for name, widget in [('button',button),('entry',entry),('menu',menu_button),('choice',choice)]:
        pos = widget.translate_coordinates(w, 0, 0)
        if pos:
            items[name] = {'x': pos[0]+widget.get_allocated_width()/2, 'y': pos[1]+widget.get_allocated_height()/2}
    Path(os.environ['FRIDAY_TEST_RESULT']).with_name('controls.json').write_text(json.dumps(items))
for widget in [w, button, entry, menu_button, choice]: widget.connect('size-allocate', geometry)
w.show_all()
Gtk.main()
