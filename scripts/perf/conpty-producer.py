"""Separate seq/ConPTY diagnostic with an eager raw sink; no mycmux process.

API lifetime follows:
https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session
https://learn.microsoft.com/en-us/windows/console/closepseudoconsole
"""
from __future__ import annotations

import argparse
import ctypes as c
from ctypes import wintypes as w
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time


class Coord(c.Structure):
    _fields_ = [("x", c.c_short), ("y", c.c_short)]


class StartupInfo(c.Structure):
    _fields_ = [("cb", w.DWORD), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR),
                ("title", w.LPWSTR), ("x", w.DWORD), ("y", w.DWORD),
                ("width", w.DWORD), ("height", w.DWORD), ("xchars", w.DWORD),
                ("ychars", w.DWORD), ("fill", w.DWORD), ("flags", w.DWORD),
                ("show", w.WORD), ("reserved_size", w.WORD), ("reserved2", c.c_void_p),
                ("stdin", w.HANDLE), ("stdout", w.HANDLE), ("stderr", w.HANDLE)]


class StartupInfoEx(c.Structure):
    _fields_ = [("info", StartupInfo), ("attributes", c.c_void_p)]


class ProcessInfo(c.Structure):
    _fields_ = [("process", w.HANDLE), ("thread", w.HANDLE),
                ("pid", w.DWORD), ("tid", w.DWORD)]


