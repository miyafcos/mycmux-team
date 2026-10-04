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
match = re.fullmatch(r'mycmux-wt-mac-([a-z0-9]+)-261003', ROOT.name)
assert match, ROOT
SEAT = match.group(1)
OUT = ROOT / f'tmp/robust-{SEAT}'

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

def configure_tearout(app, enabled):
    # Profiles isolate backend state, but the bundle identifier owns WebKit's
    # persistent localStorage. A preceding drag case can leave this opt-in ON.
    # Set the actual Mac preference rather than inferring it from a fresh profile.
    initial=app.eval('const s=window.__mycmuxE2E.stores.settings.getState();return {native:s.nativePaneTearoutEnabled,mac:s.macNativePaneTearoutEnabled};')
    app.eval('window.__mycmuxE2E.stores.settings.getState().setNativePaneTearoutEnabled('+json.dumps(enabled)+');return true;')
    app.wait_until(lambda:app.eval('const s=window.__mycmuxE2E.stores.settings.getState();return s.nativePaneTearoutEnabled === '+json.dumps(enabled)+' && s.macNativePaneTearoutEnabled === '+json.dumps(enabled)+';'),10,'explicit Mac tearout preference')
    if enabled:
        app.wait_until(lambda:len(app.windows())==2 and any(not w['visible'] for w in app.windows()),20,'one isolated tearout spare')
    else:
        app.wait_until(lambda:[w['label'] for w in app.windows()]==['main'],20,'OFF releases the spare')
    windows=app.windows()
    spares=[]
    for window in windows:
        if window['label']=='main': continue
        label=window['label']
        assert app.eval('return window.__MYCMUX_TEAROUT_WINDOW__ === true;',label), window
        assert not window['visible'], window
        spares.append({'label':label,'renderer':renderer(app,label)})
    assert len(spares)==int(enabled), spares
    return {'enabled':enabled,'initial':initial,'windows':windows,'spares':spares,'main_renderer':renderer(app)}

def prepare_background_read(app, session):
    # A prewarmed, never-painted xterm can exist with an empty cache. Select
    # the REAL terminal in this disposable profile, await parsed live output,
    # then restore the former tab before checking the ordinary background API.
    selection=app.eval('const h=window.__mycmuxE2E,sid='+json.dumps(session)+';const ui=h.stores.ui.getState(),list=h.stores.workspaceList.getState();for(const w of list.workspaces)for(const p of w.panes){const t=p.tabs.find(t=>t.sessionId===sid);if(t){const old={workspace:w.id,pane:p.id,tab:p.activeTabId,session:ui.activePaneId,activeWorkspace:list.activeWorkspaceId};list.setActiveWorkspace(w.id);h.stores.layout.getState().setActivePaneTab(w.id,p.id,t.id);ui.setActivePaneId(sid);return old;}}throw new Error("clock owner missing");')
    app.wait_until(lambda:app.eval('const t=window.__mycmuxE2E.terminals.live.get('+json.dumps(session)+');if(!t)return false;const b=t.buffer.active;for(let i=0;i<b.length;i++)if(b.getLine(i)?.translateToString(true).includes("M2CLOCK"))return true;return false;'),20,'mounted clock has parsed live output')
    mounted=app.call('pane.read',{'sessionId':session})
    assert 'M2CLOCK' in json.dumps(mounted), mounted
    app.eval('const h=window.__mycmuxE2E,old='+json.dumps(selection)+';h.stores.layout.getState().setActivePaneTab(old.workspace,old.pane,old.tab);h.stores.workspaceList.getState().setActiveWorkspace(old.activeWorkspace);h.stores.ui.getState().setActivePaneId(old.session);return true;')
    app.wait_until(lambda:app.eval('const h=window.__mycmuxE2E,w=h.stores.workspaceList.getState().workspaces.find(w=>w.id==='+json.dumps(selection['workspace'])+'),p=w?.panes.find(p=>p.id==='+json.dumps(selection['pane'])+');return p?.activeTabId === '+json.dumps(selection['tab'])+';'),10,'original tab restored')
    background=app.wait_until(lambda:(r if 'M2CLOCK' in json.dumps(r) else None) if (r:=app.call('pane.read',{'sessionId':session})) else None,20,'normal background clock read')
    return {'selection':selection,'mounted':mounted,'background':background}

def fixture(app, count=20):
    workspace = app.call('workspace.new', {'name': 'M2 retention', 'grid': '1x1', 'cwd': str(ROOT)})
    source = next(w for w in app.workspaces() if w['id']==workspace['workspaceId'])
    anchor = source['panes'][0]['tabs'][0]['sessionId']
    sessions=[]
    for index in range(count):
        spawned = app.call('pane.spawn_tab', {'anchorSessionId':anchor,'activate':False,
            'label':f'{SEAT}-clock-{index}', 'commandArgv':['/bin/sh','-c',
            'i=0; while :; do i=$((i+1)); printf "M2CLOCK %s %s\\n" "$$" "$i"; sleep 0.2; done']})
        anchor=spawned['sessionId']
        sessions.append(anchor)
    # The real autosave path writes the real serialized stores and fragments.
    app.wait_until(lambda: any('M2 retention' in p.read_text() for p in (
        Path.home()/f'Library/Application Support/com.miyazaki.mycmux.e2e.{SEAT}/profiles'/app.profile).glob('data.json')), 20, 'live autosave')
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

def run_case(app, case, mode, directory, tearout=False):
    expect=mode=='after'
    preference=configure_tearout(app,tearout)
    sessions=fixture(app,20 if case=='crash' else 3)
    prepared=prepare_background_read(app,sessions[-1]) if tearout else None
    before=clocks(app,sessions)
    # The B5 pane.read contract uses the normal control API before any fault.
    read=app.call('pane.read',{'sessionId':sessions[-1]})
    assert 'M2CLOCK' in json.dumps(read), read
    app.wait_until(lambda:'[renderer] ' in diag(app),75,'production renderer heartbeat',0.5)
    heartbeat=next(line for line in diag(app).splitlines() if '[renderer] ' in line)
    for key in ('heap_used_mib=','longtasks=','max_longtask_ms=','xterm=','pending_invokes=','visibility=','focus=','free_ram_mib='):
        assert key in heartbeat, heartbeat
    result={'background_read':'PASS','heartbeat':heartbeat,'before':before,'tearout':preference,'prepared_read':prepared}
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
            label='web-pane-'+opened['tabId']
            app.wait_until(lambda:[candidate for w in app.windows() for candidate in w['webviews'] if candidate.startswith('web-pane-')]==[label],30,'exact native browser webview created')
            labels=[label for w in app.windows() for label in w['webviews'] if label.startswith('web-pane-')]
            assert labels==[label], (opened,labels)
            result['webview_label']=label
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
    parser.add_argument('--tearout',choices=['off','on'],default='off')
    args=parser.parse_args()
    assert sys.platform=='darwin' and ROOT.parent == Path('/Users/edu/Developer')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    profile=f'{SEAT}-{args.mode}-{args.case}-{args.sample}-{stamp}'
    directory=OUT/profile
    directory.mkdir(parents=True)
    app=App(profile,args.bundle)
    record={'profile':profile,'bundle':str(args.bundle),'sha256':hashlib.sha256(app.binary.read_bytes()).hexdigest(),
            'mode':args.mode,'case':args.case,'sample':args.sample}
    try:
        launch(app)
        record['checks']=run_case(app,args.case,args.mode,directory,args.tearout=='on')
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
