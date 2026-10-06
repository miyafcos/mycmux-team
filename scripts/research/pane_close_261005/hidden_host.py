"""Own one isolated release copy on a never-selected Windows desktop.

Start gate: 3 GiB. Stop gate: <2 GiB. Stops only PIDs/birth times owned by this host.
No real input, no whole-desktop capture, no installation, no deletion.
"""
from __future__ import annotations

import ctypes as C
from ctypes import wintypes as W
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import threading
import time

import psutil

from evidence_io import DEFAULT_DATA, dump

ROOT = Path(__file__).resolve().parents[3]
APP_IDENTIFIER = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["identifier"]
SOURCE_EXE = Path.home() / "_work/mycmux-release-0830c-261004/windows/mycmux.exe"
HEAVY_STATE = Path.home() / ".claude/dispatch/261005-shared/heavy_lock.json"
SEAT = "s5"
SHA256 = "54b3448eacf47989ed1740128b3eb33f547d91814a0106b14d28a6524dfa3f2b"


class Startup(C.Structure):
    _fields_ = [("cb", W.DWORD), ("lpReserved", W.LPWSTR), ("lpDesktop", W.LPWSTR),
                ("lpTitle", W.LPWSTR), ("dwX", W.DWORD), ("dwY", W.DWORD),
                ("dwXSize", W.DWORD), ("dwYSize", W.DWORD), ("dwXCountChars", W.DWORD),
                ("dwYCountChars", W.DWORD), ("dwFillAttribute", W.DWORD), ("dwFlags", W.DWORD),
                ("wShowWindow", W.WORD), ("cbReserved2", W.WORD), ("lpReserved2", C.c_void_p),
                ("hStdInput", W.HANDLE), ("hStdOutput", W.HANDLE), ("hStdError", W.HANDLE)]


class ProcessInfo(C.Structure):
    _fields_ = [("hProcess", W.HANDLE), ("hThread", W.HANDLE), ("dwProcessId", W.DWORD), ("dwThreadId", W.DWORD)]


user32 = C.WinDLL("user32", use_last_error=True)
kernel32 = C.WinDLL("kernel32", use_last_error=True)
user32.CreateDesktopW.argtypes = [W.LPCWSTR, W.LPCWSTR, C.c_void_p, W.DWORD, W.DWORD, C.c_void_p]
user32.CreateDesktopW.restype = W.HANDLE
user32.CloseDesktop.argtypes = [W.HANDLE]
user32.CloseDesktop.restype = W.BOOL
user32.GetForegroundWindow.restype = W.HWND
user32.GetWindowThreadProcessId.argtypes = [W.HWND, C.POINTER(W.DWORD)]
EnumProc = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
user32.EnumWindows.argtypes = [EnumProc, W.LPARAM]
kernel32.CreateProcessW.argtypes = [W.LPCWSTR, W.LPWSTR, C.c_void_p, C.c_void_p, W.BOOL,
                                   W.DWORD, C.c_void_p, W.LPCWSTR, C.POINTER(Startup), C.POINTER(ProcessInfo)]
kernel32.CreateProcessW.restype = W.BOOL
kernel32.CloseHandle.argtypes = [W.HANDLE]
kernel32.CloseHandle.restype = W.BOOL


def foreground():
    return int(user32.GetForegroundWindow() or 0)


def visible_desktop_windows(pid):
    handles = []
    @EnumProc
    def collect(hwnd, _):
        actual = W.DWORD()
        user32.GetWindowThreadProcessId(hwnd, C.byref(actual))
        if actual.value == pid:
            handles.append(int(hwnd))
        return True
    user32.EnumWindows(collect, 0)
    return handles


def memory_sample(reason):
    return {"utc": dt.datetime.now(dt.timezone.utc).isoformat(), "reason": reason,
            "free_bytes": psutil.virtual_memory().available,
            "free_gib": round(psutil.virtual_memory().available / 2**30, 6)}


