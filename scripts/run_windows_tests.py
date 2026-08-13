"""Windows で cargo のテストバイナリを manifest 付きで実行する。

`cargo test --release` を素で走らせると、テストが 1 行も走らないまま
STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) で落ちることがある。原因は test harness exe に
manifest が付かないこと: 依存クレートが comctl32 の TaskDialogIndirect を import する一方、
manifest 無しでは Common Controls v5.82 が解決され該当 entrypoint が存在しない。
製品 exe は tauri-build が manifest を埋めるので影響を受けない。

mt.exe で後から埋めても `cargo test` は再リンクのたびに剥がすため、ビルド (--no-run) と
実行を分離し、その間に manifest を埋め込む。リンカへ /MANIFEST:EMBED を渡す方法は
LNK1123 (COFF 変換失敗) を踏むうえ製品 exe のリンクにも影響するため採らない。

使い方:
    python scripts/run_windows_tests.py            # src-tauri でビルドから実行まで
    python scripts/run_windows_tests.py --build-json <path>   # 既存のビルド出力を使う
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# Progress messages contain Japanese; a cp932 console would raise
# UnicodeEncodeError mid-run and abort the whole test pass.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = REPO_ROOT / "src-tauri" / "tests.manifest"
WINDOWS_KITS_BIN = Path(r"C:\Program Files (x86)\Windows Kits\10\bin")

# RAM gate: rustc release build peaks >2GB; this machine has BSOD 0x133 history
# under RAM exhaustion, and long-running production jobs may share the box.
# Refuse to start a build below MIN_BUILD_RAM_GB and throttle below LOW_RAM_JOBS_GB.
MIN_BUILD_RAM_GB = 5.0
LOW_RAM_JOBS_GB = 8.0
RAM_POLL_SECONDS = 60


def available_ram_gb() -> float | None:
    """Windows の空き物理メモリ (GB)。取得できなければ None。"""
    if os.name != "nt":
        return None
    import ctypes

    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    stat = MEMORYSTATUSEX()
    stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
        return None
    return stat.ullAvailPhys / (1024**3)


def wait_for_build_ram() -> list[str]:
    """空きRAMがビルド安全水準に達するまで待ち、cargo に足す追加引数を返す。

    MYCMUX_SKIP_RAM_GATE=1 で無効化。既定の最大待ち時間は 120 分で、
    それでも足りなければ RAM を食い潰すよりビルド中止を選ぶ (fail-closed)。
    """
    if os.environ.get("MYCMUX_SKIP_RAM_GATE") == "1":
        return []
    avail = available_ram_gb()
    if avail is None:
        return []
    max_wait_min = float(os.environ.get("MYCMUX_RAM_GATE_MAX_WAIT_MIN", "120"))
    deadline = time.monotonic() + max_wait_min * 60
    while avail is not None and avail < MIN_BUILD_RAM_GB:
        if time.monotonic() >= deadline:
            sys.exit(
                f"空きRAM {avail:.1f}GB < {MIN_BUILD_RAM_GB}GB のままビルドを中止しました "
                f"(BSOD 0x133 予防・{max_wait_min:.0f}分待機後)。他ジョブ終了後に再実行してください。"
            )
        print(
            f"RAM gate: 空き {avail:.1f}GB < {MIN_BUILD_RAM_GB}GB — {RAM_POLL_SECONDS}秒待機",
            flush=True,
        )
        time.sleep(RAM_POLL_SECONDS)
        avail = available_ram_gb()
    if avail is not None and avail < LOW_RAM_JOBS_GB:
        print(f"RAM gate: 空き {avail:.1f}GB < {LOW_RAM_JOBS_GB}GB — cargo -j 2 で実行", flush=True)
        return ["-j", "2"]
    return []


def find_mt_exe() -> Path | None:
    """一番新しい SDK の mt.exe を返す。見つからなければ None。"""
    if not WINDOWS_KITS_BIN.is_dir():
        return None
    candidates = sorted(WINDOWS_KITS_BIN.glob("*/x64/mt.exe"))
    return candidates[-1] if candidates else None


def build_test_binaries(manifest_dir: Path) -> list[Path]:
    """cargo test --no-run を走らせ、生成された test exe の一覧を返す。"""
    extra_args = wait_for_build_ram()
    proc = subprocess.run(
        ["cargo", "test", "--release", "--no-run", "--message-format=json", *extra_args],
        cwd=manifest_dir,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    sys.stderr.write(proc.stderr)
    if proc.returncode != 0:
        sys.exit(f"cargo test --no-run failed with exit code {proc.returncode}")
    return collect_executables(proc.stdout)


def collect_executables(stdout: str) -> list[Path]:
    """テストハーネスだけを拾う。

    `cargo test --no-run` は example / bin もビルドするので executable が生えるが、
    それらは走らせてはいけない (例: examples/oauth_probe は標準入力を待つ対話プログラム)。
    テストとしてビルドされたものだけ profile.test が true になるのでそれで絞る。
    """
    executables: list[Path] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        executable = message.get("executable")
        is_test = (message.get("profile") or {}).get("test") is True
        if executable and is_test:
            executables.append(Path(executable))
    return executables


def embed_manifest(exe: Path, mt_exe: Path) -> None:
    proc = subprocess.run(
        [str(mt_exe), "-manifest", str(MANIFEST), f"-outputresource:{exe};#1"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        sys.exit(f"mt.exe failed for {exe.name}:\n{proc.stdout}\n{proc.stderr}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--manifest-dir",
        default=str(REPO_ROOT / "src-tauri"),
        help="cargo を走らせるディレクトリ (既定: src-tauri)",
    )
    args = parser.parse_args()

    if os.name != "nt":
        # 非 Windows では素の cargo test で十分 (manifest は Windows 固有の話)
        return subprocess.run(["cargo", "test", "--release"], cwd=args.manifest_dir).returncode

    if not MANIFEST.is_file():
        sys.exit(f"manifest not found: {MANIFEST}")

    executables = build_test_binaries(Path(args.manifest_dir))
    if not executables:
        sys.exit("no test executables were produced by cargo test --no-run")

    mt_exe = find_mt_exe()
    if mt_exe is None:
        sys.exit(f"mt.exe not found under {WINDOWS_KITS_BIN}")
    print(f"using {mt_exe}", flush=True)

    failed: list[str] = []
    for exe in executables:
        if not exe.is_file():
            failed.append(f"{exe} (missing)")
            continue
        embed_manifest(exe, mt_exe)
        print(f"\n=== running {exe.name} ===", flush=True)
        # cargo を介さず直接実行する (cargo test 経由だと再リンクで manifest が剥がれる)
        result = subprocess.run([str(exe)])
        if result.returncode != 0:
            failed.append(f"{exe.name} (exit {result.returncode})")

    if failed:
        print("\nFAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print(f"\nall {len(executables)} test binaries passed", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
