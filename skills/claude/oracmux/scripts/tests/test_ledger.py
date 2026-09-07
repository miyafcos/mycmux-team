from __future__ import annotations

import pytest

from oracmux_lib import ledger


def test_append_update_merge_and_recent(tmp_path):
    path = tmp_path / "ledger.jsonl"
    ledger.append({"run_id": "r1", "engine": "gemini", "status": "started", "chars": 10}, path)
    ledger.append({"run_id": "r1", "engine": "grok", "status": "started"}, path)
    ledger.append({"run_id": "r1", "engine": "gemini", "status": "ok", "url": "https://gemini.google.com/app/abc"}, path)
    lanes = ledger.load(path)
    assert [(lane["run_id"], lane["engine"]) for lane in lanes] == [("r1", "gemini"), ("r1", "grok")]
    gemini = lanes[0]
    assert gemini["status"] == "ok" and gemini["chars"] == 10 and gemini["url"].endswith("/abc")
    assert ledger.recent(1, path)[0]["engine"] == "grok"
    assert ledger.recent(0, path) == lanes


def test_ledger_file_is_ascii_only(tmp_path):
    path = tmp_path / "ledger.jsonl"
    ledger.append({"run_id": "r2", "engine": "chatgpt", "status": "ok", "note": "日本語の判定値"}, path)
    raw = path.read_bytes()
    assert raw.isascii()
    assert ledger.load(path)[0]["note"] == "日本語の判定値"


def test_records_need_run_id_and_engine(tmp_path):
    path = tmp_path / "ledger.jsonl"
    with pytest.raises(ValueError):
        ledger.append({"engine": "grok"}, path)
    with pytest.raises(ValueError):
        ledger.append({"run_id": "r"}, path)


def test_corrupt_lines_are_skipped(tmp_path):
    path = tmp_path / "ledger.jsonl"
    path.write_text('{"run_id": "a", "engine": "grok"}\nnot json\n\n', encoding="ascii")
    assert [lane["run_id"] for lane in ledger.load(path)] == ["a"]
    assert ledger.load(tmp_path / "missing.jsonl") == []
