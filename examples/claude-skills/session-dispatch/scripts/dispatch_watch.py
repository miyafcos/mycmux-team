"""Watch one session dispatch and verify its declared machine gate.

Requires env MYCMUX_AGENT_CLI = full path to mycmux's scripts/mycmux_agent_cli.py
(used for auto-closing the tab after the gate passes).
"""

from __future__ import annotations

import argparse
import json
import locale
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from dispatch_status import session_activity


DEFAULT_LEDGER = Path.home() / ".claude" / "dispatch" / "ledger.jsonl"
HEADING_RE = re.compile(r"^##\s+自動検収")


def close_cli_path() -> Path | None:
    raw = os.environ.get("MYCMUX_AGENT_CLI", "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    return path if path.is_file() else None


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


def load_entries(path: Path) -> dict[str, dict[str, object]]:
    entries: dict[str, dict[str, object]] = {}
    if not path.is_file():
        return entries
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        try:
            record = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(record, dict):
            continue
        slug = record.get("slug")
        if isinstance(slug, str) and slug:
            entries[slug] = {**entries.get(slug, {}), **record}
    return entries


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


def shell_argv(command: str) -> list[str]:
    if sys.platform == "win32":
        return ["powershell", "-NoProfile", "-Command", command]
    return ["bash", "-lc", command]


def run_gate(gate: Gate, cwd: Path) -> list[CommandResult]:
    results: list[CommandResult] = []
    output_encoding = locale.getpreferredencoding(False)
    for command in gate.commands:
        try:
            proc = subprocess.run(
                shell_argv(command),
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
            stdout = (exc.stdout or b"").decode(output_encoding, "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            stderr = (exc.stderr or b"").decode(output_encoding, "replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
            results.append(CommandResult(command, "TIMEOUT", stdout + stderr))
        except OSError as exc:
            results.append(CommandResult(command, "ERROR", str(exc)))
    return results


def close_tab(session_id: str) -> str | None:
    cli = close_cli_path()
    if cli is None:
        return "MYCMUX_AGENT_CLI is not set or does not point to a file"
    try:
        proc = subprocess.run(
            [sys.executable, str(cli), "close-tab", "--session", session_id],
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


def append_ledger(path: Path, record: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="ascii", newline="") as stream:
        stream.write(json.dumps(record, ensure_ascii=True) + "\n")


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
    dispatch_dir: Path,
    ledger: Path,
    slug: str,
    label: str,
    exit_code: int,
    results: list[CommandResult] | None = None,
    ledger_record: dict[str, object] | None = None,
) -> int:
    timestamp = local_timestamp()
    write_verdict(dispatch_dir / "VERDICT.md", label, timestamp, results or [])
    if ledger_record is not None:
        append_ledger(ledger, {"ts": timestamp, "slug": slug, **ledger_record})
    print(f"VERDICT {label}", flush=True)
    return exit_code


def positive_number(value: str) -> float:
    number = float(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("value must be greater than zero")
    return number


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slug", required=True)
    parser.add_argument("--timeout-min", type=positive_number, default=180.0)
    parser.add_argument("--stall-exit-min", type=positive_number, default=45.0)
    parser.add_argument("--poll-sec", type=positive_number, default=20.0)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    ledger = Path(os.environ.get("DISPATCH_LEDGER", str(DEFAULT_LEDGER))).expanduser()
    if not ledger.is_file():
        print(f"CONFIG-ERROR: ledger is missing: {ledger}")
        return 3
    record = load_entries(ledger).get(args.slug)
    if record is None:
        print(f"CONFIG-ERROR: slug is missing from ledger: {args.slug}")
        return 3
    missing = [name for name in ("dir", "tab_session_id", "cwd") if not record.get(name)]
    if missing:
        print(f"CONFIG-ERROR: required field is missing: {', '.join(missing)}")
        return 3
    dispatch_dir = Path(str(record["dir"]))
    cwd = Path(str(record["cwd"]))
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
    ask_path = dispatch_dir / "ASK.md"
    start = time.monotonic()
    no_log_since: float | None = None
    polls = 0
    while True:
        elapsed_min = (time.monotonic() - start) / 60.0
        if done_path.is_file():
            if gate is None:
                label = f"DONE-NEEDS-REVIEW (no machine gate) slug={args.slug}"
                row = {"status": "done", "verify": "auto-fail"}
                return finish(dispatch_dir, ledger, args.slug, label, 1, ledger_record=row)
            results = run_gate(gate, cwd)
            failed = [result.command for result in results if not result.passed]
            if failed:
                joined = "; ".join(failed)
                label = f"DONE-NEEDS-REVIEW slug={args.slug} failed={joined}"
                row = {"status": "done", "verify": "auto-fail"}
                return finish(dispatch_dir, ledger, args.slug, label, 1, results, row)
            if not gate.auto_close or args.dry_run:
                label = f"DONE-VERIFIED-KEEP slug={args.slug}"
                row = {"status": "done", "verify": "auto-pass"}
                return finish(dispatch_dir, ledger, args.slug, label, 0, results, row)
            close_error = close_tab(str(record["tab_session_id"]))
            if close_error:
                short_error = close_error[:400].replace("\r", " ").replace("\n", " ")
                label = f"DONE-VERIFIED-CLOSED slug={args.slug} (close-tab FAILED: {short_error})"
                ledger_row = {"status": "closed", "verify": "auto-pass", "close_error": close_error[:400]}
            else:
                label = f"DONE-VERIFIED-CLOSED slug={args.slug}"
                ledger_row = {"status": "closed", "verify": "auto-pass"}
            return finish(dispatch_dir, ledger, args.slug, label, 0, results, ledger_row)

        # A child waiting on ASK.md is a legitimate pause, not a stall. Exit so the
        # parent gets notified; after answering, the parent re-launches this watcher.
        if ask_path.is_file():
            return finish(dispatch_dir, ledger, args.slug, f"ASK-WAITING slug={args.slug}", 2)

        log_name, log_age = session_activity(str(record["cwd"]))
        now = time.monotonic()
        # A log last written before this watcher started belongs to an older
        # session in the same cwd, not to the child we are watching.
        if log_age >= 0 and log_age > elapsed_min + 1.0:
            log_age = -1.0
            log_name = ""
        if log_age >= args.stall_exit_min:
            return finish(dispatch_dir, ledger, args.slug, f"STALL slug={args.slug}", 2)
        if log_age < 0:
            no_log_since = no_log_since or now
            no_log_age = (now - no_log_since) / 60.0
            if no_log_age >= 5.0 + args.stall_exit_min:
                return finish(dispatch_dir, ledger, args.slug, f"STALL slug={args.slug}", 2)
            state = "NO-LOG"
        else:
            no_log_since = None
            state = "RUNNING"
        if elapsed_min >= args.timeout_min:
            return finish(dispatch_dir, ledger, args.slug, f"TIMEOUT slug={args.slug}", 2)
        polls += 1
        if polls % 10 == 0:
            print(f"{state} slug={args.slug} elapsed_min={elapsed_min:.1f} log={log_name or '-'}", flush=True)
        time.sleep(args.poll_sec)


if __name__ == "__main__":
    for output_stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(output_stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
