"""Mac perf3 measurement driver. Stdlib only; never addresses the live socket.

Run on the Mac: python3 scripts/e2e/measure_mac.py --out <results directory>
Results are append-only by phase/run; a failed phase remains explicit.
"""
from __future__ import annotations
import argparse
import base64
from contextlib import redirect_stdout
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import traceback
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "perf"))
from mycmux_e2e import App, E2eError
from scenarios import fresh_start, stop as scenario_stop, new_workspace, SCENARIOS
from mac_observe import processes, sample, run
from mac_load import LoadRecorder

ROOT = Path.home() / "Developer/macq-e2e/perf3"
REPO = Path(__file__).resolve().parents[2]
J = json.dumps


def stop(app):
    try:
        scenario_stop(app)
    except (OSError, E2eError):
        # App.pids() is restricted to this exact bundle and profile.
        app.kill()
        app.wait_exit(10)


class PerfApp(App):
    def launch(self, *, background=True, wait_seconds=45):
        if not background or self.profile != "perf3":
            raise E2eError("only the background perf3 profile is allowed")
        if self.pids():
            raise E2eError("test profile already running")
        if os.getpriority(os.PRIO_PROCESS, 0) != 0:
            raise E2eError("measurement app must inherit default priority, not a niced background shell")
        # Preserve old socket files; readiness checks use process identity too.
        self.open_epoch_ms = time.time() * 1000
        load_interval = self.load_recorder.begin()
        started = time.monotonic()
        self.launch_method = "direct-accessory"
        env = dict(os.environ, MYCMUX_PROFILE_ACTIVATION="accessory")
        log_path = getattr(self, "launch_log", ROOT / "results" / "launch.log")
        with log_path.open("a") as log:
            subprocess.Popen([str(self.binary), "--profile", self.profile], env=env,
                             stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        self.wait_until(lambda: self.pids() and self._socket_ready(), wait_seconds, "new test socket")
        self.wait_until(lambda: self.eval("return !!window.__mycmuxE2E"), wait_seconds, "e2e hooks")
        if not any(w.get("visible") for w in self.windows()):
            self.window_action("main", "show")
            time.sleep(1)
        if not any(w.get("visible") for w in self.windows()):
            self.terminate()
            self.wait_exit(15)
            self.launch_method = "open-g"
            subprocess.run(["open", "-n", "-g", "-a", str(self.bundle), "--args", "--profile", self.profile], check=True)
            self.wait_until(lambda: self.pids() and self._socket_ready(), wait_seconds, "fallback test socket")
            self.wait_until(lambda: self.eval("return !!window.__mycmuxE2E"), wait_seconds, "fallback e2e hooks")
        # Owner authorized launch activation in spec_measure_mac2. Record it.
        event = {"epoch": time.time(), "method": self.launch_method, "pids": self.pids(), "windows": self.windows()}
        event.update(self.load_recorder.finish(load_interval))
        event["priority"] = run(["ps", "-p", ",".join(str(pid) for pid in self.pids()), "-o", "pid,ppid,ni,comm"])
        if hasattr(self, "record_launch"):
            self.record_launch(event)
        return time.monotonic() - started


def stats(values):
    values = sorted(x for x in values if isinstance(x, (float, int)))
    if not values:
        return {"n": 0, "median": None, "p90": None, "p99": None, "max": None}
    def quantile(p):
        rank = (len(values) - 1) * p
        lo = int(rank)
        hi = min(lo + 1, len(values) - 1)
        return values[lo] + (values[hi] - values[lo]) * (rank - lo)
    return {"n": len(values), "median": quantile(.5), "p90": quantile(.9), "p99": quantile(.99), "max": values[-1]}


def fixtures(directory):
    directory.mkdir(parents=True, exist_ok=True)
    head = '<!doctype html><meta charset="utf-8"><title>mycmux perf fixture</title><main id="chart"></main>'
    script = '<script>const root=document.getElementById("chart");for(let i=0;i<600;i++){let p=document.createElement("span");p.textContent="chart "+i+" ";p.style.color=`hsl(${i%360} 60% 45%)`;root.append(p)}</script>'
    result = {}
    for size, n in (("small", 50000), ("medium", 1000000), ("heavy", 10000000)):
        if size == "heavy":
            svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><!--' + '.' * 8000000 + '--><rect width="1200" height="800" fill="blue"/></svg>'
            html = head + script + '<img alt="load" src="data:image/svg+xml;base64,' + base64.b64encode(svg.encode()).decode() + '">'
        else:
            html = head + script + '<!--' + '.' * n + '-->'
        md = '# mycmux perf fixture\n\n' + ('dummy line for the Markdown preview.\n' * (n // 36 + 1))
        for kind, content in (("html", html), ("md", md)):
            path = directory / f"{size}.{kind}"
            if not path.exists():
                path.write_text(content, encoding="utf-8")
            data = path.read_bytes()
            result[f"{kind}_{size}"] = {"path": str(path), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    flow = directory / "flow-10mb.txt"
    if not flow.exists():
        flow.write_bytes((b"0123456789abcdefghijklmnopqrstuvwxyz-OUTPUT\n" * 250000)[:10000000])
    return result


class Measure:
    def __init__(self, out):
        self.out = out
        out.mkdir(parents=True, exist_ok=False)
        self.app = PerfApp("perf3", ROOT / "mycmux-e2e.app")
        self.load = LoadRecorder()
        self.app.load_recorder = self.load
        self.report = {"head": run(["git", "-C", str(REPO), "rev-parse", "HEAD"])["stdout"].strip(),
                       "started": time.time(), "measurements": {}, "errors": [], "assumptions": [], "complete": False}
        self.fixture = fixtures(out / "fixtures")
        self.report["fixtures"] = self.fixture
        self.report["live_initial"] = run(["pgrep", "-fl", "/Applications/mycmux.app/Contents/MacOS/mycmux"])
        self.app.launch_log = out / "launch.log"
        self.app.record_launch = self.record_launch
        self.report["definitions"] = {"cold": "first 3 process launches; OS file cache is not purged",
                                      "previewCold": "destroy previous preview before opening",
                                      "previewWarm": "reopen after appending a newline; same warm process as Windows runH1"}
        self.save()

    def record_launch(self, event):
        self.report.setdefault("launches", []).append(event)
        self.save()

    def save(self):
        temporary = self.out / "results.json.tmp"
        temporary.write_text(J(self.report, indent=2) + "\n", encoding="utf-8")
        temporary.replace(self.out / "results.json")

    def add(self, name, **row):
        if "_load_interval" in row:
            row.update(self.load.finish(row.pop("_load_interval")))
        if "loadMean" not in row:
            raise E2eError("measurement has no load interval: " + name)
        row.update(epoch=time.time(), load=os.getloadavg())
        row["launchMethod"] = getattr(self.app, "launch_method", None)
        try:
            row["windows"] = self.app.windows()
        except Exception as exc:
            row["windows_error"] = str(exc)
        item = self.report["measurements"].setdefault(name, {"samples": [], "stats": {}})
        item["samples"].append(row)
        for key in set().union(*(r.keys() for r in item["samples"])):
            if any(isinstance(r.get(key), (int, float)) and not isinstance(r.get(key), bool) for r in item["samples"]):
                item["stats"][key] = stats([r.get(key) for r in item["samples"]])
        self.save()
        print(J({"event": "measurement", "name": name, "n": len(item["samples"]), "load": row["load"]}), flush=True)

    def eval(self, script, label="main", timeout_ms=10000):
        return self.app.eval(script, label, timeout_ms)

    def marks(self, label="main"):
        return self.eval("return {front:window.__MYCMUX_PERF__.read(),rust:await window.__TAURI_INTERNALS__.invoke('perf_timeline_read')};", label)

    def ptys(self):
        # pane.list_all returns a layout object (five top-level fields), not
        # a list of live PTYs. Enumerate SessionManager directly: monitor
        # metadata refreshes only every ten seconds and biases startup timing.
        return self.eval("return Object.entries(await window.__TAURI_INTERNALS__.invoke('get_session_output_snapshot')).map(([session_id,last_output_at])=>({session_id,last_output_at}));")

    def frame(self, action="", label="main", timeout=2000):
        interval = self.load.begin()
        result = self.eval("""
          const started=performance.now(); const e=window.__mycmuxE2E;
          const before=document.visibilityState;
          %s
          let frames=0;
          const outcome=await Promise.race([
            new Promise(resolve=>requestAnimationFrame(()=>{frames++;requestAnimationFrame(()=>{frames++;resolve('frame')})})),
            e.macProbe.delay(%d).then(()=>'raf-stopped')]);
          return {outcome,frames,ms:performance.now()-started,visibilityBefore:before,visibilityAfter:document.visibilityState};
        """ % (action, timeout), label, timeout + 1500)
        result.update(self.load.finish(interval))
        return result

    def layout(self, count=24):
        fresh_start(self.app)
        for i in range(4 if count == 24 else 1):
            new_workspace(self.app, f"PERF3-{i}", "1x1", plain_shell_panes=2 if count == 24 else 1,
                          tabs_per_pane=3 if count == 24 else 1)
        self.app.wait_until(lambda: len(self.ptys()) == count, 40, f"{count} PTYs")
        self.ws = self.app.workspaces()
        self.tabs = [(w["id"], p["id"], t) for w in self.ws for p in w["panes"] for t in p["tabs"] if t["type"] == "terminal"]
        if len(self.tabs) != count or sum(len(w["panes"]) for w in self.ws) != (8 if count == 24 else 1):
            raise E2eError("fixture structure does not match spec")
        self.select(self.tabs[0])
        self.app.window_action("main", "show")
        time.sleep(3)
        return self.ws

    def select(self, target):
        wid, pid, tab = target
        return self.frame("e.stores.workspaceList.getState().setActiveWorkspace(%s);e.stores.layout.getState().setActivePaneTab(%s,%s,%s);e.stores.ui.getState().setActivePaneId(%s);" % (J(wid), J(wid), J(pid), J(tab["id"]), J(tab["sessionId"])))

    def input_keys(self, session, count, label="main"):
        self.app.wait_until(lambda:self.eval("return !!window.__mycmuxE2E.terminals.live.get(%s)?.textarea;"%J(session),label),15,"mounted xterm textarea")
        rows=[]
        for offset in range(0, count, 10):
            interval=self.load.begin()
            windows_before=self.app.windows()
            batch=self.eval("""
              const e=window.__mycmuxE2E, term=e.terminals.live.get(%s);
              if(!term?.textarea) throw new Error('active xterm missing');
              const rows=[];term.textarea.focus();
              for(let i=0;i<%d;i++){
                const atMs=performance.timeOrigin+performance.now();
                let done=false;let sub;
                const painted=new Promise(resolve=>{sub=term.onRender(()=>{done=true;resolve(performance.timeOrigin+performance.now())})});
                const erase=(i+%d)%%2===1;
                const options={key:erase?'Backspace':'z',code:erase?'Backspace':'KeyZ',keyCode:erase?8:90,which:erase?8:90,bubbles:true,cancelable:true};
                term.textarea.dispatchEvent(new KeyboardEvent('keydown',options));
                term.textarea.dispatchEvent(new KeyboardEvent('keyup',options));
                const end=await Promise.race([painted,e.macProbe.delay(1500).then(()=>null)]);sub.dispose();
                rows.push({atMs,ms:end===null?null:end-atMs,rendered:done,visibility:document.visibilityState});
                await e.macProbe.delay(20);
              }
              return rows;
            """ % (J(session), min(10,count-offset), offset),label,20000)
            windows_after=self.app.windows()
            load_fields=self.load.finish(interval)
            for row in batch:
                row.update(windowsBefore=windows_before,windowsAfter=windows_after,
                           launchMethod=self.app.launch_method,loadScope="key-batch",**load_fields)
            rows.extend(batch)
        return rows

    def fake(self):
        fake = REPO / "scripts/perf/fake-agent.sh"
        launched=[]
        for _,_,tab in self.tabs[1:7]:
            identity=str(uuid.uuid4())
            self.app.call("pane.send_text", {"sessionId": tab["sessionId"], "text": f"/bin/zsh -f {shlex.quote(str(fake))} {identity}\n"})
            launched.append({"sessionId":tab["sessionId"],"fakeId":identity})
        time.sleep(3)
        metadata=self.eval("return window.__mycmuxE2E.stores.paneMetadata.getState().metadata")
        mappings=self.eval("return await window.__TAURI_INTERNALS__.invoke('read_agent_session_mappings',{sessionIds:%s})"%J([r["sessionId"] for r in launched]))
        files=[]
        for row in launched:
            path=self.app.runtime_dir/"fake-projects"/"perf3"/(row["fakeId"]+".jsonl")
            files.append({"path":str(path),"exists":path.exists(),"bytes":path.stat().st_size if path.exists() else 0})
        self.report.setdefault("fake_agents",[]).append({"epoch":time.time(),"launched":launched,"metadata":metadata,"mappings":mappings,"files":files,
                                                        "isolatedRootRoutedToLivebrief":False})
        self.save()

    def input_burst(self, session, count):
        interval=self.load.begin()
        windows_before=self.app.windows()
        rows=self.eval("""
          const e=window.__mycmuxE2E, term=e.terminals.live.get(%s);
          if(!term?.textarea) throw new Error('active xterm missing');
          term.textarea.focus(); const pending=[];
          for(let i=0;i<%d;i++){
            const row={atMs:performance.timeOrigin+performance.now(),rendered:false,ms:null,visibility:document.visibilityState};
            let sub;
            const rendered=new Promise(resolve=>{sub=term.onRender(()=>{
              row.rendered=true;row.ms=performance.timeOrigin+performance.now()-row.atMs;resolve(row)
            })});
            const erase=i%%2===1;
            const options={key:erase?'Backspace':'z',code:erase?'Backspace':'KeyZ',keyCode:erase?8:90,which:erase?8:90,bubbles:true,cancelable:true};
            term.textarea.dispatchEvent(new KeyboardEvent('keydown',options));
            term.textarea.dispatchEvent(new KeyboardEvent('keyup',options));
            pending.push(Promise.race([rendered,e.macProbe.delay(1500).then(()=>row)]).finally(()=>sub.dispose()));
          }
          return await Promise.all(pending);
        """%(J(session),count),timeout_ms=5000)
        fields=self.load.finish(interval)
        windows_after=self.app.windows()
        for row in rows:
            row.update(**fields,windowsBefore=windows_before,windowsAfter=windows_after,loadScope="key-burst",
                       launchMethod=self.app.launch_method)
        return rows

    def S1(self):
        for count in (1,24):
            self.layout(count)
            time.sleep(2)
            saved_ids=sorted(t[2]["sessionId"] for t in self.tabs)
            stop(self.app)
            for index in range(13):
                interval=self.load.begin()
                self.app.launch()
                opened=self.app.open_epoch_ms
                self.app.wait_until(lambda: (self.app.window("main") or {}).get("visible"),30,"visible window")
                visible_observed=time.time()*1000-opened
                restoration_error=None
                try:
                    self.app.wait_until(lambda: len(self.ptys())==count,40,"restored PTYs")
                    restored=time.time()*1000-opened
                except E2eError as exc:
                    # A lazy restore or a product timeout is an observed result,
                    # not permission to activate extra panes or drop the run.
                    restored=None
                    restoration_error=str(exc)
                actual_ptys=self.ptys()
                frame=self.frame()
                keys=self.input_keys(self.tabs[0][2]["sessionId"],2)
                marks=self.marks()
                front=marks["front"]
                def delta(name):
                    found=next((m for m in front if m["name"]==name),None)
                    return found["atMs"]-opened if found else None
                ids=sorted(t["sessionId"] for w in self.app.workspaces() for p in w["panes"] for t in p["tabs"] if t["type"]=="terminal")
                self.add(f"S1_L{count}_{'cold' if index<3 else 'warm'}", visibleObservedMs=visible_observed,
                         visibleMarkMs=delta("window.visible"), firstFrameMs=delta("workspace.first.frame"),
                         restoredObservedMs=restored, restoreTimeoutMs=40000 if restoration_error else None,
                         restorationError=restoration_error,restoredPtyCount=len(actual_ptys),ptys=actual_ptys,
                         frame=frame, input=keys, marks=marks, idsMatch=ids==saved_ids,_load_interval=interval)
                stop(self.app)

    def S2(self):
        for stage in ("L0","L24","L24S","L24S+H"):
            self.layout(1 if stage=="L0" else 24)
            if "S" in stage: self.fake()
            if "+H" in stage:
                self.preview(self.fixture["html_small"]["path"])
                self.web_blank()
            self.report.setdefault("appearance",{})[stage]=self.eval("""
              const elements=[...document.querySelectorAll('*')];
              const blurred=elements.filter(n=>{const s=getComputedStyle(n);return s.backdropFilter&&s.backdropFilter!=='none'});
              return {canvasCount:document.querySelectorAll('canvas').length,
                mountedTerminals:window.__mycmuxE2E.terminals.live.size,cachedTerminals:window.__mycmuxE2E.terminals.cached.size,
                blurred:blurred.map(n=>({tag:n.tagName,className:String(n.className),filter:getComputedStyle(n).backdropFilter})),
                images:document.querySelectorAll('img').length,videos:document.querySelectorAll('video').length};
            """)
            self.app.snapshot(self.out / f"snapshot-{stage}.png")
            pid=self.app.pids()[0]
            group=processes(pid)
            for p in group:
                if p["kind"] in ("mycmux","WebContent"):
                    interval=self.load.begin()
                    profile=sample(p["pid"],self.out/f"sample-{stage}-{p['pid']}.txt")
                    self.report.setdefault("profiles",[]).append({"stage":stage,**profile,**self.load.finish(interval),
                        "windows":self.app.windows(),"launchMethod":self.app.launch_method})
            for index in range(5):
                interval=self.load.begin()
                before=processes(pid)
                windows_before=self.app.windows()
                self.eval("return window.__mycmuxE2E.macProbe.start()")
                start=time.monotonic()
                load_samples=[{"epoch":time.time(),"load":os.getloadavg()}]
                for tick in range(1,7):
                    time.sleep(max(0,start+tick*10-time.monotonic()))
                    load_samples.append({"epoch":time.time(),"load":os.getloadavg()})
                probe=self.eval("return window.__mycmuxE2E.macProbe.read(true)")
                after=processes(pid)
                cpu={}
                for kind in ("mycmux","WebContent","GPU","Networking"):
                    old={r["pid"]:r for r in before if r["kind"]==kind}
                    new=[r for r in after if r["kind"]==kind]
                    cpu[kind]={"cpuDeltaMs":sum((r["cpu_seconds"]-old[r["pid"]]["cpu_seconds"])*1000 for r in new if r["pid"] in old),
                               "rssMiB":sum(r["rss_kib"] for r in new)/1024,"pids":[r["pid"] for r in new]}
                self.add(f"S2_{stage}", elapsedS=time.monotonic()-start, before=before, after=after, cpu=cpu, probe=probe, windowsBefore=windows_before,loadSamples=load_samples,
                         rafHz=probe["framesPerSecond"], maxRafGapMs=probe["maxGapMs"], longtaskSupported=probe["longtaskSupported"],_load_interval=interval,
                         **{f"{k}CpuMs":v["cpuDeltaMs"] for k,v in cpu.items()}, **{f"{k}RssMiB":v["rssMiB"] for k,v in cpu.items()})
            stop(self.app)

    def S3(self):
        for stage in ("L24","L24S"):
            self.layout()
            if stage.endswith("S"):self.fake()
            self.eval("return window.__mycmuxE2E.macProbe.start()")
            keys=self.input_keys(self.tabs[0][2]["sessionId"],200)
            probe=self.eval("return window.__mycmuxE2E.macProbe.read(true)")
            for row in keys:self.add(f"S3_{stage}",**row)
            self.report.setdefault("input_correlation",{})[stage]={"summary":stats([r["ms"] for r in keys]),"probe":probe,"marks":self.marks()}
            self.save()
            stop(self.app)

    def S4(self):
        self.layout()
        for kind in ("pane","tab_focus","workspace"):
            for i in range(20):
                target=self.tabs[i%3] if kind=="pane" else self.tabs[(i%2)*3] if kind=="tab_focus" else self.tabs[(i%4)*6]
                before=self.app.windows()
                result=self.select(target)
                self.add(f"S4_{kind}",**result,windowsBefore=before)
        stop(self.app)

    def preview(self, path):
        wid,pid,tab=self.tabs[0]
        started=time.time()*1000
        info=self.eval("const e=window.__mycmuxE2E;window.__MYCMUX_PERF__.mark('artifact.link.click');const info=await e.previewArtifactUriForSessionV2(%s,%s);e.stores.layout.getState().openOrReloadHtmlPreviewPane(%s,%s,info);return info;"%(J(tab["sessionId"]),J(path),J(wid),J(pid)),timeout_ms=20000)
        self.app.wait_until(lambda:any(t["type"]=="browser" for w in self.app.workspaces() for p in w["panes"] for t in p["tabs"]),20,"preview pane")
        return {"startedMs":started,"info":info}

    def web_blank(self):
        # A loopback page is the socket API's allowed about:blank equivalent.
        import http.server, threading
        if not hasattr(self,"server"):
            class Handler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    self.send_response(200);self.send_header("Content-Type","text/html");self.end_headers();self.wfile.write(b"<!doctype html><title>perf3 blank</title>")
                def log_message(self,*args):pass
            self.server=http.server.HTTPServer(("127.0.0.1",0),Handler)
            threading.Thread(target=self.server.serve_forever,daemon=True).start()
        return self.app.call("web.open",{"presetId":"browser","url":f"http://127.0.0.1:{self.server.server_port}/","anchorSessionId":self.tabs[3][2]["sessionId"],"background":False})

    def S5(self):
        from concurrent.futures import ThreadPoolExecutor
        self.layout()
        output=self.tabs[3][2]["sessionId"]
        self.select(self.tabs[3]);self.select(self.tabs[0])
        for kind in ("seq","cat10mb"):
            for index in range(10):
                interval=self.load.begin()
                marker=f"PERF3_END_{kind}_{index}_{uuid.uuid4().hex[:6]}"
                command="seq 1 200000" if kind=="seq" else "cat "+shlex.quote(str(self.out/"fixtures/flow-10mb.txt"))
                self.eval("return window.__mycmuxE2E.macProbe.start()")
                started=time.monotonic()
                command_epoch=time.time()*1000
                self.app.call("pane.send_text",{"sessionId":output,"text":f"{command}; printf '\\n{marker}\\n'\n"})
                with ThreadPoolExecutor(max_workers=1) as executor:
                    keys=executor.submit(self.input_burst,self.tabs[0][2]["sessionId"],50)
                    self.app.wait_until(lambda:marker in [str(v).strip() for v in self.app.call("pane.read",{"sessionId":output,"lines":40})["lines"]],120,"terminal output sentinel")
                    sentinel_observed=(time.monotonic()-started)*1000
                    sentinel_epoch=time.time()*1000
                    inputs=keys.result()
                def quiet():
                    snapshot=self.eval("return (await window.__TAURI_INTERNALS__.invoke('get_session_output_snapshot'))[%s];"%J(output))
                    return snapshot if snapshot and time.time()*1000-snapshot>=500 else None
                last_output=self.app.wait_until(quiet,30,"500ms output quiescence")
                settled=(time.monotonic()-started)*1000
                probe=self.eval("return window.__mycmuxE2E.macProbe.read(true)")
                self.add(f"S5_{kind}",settledMs=settled,maxRafGapMs=probe["maxGapMs"],droppedFrames=probe["dropped"],
                         inputStats=stats([r["ms"] for r in inputs]),inputs=inputs,probe=probe,
                         keysStartedBeforeSentinel=sum(r["atMs"]<=sentinel_epoch for r in inputs),sentinelEpochMs=sentinel_epoch,
                         keysStartedDuringOutput=sum(command_epoch<=r["atMs"]<=last_output for r in inputs),lastOutputEpochMs=last_output,
                         commandEpochMs=command_epoch,sentinelObservedMs=sentinel_observed,inputMode="50-key burst",quietWindowMs=500,_load_interval=interval)
        stop(self.app)

    def detach_round(self,name):
        self.ws=self.app.workspaces()
        before_ids=sorted(t["sessionId"] for w in self.ws for p in w["panes"] for t in p["tabs"] if t["type"]=="terminal")
        target=next((w,p,t) for w in self.ws for p in w["panes"] for t in p["tabs"] if t["type"]=="terminal")
        w,p,t=target
        self.select((w["id"],p["id"],t))
        prior={v["label"] for v in self.app.windows()}
        interval=self.load.begin()
        started=time.time()*1000
        self.eval("window.__mycmuxE2E.detachTab(%s,%s,%s,740,320);return true;"%(J(w["id"]),J(p["id"]),J(t["id"])))
        child=self.app.wait_until(lambda:next((v for v in self.app.windows() if v["label"] not in prior),None),15,"child window")
        created_observed=time.time()*1000-started
        label=child["label"]
        self.app.wait_until(lambda:(self.app.window(label) or {}).get("visible"),20,"child visible")
        visible_observed=time.time()*1000-started
        self.app.wait_until(lambda:self.eval("return !!window.__mycmuxE2E?.macProbe;",label),15,"child measurement hooks ready")
        hooks_observed=time.time()*1000-started
        frame=self.frame(label=label)
        # Native visibility can precede transfer hydration in the child.
        # Waiting for its payload is a harness readiness condition, not a fix.
        def hydrated_child():
            workspaces=self.app.workspaces(label)
            return workspaces if any(t["type"]=="terminal" for w in workspaces for p in w["panes"] for t in p["tabs"]) else None
        child_ws=self.app.wait_until(hydrated_child,15,"detached terminal payload")
        payload_observed=time.time()*1000-started
        session=next(t["sessionId"] for w in child_ws for p in w["panes"] for t in p["tabs"] if t["type"]=="terminal")
        keys=self.input_keys(session,2,label)
        input_observed=time.time()*1000-started
        marks=self.marks(label)
        child_frame=self.app.window(label)
        returned=time.time()*1000
        self.eval("await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'mycmux://detached-dock-request',payload:{toLabel:'main',workspaceId:%s}});return true;"%J(child_ws[0]["id"]),label)
        self.app.wait_until(lambda:self.app.window(label) is None,20,"child docked")
        def returned_ids():
            ids=sorted(t["sessionId"] for w in self.app.workspaces() for p in w["panes"] for t in p["tabs"] if t["type"]=="terminal")
            return ids if ids==before_ids else None
        after_ids=self.app.wait_until(returned_ids,15,"docked terminal identities")
        closed=time.time()*1000-returned
        main_frame=self.frame()
        front=marks["front"];rust=marks["rust"]
        def delta(entries,name):
            found=next((m for m in reversed(entries) if m["name"]==name and m["atMs"]>=started-1),None)
            return found["atMs"]-started if found else None
        self.add(name,createdObservedMs=created_observed,visibleObservedMs=visible_observed,inputObservedMs=input_observed,
                 builtMs=delta(rust,"window.child.built"),visibleMs=delta(front,"window.visible"),firstFrameMs=delta(front,"workspace.first.frame"),
                 frame=frame,keys=keys,childFrame=child_frame,expectedFrame={"x":700,"y":300,"width":720,"height":520},
                 geometryMatches=all(abs(child_frame[k]-v)<=2 for k,v in {"x":700,"y":300,"width":720,"height":520}.items()),
                 closedMs=closed,mainFrame=main_frame,marks=marks,payloadObservedMs=payload_observed,hooksReadyObservedMs=hooks_observed,
                 idsMatch=before_ids==after_ids,idsBefore=before_ids,idsAfter=after_ids,_load_interval=interval)

    def S6(self):
        self.layout()
        for _ in range(10):self.detach_round("S6_detach_return")
        stop(self.app)

    def native(self,label,script):
        return self.app.call("e2e.native_eval",{"label":label,"script":script})

    def close_previews(self):
        result=self.eval("""
          const e=window.__mycmuxE2E;
          for(const w of e.stores.workspaceList.getState().workspaces)
            for(const p of w.panes)
              for(const t of p.tabs)if(t.type==='browser')e.stores.layout.getState().removeTabFromPane(w.id,p.id,t.id);
          return true;
        """)
        self.app.wait_until(lambda:not any(label.startswith("web-pane-") for w in self.app.windows() for label in w["webviews"]),20,"preview destruction")
        return result

    def preview_round(self,path,name,cold=False):
        interval=self.load.begin()
        if cold:self.close_previews();time.sleep(.3)
        start=self.preview(path)["startedMs"]
        if path.endswith(".md"):
            # Markdown deliberately uses an app-owned themed iframe, not a
            # native child WKWebView. Measure its actual path separately.
            def markdown_ready():
                return self.eval("const f=[...document.querySelectorAll('iframe')].find(f=>f.title===%s);const d=f?.contentDocument;return d?.readyState==='complete'&&d.body?.textContent?.includes('dummy line')?{ready:d.readyState,characters:d.body.textContent.length}:null;"%J(path))
            loaded=self.app.wait_until(markdown_ready,60,"Markdown iframe loaded")
            loaded_observed=time.time()*1000-start
            frame=self.frame()
            self.add(name,loadedObservedMs=loaded_observed,frameObservedMs=time.time()*1000-start,
                     renderer="themed-iframe",frame=frame,loaded=loaded,marks=self.marks(),_load_interval=interval)
            return "main"
        tabs=self.eval("return window.__mycmuxE2E.stores.workspaceList.getState().workspaces.flatMap(w=>w.panes.flatMap(p=>p.tabs.filter(t=>t.type==='browser').map(t=>({id:t.id,sourcePath:t.sourcePath,htmlPath:t.htmlPath}))));")
        tab=next((t for t in tabs if t.get("sourcePath")==path or t.get("htmlPath")==path),tabs[-1])
        label="web-pane-"+tab["id"]
        self.app.wait_until(lambda:any(label in w["webviews"] for w in self.app.windows()),20,"preview webview created")
        def ready():
            value=self.native(label,"return {ready:document.readyState,href:location.href,title:document.title};")
            return value if value["ready"]=="complete" and value["href"]!="about:blank" else None
        loaded=self.app.wait_until(ready,30,"preview loaded")
        loaded_observed=time.time()*1000-start
        self.native(label,"window.__perf3Frame={start:performance.timeOrigin+performance.now(),frames:0,visibility:document.visibilityState};requestAnimationFrame(()=>{window.__perf3Frame.frames++;requestAnimationFrame(()=>{window.__perf3Frame.frames++;window.__perf3Frame.end=performance.timeOrigin+performance.now()})});return window.__perf3Frame;")
        deadline=time.monotonic()+2
        frame=None
        while time.monotonic()<deadline:
            frame=self.native(label,"return window.__perf3Frame;")
            if frame and frame.get("end"):break
            time.sleep(.025)
        marks=self.marks()
        def delta(name):
            found=next((m for m in reversed(marks["rust"]) if m["name"]==name and m.get("id")==tab["id"] and m["atMs"]>=start-1),None)
            return found["atMs"]-start if found else None
        self.add(name,loadedObservedMs=loaded_observed,frameObservedMs=time.time()*1000-start,
                 createdMs=delta("webpane.child.created"),loadedMs=delta("webpane.load.finished"),shownMs=delta("webpane.child.shown"),
                 reusedMs=delta("webpane.preview.reload"),frame=frame,loaded=loaded,marks=marks,_load_interval=interval)
        return label

    def S7(self):
        self.layout()
        for kind in ("html","md"):
            for size in ("small","medium","heavy"):
                path=self.fixture[f"{kind}_{size}"]["path"]
                for i in range(3):
                    label=self.preview_round(path,f"S7_{kind}_{size}_cold",cold=True)
                    if i==0:self.app.snapshot(self.out/f"snapshot-{kind}-{size}.png",label)
                for _ in range(10):
                    with Path(path).open("a",encoding="utf-8") as file:file.write("\n")
                    self.preview_round(path,f"S7_{kind}_{size}_warm",cold=True)
        stop(self.app)

    def stability_sample(self,index,interval):
        pid=self.app.pids()[0]
        group=processes(pid)
        raw=[]
        for row in group:
            thread_rows=run(["ps","-M","-o","pid=","-p",str(row["pid"])])
            raw.append({"pid":row["pid"],"threads":len(thread_rows["stdout"].splitlines()),"threadPs":thread_rows,
                        "fdCount":len(run(["lsof","-p",str(row["pid"])])["stdout"].splitlines()),
                        "top":run(["top","-l","1","-pid",str(row["pid"]),"-stats","pid,threads,mem"])})
        self.add("S8_continuous",index=index,processes=group,details=raw,
                 rssMiB=sum(r["rss_kib"] for r in group)/1024,probe=self.eval("return window.__mycmuxE2E.macProbe.read()"),_load_interval=interval)

    def S8(self):
        # Owner's third-round rule: wait at most 20 minutes, then measure.
        start=time.monotonic()
        while os.getloadavg()[0]>20:
            self.report.setdefault("stability_load_gate",[]).append({"epoch":time.time(),"load":os.getloadavg()});self.save()
            if time.monotonic()-start>=1200:break
            time.sleep(300)
        self.layout();self.fake()
        self.eval("return window.__mycmuxE2E.macProbe.start()")
        start=time.monotonic()
        for i in range(7):
            interval=self.load.begin()
            time.sleep(max(0,start+i*300-time.monotonic()))
            self.stability_sample(i,interval)
        self.stability_repetitions("S8",switches=True)

    def S8_tail(self):
        self.report["continuationDefinition"]="Fresh L24S process for repetitions after the retained 30-minute run; not one uninterrupted S8 acceptance pass"
        self.layout();self.fake()
        self.stability_repetitions("S8_tail",switches=False)

    def stability_repetitions(self,prefix,switches):
        if switches:
            for i in range(100):
                interval=self.load.begin()
                a=self.select(self.tabs[6]);b=self.select(self.tabs[0])
                self.add(prefix+"_workspace_roundtrip",ms=a["ms"]+b["ms"],outbound=a,inbound=b,_load_interval=interval)
            for i in range(100):self.add(prefix+"_pane_switch",**self.select(self.tabs[i%3]))
        for _ in range(20):self.detach_round(prefix+"_detach_return")
        # Refresh identifiers after the docking transactions.
        self.ws=self.app.workspaces()
        self.tabs=[(w["id"],p["id"],t) for w in self.ws for p in w["panes"] for t in p["tabs"] if t["type"]=="terminal"]
        for _ in range(20):
            self.preview_round(self.fixture["html_small"]["path"],prefix+"_html_open",cold=True)
            self.close_previews()
        self.close_previews()
        for i in range(3):
            interval=self.load.begin()
            before=sorted(t["sessionId"] for w in self.app.workspaces() for p in w["panes"] for t in p["tabs"] if t["type"]=="terminal")
            before_rows=self.ptys()
            self.app.menu_key("q",["cmd"],defer_ms=100)
            exit_seconds=self.app.wait_exit(20)
            self.app.launch()
            self.app.wait_until(lambda:len(self.ptys())>0,40,"active restored PTYs")
            after=sorted(t["sessionId"] for w in self.app.workspaces() for p in w["panes"] for t in p["tabs"] if t["type"]=="terminal")
            after_rows=self.ptys()
            self.add(prefix+"_quit_restart",exitMs=exit_seconds*1000,idsMatch=before==after,uniqueIds=len(set(after)),
                     ptyCount=len(after_rows),before=before_rows,after=after_rows,_load_interval=interval)
        diag=self.app.runtime_dir/"diag.log"
        if diag.exists():
            text=diag.read_text(errors="replace")
            (self.out/"diag-stability.log").write_text(text,encoding="utf-8")
            self.report["diag_errors"]=[line for line in text.splitlines() if "error" in line.lower() or "timeout" in line.lower()]
        for name in ("close_main_keeps_saved_workspaces","cmd_q_restores_everything","hidden_window_keeps_output"):
            interval=self.load.begin()
            with (self.out/f"regression-{name}.jsonl").open("w",encoding="utf-8") as file,redirect_stdout(file):
                ok=SCENARIOS[name](self.app)
            self.add(prefix+"_"+name,passed=ok,_load_interval=interval)
            if not ok:raise E2eError("regression failed: "+name)
        stop(self.app)

    def smoke(self):
        self.layout(1)
        interval=self.load.begin()
        self.add("smoke_L0",keys=self.input_keys(self.tabs[0][2]["sessionId"],4),frame=self.frame(),_load_interval=interval)
        self.layout()
        interval=self.load.begin()
        self.add("smoke_L24",structure=self.app.workspaces(),keys=self.input_keys(self.tabs[0][2]["sessionId"],4),frame=self.frame(),_load_interval=interval)
        self.preview_round(self.fixture["html_small"]["path"],"smoke_preview",cold=True)
        self.close_previews()
        self.detach_round("smoke_detach")
        self.app.snapshot(self.out/"snapshot-smoke.png")
        stop(self.app)

    def validate(self, phases):
        expected={}
        if "S1" in phases:
            expected.update({f"S1_L{load}_{kind}":n for load in (1,24) for kind,n in (("cold",3),("warm",10))})
        if "S2" in phases:expected.update({f"S2_{load}":5 for load in ("L0","L24","L24S","L24S+H")})
        if "S3" in phases:expected.update({f"S3_{load}":200 for load in ("L24","L24S")})
        if "S4" in phases:expected.update({f"S4_{kind}":20 for kind in ("pane","tab_focus","workspace")})
        if "S5" in phases:expected.update({f"S5_{kind}":10 for kind in ("seq","cat10mb")})
        if "S6" in phases:expected["S6_detach_return"]=10
        if "S7" in phases:expected.update({f"S7_{kind}_{size}_{warm}":n for kind in ("html","md") for size in ("small","medium","heavy") for warm,n in (("cold",3),("warm",10))})
        if "S8" in phases:
            expected.update({"S8_continuous":7,"S8_workspace_roundtrip":100,"S8_pane_switch":100,"S8_detach_return":20,"S8_html_open":20,"S8_quit_restart":3})
            expected.update({"S8_"+name:1 for name in ("close_main_keeps_saved_workspaces","cmd_q_restores_everything","hidden_window_keeps_output")})
        if "S8_tail" in phases:
            expected.update({"S8_tail_detach_return":20,"S8_tail_html_open":20,"S8_tail_quit_restart":3})
            expected.update({"S8_tail_"+name:1 for name in ("close_main_keeps_saved_workspaces","cmd_q_restores_everything","hidden_window_keeps_output")})
        actual={name:len(item["samples"]) for name,item in self.report["measurements"].items()}
        self.report["expected"]=expected
        self.report["missing"]=[{"name":name,"expected":n,"actual":actual.get(name,0)} for name,n in expected.items() if actual.get(name,0)!=n]
        self.report["complete"]=not self.report["errors"] and not self.report["missing"]

    def run_phase(self,name):
        interval=self.load.begin()
        self.report["current_phase"]=name
        self.report.setdefault("phase_state",{})[name]={"status":"running","started":time.time()}
        self.save()
        print(J({"event":"phase-start","phase":name,"load":os.getloadavg()}),flush=True)
        try:
            getattr(self,name)()
            self.report["phase_state"][name].update(status="finished",ended=time.time())
        except Exception as exc:
            self.report["phase_state"][name].update(status="error",ended=time.time())
            self.report["errors"].append({"phase":name,"error":repr(exc),"epoch":time.time(),"traceback":traceback.format_exc()})
            self.save();print(J({"event":"phase-error","phase":name,"error":repr(exc)}),flush=True)
            stop(self.app)
        self.report["phase_state"][name].update(self.load.finish(interval))
        self.save()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--phases",nargs="+",default=[f"S{i}" for i in range(1,9)])
    args=parser.parse_args()
    measurement=Measure(args.out)
    try:
        for phase in args.phases:measurement.run_phase(phase)
    finally:
        stop(measurement.app)
        measurement.report["ended"]=time.time()
        measurement.report["test_final"]=run(["pgrep","-fl","mycmux-e2e"])
        measurement.report["live_final"]=run(["pgrep","-fl","/Applications/mycmux.app/Contents/MacOS/mycmux"])
        measurement.validate(args.phases)
        measurement.save()
    return not measurement.report["complete"]


if __name__=="__main__":
    raise SystemExit(main())
