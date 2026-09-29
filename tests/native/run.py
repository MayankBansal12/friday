#!/usr/bin/env python3
"""Run GNOME 49 + GTK on an isolated 1920x1080 Wayland display, never the user's session."""
import base64
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
if '--agent' in sys.argv and '--ui' not in sys.argv:
    sys.argv.append('--ui')
if '--inside' not in sys.argv:
    stage = Path(tempfile.mkdtemp(prefix='friday-smoke-'))
    subprocess.run([sys.executable, str(ROOT / 'scripts/install-desktop.py'), '--stage', str(stage)], check=True)
    driver = stage / 'data/gnome-shell/extensions/friday-test@linux-buddy.local'
    driver.mkdir(parents=True)
    (driver / 'metadata.json').write_text(json.dumps({'uuid': 'friday-test@linux-buddy.local', 'name': 'Friday isolated test driver', 'description': 'Test only', 'shell-version': ['49']}))
    shutil.copy2(ROOT / 'tests/native/driver.js', driver / 'extension.js')
    runtime = stage / 'runtime'; runtime.mkdir(mode=0o700)
    binaries = stage / 'bin'; binaries.mkdir()
    # Exercise the real local synthesizer without needing speakers in a headless seat.
    speaker = binaries / 'espeak-ng'
    speaker.write_text('#!/bin/sh\nexec /usr/bin/espeak-ng --stdout "$@" > "$FRIDAY_TEST_STAGE/auto-speech.wav"\n')
    speaker.chmod(0o700)
    env = dict(os.environ, PATH=str(binaries) + os.pathsep + os.environ['PATH'], XDG_RUNTIME_DIR=str(runtime), XDG_DATA_HOME=str(stage / 'data'), XDG_CONFIG_HOME=str(stage / 'config'), XDG_CACHE_HOME=str(stage / 'cache'), FRIDAY_ISOLATED_TEST='1', FRIDAY_TEST_STAGE=str(stage), FRIDAY_TEST_RESULT=str(stage / 'clicked'), WAYLAND_DISPLAY='wayland-friday-smoke', NO_AT_BRIDGE='1')
    print('Native smoke artifacts:', stage, flush=True)
    result = subprocess.run(['dbus-run-session', '--', sys.executable, __file__, '--inside', *[flag for flag in ['--agent', '--ui', '--computer'] if flag in sys.argv]], env=env)
    sys.exit(result.returncode)

import gi
from gi.repository import Gio, GLib
stage = Path(os.environ['FRIDAY_TEST_STAGE'])
subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', '["friday-desktop@linux-buddy.local", "friday-test@linux-buddy.local"]'], check=True)
subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'disable-user-extensions', 'false'], check=True)
subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'welcome-dialog-last-shown-version', '49.10'], check=True)
# A new headless seat starts exactly inside GNOME's hot-corner pointer barriers.
subprocess.run(['gsettings', 'set', 'org.gnome.desktop.interface', 'enable-hot-corners', 'false'], check=True)
log = open(stage / 'shell.log', 'w')
shell = subprocess.Popen(['gnome-shell', '--headless', '--wayland', '--virtual-monitor=1920x1080', '--wayland-display=wayland-friday-smoke'], stdout=log, stderr=log)
app = None
ui = None
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
token = (stage / 'config/friday-desktop/token').read_text()

def invoke(dest, path, interface, payload):
    params = GLib.Variant('(ss)', (token, json.dumps(payload))) if dest == 'dev.Friday.Desktop' else GLib.Variant('(s)', (json.dumps(payload),))
    reply = bus.call_sync(dest, path, interface, 'Command', params, GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 5000, None)
    value = json.loads(reply.unpack()[0])
    if value.get('error'):
        raise RuntimeError(value['error'])
    return value

def command(op, **kwargs):
    return invoke('dev.Friday.Desktop', '/dev/Friday/Desktop', 'dev.Friday.Desktop1', {'op': op, 'runId': 'smoke', **kwargs})
def driver(op, **kwargs):
    return invoke('org.gnome.Shell', '/dev/Friday/Test', 'dev.Friday.Test', {'op': op, **kwargs})
def capture(name):
    (stage / name).write_bytes(base64.b64decode(driver('capture')['data']))
