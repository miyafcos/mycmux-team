"""Run the required Windows test runner with a guard for this process tree only."""
from __future__ import annotations
import ctypes
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]

class Memory(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
        (name, ctypes.c_ulonglong) for name in
        ("total", "available", "page_total", "page_available", "virtual", "virtual_available", "extended")]

def available() -> float:
    memory = Memory()
    memory.length = ctypes.sizeof(memory)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory)):
        raise RuntimeError("Cannot verify available RAM")
    return memory.available / 1024**3

def other_rust_processes() -> list[dict]:
    command = (
        "$ErrorActionPreference = 'Stop'; "
        "Get-CimInstance Win32_Process -Filter \"Name = 'cargo.exe' OR Name = 'rustc.exe'\" "
        "| Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"
    )
    result = subprocess.run(["powershell", "-NoProfile", "-Command", command],
                            capture_output=True, text=True, check=True)
    if not result.stdout.strip():
        return []
    processes = json.loads(result.stdout)
    return processes if isinstance(processes, list) else [processes]

def wait_for_gate(out: Path) -> float | None:
    history = out / "resume1-ram-wait.jsonl"
    first = None
    if history.exists():
        for line in history.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if row.get("wait_started"):
                first = datetime.fromisoformat(row["utc"])
                break
    first = first or datetime.now(timezone.utc)
    while True:
        tick = time.monotonic()
        peers = other_rust_processes()
        free = available()
        now = datetime.now(timezone.utc)
        expired = (now - first).total_seconds() >= 4 * 60 * 60
        row = {"utc": now.isoformat(), "available_gib": round(free, 3),
               "other_rust_processes": peers, "wait_seconds": (now - first).total_seconds(),
               "expired": expired}
        with history.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row) + "\n")
        status = "ram_wait_expired" if expired else "ready" if free >= 5 and not peers else "waiting"
        (out / "resume1-rust-state.json").write_text(
            json.dumps({**row, "status": status}, indent=2) + "\n", encoding="utf-8")
        print(f"RAM gate: {free:.3f} GiB; other cargo/rustc: {len(peers)}; "
              f"wait: {row['wait_seconds']:.0f}s; {status}", flush=True)
        if expired:
            return None
        if status == "ready":
            return free
        time.sleep(max(0, 60 - (time.monotonic() - tick)))

def main() -> int:
    out = ROOT / "tmp" / "tearout-verification"
    out.mkdir(parents=True, exist_ok=True)
    started = wait_for_gate(out)
    if started is None:
        return 75
    print(f"RAM before tests: {started:.3f} GiB", flush=True)
    env = os.environ.copy()
    env["CARGO_BUILD_JOBS"] = "2"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    # If RAM falls during interpreter startup, return to our bounded 60s gate.
    # The required runner still checks its own gate; never bypass it.
    env.pop("MYCMUX_SKIP_RAM_GATE", None)
    env["MYCMUX_RAM_GATE_MAX_WAIT_MIN"] = "0"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log = out / f"rust-resume1-{stamp}.txt"
    minimum = started
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    with log.open("w", encoding="utf-8") as stream:
        process = subprocess.Popen([sys.executable, "scripts/run_windows_tests.py"], cwd=ROOT,
                                   env=env, stdout=stream, stderr=subprocess.STDOUT)
        (out / "resume1-rust-state.json").write_text(
            json.dumps({"status": "running", "pid": process.pid, "log": str(log),
                        "start_gib": started}, indent=2) + "\n", encoding="utf-8")
        tick = 0
        while process.poll() is None:
            free = available()
            minimum = min(minimum, free)
            with (out / "resume1-running-ram.jsonl").open("a", encoding="utf-8") as history:
                history.write(json.dumps({"utc": datetime.now(timezone.utc).isoformat(),
                                          "pid": process.pid, "available_gib": round(free, 3)}) + "\n")
            if free < 1:
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], check=False,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                print(f"Stopped own test/build tree at {free:.3f} GiB", flush=True)
                process.wait()
                break
            if tick % 6 == 0:
                print(f"RAM during tests: {free:.3f} GiB; output: {log}", flush=True)
            tick += 1
            time.sleep(5)
    contents = log.read_text(encoding="utf-8")
    gate_refused = process.returncode != 0 and "\u7a7a\u304dRAM" in contents and "cargo test --no-run failed" not in contents
    status = "ram_gate_refused" if gate_refused else "completed" if minimum >= 1 else "stopped_low_ram"
    evidence = {"command": "python scripts/run_windows_tests.py", "jobs": 2, "head": head,
                "start_gib": started, "minimum_gib": minimum, "exit_code": process.returncode,
                "log": str(log), "status": status}
    (out / "rust-memory.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    (out / f"rust-memory-{stamp}.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    (out / "resume1-rust-state.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print("\n".join(contents.splitlines()[-35:]), flush=True)
    return 76 if gate_refused else process.returncode

if __name__ == "__main__":
    while True:
        result = main()
        if result != 76:
            raise SystemExit(result)
