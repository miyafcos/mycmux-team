"""Low-overhead counters for an explicitly identified isolated test process."""
import argparse
import json
import importlib.util
from pathlib import Path
import time
import psutil
import re

spec = importlib.util.spec_from_file_location('observer', Path(__file__).with_name('observe-production.py'))
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)

parser = argparse.ArgumentParser()
parser.add_argument('--pid', type=int)
parser.add_argument('--profile-name', default='perf3')
args = parser.parse_args()
assert re.fullmatch(r'[A-Za-z0-9_-]{1,64}', args.profile_name), 'Invalid profile name'
if args.pid:
    proc = psutil.Process(args.pid)
    command = proc.cmdline()
    profile_index = command.index('--profile') if '--profile' in command else -1
    assert profile_index >= 0 and profile_index + 1 < len(command) and command[profile_index + 1] == args.profile_name, 'Not the requested isolated profile'
    row = observer.snapshot(proc)
    descendants = []
    for child in proc.children(recursive=True):
        try:
            if child.name().lower() != 'msedgewebview2.exe':
                continue
            item = observer.snapshot(child)
            item['type'] = next((a[7:] for a in child.cmdline() if a.startswith('--type=')), 'browser')
            item['user_data_dir'] = next((a.split('=',1)[1] for a in child.cmdline() if a.startswith('--user-data-dir=')), None)
            descendants.append(item)
        except psutil.Error:
            pass
    print(json.dumps(dict(time_ms=time.time()*1000, app=row, webviews=descendants, available_memory=psutil.virtual_memory().available, system_cpu=psutil.cpu_times()._asdict())))
else:
    rows = []
    for proc in psutil.process_iter(['name', 'exe', 'cmdline', 'create_time']):
        if proc.info['name'].lower() == 'mycmux.exe':
            rows.append(dict(pid=proc.pid, **proc.info))
    print(json.dumps(rows))
