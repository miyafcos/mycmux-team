"""Isolated CDP checks and a 120 Hz probe; never sends physical input."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tmp/tearout-verification/i3"
E2E = OUT / "e2e"
E2E.mkdir(parents=True, exist_ok=True)
for filename in ("tmctl.py", "drive.py", "cdp.py", "sock.py", "win.ps1", "suite.py", "s_web_tearout.py", "s_b1_second_tearout.py"):
    destination = E2E / filename
    if not destination.exists():
        shutil.copy2(ROOT / "tmp/tearout-verification/resume3/e2e" / filename, destination)
shutil.copy2(Path(__file__).with_name("tearout_i3_launch.ps1"), E2E / "launch_tm.ps1")
sys.path.insert(0, str(E2E))
import drive
import tmctl


def js(page, body, timeout=45):
    return drive.js(page, body, timeout)


def cli(profile, *arguments):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("MYCMUX_", "CLAUDE"))}
    env.update(MYCMUX_RUNTIME_DIR=str(Path.home() / f".mycmux-{profile}"), PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")
    result = subprocess.run([sys.executable, "-X", "utf8", str(ROOT / "scripts/mycmux_agent_cli.py"), *arguments],
                            capture_output=True, text=True, encoding="utf-8", env=env, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return json.loads(result.stdout)


def setup(page, profile, clocks=2):
    js(page, r"""
const button = tm.byText('\u30db\u30fc\u30e0\u3067\u65b0\u898f\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9');
if (!button) throw new Error('welcome button missing');
button.click(); await tm.sleep(2000);
return true;
""")
    anchor = drive.panes(profile)["panes"][0]["tabs"][0]["sessionId"]
    for index in range(clocks):
        cli(profile, "spawn-tab", "--anchor-session", anchor, "--no-activate", "--label", f"clock{index}", "--",
            "powershell", "-NoLogo", "-NoExit", "-Command",
            "while ($true) { 'PID ' + $PID + ' ' + (Get-Date -Format 'HH:mm:ss.fff'); Start-Sleep -Milliseconds 250 }")
        time.sleep(2)
        anchor = next(tab["sessionId"] for pane in drive.panes(profile)["panes"] for tab in pane["tabs"] if tab.get("type") == "terminal")
    js(page, r"""
const modules = await import(document.querySelector('script[type=module][src]').src);
const values=Object.values(modules).flatMap(value=>value?.useWorkspaceListStore?Object.values(value):[value]);
window.__i3Store = values.find(value => typeof value?.getState === 'function' && Array.isArray(value.getState().workspaces));
window.__i3Command = Object.values(modules).find(value => typeof value === 'function' && value.name === 'handleSocketCommand');
window.__i3Layout = values.find(value => typeof value?.getState === 'function' && typeof value.getState().setActivePaneTab === 'function');
window.__i3Ui = values.find(value => typeof value?.getState === 'function' && typeof value.getState().setActivePaneId === 'function');
if (!window.__i3Store || !window.__i3Command) throw new Error('test access missing');
const open = [...document.querySelectorAll('button')].find(b => b.title === '\u8a2d\u5b9a' && b.offsetParent !== null);
open.click(); await tm.sleep(600);
tm.byText('\u901a\u77e5\u3068\u30ec\u30a4\u30a2\u30a6\u30c8').click(); await tm.sleep(400);
const label = [...document.querySelectorAll('label')].find(l => l.innerText.includes('\u30da\u30a4\u30f3\u306e\u5207\u308a\u96e2\u3057\u3092\u65b0\u3057\u3044\u52d5\u304d\u306b\u3059\u308b'));
const box = label.querySelector('input[type=checkbox]'); if (!box.checked) box.click();
document.querySelector('.cmux-settings-close-button').click(); await tm.sleep(2200);
const workspace = window.__i3Store.getState().workspaces.find(ws => ws.panes.some(p => p.tabs.some(t => t.type === 'terminal')));
if (!workspace) throw new Error('clock workspace missing');
window.__i3Store.getState().setActiveWorkspace(workspace.id); await tm.frame();
return true;
""")
    page_access(page, capture=True)
    return drive.panes(profile)


def page_access(page, capture=False):
    return js(page, f"""
