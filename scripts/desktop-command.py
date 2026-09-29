#!/usr/bin/env python3
"""Inspect installation without printing credentials or screen contents."""
import json
import os
import sys
from pathlib import Path
import gi
from gi.repository import Gio, GLib

config = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config'))
try:
    token = (config / 'friday-desktop/token').read_text().strip()
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    result = bus.call_sync('dev.Friday.Desktop', '/dev/Friday/Desktop', 'dev.Friday.Desktop1', 'Command', GLib.Variant('(ss)', (token, json.dumps({'op': 'status'}))), GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 5000, None)
    value = json.loads(result.unpack()[0])
    if value.get('protocolVersion') != 8:
        value['ready'] = False
        value['actionRequired'] = 'Save your work, sign out of GNOME and sign back in to activate the installed Friday update.'
    print(json.dumps(value, indent=2))
    sys.exit(0 if value.get('ready') else 1)
except Exception as e:
    print('Friday desktop is unavailable:', e)
    print('Run pnpm desktop:install. If just installed, save your work and sign out/back in once.')
    sys.exit(1)
