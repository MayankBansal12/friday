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
    result = subprocess.run(['dbus-run-session', '--', sys.executable, __file__, '--inside', *[flag for flag in ['--agent', '--ui'] if flag in sys.argv]], env=env)
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
shell = subprocess.Popen(['gnome-shell', '--headless', '--wayland', '--no-x11', '--virtual-monitor=1920x1080', '--wayland-display=wayland-friday-smoke'], stdout=log, stderr=log)
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

def approve_action(payload, bounded=False):
    command('heartbeat')
    # Send confirmation asynchronously, then operate the real dialog from the test-only driver.
    pending = {'done': False}
    def completed(conn, result):
        pending['reply'] = json.loads(conn.call_finish(result).unpack()[0]); pending['done'] = True
    bus.call('dev.Friday.Desktop', '/dev/Friday/Desktop', 'dev.Friday.Desktop1', 'Command', GLib.Variant('(ss)', (token, json.dumps({'op': 'confirm', 'runId': 'smoke', 'action': payload}))), GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 10000, None, completed)
    time.sleep(.6)
    driver('approve', bounded=bounded)
    context = GLib.MainContext.default()
    deadline = time.monotonic() + 5
    while not pending['done'] and time.monotonic() < deadline:
        context.iteration(False); time.sleep(.01)
    assert pending.get('reply', {}).get('approved'), pending
    time.sleep(.4)

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
    command('begin', mode='guide')
    full_obs = observe()
    draw_reply = command('draw', **full_obs, items=[{'id': 'fullscreen-circle', 'kind': 'ellipse', 'x': 600, 'y': 400, 'width': 600, 'height': 120, 'color': '#ff0000'}, {'id': 'graph', 'kind': 'rectangle', 'x': 846, 'y': 100, 'width': 846, 'height': 453, 'color': '#facc15'}])
    assert draw_reply['rendered'], 'Drawing acknowledged without painting'
    assert command('status')['presentation']['compositingHeld'], 'Drawing did not inhibit fullscreen bypass'
    command('caption', text='Friday is looking at your screen…')
    time.sleep(.4)
    fullscreen_state = driver('overlayState')
    capture('00-fullscreen-overlay.png')
    print('Fullscreen overlay:', fullscreen_state, flush=True)
    assert fullscreen_state['fullscreen'] and fullscreen_state['drawingMapped'] and fullscreen_state['captionMapped'], fullscreen_state
    from PIL import Image
    pixels = Image.open(stage / '00-fullscreen-overlay.png').convert('RGB')
    red, green, blue = pixels.getpixel((1100, 100))
    assert red > 220 and green > 160 and blue < 60, 'Yellow graph border absent from composed screen pixels'
    command('clear')
    assert command('status')['presentation']['compositingHeld'], 'Clearing the drawing released compositing while caption remained'
    assert driver('overlayState')['captionMapped']
    command('finish'); time.sleep(.2)
    assert driver('overlayState')['captionMapped'], 'Caption disappeared on completion in fullscreen'
    command('stop')
    assert not command('status')['presentation']['compositingHeld'], 'Stop leaked fullscreen compositing inhibition'
    command('begin', mode='guide')
    full_obs = observe()
    driver('blockPainting', enabled=True)
    reject('draw', 'could not display', **full_obs, items=[{'id': 'unpainted', 'kind': 'rectangle', 'x': 100, 'y': 100, 'width': 300, 'height': 200}])
    assert command('status')['annotations'] == 0, 'Unpainted drawing reported as active'
    driver('blockPainting', enabled=False)
    command('stop')
    assert not command('status')['presentation']['compositingHeld']
    print('PASS: fullscreen graph pixels, paint acknowledgement, caption/drawing compositing lifetime, unpainted draw rejection', flush=True)
    driver('fullscreen', enabled=False); time.sleep(.6)
    command('begin', mode='act')
    obs = observe(); capture('01-observe.png')
    driver('move', x=1050, y=580); time.sleep(.1)
    command('draw', **obs, items=[{'id': 'target', 'kind': 'ellipse', 'x': 560, 'y': 380, 'width': 800, 'height': 110}, {'id': 'pointer', 'kind': 'arrow', 'x': 400, 'y': 400, 'toX': 560, 'toY': 430, 'text': 'Open the demo'}])
    time.sleep(.3); capture('02-annotated.png')
    driver('move', x=1100, y=600); time.sleep(.1)
    assert command('status')['annotations'] == 2, 'Pointer motion erased guidance'
    reject('confirm', 'pointer moved', action={**obs, 'action': 'click', 'x': 960, 'y': 430})
    assert driver('pick', x=960, y=430)['friday'] is False, 'Drawing intercepted input'
    driver('click', x=960, y=430); time.sleep(.3)
    capture('02b-after-click.png')
    assert (stage / 'clicked').exists(), 'Click did not reach GTK app through overlay'
    assert command('status')['annotations'] == 0, 'Stale drawing survived user input'
    print('PASS: capture, circle/arrow rendering, real GTK click-through, stale clearing', flush=True)
    obs = observe()
    payload = {**obs, 'action': 'click', 'x': 960, 'y': 430}
    reject('action', 'Approve', **payload)
    approve_action(payload)
    command('action', **payload)
    observe(); capture('03-verified.png')
    print('PASS: exact-action consent, native input, screenshot verification', flush=True)
    obs = observe(); payload = {**obs, 'action': 'click', 'x': 960, 'y': 430}
    approve_action(payload, bounded=True); command('action', **payload)
    assert command('status')['permission']['remaining'] == 4
    # Consequential effects bypass the grant and still show a fresh exact-action dialog.
    obs = observe(); payload = {**obs, 'action': 'click', 'x': 960, 'y': 430, 'forceConfirmation': True}
    approve_action(payload); command('action', **payload)
    assert command('status')['permission']['remaining'] == 4
    for remaining in range(3, -1, -1):
        obs = observe(); payload = {**obs, 'action': 'click', 'x': 960, 'y': 430}
        assert command('confirm', action=payload).get('scoped') is True
        command('action', **payload)
        assert command('status')['permission']['remaining'] == remaining
    obs = observe(); payload = {**obs, 'action': 'click', 'x': 960, 'y': 430}
    approve_action(payload); command('action', **payload)  # exhausted budget must show a dialog
    driver('overview', show=True); time.sleep(.3)
    status = command('status')
    assert not status['active'] and status['permission'] is None
    assert status['lastStop']['reason'] == 'overview'
    driver('overview'); time.sleep(.4)
    command('begin', mode='act'); observe()
    print('PASS: bounded consent, five-action budget, consequential reapproval, overview revocation and reason', flush=True)
    command('mark'); driver('press', x=600, y=450); driver('move', x=800, y=550); driver('release', x=850, y=430); time.sleep(.2)
    status = command('status'); capture('mark.png'); assert not status['marking'] and status['lastMark']['points']
    assert driver('pick', x=960, y=430)['friday'] is False
    command('stop'); assert command('status')['annotations'] == 0
    reject('observe', 'user_stop')
    print('PASS: explicit user marking, return to click-through, Stop/revocation', flush=True)
    for selected in ['explain', 'guide']:
        command('begin', mode=selected); obs = observe()
        reject('action', 'Act mode', **obs, action='click', x=960, y=430)
        if selected == 'explain': reject('draw', 'Guide', **obs, items=[])
        command('stop')
    print('PASS: native capability enforcement', flush=True)
    command('begin', mode='act')
    driver('click', x=960, y=540); time.sleep(.2)
    obs = observe()
    payload = {**obs, 'action': 'type', 'text': 'x' * 1000}
    approve_action(payload)
    # Stop while native typing is in flight, without waiting behind its reply.
    pending_input = {'done': False}
    def input_done(conn, result):
        pending_input['reply'] = json.loads(conn.call_finish(result).unpack()[0]); pending_input['done'] = True
    bus.call('dev.Friday.Desktop', '/dev/Friday/Desktop', 'dev.Friday.Desktop1', 'Command', GLib.Variant('(ss)', (token, json.dumps({'op': 'action', 'runId': 'smoke', **payload}))), GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 10000, None, input_done)
    time.sleep(.15); command('stop'); time.sleep(.2)
    text_path = stage / 'clicked.text'
    count = len(text_path.read_text()) if text_path.exists() else 0
    assert 0 < count < 1000, count
    time.sleep(.3)
    assert len(text_path.read_text()) == count, 'Typing continued after Stop'
    assert driver('inputState') == {'keys': 0, 'buttons': 0}
    context = GLib.MainContext.default()
    while context.pending(): context.iteration(False)
    assert pending_input.get('reply', {}).get('error'), pending_input
    command('begin', mode='guide'); observe()
    driver('key', key=0xff1b); time.sleep(.2)
    assert command('status')['active'] is False, 'Escape did not revoke the native lease'
    print('PASS: in-flight typing cancellation, held input release, global Escape', flush=True)
    if '--ui' in sys.argv:
        app.terminate(); app.wait(timeout=5)
        (stage / 'clicked').unlink(missing_ok=True)
        app = subprocess.Popen([sys.executable, str(ROOT / 'tests/native/app.py')], stdout=log, stderr=log)
        time.sleep(1)
        executable = ROOT / 'release/linux-unpacked/linux-buddy'
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            debug_port = listener.getsockname()[1]
        with open(stage / 'ui.log', 'w') as ui_log:
            ui = subprocess.Popen([str(executable), '--no-sandbox', '--ozone-platform=wayland', f'--remote-debugging-port={debug_port}', '--remote-debugging-address=127.0.0.1'], cwd=ROOT, stdout=ui_log, stderr=ui_log)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and ui.poll() is None:
                if any('friday —' in t.lower() or 'linux buddy' in t.lower() for t in driver('windows')['titles']): break
                time.sleep(.5)
            assert any('friday —' in t.lower() or 'linux buddy' in t.lower() for t in driver('windows')['titles']), 'Friday window did not map: ' + str(driver('windows')) + (stage / 'ui.log').read_text()
            time.sleep(1)
            assert ui.poll() is None, (stage / 'ui.log').read_text()
            capture('05-friday-ui.png')
            subprocess.run(['node', str(ROOT / 'tests/native/ui.mjs'), str(debug_port), 'ready'], check=True, timeout=30)
            # Simulate the user's missing service, then recover, only inside this isolated desktop.
            subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', '["friday-test@linux-buddy.local"]'], check=True)
            time.sleep(.5)
            subprocess.run(['node', str(ROOT / 'tests/native/ui.mjs'), str(debug_port), 'unavailable'], check=True, timeout=30)
            subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', '["friday-desktop@linux-buddy.local", "friday-test@linux-buddy.local"]'], check=True)
            time.sleep(.5)
            subprocess.run(['node', str(ROOT / 'tests/native/ui.mjs'), str(debug_port), 'reconnected'], check=True, timeout=30)
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
                                    assert driver('overlayState')['captionMapped'], 'No visible native caption'
                                    window_state = driver('fridayWindow')
                                    assert window_state['minimized'] and not window_state['skipTaskbar'], window_state
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
                                    if not window_state['minimized'] and window_state['showing'] and window_state['focused'] and window_state['mapped'] and window_state['opacity'] == 255 and min(window_state['scale']) > .99:
                                        time.sleep(.3)
                                        capture('08-ui-returned.png')
                                        (stage / 'ui-returned-state.json').write_text(json.dumps(window_state, indent=2))
                                        (stage / 'ui-drawing-captured').write_text('returned automatically')
                                try: driver('approve')
                                except RuntimeError: pass
                            else:
                                if not (stage / '05b-working-fullscreen.png').exists() and command('status')['active']:
                                    state = driver('overlayState')
                                    if state.get('captionMapped') and driver('fridayWindow')['minimized']:
                                        capture('05b-working-fullscreen.png')
                                driver('move', x=1050 + int(time.monotonic() * 10) % 100, y=590)
                            time.sleep(.25)
                        assert agent.poll() == 0, (stage / 'ui-agent.log').read_text()[-6000:]
                        assert (stage / 'clicked').exists(), 'UI agent did not click the target'
                        print((stage / 'ui-agent.log').read_text(), flush=True)
                        capture('07-ui-verified.png')
                    finally:
                        if agent.poll() is None: agent.terminate(); agent.wait(timeout=5)
            errors = (stage / 'ui.log').read_text()
            assert 'Error launching app' not in errors and 'Unable to find Electron app' not in errors and 'A JavaScript error occurred' not in errors, errors
            print('PASS: packaged Electron app launches with the native helper present', flush=True)
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
