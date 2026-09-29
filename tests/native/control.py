"""Control checks run only in run.py's isolated compositor, with distinct virtual devices."""
import base64
import json
import time
import threading

def exercise(command, driver, observe, stage):
    # Match DesktopBridge's heartbeat independently of screenshot encoding and
    # pixel assertions, which can exceed the short control lease on busy hosts.
    enabled=threading.Event(); enabled.set()
    stopped=threading.Event()
    def heartbeat():
        while not stopped.wait(.5):
            if enabled.is_set():
                try: command('heartbeat')
                except Exception: pass
    thread=threading.Thread(target=heartbeat,daemon=True); thread.start()
    try: _exercise(command,driver,observe,stage,enabled)
    finally: stopped.set(); thread.join(timeout=6)

def _exercise(command, driver, observe, stage,heartbeat_enabled):
    def targets():
        frame=driver('drawingGeometry')['buffer']
        # GTK widget positions include CSD shadows: use the buffer, not the frame.
        return {name: {'x': point['x']+frame['x'], 'y': point['y']+frame['y']} for name,point in json.loads((stage/'controls.json').read_text()).items()}
    def act(actions):
        obs=observe()
        return command('act', **obs, actions=actions)
    command('begin')
    command('control_begin')
    assert command('status')['inputBlocked']
    (stage/'clicked').unlink(missing_ok=True)
    driver('click', **targets()['button']); time.sleep(.15)
    assert not (stage/'clicked').exists(), 'Driver mouse input escaped the shield'
    result=act([{'type':'click', **targets()['button']}])
    assert (stage/'clicked').exists(), 'Friday click did not reach GTK'
    print('Control click timing:', result, flush=True)
    act([{'type':'click', **targets()['entry']}, {'type':'keypress','keys':['ctrl','a']}, {'type':'type','text':'Friday 123'}])
    assert (stage/'typed').read_text()=='Friday 123', (stage/'typed').read_text()
    driver('key', key=ord('x')); time.sleep(.1)
    assert (stage/'typed').read_text()=='Friday 123', 'Driver keyboard input escaped the shield'
    act([{'type':'keypress','keys':['ctrl','a']},{'type':'type','text':'Verified'}])
    assert (stage/'typed').read_text()=='Verified', (stage/'typed').read_text()
    act([{'type':'keypress','keys':['ctrl','a']},{'type':'keypress','keys':['shift','a']}])
    assert (stage/'typed').read_text()=='A', 'Modified key delivery was not confirmed'
    act([{'type':'keypress','keys':['ctrl','a']},{'type':'type','text':'Verified'}])
    act([{'type':'keypress','keys':['enter']}])
    assert (stage/'entered').read_text()=='Verified', 'Enter did not reach the app'
    act([{'type':'keypress','keys':['escape']}])
    assert command('status')['controlling'], 'Friday Escape stopped its own run'
    # A real Wayland popup (Gtk.Menu, not an in-window Popover) must survive
    # closing/reopening the input window and capture.
    (stage/'menu-result').unlink(missing_ok=True)
    act([{'type':'click', **targets()['menu']}]); time.sleep(.15)
    assert (stage/'menu-open').exists(), 'Menu did not open'
    act([{'type':'keypress','keys':['down']},{'type':'keypress','keys':['enter']}])
    assert (stage/'menu-result').exists(), 'Popup did not survive input shielding/capture'
    act([{'type':'click',**targets()['menu']}])
    assert (stage/'menu-open').exists()
    act([{'type':'keypress','keys':['escape']}])
    assert not (stage/'menu-open').exists(), 'Friday Escape did not reach the popup'
    obs=observe()
    driver('click',x=100,y=800)
    command('act',**obs,actions=[{'type':'keypress','keys':['enter']}])
    obs=observe()
    command('draw', **obs, items=[{'id':'control-mark','kind':'circle','x':100,'y':180,'width':200,'height':100}])
    assert command('status')['annotations']==1
    command('heartbeat')
    image=command('observe')
    (stage/'control-clean.png').write_bytes(base64.b64decode(image['data']))
    (stage/'control-composed.png').write_bytes(base64.b64decode(driver('capture')['data']))
    assert command('status')['annotations']==1, 'Capture erased valid drawing during control'
    from PIL import Image, ImageChops
    clean=Image.open(stage/'control-clean.png').convert('RGB')
    composed=Image.open(stage/'control-composed.png').convert('RGB')
    for region in [(90,170,310,290)]:
        assert ImageChops.difference(clean.crop(region),composed.crop(region)).getbbox(), 'Overlay leaked into observation or vanished'
    assert not ImageChops.difference(clean.crop((700,950,1220,1050)),composed.crop((700,950,1220,1050))).getbbox(), 'Extra control banner appeared'
    driver('key',key=0xff1b); time.sleep(.1)
    first=command('status')
    assert first['controlling'], first
    driver('key',key=0xff1b); time.sleep(.15)
    status=command('status')
    assert not status['controlling'] and not status['inputBlocked'], status
    assert status['inputState']=={'keys':0,'buttons':0}
    # Revoke a batch while it still owns input; no later chunk may run.
    import concurrent.futures
    command('begin'); command('control_begin')
    obs=observe()
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        running=pool.submit(command, 'act', **obs, actions=[{'type':'click',**targets()['entry']},{'type':'keypress','keys':['ctrl','a']},{'type':'type','text':'x'*500}])
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            partial=(stage/'typed').read_text()
            if partial.startswith('x'*60): break
            time.sleep(.01)
        else: raise AssertionError('Typing did not start before the stop check')
        command('stop')
        try: running.result(timeout=5)
        except RuntimeError: pass
        else: raise AssertionError('Batch kept running after stop')
    assert 60 <= len((stage/'typed').read_text()) < 500
    assert not command('status')['inputBlocked']
    command('begin'); command('control_begin'); command('stop')
    assert not command('status')['inputBlocked']
    command('begin'); command('control_begin')
    heartbeat_enabled.clear()
    time.sleep(4.1)
    assert not command('status')['controlling'], 'Heartbeat loss left input blocked'
    print('PASS: controlled click/type/keys, user-input shield, popup survival, drawing/capture, double Esc, stop and watchdog',flush=True)
