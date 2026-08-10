"""dispatch_status.py — session-dispatch 台帳と実体 (DONE.md / ASK.md / セッションJSONL増分) の突合.

usage: python dispatch_status.py [--all]
"""
import json
import re
import sys
import time
from pathlib import Path

LEDGER = Path.home() / ".claude" / "dispatch" / "ledger.jsonl"
PROJECTS = Path.home() / ".claude" / "projects"
STALL_MINUTES = 5.0


def slugify_cwd(cwd: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def load_entries() -> dict[str, dict]:
    """slug -> merged latest record (append-only ledger: last wins per key)."""
    entries: dict[str, dict] = {}
    if not LEDGER.exists():
        return entries
    for line in LEDGER.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        slug = rec.get("slug")
        if slug:
            entries[slug] = {**entries.get(slug, {}), **rec}
    return entries


def session_activity(cwd: str) -> tuple[str, float]:
    """Return (newest session log name, minutes since its last write) for a cwd."""
    if not cwd:
        return "", -1.0
    proj = PROJECTS / slugify_cwd(cwd)
    if not proj.is_dir():
        return "", -1.0
    best_mtime = -1.0
    best_name = ""
    for f in proj.glob("*.jsonl"):
        m = f.stat().st_mtime
        if m > best_mtime:
            best_mtime = m
            best_name = f.name
    if not best_name:
        return "", -1.0
    return best_name, (time.time() - best_mtime) / 60.0


def live_state(rec: dict) -> str:
    if rec.get("status") == "closed":
        return "CLOSED"
    d = rec.get("dir", "")
    if d and (Path(d) / "DONE.md").exists():
        return "DONE(要検収)" if rec.get("status") == "open" else "DONE"
    if d and (Path(d) / "ASK.md").exists():
        return "ASK(判断待ち)"
    _, age = session_activity(rec.get("cwd", ""))
    if age < 0:
        return "NO-LOG"
    if age <= STALL_MINUTES:
        return "RUNNING"
    return f"STALL({age:.0f}m)"


def main() -> None:
    show_all = "--all" in sys.argv
    entries = load_entries()
    if not entries:
        print(f"台帳が空です: {LEDGER}")
        return
    header = ("slug", "ledger", "live", "tab_session", "session_log")
    rows: list[tuple[str, ...]] = []
    for slug, rec in sorted(entries.items(), key=lambda kv: kv[1].get("ts", "")):
        status = rec.get("status", "?")
        if not show_all and status in ("closed", "abandoned"):
            continue
        log_name, _ = session_activity(rec.get("cwd", ""))
        rows.append((slug, status, live_state(rec),
                     (rec.get("tab_session_id") or "")[:24], log_name))
    if not rows:
        print("open な dispatch はありません (--all で全件表示)")
        return
    widths = [max(len(str(r[i])) for r in rows + [header]) for i in range(len(header))]
    for r in [header] + rows:
        print("  ".join(str(c).ljust(widths[i]) for i, c in enumerate(r)))


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        reconf = getattr(stream, "reconfigure", None)
        if reconf is not None:
            reconf(encoding="utf-8", errors="replace")
    main()
