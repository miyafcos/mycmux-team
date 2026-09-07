"""dispatch_ledger.py — session-dispatch 台帳の唯一の読み書き経路 (B1).

台帳 = `~/.claude/dispatch/ledger.jsonl` (append-only / 1行1オブジェクト)。

設計の要点:
- 書き込みは必ず `append_record` / `update_record` を通す。snake キーのみ・`json.dumps`
  経由 (生バックスラッシュ混入の根絶)・`ensure_ascii=True` (cp932 環境での破損回避)。
- slug は `YYMMDD-<名前>` 形式必須。日付なし slug は別日に再利用され、旧 dispatch の
  tab_session_id へ close-tab / send を撃つ事故の温床になるため拒否する。
- 読み込みは **slug 後勝ちシャローマージを行わない**。dispatch の同一性は
  `(slug, tab_session_id)` で決まり、マージは同一 dispatch 内の行だけに閉じる。
  tab_session_id を持たない差分行 (status 更新等) は、同じ slug の直近 dispatch へ付く。
- 読み込みは camel/snake 両対応 (過去行の互換)。書き込みは snake のみ。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

DEFAULT_LEDGER = Path.home() / ".claude" / "dispatch" / "ledger.jsonl"
BACKUP_SUFFIX = ".bak-260813"
UNRECOVERABLE_NAME = "ledger.unrecoverable.jsonl"

# --- status 語彙 (現行台帳の実出現値 + guide 記載値を全数) ---------------------
STATUS_OPEN = "open"
STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_CLOSE_FAILED = "close_failed"
STATUS_CLOSED = "closed"
STATUS_DONE_VERIFIED_CLOSED = "done-verified-closed"
STATUS_ABANDONED = "abandoned"
STATUS_FALLBACK_INLINE = "fallback-inline"

#: 子タブが生きていて作業中
ACTIVE_STATUSES = frozenset({STATUS_OPEN, STATUS_RUNNING})
#: 子の完了自己申告のみ (タブはまだ生きている → 触ってよいが検収は親の義務)
DONE_STATUSES = frozenset({STATUS_DONE, STATUS_CLOSE_FAILED})
#: タブが既に無い / 二度と操作してはいけない集合 (fail-closed 判定の基準)
CLOSED_STATUSES = frozenset(
    {
        STATUS_CLOSED,
        STATUS_DONE_VERIFIED_CLOSED,
        STATUS_ABANDONED,
        STATUS_FALLBACK_INLINE,
    }
)
KNOWN_STATUSES = frozenset(ACTIVE_STATUSES | DONE_STATUSES | CLOSED_STATUSES)

SLUG_RE = re.compile(r"^\d{6}-[A-Za-z0-9][A-Za-z0-9._-]*$")
_DATED_PREFIX_RE = re.compile(r"^\d{6}-")
_CAMEL_RE = re.compile(r"(?<=[a-z0-9])([A-Z])")


def is_closed(status: str | None) -> bool:
    """クローズ済み集合の判定 (未知 status は「閉じていない」= 触ってはいけない側)。"""
    return bool(status) and str(status) in CLOSED_STATUSES


# --- キー正規化 ---------------------------------------------------------------


def snake_key(key: str) -> str:
    """camelCase なキー名を snake_case へ (既に snake ならそのまま)."""
    return _CAMEL_RE.sub(lambda m: "_" + m.group(1).lower(), key).lower()


def normalize_record(record: dict[str, Any]) -> dict[str, Any]:
    """1レコードのキーを snake へ正規化する (値は触らない)。

    同じ意味のキーが camel/snake 両方あるときは snake 側を優先する。
    """
    normalized: dict[str, Any] = {}
    for key, value in record.items():
        if not isinstance(key, str):
            continue
        target = snake_key(key)
        if target in normalized and key != target:
            continue
        normalized[target] = value
    return normalized


def normalize_spawn_record(record: dict[str, Any]) -> dict[str, Any]:
    """Normalize a new spawn row, rejecting conflicting aliases before writing."""
    normalized: dict[str, Any] = {}
    for key, value in record.items():
        if not isinstance(key, str):
            continue
        target = snake_key(key)
        if target in normalized and normalized[target] != value:
            raise ValueError(f"conflicting aliases for {target}")
        normalized[target] = value
    # Only new append rows receive the semantic mapping; historical reads do not.
    if "session_id" in normalized:
        session_id = normalized["session_id"]
        if "tab_session_id" in normalized and normalized["tab_session_id"] != session_id:
            raise ValueError("conflicting aliases for tab_session_id")
        normalized["tab_session_id"] = session_id
    return normalized


# --- 読み込み -----------------------------------------------------------------


@dataclass
class Dispatch:
    """1 dispatch = 1 タブ起動。行はこの単位でのみマージされる。"""

    slug: str
    spawn_ts: str
    tab_session_id: str | None
    data: dict[str, Any] = field(default_factory=dict)
    rows: list[dict[str, Any]] = field(default_factory=list)

    @property
    def status(self) -> str:
        return str(self.data.get("status") or "")

    @property
    def closed(self) -> bool:
        return is_closed(self.status)

    @property
    def dispatch_id(self) -> str:
        return f"{self.slug}@{self.spawn_ts}"

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)


@dataclass
class LoadResult:
    dispatches: list[Dispatch] = field(default_factory=list)
    orphan_rows: list[dict[str, Any]] = field(default_factory=list)
    unparsable_lines: list[int] = field(default_factory=list)


def _iter_raw_lines(path: Path) -> Iterable[tuple[int, str]]:
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    return [(i, line) for i, line in enumerate(text.splitlines(), 1) if line.strip()]


def load_result(path: Path | str = DEFAULT_LEDGER) -> LoadResult:
    """台帳を dispatch 単位で読む (後勝ちシャローマージなし)."""
    path = Path(path)
    result = LoadResult()
    by_tab: dict[tuple[str, str], Dispatch] = {}
    by_spawn: dict[tuple[str, str], Dispatch] = {}
    latest_for_slug: dict[str, Dispatch] = {}

    for lineno, raw in _iter_raw_lines(path):
        try:
            record = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            result.unparsable_lines.append(lineno)
            continue
        if not isinstance(record, dict):
            result.unparsable_lines.append(lineno)
            continue
        record = normalize_record(record)
        slug = record.get("slug")
        if not isinstance(slug, str) or not slug:
            result.orphan_rows.append(record)
            continue

        tab_session_id = record.get("tab_session_id")
        tab_session_id = tab_session_id if isinstance(tab_session_id, str) and tab_session_id else None
        spawn_ts = record.get("spawn_ts")
        spawn_ts = spawn_ts if isinstance(spawn_ts, str) and spawn_ts else None
        row_ts = str(record.get("ts") or record.get("dispatched_at") or "")

        target: Dispatch | None = None
        if tab_session_id is not None:
            target = by_tab.get((slug, tab_session_id))
        if target is None and spawn_ts is not None:
            target = by_spawn.get((slug, spawn_ts))
        # identity を何も名乗らない差分行 (status 更新等) だけが直近 dispatch へ付く。
        # tab_session_id / spawn_ts を名乗って不一致なら、それは別 dispatch。
        if target is None and tab_session_id is None and spawn_ts is None:
            target = latest_for_slug.get(slug)
        if target is None:
            target = Dispatch(
                slug=slug,
                spawn_ts=spawn_ts or row_ts,
                tab_session_id=tab_session_id,
            )
            result.dispatches.append(target)
            by_spawn[(slug, target.spawn_ts)] = target
            if tab_session_id is not None:
                by_tab[(slug, tab_session_id)] = target
        elif tab_session_id is not None and target.tab_session_id is None:
            # 後から spawn 応答が追記された (identity の初回確定)
            target.tab_session_id = tab_session_id
            by_tab[(slug, tab_session_id)] = target

        target.rows.append(record)
        target.data.update(record)
        # spawn_ts は最初の行の ts で固定する (差分行の ts で上書きしない)
        target.data["spawn_ts"] = target.spawn_ts
        latest_for_slug[slug] = target

    return result


def load_dispatches(path: Path | str = DEFAULT_LEDGER) -> list[Dispatch]:
    return load_result(path).dispatches


def find_dispatches(
    dispatches: Iterable[Dispatch], slug: str, spawn_ts: str | None = None
) -> list[Dispatch]:
    found = [d for d in dispatches if d.slug == slug]
    if spawn_ts:
        found = [d for d in found if d.spawn_ts == spawn_ts]
    return found


# --- 書き込み -----------------------------------------------------------------


def local_timestamp() -> str:
    return datetime.now().isoformat(timespec="seconds")


def validate_slug(slug: str) -> str:
    if not isinstance(slug, str) or not SLUG_RE.match(slug):
        raise ValueError(
            f"slug は YYMMDD-<名前> 形式 (ASCII) が必須です: {slug!r} "
            "— 日付なし slug は別日に再利用され誤爆の原因になります"
        )
    return slug


def validate_status(status: str | None) -> str | None:
    if status is None:
        return None
    if status not in KNOWN_STATUSES:
        raise ValueError(
            f"未知の status: {status!r} (既知: {', '.join(sorted(KNOWN_STATUSES))}) "
            "— 語彙を増やすときは dispatch_ledger.py の定数を先に更新すること"
        )
    return status


def _write_line(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=True, sort_keys=False)
    with path.open("a", encoding="ascii", newline="\n") as stream:
        stream.write(line + "\n")


def append_record(
    path: Path | str, record: dict[str, Any], *, ledger_ts: str | None = None
) -> dict[str, Any]:
    """spawn 直後の新規 dispatch 行を追記する。"""
    normalized = normalize_spawn_record(record)
    validate_slug(str(normalized.get("slug", "")))
    validate_status(normalized.get("status"))
    normalized.setdefault("ts", ledger_ts or local_timestamp())
    _write_line(Path(path), normalized)
    return normalized


def update_record(
    path: Path | str,
    *,
    slug: str,
    spawn_ts: str | None = None,
    tab_session_id: str | None = None,
    status: str | None = None,
    ledger_ts: str | None = None,
    **fields: Any,
) -> dict[str, Any]:
    """既存 dispatch への差分行を追記する (slug + spawn_ts で対象を特定)."""
    validate_slug(slug)
    validate_status(status)
    record: dict[str, Any] = {"ts": ledger_ts or local_timestamp(), "slug": slug}
    if spawn_ts:
        record["spawn_ts"] = spawn_ts
    if tab_session_id:
        record["tab_session_id"] = tab_session_id
    if status is not None:
        record["status"] = status
    record.update(normalize_record(fields))
    _write_line(Path(path), record)
    return record


# --- repair -------------------------------------------------------------------

_VALID_ESCAPES = set('"\\/bfnrt')


def fix_backslash_escapes(text: str) -> str:
    """JSON として不正なバックスラッシュを `\\\\` へ直す (Windows パスの生書き対策)."""
    out: list[str] = []
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char != "\\":
            out.append(char)
            index += 1
            continue
        nxt = text[index + 1] if index + 1 < length else ""
        if nxt in _VALID_ESCAPES:
            out.append(char)
            out.append(nxt)
            index += 2
            continue
        if nxt == "u" and re.match(r"[0-9a-fA-F]{4}", text[index + 2 : index + 6] or ""):
            out.append(text[index : index + 6])
            index += 6
            continue
        out.append("\\\\")
        index += 1
    return "".join(out)


def split_concatenated_objects(text: str) -> list[str]:
    """1行に連結された複数 JSON オブジェクトを分割する (文字列内の括弧は無視)."""
    chunks: list[str] = []
    depth = 0
    in_string = False
    escaped = False
    start: int | None = None
    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            continue
        if char == "{":
            if depth == 0:
                start = index
            depth += 1
            continue
        if char == "}":
            depth -= 1
            if depth == 0 and start is not None:
                chunks.append(text[start : index + 1])
                start = None
    return chunks


def parse_line(raw: str) -> tuple[list[dict[str, Any]], bool]:
    """1行を 0..n レコードへ復元する。戻り値 = (レコード列, 修復したか)."""
    stripped = raw.strip()
    if not stripped:
        return [], False
    try:
        value = json.loads(stripped)
        if isinstance(value, dict):
            return [value], False
    except json.JSONDecodeError:
        pass

    for candidate, repaired in ((stripped, True), (fix_backslash_escapes(stripped), True)):
        chunks = split_concatenated_objects(candidate)
        records: list[dict[str, Any]] = []
        ok = bool(chunks)
        for chunk in chunks:
            try:
                parsed = json.loads(chunk)
            except json.JSONDecodeError:
                try:
                    parsed = json.loads(fix_backslash_escapes(chunk))
                except json.JSONDecodeError:
                    ok = False
                    break
            if not isinstance(parsed, dict):
                ok = False
                break
            records.append(parsed)
        if ok and records:
            return records, repaired
    return [], False


def derive_dated_slug(record: dict[str, Any]) -> str | None:
    """日付なし slug に YYMMDD 接頭辞を与える (dispatch dir → ts の順で根拠を取る)."""
    slug = record.get("slug")
    if not isinstance(slug, str) or not slug:
        return None
    if _DATED_PREFIX_RE.match(slug):
        return slug
    pattern = re.compile(r"(\d{6})-" + re.escape(slug) + r"(?=[\\/]|$)")
    for key in ("dir", "spec", "done_path", "cwd", "out"):
        value = record.get(key)
        if isinstance(value, str):
            match = pattern.search(value)
            if match:
                return f"{match.group(1)}-{slug}"
    ts = record.get("ts")
    if isinstance(ts, str):
        match = re.match(r"(\d{4})-(\d{2})-(\d{2})", ts)
        if match:
            return f"{match.group(1)[2:]}{match.group(2)}{match.group(3)}-{slug}"
    return None


@dataclass
class RepairStats:
    total_lines: int = 0
    parsable_before: int = 0
    records_after: int = 0
    repaired_lines: list[int] = field(default_factory=list)
    split_lines: list[int] = field(default_factory=list)
    unrecoverable_lines: list[int] = field(default_factory=list)
    renamed_slugs: dict[str, str] = field(default_factory=dict)
    camel_keys_fixed: int = 0
    dispatches_before: int = 0
    dispatches_after: int = 0
    backup_path: str = ""
    unrecoverable_path: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "total_lines": self.total_lines,
            "parsable_before": self.parsable_before,
            "records_after": self.records_after,
            "repaired_lines": self.repaired_lines,
            "split_lines": self.split_lines,
            "unrecoverable_lines": self.unrecoverable_lines,
            "renamed_slugs": self.renamed_slugs,
            "camel_keys_fixed": self.camel_keys_fixed,
            "dispatches_before": self.dispatches_before,
            "dispatches_after": self.dispatches_after,
            "backup_path": self.backup_path,
            "unrecoverable_path": self.unrecoverable_path,
        }


def _backup_path(path: Path) -> Path:
    candidate = path.with_name(path.name + BACKUP_SUFFIX)
    if not candidate.exists():
        return candidate
    stamp = datetime.now().strftime("%H%M%S")
    return path.with_name(f"{path.name}{BACKUP_SUFFIX}-{stamp}")


def repair(path: Path | str = DEFAULT_LEDGER, *, dry_run: bool = False) -> RepairStats:
    """台帳を正規化する (camel→snake / 連結行分割 / エスケープ復元 / slug 日付付与)."""
    path = Path(path)
    stats = RepairStats()
    if not path.is_file():
        return stats

    stats.dispatches_before = len(load_dispatches(path))
    raw_lines = [
        (i, line)
        for i, line in enumerate(
            path.read_text(encoding="utf-8-sig", errors="replace").splitlines(), 1
        )
        if line.strip()
    ]
    stats.total_lines = len(raw_lines)

    repaired: list[dict[str, Any]] = []
    unrecoverable: list[dict[str, Any]] = []
    for lineno, raw in raw_lines:
        try:
            direct = json.loads(raw.strip())
            direct_ok = isinstance(direct, dict)
        except json.JSONDecodeError:
            direct_ok = False
        if direct_ok:
            stats.parsable_before += 1
        records, was_repaired = parse_line(raw)
        if not records:
            stats.unrecoverable_lines.append(lineno)
            unrecoverable.append({"source_line": lineno, "raw": raw})
            continue
        if len(records) > 1:
            stats.split_lines.append(lineno)
        if was_repaired and lineno not in stats.split_lines:
            stats.repaired_lines.append(lineno)
        for record in records:
            camel = [k for k in record if isinstance(k, str) and snake_key(k) != k]
            stats.camel_keys_fixed += len(camel)
            normalized = normalize_record(record)
            slug = normalized.get("slug")
            dated = derive_dated_slug(normalized)
            if isinstance(slug, str) and dated and dated != slug:
                stats.renamed_slugs[slug] = dated
                normalized["slug"] = dated
                normalized.setdefault("slug_legacy", slug)
            repaired.append(normalized)

    stats.records_after = len(repaired)
    if dry_run:
        return stats

    backup = _backup_path(path)
    backup.write_bytes(path.read_bytes())
    stats.backup_path = str(backup)

    body = "".join(json.dumps(rec, ensure_ascii=True) + "\n" for rec in repaired)
    path.write_text(body, encoding="ascii", newline="\n")

    if unrecoverable:
        quarantine = path.with_name(UNRECOVERABLE_NAME)
        with quarantine.open("a", encoding="ascii", newline="\n") as stream:
            for item in unrecoverable:
                stream.write(json.dumps(item, ensure_ascii=True) + "\n")
        stats.unrecoverable_path = str(quarantine)

    stats.dispatches_after = len(load_dispatches(path))
    return stats


# --- CLI ----------------------------------------------------------------------


def _parse_set(values: list[str] | None) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    for item in values or []:
        if "=" not in item:
            raise SystemExit(f"--set は key=value 形式です: {item!r}")
        key, _, value = item.partition("=")
        fields[key.strip()] = value
    return fields


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    sub = parser.add_subparsers(dest="command", required=True)

    append_cmd = sub.add_parser("append", help="新規 dispatch 行を追記")
    append_cmd.add_argument("--slug", required=True)
    append_cmd.add_argument("--status", default=STATUS_OPEN)
    append_cmd.add_argument("--json", dest="json_blob", help="追加フィールドの JSON オブジェクト")
    append_cmd.add_argument("--set", action="append", dest="set_values")

    update_cmd = sub.add_parser("update", help="既存 dispatch へ差分行を追記")
    update_cmd.add_argument("--slug", required=True)
    update_cmd.add_argument("--spawn-ts")
    update_cmd.add_argument("--tab-session-id")
    update_cmd.add_argument("--status")
    update_cmd.add_argument("--set", action="append", dest="set_values")

    repair_cmd = sub.add_parser("repair", help="台帳の修復 (バックアップ必須)")
    repair_cmd.add_argument("--dry-run", action="store_true")

    list_cmd = sub.add_parser("list", help="dispatch 一覧 (JSON)")
    list_cmd.add_argument("--all", action="store_true", help="クローズ済みも表示")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    ledger = Path(args.ledger)
    if args.command == "append":
        record: dict[str, Any] = {}
        if args.json_blob:
            parsed = json.loads(args.json_blob)
            if not isinstance(parsed, dict):
                print("--json は JSON オブジェクトを渡してください", file=sys.stderr)
                return 2
            record.update(parsed)
        record.update(_parse_set(args.set_values))
        record["slug"] = args.slug
        record["status"] = args.status
        try:
            written = append_record(ledger, record)
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        print(json.dumps(written, ensure_ascii=False))
        return 0
    if args.command == "update":
        try:
            written = update_record(
                ledger,
                slug=args.slug,
                spawn_ts=args.spawn_ts,
                tab_session_id=args.tab_session_id,
                status=args.status,
                **_parse_set(args.set_values),
            )
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        print(json.dumps(written, ensure_ascii=False))
        return 0
    if args.command == "repair":
        stats = repair(ledger, dry_run=args.dry_run)
        print(json.dumps(stats.as_dict(), ensure_ascii=False, indent=2))
        return 0
    if args.command == "list":
        rows = [
            {
                "dispatch_id": d.dispatch_id,
                "slug": d.slug,
                "spawn_ts": d.spawn_ts,
                "status": d.status,
                "tab_session_id": d.tab_session_id,
                "claude_session_id": d.get("claude_session_id"),
                "cwd": d.get("cwd"),
                "dir": d.get("dir"),
            }
            for d in load_dispatches(ledger)
            if args.all or not d.closed
        ]
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
