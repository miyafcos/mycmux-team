"""M3 Mac Web pane checks. Run the entire invocation under COMMON.md's lockf.

Only a fresh m3 profile and the supplied isolated test bundle are operated.
No OS input injection, production instance, external website or deletion.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import math
from pathlib import Path
import statistics
import struct
import subprocess
import sys
import threading
import time

from mycmux_e2e import App, E2eError

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'tmp/webpane-m3'
PAGE = b'''<!doctype html><meta charset="utf-8"><title>M3 local fixture</title>
<style>body{margin:20px;background:#fff;color:#000}button,input{display:block;margin:10px;width:260px;height:40px}
#scroll{height:100px;width:300px;overflow:auto}#scroll div{height:1000px}</style>
<button id="count">Count</button><input id="text"><input id="file" type="file" multiple>
<input id="hidden-file" type="file" multiple style="display:none"><div id="scroll"><div>Scroll</div></div>
<div id="editable" contenteditable="true">Editable</div>
<script>window.state={clicks:[],keys:[],inputs:[],files:[],changes:[],wheels:[]};
state.allWheels=[];document.addEventListener('wheel',e=>state.allWheels.push({id:e.target.id,x:e.clientX,y:e.clientY,dy:e.deltaY,isTrusted:e.isTrusted}),true);
count.addEventListener('click',e=>state.clicks.push({isTrusted:e.isTrusted}));
text.addEventListener('keydown',e=>state.keys.push({key:e.key,code:e.code,isTrusted:e.isTrusted,ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey,meta:e.metaKey}));
text.addEventListener('input',e=>state.inputs.push({isTrusted:e.isTrusted,value:text.value}));
for(const el of document.querySelectorAll('input[type=file]'))el.addEventListener('change',e=>{state.files=[...e.target.files].map(f=>({name:f.name,size:f.size}));state.changes.push({isTrusted:e.isTrusted,id:el.id});});
document.getElementById('scroll').addEventListener('wheel',e=>state.wheels.push({isTrusted:e.isTrusted,dy:e.deltaY}));
document.getElementById('editable').addEventListener('input',e=>state.inputs.push({isTrusted:e.isTrusted,value:e.target.textContent}));
</script>'''

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type','text/html; charset=utf-8')
        self.send_header('Content-Length',str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)
    def log_message(self,*args):
        pass

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--bundle',type=Path,required=True)
    parser.add_argument('--expect',choices=['unsupported','supported'],required=True)
    parser.add_argument('--runs',type=int,default=5)
    args=parser.parse_args()
    assert sys.platform=='darwin' and args.runs>=5
    assert str(ROOT)=='/Users/edu/Developer/mycmux-wt-mac-m3-261003'
    assert args.bundle.resolve().is_relative_to(OUT.resolve())
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    profile='m3-web-'+stamp.lower()
    out=OUT / (args.expect+'-'+stamp)
    out.mkdir(parents=True)
    fixture=out/'fixture space.txt'
    fixture.write_bytes(b'M3 local upload fixture\n')
    app=App(profile,args.bundle)
    assert not app.runtime_dir.exists()
    rows=[]
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    tab=None
    status='RUNNING'

    def save():
        (out/'results.json').write_text(json.dumps({'status':status,'profile':profile,'expect':args.expect,
            'bundle':str(args.bundle),'binary_sha256':hashlib.sha256(app.binary.read_bytes()).hexdigest(),
            'rows':rows},indent=2)+'\n',encoding='utf-8')
    def ev(script):
        return app.call('web.eval',{'tabId':tab,'script':script,'direct':True})['value']
    def native(command,params):
        params={'tabId':tab,**params}
        return app.eval('return await window.__TAURI_INTERNALS__.invoke('+json.dumps(command)+','+json.dumps(params)+');',timeout_ms=24000)
    def measured(name,operation,expected=None):
        start=time.perf_counter()
        try:
            value=operation()
        except Exception as error:
            if expected is None or expected not in str(error):
                rows.append({'name':name,'ok':False,'error':str(error),'ms':(time.perf_counter()-start)*1000})
                save()
                raise
            row={'name':name,'ok':True,'error':str(error)}
        else:
            if expected is not None:
                error=AssertionError((name,'expected error',expected,value))
                rows.append({'name':name,'ok':False,'error':str(error),'ms':(time.perf_counter()-start)*1000})
                save()
                raise error
            row={'name':name,'ok':True,'value':value}
        row['ms']=(time.perf_counter()-start)*1000
        rows.append(row)
        save()
        return row.get('value')
    def call(command,params):
        return app.call(command,{'tabId':tab,**params})
    def read():
        return ev('return {...window.state,text:document.getElementById("text").value,scroll:document.getElementById("scroll").scrollTop};')

    try:
        subprocess.run(['open','-n','-g','--stdout',str(out/'app-stdout.log'),'--stderr',str(out/'app-stderr.log'),'-a',str(args.bundle),'--args','--profile',profile],check=True)
        app.wait_until(app._socket_ready,45,'m3 test socket')
        assert app.eval('return await window.__TAURI_INTERNALS__.invoke("get_test_profile");')==profile
        assert not any(w.get('applicationActive') for w in app.windows()),'background app activated'
        app.call('workspace.new',{'name':'M3 fixture','cwd':str(out)})
        opened=app.call('web.open',{'presetId':'browser','url':f'http://127.0.0.1:{server.server_port}/','background':True})
        tab=opened['tabId']
        app.wait_until(lambda:ev('return !!window.state;'),25,'local page')
        # Select only the fixture tab in the background test window. No app activation.
        app.eval('''const h=window.__mycmuxE2E,list=h.stores.workspaceList.getState();
        for(const w of list.workspaces)for(const p of w.panes)if(p.tabs.some(t=>t.id==='''+json.dumps(tab)+''')){
        list.setActiveWorkspace(w.id);h.stores.layout.getState().setActivePaneTab(w.id,p.id,'''+json.dumps(tab)+''');}
        return true;''')
        time.sleep(.4)
        for run in range(args.runs):
            uns=args.expect=='unsupported'
            screenshot=measured('screenshot',lambda:call('web.screenshot',{'path':str(out/f'shot-{run}.png')}),
                'web.screenshot is not supported on this platform yet' if uns else None)
            measured('click',lambda:call('web.click',{'selector':'#count','trusted':True}),
                'trusted input is not supported on this platform yet' if uns else None)
            typed='M3 '+str(run)+' \u65e5\u672c\u8a9e \U0001f600'
            measured('type',lambda:call('web.type',{'selector':'#text','text':typed,'trusted':True}),
                'trusted input is not supported on this platform yet' if uns else None)
            measured('key',lambda:call('web.key',{'key':'Enter','trusted':True}),
                'trusted input is not supported on this platform yet' if uns else None)
            ev('document.getElementById("file").value="";return true;')
            upload=measured('upload',lambda:call('web.upload',{'selector':'#file','paths':[str(fixture)],'trusted':True}),
                'native file input is not supported on this platform yet' if uns else None)
            if not uns:
                expected_files=[{'name':fixture.name,'size':fixture.stat().st_size}]
                current=app.wait_until(lambda:read() if read()['files']==expected_files else None,5,'uploaded DOM files')
                assert current['clicks']==[{'isTrusted':True}]*(run+1),current
                assert current['text']==typed,current
                assert current['inputs'][-1]['isTrusted'] is True,current
                assert current['keys'][-1]['key']=='Enter' and current['keys'][-1]['isTrusted'] is True,current
                assert current['changes'][-1]=={'id':'file','isTrusted':True},current
                assert upload['files']==expected_files and upload['trusted'] is True,upload
                png=(out/f'shot-{run}.png').read_bytes()
                assert png[:8]==b'\x89PNG\r\n\x1a\n'
                assert list(struct.unpack('>II',png[16:24]))==[screenshot['width'],screenshot['height']]
                assert screenshot['width']>300 and screenshot['height']>200 and screenshot['dpr']>0,screenshot
                rows.append({'name':'page-proof','ok':True,'run':run,'value':current})
                save()
        if args.expect=='supported':
            clip={'x':10,'y':20,'width':160,'height':80}
            shot=measured('clip',lambda:call('web.screenshot',{'path':str(out/'clip.png'),'clip':clip}))
            assert (shot['width'],shot['height'])==(160,80),shot
            default=measured('default-path',lambda:call('web.screenshot',{}))
            assert Path(default['path']).is_absolute() and Path(default['path']).is_file()
            measured('relative-path',lambda:native('webpane_screenshot',{'path':'relative.png'}),'screenshot path must be absolute')
            for cmd,p in [('webpane_screenshot',{}),('webpane_input_trusted',{'action':{'kind':'click','x':1,'y':1}}),
                ('webpane_set_file_input',{'selector':'#file','paths':[str(fixture)]})]:
                measured('zero-budget-'+cmd,lambda cmd=cmd,p=p:native(cmd,{**p,'budgetMs':0,'command':'web.type'}),'web.type exceeded the 20s native budget')
            generation=ev('return window.__mycmux.generation;')
            measured('stale-input',lambda:native('webpane_input_trusted',{'action':{'kind':'insertText','text':'BAD','expectedGeneration':(generation+1)%2**32}}),'page changed since the target was resolved; snapshot again')
            measured('stale-upload',lambda:native('webpane_set_file_input',{'selector':'#file','paths':[str(fixture)],'expectedGeneration':(generation+1)%2**32}),'page changed since the target was resolved; snapshot again')
            measured('missing-selector',lambda:native('webpane_set_file_input',{'selector':'#missing','paths':[str(fixture)]}),'selector matched no element')
            measured('relative-upload',lambda:native('webpane_set_file_input',{'selector':'#file','paths':['relative.txt']}),'native file input paths must be absolute')
            measured('hidden-file',lambda:call('web.upload',{'selector':'#hidden-file','paths':[str(fixture)],'trusted':True}))
            current=app.wait_until(lambda:read() if read()['changes'][-1]['id']=='hidden-file' else None,5,'hidden input native change')
            assert current['changes'][-1]['isTrusted'] is True,current
            assert ev('return await document.getElementById("hidden-file").files[0].text();')==fixture.read_text()
            measured('append-text',lambda:call('web.type',{'selector':'#text','text':' tail','mode':'append','trusted':True}))
            assert read()['text']==typed+' tail'
            measured('editable-text',lambda:call('web.type',{'selector':'#editable','text':'Native \u65e5\u672c\u8a9e \U0001f600','trusted':True}))
            assert ev('return document.getElementById("editable").textContent;')=='Native \u65e5\u672c\u8a9e \U0001f600'
            assert read()['inputs'][-1]['isTrusted'] is True
            ev('document.getElementById("text").focus();return true;')
            measured('modified-key',lambda:call('web.key',{'key':'a','code':'KeyA','modifiers':['ctrl','shift'],'trusted':True}))
            last=read()['keys'][-1]
            assert last['isTrusted'] is True and last['ctrl'] is True and last['shift'] is True and last['code']=='KeyA',last
            point=ev('const r=document.getElementById("scroll").getBoundingClientRect();return {x:r.x+20,y:r.y+20};')
            measured('wheel',lambda:native('webpane_input_trusted',{'action':{'kind':'wheel',**point,'deltaX':0,'deltaY':80}}))
            current=measured('wheel-proof',lambda:app.wait_until(lambda:read() if read()['wheels'] else None,5,'trusted wheel'))
            assert current['wheels'][-1]['isTrusted'] is True and current['scroll']>0,current
            measured('untrusted-click',lambda:call('web.click',{'selector':'#count'}))
            assert read()['clicks'][-1]['isTrusted'] is False
            assert not app.dialogs(),'native file chooser appeared'
            assert not any(w.get('applicationActive') for w in app.windows()),'native input activated app'
        summary={}
        for name in ['screenshot','click','type','key','upload']:
            timings=[r['ms'] for r in rows if r['name']==name]
            summary[name]={'n':len(timings),'median_ms':statistics.median(timings),
                'p95_ms':sorted(timings)[math.ceil(.95*len(timings))-1],'max_ms':max(timings)}
        (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n',encoding='utf-8')
        status='PASS'
    except BaseException:
        status='FAIL'
        raise
    finally:
        server.shutdown()
        server.server_close()
        if app.pids():
            app.terminate(100)
            app.wait_exit(15)
        assert not app.pids()
        save()
    print(json.dumps({'status':status,'out':str(out),'summary':summary}),flush=True)

if __name__=='__main__':
    main()