def observe():
    # Match the app's lease renewal during this increasingly long native suite.
    command('heartbeat')
    result = command('observe')
    assert base64.b64decode(result['data']).startswith(b'\x89PNG')
    return {'observationId': result['id'], 'displayId': result['display']['id']}
def reject(op, fragment, **kwargs):
    try:
        command(op, **kwargs)
    except RuntimeError as error:
        assert fragment in str(error), str(error)
    else:
        raise AssertionError('Expected rejection: ' + op)

try:
    deadline = time.monotonic() + 20
    while True:
        try:
            command('status')
            if not driver('ready')['ready']: raise RuntimeError('GNOME startup in progress')
            break
        except Exception:
            if shell.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError((stage / 'shell.log').read_text()[-5000:])
            time.sleep(.3)
    driver('overview'); time.sleep(1)
    app = subprocess.Popen([sys.executable, str(ROOT / 'tests/native/app.py')], stdout=log, stderr=log)
    time.sleep(2)
    driver('overview'); time.sleep(.5)
    driver('fullscreen', enabled=True); time.sleep(.6)
    assert not command('status')['presentation']['compositingHeld'], 'Idle overlay keeps fullscreen compositing inhibited'
    command('begin')
    full_obs = observe()
    draw_reply = command('draw', **full_obs, items=[{'id': 'fullscreen-circle', 'kind': 'ellipse', 'x': 600, 'y': 400, 'width': 600, 'height': 120, 'color': '#ff0000'}, {'id': 'graph', 'kind': 'rectangle', 'x': 846, 'y': 100, 'width': 846, 'height': 453, 'color': '#facc15'}])
    assert draw_reply['rendered'], 'Drawing acknowledged without painting'
    assert command('status')['presentation']['compositingHeld'], 'Drawing did not inhibit fullscreen bypass'
    time.sleep(.4)
    fullscreen_state = driver('overlayState')
    capture('00-fullscreen-overlay.png')
    print('Fullscreen overlay:', fullscreen_state, flush=True)
    assert fullscreen_state['fullscreen'] and fullscreen_state['drawingMapped'], fullscreen_state
    from PIL import Image
    pixels = Image.open(stage / '00-fullscreen-overlay.png').convert('RGB')
    yellow_rows = [y for y in range(92, 109) if (lambda r, g, b: r > 220 and g > 160 and b < 60)(*pixels.getpixel((1400, y)))]
    assert sum(y - 1 not in yellow_rows for y in yellow_rows) == 2, 'Expected two separate yellow pen strokes in fullscreen'
    command('clear')
    assert not command('status')['presentation']['compositingHeld'], 'Clearing the drawing leaked fullscreen compositing inhibition'
    command('stop')
    assert not command('status')['presentation']['compositingHeld'], 'Stop leaked fullscreen compositing inhibition'
    command('begin')
    full_obs = observe()
    driver('blockPainting', enabled=True)
    reject('draw', 'could not display', **full_obs, items=[{'id': 'unpainted', 'kind': 'rectangle', 'x': 100, 'y': 100, 'width': 300, 'height': 200}])
    assert command('status')['annotations'] == 0, 'Unpainted drawing reported as active'
    driver('blockPainting', enabled=False)
    command('stop')
    assert not command('status')['presentation']['compositingHeld']
    print('PASS: fullscreen graph pixels, paint acknowledgement, drawing compositing lifetime, unpainted draw rejection', flush=True)
    driver('fullscreen', enabled=False); time.sleep(.6)
    command('begin')
    obs = observe(); capture('01-observe.png')
    driver('move', x=1050, y=580); time.sleep(.1)
    command('draw', **obs, items=[{'id': 'target', 'kind': 'ellipse', 'x': 560, 'y': 380, 'width': 800, 'height': 110}, {'id': 'pointer', 'kind': 'arrow', 'x': 400, 'y': 400, 'toX': 560, 'toY': 430, 'text': 'Open the demo'}])
    time.sleep(.3); capture('02-annotated.png')
    driver('move', x=1100, y=600); time.sleep(.1)
    assert command('status')['annotations'] == 2, 'Pointer motion erased guidance'
    assert driver('pick', x=960, y=430)['friday'] is False, 'Drawing intercepted input'
    driver('click', x=960, y=430); time.sleep(.3)
    capture('02b-after-click.png')
    assert (stage / 'clicked').exists(), 'Click did not reach GTK app through overlay'
    assert command('status')['annotations'] == 0, 'Stale drawing survived user input'
    print('PASS: capture, circle/arrow rendering, real GTK click-through, stale clearing', flush=True)
    obs = observe(); capture('03-guidance-before.png')
    command('draw', **obs, items=[
        {'id': 'circle', 'kind': 'circle', 'x': 60, 'y': 120, 'width': 280, 'height': 90},
        {'id': 'highlight', 'kind': 'highlight', 'x': 480, 'y': 120, 'width': 240, 'height': 60, 'text': 'Selected network'},
        {'id': 'arrow', 'kind': 'arrow', 'x': 900, 'y': 160, 'text': 'Choose your Wi-Fi network'},
        {'id': 'step', 'kind': 'step', 'x': 1320, 'y': 160, 'step': 2, 'text': 'Enter the password, then choose Connect'},
        {'id': 'underline', 'kind': 'underline', 'x': 60, 'y': 350, 'width': 260, 'height': 40, 'text': 'Check this value'},
        {'id': 'bracket', 'kind': 'bracket', 'x': 480, 'y': 330, 'width': 220, 'height': 100, 'text': 'Network settings'},
        {'id': 'note', 'kind': 'note', 'x': 80, 'y': 650, 'title': 'Almost connected', 'text': 'Choose your network and enter its password. The connection icon will change when you are online. You can keep using the app while this guide is on screen.'},
        {'id': 'edge', 'kind': 'note', 'x': 1919, 'y': 1079, 'title': 'At the screen edge', 'text': 'This note stays inside the display and wraps automatically.'},
    ])
    capture('03-guidance.png')
    from PIL import ImageChops
    before = Image.open(stage / '03-guidance-before.png').convert('RGB')
    after = Image.open(stage / '03-guidance.png').convert('RGB')
    for name, region in [('circle', (55, 115, 345, 215)), ('highlight', (480, 120, 720, 180)), ('arrow', (890, 150, 1050, 240)), ('step', (1300, 140, 1340, 180)), ('underline', (55, 385, 325, 400)), ('bracket', (685, 325, 710, 435)), ('note', (80, 650, 360, 850)), ('edge', (1630, 970, 1912, 1072))]:
        assert ImageChops.difference(before.crop(region), after.crop(region)).getbbox(), f'{name} absent from composed screen'
    assert all(abs(a - b) <= 6 for a, b in zip(after.getpixel((330, 656)), (251, 250, 244))), 'Note card is not warm paper'
    red_rows = [y for y in range(380, 401) if (lambda r, g, b: r > 160 and g < 110 and b < 120)(*after.getpixel((190, y)))]
    blue_columns = [x for x in range(690, 710) if (lambda r, g, b: b > 160 and r < 110 and g < 145)(*after.getpixel((x, 380)))]
    assert sum(y - 1 not in red_rows for y in red_rows) == 2, 'Underline is missing two distinct red strokes'
    assert sum(x - 1 not in blue_columns for x in blue_columns) == 2, 'Bracket is missing two distinct blue strokes'
    capture('03-guidance-repaint.png')
    repeated = Image.open(stage / '03-guidance-repaint.png').convert('RGB')
    assert not ImageChops.difference(after.crop((55, 115, 345, 215)), repeated.crop((55, 115, 345, 215))).getbbox(), 'Sketch changed between repaints'
    assert not driver('pick', x=100, y=700)['friday'], 'Note intercepted desktop input'
    print('PASS: visual vocabulary, wrapped notes, edge placement, stable sketches, note click-through', flush=True)
    driver('overview', show=True); time.sleep(.3)
    status = command('status')
    assert not status['active'] and status['lastStop']['reason'] == 'overview'
    driver('overview'); time.sleep(.4)
    command('begin'); observe()
    print('PASS: overview revocation and reason', flush=True)
    command('mark'); driver('press', x=600, y=450); driver('move', x=800, y=550); driver('release', x=850, y=430); time.sleep(.2)
    status = command('status'); capture('mark.png'); assert not status['marking'] and status['lastMark']['points']
    assert driver('pick', x=960, y=430)['friday'] is False
    command('stop'); assert command('status')['annotations'] == 0
    reject('observe', 'user_stop')
    print('PASS: explicit user marking, return to click-through, Stop/revocation', flush=True)
    command('begin'); observe()
    driver('key', key=0xff1b); time.sleep(.2)
    assert command('status')['active'] is False, 'Escape did not revoke the native lease'
    print('PASS: global Escape', flush=True)
    if '--ui' in sys.argv:
        app.terminate(); app.wait(timeout=5)
        (stage / 'clicked').unlink(missing_ok=True)
        app = subprocess.Popen([sys.executable, str(ROOT / 'tests/native/app.py')], stdout=log, stderr=log)
        time.sleep(1)
        executable = ROOT / 'release/linux-unpacked/linux-buddy'
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            debug_port = listener.getsockname()[1]
        # Seed quiet completed updates so the packaged React UI must actually expand
        # from a 96px circle, rather than only testing direct host layout calls.
        saved_state = stage / 'config/linux-buddy/tasks.json'
        saved_state.parent.mkdir(parents=True, exist_ok=True)
        saved_state.write_text(json.dumps({'version': 3, 'tasks': [], 'parentId': 'native-parent', 'sessions': [
            {'id': 'native-parent', 'role': 'parent', 'title': 'Friday', 'status': 'idle', 'createdAt': 1, 'updatedAt': 1},
            *[{'id': f'native-child-{i}', 'role': 'child', 'parentId': 'native-parent', 'title': title, 'status': 'completed', 'summary': 'Ready to discuss', 'createdAt': 1, 'updatedAt': 1} for i, title in enumerate(['Compare train options', 'Summarize release notes', 'Organize project notes'])]
        ]}))
        with open(stage / 'ui.log', 'w') as ui_log:
            display_env = driver('displayEnvironment')
            assert display_env.get('DISPLAY'), 'Isolated GNOME did not provide an XWayland display'
            ui_env = dict(os.environ, **display_env)
            ui = subprocess.Popen([str(executable), '--no-sandbox', '--ozone-platform=x11', f'--remote-debugging-port={debug_port}', '--remote-debugging-address=127.0.0.1'], cwd=ROOT, env=ui_env, stdout=ui_log, stderr=ui_log)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and ui.poll() is None:
                if any('friday —' in t.lower() or 'linux buddy' in t.lower() for t in driver('windows')['titles']): break
                time.sleep(.5)
            assert any('friday —' in t.lower() or 'linux buddy' in t.lower() for t in driver('windows')['titles']), 'Friday window did not map: ' + str(driver('windows')) + (stage / 'ui.log').read_text()
            time.sleep(1)
            assert ui.poll() is None, (stage / 'ui.log').read_text()
            capture('05-friday-ui.png')
            subprocess.run(['node', str(ROOT / 'tests/native/ui.mjs'), str(debug_port), 'ready'], env=ui_env, check=True, timeout=30)
            # Simulate the user's missing service, then recover, only inside this isolated desktop.
            subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', '["friday-test@linux-buddy.local"]'], check=True)
            time.sleep(.5)
            subprocess.run(['node', str(ROOT / 'tests/native/ui.mjs'), str(debug_port), 'unavailable'], env=ui_env, check=True, timeout=30)
            subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', '["friday-desktop@linux-buddy.local", "friday-test@linux-buddy.local"]'], check=True)
            time.sleep(.5)
            subprocess.run(['node', str(ROOT / 'tests/native/ui.mjs'), str(debug_port), 'reconnected'], env=ui_env, check=True, timeout=30)
            if '--computer' in sys.argv:
                subprocess.run(['node', str(ROOT/'tests/native/ui-control.mjs'), str(debug_port)], env=ui_env, check=True, timeout=550)
            if '--agent' in sys.argv:
                driver('fullscreen', enabled=True); time.sleep(.5)
                driver('fridayWindow', activate=True); time.sleep(.3)
                with open(stage / 'ui-agent.log', 'w') as agent_log:
                    agent = subprocess.Popen(['node', str(ROOT / 'tests/native/agent.mjs'), str(debug_port)], cwd=ROOT, stdout=agent_log, stderr=agent_log)
                    deadline = time.monotonic() + 390
                    try:
                        while agent.poll() is None and time.monotonic() < deadline:
                            if (stage / 'ui-drawing-ready').exists():
                                if not (stage / 'ui-drawing-geometry.json').exists():
                                    assert command('status')['annotations'] >= 1, 'Guidance vanished on task completion'
                                    # One UI: the Electron companion stays on screen while guiding; GNOME only draws.
                                    window_state = driver('fridayWindow')
                                    assert not window_state['minimized'] and window_state['showing'] and not window_state['skipTaskbar'], window_state
                                    capture('06-ui-drawing.png')
                                    geometry = driver('drawingGeometry')
                                    (stage / 'ui-drawing-geometry.json').write_text(json.dumps(geometry, indent=2))
                                    frame = geometry['frame']
                                    # Fixture button: 50px horizontal margins, 100px high, below the title/header.
                                    button = {'x': frame['x'] + 50, 'y': frame['y'] + (110 if geometry['fullscreen'] else 146), 'width': frame['width'] - 100, 'height': 100}
                                    center = (button['x'] + button['width'] / 2, button['y'] + button['height'] / 2)
                                    ellipses = [item for item in geometry['items'] if item['kind'] == 'ellipse']
                                    assert any(abs(item['x'] + item['width'] / 2 - center[0]) < 50 and abs(item['y'] + item['height'] / 2 - center[1]) < 30 and .85 * button['width'] < item['width'] < 1.3 * button['width'] and .7 * button['height'] < item['height'] < 2 * button['height'] for item in ellipses), f'Circle does not surround the main button: {geometry}'
                                    arrows = [item for item in geometry['items'] if item['kind'] == 'arrow']
                                    if arrows:
                                        assert any(button['x'] - 20 <= item['toX'] <= button['x'] + button['width'] + 20 and button['y'] - 20 <= item['toY'] <= button['y'] + button['height'] + 20 for item in arrows), f'Arrow misses main button: {geometry}'
                                if not (stage / 'ui-drawing-captured').exists() and command('status')['annotations'] == 0:
                                    window_state = driver('fridayWindow')
                                    if not window_state['minimized'] and window_state['showing'] and window_state['mapped'] and window_state['opacity'] == 255 and min(window_state['scale']) > .99:
                                        time.sleep(.3)
                                        capture('08-ui-returned.png')
                                        (stage / 'ui-returned-state.json').write_text(json.dumps(window_state, indent=2))
                                        (stage / 'ui-drawing-captured').write_text('guide cleared with Friday visible')
                            else:
                                if not (stage / '05b-working-fullscreen.png').exists() and command('status')['active']:
                                    capture('05b-working-fullscreen.png')
                                driver('move', x=1050 + int(time.monotonic() * 10) % 100, y=590)
                            time.sleep(.25)
                        assert agent.poll() == 0, (stage / 'ui-agent.log').read_text()[-6000:]
                        assert not (stage / 'clicked').exists(), 'Guidance unexpectedly clicked the target'
                        print((stage / 'ui-agent.log').read_text(), flush=True)
                        capture('07-ui-verified.png')
                    finally:
                        if agent.poll() is None: agent.terminate(); agent.wait(timeout=5)
            errors = (stage / 'ui.log').read_text()
            assert 'Error launching app' not in errors and 'Unable to find Electron app' not in errors and 'A JavaScript error occurred' not in errors, errors
            print('PASS: packaged Electron app launches with the native helper present', flush=True)
    from control import exercise
    exercise(command, driver, observe, stage)
    if '--computer' in sys.argv:
        subprocess.run(['node', str(ROOT/'tests/native/computer.mjs')], check=True, timeout=330)
    errors = (stage / 'shell.log').read_text()
    assert 'JS ERROR' not in errors and 'Extension friday-desktop' not in errors, errors[-4000:]
    print('PASS: GNOME integration smoke suite. Artifacts:', stage, flush=True)
finally:
    try: command('stop')
    except Exception: pass
    for process in [ui, app, shell]:
        if process and process.poll() is None:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
    log.close()
