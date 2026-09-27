#!/usr/bin/env python3
"""Private JSONL transport. Keeps a unique D-Bus owner alive for revocable input.
No screenshots or credentials are written to disk; stdout is protocol only.
"""
import json
import os
import sys
import gi
from gi.repository import Gio, GLib

config = os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config'))
try:
    with open(os.path.join(config, 'friday-desktop', 'token'), encoding='utf-8') as f:
        token = f.read().strip()
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
except Exception:
    print(json.dumps({'fatal': 'Friday desktop is not installed. Run pnpm desktop:install, then sign out and back in if requested.'}), flush=True)
    sys.exit(1)

loop = GLib.MainLoop()

def native_event(_connection, _sender, _path, _interface, _signal, parameters, *_unused):
    try:
        event = json.loads(parameters.unpack()[0])
        if event.get('event') in ['reveal', 'stopped']:
            print(json.dumps(event), flush=True)
    except (ValueError, TypeError):
        pass

connection.signal_subscribe('dev.Friday.Desktop', 'dev.Friday.Desktop1', 'Event', '/dev/Friday/Desktop', None, Gio.DBusSignalFlags.NONE, native_event)

def complete(conn, result, request_id):
    try:
        reply = conn.call_finish(result).unpack()[0]
        value = json.loads(reply)
    except Exception as e:
        value = {'error': 'GNOME desktop integration unavailable: ' + str(e)}
    print(json.dumps({'_requestId': request_id, **value}), flush=True)

def incoming(_source, condition):
    if condition & GLib.IOCondition.HUP:
        loop.quit()
        return False
    line = sys.stdin.readline()
    if not line:
        loop.quit()
        return False
    request_id = None
    try:
        if len(line) > 131072:
            raise ValueError('Command too large')
        value = json.loads(line)
        request_id = value.pop('_requestId')
        connection.call('dev.Friday.Desktop', '/dev/Friday/Desktop', 'dev.Friday.Desktop1', 'Command',
                        GLib.Variant('(ss)', (token, json.dumps(value))), GLib.VariantType.new('(s)'),
                        Gio.DBusCallFlags.NONE, 25000, None, complete, request_id)
    except Exception as e:
        print(json.dumps({'_requestId': request_id, 'error': str(e)}), flush=True)
    return True

# A binary unbuffered stdin avoids TextIOWrapper read-ahead hiding queued lines from GLib.
sys.stdin = open(0, 'rb', buffering=0)
GLib.io_add_watch(sys.stdin, GLib.IOCondition.IN | GLib.IOCondition.HUP, incoming)
loop.run()
