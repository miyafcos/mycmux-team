"""Same S4 counter, fixture, UI actions and sampling before/after; isolated S5 host.

Busy/agent metadata and kill faults are deliberate fixtures, not live-agent detection.
No external agent, hardware input, build, installation, production profile or deletion.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
import sys
import time
import traceback

from cdp_client import ready, own_call
from evidence_io import dump
import hidden_host
from fixture import Suite, HERE


class CloseSuite(Suite):
    def emit(self, label):
        self.base(False)
        counter = self.host.directory / (label + ".txt")
        own_call(self.host.profile, "pane.spawn_tab", {
            "anchorSessionId": self.fixtures[0]["tab"]["sessionId"], "activate": False, "label": label,
            "commandArgv": [sys.executable, "-u", str(HERE/"emitter.py"), "--counter", str(counter), "--label", label],
        })
        tab = self.p.js("return window.__s4.L.getState().workspaces.flatMap(w=>w.panes.flatMap(p=>p.tabs)).find(t=>t.label==="+json.dumps(label)+");")
        self.p.js("window.__s4.pill("+json.dumps(tab["id"])+").click();await window.__s4.sleep(450);return true;")
        self.wait_counter(tab, counter)
        return self.settled_tab(tab), counter

    def alive(self, tab):
        return self.p.js("return await window.__TAURI_INTERNALS__.invoke('is_session_alive',{sessionId:"+json.dumps(tab["sessionId"])+"});")

    def sample(self, tab, counter, count=4):
        samples = []
        for _ in range(count):
            lines = self.read_output(tab)
            matches = re.findall(r"PID=(\d+) SEQ=(\d+)", "\n".join(lines))
            samples.append({"alive": self.alive(tab), "counter": self.read_counter(counter),
                            "pid": int(matches[-1][0]) if matches else None,
                            "output_seq": int(matches[-1][1]) if matches else None})
            time.sleep(.4)
        return samples

    def stable(self, samples):
        return (all(s["alive"] for s in samples) and len({s["pid"] for s in samples}) == 1
                and samples[0]["pid"] is not None
                and all(b["counter"] > a["counter"] and b["output_seq"] > a["output_seq"] for a,b in zip(samples,samples[1:])))

    def action(self, tab, entry):
        tid=json.dumps(tab["id"])
        if entry=="middle": body="s.pill("+tid+").dispatchEvent(new MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true}));"
        elif entry=="key": body="s.key('w',{ctrlKey:true,altKey:true});"
        elif entry=="cli":
            command="pane.close_tabs" if tab.get("type")=="launcher" else "pane.close_tab"
            args={"tabIds":[tab["id"]]} if command=="pane.close_tabs" else {"sessionId":tab["sessionId"]}
            body="try{await s.command("+json.dumps(command)+","+json.dumps(args)+");}catch(e){window.__s5CloseError=String(e);}"
        else: body="const root=s.pill("+tid+");const b=s.button('\u30da\u30a4\u30f3\u3092\u9589\u3058\u308b',root)||(root?s.button('\u30bf\u30d6\u3092\u9589\u3058\u308b',root.closest('[data-dnd-pane-id]')):null);if(!b)return {available:false};b.click();"
        return self.p.js("const s=window.__s4;window.__s5CloseError=null;"+body+"await s.sleep(200);return {available:true,error:window.__s5CloseError,prompt:document.querySelector('[role=dialog][aria-modal=true]')?.innerText||null};")

    def answer(self, accept):
        return self.p.js("const d=document.querySelector('[role=dialog][aria-modal=true]');if(!d)return false;d.querySelectorAll('button')["+str(1 if accept else 0)+"].click();await window.__s4.sleep(150);return true;")

    def fixed_policy(self, tab, metadata):
        # These are explicit policy fixtures on real owned counters. Hold their
        # declared inputs constant while unrelated backend telemetry arrives.
        return self.p.js("const s=window.__s4,sid="+json.dumps(tab["sessionId"])+",fixed="+json.dumps(metadata)+";if(!window.__s5FixedPolicies){window.__s5FixedPolicies={};const original=s.M.getState().setMetadata;s.M.setState({setMetadata:(id,data)=>original(id,{...data,...window.__s5FixedPolicies[id]})});}window.__s5FixedPolicies[sid]=fixed;s.M.getState().setMetadata(sid,fixed);return {metadata:s.M.getState().metadata[sid],volatile:s.M.getState().volatileMetadata[sid]};")

    def approve(self):
        # Recheck can legitimately present another prompt after async hydration.
        answers = 0
        while self.p.js("return !!document.querySelector('[role=dialog][aria-modal=true]');"):
            if answers >= 5:
                raise RuntimeError("fixture close confirmation did not settle")
            self.answer(True)
            answers += 1
        return answers

    def base(self, native=False):
        # Every case starts with no unanswered confirmation from its predecessor.
        while self.answer(False):
            pass
        return super().base(native)

    def before_after(self):
        for i in range(self.repetitions):
            tab,counter=self.emit(f"S5-last-{i}")
            self.p.js("const s=window.__s4,w=structuredClone(s.L.getState().getWorkspace("+json.dumps(self.wid)+")),t="+json.dumps(tab)+";w.panes=[{...w.panes[0],tabs:[t],activeTabId:t.id,sessionId:t.sessionId,pinnedTabId:undefined}];w.splitColumns=[[w.panes[0].id]];s.L.getState()._replaceWorkspaces([w]);s.U.getState().setActivePaneId(t.sessionId);await s.sleep(200);return true;")
            before=self.p.js("return window.__s4.snapshot();")
            # The CLI and the UI middle-click are exactly the S4 close-safety actions.
            cli=self.action(tab,"cli")
            result=self.action(tab,"middle")
            time.sleep(.2)
            alive=self.alive(tab)
            samples=self.sample(tab,counter) if alive else []
            after=self.p.js("return window.__s4.snapshot();")
            self.record({"name":"P0-01-last-middle","iteration":i,"pass":alive and self.stable(samples) and before==after,
                         "product_failure":not alive,"cli":cli,"result":result,"samples":samples,"before":before,"after":after})
            self.p.shot(self.host.directory/f"last-middle-{i}.png")
            tab,counter=self.emit(f"S5-working-{i}")
            policy=self.fixed_policy(tab,{"processIsShell":False,"agentStatus":"working","backendProcessStatus":"working"})
            dump(self.host.directory/f"working-policy-{i}.json",policy)
            result=self.action(tab,"x")
            alive=self.alive(tab)
            samples=self.sample(tab,counter) if result["prompt"] and alive else []
            self.record({"name":"P0-03-working-x","iteration":i,"pass":bool(result["prompt"] and alive and self.stable(samples)),
                         "prompt":bool(result["prompt"]),"alive_before_approval":alive,"result":result,"samples":samples})
            self.p.shot(self.host.directory/f"working-confirm-{i}.png")
            if result["prompt"]: self.answer(False)
            if self.alive(tab):
                after_cancel=self.sample(tab,counter)
                self.record({"name":"C2-cancel-counter","iteration":i,"pass":self.stable(after_cancel),"samples":after_cancel})
                self.action(tab,"x"); self.approve()
            self.base(False)
            tid=self.fixtures[1]["tab"]["id"]; new_name=f"S5 renamed {i}"
            # Copied from S4.basic: context menu, first rename item, React setter, Enter.
            row=self.measure("P2-01-inactive-rename", "const el=s.pill("+json.dumps(tid)+");const point=s.center(el);el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:point.x,clientY:point.y}));await s.frame();const menu=document.querySelector('[role=menu] [role=menuitem]');if(!menu)throw new Error('rename menu missing');menu.click();await s.frame();const input=el.querySelector('input')||document.querySelector('.pane-tabbar input');if(!input){release();return {inputFound:false};}Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,"+json.dumps(new_name)+");input.dispatchEvent(new Event('input',{bubbles:true}));await s.frame();release();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));",
                "return s.L.getState().workspaces.some(w=>w.panes.some(p=>p.tabs.some(t=>t.id==="+json.dumps(tid)+"&&t.label==="+json.dumps(new_name)+")));",steps=3,budget=600)
            self.p.shot(self.host.directory/f"inactive-rename-{i}.png")

    def kill_probe(self, tab, mode):
        config=json.dumps({"sessionId":tab["sessionId"],"mode":mode})
        self.p.js("const config="+config+""";
