"""M4 before/after probes, one invocation per GUI lock. No OS input injection."""
from pathlib import Path
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
import argparse
import hashlib
import json
import os
import subprocess
import re
import sys
import threading
import time

ROOT=Path(__file__).resolve().parents[2]
assert ROOT == Path('/Users/edu/Developer/mycmux-wt-mac-m5-261003')
sys.path.insert(0,str(ROOT/'scripts/e2e'))
from mycmux_e2e import App
from mac_webpane import Handler

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--bundle',type=Path,required=True)
    parser.add_argument('--mode',choices=['before','after'],required=True)
    parser.add_argument('--case',choices=['lifetime','focus','meta','right','late-upload','upload-conditions','screenshot'],required=True)
    args=parser.parse_args()
    assert args.bundle.resolve().is_relative_to(ROOT/'tmp')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    out=ROOT/'tmp/m5-review'/f'{args.mode}-{args.case}-{stamp}'
    out.mkdir(parents=True)
    app=App('m5-review-'+stamp.lower(),args.bundle)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    rows=[]
    record={'mode':args.mode,'case':args.case,'bundle':str(args.bundle),'profile':app.profile,
        'binary_sha256':hashlib.sha256(app.binary.read_bytes()).hexdigest(),'rows':rows}
    def save(): (out/'result.json').write_text(json.dumps(record,indent=2)+'\n',encoding='utf-8')
    def invoke(command,params={}):
        return app.eval('return await window.__TAURI_INTERNALS__.invoke('+json.dumps(command)+','+json.dumps(params)+');')
    def ev(tab,code): return app.call('web.eval',{'tabId':tab,'script':code})['value']
    def open_web():
        result=app.call('web.open',{'presetId':'browser','url':f'http://127.0.0.1:{server.server_port}/','background':True})
        tab=result['tabId']
        app.wait_until(lambda:ev(tab,'return !!window.state;'),20,'fixture loaded')
        return tab,'web-pane-'+tab
    try:
        assert not app.runtime_dir.exists()
        subprocess.run(['open','-n','-g','--env','MYCMUX_PROFILE_ACTIVATION=accessory','--stdout',str(out/'stdout.log'),'--stderr',str(out/'stderr.log'),
            '-a',str(args.bundle),'--args','--profile',app.profile],check=True)
        app.wait_until(app._socket_ready,45,'m4 test socket')
        app.wait_until(lambda:app.eval('return !!window.__mycmuxE2E;'),30,'M4 frontend hooks')
        assert not any(w.get('applicationActive') for w in app.windows())
        app.call('workspace.new',{'name':'M4 local fixture','cwd':str(out)})
        if args.case=='lifetime':
            for n in range(5):
                tab,label=open_web()
                rows.append({'kind':'web','index':n,'track':app.call('e2e.mac_review',{'action':'track','label':label})})
                invoke('webpane_destroy',{'tabId':tab})
                app.wait_until(lambda:not any(label in w['webviews'] for w in app.windows()),10,'webview removal')
                child=invoke('open_child_window',{'workspaceIds':[],'width':500,'height':350})
                if isinstance(child,dict): child=child['label']
                app.wait_until(lambda:app.eval('return !!window.__mycmuxE2E;',child),20,'child frontend')
                rows.append({'kind':'child','index':n,'track':app.call('e2e.mac_review',{'action':'track','label':child})})
                app.window_action(child,'destroy')
                app.wait_until(lambda:app.window(child) is None,15,'child window removal')
                save()
            time.sleep(2)
            record['weak']=app.call('e2e.mac_review',{'action':'weak'})
            record['remaining']=sum(record['weak'].values())
            assert record['remaining']==(10 if args.mode=='before' else 0),record['weak']
        else:
            tab,label=open_web()
            if args.case=='focus':
                actions=[{'kind':'click','x':30,'y':30},{'kind':'wheel','x':30,'y':250,'deltaX':0,'deltaY':80},
                    {'kind':'key','key':'Enter'},{'kind':'insertText','text':'m4-local'}]
                for n in range(5):
                    for action in actions:
                        ev(tab,'document.getElementById("text").focus();return true;')
                        before=app.call('e2e.mac_review',{'action':'focus','label':'main'})
                        invoke('webpane_input_trusted',{'tabId':tab,'action':action})
                        time.sleep(.05)
                        after=app.call('e2e.mac_review',{'action':'inspect','label':'main'})
                        row={'index':n,'kind':action['kind'],'before':before,'after':after}
                        rows.append(row);save()
                        equal=before['firstResponder']==after['firstResponder']
                        assert equal == (args.mode=='after'),row
            elif args.case=='meta':
                ev(tab,'document.body.tabIndex=0;document.body.focus();return true;')
                before=app.call('e2e.mac_review',{'action':'inspect','label':'main'})
                try:
                    value=invoke('webpane_input_trusted',{'tabId':tab,'action':{'kind':'key','key':'m','modifiers':['meta']}})
                    rows.append({'value':value})
                except Exception as error:
                    rows.append({'error':str(error)})
                time.sleep(.5)
                record['before']=before
                record['after']=app.call('e2e.mac_review',{'action':'inspect','label':'main'})
                record['menu_effect']=record['after']['miniaturized'] or record['after']['applicationHidden']
                for n in range(4):
                    try:
                        value=invoke('webpane_input_trusted',{'tabId':tab,'action':{'kind':'key','key':'m','modifiers':['meta']}})
                        rows.append({'value':value})
                    except Exception as error:rows.append({'error':str(error)})
                    time.sleep(.1)
                    rows[-1]['state']=app.call('e2e.mac_review',{'action':'inspect','label':'main'})
                    assert not rows[-1]['state']['miniaturized'] and not rows[-1]['state']['applicationHidden']
            elif args.case=='right':
                try:
                    rows.append({'result':invoke('webpane_input_trusted',{'tabId':tab,'action':{'kind':'click','x':40,'y':40,'button':'right'}})})
                except Exception as error:
                    rows.append({'error':str(error)})
                record['socket_alive']=bool(app.call('e2e.windows',timeout=2))
                record['frontend_alive']=bool(app.eval('return !!window.__mycmuxE2E;'))
                record['dialogs']=app.dialogs()
                if args.mode=='after':assert 'right click is not supported' in rows[0].get('error','')
            elif args.case=='late-upload':
                fixture=out/'fixture.txt';fixture.write_bytes(b'M4_LOCAL\n')
                ev(tab,'const click=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){setTimeout(()=>click.call(this),200)};return true;')
                try: invoke('webpane_set_file_input',{'tabId':tab,'selector':'#file','paths':[str(fixture)],'budgetMs':50,'command':'web.upload'})
                except Exception as error: rows.append({'error':str(error)})
                time.sleep(.5)
                record['dialogs']=app.dialogs()
                record['files']=ev(tab,'return [...document.getElementById("file").files].map(f=>f.name);')
                if args.mode=='after': assert not record['dialogs'] and not record['files'],record
            elif args.case=='upload-conditions':
                files=[out/'a.txt',out/'b.txt']
                for file in files:file.write_bytes(b'M4_LOCAL\n')
                ev(tab,'document.getElementById("file").multiple=false;return true;')
                try: rows.append({'value':invoke('webpane_set_file_input',{'tabId':tab,'selector':'#file','paths':[str(f) for f in files]})})
                except Exception as error:rows.append({'error':str(error)})
                record['files']=ev(tab,'return [...document.getElementById("file").files].map(f=>f.name);')
                if args.mode=='after':assert rows[0].get('error') and not record['files'],record
            elif args.case=='screenshot':
                for n in range(5):
                    start=time.monotonic()
                    result=app.call('web.screenshot',{'tabId':tab,'path':str(out/f'shot-{n}.png')})
                    rows.append({'ms':(time.monotonic()-start)*1000,'value':result})
                log=(out/'stderr.log').read_text()
                record['main_ms']=[float(n) for n in re.findall(r'\[m4\] snapshot_main_ms=([0-9.]+)',log)]
                record['worker_ms']=[float(n) for n in re.findall(r'\[m4\] snapshot_worker_ms=([0-9.]+)',log)]
                assert len(record['main_ms'])==5,log
        record['status']='PASS'
    except BaseException as error:
        record['status']='FAIL';record['error']=repr(error)
        raise
    finally:
        server.shutdown();server.server_close()
        if app.pids():
            try:app.terminate(100);app.wait_exit(10)
            except Exception:
                for pid in app.pids():
                    actual=subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True).strip()
                    assert actual.startswith(str(app.binary)+' --profile '+app.profile),actual
                    os.kill(pid,9)
                app.wait_exit(10)
        record['remaining_pids']=app.pids()
        assert not record['remaining_pids']
        save()
        print('M4_REVIEW',record['status'],args.case,str(out/'result.json'),flush=True)

if __name__=='__main__':main()
