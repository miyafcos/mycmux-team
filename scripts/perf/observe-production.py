"""Read-only Windows stage-three observation. Never attaches CDP or sends input."""
import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import psutil


def stamp():
    return datetime.now(timezone.utc).isoformat()


def emit(stream, kind, **values):
    stream.write(json.dumps(dict(time=stamp(), kind=kind, **values), ensure_ascii=True) + "\n")
    stream.flush()


def snapshot(proc):
    with proc.oneshot():
        cpu = proc.cpu_times()
        mem = proc.memory_info()
        io = proc.io_counters()
        return dict(pid=proc.pid, parent=proc.ppid(), created=proc.create_time(),
                    cpu_ms=(cpu.user + cpu.system) * 1000, ws=mem.rss,
                    private=mem.private, handles=proc.num_handles(), threads=proc.num_threads(),
                    read_bytes=io.read_bytes, write_bytes=io.write_bytes)


def thread_description(tid):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenThread.restype = wintypes.HANDLE
    kernel.GetThreadDescription.argtypes = [wintypes.HANDLE, ctypes.POINTER(ctypes.c_wchar_p)]
    kernel.GetThreadDescription.restype = ctypes.c_long
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenThread(0x0800, False, tid)
    if not handle:
        return None
    ptr = ctypes.c_wchar_p()
    try:
        # HRESULT success is any non-negative value (this host returns S_* != 0).
        if kernel.GetThreadDescription(handle, ctypes.byref(ptr)) >= 0:
            name = ptr.value
            kernel.LocalFree(ctypes.cast(ptr, ctypes.c_void_p))
            return name
    finally:
        kernel.CloseHandle(handle)
    return None


def file_snapshot(roots):
    result = {}
    errors = []
    for root in roots:
        directories = [root]
        for name in ("pane-sessions", "scrollback"):
            child = root / name
            if child.is_dir():
                directories.append(child)
        for directory in directories:
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        stat = entry.stat(follow_symlinks=False)
                        result[entry.path] = [stat.st_mtime_ns, stat.st_size]
            except OSError as error:
                errors.append(dict(path=str(directory), error=str(error)))
    return result, errors


def webviews(prod_pid):
    rows = []
    parents = {}
    processes = list(psutil.process_iter(["name", "ppid"]))
    for proc in processes:
        parents[proc.pid] = proc.info["ppid"]
    for proc in processes:
        if proc.info["name"].lower() != "msedgewebview2.exe":
            continue
        try:
            args = proc.cmdline()
            row = snapshot(proc)
            row["type"] = next((a[7:] for a in args if a.startswith("--type=")), "browser")
            row["webview_exe_name"] = next((a.split("=", 1)[1] for a in args if a.startswith("--webview-exe-name=")), None)
            row["user_data_dir"] = next((a.split("=", 1)[1] for a in args if a.startswith("--user-data-dir=")), None)
            ancestor = proc.pid
            visited = set()
            while ancestor not in visited and ancestor in parents and ancestor != prod_pid:
                visited.add(ancestor)
                ancestor = parents[ancestor]
            row["production_descendant"] = ancestor == prod_pid
            rows.append(row)
        except (psutil.Error, OSError):
            pass
    return rows


