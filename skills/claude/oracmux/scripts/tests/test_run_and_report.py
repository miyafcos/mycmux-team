from __future__ import annotations

from datetime import datetime

from oracmux_lib import report, run


def test_slugify_is_ascii_bounded_and_has_fallback():
    assert run.slugify("Web ペイン + oracle 統合案 v2") == "web-oracle-v2"
    assert run.slugify("日本語だけ") == "consult"
    assert len(run.slugify("x" * 100)) == run.SLUG_MAX
    assert run.slugify("--a--b--") == "a-b"


def test_prefixed_does_not_double():
    assert run.prefixed("council-", "council-demo") == "council-demo"
    assert run.prefixed("council-", "demo") == "council-demo"


def test_new_run_dir_dedupes_same_minute(tmp_path):
    now = datetime(2026, 9, 7, 13, 5)
    first = run.new_run_dir("demo", now=now, root=tmp_path)
    second = run.new_run_dir("demo", now=now, root=tmp_path)
    assert first.name == "260907-1305-demo"
    assert second.name == "260907-1305-demo-2"
    assert first.is_dir() and second.is_dir()


def test_progress_roundtrip_and_answer_header(tmp_path):
    eng = run.engine_dir(tmp_path, "gemini")
    run.write_progress(eng, "streaming", chars=120)
    progress = run.read_progress(eng)
    assert progress["phase"] == "streaming" and progress["chars"] == 120
    header = run.answer_header({"engine": "gemini", "status": "ok", "conversation_url": "u", "ignored": 1})
    assert header.startswith("---\nengine: gemini\nstatus: ok\nconversation_url: u\n---")
    assert run.read_json(tmp_path / "missing.json") == {}


def test_council_markdown_has_table_answers_and_judge_block():
    lanes = [
        {"engine": "chatgpt", "label": "ChatGPT", "status": "ok", "mode_requested": "current", "mode_actual": "current", "elapsed_sec": 30, "chars": 12, "conversation_url": "https://chatgpt.com/c/1", "answer": "# 結論\n\nはい"},
        {"engine": "grok", "label": "Grok", "status": "failed", "error": "ui_not_found: composer", "answer": ""},
    ]
    md = report.council_markdown("260907-1305-council-demo", "問い本文", lanes)
    assert "| ChatGPT | <span class=\"chip ok\">回収済</span> | current→current | 30s | 12 | https://chatgpt.com/c/1 |" in md
    assert "## ChatGPT の回答\n\n### 結論" in md  # answer headings demoted under the lane heading
    assert "(回収なし: ui_not_found: composer)" in md
    assert "## judge (母艦が記入)" in md and "confidence" in md


def test_demote_headings_caps_at_h6():
    assert report.demote_headings("# a\n##### b\ntext") == "### a\n###### b\ntext"