const modules = await import(document.querySelector('script[type=module][src]').src);
const values=Object.values(modules).flatMap(value=>value?.useWorkspaceListStore?Object.values(value):[value]);
window.__i3Store ??= values.find(value => typeof value?.getState === 'function' && Array.isArray(value.getState().workspaces));
window.__i3Command ??= Object.values(modules).find(value => typeof value === 'function' && value.name === 'handleSocketCommand');
window.__i3Read ??= Object.values(modules).find(value => typeof value === 'function' && value.name === 'readPaneTail');
window.__i3Layout ??= values.find(value => typeof value?.getState === 'function' && typeof value.getState().setActivePaneTab === 'function');
window.__i3Ui ??= values.find(value => typeof value?.getState === 'function' && typeof value.getState().setActivePaneId === 'function');
if (!window.__i3Store || !window.__i3Command) throw new Error('test access missing');
if ({str(capture).lower()} && !window.__i3Capturing) {{
  const api=window.__TAURI_INTERNALS__, fetch=window.fetch.bind(window);
  window.fetch=function(input,options) {{
    if(String(input).includes('/tearout_start_move')) {{
      window.__i3Moving=JSON.parse(options.body);
      return Promise.resolve(new Response('null',{{headers:{{'Tauri-Response':'ok','Content-Type':'application/json'}}}}));
    }}
    return fetch(input,options);
  }};
  const bridge=window.chrome.webview, post=bridge.postMessage.bind(bridge);
  bridge.postMessage=function(data) {{
    const message=typeof data==='string'?JSON.parse(data):data;
    if(message.cmd==='tearout_start_move') {{window.__i3Moving=message.payload;api.runCallback(message.callback,null);return;}}
    return post(data);
  }};
  window.__i3Capturing=true;
}}
return window.__TAURI_INTERNALS__.metadata.currentWindow.label;
""")


def snapshot(page):
    return js(page, "return {workspaces:window.__i3Store.getState().workspaces, activeWorkspace:window.__i3Store.getState().activeWorkspaceId, activeSession:window.__i3Ui?.getState().activePaneId, zoom:window.__i3Ui?.getState().zoomedPaneId};")


def live_output(page, tabs):
    result = {}
    for tab in tabs:
        if tab.get("type") != "terminal":
            continue
        lines = js(page, f"return await window.__i3Read({json.dumps(tab['sessionId'])},120,true);")
        lines = [line.strip() for line in lines if line.strip()]
        matches = [re.search(r"PID (\d+) (\d\d:\d\d:\d\d\.\d+)", line) for line in lines]
        clocks = [(match.group(1), match.group(2)) for match in matches if match]
        assert clocks, (tab["id"], lines[-5:])
        result[tab["id"]] = {"session": tab["sessionId"], "pid": clocks[-1][0], "last_clock": clocks[-1][1]}
    return result


def assert_live(before, after):
    assert before.keys() == after.keys(), (before, after)
    for tab_id in before:
        assert before[tab_id]["session"] == after[tab_id]["session"], tab_id
        assert before[tab_id]["pid"] == after[tab_id]["pid"], tab_id
        assert before[tab_id]["last_clock"] != after[tab_id]["last_clock"], tab_id


def fragments(page):
    return js(page, "return await window.__TAURI_INTERNALS__.invoke('get_window_fragments');")


def hosts_for(page, tabs):
    hosted = {tab["id"]: [] for tab in tabs}
    for fragment in fragments(page):
        for workspace in fragment.get("workspaces", []):
            for pane in workspace.get("panes", []):
                for tab in pane.get("tabs", []):
                    if tab.get("tab_id") in hosted:
                        hosted[tab["tab_id"]].append((fragment["window_label"], tab.get("session_id")))
    return hosted


def fixture(page, regions):
    return js(page, f"""
const state=window.__i3Store.getState();
const source=state.workspaces.find(ws=>ws.panes.some(p=>p.tabs.some(t=>t.type==='terminal')));
const launcher=source.panes.flatMap(p=>p.tabs).find(t=>t.type==='launcher');
if(!launcher) throw new Error('receiver launcher missing');
const receiverPane={{...source.panes[0],id:crypto.randomUUID(),tabs:[launcher],activeTabId:launcher.id,sessionId:launcher.sessionId}};
const receiver=state.createWorkspace('receiver','1x1',[receiverPane],[[receiverPane.id]],{{activate:false}});
const tabs=source.panes.flatMap(p=>p.tabs).filter(t=>t.type==='terminal');
const panes=[];
for(let i=0;i<{regions};i++) {{
  const group=tabs.slice(i*2,i*2+2);
  if(group.length!==2) throw new Error('fixture requires two live panes per region');
  panes.push({{...source.panes[0],id:i===0?source.panes[0].id:crypto.randomUUID(),tabs:group,activeTabId:group[1].id,sessionId:group[1].sessionId}});
}}
const arranged={{...source,panes,splitColumns:panes.map(p=>[p.id]),columnWidths:{regions}===1?[1]:[.35,.65],
  rowHeightsPerCol:panes.map(()=>[1]),columnDividerPins:{regions}===1?[]:[true],rowDividerPinsPerCol:panes.map(()=>[])}};
