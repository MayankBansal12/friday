#!/usr/bin/env python3
"""Install only Friday's GNOME 49 extension and its private local client token.
Run after pnpm desktop:build. Never restarts GNOME or logs the user out.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--stage', type=Path, help='Stage an isolated installation for testing; do not change GNOME settings')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
compiled = root / 'dist-electron/desktop-protocol.js'
if not compiled.exists():
    raise SystemExit('Run pnpm desktop:build first.')
if args.stage:
    data = args.stage / 'data'
    config = args.stage / 'config'
else:
    data = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share'))
    config = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config'))
uuid = 'friday-desktop@linux-buddy.local'
target = data / 'gnome-shell/extensions' / uuid
target.mkdir(parents=True, exist_ok=True)
for name in ['metadata.json', 'extension.js', 'drawing.js']:
    shutil.copy2(root / 'native/gnome-extension' / name, target / name)
shutil.copy2(compiled, target / 'protocol.js')
private = config / 'friday-desktop'
private.mkdir(mode=0o700, parents=True, exist_ok=True)
private.chmod(0o700)
token = private / 'token'
if not token.exists():
    fd = os.open(token, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(secrets.token_hex(32))
token.chmod(0o600)
print(f'Installed {target}')
if not args.stage:
    import gi
    from gi.repository import Gio
    settings = Gio.Settings.new('org.gnome.shell')
    enabled = settings.get_strv('enabled-extensions')
    if uuid not in enabled:
        settings.set_strv('enabled-extensions', [*enabled, uuid])
    disabled = settings.get_strv('disabled-extensions')
    if uuid in disabled:
        settings.set_strv('disabled-extensions', [x for x in disabled if x != uuid])
    Gio.Settings.sync()
    result = subprocess.run(['gdbus', 'call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell', '--method', 'org.gnome.Shell.Extensions.EnableExtension', uuid], capture_output=True, text=True)
    print(result.stdout.strip() or result.stderr.strip())
    if 'true' not in result.stdout:
        print('GNOME has not discovered the new extension in this session. Save your work, sign out once, and sign back in. Friday is already enabled for the next session.')
    else:
        print('Extension enabled. Run pnpm desktop:status to verify. Updates to an already loaded extension require signing out and back in.')
