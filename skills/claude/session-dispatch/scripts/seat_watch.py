r"""Watch dispatch DONE headings and ready-file metadata; Python 3.10 stdlib only.

python -X utf8 seat_watch.py status --seat 261009-sample-a --seat 261009-sample-b --seat 261009-sample-c
python -X utf8 seat_watch.py wait --seat 261009-sample-a --watch "~\reports\日本語 フォルダ\*_ready.json"
python -X utf8 seat_watch.py wait --seat 261009-sample-a --state "~\.claude\dispatch\<slug>\watch_state.json"

Repeat the third command after it exits: the saved state becomes its baseline.
Defaults: --timeout-min 180 (fractions allowed), --poll-sec 20. Exit codes:
0 = status/CHANGED, 2 = input or I/O error, 3 = TIMEOUT. Output is buffered.
State is atomically replaced outside the watched seats/files; its parent must exist.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import fnmatch
from functools import lru_cache
import glob
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time

DISPATCH_ROOT = Path.home() / ".claude" / "dispatch"
LATEST_MARKER = "(これが最新"


def fs_path(value: str | Path) -> Path:
    """Use extended Windows paths, including UNC, without changing display paths."""
    value = os.path.abspath(os.path.expanduser(str(value)))
    if os.name == "nt" and not value.startswith("\\\\?\\"):
        value = "\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value
    return Path(value)


def display_path(value: str | Path) -> str:
    value = str(value)
    if value.startswith("\\\\?\\UNC\\"):
        return "\\\\" + value[8:]
    return value[4:] if value.startswith("\\\\?\\") else value


def one_line(value: object) -> str:
    return " ".join(str(value).splitlines())


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(message)


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = Parser(description="Watch dispatch DONE.md and ready files.")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("status", "wait"):
        sub = commands.add_parser(command)
        sub.add_argument("--seat", action="append", required=True)
        sub.add_argument("--watch", action="append", default=[])
        sub.add_argument("--state")
        if command == "status":
            sub.add_argument("--json", action="store_true", dest="as_json")
        else:
            sub.add_argument("--timeout-min", type=float, default=180)
            sub.add_argument("--poll-sec", type=float, default=20)
    args = parser.parse_args(argv)
    if args.command == "wait":
        if not math.isfinite(args.timeout_min) or args.timeout_min < 0:
            raise ValueError("--timeout-min must be finite and >= 0")
        if not math.isfinite(args.poll_sec) or args.poll_sec <= 0:
            raise ValueError("--poll-sec must be finite and > 0")
    return args


def resolve_seats(values: list[str]) -> list[Path]:
    seats = []
    for value in values:
        path = Path(value).expanduser()
        path = fs_path(path if path.is_absolute() else DISPATCH_ROOT / path).resolve()
        if not path.is_dir():
            raise ValueError(f"seat folder does not exist: {value}")
        if path not in seats:
            seats.append(path)
    return seats


def stamp(row: dict | None) -> tuple | None:
    return None if row is None else (row["exists"], row["mtime_ns"], row["bytes"])


def seat_state(path: Path, previous: dict | None) -> dict:
    empty = {"name": path.name, "exists": False, "mtime_ns": None, "bytes": 0, "headings": []}
    try:
        done = path / "DONE.md"
        info = done.stat()
        row = dict(empty, exists=True, mtime_ns=info.st_mtime_ns, bytes=info.st_size)
        if stamp(row) == stamp(previous):
            return previous
        with done.open(encoding="utf-8-sig", errors="replace") as handle:
            for line in handle:
                if line.startswith("## "):
                    row["headings"].append(line[3:].rstrip("\r\n"))
        return row
    except FileNotFoundError:
        return empty


def watch_state(pattern: str) -> dict:
    files = {}
    for value in glob.iglob(str(fs_path(pattern)), recursive=True):
        path = Path(value)
        try:
            if path.is_file():
                info = path.stat()
                files[display_path(path)] = {"mtime_ns": info.st_mtime_ns, "bytes": info.st_size}
        except FileNotFoundError:
            continue
    return files


def snapshot(seats: list[Path], patterns: list[str], previous: dict | None = None) -> dict:
    cache = (previous or {}).get("seats", {})
    return {"version": 1,
            "seats": {display_path(p): seat_state(p, cache.get(display_path(p))) for p in seats},
            "watches": {p: watch_state(p) for p in patterns}}


def load_state(path: Path | None) -> dict | None:
    if path is None or not path.exists():
        return None
    with path.open(encoding="utf-8-sig") as handle:
        data = json.load(handle)
    valid = isinstance(data, dict) and data.get("version") == 1
    valid = valid and all(isinstance(data.get(k), dict) for k in ("seats", "watches"))
    if valid:
        for row in data["seats"].values():
            valid = valid and isinstance(row, dict) and isinstance(row.get("exists"), bool)
            valid = valid and isinstance(row.get("bytes"), int) and isinstance(row.get("headings"), list)
            valid = valid and (row.get("mtime_ns") is None or isinstance(row.get("mtime_ns"), int))
            valid = valid and all(isinstance(h, str) for h in row.get("headings", []))
        for files in data["watches"].values():
            valid = valid and isinstance(files, dict)
            if not valid:
                break
            valid = all(isinstance(r, dict) and isinstance(r.get("mtime_ns"), int)
                        and isinstance(r.get("bytes"), int) for r in files.values())
    if not valid:
        raise ValueError(f"invalid state schema: {display_path(path)}")
    return data


def matches_glob(path: Path, pattern: str) -> bool:
    """Match a planned state path without creating it (glob '*' stays in one directory)."""
    names = Path(os.path.normcase(display_path(path))).parts
    parts = Path(os.path.normcase(display_path(fs_path(pattern)))).parts

    @lru_cache(maxsize=None)
    def match(i: int, j: int) -> bool:
        if j == len(parts):
            return i == len(names)
        if parts[j] == "**":
            return match(i, j + 1) or (i < len(names) and not names[i].startswith(".") and match(i + 1, j))
        return (i < len(names) and (not names[i].startswith(".") or parts[j].startswith("."))
                and fnmatch.fnmatchcase(names[i], parts[j]) and match(i + 1, j + 1))

    return match(0, 0)


def check_state_target(path: Path | None, seats: list[Path], patterns: list[str]) -> None:
    if path is None:
        return
    if any(path == seat or seat in path.parents for seat in seats):
        raise ValueError("--state must be outside watched seat folders")
    if any(matches_glob(path, pattern) for pattern in patterns):
        raise ValueError("--state must be outside watched files/globs")
    # Also protect existing watched aliases (symlinks) of the state destination.
    for pattern in patterns:
        if any(fs_path(p).resolve() == path
               for p in glob.iglob(str(fs_path(pattern)), recursive=True)):
            raise ValueError("--state must not overwrite a watched file")


def save_state(path: Path | None, data: dict) -> None:
    if path is None:
        return
    text = json.dumps(data, ensure_ascii=True, separators=(",", ":")) + "\n"
    with tempfile.TemporaryDirectory(dir=path.parent, prefix=".seat-watch-") as directory:
        temporary = Path(directory) / "state.json"
        with temporary.open("w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        assert temporary.read_text(encoding="utf-8") == text and "\ufffd" not in text
        os.replace(temporary, path)


def changes(current: dict, previous: dict | None) -> tuple[list[str], list[str]]:
    previous = previous or {"seats": {}, "watches": {}}
    seats = [key for key, row in current["seats"].items()
             if stamp(row) != stamp(previous["seats"].get(key))]
    watches = [key for key, files in current["watches"].items()
               if files != previous["watches"].get(key)]
    return seats, watches


def clock_label(mtime_ns: int | None) -> str:
    return "-" if mtime_ns is None else datetime.fromtimestamp(mtime_ns / 1e9).strftime("%m/%d %H:%M")


def status_rows(current: dict, previous: dict | None, mark: bool) -> dict:
    changed_seats, changed_watches = changes(current, previous) if mark else ([], [])
    seats, watches = [], []
    for key, row in current["seats"].items():
        headings = row["headings"]
        latest = next((h for h in headings if LATEST_MARKER in h), headings[-1] if headings else "")
        age = None if row["mtime_ns"] is None else round(max(0, (time.time() - row["mtime_ns"] / 1e9) / 60), 1)
        seats.append({"name": row["name"], "path": key, "done": row["exists"],
                      "mtime": clock_label(row["mtime_ns"]), "age_min": age, "bytes": row["bytes"],
                      "heading_count": len(headings), "latest_heading": latest[:60],
                      "changed": key in changed_seats})
    for pattern, files in current["watches"].items():
        latest = max(files, key=lambda p: (files[p]["mtime_ns"], p)) if files else None
        watches.append({"pattern": pattern, "count": len(files),
                        "mtime": clock_label(files[latest]["mtime_ns"] if latest else None),
                        "latest_file": Path(latest).name if latest else "",
                        "changed": pattern in changed_watches})
    return {"seats": seats, "watches": watches}


def status_lines(rows: dict) -> list[str]:
    result = []
    for row in rows["seats"]:
        age = "-" if row["age_min"] is None else f'{row["age_min"]:.1f}m'
        result.append(("* " if row["changed"] else "") + one_line(
            f'{row["name"]} DONE={"YES" if row["done"] else "NO"} mtime={row["mtime"]} '
            f'age={age} bytes={row["bytes"]} headings={row["heading_count"]} latest={row["latest_heading"] or "-"}'))
    for row in rows["watches"]:
        result.append(("* " if row["changed"] else "") + one_line(
            f'WATCH {row["pattern"]} count={row["count"]} mtime={row["mtime"]} latest={row["latest_file"] or "-"}'))
    return result


def changed_lines(current: dict, previous: dict, changed: tuple[list[str], list[str]]) -> list[str]:
    result = ["CHANGED"]
    for key in changed[0]:
        row = current["seats"][key]
        old = Counter(previous["seats"].get(key, {}).get("headings", []))
        added = []
        for heading in row["headings"]:
            if old[heading]:
                old[heading] -= 1
            else:
                added.append(heading[:60])
                if len(added) == 5:
                    break
        result.append(one_line(f'{row["name"]} DONE={"YES" if row["exists"] else "NO"} '
                               f'new ##: {" | ".join(added) if added else "-"}'))
    for pattern in changed[1]:
        before = previous["watches"].get(pattern, {})
        after = current["watches"][pattern]
        names = []
        affected = sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p))
        for path in affected[:20]:
            tag = "+" if path not in before else "-" if path not in after else "~"
            names.append(tag + Path(path).name)
        suffix = f" (+{len(affected) - 20} more)" if len(affected) > 20 else ""
        result.append(one_line(f'WATCH {pattern}: {" | ".join(names) or "-"}{suffix}'))
    return result


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        seats = resolve_seats(args.seat)  # Validate every seat before reading DONE/state/globs.
        state_path = fs_path(args.state).resolve() if args.state else None
        check_state_target(state_path, seats, args.watch)
        previous = load_state(state_path)
        current = snapshot(seats, args.watch)
        if args.command == "status":
            rows = status_rows(current, previous, state_path is not None)
            lines = [json.dumps(rows, ensure_ascii=False, separators=(",", ":"))] if args.as_json else status_lines(rows)
            code = 0
        else:
            baseline = previous if previous is not None else current
            deadline = time.monotonic() + args.timeout_min * 60
            while True:
                changed = changes(current, baseline)
                if any(changed):
                    lines, code = changed_lines(current, baseline, changed), 0
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    lines, code = ["TIMEOUT", *status_lines(status_rows(current, None, False))], 3
                    break
                time.sleep(min(args.poll_sec, remaining))
                current = snapshot(seats, args.watch, current)
        save_state(state_path, current)
        print("\n".join(lines))
        return code
    except (OSError, ValueError) as error:
        print("ERROR: " + one_line(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
