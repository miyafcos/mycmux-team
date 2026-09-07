"""Regression tests for the 2026-09-07 audit findings outside the driver."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

import oracmux
from oracmux_lib import brief, engines, guard, ledger, oracle_cli, paths, report, run


# --- guard / brief -----------------------------------------------------------


def test_guard_load_fails_closed_on_missing_or_bad_file(tmp_path):
    with pytest.raises(guard.GuardConfigError):
        guard.load(tmp_path / "missing.json")
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(guard.GuardConfigError):
        guard.load(bad)
    for payload in ({"markers_ja": [" "]}, {"max_total_chars": True}, {"deny_roots": ["ok", ""]}):
        bad.write_text(json.dumps(payload), encoding="utf-8")
        with pytest.raises(guard.GuardConfigError):
            guard.load(bad)


def test_missing_explicit_guard_file_stops_the_cli(isolated_home, monkeypatch, capsys):
    monkeypatch.setenv("ORACMUX_GUARD", str(isolated_home / "nope.json"))
    assert oracmux.main(["ask", "--engine", "gemini", "-q", "q", "--dry-run"]) == oracmux.EXIT_PRECONDITION
    assert "guard configuration not found" in capsys.readouterr().out


def test_upload_text_content_is_scanned_and_binaries_are_reported(isolated_home, tmp_path, capsys):
    secret = tmp_path / "notes.txt"
    secret.write_text("this text is CONFIDENTIAL", encoding="utf-8")
    code = oracmux.main(["ask", "--engine", "chatgpt", "--via", "oracle", "-q", "q", "--upload", str(secret), "--dry-run"])
    assert code == oracmux.EXIT_GUARD
    assert "upload" in capsys.readouterr().out
    pdf = tmp_path / "doc.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    assert oracmux.main(["ask", "--engine", "chatgpt", "--via", "oracle", "-q", "q", "--upload", str(pdf), "--dry-run", "--json"]) == oracmux.EXIT_OK
    out = capsys.readouterr().out
    assert "guard could not inspect" in out
    payload = json.loads([line for line in out.splitlines() if line.startswith("JSON ")][-1][5:])
    request = json.loads((Path(payload["run_dir"]) / "request.json").read_text(encoding="utf-8"))
    assert request["uploads_unscanned"] and "binary" in request["uploads_unscanned"][0]
    assert request["uploads"] == [str(pdf.resolve())]


def test_upload_is_refused_on_the_cdp_lane(isolated_home, tmp_path, capsys):
    pdf = tmp_path / "doc.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    assert oracmux.main(["ask", "--engine", "gemini", "-q", "q", "--upload", str(pdf), "--dry-run"]) == oracmux.EXIT_PRECONDITION
    assert "--upload is only delivered" in capsys.readouterr().out
    assert oracmux.main(["ask", "--engine", "chatgpt", "--via", "cdp", "-q", "q", "--upload", str(pdf), "--dry-run"]) == oracmux.EXIT_PRECONDITION


def test_reused_run_rescans_original_paths_and_uploads(isolated_home, tmp_path, monkeypatch, capsys):
    secret = tmp_path / "secret"
    secret.mkdir()
    question = secret / "q.md"
    question.write_text("問い", encoding="utf-8")
    run_dir = isolated_home / "260907-0001-reuse"
    run_dir.mkdir(parents=True)
    (run_dir / "brief.md").write_text("# brief\n\n問い\n", encoding="utf-8")
    run.write_json(run_dir / "request.json", {"guard_paths": [str(question)], "uploads": []})
    assert oracmux.main(["ask", "--engine", "grok", "--run-dir", str(run_dir), "--dry-run"]) == oracmux.EXIT_OK
    guard_json = tmp_path / "guard.json"
    guard_json.write_text(json.dumps({"deny_roots": [str(secret)]}), encoding="utf-8")
    monkeypatch.setenv("ORACMUX_GUARD", str(guard_json))
    assert oracmux.main(["ask", "--engine", "grok", "--run-dir", str(run_dir), "--dry-run"]) == oracmux.EXIT_GUARD
    assert "deny root" in capsys.readouterr().out
    bad = run_dir / "brief.md"
    bad.write_bytes(b"\xff\xfe\x00\x81\x39")
    monkeypatch.delenv("ORACMUX_GUARD")
    assert oracmux.main(["ask", "--engine", "grok", "--run-dir", str(run_dir), "--dry-run"]) == oracmux.EXIT_PRECONDITION


def test_brief_limit_is_enforced_on_the_final_text(tmp_path):
    with pytest.raises(brief.BriefTooLarge):
        brief.build("x" * 500, engine_label="Gemini", max_inline_chars=400)
    small = tmp_path / "a.txt"
    small.write_text("abc", encoding="utf-8")
    built = brief.build("q", engine_label="Gemini", files=[small], max_inline_chars=900)
    assert built.total_chars <= 900
    assert oracmux.main(["ask", "--engine", "gemini", "-q", "x" * 200, "--max-inline-chars", "150", "--dry-run"]) == oracmux.EXIT_PRECONDITION


# --- engines / cli input validation --------------------------------------------


def test_engines_validation_catches_empty_lists_bad_regex_and_js_pseudo(tmp_path):
    base = json.loads(paths.engines_json().read_text(encoding="utf-8-sig"))
    for mutate, message in (
        (lambda d: d["gemini"].update(composer=[]), "composer"),
        (lambda d: d["grok"].update(answer_strip_patterns=["["]), "invalid regex"),
        (lambda d: d["chatgpt"].update(assistant=["div:has-text('x')"]), "Playwright-only"),
        (lambda d: d["cdp"].update(port=70000), "port"),
        (lambda d: d["chatgpt"].update(conversation_url_pattern="("), "invalid regex"),
    ):
        data = json.loads(json.dumps(base))
        mutate(data)
        target = tmp_path / "e.json"
        target.write_text(json.dumps(data), encoding="utf-8")
        with pytest.raises(engines.EngineContractError) as info:
            engines.load(target)
        assert message in str(info.value)


def test_numeric_flags_and_usage_errors_map_to_precondition(isolated_home, capsys):
    assert oracmux.main(["ask", "--engine", "gemini", "-q", "q", "--timeout-min", "-1", "--dry-run"]) == oracmux.EXIT_PRECONDITION
    assert oracmux.main(["ask", "--engine", "gemini", "-q", "q", "--timeout-min", "nan", "--dry-run"]) == oracmux.EXIT_PRECONDITION
    assert oracmux.main(["ask", "--engine", "gemini", "-q", "q", "--max-inline-chars", "0", "--dry-run"]) == oracmux.EXIT_PRECONDITION
    assert oracmux.main(["ask", "--bogus"]) == oracmux.EXIT_PRECONDITION
    assert oracmux.main(["--help"]) == oracmux.EXIT_OK


def test_file_flag_accepts_several_paths(isolated_home, tmp_path, capsys):
    a = tmp_path / "a.md"
    b = tmp_path / "b.md"
    a.write_text("A", encoding="utf-8")
    b.write_text("B", encoding="utf-8")
    assert oracmux.main(["ask", "--engine", "gemini", "-q", "q", "--file", str(a), str(b), "--dry-run", "--json"]) == oracmux.EXIT_OK
    payload = json.loads([line for line in capsys.readouterr().out.splitlines() if line.startswith("JSON ")][-1][5:])
    request = json.loads((Path(payload["run_dir"]) / "request.json").read_text(encoding="utf-8"))
    assert [Path(item["path"]).name for item in request["files"]] == ["a.md", "b.md"]


def test_council_dedupes_engines_and_keeps_question(isolated_home, capsys):
    assert oracmux.main(["council", "-q", "問い", "--engines", "gemini,gemini,grok", "--dry-run", "--json"]) == oracmux.EXIT_OK
    payload = json.loads([line for line in capsys.readouterr().out.splitlines() if line.startswith("JSON ")][-1][5:])
    assert payload["engines"] == ["gemini", "grok"]
    request = json.loads((Path(payload["run_dir"]) / "request.json").read_text(encoding="utf-8"))
    assert request["question"] == "問い"
    assert oracmux.main(["council", "-q", "q", "--engines", "bing", "--dry-run"]) == oracmux.EXIT_PRECONDITION


def test_push_dry_run_emits_json_and_normalized_bytes(isolated_home, capsys):
    assert oracmux.main(["push", "--engine", "gemini", "-q", "行1\r\n行2", "--dry-run", "--json"]) == oracmux.EXIT_OK
    out = capsys.readouterr().out
    payload = json.loads([line for line in out.splitlines() if line.startswith("JSON ")][-1][5:])
    pushed = Path(payload["brief"]).read_bytes()
    assert b"\r" not in pushed and not pushed.startswith(b"\xef\xbb\xbf")
    assert payload["bytes"] == len(pushed)


def test_slug_with_path_components_is_normalised(isolated_home, capsys):
    assert oracmux.main(["ask", "--engine", "gemini", "-q", "q", "--slug", "audit-parent/../evil", "--dry-run", "--json"]) == oracmux.EXIT_OK
    payload = json.loads([line for line in capsys.readouterr().out.splitlines() if line.startswith("JSON ")][-1][5:])
    run_dir = Path(payload["run_dir"])
    assert run_dir.parent == isolated_home.resolve()
    assert run_dir.name.endswith("-audit-parent-evil")


# --- run / ledger / report / oracle_cli ----------------------------------------


def test_previous_outputs_are_archived_before_a_rerun(tmp_path):
    eng = run.engine_dir(tmp_path, "gemini")
    (eng / "answer.md").write_text("old", encoding="utf-8")
    (eng / "citations.txt").write_text("u", encoding="utf-8")
    archive = run.archive_previous_outputs(eng)
    assert archive is not None and (archive / "answer.md").read_text(encoding="utf-8") == "old"
    assert not (eng / "answer.md").exists() and not (eng / "citations.txt").exists()
    assert run.archive_previous_outputs(eng) is None


def test_ledger_recent_orders_by_last_update_and_locks(tmp_path):
    path = tmp_path / "ledger.jsonl"
    ledger.append({"run_id": "a", "engine": "gemini", "status": "started", "ts": "2026-09-07T01:00:00Z"}, path)
    ledger.append({"run_id": "b", "engine": "grok", "status": "started", "ts": "2026-09-07T01:01:00Z"}, path)
    ledger.append({"run_id": "a", "engine": "gemini", "status": "ok", "ts": "2026-09-07T01:02:00Z"}, path)
    assert [lane["run_id"] for lane in ledger.recent(2, path)] == ["b", "a"]
    assert not (tmp_path / "ledger.jsonl.lock").exists()


def test_demote_headings_leaves_code_fences_alone():
    text = "# 結論\n```python\n# comment\n```\n## 根拠"
    assert report.demote_headings(text) == "### 結論\n```python\n# comment\n```\n#### 根拠"


def test_oracle_classify_and_run_with_fake_process(tmp_path):
    assert oracle_cli.classify("", 0, False) == (oracle_cli.STATUS_OK, "")
    assert oracle_cli.classify("A session with the same prompt is already running", 1, False)[0] == oracle_cli.STATUS_BUSY
    assert oracle_cli.classify("Browser manual login required", 1, False)[0] == oracle_cli.STATUS_NEEDS_HUMAN
    assert oracle_cli.classify("Prompt did not appear in conversation before timeout", 1, False)[0] == oracle_cli.STATUS_TIMEOUT
    assert oracle_cli.classify("boom", 1, False)[0] == oracle_cli.STATUS_FAILED
    assert oracle_cli.classify("x", None, True)[0] == oracle_cli.STATUS_TIMEOUT
    script = "import sys; print('Reattach: oracle session demo-1'); print('open https://chatgpt.com/c/WEB:abc'); sys.exit(0)"
    result = oracle_cli.run([sys.executable, "-c", script], 30, lambda _m: None, log_path=tmp_path / "oracle.log")
    assert result.status == oracle_cli.STATUS_OK
    assert result.session_slug == "demo-1" and result.conversation_url == "https://chatgpt.com/c/WEB:abc"
    hang = "import time; print('Acquired ChatGPT browser slot', flush=True); time.sleep(60)"
    result = oracle_cli.run([sys.executable, "-c", hang], 1, lambda _m: None, log_path=tmp_path / "oracle2.log")
    assert result.status == oracle_cli.STATUS_TIMEOUT and result.returncode is None
    assert result.command[0] == sys.executable


def test_oracle_command_paths_are_absolute(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    command = oracle_cli.build_command(Path("brief.md"), Path("out.md"), "s", uploads=[Path("a.pdf")], node="node", cli_js=Path("j.js"))
    assert command[command.index("-f") + 1] == str((tmp_path / "brief.md").resolve())
    assert str((tmp_path / "a.pdf").resolve()) in command
    assert command[command.index("--write-output") + 1] == str((tmp_path / "out.md").resolve())
