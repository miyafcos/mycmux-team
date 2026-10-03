"""M2 real WKWebView termination, heartbeat and retained-PTY acceptance.

Run only under COMMON.md's lockf in the edu GUI session. Each invocation
owns one fresh m2 profile and releases the GUI lock after stopping its app.
No physical input, production app, dependency installation or deletion.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from mycmux_e2e import App, E2eError

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'tmp/robust-m2'

def diag(app):
    return '\n'.join(path.read_text(encoding='utf-8', errors='strict') for path in sorted(app.runtime_dir.glob('diag.log*')))

def renderer(app, label='main', action='inspect'):
    return app.call('e2e.renderer', {'label': label, 'action': action}, timeout=5)

def ready(app, label='main'):
    try:
        return app.eval('return !!window.__mycmuxE2E && document.readyState === "complete" && !!document.querySelector("#root")?.children.length;', label, timeout_ms=500)
    except (OSError, E2eError):
        return False

def launch(app):
    assert not app.runtime_dir.exists(), app.runtime_dir
    assert str(app.bundle.resolve()).startswith(str(OUT.resolve())+'/'), app.bundle
    # open -g alone is overridden by tao's startup activation. --env carries
    # the existing profile-only accessory policy through LaunchServices.
    subprocess.run(['open', '-n', '-g', '--env', 'MYCMUX_PROFILE_ACTIVATION=accessory',
                    '-a', str(app.bundle), '--args', '--profile', app.profile], check=True)
    app.wait_until(app._socket_ready, 50, 'profile socket')
    app.wait_until(lambda: ready(app), 30, 'real frontend hooks')
    assert app.eval('return await window.__TAURI_INTERNALS__.invoke("get_test_profile");') == app.profile
    assert app.pids()
    assert not any(window.get('applicationActive') for window in app.windows()), 'test application activated'

def stop(app):
    if not app.pids(): return
    try:
        app.terminate(200)
        app.wait_exit(15)
    except Exception:
        for pid in app.pids():
            actual = subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True).strip()
            assert actual.startswith(str(app.binary)+' --profile '+app.profile), actual
            os.kill(pid, 9)
        app.wait_exit(10)

def fixture(app, count=20):
    workspace = app.call('workspace.new', {'name': 'M2 retention', 'grid': '1x1', 'cwd': str(ROOT)})
    source = next(w for w in app.workspaces() if w['id']==workspace['workspaceId'])
    anchor = source['panes'][0]['tabs'][0]['sessionId']
    sessions=[]
    for index in range(count):
        spawned = app.call('pane.spawn_tab', {'anchorSessionId':anchor,'activate':False,
            'label':f'm2-clock-{index}', 'commandArgv':['/bin/sh','-c',
            'i=0; while :; do i=$((i+1)); printf "M2CLOCK %s %s\\n" "$$" "$i"; sleep 0.2; done']})
        anchor=spawned['sessionId']
        sessions.append(anchor)
    # The real autosave path writes the real serialized stores and fragments.
    app.wait_until(lambda: any('M2 retention' in p.read_text() for p in (
        Path.home()/'Library/Application Support/com.miyazaki.mycmux.e2e.m2/profiles'/app.profile).glob('data.json')), 20, 'live autosave')
    time.sleep(2)
    return sessions

def clocks(app, sessions):
    readings={}
    for session in sessions:
        row=app.call('e2e.pty', {'session_id':session}, timeout=5)
        values=re.findall(r'M2CLOCK (\d+) (\d+)',row['tail'])
        assert row['running'] and values, row
        pid,tick=values[-1]
        assert int(pid)==row['pid'], row
        readings[session]={'pid':int(pid),'tick':int(tick),'epoch':row['epoch']}
    return readings

def retained(before,after):
    assert before.keys()==after.keys()
    for session in before:
        assert before[session]['pid']==after[session]['pid'], (session,before,after)
        assert before[session]['epoch']==after[session]['epoch'], (session,before,after)
        assert after[session]['tick']>before[session]['tick'], (session,before[session],after[session])

def crash(app, expect, label='main', observation_s=None):
    before=diag(app)
    boot=app.eval('return performance.timeOrigin;', label) if not label.startswith('web-pane-') else None
    begun=time.monotonic()
    signal=renderer(app,label,'crash')
    death=False
    returned=False
    observed=[]
    # The final before/after comparison uses the same 25-second deadline.
    limit=observation_s if observation_s is not None else 25
    while time.monotonic()-begun<limit:
        try: os.kill(signal['pid'],0)
        except ProcessLookupError: death=True
        observed=[line for line in diag(app)[len(before):].splitlines() if 'renderer reload' in line and f'webview={label} ' in line]
        if label.startswith('web-pane-'):
            try:
                returned=bool(app.call('e2e.native_eval',{'label':label,'script':'return document.readyState === "complete" && document.body.textContent.includes("M2_WEB");','timeout_ms':500},timeout=2))
            except Exception: returned=False
        else:
            returned=bool(ready(app,label))
            if returned and boot is not None:
                returned=app.eval('return performance.timeOrigin;',label)!=boot
        if death and returned and observed: break
        time.sleep(0.1)
    elapsed=(time.monotonic()-begun)*1000
    assert death, ('renderer PID never exited',signal)
    if expect:
        assert observed and all('success=true' in line for line in observed) and returned, (label,observed,returned,diag(app)[-2500:])
    else:
        assert not observed and not returned, (label,observed,returned)
    return {'renderer':signal,'native_death':death,'page_returned':returned,'reload_lines':observed,
            'recovery_ms':elapsed if expect else None,'observation_ms':elapsed,'baseline_censored':not expect}

def run_case(app, case, mode, directory):
    expect=mode=='after'
    sessions=fixture(app,20 if case=='crash' else 3)
    before=clocks(app,sessions)
    # The B5 pane.read contract uses the normal control API before any fault.
    read=app.call('pane.read',{'sessionId':sessions[-1]})
    assert 'M2CLOCK' in json.dumps(read), read
    app.wait_until(lambda:'[renderer] ' in diag(app),75,'production renderer heartbeat',0.5)
    heartbeat=next(line for line in diag(app).splitlines() if '[renderer] ' in line)
    for key in ('heap_used_mib=','longtasks=','max_longtask_ms=','xterm=','pending_invokes=','visibility=','focus=','free_ram_mib='):
        assert key in heartbeat, heartbeat
    result={'background_read':'PASS','heartbeat':heartbeat,'before':before}
    if case=='crash':
        result.update(crash(app,expect))
        after=clocks(app,sessions)
        retained(before,after)
        result['after']=after
        if expect:
            restored={t['sessionId'] for w in app.workspaces() for p in w['panes'] for t in p['tabs']}
            assert set(sessions)<=restored, (sessions,restored)
            read=app.call('pane.read',{'sessionId':sessions[-1]})
            assert 'M2CLOCK' in json.dumps(read), read
            app.snapshot(directory/'restored.png')
    elif case=='budget':
        assert expect
        result['attempts']=[]
        for attempt in range(1,4):
            sample=crash(app,True,observation_s=70)
            assert any(f'attempt={attempt}/3' in line for line in sample['reload_lines']), sample
            result['attempts'].append(sample)
            retained(before,clocks(app,sessions))
        result['fourth']=crash(app,False,observation_s=5)
        app.wait_until(lambda:'renderer recovery give up webview=main' in diag(app),5,'reload budget give up')
        assert len([l for l in diag(app).splitlines() if 'renderer reload webview=main ' in l])==3
        result['after']=clocks(app,sessions)
        retained(before,result['after'])
    elif case=='silent':
        app.eval('setTimeout(() => { for (;;) {} }, 150); return true;')
        app.wait_until(lambda:'[watchdog] renderer silent' in diag(app),150,'silent heartbeat record',0.5)
        assert diag(app).count('[watchdog] renderer silent')==1
        result['after']=clocks(app,sessions)
        retained(before,result['after'])
        result['silent_line']=next(l for l in diag(app).splitlines() if '[watchdog] renderer silent' in l)
        # Actual process death after the hang must still return a usable page.
        signal=renderer(app,'main','crash')
        app.wait_until(lambda:ready(app),30,'page after hung renderer termination')
        app.wait_until(lambda:'[watchdog] renderer back after' in diag(app),75,'heartbeat resumed',0.5)
        result['hung_renderer']=signal
        result['back_line']=next(l for l in diag(app).splitlines() if '[watchdog] renderer back after' in l)
    elif case=='child':
        child=app.eval('return await window.__TAURI_INTERNALS__.invoke("open_child_window",{workspaceIds:[],width:500,height:350});')
        if isinstance(child,dict): child=child['label']
        app.wait_until(lambda:ready(app,child),30,'child frontend')
        result['child_label']=child
        result.update(crash(app,True,child))
        result['main_ready']=bool(ready(app))
        assert result['main_ready']
        app.window_action(child,'destroy')
        app.wait_until(lambda:app.window(child) is None,15,'child cleanup')
        retained(before,clocks(app,sessions))
    elif case=='webpane':
        import functools
        import http.server
        import threading
        file=directory/'web.html'
        file.write_text('<!doctype html><title>M2 web recovery</title><p>M2_WEB</p>\n',encoding='utf-8')
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),
            functools.partial(http.server.SimpleHTTPRequestHandler,directory=str(directory)))
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            opened=app.call('web.open',{'presetId':'browser','url':f'http://127.0.0.1:{server.server_port}/web.html'})
            listing=app.call('web.list')
            result['web_open']=opened
            result['web_list']=listing
            labels=[label for w in app.windows() for label in w['webviews'] if label!='main']
            assert len(labels)==1, labels
            label=labels[0]
            app.wait_until(lambda:app.call('e2e.native_eval',{'label':label,'script':'return document.body.textContent.includes("M2_WEB");'}),30,'local browser content')
            result.update(crash(app,True,label))
            assert ready(app)
            retained(before,clocks(app,sessions))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)
    else: raise ValueError(case)
    result['pty_retained']='PASS'
    return result

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--bundle',type=Path,required=True)
    parser.add_argument('--mode',choices=['before','after'],required=True)
    parser.add_argument('--case',choices=['crash','budget','silent','child','webpane'],default='crash')
    parser.add_argument('--sample',type=int,default=1)
    args=parser.parse_args()
    assert sys.platform=='darwin' and str(ROOT)=='/Users/edu/Developer/mycmux-wt-mac-m2-261003'
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    profile=f'm2-{args.mode}-{args.case}-{args.sample}-{stamp}'
    directory=OUT/profile
    directory.mkdir(parents=True)
    app=App(profile,args.bundle)
    record={'profile':profile,'bundle':str(args.bundle),'sha256':hashlib.sha256(app.binary.read_bytes()).hexdigest(),
            'mode':args.mode,'case':args.case,'sample':args.sample}
    try:
        launch(app)
        record['checks']=run_case(app,args.case,args.mode,directory)
        record['status']='PASS'
    except Exception as error:
        record['status']='FAIL'
        record['error']=repr(error)
        import traceback
        traceback.print_exc()
    finally:
        (directory/'diag.log').write_text(diag(app),encoding='utf-8')
        stop(app)
        record['pids_after_stop']=app.pids()
        assert not record['pids_after_stop']
        (directory/'result.json').write_text(json.dumps(record,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(record),flush=True)
    raise SystemExit(0 if record['status']=='PASS' else 1)

if __name__=='__main__': main()
