"""dispatch_status.py — session-dispatch 台帳と実体 (DONE.md / 子セッションJSONL) の突合 (B2).

usage: python dispatch_status.py [--all] [--no-pin] [--json]

活動判定は **pin した子セッションのログ1本** だけを見る。
「cwd 内の最新 jsonl」での代用は廃止した — 同一 cwd の親・兄弟・無関係セッションの
活動を子の活動と取り違え、closed 済み dispatch が RUNNING に見える事故の原因だったため。

子セッション ID の取得順:
  ① 台帳の `claude_session_id`
  ② spawn 応答の `tab_id` (mycmux の handoff spawn では tab id = claude session id)
  ③ spawn 時刻の直後に初出した jsonl が **1本だけ** ならそれを pin して台帳へ追記
  ④ どれも不可なら UNKNOWN (代用しない)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import dispatch_ledger
from dispatch_ledger import DEFAULT_LEDGER, Dispatch

PROJECTS = Path.home() / ".claude" / "projects"
STALL_MINUTES = 5.0
#: pin 候補として認める「spawn 直後」の幅
PIN_WINDOW_BEFORE_SEC = 60.0
PIN_WINDOW_AFTER_MIN = 20.0

STATE_RUNNING = "RUNNING"
STATE_NO_LOG = "NO-LOG"
STATE_UNKNOWN = "UNKNOWN"


def slugify_cwd(cwd: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def project_dir(cwd: str) -> Path | None:
    if not cwd:
        return None
    directory = PROJECTS / slugify_cwd(cwd)
    return directory if directory.is_dir() else None


def parse_ts(value: str | None) -> float | None:
    """台帳の ts / spawn_ts を epoch 秒へ (naive はローカル時刻とみなす)."""
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return None


@dataclass
class Activity:
    state: str
    log_name: str = ""
    age_min: float = -1.0
    reason: str = ""

    def label(self) -> str:
        if self.state == "STALL":
            return f"STALL({self.age_min:.0f}m)"
        return self.state


def pin_candidates(cwd: str, spawn_ts: str | None) -> list[Path]:
    """spawn 直後に初出した子セッションログの候補を返す."""
    directory = project_dir(cwd)
    spawn_epoch = parse_ts(spawn_ts)
    if directory is None or spawn_epoch is None:
        return []
    lower = spawn_epoch - PIN_WINDOW_BEFORE_SEC
    upper = spawn_epoch + PIN_WINDOW_AFTER_MIN * 60.0
    candidates = [
        path
        for path in sorted(directory.glob("*.jsonl"))
        if lower <= path.stat().st_ctime <= upper
    ]
    return candidates


def resolve_child_session_id(
    dispatch: Dispatch, *, pin: bool = True, ledger: Path = DEFAULT_LEDGER
) -> tuple[str | None, str]:
    """子の Claude セッション UUID を決める。戻り値 = (session_id, 取得根拠)."""
    existing = dispatch.get("claude_session_id")
    if isinstance(existing, str) and existing:
        return existing, "ledger"

    cwd = str(dispatch.get("cwd") or "")
    directory = project_dir(cwd)
    tab_id = dispatch.get("tab_id")
    if isinstance(tab_id, str) and tab_id and directory is not None:
        if (directory / f"{tab_id}.jsonl").is_file():
            _record_pin(dispatch, tab_id, "tab_id", pin=pin, ledger=ledger)
            return tab_id, "tab_id"

    candidates = pin_candidates(cwd, dispatch.spawn_ts)
    if len(candidates) == 1:
        session_id = candidates[0].stem
        _record_pin(dispatch, session_id, "pinned", pin=pin, ledger=ledger)
        return session_id, "pinned"
    if len(candidates) > 1:
        return None, f"ambiguous({len(candidates)})"
    return None, "unresolved"


def _record_pin(
    dispatch: Dispatch, session_id: str, source: str, *, pin: bool, ledger: Path
) -> None:
    """pin は初回のみ台帳へ書く (以後は台帳の値が固定値として勝つ)."""
    if not pin or dispatch.get("claude_session_id"):
        return
    if dispatch.closed:
        return
    try:
        dispatch_ledger.update_record(
            ledger,
            slug=dispatch.slug,
            spawn_ts=dispatch.spawn_ts,
            tab_session_id=dispatch.tab_session_id,
            claude_session_id=session_id,
            event=f"pin-session-log:{source}",
        )
    except (ValueError, OSError):
        return
    dispatch.data["claude_session_id"] = session_id


def dispatch_activity(
    dispatch: Dispatch, *, pin: bool = True, ledger: Path = DEFAULT_LEDGER
) -> Activity:
    """pin 済み子セッションログ 1 本だけで活動状態を判定する."""
    cwd = str(dispatch.get("cwd") or "")
    directory = project_dir(cwd)
    if directory is None:
        return Activity(STATE_UNKNOWN, reason="no-project-dir")
    session_id, source = resolve_child_session_id(dispatch, pin=pin, ledger=ledger)
    if not session_id:
        return Activity(STATE_UNKNOWN, reason=source)
    log_path = directory / f"{session_id}.jsonl"
    if not log_path.is_file():
        return Activity(STATE_NO_LOG, log_name=log_path.name, reason=source)
    mtime = log_path.stat().st_mtime
    spawn_epoch = parse_ts(dispatch.spawn_ts)
    if spawn_epoch is not None and mtime < spawn_epoch - PIN_WINDOW_BEFORE_SEC:
        # spawn より前で止まっているログは、この子のものではない
        return Activity(STATE_NO_LOG, log_name=log_path.name, reason="pre-spawn-mtime")
    age = (time.time() - mtime) / 60.0
    if age <= STALL_MINUTES:
        return Activity(STATE_RUNNING, log_path.name, age, source)
    return Activity("STALL", log_path.name, age, source)


def live_state(
    dispatch: Dispatch, *, pin: bool = True, ledger: Path = DEFAULT_LEDGER
) -> str:
    if dispatch.closed:
        return "CLOSED"
    directory = dispatch.get("dir")
    if directory and (Path(str(directory)) / "DONE.md").is_file():
        return "DONE(要検収)" if dispatch.status in dispatch_ledger.ACTIVE_STATUSES else "DONE"
    return dispatch_activity(dispatch, pin=pin, ledger=ledger).label()


def build_rows(
    dispatches: list[Dispatch], *, show_all: bool, pin: bool, ledger: Path
) -> list[tuple[str, ...]]:
    rows: list[tuple[str, ...]] = []
    for dispatch in sorted(dispatches, key=lambda d: d.spawn_ts):
        if not show_all and dispatch.closed:
            continue
        activity = (
            Activity("CLOSED")
            if dispatch.closed
            else dispatch_activity(dispatch, pin=pin, ledger=ledger)
        )
        rows.append(
            (
                dispatch.slug,
                dispatch.spawn_ts[:19] or "-",
                dispatch.status or "?",
                live_state(dispatch, pin=pin, ledger=ledger),
                (dispatch.tab_session_id or "")[-24:],
                activity.log_name or (activity.reason if activity.reason else "-"),
            )
        )
    return rows


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true", help="クローズ済みも表示")
    parser.add_argument("--no-pin", action="store_true", help="台帳へ pin を書かない")
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    ledger = Path(args.ledger)
    result = dispatch_ledger.load_result(ledger)
    if not result.dispatches:
        print(f"台帳が空です: {ledger}")
        return 0
    if result.unparsable_lines:
        print(
            f"WARN: パース不能行 {len(result.unparsable_lines)} 件 "
            f"(行 {result.unparsable_lines}) — `dispatch_ledger.py repair` を検討",
            file=sys.stderr,
        )
    rows = build_rows(
        result.dispatches, show_all=args.all, pin=not args.no_pin, ledger=ledger
    )
    if args.as_json:
        header = ("slug", "spawn_ts", "ledger", "live", "tab_session", "session_log")
        print(json.dumps([dict(zip(header, row)) for row in rows], ensure_ascii=False, indent=2))
        return 0
    if not rows:
        print("open な dispatch はありません (--all で全件表示)")
        return 0
    header = ("slug", "spawn_ts", "ledger", "live", "tab_session", "session_log")
    widths = [max(len(str(row[i])) for row in [header, *rows]) for i in range(len(header))]
    for row in [header, *rows]:
        print("  ".join(str(cell).ljust(widths[index]) for index, cell in enumerate(row)))
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
