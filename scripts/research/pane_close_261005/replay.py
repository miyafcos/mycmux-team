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
        return tab, counter

    def alive(self, tab):
        return self.p.js("return await window.__TAURI_INTERNALS__.invoke('is_session_alive',{sessionId:"+json.dumps(tab["sessionId"])+"});")

    def sample(self, tab, counter, count=4):
        samples = []
        for _ in range(count):
            lines = own_call(self.host.profile, "pane.read", {"sessionId": tab["sessionId"], "lines": 12})
            matches = re.findall(r"PID=(\d+) SEQ=(\d+)", "\n".join(lines))
            samples.append({"alive": self.alive(tab), "counter": int(counter.read_text()),
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
        elif entry=="cli": body="try{await s.command('pane.close_tab',{sessionId:"+json.dumps(tab["sessionId"])+"});}catch(e){window.__s5CloseError=String(e);}"
        else: body="const b=s.button('\\u30da\\u30a4\\u30f3\\u3092\\u9589\\u3058\\u308b',s.pill("+tid+"));if(!b)return {available:false};b.click();"
        return self.p.js("const s=window.__s4;window.__s5CloseError=null;"+body+"await s.sleep(200);return {available:true,error:window.__s5CloseError,prompt:document.querySelector('[role=dialog][aria-modal=true]')?.innerText||null};")

    def answer(self, accept):
        return self.p.js("const d=document.querySelector('[role=dialog][aria-modal=true]');if(!d)return false;d.querySelectorAll('button')["+str(1 if accept else 0)+"].click();await window.__s4.sleep(150);return true;")

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
            self.p.js("window.__s4.M.getState().setMetadata("+json.dumps(tab["sessionId"])+",{processIsShell:false,agentStatus:'working',backendProcessStatus:'working'});return true;")
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
                self.action(tab,"x"); self.answer(True)
            self.base(False)
            tid=self.fixtures[1]["tab"]["id"]; new_name=f"S5 renamed {i}"
            # Copied from S4.basic: context menu, first rename item, React setter, Enter.
            row=self.measure("P2-01-inactive-rename", "const el=s.pill("+json.dumps(tid)+");const point=s.center(el);el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:point.x,clientY:point.y}));await s.frame();const menu=document.querySelector('[role=menu] [role=menuitem]');if(!menu)throw new Error('rename menu missing');menu.click();await s.frame();const input=el.querySelector('input')||document.querySelector('.pane-tabbar input');if(!input){release();return {inputFound:false};}Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,"+json.dumps(new_name)+");input.dispatchEvent(new Event('input',{bubbles:true}));await s.frame();release();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));",
                "return s.L.getState().workspaces.some(w=>w.panes.some(p=>p.tabs.some(t=>t.id==="+json.dumps(tid)+"&&t.label==="+json.dumps(new_name)+")));",steps=3,budget=600)
            self.p.shot(self.host.directory/f"inactive-rename-{i}.png")

    def faults(self):
        for mode in ("reject","delay","timeout"):
            tab,counter=self.emit("S5-fault-"+mode)
            payload=json.dumps({"sessionId":tab["sessionId"],"mode":mode})
            self.p.js("const config="+payload+";const api=window.__TAURI_INTERNALS__,original=api.invoke;window.__s5Fault={original,count:0};api.invoke=function(cmd,args,...rest){if(cmd==='kill_session'&&args.sessionId===config.sessionId){window.__s5Fault.count++;if(config.mode==='reject')return Promise.reject(new Error('S5 injected rejection'));return new Promise((yes,no)=>setTimeout(()=>original.call(api,cmd,args,...rest).then(yes,no),config.mode==='timeout'?11500:1200));}return original.call(api,cmd,args,...rest);};return true;")
            result=self.action(tab,"x"); self.answer(True)
            if mode=="timeout": time.sleep(10.1)
            elif mode=="delay": time.sleep(.1)
            retained=self.p.js("return window.__s4.L.getState().workspaces.some(w=>w.panes.some(p=>p.tabs.some(t=>t.id==="+json.dumps(tab["id"])+"))); ")
            alive=self.alive(tab)
            self.p.shot(self.host.directory/("fault-"+mode+".png"))
            if mode!="reject":
                self.action(tab,"x")
                time.sleep(1.5)
            state=self.p.js("const f=window.__s5Fault;window.__TAURI_INTERNALS__.invoke=f.original;return {count:f.count,retained:window.__s4.L.getState().workspaces.some(w=>w.panes.some(p=>p.tabs.some(t=>t.id==="+json.dumps(tab["id"])+")))};")
            self.record({"name":"C3-"+mode,"pass":retained and alive and state["count"]==1 and (state["retained"] if mode=="reject" else not state["retained"]),"retained_while_live":retained,"alive_while_retained":alive,"result":state})
            if mode=="reject": self.action(tab,"x"); self.answer(True)

    def last_entry_matrix(self):
        tab,counter=self.emit("S5-last-entry-matrix")
        self.p.js("const s=window.__s4,w=structuredClone(s.L.getState().getWorkspace("+json.dumps(self.wid)+")),t="+json.dumps(tab)+";w.panes=[{...w.panes[0],tabs:[t],activeTabId:t.id,sessionId:t.sessionId,pinnedTabId:undefined}];w.splitColumns=[[w.panes[0].id]];s.L.getState()._replaceWorkspaces([w]);s.U.getState().setActivePaneId(t.sessionId);await s.sleep(200);return true;")
        for entry in ("x","middle","key","cli"):
            before=self.p.js("return window.__s4.snapshot();")
            result=self.action(tab,entry)
            samples=self.sample(tab,counter)
            after=self.p.js("return window.__s4.snapshot();")
            self.record({"name":"C1-last-"+entry,"pass":before==after and self.stable(samples),"result":result,"samples":samples,"before":before,"after":after})

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
    args=parser.parse_args(); hidden_host.SOURCE_EXE=args.exe; hidden_host.SHA256=args.sha256.lower()
    host=hidden_host.HiddenHost(args.profile,args.port); suite=None
    try:
        with host:
            p=ready(args.port,args.profile)
            try:
                suite=CloseSuite(host,p,args.repetitions); suite.setup(); suite.before_after()
                if args.faults:
                    suite.last_entry_matrix(); suite.faults(); suite.rename_matrix()
                summary=suite.summary(); p.shot(host.directory/"final.png")
            finally: p.close()
        print(json.dumps({"directory":str(host.directory),"summary":summary},ensure_ascii=True),flush=True)
        return 0
    except Exception:
        dump(host.directory/"exception.json",{"traceback":traceback.format_exc()})
        if suite: suite.summary()
        print(traceback.format_exc(),flush=True); return 2

if __name__=="__main__": raise SystemExit(main())
