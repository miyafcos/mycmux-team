"""Repeatable S4 release measurements with CDP synthetic UI events.

Fixture construction uses the release's exported stores and its own-profile API.
Measured UI operations use click/key/pointer events. Native OS move input is
intercepted; tearout_synthetic_sample exercises the actual release transfer path.
This cannot test OS snap, physical pointer behavior, or a second physical screen.
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
from pathlib import Path
import re
import sys
import time
import traceback

from evidence_io import DEFAULT_DATA, dump
from cdp_client import own_call, page, ready, targets
from hidden_host import HiddenHost

HERE = Path(__file__).resolve().parent
METRICS = (HERE / "metrics.js").read_text(encoding="utf-8")


def install(p, native=False):
    p.eval(METRICS)
    if native:
        p.js("window.__s4.nativeCapture();return true;")


class Suite:
    def __init__(self, host, p, repetitions, synthetic_reveal=False):
        self.host, self.p, self.repetitions = host, p, repetitions
        self.rows = []
        self.fixtures = []
        self.started = dt.datetime.now(dt.timezone.utc).isoformat()
        self.synthetic_reveal=synthetic_reveal

    def record(self, row):
        row.update(profile=self.host.profile, port=self.host.port,
                   utc=dt.datetime.now(dt.timezone.utc).isoformat(), ordinal=len(self.rows)+1)
        self.rows.append(row)
        with (self.host.directory / "measurements.jsonl").open("a",encoding="utf-8",newline="\n") as out:
            out.write(json.dumps(row,ensure_ascii=True)+"\n")
        print(json.dumps({k: v for k,v in row.items() if k not in {"before","after","samples","actionResult"}}, ensure_ascii=True), flush=True)

    def measure(self, name, body, expected, budget=6500, p=None, steps=1):
        target = p or self.p
        target.tag(name)
        if self.host.stopped:
            raise RuntimeError("owned test machine stopped: " + self.host.record.get("stop_reason", ""))
        expression = ("const s=window.__s4;return await s.measure(" + json.dumps(name) + ",async release=>{" + body +
                      "},()=>{" + expected + "}," + str(budget) + ");")
        row = target.js(expression, timeout=max(25,budget/1000+10))
        row.update(entry="CDP synthetic UI", steps=steps)
        self.record(row)
        target.tag("unmeasured")
        return row

    def setup(self):
        install(self.p)
        # Explicit launcher fixture prevents invoking any user-configured external agent.
        fixture = self.p.js("""
const s=window.__s4,wid=crypto.randomUUID(),pid=crypto.randomUUID(),tid=crypto.randomUUID();
const tab={id:tid,sessionId:'pty-'+wid+'-'+pid+'-'+tid,agentId:'shell-starter',type:'launcher',label:'S4-anchor',createdAt:Date.now()};
const pane={id:pid,agentId:'shell-starter',sessionId:tab.sessionId,tabs:[tab],activeTabId:tid};
const w=s.L.getState().createWorkspace('S4 operations','1x1',[pane],[[pid]],{id:wid});
s.U.getState().setActivePaneId(tab.sessionId);await s.sleep(300);return {wid,pid,tid,anchor:tab.sessionId};
""")
        self.wid, self.pid = fixture["wid"], fixture["pid"]
        anchor = fixture["anchor"]
        for index in range(3):
            counter = self.host.directory / f"counter-{index}.txt"
            label = f"S4clock{index}"
            result = own_call(self.host.profile,"pane.spawn_tab",{
                "anchorSessionId":anchor, "activate":False, "label":label,
                "commandArgv":[sys.executable,"-u",str(HERE/"emitter.py"),"--counter",str(counter),"--label",label],
                "cwd":str(self.host.directory)})
            time.sleep(.35)
            state = self.p.js("return window.__s4.snapshot();")
            tab = next(t for w in state["workspaces"] for pn in w["panes"] for t in pn["tabs"] if t.get("label")==label)
            self.fixtures.append({"tab":tab,"counter":str(counter),"spawn":result})
            self.p.js("const s=window.__s4;s.pill("+json.dumps(tab["id"])+").click();await s.sleep(300);return true;")
        self.p.js("""
const s=window.__s4,base=s.L.getState().getWorkspace(s.L.getState().activeWorkspaceId),pid=crypto.randomUUID(),tid=crypto.randomUUID();
const tab={...base.panes[0].tabs.find(t=>t.type==='launcher'),id:tid,sessionId:'launcher-'+tid,label:'S4 receiver'};
const pane={...base.panes[0],id:pid,tabs:[tab],activeTabId:tid,sessionId:tab.sessionId,pinnedTabId:undefined};
window.__s4Receiver=s.L.getState().createWorkspace('S4 receiver','1x1',[pane],[[pid]],{activate:false});
window.__s4Base=structuredClone(s.L.getState().getWorkspace(base.id));
return true;
""")
        dump(self.host.directory / "fixture.json", {"home":fixture,"clocks":self.fixtures,"state":self.p.js("return window.__s4.snapshot();")})
        self.p.shot(self.host.directory / "fixture.png")

    def base(self, native=False):
        self.p.js("""
const s=window.__s4,base=structuredClone(window.__s4Base),receiver=structuredClone(window.__s4Receiver);
s.L.getState()._replaceWorkspaces([base,receiver]);s.L.getState().setActiveWorkspace(base.id);
s.U.getState().setZoomedPaneId(null);s.U.getState().setActivePaneId(base.panes[0].sessionId);
await s.sleep(200);return true;
""")
        self.p.js("return await window.__s4.setNative("+str(native).lower()+");")

