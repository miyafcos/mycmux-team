from __future__ import annotations

import json

import pytest

from oracmux_lib import brief


def test_stance_line_is_first_and_sections_follow():
    built = brief.build("2+2 は？", engine_label="Gemini", slug="demo", context="算数", constraints="短く")
    lines = built.text.splitlines()
    assert lines[0] == "# oracmux brief — demo"
    assert lines[2].startswith("読者＝Gemini／語り手＝")
    assert "## 論点 (問い)" in built.text
    assert "## 経緯・文脈" in built.text and "算数" in built.text
    assert "## 制約" in built.text and "短く" in built.text
    assert "## 出力契約" in built.text and "【要確認】" in built.text
    assert built.attachments == []


def test_empty_question_is_rejected():
    with pytest.raises(ValueError):
        brief.build("   ", engine_label="X")


def test_text_file_is_inlined_and_json_minified(tmp_path):
    md = tmp_path / "note.md"
    md.write_text("# memo\n\nhello\n", encoding="utf-8")
    data = tmp_path / "data.json"
    data.write_text(json.dumps({"a": [1, 2], "b": "x"}, indent=2), encoding="utf-8")
    built = brief.build("q", engine_label="ChatGPT", files=[md, data])
    assert len(built.inlined) == 2 and not built.skipped
    assert f"### FILE: {md} (" in built.text
    assert '{"a":[1,2],"b":"x"}' in built.text
    assert "```markdown\n# memo" in built.text
    assert "## 添付一覧" in built.text


def test_binary_missing_large_and_empty_files_are_listed_not_dropped(tmp_path):
    pdf = tmp_path / "doc.pdf"
    pdf.write_bytes(b"%PDF-1.4 binary")
    big = tmp_path / "big.txt"
    big.write_text("x" * 50, encoding="utf-8")
    empty = tmp_path / "empty.txt"
    empty.write_text("   \n", encoding="utf-8")
    missing = tmp_path / "nope.txt"
    built = brief.build("q", engine_label="Grok", files=[pdf, big, empty, missing], max_file_bytes=10)
    reasons = {item.path.name: item.reason for item in built.skipped}
    assert reasons == {
        "doc.pdf": brief.SKIP_BINARY,
        "big.txt": brief.SKIP_TOO_LARGE,
        "empty.txt": brief.SKIP_EMPTY,
        "nope.txt": brief.SKIP_MISSING,
    }
    assert "未添付: binary" in built.text
    assert "## 添付ファイル本文" not in built.text


def test_inline_budget_skips_files_that_do_not_fit(tmp_path):
    small = tmp_path / "small.txt"
    small.write_text("abc", encoding="utf-8")
    large = tmp_path / "large.txt"
    large.write_text("y" * 5000, encoding="utf-8")
    built = brief.build("q", engine_label="Gemini", files=[large, small], max_inline_chars=1200)
    assert [item.kind for item in built.attachments] == ["skipped", "inline"]
    assert built.attachments[0].reason == brief.SKIP_OVER_INLINE_LIMIT
    assert built.total_chars <= 1200


def test_fence_grows_past_backticks_in_content(tmp_path):
    md = tmp_path / "code.md"
    md.write_text("```py\nprint(1)\n```\n", encoding="utf-8")
    built = brief.build("q", engine_label="ChatGPT", files=[md])
    assert "````markdown\n```py" in built.text
    assert brief.fence_for("no ticks") == "```"
    assert brief.fence_for("a````b") == "`````"


def test_cp932_file_is_read_without_crashing(tmp_path):
    sjis = tmp_path / "old.txt"
    sjis.write_bytes("日本語".encode("cp932"))
    built = brief.build("q", engine_label="Gemini", files=[sjis])
    assert "日本語" in built.text
