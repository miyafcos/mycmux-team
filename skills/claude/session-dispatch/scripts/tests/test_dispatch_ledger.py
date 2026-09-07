"""dispatch_ledger の契約テスト (B1/B6): マージ廃止・snake 書き込み・repair の正規化."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import dispatch_ledger


def write_lines(path: Path, lines: list[str]) -> Path:
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


# --- 後勝ちシャローマージの廃止 ------------------------------------------------


def test_same_slug_different_tab_is_a_separate_dispatch(tmp_path: Path) -> None:
    ledger = write_lines(
        tmp_path / "ledger.jsonl",
        [
            json.dumps(
                {
                    "ts": "2026-08-01T10:00:00",
                    "slug": "260801-foo",
                    "dir": "d1",
                    "cwd": "c1",
                    "tab_session_id": "tab-old",
                    "status": "open",
                }
            ),
            json.dumps({"ts": "2026-08-01T11:00:00", "slug": "260801-foo", "status": "closed"}),
            json.dumps(
                {
                    "ts": "2026-08-05T10:00:00",
                    "slug": "260801-foo",
                    "dir": "d2",
                    "tab_session_id": "tab-new",
                    "status": "open",
                }
            ),
        ],
    )
    dispatches = dispatch_ledger.load_dispatches(ledger)
    assert len(dispatches) == 2
    old, new = dispatches
    assert old.tab_session_id == "tab-old"
    assert old.status == "closed"
    # 新しいレコードに無いキー (cwd) が旧レコードから生き残らないこと
    assert new.tab_session_id == "tab-new"
    assert new.get("cwd") is None
    assert new.status == "open"


def test_status_only_row_attaches_to_latest_dispatch(tmp_path: Path) -> None:
    ledger = write_lines(
        tmp_path / "ledger.jsonl",
        [
            json.dumps(
                {"ts": "2026-08-01T10:00:00", "slug": "260801-foo", "tab_session_id": "a", "status": "open"}
            ),
            json.dumps(
                {"ts": "2026-08-02T10:00:00", "slug": "260801-foo", "tab_session_id": "b", "status": "open"}
            ),
            json.dumps({"ts": "2026-08-02T11:00:00", "slug": "260801-foo", "status": "closed"}),
        ],
    )
    first, second = dispatch_ledger.load_dispatches(ledger)
    assert first.status == "open"
    assert second.status == "closed"


def test_spawn_ts_targets_the_right_dispatch(tmp_path: Path) -> None:
    ledger = write_lines(
        tmp_path / "ledger.jsonl",
        [
            json.dumps(
                {"ts": "2026-08-01T10:00:00", "slug": "260801-foo", "tab_session_id": "a", "status": "open"}
            ),
            json.dumps(
                {"ts": "2026-08-02T10:00:00", "slug": "260801-foo", "tab_session_id": "b", "status": "open"}
            ),
        ],
    )
    dispatch_ledger.update_record(
        ledger, slug="260801-foo", spawn_ts="2026-08-01T10:00:00", status="closed"
    )
    first, second = dispatch_ledger.load_dispatches(ledger)
    assert first.status == "closed"
    assert second.status == "open"


def test_camel_case_rows_are_readable(tmp_path: Path) -> None:
    ledger = write_lines(
        tmp_path / "ledger.jsonl",
        [json.dumps({"ts": "2026-08-01T10:00:00", "slug": "260801-foo", "tabSessionId": "a", "status": "open"})],
    )
    (dispatch,) = dispatch_ledger.load_dispatches(ledger)
    assert dispatch.tab_session_id == "a"


# --- status 語彙 --------------------------------------------------------------


def test_closed_status_set_covers_the_real_vocabulary() -> None:
    assert dispatch_ledger.is_closed("closed")
    assert dispatch_ledger.is_closed("done-verified-closed")
    assert dispatch_ledger.is_closed("abandoned")
    assert dispatch_ledger.is_closed("fallback-inline")
    # done は「子の自己申告」であってタブは生きている
    assert not dispatch_ledger.is_closed("done")
    assert not dispatch_ledger.is_closed("open")
    assert not dispatch_ledger.is_closed("running")
    # 未知・空は「閉じていない」側 (fail-closed)
    assert not dispatch_ledger.is_closed("something-new")
    assert not dispatch_ledger.is_closed(None)


# --- 書き込み -----------------------------------------------------------------


def test_append_rejects_undated_slug(tmp_path: Path) -> None:
    ledger = tmp_path / "ledger.jsonl"
    with pytest.raises(ValueError):
        dispatch_ledger.append_record(ledger, {"slug": "kaiteibin", "status": "open"})
    assert not ledger.exists()


def test_append_rejects_unknown_status(tmp_path: Path) -> None:
    ledger = tmp_path / "ledger.jsonl"
    with pytest.raises(ValueError):
        dispatch_ledger.append_record(ledger, {"slug": "260813-foo", "status": "in-progress"})


def test_append_writes_one_ascii_snake_object_per_line(tmp_path: Path) -> None:
    ledger = tmp_path / "ledger.jsonl"
    dispatch_ledger.append_record(
        ledger,
        {
            "slug": "260813-foo",
            "status": "open",
            "tabSessionId": "tab-1",
            "spec": r"C:\Users\example\.claude\dispatch\260813-foo\spec.md",
            "note": "日本語のメモ",
        },
    )
    raw = ledger.read_text(encoding="ascii")
    assert raw.count("\n") == 1
    record = json.loads(raw)
    assert record["tab_session_id"] == "tab-1"
    assert "tabSessionId" not in record
    assert record["spec"].endswith(r"260813-foo\spec.md")
    assert record["note"] == "日本語のメモ"


# --- repair -------------------------------------------------------------------


def test_repair_fixes_escapes_concatenation_camel_and_slug(tmp_path: Path) -> None:
    ledger = tmp_path / "ledger.jsonl"
    good = json.dumps(
        {"ts": "2026-08-01T10:00:00", "slug": "260801-ok", "tab_session_id": "a", "status": "open"}
    )
    raw_backslash = (
        '{"slug":"newbook","ts":"2026-08-10T03:55:00",'
        '"spec":"C:\\Users\\example\\.claude\\dispatch\\260810-newbook\\spec.md",'
        '"tabSessionId":"tab-nb","status":"running"}'
    )
    concatenated = (
        '{"slug":"kaiteibin","status":"done-verified-closed","ts":"2026-08-12T06:02:48"} '
        '{"slug":"wahou","ts":"2026-08-12T06:02:48","tab_session_id":"tab-w","status":"running"}'
    )
    write_lines(ledger, [good, raw_backslash, concatenated, "{not json at all"])

    before = dispatch_ledger.load_result(ledger)
    assert len(before.unparsable_lines) == 3

    stats = dispatch_ledger.repair(ledger)
    assert stats.total_lines == 4
    assert stats.parsable_before == 1
    assert stats.records_after == 4
    assert stats.unrecoverable_lines == [4]
    assert Path(stats.backup_path).is_file()
    assert Path(stats.unrecoverable_path).is_file()
    assert stats.renamed_slugs == {
        "newbook": "260810-newbook",
        "kaiteibin": "260812-kaiteibin",
        "wahou": "260812-wahou",
    }

    after = dispatch_ledger.load_result(ledger)
    assert after.unparsable_lines == []
    slugs = sorted(dispatch.slug for dispatch in after.dispatches)
    assert slugs == ["260801-ok", "260810-newbook", "260812-kaiteibin", "260812-wahou"]
    newbook = next(d for d in after.dispatches if d.slug == "260810-newbook")
    assert newbook.get("spec").endswith(r"260810-newbook\spec.md")
    assert newbook.tab_session_id == "tab-nb"


def test_repair_keeps_the_backup_and_quarantines_nothing_when_clean(tmp_path: Path) -> None:
    ledger = write_lines(
        tmp_path / "ledger.jsonl",
        [json.dumps({"ts": "2026-08-01T10:00:00", "slug": "260801-ok", "status": "open"})],
    )
    stats = dispatch_ledger.repair(ledger)
    assert stats.unrecoverable_lines == []
    assert stats.unrecoverable_path == ""
    assert Path(stats.backup_path).read_text(encoding="utf-8").strip().startswith("{")


def test_repair_does_not_overwrite_an_existing_backup(tmp_path: Path) -> None:
    ledger = write_lines(
        tmp_path / "ledger.jsonl",
        [json.dumps({"ts": "2026-08-01T10:00:00", "slug": "260801-ok", "status": "open"})],
    )
    first = dispatch_ledger.repair(ledger)
    second = dispatch_ledger.repair(ledger)
    assert first.backup_path != second.backup_path
    assert Path(first.backup_path).is_file()


def test_fix_backslash_escapes_keeps_valid_sequences() -> None:
    assert dispatch_ledger.fix_backslash_escapes(r'"a\\b"') == r'"a\\b"'
    assert dispatch_ledger.fix_backslash_escapes(r'"a\nb"') == r'"a\nb"'
    assert dispatch_ledger.fix_backslash_escapes(r'"\u3042"') == r'"\u3042"'
    assert dispatch_ledger.fix_backslash_escapes(r'"C:\Users"') == r'"C:\\Users"'


def test_split_concatenated_objects_ignores_braces_in_strings() -> None:
    text = '{"a":"}{"} {"b":1}'
    assert dispatch_ledger.split_concatenated_objects(text) == ['{"a":"}{"}', '{"b":1}']


def test_append_maps_spawn_ids_and_round_trips_through_cli(tmp_path, capsys):
    ledger = tmp_path / "ledger.jsonl"
    payload = {"sessionId": "pty-1", "tabId": "tab-1", "placement": "tab"}
    assert dispatch_ledger.main([
        "--ledger", str(ledger), "append", "--slug", "260907-new",
        "--json", json.dumps(payload),
    ]) == 0
    row = json.loads(capsys.readouterr().out)
    assert row["tab_session_id"] == "pty-1"
    assert row["tab_id"] == "tab-1"
    assert row["session_id"] == "pty-1"
    assert all(dispatch_ledger.snake_key(key) == key for key in row)
    assert dispatch_ledger.load_dispatches(ledger)[0].tab_session_id == "pty-1"


@pytest.mark.parametrize("aliases", [
    {"sessionId": "a", "session_id": "b"},
    {"sessionId": "a", "tab_session_id": "b"},
    {"session_id": "a", "tabSessionId": "b"},
    {"tabSessionId": "a", "tab_session_id": "b"},
    {"tabId": "a", "tab_id": "b"},
])
@pytest.mark.parametrize("reverse", [False, True])
def test_append_rejects_conflicting_aliases_without_touching_ledger(tmp_path, aliases, reverse):
    ledger = tmp_path / "ledger.jsonl"
    ledger.write_text("{}\n", encoding="utf-8")
    before = ledger.read_bytes()
    if reverse:
        aliases = dict(reversed(list(aliases.items())))
    with pytest.raises(ValueError, match="conflicting aliases"):
        dispatch_ledger.append_record(ledger, {"slug": "260907-new", "status": "open", **aliases})
    assert ledger.read_bytes() == before


def test_append_accepts_equal_aliases(tmp_path):
    row = dispatch_ledger.append_record(tmp_path / "ledger.jsonl", {
        "slug": "260907-new", "status": "open",
        "sessionId": "pty-1", "session_id": "pty-1", "tab_session_id": "pty-1",
        "tabId": "tab-1", "tab_id": "tab-1",
    })
    assert row["tab_session_id"] == "pty-1"
    assert row["tab_id"] == "tab-1"


def test_historical_session_id_is_not_inferred(tmp_path):
    ledger = tmp_path / "ledger.jsonl"
    ledger.write_text(json.dumps({
        "slug": "260907-old", "status": "open", "sessionId": "legacy-pty",
    }) + "\n", encoding="utf-8")
    before = ledger.read_bytes()
    assert dispatch_ledger.load_dispatches(ledger)[0].tab_session_id is None
    assert ledger.read_bytes() == before


def test_update_keeps_explicit_tab_session_id_flag(tmp_path, capsys):
    ledger = tmp_path / "ledger.jsonl"
    assert dispatch_ledger.main([
        "--ledger", str(ledger), "update", "--slug", "260907-new",
        "--tab-session-id", "pty-1", "--status", "close_failed",
    ]) == 0
    assert json.loads(capsys.readouterr().out)["tab_session_id"] == "pty-1"
    dispatch = dispatch_ledger.load_dispatches(ledger)[0]
    assert dispatch.status == "close_failed"
    assert not dispatch.closed
