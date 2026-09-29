"""Durable perf3 build/measurement supervisor; run under nohup on the Mac.

Each phase has its own atomic partial results. Completed phases are retained
on restart; interrupted attempts are kept and retried into a new directory.
"""
from __future__ import annotations
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[2]
ROOT = Path.home() / "Developer/macq-e2e/perf3"


def read(path):
    return json.loads(path.read_text()) if path.exists() else {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--phases", nargs="+", default=["smoke"] + [f"S{i}" for i in range(1, 9)])
    parser.add_argument("--verify-lib", action="store_true")
    parser.add_argument("--detach", action="store_true", help="detach without zsh background nice inheritance")
    parser.add_argument("--retry-phases", nargs="*", default=[], help="retain and replace selected phase attempts even if complete")
    args = parser.parse_args()
    args.run_dir.mkdir(parents=True, exist_ok=True)
    if args.detach:
        if os.getpriority(os.PRIO_PROCESS, 0) != 0:
            raise SystemExit("start the detached supervisor from a default-priority foreground shell")
        with (args.run_dir / "supervisor.log").open("a") as log:
            child = subprocess.Popen([sys.executable, "-u", str(Path(__file__).resolve())]
                                     + [arg for arg in sys.argv[1:] if arg != "--detach"],
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        print(json.dumps({"supervisorPid": child.pid, "runDir": str(args.run_dir), "nice": 0}))
        return 0
    # A second reconnect command must not stop or compete with the first run.
    lock = (ROOT / "supervisor.lock").open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("another perf3 supervisor still owns the Mac profile")
    state_path = args.run_dir / "state.json"
    state = read(state_path)
    prior_pid = state.get("pid")
    if state.get("status") == "running" and prior_pid and prior_pid != os.getpid():
        prior_command = subprocess.run(["ps", "-p", str(prior_pid), "-o", "command="], capture_output=True, text=True).stdout
        if "run-mac-resumable.py" in prior_command:
            raise SystemExit("recorded supervisor is still running: " + str(prior_pid))
    state.update(pid=os.getpid(), started=time.time(), status="running")
    state.pop("error", None)
    state.pop("ended", None)
    state["supervisorNice"] = os.getpriority(os.PRIO_PROCESS, 0)
    state.setdefault("phases", {})
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    state["head"] = head

    def save(**fields):
        state.update(fields, updated=time.time())
        temp = state_path.with_suffix(".tmp")
        temp.write_text(json.dumps(state, indent=2) + "\n")
        temp.replace(state_path)

    def load_gate(stage):
        prior_checks = [row for row in state.get("load_checks", []) if row["stage"] == stage]
        gate = state.setdefault("load_gates", {}).setdefault(stage, {
            "started": prior_checks[0]["epoch"] if prior_checks else time.time(),
            "nextCheck": prior_checks[-1]["epoch"] + 300 if prior_checks else time.time(),
        })
        while True:
            save(current="load-gate-" + stage)
            time.sleep(max(0, gate["nextCheck"] - time.time()))
            row = {"epoch": time.time(), "stage": stage, "load": os.getloadavg()}
            state.setdefault("load_checks", []).append(row)
            gate["nextCheck"] = row["epoch"] + 300
            save(current="load-gate-" + stage)
            if row["load"][0] <= 20:
                gate["passed"] = row["epoch"]
                save()
                return
            if time.time() - gate["started"] >= 1200:
                gate["proceedAboveThreshold"] = row["epoch"]
                save()
                return

    try:
        build = read(ROOT / "build-result.json")
        state["prior_build"] = build
        binary = ROOT / "mycmux-e2e.app/Contents/MacOS/mycmux"
        reusable = build.get("exit") == 0 and build.get("head") == head and binary.exists()
        if not reusable and build.get("exit") == 0 and binary.exists() and build.get("head"):
            # Driver-only commits do not change the measured bundle. Retain its
            # exact source SHA; never pretend it was built from the new HEAD.
            result = subprocess.run(["git", "diff", "--name-only", build["head"], head], cwd=REPO, capture_output=True, text=True)
            changed = result.stdout.splitlines()
            reusable = result.returncode == 0 and all(p.startswith(("scripts/e2e/", "scripts/perf/")) for p in changed)
            state["build_source_difference"] = changed
        if not reusable:
            load_gate("build")
            save(current="build")
            with (args.run_dir / "build-supervisor.log").open("a") as log:
                code = subprocess.call(["/bin/zsh", str(REPO / "scripts/perf/build-perf3.sh")], stdout=log, stderr=log)
            build = read(ROOT / "build-result.json")
            if code or build.get("exit") != 0 or build.get("head") != head:
                raise RuntimeError("build failed: " + json.dumps(build))
        state["build"] = build
        (args.run_dir / "build-result.json").write_text(json.dumps(build, indent=2) + "\n")
        save(current="measure")
        def verify_lib():
            load_gate("lib-test")
            log_path = args.run_dir / ("cargo-lib-" + time.strftime("%Y%m%d-%H%M%S") + ".log")
            command = ["nice", "-n", "10", "cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib"]
            env = dict(os.environ)
            env["PATH"] = "/opt/homebrew/opt/rustup/bin:" + str(Path.home() / ".cargo/bin") + ":/opt/homebrew/bin:" + env.get("PATH", "")
            row = {"head":head,"command":command,"log":str(log_path),"started":time.time()}
            state["lib_test"] = row
            save(current="lib-test")
            with log_path.open("w") as log:
                process = subprocess.Popen(command,cwd=REPO,env=env,stdout=log,stderr=log)
                row["pid"] = process.pid
                save()
                row["exit"] = process.wait()
            row["seconds"] = time.time() - row["started"]
            save()
        for phase in args.phases:
            prior = state["phases"].get(phase, {})
            if phase not in args.retry_phases and prior.get("exit") == 0 and read(Path(prior["out"]) / "results.json").get("complete"):
                continue
            stamp = time.strftime("%Y%m%d-%H%M%S")
            out = args.run_dir / f"{phase}-{stamp}"
            log_path = args.run_dir / f"{phase}-{stamp}.log"
            row = {"out": str(out), "started": time.time(), "log": str(log_path)}
            state["phases"][phase] = row
            save(current=phase)
            with log_path.open("w") as log:
                process = subprocess.Popen([sys.executable, "-u", str(REPO / "scripts/e2e/measure_mac.py"), "--out", str(out), "--phases", phase], stdout=log, stderr=log)
                row["pid"] = process.pid
                save()
                row["exit"] = process.wait()
            row["ended"] = time.time()
            save()
            if phase == "smoke" and row["exit"]:
                raise RuntimeError("smoke failed; inspect retained results before full measurements")
        if args.verify_lib and not (state.get("lib_test", {}).get("head") == head and state["lib_test"].get("exit") == 0):
            verify_lib()
        failed = [name for name, row in state["phases"].items() if row.get("exit") != 0]
        if state.get("lib_test") and state["lib_test"].get("exit") != 0:
            failed.append("lib-test")
        save(status="finished" if not failed else "partial", current=None, failed=failed, ended=time.time())
        return bool(failed)
    except Exception as exc:
        save(status="blocked", error=repr(exc), ended=time.time())
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
