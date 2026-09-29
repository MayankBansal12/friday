#!/usr/bin/env python3
"""Launch Friday with the logged-in desktop's XWayland connection, including from SSH."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
env = dict(os.environ)
runtime = env.setdefault('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')
env.setdefault('DBUS_SESSION_BUS_ADDRESS', f'unix:path={runtime}/bus')
# A persistent remote terminal can retain the previous login's XWayland token.
# Prefer the logged-in desktop's current connection values on every launch.
# Read only display connection values; never print the session environment.
result = subprocess.run(['systemctl', '--user', 'show-environment'], env=env, capture_output=True, text=True)
if result.returncode == 0:
    for line in result.stdout.splitlines():
        key, _, value = line.partition('=')
        if key in ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY']:
            env[key] = value
if not env.get('DISPLAY'):
    raise SystemExit('Friday needs the desktop XWayland display for fixed placement. Run this from your GNOME session.')
os.chdir(root)
command = [str(root / 'node_modules/.bin/electron'), '--no-sandbox', '--ozone-platform=x11', '.', *sys.argv[1:]]
os.execvpe(command[0], command, env)