def observe(args):
    prod = psutil.Process(args.pid)
    expected = Path(os.environ["LOCALAPPDATA"]) / "mycmux" / "mycmux.exe"
    if Path(prod.exe()).resolve() != expected.resolve():
        raise RuntimeError("PID does not identify the installed production executable")
    created = prod.create_time()
    roots = [Path.home() / ".mycmux", Path(os.environ["APPDATA"]) / "com.miyazaki.mycmux"]
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith(("CLAUDE", "MYCMUX_"))}
    env["MYCMUX_RUNTIME_DIR"] = str(roots[0])
    env["PYTHONIOENCODING"] = "utf-8"
    cli = Path(__file__).resolve().parents[1] / "mycmux_agent_cli.py"
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation preserves previous evidence on resume.
    with output.open("x", encoding="utf-8") as stream:
        emit(stream, "start", production=snapshot(prod), exe=str(expected), seconds=args.seconds,
             observer_pid=os.getpid(), roots=list(map(str, roots)),
             io_method="GetProcessIoCounters via psutil; successive byte-counter deltas / actual elapsed seconds")
        files, errors = file_snapshot(roots)
        emit(stream, "files_initial", files=files, errors=errors)
        started = time.monotonic()
        next_process = 0
        next_threads = 0
        previous_threads = {}
        previous_sample = None
        previous_webviews = {}
        previous_thread_at = started
        ticks = 0
        while time.monotonic() - started <= args.seconds:
            elapsed = time.monotonic() - started
            if not prod.is_running() or prod.create_time() != created:
                emit(stream, "aborted", reason="production process identity changed")
                return 2
            scan_start = time.monotonic()
            updated, errors = file_snapshot(roots)
            changes = [dict(path=p, before=files.get(p), after=v) for p, v in updated.items() if files.get(p) != v]
            removed = [p for p in files if p not in updated]
            emit(stream, "files", elapsed=elapsed, changes=changes, removed=removed, errors=errors,
                 scan_ms=(time.monotonic() - scan_start) * 1000)
            files = updated
            if elapsed >= next_process:
                row = snapshot(prod)
                row["elapsed"] = elapsed
                if previous_sample:
                    duration = elapsed - previous_sample["elapsed"]
                    row["interval_seconds"] = duration
                    for key in ("cpu_ms", "read_bytes", "write_bytes"):
                        row[key + "_delta"] = row[key] - previous_sample[key]
                    row["read_bytes_per_second"] = row["read_bytes_delta"] / duration
                    row["write_bytes_per_second"] = row["write_bytes_delta"] / duration
                previous_sample = row.copy()
                web = webviews(prod.pid)
                for view in web:
                    before = previous_webviews.get(view["pid"])
                    if before and before["created"] == view["created"]:
                        view["cpu_ms_delta"] = view["cpu_ms"] - before["cpu_ms"]
                previous_webviews = {view["pid"]: view for view in web}
                try:
                    command = subprocess.run([sys.executable, str(cli), "panes", "--all"], env=env,
                                             capture_output=True, text=True, encoding="utf-8", timeout=8,
                                             creationflags=subprocess.CREATE_NO_WINDOW)
                    activity = json.loads(command.stdout) if command.returncode == 0 else {"error": command.stderr}
                except Exception as error:
                    activity = {"error": str(error)}
                emit(stream, "process", production=row, webviews=web, activity=activity,
                     observer=snapshot(psutil.Process()), available_memory=psutil.virtual_memory().available)
                next_process += 10
            if elapsed >= next_threads:
                current_threads = {t.id: (t.user_time + t.system_time) * 1000 for t in prod.threads()}
                rows = [dict(id=tid, cpu_ms_delta=cpu-previous_threads[tid], name=thread_description(tid))
                        for tid, cpu in current_threads.items() if tid in previous_threads]
                rows.sort(key=lambda row: row["cpu_ms_delta"], reverse=True)
                emit(stream, "threads", elapsed=elapsed, interval_seconds=time.monotonic()-previous_thread_at,
                     top10=rows[:10], all=rows)
                previous_threads = current_threads
                previous_thread_at = time.monotonic()
                next_threads += 30
            ticks += 1
            time.sleep(max(0, started + ticks - time.monotonic()))
        emit(stream, "complete", elapsed=time.monotonic()-started, production=snapshot(prod),
             same_pid=prod.pid == args.pid and prod.create_time() == created)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", required=True, type=int)
    parser.add_argument("--seconds", type=int, default=1800)
    parser.add_argument("--output", required=True)
    raise SystemExit(observe(parser.parse_args()))