state._replaceWorkspaces(window.__i3Store.getState().workspaces.map(ws=>ws.id===source.id?arranged:ws));
state.setActiveWorkspace(source.id); await tm.sleep(400);
const pill=[...document.querySelectorAll('[data-tab-id]')].find(el=>el.dataset.tabId===panes.at(-1).activeTabId&&el.offsetParent!==null);
pill.click(); await tm.sleep(1000);
return {{source:arranged,receiver:window.__i3Store.getState().getWorkspace(receiver.id)}};
""")


def detach_group(page, kind, source, tabs):
    if kind == "pane":
        return detach_pane(page, tabs[-1])
    return js(page, f"""
window.__i3Moving=null;
const kind={json.dumps(kind)};
const source={json.dumps(source)};
let el,start,end;
if(kind==='workspace') {{
  el=[...document.querySelectorAll('[data-dnd-workspace-target-id]')].find(el=>el.dataset.dndWorkspaceTargetId===source.id);
  const r=el.getBoundingClientRect(); start={{x:r.left+8,y:r.top+r.height*.5}};
  const sidebar=el.closest('[data-dnd-workspace-sidebar=true]').getBoundingClientRect();
  end={{x:sidebar.right+13,y:start.y}};
}} else {{
  const region=[...document.querySelectorAll('[data-dnd-pane-id]')].find(el=>el.dataset.dndPaneId===source.panes.at(-1).id);
  el=region.querySelector('.pane-tabbar'); const r=el.getBoundingClientRect();
  let x=r.right-120; const y=r.top+r.height*.5;
  for(;x>r.left;x-=4) {{
    const hit=document.elementFromPoint(x,y);
    if(hit&&hit.closest('.pane-tabbar')===el&&!hit.closest('button,input,textarea,select,[data-tab-id]')) {{el=hit;break;}}
  }}
  if(x<=r.left) throw new Error('region whitespace missing');
  start={{x,y}}; end={{x,y:r.bottom+13}};
}}
tm.pe('pointerdown',el,start.x,start.y); tm.pe('pointermove',window,end.x,end.y);
await tm.sleep(1400);
if(!window.__i3Moving) throw new Error(kind+' native handoff missing');
return window.__i3Moving;
""")


def destination_point(page, destination, receiver):
    return js(page, f"""
const receiver={json.dumps(receiver)}, destination={json.dumps(destination)};
window.__i3Store.getState().setActiveWorkspace(receiver.id); await tm.sleep(350);
if(destination==='sidebar') {{const r=document.querySelector('[data-dnd-workspace-sidebar=true]').getBoundingClientRect(); return {{x:r.left+8,y:r.top+10}};}}
const pane=[...document.querySelectorAll('[data-dnd-pane-id]')].find(el=>el.dataset.dndPaneId===receiver.panes[0].id);
const r=pane.getBoundingClientRect();
if(destination==='strip') {{ const pill=pane.querySelector('[data-tab-id]'); const p=pill.getBoundingClientRect(); return {{x:p.left+1,y:p.top+p.height*.5}}; }}
const points={{center:{{x:r.left+r.width*.5,y:r.top+r.height*.5}}, left:{{x:r.left+5,y:r.top+r.height*.5}},
  right:{{x:r.right-5,y:r.top+r.height*.5}},up:{{x:r.left+r.width*.5,y:r.top+42}},down:{{x:r.left+r.width*.5,y:r.bottom-5}}}};
return points[destination];
""")


def synthetic_move(host, moving, source, receiver, point, dwell_ms=450, escaped=False):
    arguments = {**moving, "sourceLabel": source, "receiver": receiver, "clientX": point["x"], "clientY": point["y"], "phase": "move", "escaped": False}
    result = js(host, f"""
