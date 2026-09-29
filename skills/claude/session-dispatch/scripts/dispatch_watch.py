"""Watch one session dispatch and verify its declared machine gate (B3).

fail-closed の原則:
- close-tab は「この dispatch の行に spawn 応答由来として記録された tab_session_id」だけに撃つ。
  slug 後勝ちマージで別日の同名 dispatch から引き継いだ値は使わない (台帳の読みは dispatch_ledger)。
- 台帳上すでにクローズ済み集合の dispatch には一切操作しない。
- 同じ slug に active な dispatch が複数あるときは撃たずに CONFIG-ERROR で止まる (--spawn-ts で特定)。
- RUNNING / STALL 判定は pin 済み子セッションログ 1 本だけを見る (dispatch_status.dispatch_activity)。
"""

from __future__ import annotations

import argparse
import locale
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import dispatch_ledger
from dispatch_ledger import Dispatch, find_dispatches, load_dispatches
from dispatch_status import dispatch_activity

DEFAULT_LEDGER = dispatch_ledger.DEFAULT_LEDGER

def resolve_agent_cli() -> Path:
    import os
    import sys
    explicit = os.environ.get("MYCMUX_AGENT_CLI")
    candidates = [Path(explicit).expanduser()] if explicit else []
    candidates.append(Path.home() / ".mycmux" / "bin" / "mycmux_agent_cli.py")
    candidates.extend(parent / "scripts" / "mycmux_agent_cli.py"
                      for parent in Path(__file__).resolve().parents)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    print("mycmux agent CLI not found. From the mycmux checkout run: "
          "python scripts/install_claude_skills.py install", file=sys.stderr)
    raise SystemExit(7)

CLOSE_CLI = resolve_agent_cli()
HEADING_RE = re.compile(r"^##\s+自動検収")


@dataclass
class CommandResult:
    command: str
    exit_code: int | str
    output: str = ""

    @property
    def passed(self) -> bool:
        return self.exit_code == 0


@dataclass
class Gate:
    commands: list[str]
    auto_close: bool = False


def local_timestamp() -> str:
    return datetime.now().isoformat(timespec="seconds")


def select_dispatch(
    ledger: Path, slug: str, spawn_ts: str | None = None
) -> tuple[Dispatch | None, str]:
    """撃ってよい dispatch を1件だけ確定する (曖昧なら撃たない)."""
    matches = find_dispatches(load_dispatches(ledger), slug, spawn_ts)
    if not matches:
        return None, f"slug is missing from ledger: {slug}"
    active = [dispatch for dispatch in matches if dispatch.status not in dispatch_ledger.INACTIVE_STATUSES]
    if not active:
        statuses = ", ".join(sorted({dispatch.status for dispatch in matches}))
        return None, f"dispatch is already closed (status={statuses}): {slug}"
    if len(active) > 1:
        spawn_list = ", ".join(dispatch.spawn_ts for dispatch in active)
        return None, (
            f"multiple active dispatches share this slug: {slug} "
            f"(spawn_ts: {spawn_list}) — pass --spawn-ts"
        )
    return active[0], ""


def parse_gate(spec_path: Path) -> Gate | None:
    lines = spec_path.read_text(encoding="utf-8-sig").splitlines()
    start = next((i for i, line in enumerate(lines) if HEADING_RE.match(line)), None)
    if start is None:
        return None
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break
    section = lines[start + 1 : end]
    auto_close = False
    for line in section:
        match = re.match(r"^\s*auto_close:\s*(true|false)\s*$", line, re.I)
        if match:
            auto_close = match.group(1).lower() == "true"
    fence_start = next(
        (i for i, line in enumerate(section) if line.strip() == "```verify"), None
    )
    if fence_start is None:
        return None
    commands: list[str] = []
    for line in section[fence_start + 1 :]:
        if line.strip() == "```":
            break
        command = line.strip()
        if command and not command.startswith("#"):
            commands.append(command)
    return Gate(commands, auto_close) if commands else None


