"""Windows/Mac M2 driver: every real GUI invocation is protected by lockf."""
import argparse
import base64
import subprocess
import sys

REMOTE='/Users/edu/Developer/mycmux-wt-mac-m2-261003'
parser=argparse.ArgumentParser()
parser.add_argument('--mode',choices=['before','after'],required=True)
parser.add_argument('--case',default='crash')
parser.add_argument('--sample',type=int,default=1)
parser.add_argument('--build-head',required=True)
args=parser.parse_args()
source=f'''
import json, subprocess
from pathlib import Path
root=Path({REMOTE!r})
records=[json.loads(p.read_text()) for p in sorted((root/'tmp/robust-m2').glob('build-*.json'))]
records=[r for r in records if r['head'].startswith({args.build_head!r}) and r['exit']==0]
assert records, 'no successful build for requested HEAD'
build=records[-1]
command=['/usr/bin/lockf','-k','-t','7200','/Users/edu/.mycmux-gui-e2e.lock',
    'python3','scripts/e2e/mac_robust.py','--bundle',build['bundle'],
    '--mode',{args.mode!r},'--case',{args.case!r},'--sample',{str(args.sample)!r}]
print('LOCKED_M2_GUI',json.dumps(command),flush=True)
raise SystemExit(subprocess.run(command,cwd=root).returncode)
'''
payload=base64.b64encode(source.encode('utf-8')).decode('ascii')
command='python3 -c "import base64;exec(base64.b64decode(\''+payload+'\'))"'
raise SystemExit(subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','edumac-mini',command]).returncode)
