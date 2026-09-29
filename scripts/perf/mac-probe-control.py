"""Same-process off/on/off control for Mac rAF and timer collection."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2e"))
from measure_mac import Measure, ROOT, stop, J
from mac_observe import processes, run


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--preview-breakdown", action="store_true")
    parser.add_argument("--visibility-control", action="store_true")
    parser.add_argument("--detach", action="store_true", help="release the SSH responsibility owner before measuring WebKit")
    args = parser.parse_args()
    if args.detach:
        if os.getpriority(os.PRIO_PROCESS,0) != 0:
            raise SystemExit("control must inherit default priority")
        with args.out.with_suffix(".log").open("a") as log:
            child=subprocess.Popen([sys.executable,"-u",str(Path(__file__).resolve())]+[a for a in sys.argv[1:] if a!="--detach"],
                                   stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        print(json.dumps({"pid":child.pid,"out":str(args.out)}))
        return 0
    lock = (ROOT / "supervisor.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    measurement = Measure(args.out)
    measurement.report["controlDefinition"] = "L0, same process, 60s off/on/off; active toggles continuous rAF and timer accounting together; timer wrappers remain installed in all conditions"
    try:
        measurement.layout(1)
        pid = measurement.app.pids()[0]
        for active in (False, True, False):
            measurement.eval("return window.__mycmuxE2E.macProbe.read(true)")
            time.sleep(3)
            interval = measurement.load.begin()
            before = processes(pid)
            required={"mycmux","WebContent","GPU","Networking"}
            if not required.issubset({p["kind"] for p in before}):
                raise RuntimeError("incomplete process ownership coverage before control interval")
            windows_before = measurement.app.windows()
            if active:
                measurement.eval("return window.__mycmuxE2E.macProbe.start()")
            started = time.monotonic()
            time.sleep(60)
            probe = measurement.eval("return window.__mycmuxE2E.macProbe.read(true)") if active else None
            after = processes(pid)
            if not required.issubset({p["kind"] for p in after}):
                raise RuntimeError("incomplete process ownership coverage after control interval")
            elapsed = time.monotonic() - started
            cpu = {}
            for kind in ("mycmux", "WebContent", "GPU", "Networking"):
                old = {row["pid"]: row for row in before if row["kind"] == kind}
                new = [row for row in after if row["kind"] == kind]
                delta = sum((row["cpu_seconds"] - old[row["pid"]]["cpu_seconds"]) * 1000 for row in new if row["pid"] in old)
                cpu[kind] = {"cpuDeltaMs": delta, "cpuPercent": delta / elapsed / 10,
                             "rssMiB": sum(row["rss_kib"] for row in new) / 1024, "pids": [row["pid"] for row in new]}
            measurement.add("probeControl_" + ("on" if active else "off"), active=active, elapsedS=elapsed,
                            before=before, after=after, cpu=cpu, probe=probe, windowsBefore=windows_before, _load_interval=interval)
        if args.visibility_control:
            for visible in (False, True):
                measurement.app.window_action("main", "show" if visible else "hide")
                measurement.app.wait_until(lambda: measurement.app.window("main")["visible"] == visible, 10, "visibility control")
                time.sleep(.3)
                measurement.add("visibilityControl_" + ("visible" if visible else "hidden"), **measurement.frame(timeout=1000))
        if args.preview_breakdown:
            measurement.eval("""
              const e=window.__mycmuxE2E;
              const original=e.previewArtifactUriForSessionV2;
              window.__perf3InvokeSpans=[];
              const wrapped=async function(...args){
                const span={command:'preview_artifact_uri_for_session_v2',startMs:performance.timeOrigin+performance.now()};
                window.__perf3InvokeSpans.push(span);
                try{return await original(...args)}finally{
                  span.endMs=performance.timeOrigin+performance.now();span.ms=span.endMs-span.startMs;
                }
              };e.previewArtifactUriForSessionV2=wrapped;
              if(e.previewArtifactUriForSessionV2!==wrapped)throw new Error('preview wrapper not installed');
              return true;
            """)
            for _ in range(3):
                measurement.eval("window.__perf3InvokeSpans=[];return true;")
                measurement.preview_round(measurement.fixture["md_heavy"]["path"], "markdownBreakdown", cold=True)
                row=measurement.report["measurements"]["markdownBreakdown"]["samples"][-1]
                row["invokeSpans"]=measurement.eval("return window.__perf3InvokeSpans")
                measurement.save()
                interval=measurement.load.begin()
                standalone=measurement.eval("""
                  const started=performance.now();
                  const source=await window.__TAURI_INTERNALS__.invoke('read_editable_artifact',{sourcePath:%s});
                  return {ms:performance.now()-started,characters:source.content.length,
                    definition:'standalone repeat of the second conversion API, not a span inside the displayed preview'};
                """%J(measurement.fixture["md_heavy"]["path"]),timeout_ms=20000)
                measurement.add("markdownReadStandalone",**standalone,_load_interval=interval)
        measurement.report["complete"] = True
    except Exception as exc:
        measurement.report["errors"].append({"error": repr(exc), "epoch": time.time()})
    finally:
        stop(measurement.app)
        measurement.report["ended"] = time.time()
        measurement.report["test_final"] = run(["pgrep", "-fl", "mycmux-e2e"])
        measurement.report["live_final"] = run(["pgrep", "-fl", "/Applications/mycmux.app/Contents/MacOS/mycmux"])
        measurement.save()
    print(json.dumps({"complete": measurement.report["complete"], "errors": measurement.report["errors"]}))
    return not measurement.report["complete"]


if __name__ == "__main__":
    raise SystemExit(main())
