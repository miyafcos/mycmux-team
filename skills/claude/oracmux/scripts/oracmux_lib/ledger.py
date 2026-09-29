"""Append-only JSONL ledger of consults.

One record per event; `run_id` + `engine` identify a lane. Reads merge the
records of a lane in file order, so an update is just another append (no
rewrite, no partial-write window). Output is ASCII-escaped: a ledger line
that reaches the terminal through a cp932 console must not turn into `?`.

Parallel appends (council lanes) are serialised with a lock file created
O_EXCL; a stale lock older than LOCK_STALE_SEC is broken.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from . import paths

LOCK_TIMEOUT_SEC = 10.0
LOCK_STALE_SEC = 60.0


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class _Lock:
    def __init__(self, target: Path) -> None:
        self.path = target.with_name(target.name + ".lock")
        self.fd: int | None = None

    def __enter__(self) -> "_Lock":
        deadline = time.monotonic() + LOCK_TIMEOUT_SEC
        while True:
            try:
                self.fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, str(os.getpid()).encode("ascii"))
                return self
            except FileExistsError:
                try:
                    age = time.time() - self.path.stat().st_mtime
                except OSError:
                    age = 0.0
                if age > LOCK_STALE_SEC:
                    try:
                        self.path.unlink()
                    except OSError:
                        pass
                    continue
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"ledger lock held too long: {self.path}")
                time.sleep(0.05)

    def __exit__(self, *_exc: object) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        try:
            self.path.unlink()
        except OSError:
            pass


def append(record: dict[str, object], path: Path | None = None) -> dict[str, object]:
    if not isinstance(record.get("run_id"), str) or not record["run_id"]:
        raise ValueError("ledger record needs run_id")
    if not isinstance(record.get("engine"), str) or not record["engine"]:
        raise ValueError("ledger record needs engine")
    target = path or paths.ledger_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    stamped = dict(record)
    stamped.setdefault("ts", _now())
    line = json.dumps(stamped, ensure_ascii=True, sort_keys=True)
    with _Lock(target):
        with target.open("a", encoding="ascii") as handle:
            handle.write(line + "\n")
            handle.flush()
    return stamped


def load_raw(path: Path | None = None) -> list[dict[str, object]]:
    target = path or paths.ledger_path()
    if not target.is_file():
        return []
    records: list[dict[str, object]] = []
    for line in target.read_text(encoding="ascii").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            records.append(item)
    return records


def load(path: Path | None = None) -> list[dict[str, object]]:
    """Merge records per (run_id, engine); later fields win. Order = last update."""
    merged: dict[tuple[str, str], dict[str, object]] = {}
    for item in load_raw(path):
        key = (str(item.get("run_id")), str(item.get("engine")))
        if key in merged:
            merged[key].update(item)
            merged[key]["last_ts"] = item.get("ts", merged[key].get("last_ts", ""))
        else:
            merged[key] = dict(item)
            merged[key]["last_ts"] = item.get("ts", "")
    return sorted(merged.values(), key=lambda lane: str(lane.get("last_ts", "")))


# A "started" row whose lane was killed never gets a terminal status, so the
# duplicate guard has to forget it eventually or that brief is blocked forever
# (found 2026-09-09 by killing a Deep Research consult). oracle calls the same
# idea --zombie-timeout. Deep Research legitimately runs for tens of minutes, so
# the cutoff is generous.
STALE_RUN_SEC = 90 * 60


def running_same_prompt(
    engine: str,
    digest: str,
    path: Path | None = None,
    *,
    stale_sec: float = STALE_RUN_SEC,
    now: datetime | None = None,
) -> dict[str, object] | None:
    """A lane for this engine that started on the same brief and never finished.

    oracle refuses to start a second identical prompt (`--force` overrides); this
    is the pane lane's equivalent, so a slow Pro consult is not accidentally
    started twice and billed twice. Rows older than `stale_sec` are ignored: a
    killed lane must not block its own brief forever.
    """
    started: dict[str, dict[str, object]] = {}
    for row in load_raw(path):
        run_id = str(row.get("run_id") or "")
        if not run_id or str(row.get("engine") or "") != engine:
            continue
        if row.get("status") == "started" and str(row.get("prompt_sha") or "") == digest:
            started[run_id] = row
        elif row.get("status") not in (None, "started"):
            started.pop(run_id, None)
    if not started:
        return None
    moment = now or datetime.now(timezone.utc)
    fresh = [row for row in started.values() if _age_seconds(row, moment) <= stale_sec]
    if not fresh:
        return None
    return sorted(fresh, key=lambda item: str(item.get("ts") or ""))[-1]


def _age_seconds(row: dict[str, object], moment: datetime) -> float:
    """Seconds since the row was written. An unreadable timestamp counts as
    stale, so a malformed line can never block a send."""
    raw = str(row.get("ts") or "")
    try:
        stamp = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return float("inf")
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return (moment - stamp).total_seconds()


def recent(limit: int = 20, path: Path | None = None) -> list[dict[str, object]]:
    lanes = load(path)
    return lanes[-limit:] if limit > 0 else lanes
