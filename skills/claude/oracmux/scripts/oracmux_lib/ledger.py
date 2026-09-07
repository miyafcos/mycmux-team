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


def recent(limit: int = 20, path: Path | None = None) -> list[dict[str, object]]:
    lanes = load(path)
    return lanes[-limit:] if limit > 0 else lanes
