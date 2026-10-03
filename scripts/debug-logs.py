#!/usr/bin/env python3
"""Follow Friday's newest debug log, including across app restarts."""
import json
import os
from pathlib import Path
import time

# Electron's userData follows XDG_CONFIG_HOME on Linux.
config = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config')
directory = Path(os.environ.get('FRIDAY_DEBUG_DIR') or config / 'linux-buddy/debug')
current = None
stream = None
try:
    while True:
        files = sorted(directory.glob('friday-*.jsonl'))
        latest = files[-1] if files else None
        if latest and latest != current:
            if stream:
                stream.close()
            current = latest
            stream = latest.open()
            print(f'--- {latest} ---', flush=True)
        if stream:
            for line in stream:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                stamp = record.pop('time', '')
                area = record.pop('area', '')
                event = record.pop('event', '')
                detail = ' '.join(f'{key}={json.dumps(value, ensure_ascii=False)}' for key, value in record.items())
                print(f'{stamp} {area:<8} {event} {detail}', flush=True)
        time.sleep(0.25)
except KeyboardInterrupt:
    pass
finally:
    if stream:
        stream.close()
