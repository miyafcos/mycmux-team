"""W11: a caller in a native child owns socket and CLI spawns on macOS."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from mycmux_e2e import App
from mac_tearout import ROOT, OUT, SEAT, launch, stop, wait, clocks
from mac_tearout_lifecycle import kept


def locations(app, session):
    return [row['label'] for row in app.windows() if row.get('visible')
        for workspace in app.workspaces(row['label']) for pane in workspace['panes']
        for tab in pane['tabs'] if tab['sessionId']==session]


def run(app, out):
    launch(app,out)
    _,tabs,label=kept(app,1,'pane')
    before=wait(app,lambda:clocks(app,tabs,label),'live caller')
    anchor=tabs[-1]['sessionId']
    checks=[]
    for name in ['pane.spawn_tab','spawn --split']:
        row={'command':name,'caller_window':label,'passed':False}
        try:
            if name=='pane.spawn_tab':
                spawned=app.call(name,{'anchorSessionId':anchor,'activate':False,'label':SEAT+'-caller-tab',
                    'commandArgv':['/bin/sh','-c','while :; do printf "I4SPAWN %s\\n" "$$"; sleep 0.1; done']})
            else:
                env={key:value for key,value in os.environ.items() if not key.startswith(('MYCMUX_','CLAUDE'))}
                env.update(MYCMUX_RUNTIME_DIR=str(app.runtime_dir),MYCMUX_PANE_SESSION_ID=anchor,PYTHONDONTWRITEBYTECODE='1')
                command=[sys.executable,'-X','utf8',str(ROOT/'scripts/mycmux_agent_cli.py'),'spawn','--target','shell',
                    '--split','--no-activate','--label',SEAT+'-caller-split']
                row['argv']=command
                process=subprocess.run(command,cwd=ROOT,env=env,capture_output=True,text=True,timeout=60)
                assert process.returncode==0,process.stdout+process.stderr
                spawned=json.loads(process.stdout)
            row['response']=spawned
            observed=wait(app,lambda:locations(app,spawned['sessionId']) or None,'spawned owner',15)
            row['locations']=observed
            assert observed==[label],(observed,label)
            assert clocks(app,tabs,label)[tabs[-1]['id']]['pid']==before[tabs[-1]['id']]['pid']
            assert spawned['foregroundChanged'] is False,spawned
            row['passed']=True
        except Exception as error:row['error']=str(error)
        checks.append(row)
    return checks


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--bundle',type=Path,required=True)
    args=parser.parse_args()
    bundle=args.bundle.resolve()
    assert OUT.resolve() in bundle.parents
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    out=OUT/('spawn-caller-'+stamp)
    out.mkdir(parents=True)
    app=App(SEAT+'spawn'+stamp,bundle)
    result={'profile':app.profile,'bundle':str(bundle),'binary_sha256':hashlib.sha256(app.binary.read_bytes()).hexdigest()}
    began=time.monotonic()
    try:
        result['checks']=run(app,out)
        result['passed']=all(row['passed'] for row in result['checks'])
    except Exception as error:result.update(passed=False,error=str(error))
    finally:
        try:stop(app)
        except Exception as error:result.update(passed=False,cleanup_error=str(error))
    result['remaining_pids']=app.pids()
    result['elapsed_ms']=round((time.monotonic()-began)*1000,3)
    (out/'summary.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print('I4_SPAWN_CALLER',result.get('passed'),str(out/'summary.json'),flush=True)
    return 0 if result.get('passed') and not result['remaining_pids'] else 1


if __name__=='__main__':raise SystemExit(main())