def validate_seq_stream(raw: bytes, count: int) -> dict:
    """Fail closed if VT removal cannot establish every decimal line in order."""
    # Keep movement/erase controls distinct from line separators: if ConPTY
    # coalesces rows, this check must fail rather than invent missing newlines.
    plain = re.sub(rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", b"", raw)
    plain = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", plain)
    expected = b"".join(str(i).encode("ascii") + b"\n" for i in range(1, count + 1))
    normalized = plain.replace(b"\r\n", b"\n")
    return {"exactSequence": normalized == expected, "normalizedBytes": len(normalized),
            "normalizedSha256": hashlib.sha256(normalized).hexdigest(),
            "expectedSha256": hashlib.sha256(expected).hexdigest(),
            "rawSha256": hashlib.sha256(raw).hexdigest()}


def run_once(program: Path, arguments: list[str], count: int, cols: int, rows: int,
             timeout_ms: int = 120_000, read_delay_ms: float = 0):
    if os.name != "nt":
        raise RuntimeError("ConPTY requires Windows")
    kernel = c.WinDLL("kernel32", use_last_error=True)
    signatures = {
        "CreatePipe": ([c.POINTER(w.HANDLE), c.POINTER(w.HANDLE), c.c_void_p, w.DWORD], w.BOOL),
        "CreatePseudoConsole": ([Coord, w.HANDLE, w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)], c.c_long),
        "ClosePseudoConsole": ([w.HANDLE], None),
        "CloseHandle": ([w.HANDLE], w.BOOL),
        "InitializeProcThreadAttributeList": ([c.c_void_p, w.DWORD, w.DWORD, c.POINTER(c.c_size_t)], w.BOOL),
        "UpdateProcThreadAttribute": ([c.c_void_p, w.DWORD, c.c_size_t, c.c_void_p, c.c_size_t, c.c_void_p, c.c_void_p], w.BOOL),
        "DeleteProcThreadAttributeList": ([c.c_void_p], None),
        "CreateProcessW": ([w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p, w.BOOL, w.DWORD,
                            c.c_void_p, w.LPCWSTR, c.POINTER(StartupInfoEx), c.POINTER(ProcessInfo)], w.BOOL),
        "ReadFile": ([w.HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.c_void_p], w.BOOL),
        "WaitForSingleObject": ([w.HANDLE, w.DWORD], w.DWORD),
        "GetExitCodeProcess": ([w.HANDLE, c.POINTER(w.DWORD)], w.BOOL),
        "GetProcessTimes": ([w.HANDLE, c.POINTER(w.FILETIME), c.POINTER(w.FILETIME),
                             c.POINTER(w.FILETIME), c.POINTER(w.FILETIME)], w.BOOL),
    }
    for name, (args, result) in signatures.items():
        fn = getattr(kernel, name); fn.argtypes = args; fn.restype = result

    def checked(ok):
        if not ok:
            raise c.WinError(c.get_last_error())

    handles = []
    hpc = w.HANDLE()
    attributes = None
    reader = None
    pieces = []
    read_errors = []
    result = {"reads": 0, "bytes": 0, "firstReadAtMs": None, "lastReadAtMs": None}
    epoch = time.time_ns() / 1_000_000
    origin = time.perf_counter_ns()
    cpu_start = time.process_time()
    stamp = lambda: epoch + (time.perf_counter_ns() - origin) / 1_000_000

    def close_handle(handle):
        if handle in handles:
            checked(kernel.CloseHandle(handle)); handles.remove(handle)

    try:
        input_read, input_write, output_read, output_write = (w.HANDLE() for _ in range(4))
        checked(kernel.CreatePipe(c.byref(input_read), c.byref(input_write), None, 0))
        handles.extend([input_read.value, input_write.value])
        checked(kernel.CreatePipe(c.byref(output_read), c.byref(output_write), None, 0))
        handles.extend([output_read.value, output_write.value])
        status = kernel.CreatePseudoConsole(Coord(cols, rows), input_read, output_write, 0, c.byref(hpc))
        if status < 0:
            raise RuntimeError(f"CreatePseudoConsole HRESULT {status & 0xffffffff:08x}")

        def drain():
            buffer = c.create_string_buffer(65536)
            size = w.DWORD()
            while True:
                if read_delay_ms:
                    time.sleep(read_delay_ms / 1000)
                if not kernel.ReadFile(output_read, buffer, len(buffer), c.byref(size), None):
                    break
                if not size.value:
                    break
                at = stamp()
                result["reads"] += 1; result["bytes"] += size.value
                if result["firstReadAtMs"] is None:
                    result["firstReadAtMs"] = at
                result["lastReadAtMs"] = at
                if result["bytes"] <= 64 * 1024 * 1024:
                    pieces.append(c.string_at(buffer, size.value))
                elif not read_errors:
                    read_errors.append("Raw capture exceeded 64 MiB; capture is incomplete")
            error = c.get_last_error()
            if error not in (0, 109):
                read_errors.append(f"ReadFile error {error}")

        reader = threading.Thread(target=drain, name="conpty-raw-sink", daemon=True)
        reader.start()
        size = c.c_size_t()
        kernel.InitializeProcThreadAttributeList(None, 1, 0, c.byref(size))
        memory = c.create_string_buffer(size.value)
        checked(kernel.InitializeProcThreadAttributeList(memory, 1, 0, c.byref(size)))
        attributes = c.cast(memory, c.c_void_p)
        checked(kernel.UpdateProcThreadAttribute(attributes, 0, 0x00020016, hpc, c.sizeof(hpc), None, None))
        startup = StartupInfoEx()
        # Explicit NULL standard handles prevent Windows from duplicating the
        # invoking tool's redirected stdout instead of connecting to ConPTY.
        # https://github.com/microsoft/terminal/discussions/15814
        startup.info.cb = c.sizeof(startup); startup.info.flags = 0x101; startup.info.show = 0
        startup.attributes = attributes
        process = ProcessInfo()
        command = c.create_unicode_buffer(subprocess.list2cmdline([str(program), *arguments]))
        result["processStartAtMs"] = stamp()
        checked(kernel.CreateProcessW(str(program), command, None, None, False, 0x00080000,
                                      None, str(program.parent), c.byref(startup), c.byref(process)))
        handles.extend([process.process, process.thread])
        result["pid"] = process.pid
        close_handle(input_read.value); close_handle(output_write.value)
        wait = kernel.WaitForSingleObject(process.process, timeout_ms)
        result["processEndAtMs"] = stamp()
        if wait != 0:
            raise RuntimeError(f"Owned producer did not finish: wait={wait}")
        code = w.DWORD()
        checked(kernel.GetExitCodeProcess(process.process, c.byref(code)))
        result["exitCode"] = code.value
        created, exited, kernel_time, user_time = (w.FILETIME() for _ in range(4))
        checked(kernel.GetProcessTimes(process.process, c.byref(created), c.byref(exited),
                                       c.byref(kernel_time), c.byref(user_time)))
        ticks = lambda value: (value.dwHighDateTime << 32) | value.dwLowDateTime
        result["producerCpuMs"] = (ticks(kernel_time) + ticks(user_time)) / 10_000
    finally:
        # Drain on another thread throughout close, including the final VT frame.
        if hpc.value:
            kernel.ClosePseudoConsole(hpc)
        for handle in [locals().get("input_read"), locals().get("output_write")]:
            if handle and handle.value in handles:
                close_handle(handle.value)
        if reader is not None:
            reader.join(10)
            if reader.is_alive():
                read_errors.append("Output did not close within 10 seconds")
        if attributes:
            kernel.DeleteProcThreadAttributeList(attributes)
        for handle in list(handles):
            close_handle(handle)
    if read_errors:
        raise RuntimeError("; ".join(read_errors))
    result["sinkCpuMs"] = (time.process_time() - cpu_start) * 1000
    raw = b"".join(pieces)
    result.update(validate_seq_stream(raw, count))
    result["producerThroughConptyMs"] = result["processEndAtMs"] - result["processStartAtMs"]
    result["readSpanMs"] = result["lastReadAtMs"] - result["firstReadAtMs"] if raw else None
    return result, raw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--count", type=int, default=200_000)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--cols", type=int, default=80)
    parser.add_argument("--rows", type=int, default=24)
    parser.add_argument("--producer", choices=["seq", "cat"], default="seq")
    parser.add_argument("--read-delay-ms", type=float, default=0)
    args = parser.parse_args()
    if not (1 <= args.count <= 200_000 and 1 <= args.runs <= 10 and 10 <= args.cols <= 300
            and 5 <= args.rows <= 200 and 0 <= args.read_delay_ms <= 2):
        parser.error("Diagnostic bounds exceeded")
    out = args.output_dir.resolve()
    allowed = (Path.home() / "_work/mycmux-perf3-260924/fixA").resolve()
    if not out.is_relative_to(allowed):
        parser.error("Evidence must be under the fixA folder")
    out.mkdir(parents=True, exist_ok=True)
    program = Path("C:/Program Files/Git/usr/bin") / f"{args.producer}.exe"
    identity = {"producer": args.producer, "producerSha256": hashlib.sha256(program.read_bytes()).hexdigest(),
                "driverSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "count": args.count, "cols": args.cols, "rows": args.rows, "readDelayMs": args.read_delay_ms}
    path = out / "conpty-producer.json"
    report = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {
        "identity": identity, "samples": [],
        "method": "Separate diagnostic: direct seq or cat process attached to ConPTY, both producing the same 1..N lines; 64 KiB ReadFile on a separate thread, eager by default or delayed by the recorded readDelayMs; raw capture kept in memory then saved. No Rust, IPC, xterm, or input workload. Process time includes process startup and ConPTY backpressure; dimensions may differ from S5. Not an A/B acceptance result."}
    if report["identity"] != identity:
        raise RuntimeError("Existing diagnostic identity differs; choose a new evidence directory")
    if any(row["exitCode"] != 0 or not row["exactSequence"] for row in report["samples"]):
        raise RuntimeError("Existing failed capture must not be reused; choose a new evidence directory")
    source = out / "driver-source.py"
    if source.exists() and source.read_bytes() != Path(__file__).read_bytes():
        raise RuntimeError("Preserved diagnostic source differs")
    if not source.exists():
        source.write_bytes(Path(__file__).read_bytes())
    arguments = ["1", str(args.count)]
    if args.producer == "cat":
        payload = b"".join(str(i).encode("ascii") + b"\n" for i in range(1, args.count + 1))
        fixture = out / "sequence.txt"
        if fixture.exists() and fixture.read_bytes() != payload:
            raise RuntimeError("Existing producer fixture differs")
        if not fixture.exists():
            fixture.write_bytes(payload)
        arguments = [str(fixture)]
    while len(report["samples"]) < args.runs:
        row, raw = run_once(program, arguments, args.count, args.cols, args.rows, read_delay_ms=args.read_delay_ms)
        row["run"] = len(report["samples"]) + 1
        capture = out / f"conpty-seq-{row['run']}.bin"
        if capture.exists():
            raise RuntimeError("Existing raw capture without a report row; preserve and choose a new directory")
        capture.write_bytes(raw); row["rawFile"] = str(capture)
        report["samples"].append(row)
        path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(row), flush=True)
        if row["exitCode"] != 0 or not row["exactSequence"]:
            raise RuntimeError("ConPTY capture did not verify every line in order; raw evidence preserved")


if __name__ == "__main__":
    main()