const args={json.dumps(arguments)}, api=window.__TAURI_INTERNALS__;
const start=performance.now(); let last;
while(performance.now()-start<{dwell_ms}) {{last=await api.invoke('tearout_synthetic_sample',args); await tm.sleep(8);}}
return last;
""")
    arguments.update(phase="end", escaped=escaped)
    end = js(host, f"return await window.__TAURI_INTERNALS__.invoke('tearout_synthetic_sample',{json.dumps(arguments)});")
    return {"hover": result, "end": end}


def layout_state(state):
    keys = ("id", "gridTemplateId", "splitColumns", "columnWidths", "rowHeightsPerCol", "columnDividerPins", "rowDividerPinsPerCol")
    return {"activeWorkspace": state.get("activeWorkspace"), "activeSession": state.get("activeSession"), "zoom": state.get("zoom"),
            "workspaces": [{**{key: ws.get(key) for key in keys},
                            "panes": [{"id": pane["id"], "activeTabId": pane.get("activeTabId"), "sessionId": pane.get("sessionId"),
                                       "pinnedTabId": pane.get("pinnedTabId"),
                                       "tabs": [(tab["id"], tab["sessionId"]) for tab in pane["tabs"]]} for pane in ws["panes"]]}
                           for ws in state["workspaces"]]}


def placement_check(state, receiver, source, moved, destination):
    moved_ids = [tab["id"] for tab in moved]
    if destination == "sidebar":
        incoming = next(ws for ws in state["workspaces"] if any(tab["id"] in moved_ids for pane in ws["panes"] for tab in pane["tabs"]))
        assert incoming["id"] != receiver["id"], incoming
        assert [tab["id"] for pane in incoming["panes"] for tab in pane["tabs"]] == moved_ids, incoming
        if len(source["panes"]) > 1:
            for key in ("splitColumns", "columnWidths", "rowHeightsPerCol", "columnDividerPins", "rowDividerPinsPerCol"):
                assert incoming.get(key) == source.get(key), (key, incoming, source)
        return incoming
    result = next(ws for ws in state["workspaces"] if ws["id"] == receiver["id"])
    original = receiver["panes"][0]
    old_ids = [tab["id"] for tab in original["tabs"]]
    if destination in ("strip", "center"):
        target = next(pane for pane in result["panes"] if pane["id"] == original["id"])
        expected = moved_ids + old_ids if destination == "strip" else old_ids + moved_ids
        assert [tab["id"] for tab in target["tabs"]] == expected, (destination, target, expected)
    else:
        incoming = next(pane for pane in result["panes"] if any(tab["id"] in moved_ids for tab in pane["tabs"]))
        assert [tab["id"] for tab in incoming["tabs"]] == moved_ids, incoming
        new_id, old_id = incoming["id"], original["id"]
        expected = {"left": [[new_id], [old_id]], "right": [[old_id], [new_id]],
                    "up": [[new_id, old_id]], "down": [[old_id, new_id]]}[destination]
        assert result["splitColumns"] == expected, (destination, result["splitColumns"], expected)
    return result


def page_target(page):
    return page.send("Target.getTargetInfo")["targetInfo"]["targetId"]


def on_check(page, profile, port, kind, destination, regions, regrab, regrab_entry):
    setup(page, profile, clocks=regions*2)
    arranged = fixture(page, regions)
    source, receiver = arranged["source"], arranged["receiver"]
    tabs = source["panes"][-1]["tabs"] if kind == "tab" else source["panes"][0]["tabs"][-1:] if kind == "pane" else [tab for pane in source["panes"] for tab in pane["tabs"]]
    before_state = snapshot(page)
    before_output = live_output(page, tabs)
    moving = detach_group(page, kind, source, tabs)
    host = drive.page(port, moving["label"])
    try:
        page_access(host, capture=True)
        host_target = page_target(host)
        initial_child = snapshot(host)
        hosted = hosts_for(page, tabs)
        for tab in tabs:
            assert hosted[tab["id"]] == [(moving["label"], tab["sessionId"])], hosted
        source_ids = {tab["id"] for ws in snapshot(page)["workspaces"] for pane in ws["panes"] for tab in pane["tabs"]}
        assert not source_ids.intersection(tab["id"] for tab in tabs), source_ids
        assert js(host, "return !!document.querySelector('[data-native-pane-shell=true]') && !document.querySelector('[data-dnd-workspace-sidebar=true]');"), "child must have the native sidebar-less shell"
        if kind == "workspace" and regions > 1:
            for key in ("splitColumns", "columnWidths", "rowHeightsPerCol", "columnDividerPins", "rowDividerPinsPerCol"):
                assert initial_child["workspaces"][0].get(key) == source.get(key), (key, initial_child)
        if kind != "pane":
            assert [pane["activeTabId"] for pane in initial_child["workspaces"][0]["panes"]] == [pane["activeTabId"] for pane in (source["panes"][-1:] if kind == "tab" else source["panes"])], initial_child
        child_output = live_output(host, tabs)
        assert_live(before_output, child_output)
        transport_source = "main"
        transport_kind = kind
        if regrab:
            synthetic_move(host, moving, "main", None, {"x": -1, "y": -1}, dwell_ms=150)
            time.sleep(1)
            transport_source = moving["label"]
            if regrab_entry == "pill":
                original_host = host
                tabs = tabs[-1:]
                moving = detach_pane(original_host, tabs[0])
                assert moving["label"] != transport_source, moving
                host = drive.page(port, moving["label"])
                page_access(host, capture=True)
                host_target = page_target(host)
                sibling_tabs = initial_child["workspaces"][0]["panes"][0]["tabs"][:-1]
                sibling_output = live_output(original_host, sibling_tabs)
                assert_live({tab_id: child_output[tab_id] for tab_id in sibling_output}, sibling_output)
                original_host.close()
                child_output = {tab_id: value for tab_id, value in child_output.items() if tab_id in {tab["id"] for tab in tabs}}
                transport_kind = "pane"
            elif regrab_entry == "whitespace":
                moving = detach_group(host, "tab", initial_child["workspaces"][0], tabs)
                assert moving["label"] == transport_source, moving
            else:
                moving = js(host, "window.__i3Moving=null; const shell=document.querySelector('[data-native-pane-shell=true]'); const band=shell.firstElementChild; const s=tm.center(band.querySelector('span')); tm.pe('pointerdown',band,s.x,s.y); tm.pe('pointermove',window,s.x+10,s.y); await tm.sleep(400); if(!window.__i3Moving) throw new Error('band regrab handoff missing'); return window.__i3Moving;")
                assert moving["label"] == transport_source, moving
        probe = None
        if destination in ("keep", "esc"):
            probe = synthetic_move(host, moving, transport_source, None, {"x": -1, "y": -1}, dwell_ms=150, escaped=destination == "esc")
        else:
            point = destination_point(page, destination, receiver)
            if regions > 1:
                # A multi-region workspace must refuse every pane/strip target before sidebar adoption.
                denied = {}
                for rejected in ("strip", "center", "left", "right", "up", "down"):
                    reject_point = destination_point(page, rejected, receiver)
                    arguments = {**moving, "sourceLabel": transport_source, "receiver": "main", "clientX": reject_point["x"], "clientY": reject_point["y"], "phase": "move", "escaped": False}
                    result = js(host, f"const args={json.dumps(arguments)}; let last; for(let i=0;i<30;i++) {{last=await window.__TAURI_INTERNALS__.invoke('tearout_synthetic_sample',args); await tm.sleep(8);}} return last;")
                    frame_count = js(page, "return document.querySelectorAll('.pane-drop-result').length;")
                    assert result["approval"] is None and frame_count == 0, (rejected, result, frame_count)
                    denied[rejected] = {"approval": result["approval"], "frames": frame_count}
                point = destination_point(page, destination, receiver)
            else:
                denied = None
            probe = synthetic_move(host, moving, transport_source, "main", point)
            assert probe["end"]["approval"] is not None, (destination, probe)
            probe["denied_targets"] = denied
        deadline = time.monotonic()+18
        while time.monotonic() < deadline:
            hosted = hosts_for(page, tabs)
            expected_label = moving["label"] if destination == "keep" or regrab and destination == "esc" else "main"
            if all(hosted[tab["id"]] == [(expected_label, tab["sessionId"])] for tab in tabs):
                if expected_label == "main" and host_target in {target["id"] for target in drive.cdp.targets(port)}:
                    time.sleep(.2); continue
                break
            time.sleep(.2)
        else: raise AssertionError((destination, hosted))
        time.sleep(1)
        result_state = snapshot(page)
        if destination == "esc" and not regrab:
            assert layout_state(result_state) == layout_state(before_state), (before_state, result_state)
        if destination not in ("keep", "esc"):
            placement_check(result_state, receiver, source, tabs, destination)
        after_output = live_output(host if destination == "keep" or regrab and destination == "esc" else page, tabs)
        assert_live(child_output, after_output)
        log = Path.home()/f".mycmux-{profile}/tearout-log.jsonl"
        deadline = time.monotonic()+8
        rows = []
        while time.monotonic() < deadline:
            if log.exists(): rows = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]
            if len(rows) >= (2 if regrab else 1): break
            time.sleep(.1)
        assert len(rows) == (2 if regrab else 1), rows
        assert rows[-1]["grabbed_kind"] == transport_kind and rows[-1]["pane_count"] == len(tabs), rows
        expected_result = {"keep": "kept_window", "esc": "esc_cancelled"}.get(destination, "docked")
        assert rows[-1]["result"] == expected_result and not rows[-1]["errors"], rows
        assert not rows[-1]["focus_stolen"], rows[-1]
        return {"kind": kind, "destination": destination, "regions": regions, "regrab": regrab, "regrab_entry": regrab_entry,
                "before": layout_state(before_state), "child": layout_state(initial_child), "after": layout_state(result_state),
                "hosts": hosted, "output_before": before_output, "output_child": child_output, "output_after": after_output,
                "synthetic": probe, "log_rows": rows}
    finally:
        host.close()


def metric_install(page):
    return js(page, r"""