def run_gate(gate: Gate, cwd: Path) -> list[CommandResult]:
    results: list[CommandResult] = []
    output_encoding = locale.getpreferredencoding(False)
    for command in gate.commands:
        try:
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-Command", command],
                cwd=cwd,
                capture_output=True,
                text=True,
                encoding=output_encoding,
                errors="replace",
                timeout=120,
                check=False,
            )
            output = (proc.stdout or "") + (proc.stderr or "")
            results.append(CommandResult(command, proc.returncode, output))
        except subprocess.TimeoutExpired as exc:
            stdout = (
                (exc.stdout or b"").decode(output_encoding, "replace")
                if isinstance(exc.stdout, bytes)
                else (exc.stdout or "")
            )
            stderr = (
                (exc.stderr or b"").decode(output_encoding, "replace")
                if isinstance(exc.stderr, bytes)
                else (exc.stderr or "")
            )
            results.append(CommandResult(command, "TIMEOUT", stdout + stderr))
        except OSError as exc:
            results.append(CommandResult(command, "ERROR", str(exc)))
    return results


def close_tab(session_id: str) -> str | None:
    try:
        proc = subprocess.run(
            [sys.executable, str(CLOSE_CLI), "close-tab", "--session", session_id],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=45,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return str(exc)
    if proc.returncode == 0:
        return None
    return ((proc.stdout or "") + (proc.stderr or "")).strip() or f"exit {proc.returncode}"


def write_verdict(
    path: Path, verdict: str, timestamp: str, results: list[CommandResult]
) -> None:
    lines = ["# Dispatch verdict", "", f"- Verdict: {verdict}", f"- Timestamp: {timestamp}"]
    if results:
        lines.extend(["", "## Command results"])
    for result in results:
        lines.extend(["", f"- Command: `{result.command}`", f"- Exit code: {result.exit_code}"])
        if not result.passed:
            snippet = result.output[:400].replace("```", "` ` `")
            lines.extend(["- Failure output:", "", "```text", snippet, "```"])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def finish(
    dispatch: Dispatch,
    dispatch_dir: Path,
    ledger: Path,
    label: str,
    exit_code: int,
    results: list[CommandResult] | None = None,
    ledger_fields: dict[str, object] | None = None,
) -> int:
    timestamp = local_timestamp()
    write_verdict(dispatch_dir / "VERDICT.md", label, timestamp, results or [])
    if ledger_fields is not None:
        fields = dict(ledger_fields)
        status = fields.pop("status", None)
        try:
            dispatch_ledger.update_record(
                ledger,
                slug=dispatch.slug,
                spawn_ts=dispatch.spawn_ts,
                tab_session_id=dispatch.tab_session_id,
                status=str(status) if status is not None else None,
                ledger_ts=timestamp,
                **fields,
            )
        except ValueError as exc:
            print(f"LEDGER-WRITE-SKIPPED: {exc}", flush=True)
    print(f"VERDICT {label}", flush=True)
    return exit_code


def positive_number(value: str) -> float:
    number = float(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("value must be greater than zero")
    return number


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slug", required=True)
    parser.add_argument("--spawn-ts", help="同一 slug が複数あるときの特定用")
    parser.add_argument("--timeout-min", type=positive_number, default=180.0)
    parser.add_argument("--stall-exit-min", type=positive_number, default=45.0)
    parser.add_argument("--poll-sec", type=positive_number, default=20.0)
    parser.add_argument("--legacy-stall-exit", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def ensure_guard():
    from dispatch_guard import ensure
    return ensure()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    ledger = Path(os.environ.get("DISPATCH_LEDGER", str(DEFAULT_LEDGER))).expanduser()
    if not ledger.is_file():
        print(f"CONFIG-ERROR: ledger is missing: {ledger}")
        return 3
    record, error = select_dispatch(ledger, args.slug, args.spawn_ts)
    if record is None:
        print(f"CONFIG-ERROR: {error}")
        return 3
    missing = [name for name in ("dir", "cwd") if not record.get(name)]
    if not record.tab_session_id:
        missing.append("tab_session_id")
    if missing:
        print(f"CONFIG-ERROR: required field is missing: {', '.join(missing)}")
        return 3

    dispatch_dir = Path(str(record.get("dir")))
    cwd = Path(str(record.get("cwd")))
    spec_path = dispatch_dir / "spec.md"
    if not dispatch_dir.is_dir():
        print(f"CONFIG-ERROR: dispatch dir is missing: {dispatch_dir}")
        return 3
    if not spec_path.is_file():
        print(f"CONFIG-ERROR: spec is missing: {spec_path}")
        return 3
    if not cwd.is_dir():
        print(f"CONFIG-ERROR: cwd is missing: {cwd}")
        return 3

    gate = parse_gate(spec_path)
    done_path = dispatch_dir / "DONE.md"
    start = time.monotonic()
    no_log_since: float | None = None
    polls = 0
    handed_to_guard = False
    while True:
        elapsed_min = (time.monotonic() - start) / 60.0
        if done_path.is_file():
            if gate is None:
                label = f"DONE-NEEDS-REVIEW (no machine gate) slug={args.slug}"
                row = {"status": "done", "verify": "auto-fail"}
                return finish(record, dispatch_dir, ledger, label, 1, ledger_fields=row)
            results = run_gate(gate, cwd)
            failed = [result.command for result in results if not result.passed]
            if failed:
                joined = "; ".join(failed)
                label = f"DONE-NEEDS-REVIEW slug={args.slug} failed={joined}"
                row = {"status": "done", "verify": "auto-fail"}
                return finish(record, dispatch_dir, ledger, label, 1, results, row)
            if not gate.auto_close or args.dry_run:
                label = f"DONE-VERIFIED-KEEP slug={args.slug}"
                row = {"status": "done", "verify": "auto-pass"}
                return finish(record, dispatch_dir, ledger, label, 0, results, row)
            # close-tab はこの dispatch の行が持つ tab_session_id のみ (マージ由来を使わない)
            close_error = close_tab(str(record.tab_session_id))
            if close_error is not None:
                short_error = close_error[:400].replace("\r", " ").replace("\n", " ")
                label = (
                    f"DONE-VERIFIED-CLOSE-FAILED slug={args.slug} "
                    f"(close-tab FAILED: {short_error})"
                )
                ledger_row = {
                    "status": dispatch_ledger.STATUS_CLOSE_FAILED,
                    "verify": "auto-pass",
                    "close_error": close_error[:400],
                }
                return finish(record, dispatch_dir, ledger, label, 1, results, ledger_row)
            else:
                label = f"DONE-VERIFIED-CLOSED slug={args.slug}"
                ledger_row = {"status": "closed", "verify": "auto-pass"}
            return finish(record, dispatch_dir, ledger, label, 0, results, ledger_row)

        activity = dispatch_activity(record, ledger=ledger)
        log_age = activity.age_min if activity.state in ("RUNNING", "STALL") else -1.0
        log_name = activity.log_name
        now = time.monotonic()
        stalled = log_age >= args.stall_exit_min
        if log_age < 0:
            no_log_since = no_log_since or now
            no_log_age = (now - no_log_since) / 60.0
            stalled = no_log_age >= 5.0 + args.stall_exit_min
            state = activity.state
        else:
            no_log_since = None
            state = "RUNNING"
        if stalled:
            if args.legacy_stall_exit:
                return finish(record, dispatch_dir, ledger, f"STALL slug={args.slug}", 2)
            if not handed_to_guard:
                dispatch_ledger.update_record(ledger, slug=record.slug,
                    spawn_ts=record.spawn_ts, tab_session_id=record.tab_session_id,
                    event="stall-handed-to-guard")
                ensure_guard()
                handed_to_guard = True
        current = [d for d in load_dispatches(ledger)
                   if d.slug == record.slug and d.tab_session_id == record.tab_session_id]
        if current and current[-1].status == "lost":
            return finish(record, dispatch_dir, ledger, f"TAB-GONE slug={args.slug}", 2)
        if elapsed_min >= args.timeout_min:
            return finish(record, dispatch_dir, ledger, f"TIMEOUT slug={args.slug}", 2)
        polls += 1
        if polls % 10 == 0:
            print(
                f"{state} slug={args.slug} elapsed_min={elapsed_min:.1f} "
                f"log={log_name or '-'}",
                flush=True,
            )
        time.sleep(args.poll_sec)


if __name__ == "__main__":
    for output_stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(output_stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