const api=window.__TAURI_INTERNALS__,bridge=window.chrome.webview;
const state={mode:config.mode,count:0,nativeCalls:0,bypass:0,routes:[],
  invoke:api.invoke.bind(api),fetch:window.fetch.bind(window),post:bridge.postMessage.bind(bridge)};
window.__s5KillProbe=state;
const actual=(args)=>{
  state.nativeCalls++;state.bypass++;
  let result;
  try{result=state.invoke('kill_session',args);}catch(error){state.bypass--;return Promise.reject(error);}
  return Promise.resolve(result).finally(()=>{state.bypass--;});
};
const capture=(cmd,args,route)=>{
  if(cmd!=='kill_session'||args?.sessionId!==config.sessionId||state.bypass)return null;
  state.count++;state.routes.push({route,at:Date.now()});
  if(state.mode==='reject')return Promise.reject(new Error('S5 injected rejection'));
  if(state.mode==='delay'||state.mode==='timeout')
    return new Promise((yes,no)=>setTimeout(()=>actual(args).then(yes,no),state.mode==='timeout'?11500:1200));
  return actual(args);
};
// The bundled core retains invoke. Catch both real transports, as S4's capture does.
window.fetch=function(input,options){
  if(/\/kill_session(?:\?|$)/.test(String(input))){
    let args;try{args=JSON.parse(options.body);}catch{return state.fetch(input,options);}
    const intercepted=capture('kill_session',args,'fetch');
    if(intercepted)return intercepted.then(
      value=>new Response(JSON.stringify(value===undefined?null:value),{headers:{'Tauri-Response':'ok','Content-Type':'application/json'}}),
      error=>new Response(JSON.stringify(String(error)),{headers:{'Tauri-Response':'error','Content-Type':'application/json'}}));
  }
  return state.fetch(input,options);
};
bridge.postMessage=function(data){
  const msg=typeof data==='string'?JSON.parse(data):data;
  const intercepted=capture(msg.cmd,msg.payload,'webview');
  if(intercepted){
    intercepted.then(value=>api.runCallback(msg.callback,value),error=>api.runCallback(msg.error,String(error)));
    return;
  }
  return state.post(data);
};
return true;
""")

    def probe_state(self, remove=False):
        return self.p.js("const f=window.__s5KillProbe;const result={count:f.count,nativeCalls:f.nativeCalls,routes:f.routes};"
                        +("window.fetch=f.fetch;window.chrome.webview.postMessage=f.post;delete window.__s5KillProbe;" if remove else "")
                        +"return result;")

    def wait_removed(self, tab):
        return self.p.js("const s=window.__s4,id="+json.dumps(tab["id"])+";const end=performance.now()+2500;while(performance.now()<end){if(!s.L.getState().workspaces.some(w=>w.panes.some(p=>p.tabs.some(t=>t.id===id))))return true;await s.sleep(50);}return false;")

    def faults(self):
        for mode in ("reject","delay","timeout"):
            tab,counter=self.emit("S5-fault-"+mode)
            self.kill_probe(tab,mode)
            try:
                result=self.action(tab,"x");self.approve()
                if mode=="timeout":time.sleep(10.1)
                elif mode=="delay":time.sleep(.1)
                retained=self.p.js("return window.__s4.L.getState().workspaces.some(w=>w.panes.some(p=>p.tabs.some(t=>t.id==="+json.dumps(tab["id"])+")));")
                alive=self.alive(tab)
                self.p.shot(self.host.directory/("fault-"+mode+".png"))
                if mode!="reject":
                    self.action(tab,"x")
                    time.sleep(1.5)
                    removed=self.wait_removed(tab)
                initial=self.probe_state()
                if mode=="reject":
                    self.p.js("window.__s5KillProbe.mode='count';return true;")
                    self.action(tab,"x");self.approve()
                    removed=self.wait_removed(tab)
                # A second explicit close after completion must never send another kill.
                post_closed=self.action(tab,"cli")
                final=self.probe_state()
                alive_final=self.alive(tab)
                expected_attempts=2 if mode=="reject" else 1
                passed=(retained and alive and initial["count"]==1
                        and initial["nativeCalls"]==(0 if mode=="reject" else 1)
                        and removed and not alive_final and final["count"]==expected_attempts
                        and final["nativeCalls"]==1)
                self.record({"name":"C3-"+mode,"pass":passed,"retained_while_live":retained,"alive_while_retained":alive,
                             "initial_probe":initial,"final_probe":final,"removed_after_result":removed,
                             "alive_after_completion":alive_final,"post_closed_cli":post_closed})
            finally:
                self.probe_state(remove=True)


    def last_entry_matrix(self):
        tab,counter=self.emit("S5-last-entry-matrix")
        self.p.js("const s=window.__s4,w=structuredClone(s.L.getState().getWorkspace("+json.dumps(self.wid)+")),t="+json.dumps(tab)+";w.panes=[{...w.panes[0],tabs:[t],activeTabId:t.id,sessionId:t.sessionId,pinnedTabId:undefined}];w.splitColumns=[[w.panes[0].id]];s.L.getState()._replaceWorkspaces([w]);s.U.getState().setActivePaneId(t.sessionId);await s.sleep(200);return true;")
        for entry in ("x","middle","key","cli"):
            before=self.p.js("return window.__s4.snapshot();")
            result=self.action(tab,entry)
            samples=self.sample(tab,counter)
            after=self.p.js("return window.__s4.snapshot();")
            self.record({"name":"C1-last-"+entry,"pass":before==after and self.stable(samples),"result":result,"samples":samples,"before":before,"after":after})


    def close_matrix(self):
        for kind in ("terminal", "launcher"):
            for shape in ("singleton", "multiple-panes", "multiple-tabs"):
                for entry in ("x", "middle", "key", "cli"):
                    counter = None
                    if kind == "terminal":
                        tab,counter = self.emit("S5-matrix-"+shape+"-"+entry)
                    else:
                        self.base(False)
                        tab = self.p.js("const id=crypto.randomUUID();return {id,sessionId:'launcher-'+id,type:'launcher',agentId:'shell-starter',label:'S5 launcher'};")
                    config = json.dumps({"tab":tab,"shape":shape,"wid":self.wid})
                    self.p.js("const s=window.__s4,c="+config+",w=structuredClone(s.L.getState().getWorkspace(c.wid)),p={...w.panes[0],tabs:[c.tab],activeTabId:c.tab.id,sessionId:c.tab.sessionId,pinnedTabId:undefined};const id=crypto.randomUUID(),g={id,sessionId:'launcher-'+id,type:'launcher',agentId:'shell-starter',label:'S5 survivor'};w.panes=[p];if(c.shape==='multiple-tabs')p.tabs.push(g);if(c.shape==='multiple-panes')w.panes.push({...p,id:crypto.randomUUID(),tabs:[g],activeTabId:g.id,sessionId:g.sessionId});w.splitColumns=w.panes.map(p=>[p.id]);s.L.getState()._replaceWorkspaces([w]);s.U.getState().setActivePaneId(c.tab.sessionId);await s.sleep(250);return true;")
                    before = self.p.js("return window.__s4.snapshot();")
                    result = self.action(tab,entry)
                    refused = shape == "singleton" or (shape == "multiple-tabs" and entry == "key")
                    if not refused and result.get("prompt"): self.approve()
                    time.sleep(.35)
                    after = self.p.js("return window.__s4.snapshot();")
                    retained = any(t["id"] == tab["id"] for w in after["workspaces"] for p in w["panes"] for t in p["tabs"])
                    samples = self.sample(tab,counter) if refused and counter else []
                    alive = self.alive(tab) if kind == "terminal" else False
                    passed = (before == after and retained and (self.stable(samples) if counter else True)) if refused else (not retained and not alive)
                    self.record({"name":"C1-"+kind+"-"+shape+"-"+entry,"pass":passed,"expected_refusal":refused,"result":result,"retained":retained,"alive":alive,"samples":samples,"before":before,"after":after})

    def confirmation_matrix(self, only=None):
        # These are explicit metadata policy inputs on real owned counters.
        cases=[
            ("working",{"processIsShell":False,"agentStatus":"working"},True),
            ("waiting-agent",{"processIsShell":False,"agentKind":"codex","agentStatus":"waiting"},True),
            ("idle-shell",{"processIsShell":True,"agentStatus":"idle"},False),
            ("live-agent",{"processIsShell":False,"agentKind":"codex","agentStatus":"idle"},True),
            ("busy-non-agent",{"processIsShell":False,"outputActive":True},True),
            ("declared",{},False),
        ]
        for name,metadata,expected in cases:
            if only is not None and name not in only:continue
            counter=None
            if name=="declared":
                self.base(False)
                tab=self.p.js("const s=window.__s4,w=structuredClone(s.L.getState().getWorkspace("+json.dumps(self.wid)+")),p=w.panes[0],id=crypto.randomUUID(),t={id,sessionId:'pty-'+id,type:'terminal',agentId:'shell-starter',agentKind:'codex',lifecycle:'declared',label:'S5 declared'};p.tabs.push(t);s.L.getState()._replaceWorkspaces([w]);await s.sleep(250);return t;")
            else:tab,counter=self.emit("S5-policy-"+name)
            self.kill_probe(tab,"count")
            policy=self.fixed_policy(tab,metadata)
            dump(self.host.directory/("policy-"+name+".json"),policy)
            before=self.p.js("return window.__s4.snapshot();")
            entry="middle" if name=="declared" else "x"
            try:
                result=self.action(tab,entry)
                if expected:
                    initial=self.probe_state()
                    alive=self.alive(tab)
                    samples=self.sample(tab,counter)
                    self.answer(False)
                    cancelled=self.sample(tab,counter)
                    after=self.p.js("return window.__s4.snapshot();")
                    passed=bool(result.get("prompt")) and initial["count"]==0 and alive and self.stable(samples) and self.stable(cancelled) and before==after
                else:
                    samples=[];cancelled=[]
                    removed=self.wait_removed(tab)
                    initial=self.probe_state()
                    passed=not result.get("prompt") and removed and initial["count"]==(0 if name=="declared" else 1) and initial["nativeCalls"]==(0 if name=="declared" else 1)
                self.record({"name":"C2-policy-"+name,"pass":passed,"expected_confirmation":expected,"prompt":bool(result.get("prompt")),
                             "kills_before_approval":initial["count"],"native_calls":initial["nativeCalls"],"probe_routes":initial["routes"],
                             "entry":entry,"action_result":result,"samples":samples,"cancelled_samples":cancelled})
            finally:self.probe_state(remove=True)


    def rename_matrix(self):
        for state in ("active","inactive","pinned","declared","overflow"):
            for entry in ("context","other"):
                for i in range(self.repetitions):
                    self.base(False)
                    tid=self.fixtures[2 if state=="active" else 1]["tab"]["id"]
                    if state in ("declared","overflow","pinned"):
                        tid=self.p.js("const s=window.__s4,w=structuredClone(s.L.getState().getWorkspace("+json.dumps(self.wid)+")),p=w.panes[0],state="+json.dumps(state)+";let t=p.tabs[2];if(state==='declared'){t={id:crypto.randomUUID(),sessionId:'pty-'+crypto.randomUUID(),agentId:'shell-starter',type:'terminal',lifecycle:'declared',agentKind:'codex',label:'Unstarted'};p.tabs.push(t);}if(state==='pinned')p.pinnedTabId=t.id;if(state==='overflow'){for(let n=0;n<40;n++)p.tabs.push({id:crypto.randomUUID(),sessionId:'launcher-'+crypto.randomUUID(),type:'launcher',agentId:'shell-starter',label:'Extra '+n});t=p.tabs[p.tabs.length-1];}s.L.getState()._replaceWorkspaces([w]);await s.sleep(200);return t.id;")
                    before=self.p.js("return window.__s4.snapshot();")
                    def open_editor():
                        if state=="overflow":
                            return self.p.js("const s=window.__s4;s.button('\\u30da\\u30a4\\u30f3\\u4e00\\u89a7').click();await s.frame();const row=document.querySelector('[data-menu-tab-id=\\\""+tid+"\\\"]');if(!row)throw new Error('overflow row missing');row.scrollIntoView({block:'nearest'});"+("row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));" if entry=="context" else "row.querySelector('.pane-tab-menu-rename-btn').click();")+"await s.frame();return !!document.querySelector('[data-pane-tab-rename-input]');")
                        action=("el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await s.frame();document.querySelector('[role=menu] [role=menuitem]').click();" if entry=="context" else "el.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));el.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:2}));el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2,cancelable:true}));")
                        return self.p.js("const s=window.__s4,el=s.pill("+json.dumps(tid)+");"+action+"await s.frame();return !!document.querySelector('[data-pane-tab-rename-input]');")
                    opened=open_editor()
                    if not opened: raise RuntimeError("rename input missing: "+state+" "+entry)
                    if i==0: self.p.shot(self.host.directory/f"rename-editor-{state}-{entry}.png")
                    label=f"Renamed {state} {entry} {i}"
                    def finish(value,key):
                        self.p.js("const s=window.__s4,input=document.querySelector('[data-pane-tab-rename-input]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,"+json.dumps(value)+");input.dispatchEvent(new Event('input',{bubbles:true}));await s.frame();input.dispatchEvent(new KeyboardEvent('keydown',{key:"+json.dumps(key)+",bubbles:true,cancelable:true}));await s.frame();return true;")
                    finish(label,"Enter")
                    open_editor(); finish("Cancelled","Escape")
                    after=self.p.js("return window.__s4.snapshot();")
                    renamed=next(t for w in after["workspaces"] for p in w["panes"] for t in p["tabs"] if t["id"]==tid)
                    before_panes=[(p["id"],p["activeTabId"]) for w in before["workspaces"] for p in w["panes"]]
                    after_panes=[(p["id"],p["activeTabId"]) for w in after["workspaces"] for p in w["panes"]]
                    passed=renamed.get("label")==label and before["activeSession"]==after["activeSession"] and before_panes==after_panes
                    if state=="declared": passed=passed and renamed.get("lifecycle")=="declared" and not self.alive(renamed)
                    self.record({"name":"C4-"+state+"-"+entry,"iteration":i,"pass":passed,"label":renamed.get("label"),"before_active":before["activeSession"],"after_active":after["activeSession"],"lifecycle":renamed.get("lifecycle")})
                    if i==0: self.p.shot(self.host.directory/f"rename-{state}-{entry}.png")

    def summary(self):
        summary={"profile":self.host.profile,"binary_sha256":hidden_host.SHA256,"rows":len(self.rows),"passed":sum(bool(r.get("pass")) for r in self.rows),
                 "counts":{name:{"runs":sum(r["name"]==name for r in self.rows),"passed":sum(r["name"]==name and bool(r.get("pass")) for r in self.rows)} for name in sorted({r["name"] for r in self.rows})}}
        dump(self.host.directory/"summary.json",summary)
        return summary

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--profile",required=True); parser.add_argument("--port",type=int,default=9380)
    parser.add_argument("--exe",type=Path,required=True); parser.add_argument("--sha256",required=True)
    parser.add_argument("--repetitions",type=int,default=3); parser.add_argument("--faults",action="store_true")
    parser.add_argument("--followup",action="store_true")
    args=parser.parse_args(); hidden_host.SOURCE_EXE=args.exe; hidden_host.SHA256=args.sha256.lower()
    host=hidden_host.HiddenHost(args.profile,args.port); suite=None
    try:
        with host:
            p=ready(args.port,args.profile)
            try:
                suite=CloseSuite(host,p,args.repetitions);suite.setup()
                if args.followup:
                    suite.confirmation_matrix();suite.faults()
                else:
                    suite.before_after()
                    if args.faults:
                        suite.last_entry_matrix();suite.close_matrix();suite.confirmation_matrix();suite.faults();suite.rename_matrix()
                summary=suite.summary(); p.shot(host.directory/"final.png")
            finally: p.close()
        print(json.dumps({"directory":str(host.directory),"summary":summary},ensure_ascii=True),flush=True)
        return 0
    except Exception:
        dump(host.directory/"exception.json",{"traceback":traceback.format_exc()})
        if suite: suite.summary()
        print(traceback.format_exc(),flush=True); return 2

if __name__=="__main__": raise SystemExit(main())
