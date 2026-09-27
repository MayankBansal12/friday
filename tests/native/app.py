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
entry = Gtk.Entry()
entry.set_placeholder_text('Input cancellation target')
box.pack_start(entry, False, False, 0)
entry.connect('changed', lambda e: Path(os.environ['FRIDAY_TEST_RESULT'] + '.text').write_text(e.get_text()))
w.show_all()
Gtk.main()