const api = window.__TAURI_INTERNALS__;
window.__i3Metric = { samples: [], eventSamples: [], indices: new Map(), latest: -1, raf: [], rafWork: [], long: [], alpha: [], mutations: [], receives: 0, inNative: false };
const m = window.__i3Metric;
const callbacks=api.callbacks, get=callbacks.get.bind(callbacks);
callbacks.get = function(id) {
  const callback=get(id); if(!callback) return callback;
  return function(data) {
  if (data?.event !== 'mycmux://tearout-native' || !m.active) return callback(data);
  const begin = performance.now();
  const key=data.payload.id+':'+data.payload.sequence;
  if(!m.indices.has(key)) {m.indices.set(key,m.samples.length); m.samples.push(0); m.eventSamples.push(0);}
  const index=m.indices.get(key); m.latest=index;
  m.inNative = true;
  try { return callback(data); }
  finally { m.inNative = false; const work=performance.now()-begin; m.samples[index]+=work; m.eventSamples[index]+=work; m.receives++; }
  };
};
const fetch=window.fetch.bind(window);
window.fetch=function(input,options) {
  if(m.active && String(input).includes('/tearout_alpha')) m.alpha.push({at:performance.now(),alpha:JSON.parse(options.body).alpha});
  return fetch(input,options);
};
const raf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = callback => {
  const native = m.inNative;
  return raf(at => {
  const begin = performance.now();
  const previousNative = m.inNative; m.inNative = native;
  const sampleIndex = m.latest;
  try { callback(at); }
  finally {
    m.inNative = previousNative;
    if (m.active) { const work=performance.now()-begin; m.rafWork.push(work); if(native && sampleIndex>=0) m.samples[sampleIndex]+=work; }
  }
  });
};
let previous = 0;
const tick = at => {
  if (m.active && previous) m.raf.push(at - previous);
  previous = at;
  if (!m.stopped) raf(tick);
};
raf(tick);
m.longObserver = new PerformanceObserver(list => { if (m.active) m.long.push(...list.getEntries().map(e => e.duration)); });
m.longObserver.observe({ type: 'longtask', buffered: false });
m.mutationObserver = new MutationObserver(entries => {
  if (!m.active) return;
  for (const entry of entries) {
    if (entry.type === 'childList') {
      for (const [kind, nodes] of [['added', entry.addedNodes], ['removed', entry.removedNodes]])
        for (const node of nodes) if (node.nodeType === 1 && (node.matches('.pane-drop-result') || node.querySelector('.pane-drop-result')))
          m.mutations.push({ kind, at: performance.now() });
    } else if (entry.target.matches('.pane-drop-result')) m.mutations.push({kind: 'changed', at: performance.now()});
  }
});
m.mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
m.active = true;
return { callbacks: typeof api.runCallback, label: api.metadata.currentWindow.label };
""")


def metric_take(page):
    return js(page, r"""