def checked_heavy_lease(state, now=None):
    """Fail closed unless the common coordinator has an unexpired S4 lease."""
    now = time.time() if now is None else now
    expiry = state.get("expires_at") if isinstance(state, dict) else None
    if (not isinstance(state, dict) or state.get("owner") != SEAT
            or not isinstance(expiry, (int, float)) or isinstance(expiry, bool)
            or not math.isfinite(expiry) or expiry <= now):
        raise RuntimeError("S5 must acquire the shared heavy-work lease before launching a test host")
    return {"owner": SEAT, "expires_at": expiry}


def require_heavy_lease():
    try:
        state = json.loads(HEAVY_STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RuntimeError("Shared heavy-work lease is unavailable; acquire it first") from exc
    return checked_heavy_lease(state)


class HiddenHost:
    def __init__(self, profile: str, port: int, data: Path = DEFAULT_DATA, resume=False):
        assert re.fullmatch(r"s5[A-Za-z0-9_-]{1,60}", profile), profile
        assert 9380 <= port <= 9389
        self.profile, self.port, self.data = profile, port, data
        self.runtime = Path.home() / f".mycmux-{profile}"
        self.directory = data / "testmachines" / (profile + "-" + dt.datetime.now().strftime("%H%M%S%f"))
        self.directory.mkdir(parents=True, exist_ok=False)
        self.exe = self.directory / f"{profile}.exe"
        self.resume = resume
        self.pid = None
        self.birth = None
        self.desktop = None
        self.process_handle = None
        self.end = threading.Event()
        self.stopped = False
        self.low_memory = False
        self.lock = threading.RLock()
        self.owned = {}
        self.samples = []
        self.record = {"profile": profile, "port": port, "exe": str(self.exe), "expected_sha256": SHA256,
                       "desktop_name": "mycmux-" + profile, "resume": resume, "stopped": False}

    def save(self):
        dump(self.directory / "host.json", self.record)

    def sample(self, reason):
        sample = memory_sample(reason)
        with (self.directory / "memory.jsonl").open("a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(sample) + "\n")
        self.samples.append(sample)
        return sample

    def start(self):
        self.record["heavy_lease"] = require_heavy_lease()
        sample = self.sample("prelaunch")
        if sample["free_bytes"] < 3 * 2**30:
            self.record.update(started=False, blocked="free memory below 3 GiB", free_gib=sample["free_gib"])
            self.save()
            raise RuntimeError("start gate: free RAM below 3 GiB")
        assert hashlib.sha256(SOURCE_EXE.read_bytes()).hexdigest() == SHA256
        shutil.copyfile(SOURCE_EXE, self.exe)
        assert hashlib.sha256(self.exe.read_bytes()).hexdigest() == SHA256
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", self.port))
        if not self.resume:
            for path in [self.runtime, Path(os.environ["APPDATA"]) / APP_IDENTIFIER / "profiles" / self.profile]:
                if path.exists():
                    raise RuntimeError(f"fresh profile already exists: {path}")
        self.runtime.mkdir(parents=True, exist_ok=True)
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith(("CLAUDE", "MYCMUX_"))}
        env["WEBVIEW2_USER_DATA_FOLDER"] = str(self.runtime / "webview2")
        env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={self.port} --remote-allow-origins=*"
        self.record["stripped_environment_keys"] = sorted(k for k in os.environ if k.upper().startswith(("CLAUDE", "MYCMUX_")))
        self.record["webview2_user_data_folder"] = env["WEBVIEW2_USER_DATA_FOLDER"]
        self.record["foreground_before"] = foreground()
        self.desktop = user32.CreateDesktopW(self.record["desktop_name"], None, None, 0, 0x01FF, None)
        if not self.desktop:
            raise C.WinError(C.get_last_error())
        startup = Startup(); startup.cb = C.sizeof(startup)
        startup.lpDesktop = "WinSta0\\" + self.record["desktop_name"]
        startup.dwFlags = 1; startup.wShowWindow = 5
        info = ProcessInfo()
        self.record["heavy_lease"] = require_heavy_lease()
        sample = self.sample("immediate_prelaunch")
        if sample["free_bytes"] < 3 * 2**30:
            raise RuntimeError("start gate: free RAM below 3 GiB immediately before launch")
        command = C.create_unicode_buffer(subprocess.list2cmdline([str(self.exe), "--profile", self.profile]))
        env_block = C.create_unicode_buffer("\0".join(f"{k}={v}" for k, v in sorted(env.items(), key=lambda x: x[0].upper())) + "\0\0")
        ok = kernel32.CreateProcessW(str(self.exe), command, None, None, False, 0x400, env_block,
                                    str(self.directory), C.byref(startup), C.byref(info))
        if not ok:
            raise C.WinError(C.get_last_error())
        self.pid = int(info.dwProcessId); self.process_handle = info.hProcess
        kernel32.CloseHandle(info.hThread)
        proc = psutil.Process(self.pid); self.birth = proc.create_time()
        self.owned[self.pid] = self.birth
        self.record.update(started=True, pid=self.pid, birth=self.birth,
                           foreground_after_spawn=foreground(), owner_desktop_test_windows=visible_desktop_windows(self.pid))
        self.save()
        self.thread = threading.Thread(target=self.watch, daemon=True); self.thread.start()
        return self

    def watch(self):
        while not self.end.wait(1):
            try:
                require_heavy_lease()
            except RuntimeError:
                self.stop("shared heavy-work lease lost or expired")
                return
            sample = self.sample("running")
            try:
                proc = psutil.Process(self.pid)
                if proc.create_time() == self.birth:
                    for child in proc.children(recursive=True):
                        self.owned[child.pid] = child.create_time()
            except psutil.Error:
                pass
            if sample["free_bytes"] < 2 * 2**30:
                self.low_memory = True
                self.stop("RAM below 2 GiB")
                return

    def stop(self, reason="suite complete"):
        with self.lock:
            if self.stopped:
                return
            self.stopped = True; self.end.set()
            before = foreground()
            try:
                root = psutil.Process(self.pid)
                if root.create_time() == self.birth:
                    for child in root.children(recursive=True):
                        self.owned[child.pid] = child.create_time()
            except (psutil.Error, TypeError):
                pass
            stopped, remaining = [], []
            # Capture birth times; never use an image-name kill or an unverified recycled PID.
            for pid, birth in sorted(self.owned.items(), key=lambda p: p[0] == self.pid):
                try:
                    process = psutil.Process(pid)
                    if process.create_time() == birth:
                        process.terminate(); stopped.append(pid)
                except psutil.Error:
                    pass
            for pid in stopped:
                try:
                    psutil.Process(pid).wait(timeout=3)
                except psutil.TimeoutExpired:
                    remaining.append(pid)
                except psutil.Error:
                    pass
            closed = bool(user32.CloseDesktop(self.desktop)) if self.desktop else True
            if self.process_handle:
                kernel32.CloseHandle(self.process_handle)
            self.record.update(stopped=True, stop_reason=reason, stop_pids=stopped,
                               owned_birth_times={str(pid):birth for pid,birth in self.owned.items()},
                               remaining_owned_pids=remaining, desktop_closed=closed,
                               foreground_before_stop=before, foreground_after_stop=foreground(),
                               owner_desktop_test_windows_after_stop=visible_desktop_windows(self.pid or 0),
                               min_running_free_gib=min((s["free_gib"] for s in self.samples), default=None))
            self.sample("after_stop"); self.save()

    def __enter__(self):
        try:
            return self.start()
        except Exception:
            self.stop("start failed")
            raise

    def __exit__(self, exc_type, exc, tb):
        self.stop("suite exception" if exc else "suite complete")
