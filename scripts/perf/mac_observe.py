"""Read-only macOS process observations; never contacts the live app socket."""
from __future__ import annotations

import argparse
import ctypes
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import time


def run(args: list[str], timeout: float = 30) -> dict:
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    return {"command": args, "exit": p.returncode, "stdout": p.stdout, "stderr": p.stderr}


def cpu_seconds(value: str) -> float:
    parts = value.split(":")
    return sum(float(part) * 60 ** i for i, part in enumerate(reversed(parts)))


def processes(owner: int) -> list[dict]:
    lib = ctypes.CDLL(None)
    responsible = lib.responsibility_get_pid_responsible_for_pid
    responsible.argtypes = [ctypes.c_int]
    responsible.restype = ctypes.c_int
    raw = run(["ps", "-axo", "pid=,ppid=,pcpu=,rss=,time=,etime=,comm="])["stdout"]
    rows = []
    for line in raw.splitlines():
        parts = line.split(None, 6)
        if len(parts) != 7:
            continue
        pid, ppid, pcpu, rss, cpu, elapsed, command = parts
        if int(pid) != owner and "com.apple.WebKit." not in command:
            continue
        actual_owner = responsible(int(pid))
        if int(pid) != owner and actual_owner != owner:
            continue
        rows.append({"pid": int(pid), "ppid": int(ppid), "responsible_pid": actual_owner,
                     "kind": "mycmux" if int(pid) == owner else command.rsplit(".", 1)[-1],
                     "pcpu": float(pcpu), "rss_kib": int(rss), "cpu_seconds": cpu_seconds(cpu),
                     "etime": elapsed, "command": command})
    return rows


def sample(pid: int, out: Path, seconds: int = 10) -> dict:
    result = run(["sample", str(pid), str(seconds), "-mayDie", "-file", str(out)], seconds + 90)
    text = out.read_text(errors="replace") if out.exists() else ""
    # sample's own sorted leaf table avoids counting every ancestor as CPU work.
    marker = "Sort by top of stack, same collapsed (when >= 5):"
    table = text.split(marker, 1)[-1].split("Binary Images:", 1)[0] if marker in text else ""
    result["top15"] = [line.strip() for line in table.splitlines() if re.match(r"\s*\S.*\s+\d+\s*$", line)][:15]
    result["file"] = str(out)
    return result


def observe(owner: int, out: Path, duration: int = 1200, interval: int = 10) -> None:
    out.mkdir(parents=True, exist_ok=False)
    initial = processes(owner)
    if not any(row["pid"] == owner and row["command"] == "/Applications/mycmux.app/Contents/MacOS/mycmux" for row in initial):
        raise RuntimeError("live process identity mismatch")
    (out / "identity.json").write_text(json.dumps(initial, indent=2) + "\n")
    started = time.monotonic()
    previous = {}
    samples = []
    workers = []
    for row in initial:
        if row["kind"] in ("mycmux", "WebContent"):
            path = out / f"sample-{row['kind']}-{row['pid']}.txt"
            log = (out / f"sample-{row['pid']}.log").open("w")
            workers.append((subprocess.Popen(["sample", str(row["pid"]), "10", "-mayDie", "-file", str(path)], stdout=log, stderr=log), log, path))
    with (out / "observations.jsonl").open("x", encoding="utf-8") as file:
        for index in range(duration // interval + 1):
            time.sleep(max(0, started + index * interval - time.monotonic()))
            rows = processes(owner)
            for row in rows:
                old = previous.get(row["pid"])
                row["cpu_delta_ms"] = (row["cpu_seconds"] - old["cpu_seconds"]) * 1000 if old else None
            entry = {"index": index, "epoch": time.time(), "elapsed_s": time.monotonic() - started,
                     "load": os.getloadavg(), "processes": rows,
                     "ps": run(["ps", "-o", "pid,pcpu,rss,etime,comm", "-p", ",".join(str(r["pid"]) for r in rows)]),
                     "top": [run(["top", "-l", "1", "-pid", str(r["pid"]), "-stats", "pid,command,cpu,time,mem,threads,state"]) for r in rows]}
            file.write(json.dumps(entry) + "\n")
            file.flush()
            previous = {row["pid"]: row for row in rows}
            samples.append(entry)
            if index % 6 == 0:
                print(json.dumps({"event": "observation", "index": index, "elapsed_s": entry["elapsed_s"], "load": entry["load"]}), flush=True)
    for proc, log, path in workers:
        proc.wait(timeout=30)
        log.close()
    final = {"complete": len(samples) == duration // interval + 1, "count": len(samples),
             "elapsed_s": time.monotonic() - started, "initial": initial, "final": processes(owner)}
    (out / "complete.json").write_text(json.dumps(final, indent=2) + "\n")
    print(json.dumps(final), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", required=True, type=int)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--duration", type=int, default=1200)
    args = parser.parse_args()
    observe(args.pid, args.out, args.duration)