const m = window.__i3Metric; m.active = false; m.stopped = true;
m.longObserver.disconnect(); m.mutationObserver.disconnect();
const stats = values => {
  const sorted = values.slice().sort((a,b) => a-b);
  const quantile = p => sorted.length ? sorted[Math.min(sorted.length-1, Math.ceil(sorted.length*p)-1)] : null;
  return { count: sorted.length, median: quantile(.5), p95: quantile(.95), max: quantile(1) };
};
return { sample_ms: stats(m.samples), event_callback_ms: stats(m.eventSamples), raf_ms: stats(m.raf), raf_work_ms: stats(m.rafWork), long_tasks_over_50ms: m.long.filter(n => n>50).length,
  alpha_requests: m.alpha, frame_added: m.mutations.filter(e => e.kind==='added').length,
  frame_removed: m.mutations.filter(e => e.kind==='removed').length,
  frame_changed: m.mutations.filter(e => e.kind==='changed').length, callback_count: m.receives, received_samples: m.samples.length };
""")


def detach_pane(page, tab):
    return js(page, f"""
const el = [...document.querySelectorAll('[data-tab-id]')].find(e => e.dataset.tabId === {json.dumps(tab['id'])} && e.offsetParent !== null);
if (!el) throw new Error('pane pill missing');
const s = tm.center(el); tm.pe('pointerdown', el, s.x, s.y);
tm.pe('pointermove', window, s.x, s.y + 100);
await tm.sleep(1200);
if (!window.__i3Moving) throw new Error('native handoff missing');
return window.__i3Moving;
""")


def probe(page, profile, port):
    layout = setup(page, profile)
    tab = [tab for pane in layout["panes"] for tab in pane["tabs"] if tab.get("type") == "terminal"][-1]
    moving = detach_pane(page, tab)
    host = drive.page(port, moving["label"])
    try:
        metric_install(page)
        metric_install(host)
        point = js(page, "const pane = document.querySelector('[data-dnd-pane-id]'); const r=pane.getBoundingClientRect(); return {x:r.left+r.width*.5,y:r.top+r.height*.5};")
        args = {**moving, "sourceLabel": "main", "receiver": "main", "clientX": point["x"], "clientY": point["y"], "phase": "move", "escaped": False}
        samples = js(host, f"""
