"""T1 repeatable drag benchmark. CDP/DOM events only; no physical input.

Uses copied test-machine helpers from the dispatch, and real stores/PTYs.
Each scene runs at nominal 120/125 Hz for two seconds, at least five times.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
DISPATCH = Path(r"C:\Users\miyaz\.claude\dispatch\261003-mycmux-smooth\t1")
sys.path.insert(0, str(DISPATCH / "e2e"))
import drive
import tmctl


def js(page, body):
    return drive.js(page, body, timeout=60)


ACCESS = r"""
const modules=await import(document.querySelector('script[type=module][src]').src);
const values=Object.values(modules).flatMap(v=>v?.useWorkspaceListStore?Object.values(v):[v]);
window.__smoothStore=values.find(v=>typeof v?.getState==='function'&&Array.isArray(v.getState().workspaces));
window.__smoothUi=values.find(v=>typeof v?.getState==='function'&&typeof v.getState().setActivePaneId==='function');
window.__smoothSettings=values.find(v=>typeof v?.getState==='function'&&typeof v.getState().setNativePaneTearoutEnabled==='function');
if(!window.__smoothStore) throw new Error('store access missing');
const api=window.__TAURI_INTERNALS__;
if(!window.__smoothCapture) {
  const fetch=window.fetch.bind(window);
  window.fetch=function(input,options) {
    if(String(input).includes('/tearout_start_move')) {
      window.__smoothMoving=JSON.parse(options.body);
      return Promise.resolve(new Response('null',{headers:{'Tauri-Response':'ok','Content-Type':'application/json'}}));
    }
    return fetch(input,options);
  };
  const bridge=window.chrome.webview,post=bridge.postMessage.bind(bridge);
  bridge.postMessage=function(data) {
    const message=typeof data==='string'?JSON.parse(data):data;
    if(message.cmd==='tearout_start_move') {
      window.__smoothMoving=message.payload;api.runCallback(message.callback,null);return;
    }
    return post(data);
  };
  window.__smoothCapture=true;
}
return true;
"""


METRIC_INSTALL = r"""
if(!window.__smoothMetricInstalled) {
  const api=window.__TAURI_INTERNALS__,get=api.callbacks.get.bind(api.callbacks);
  api.callbacks.get=function(id) {
    const callback=get(id);if(!callback)return callback;
    return function(data) {
      const m=window.__smoothMetric;
      if(!m?.active||data?.event!=='mycmux://tearout-native')return callback(data);
      const start=performance.now();
      m.received.add(data.payload.id+':'+data.payload.sequence);
      try{return callback(data);}finally{m.callback_ms.push(performance.now()-start);}
    };
  };
  const rect=Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect=function() {
    const m=window.__smoothMetric;
    if(!m?.active)return rect.call(this);
    const start=performance.now();
    try{return rect.call(this);}finally{m.rect_ms.push(performance.now()-start);}
  };
  for(const key of ['offsetWidth','offsetHeight']) {
    const descriptor=Object.getOwnPropertyDescriptor(HTMLElement.prototype,key);
    if(!descriptor?.get)continue;
    Object.defineProperty(HTMLElement.prototype,key,{...descriptor,get() {
      const m=window.__smoothMetric;if(!m?.active)return descriptor.get.call(this);
      const start=performance.now();
      try{return descriptor.get.call(this);}finally{m.size_ms.push(performance.now()-start);}
    }});
  }
  let previous=null;
  const tick=at=> {
    const m=window.__smoothMetric;
    if(m?.active) {if(previous!==null)m.raf_ms.push(at-previous);previous=at;}else previous=null;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  new PerformanceObserver(list=> {
    const m=window.__smoothMetric;if(m?.active)m.long_ms.push(...list.getEntries().map(e=>e.duration));
  }).observe({type:'longtask',buffered:false});
  new MutationObserver(entries=> {
    const m=window.__smoothMetric;if(!m?.active)return;
    m.mutations+=entries.length;
    for(const e of entries) for(const n of e.addedNodes??[]) {
      if(n.nodeType===1&&(n.matches('.pane-drop-result')||n.querySelector('.pane-drop-result')))m.frames_added++;
    }
  }).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class']});
  window.__smoothMetricInstalled=true;
}
window.__smoothMetric={active:false,raf_ms:[],callback_ms:[],rect_ms:[],size_ms:[],long_ms:[],received:new Set(),mutations:0,frames_added:0};
return window.__TAURI_INTERNALS__.metadata.currentWindow.label;
"""


TAKE = r"""
const m=window.__smoothMetric;m.active=false;
const stats=v=> {
 const s=v.slice().sort((a,b)=>a-b),q=p=>s.length?s[Math.min(s.length-1,Math.ceil(s.length*p)-1)]:null;
 return {count:s.length,median:q(.5),p95:q(.95),max:q(1),over20:s.filter(v=>v>20).length,over33:s.filter(v=>v>33).length};
};
return {raf:stats(m.raf_ms),raf_raw:m.raf_ms,callback:stats(m.callback_ms),rect:stats(m.rect_ms),size:stats(m.size_ms),
 long_ms:m.long_ms,long_over50:m.long_ms.filter(v=>v>50).length,received:m.received.size,
 events_per_second:m.received.size/2,mutations:m.mutations,frames_added:m.frames_added};
"""


def setup(page, profile):
    js(page, r"""
const b=tm.byText('\u30db\u30fc\u30e0\u3067\u65b0\u898f\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9');
if(!b)throw new Error('welcome button missing');b.click();await tm.sleep(2000);return true;
""")
    anchor = drive.panes(profile)["panes"][0]["tabs"][0]["sessionId"]
    env = {k: v for k, v in os.environ.items() if not k.startswith(("MYCMUX_", "CLAUDE"))}
    env.update(MYCMUX_RUNTIME_DIR=str(Path.home()/f".mycmux-{profile}"), PYTHONDONTWRITEBYTECODE="1")
    for index in range(4):
        p = subprocess.run([sys.executable, "-X", "utf8", str(ROOT/"scripts/mycmux_agent_cli.py"), "spawn-tab",
                            "--anchor-session", anchor, "--no-activate", "--label", f"smooth{index}", "--",
                            "powershell", "-NoLogo", "-NoExit", "-Command", "while ($true) { Start-Sleep -Seconds 60 }"],
                           env=env, capture_output=True, text=True, encoding="utf-8", timeout=60)
        if p.returncode: raise RuntimeError(p.stdout+p.stderr)
        time.sleep(.7)
    js(page, ACCESS)
    return js(page, r"""
if(window.__smoothSettings)window.__smoothSettings.getState().setNativePaneTearoutEnabled(true);
const s=window.__smoothStore.getState(),source=s.workspaces.find(w=>w.panes.some(p=>p.tabs.some(t=>t.type==='terminal')));
const tabs=source.panes.flatMap(p=>p.tabs).filter(t=>t.type==='terminal');
if(tabs.length!==4)throw new Error('requires four real terminals');
const panes=[0,1].map(i=>({...source.panes[0],id:i===0?source.panes[0].id:crypto.randomUUID(),
 tabs:tabs.slice(i*2,i*2+2),activeTabId:tabs[i*2+1].id,sessionId:tabs[i*2+1].sessionId}));
const arranged={...source,panes,splitColumns:panes.map(p=>[p.id]),columnWidths:[.5,.5],rowHeightsPerCol:[[1],[1]],
 columnDividerPins:[false],rowDividerPinsPerCol:[[],[]]};
const launcher=source.panes.flatMap(p=>p.tabs).find(t=>t.type==='launcher');
const others=[0,1,2].map(i=> {
 const tab={...launcher,id:crypto.randomUUID(),sessionId:'launcher-'+crypto.randomUUID()};
 const pane={...source.panes[0],id:crypto.randomUUID(),tabs:[tab],activeTabId:tab.id,sessionId:tab.sessionId};
 return {...source,id:crypto.randomUUID(),name:'reorder'+i,panes:[pane],splitColumns:[[pane.id]],columnWidths:[1],rowHeightsPerCol:[[1]]};
});
s._replaceWorkspaces([arranged,...others]);s.setActiveWorkspace(arranged.id);
if(window.__smoothUi)window.__smoothUi.getState().setActivePaneId(panes[1].sessionId);
await tm.sleep(1800);
return {workspace:arranged,workspaces:[arranged,...others],tab:panes[1].tabs[1],pane:panes[1]};
""")


def restore(page, fixture):
    return js(page, f"""
const f={json.dumps(fixture)};window.__smoothStore.getState()._replaceWorkspaces(f.workspaces);
window.__smoothStore.getState().setActiveWorkspace(f.workspace.id);
if(window.__smoothUi)window.__smoothUi.getState().setActivePaneId(f.pane.sessionId);
window.__smoothMoving=null;await tm.sleep(1200);return true;
""")


def grip(page, scene, fixture):
    return js(page, f"""
const f={json.dumps(fixture)},scene={json.dumps(scene)};
let el,x,y;
if(scene==='d') {{
 el=[...document.querySelectorAll('[data-dnd-workspace-target-id]')].find(e=>e.dataset.dndWorkspaceTargetId===f.workspace.id);
 const r=el.getBoundingClientRect();x=r.left+8;y=r.top+r.height/2;
}}else if(scene==='c') {{
 el=[...document.querySelectorAll('[data-dnd-pane-id]')].find(e=>e.dataset.dndPaneId===f.pane.id).querySelector('.pane-tabbar');
 const r=el.getBoundingClientRect();x=r.left+3;y=r.top+3;
}}else {{
 el=[...document.querySelectorAll('[data-tab-id]')].find(e=>e.dataset.tabId===f.tab.id&&e.offsetParent!==null);
 const r=el.getBoundingClientRect();x=r.left+r.width/2;y=r.top+r.height/2;
}}
if(!el)throw new Error('grip missing');window.__smoothGrip=el;
return {{x,y,bounds:(scene==='d'?el.closest('[data-dnd-workspace-sidebar=true]'):el.closest('.pane-tabbar')).getBoundingClientRect().toJSON()}};
""")


def detach(page, start):
    return js(page, f"""
const s={json.dumps(start)};tm.pe('pointerdown',window.__smoothGrip,s.x,s.y);
tm.pe('pointermove',window,s.x,s.y+100);
const end=performance.now()+7000;while(!window.__smoothMoving&&performance.now()<end)await tm.sleep(20);
if(!window.__smoothMoving)throw new Error('native handoff missing');
await tm.sleep(500);return window.__smoothMoving;
""")


def native_scene(page, host, moving, scene, policy, recorder):
    point = js(page, "const p=document.querySelector('[data-dnd-pane-id]'),r=p.getBoundingClientRect();return {x:r.left+r.width*.5,y:r.top+r.height*.5,w:r.width,h:r.height};")
    args = {**moving, "sourceLabel": "main", "receiver": "main", "clientX": point["x"], "clientY": point["y"], "phase": "move", "escaped": False,
            "diagnostics": True, "legacySamples": policy == "legacy", "recorder": recorder}
    result = js(host, f"""
const args={json.dumps(args)},point={json.dumps(point)},scene={json.dumps(scene)},pending=[],times=[];
const start=performance.now();
await new Promise(resolve=> {{const timer=setInterval(()=> {{
 const elapsed=performance.now()-start;if(elapsed>=2000){{clearInterval(timer);resolve();return;}}
 const phase=elapsed/2000;
 // b traverses a real receiver's edge/center, f stays within its center.
 args.clientX=point.x+(scene==='b'?Math.sin(phase*Math.PI*4)*point.w*.38:Math.sin(phase*Math.PI*4)*8);
 times.push(performance.now());pending.push(window.__TAURI_INTERNALS__.invoke('tearout_synthetic_sample',{{...args}}));
}},8);}});
const values=await Promise.all(pending);return {{sent:times.length,times,values,elapsed_ms:performance.now()-start}};
""")
    args.update(receiver=None, clientX=-1, clientY=-1, phase="end", escaped=True)
    result["end_args"] = args
    return result


def run_scene(page, port, scene, fixture, policy, recorder):
    restore(page, fixture)
    for p in drive.app_pages(port).values():
        try:
            js(p, f"window.__MYCMUX_TEAROUT_PERF__={str(recorder).lower()};return true;")
        finally:
            p.close()
    start = grip(page, scene, fixture)
    moving = None
    if scene in ("b", "f"):
        moving = detach(page, start)
    pages = drive.app_pages(port)
    for p in pages.values():
        js(p, METRIC_INSTALL)
        js(p, f"window.__MYCMUX_TEAROUT_PERF__={str(recorder).lower()};return true;")
    for p in pages.values(): js(p, "window.__smoothMetric.active=true;return true;")
    result = {}
    try:
        if moving:
            result["stream"] = native_scene(page, pages[moving["label"]], moving, scene, policy, recorder)
        else:
            result["pointer"] = js(page, f"""
const s={json.dumps(start)},scene={json.dumps(scene)},times=[];let ghostSeen=false;
tm.pe('pointerdown',window.__smoothGrip,s.x,s.y);
const start=performance.now();
await new Promise(resolve=> {{const timer=setInterval(()=> {{
 const elapsed=performance.now()-start;if(elapsed>=2000){{clearInterval(timer);resolve();return;}}
 let x=s.x,y=s.y;
 if(scene==='d')y=s.y+12+Math.sin(elapsed/2000*Math.PI*4)*10;
 else x=Math.max(s.bounds.left+16,Math.min(s.bounds.right-16,s.x-20+Math.sin(elapsed/2000*Math.PI*4)*18));
 if(scene==='c')x=s.bounds.left+34+Math.sin(elapsed/2000*Math.PI*4)*16;
 if(scene==='e'&&elapsed>1250)y=s.y+100;
 times.push(performance.now());tm.pe('pointermove',window,x,y);
 ghostSeen ||= Boolean(document.querySelector('.pane-drag-ghost'));
}},1000/120);}});
return {{sent:times.length,times,elapsed_ms:performance.now()-start,moving:window.__smoothMoving,ghost_seen:ghostSeen}};
""")
            moving = result["pointer"]["moving"]
            if scene in ("a", "c"):
                assert not moving and result["pointer"]["ghost_seen"], result["pointer"]
        result["windows"] = {label: js(p, TAKE) for label, p in pages.items()}
        if moving:
            args = result.get("stream", {}).get("end_args") or {**moving, "sourceLabel": "main", "receiver": None, "clientX": -1, "clientY": -1, "phase": "end", "escaped": True,
                                                                        "diagnostics": True, "legacySamples": policy == "legacy", "recorder": recorder}
            host = pages.get(moving["label"]) or drive.page(port, moving["label"])
            result["final"] = js(host, f"return await window.__TAURI_INTERNALS__.invoke('tearout_synthetic_sample',{json.dumps(args)});")
            if host not in pages.values(): host.close()
            time.sleep(.8)
        else:
            js(page, "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true;")
        return result
    finally:
        for p in pages.values(): p.close()


def summarize(records):
    summary = {}
    for scene in "abcdef":
        runs = [r for r in records if r["scene"] == scene]
        frames = [v for r in runs for v in r["result"]["windows"]["main"]["raf_raw"]]
        ordered = sorted(frames)
        def q(p): return ordered[min(len(ordered)-1, int(__import__('math').ceil(len(ordered)*p))-1)] if ordered else None
        summary[scene] = {"runs": len(runs), "frames": len(frames), "median_ms": q(.5), "p95_ms": q(.95), "max_ms": q(1),
                          "over20": sum(v>20 for v in frames), "over33": sum(v>33 for v in frames),
                          "long_over50": sum(r["result"]["windows"]["main"]["long_over50"] for r in runs),
                          "rect_reads": sum(r["result"]["windows"]["main"]["rect"]["count"] for r in runs),
                          "received": sum(r["result"]["windows"]["main"]["received"] for r in runs)}
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("exe", type=Path)
    parser.add_argument("tag")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--scenes", default="abcdef")
    parser.add_argument("--policy", choices=("current", "legacy"), default="current")
    parser.add_argument("--recorder", action="store_true")
    args = parser.parse_args()
    assert args.runs >= 5
    exe = args.exe.resolve()
    profile = "t1smooth"+datetime.now().strftime("%m%d%H%M%S")
    out = DISPATCH/"measurements"/args.tag
    out.mkdir(parents=True, exist_ok=False)
    records = []
    pid = None
    page = None
    try:
        pid = tmctl.launch(exe, profile, 9310)
        page = drive.page(9310)
        assert js(page, "return await window.__TAURI_INTERNALS__.invoke('get_test_profile');") == profile
        fixture = setup(page, profile)
        for scene in args.scenes:
            for run in range(args.runs):
                result = run_scene(page, 9310, scene, fixture, args.policy, args.recorder)
                record = {"scene": scene, "run": run+1, "result": result}
                records.append(record)
                (out/f"{scene}-{run+1}.json").write_text(json.dumps(record, indent=2)+"\n", encoding="utf-8")
                print(json.dumps({"scene":scene,"run":run+1,"main":result["windows"]["main"]|{"raf_raw":None},"final":result.get("final")}), flush=True)
        report = {"exe": str(exe), "sha256": hashlib.sha256(exe.read_bytes()).hexdigest(), "profile":profile,"port":9310,
                "head":subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip(),
                  "script_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  "utc":datetime.now(timezone.utc).isoformat(),"policy":args.policy,"recorder":args.recorder,
                  "runs":args.runs,"summary":summarize(records),"records":records}
        (out/"summary.json").write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
        print(json.dumps(report["summary"]), flush=True)
    finally:
        if page: page.close()
        pid = pid or tmctl.find_pid(exe, profile)
        if pid: tmctl.stop(exe, profile, pid)


if __name__ == "__main__": main()
