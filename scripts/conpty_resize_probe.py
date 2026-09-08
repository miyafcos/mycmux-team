"""Record what conhost actually sends a terminal when a pane is resized.

Diagnostic tool for the "the conversation jumps up and down when I change a pane
width or switch workspaces" class of report. It opens a pseudoconsole directly --
no mycmux, no xterm, no WebView -- runs a real TUI inside it, resizes it on a
script, and writes every byte conhost emits to a timestamped JSONL log. Feed that
log to scripts/replay_conpty_probe.mjs to see where the viewport lands in the
same xterm.js build the app renders with.

The pseudoconsole is created with the same flags portable-pty asks for, so what
this records is what a mycmux pane would have received.

Example (line continuations are shell-level):

  python scripts/conpty_resize_probe.py --out log.jsonl --flags quirk
      --cmd "C:\path\to\claude.exe" --cwd . --size 100x30
      --script "wait:8;key:hello;wait:3;resize:70x30;wait:4;resize:100x40;wait:4"

  --flags   quirk (the default, and what portable-pty asks for) or noquirk, which
            makes conhost reprint the whole buffer on every resize.
  --script  semicolon-separated steps. wait:<seconds> / resize:<cols>x<rows> /
            key:<literal text> / raw:<text where backslash escapes are decoded,
            so a carriage return is written as backslash-r>.
"""
import argparse, ctypes, ctypes.wintypes as W, json, os, sys, threading, time, subprocess

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
HPCON = W.HANDLE
class COORD(ctypes.Structure):
    _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]
class STARTUPINFOW(ctypes.Structure):
    _fields_ = [("cb", W.DWORD), ("lpReserved", W.LPWSTR), ("lpDesktop", W.LPWSTR), ("lpTitle", W.LPWSTR),
                ("dwX", W.DWORD), ("dwY", W.DWORD), ("dwXSize", W.DWORD), ("dwYSize", W.DWORD),
                ("dwXCountChars", W.DWORD), ("dwYCountChars", W.DWORD), ("dwFillAttribute", W.DWORD),
                ("dwFlags", W.DWORD), ("wShowWindow", W.WORD), ("cbReserved2", W.WORD),
                ("lpReserved2", ctypes.c_void_p), ("hStdInput", W.HANDLE), ("hStdOutput", W.HANDLE), ("hStdError", W.HANDLE)]
class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [("StartupInfo", STARTUPINFOW), ("lpAttributeList", ctypes.c_void_p)]
class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", W.HANDLE), ("hThread", W.HANDLE), ("dwProcessId", W.DWORD), ("dwThreadId", W.DWORD)]

k32.CreatePseudoConsole.argtypes = [COORD, W.HANDLE, W.HANDLE, W.DWORD, ctypes.POINTER(HPCON)]
k32.CreatePseudoConsole.restype = ctypes.c_long
k32.ResizePseudoConsole.argtypes = [HPCON, COORD]
k32.ResizePseudoConsole.restype = ctypes.c_long
k32.ClosePseudoConsole.argtypes = [HPCON]
k32.CreatePipe.argtypes = [ctypes.POINTER(W.HANDLE), ctypes.POINTER(W.HANDLE), ctypes.c_void_p, W.DWORD]
k32.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, W.DWORD, W.DWORD, ctypes.POINTER(ctypes.c_size_t)]
k32.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, W.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
k32.CreateProcessW.argtypes = [W.LPCWSTR, W.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, W.BOOL, W.DWORD, ctypes.c_void_p, W.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(PROCESS_INFORMATION)]
k32.ReadFile.argtypes = [W.HANDLE, ctypes.c_void_p, W.DWORD, ctypes.POINTER(W.DWORD), ctypes.c_void_p]
k32.WriteFile.argtypes = [W.HANDLE, ctypes.c_void_p, W.DWORD, ctypes.POINTER(W.DWORD), ctypes.c_void_p]

PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
FLAG_QUIRK = 0x2
FLAG_WIN32_INPUT = 0x4

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--flags", default="quirk")
    ap.add_argument("--cmd", required=True)
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--size", default="100x30")
    ap.add_argument("--script", required=True)
    a = ap.parse_args()
    cols, rows = (int(v) for v in a.size.split("x"))
    flags = (FLAG_QUIRK if a.flags == "quirk" else 0) | FLAG_WIN32_INPUT

    in_r, in_w, out_r, out_w = W.HANDLE(), W.HANDLE(), W.HANDLE(), W.HANDLE()
    assert k32.CreatePipe(ctypes.byref(in_r), ctypes.byref(in_w), None, 0)
    assert k32.CreatePipe(ctypes.byref(out_r), ctypes.byref(out_w), None, 0)
    hpc = HPCON()
    hr = k32.CreatePseudoConsole(COORD(cols, rows), in_r, out_w, flags, ctypes.byref(hpc))
    assert hr == 0, hex(hr & 0xffffffff)

    size = ctypes.c_size_t(0)
    k32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
    attr = ctypes.create_string_buffer(size.value)
    assert k32.InitializeProcThreadAttributeList(attr, 1, 0, ctypes.byref(size))
    assert k32.UpdateProcThreadAttribute(attr, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc, ctypes.sizeof(HPCON), None, None)
    si = STARTUPINFOEXW()
    si.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
    # Same trick as portable-pty: explicitly invalid std handles + USESTDHANDLES so
    # the child's CRT opens the pseudoconsole for stdio instead of inheriting ours.
    INVALID = W.HANDLE(-1)
    si.StartupInfo.dwFlags = 0x100 | 0x1
    si.StartupInfo.hStdInput = INVALID; si.StartupInfo.hStdOutput = INVALID; si.StartupInfo.hStdError = INVALID
    si.lpAttributeList = ctypes.cast(attr, ctypes.c_void_p)
    pi = PROCESS_INFORMATION()

    env = {k: v for k, v in os.environ.items() if not (k.startswith("CLAUDE") or k.startswith("MYCMUX") or k.startswith("CODEX_") or k.startswith("BASH_FUNC"))}
    env["TERM"] = "xterm-256color"; env["COLORTERM"] = "truecolor"; env["TERM_PROGRAM"] = "ptrterminal"; env["MYCMUX_TERM_PROGRAM"] = "mycmux"
    envblock = "".join(f"{k}={v}\0" for k, v in sorted(env.items())) + "\0"
    envbuf = ctypes.create_unicode_buffer(envblock, len(envblock) + 1)
    cmdline = ctypes.create_unicode_buffer(a.cmd)
    ok = k32.CreateProcessW(None, cmdline, None, None, False, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                            envbuf, a.cwd, ctypes.byref(si), ctypes.byref(pi))
    assert ok, ctypes.get_last_error()
    t0 = time.perf_counter()
    log = open(a.out, "w", encoding="utf-8")
    lock = threading.Lock()
    def emit(kind, **kw):
        kw.update(t=round(time.perf_counter() - t0, 4), kind=kind)
        with lock:
            log.write(json.dumps(kw) + "\n"); log.flush()
    emit("start", cols=cols, rows=rows, flags=flags, cmd=a.cmd, pid=pi.dwProcessId)
    stop = threading.Event()
    def reader():
        buf = ctypes.create_string_buffer(65536); n = W.DWORD(0)
        while not stop.is_set():
            if not k32.ReadFile(out_r, buf, 65536, ctypes.byref(n), None):
                if not stop.is_set(): emit("eof")
                return
            if stop.is_set(): return
            emit("out", data=buf.raw[:n.value].decode("latin1"))
    threading.Thread(target=reader, daemon=True).start()
    def write(data: bytes):
        n = W.DWORD(0); k32.WriteFile(in_w, data, len(data), ctypes.byref(n), None)
    for step in a.script.split(";"):
        step = step.strip()
        if not step: continue
        op, _, arg = step.partition(":")
        if op == "wait":
            time.sleep(float(arg))
        elif op == "resize":
            c, r = (int(v) for v in arg.split("x"))
            emit("resize", cols=c, rows=r)
            hr = k32.ResizePseudoConsole(hpc, COORD(c, r))
            emit("resized", hr=hr)
        elif op == "key":
            emit("key", data=arg)
            write(arg.encode("latin1"))
        elif op == "raw":
            b = arg.encode().decode("unicode_escape").encode("latin1")
            emit("key", data=b.decode("latin1"))
            write(b)
    emit("terminate")
    k32.TerminateProcess(pi.hProcess, 0)
    time.sleep(0.5)
    emit("end")
    stop.set()
    log.close()
    k32.ClosePseudoConsole(hpc)
    os._exit(0)

if __name__ == "__main__":
    main()