const args = {json.dumps(args)}; const api = window.__TAURI_INTERNALS__;
const start = performance.now(); const times = []; const pending = [];
await new Promise(resolve => {{
  const timer = window.setInterval(() => {{
    if (performance.now() - start >= 3000) {{ window.clearInterval(timer); resolve(); return; }}
    times.push(performance.now()); pending.push(api.invoke('tearout_synthetic_sample', args));
  }}, 1000/120);
}});
const values = await Promise.all(pending);
return {{times, values}};
""", timeout=30)
        time.sleep(.1)
        receiver_metrics = metric_take(page)
        moving_metrics = metric_take(host)
        # Leave the target, applying opacity 255 while retaining the child window.
        args.update(receiver=None, clientX=-1, clientY=-1)
        js(host, f"await window.__TAURI_INTERNALS__.invoke('tearout_synthetic_sample', {json.dumps(args)}); await tm.sleep(100); return true;")
        args["phase"] = "end"
        final = js(host, f"return await window.__TAURI_INTERNALS__.invoke('tearout_synthetic_sample', {json.dumps(args)});")
        time.sleep(.5)
        interval = [b-a for a,b in zip(samples["times"], samples["times"][1:])]
        values = samples["values"]
        return {"duration_ms": 3000, "sent": len(values), "interval_ms": interval,
                "payload_bytes": sorted(set(v["payload_bytes"] for v in values)),
                "recipients": sorted(set(v["recipients"] for v in values)),
                "receiver": receiver_metrics, "moving": moving_metrics,
                "frame_reattach": max(0, receiver_metrics["frame_added"]-1),
                "native_alpha_calls_including_exit": final["alpha_calls"], "final": final}
    finally:
        host.close()


def switch_off(page):
    """The new tear-out is on by default since 0.81.0; OFF checks turn it off first.

    The welcome screen may not show the settings button, so the settings store is
    used first and the settings dialog only as a fallback."""
    return js(page, r"""
const modules = await import(document.querySelector('script[type=module][src]').src);
const values = Object.values(modules).flatMap(value => value?.useWorkspaceListStore ? Object.values(value) : [value]);
const settings = values.find(value => typeof value?.getState === 'function'
  && typeof value.getState().setNativePaneTearoutEnabled === 'function');
