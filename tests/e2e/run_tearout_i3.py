"""Sequential fresh-profile matrix for the authorized I-3 CDP checks."""
from datetime import datetime, timezone
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tmp/tearout-verification/i3"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("exe", type=Path)
    parser.add_argument("phase", choices=("before", "after", "matrix"))
    parser.add_argument("--resume-summary", type=Path)
    args = parser.parse_args()
    exe = args.exe.resolve()
    assert exe.is_file() and ROOT in exe.parents, exe
    stamp = datetime.now(timezone.utc).strftime("%m%d%H%M%S")
    cases = [("probe", [])] if args.phase != "matrix" else [(mode, []) for mode in ("off-b1", "off-suite", "off-web")]
    if args.phase == "matrix":
        for kind in ("pane", "tab", "workspace"):
            for destination in ("keep", "esc", "strip", "center", "left", "right", "up", "down", "sidebar"):
                cases.append(("on", ["--kind", kind, "--destination", destination]))
        for destination in ("keep", "esc", "sidebar"):
            cases.append(("on", ["--kind", "workspace", "--regions", "2", "--destination", destination]))
        for kind, regions in (("tab", "1"), ("workspace", "2")):
            cases.append(("on", ["--kind", kind, "--regions", regions, "--destination", "sidebar", "--regrab"]))
        for entry, destination in (("whitespace", "center"), ("pill", "left")):
            cases.append(("on", ["--kind", "tab", "--destination", destination, "--regrab", "--regrab-entry", entry]))
    digest = hashlib.sha256(exe.read_bytes()).hexdigest()
    results = []
    if args.resume_summary:
        previous = json.loads(args.resume_summary.read_text(encoding="utf-8"))
        assert args.phase == "matrix" and previous["phase"] == args.phase
        assert previous["exe_sha256"] == digest and previous["total"] == len(cases)
        for result in previous["results"]:
            if result["exit_code"]: break
            results.append(result)
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
    for index, (mode, options) in enumerate(cases):
        if index < len(results): continue
        tag = f"{args.phase}-{stamp}-{index:02}"
        profile = f"i3{stamp}{index:02}"
        port = 9271 + index
        command = [sys.executable, "-X", "utf8", str(Path(__file__).with_name("tearout_i3.py")),
                   mode, str(exe), profile, str(port), tag, *options]
        log = OUT/f"{tag}.log"
        print(f"Starting {tag}: {mode} {' '.join(options)}", flush=True)
        try:
            with log.open("w", encoding="utf-8") as output:
                process = subprocess.run(command, cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=1200)
            exit_code = process.returncode
        except subprocess.TimeoutExpired:
            # The child cannot run finally after a timeout; close this profile only.
            sys.path.insert(0, str(OUT/"e2e"))
            import tmctl
            pid = tmctl.find_pid(exe, profile)
            if pid: tmctl.stop(exe, profile, pid)
            exit_code = 124
        result = {"tag": tag, "command": command, "exit_code": exit_code, "log": str(log)}
        results.append(result)
        summary = {"exe": str(exe), "exe_sha256": digest,
                   "phase": args.phase, "results": results, "passed": sum(r["exit_code"] == 0 for r in results), "total": len(cases)}
        if args.resume_summary: summary["previous_summary"] = str(args.resume_summary.resolve())
        (OUT/f"{args.phase}-{stamp}-summary.json").write_text(json.dumps(summary, indent=2)+"\n", encoding="utf-8")
        print(json.dumps(result), flush=True)
        if exit_code:
            print("\n".join(log.read_text(encoding="utf-8").splitlines()[-30:]), flush=True)
            raise SystemExit(exit_code)
    print(f"{len(results)}/{len(cases)} passed", flush=True)


if __name__ == "__main__": main()