if (settings) {
  settings.getState().setNativePaneTearoutEnabled(false); await tm.sleep(300);
  if (settings.getState().nativePaneTearoutEnabled !== false) throw new Error('switch did not turn off');
  return 'store';
}
const open = [...document.querySelectorAll('button')].find(b => b.title === '設定' && b.offsetParent !== null);
if (!open) throw new Error('neither the settings store nor the settings button is reachable');
open.click(); await tm.sleep(600);
tm.byText('通知とレイアウト').click(); await tm.sleep(400);
const label = [...document.querySelectorAll('label')].find(l => l.innerText.includes('ペインの切り離しを新しい動きにする'));
const box = label.querySelector('input[type=checkbox]'); if (box.checked) box.click(); await tm.sleep(300);
const off = !box.checked;
document.querySelector('.cmux-settings-close-button').click(); await tm.sleep(800);
if (!off) throw new Error('switch did not turn off');
return off;
""")


def off_check(page, profile, port, mode, tag):
    switch_off(page)
    scripts = {"off-b1": ("s_b1_second_tearout.py", [str(port), profile, tag], "3/3 passed"),
               "off-web": ("s_web_tearout.py", [str(port), profile], "3/3 passed"),
               "off-suite": ("suite.py", [str(port), profile, "--arm"], "8/8 passed")}
    if mode == "off-suite":
        js(page, r"const b=tm.byText('\u30db\u30fc\u30e0\u3067\u65b0\u898f\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9'); if(!b) throw new Error('welcome button missing'); b.click(); await tm.sleep(3000); return true;")
    script, arguments, expected = scripts[mode]
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"}
    log = OUT / f"{tag}-legacy.log"
    with log.open("w", encoding="utf-8") as output:
        result = subprocess.run([sys.executable, str(E2E/script), *arguments], cwd=E2E, env=env,
                                stdout=output, stderr=subprocess.STDOUT, timeout=900)
    contents = log.read_text(encoding="utf-8")
    print(contents, flush=True)
    tally = [line for line in contents.splitlines() if line.endswith("passed")]
    failures = [line for line in contents.splitlines() if line.startswith("FAIL")]
    record = {"exit_code": result.returncode, "tally": tally[-1] if tally else None, "failures": failures, "log": str(log)}
    assert result.returncode == 0 and not failures and record["tally"] == expected, record
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("probe", "on", "off-b1", "off-suite", "off-web"))
    parser.add_argument("exe", type=Path)
    parser.add_argument("profile")
    parser.add_argument("port", type=int)
    parser.add_argument("tag")
    parser.add_argument("--kind", choices=("pane", "tab", "workspace"), default="pane")
    parser.add_argument("--destination", choices=("keep", "esc", "strip", "center", "left", "right", "up", "down", "sidebar"), default="keep")
    parser.add_argument("--regions", type=int, choices=(1, 2), default=1)
    parser.add_argument("--regrab", action="store_true")
    parser.add_argument("--regrab-entry", choices=("band", "whitespace", "pill"), default="band")
    args = parser.parse_args()
    assert re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.profile), args.profile
    for path in (Path.home()/f".mycmux-{args.profile}", Path(os.environ["APPDATA"])/"com.miyazaki.mycmux/profiles"/args.profile,
                 Path(os.environ["LOCALAPPDATA"])/"com.miyazaki.mycmux"/f"EBWebView-{args.profile}"):
        if path.exists(): raise RuntimeError(f"profile already exists: {path}")
    exe = args.exe.resolve()
    assert exe.is_file() and ROOT in exe.parents, exe
    pid = None
    page = None
    try:
        pid = tmctl.launch(exe, args.profile, args.port)
        page = drive.page(args.port)
        actual_profile = js(page, "return await window.__TAURI_INTERNALS__.invoke('get_test_profile');")
        assert actual_profile == args.profile, (actual_profile, args.profile)
        if args.mode == "probe": result = probe(page, args.profile, args.port)
        elif args.mode == "on": result = on_check(page, args.profile, args.port, args.kind, args.destination, args.regions, args.regrab, args.regrab_entry)
        else: result = off_check(page, args.profile, args.port, args.mode, args.tag)
        record = {"utc": datetime.now(timezone.utc).isoformat(), "exe": str(exe), "exe_sha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
                  "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                  "profile": args.profile, "mode": args.mode, "result": result}
        (OUT/f"{args.tag}.json").write_text(json.dumps(record, indent=2)+"\n", encoding="utf-8")
        print(json.dumps(record), flush=True)
    finally:
        if page: page.close()
        pid = pid or tmctl.find_pid(exe, args.profile)
        if pid: tmctl.stop(exe, args.profile, pid)


if __name__ == "__main__":
    main()
