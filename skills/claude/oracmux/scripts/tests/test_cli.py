"""End-to-end of the CLI in dry-run mode: no browser, no mycmux socket."""

from __future__ import annotations

import json
from pathlib import Path

import oracmux
from oracmux_lib import ledger, paths


def run_cli(*argv: str) -> int:
    return oracmux.main(list(argv))


def test_ask_dry_run_writes_run_dir_brief_request_and_ledger(isolated_home, tmp_path, capsys):
    note = tmp_path / "note.md"
    note.write_text("参考メモ\n", encoding="utf-8")
    code = run_cli("ask", "--engine", "gemini", "-q", "Web ペインに oracle を載せる設計は妥当か", "--file", str(note), "--dry-run", "--json")
    assert code == oracmux.EXIT_OK
    out = capsys.readouterr().out
    payload = json.loads([line for line in out.splitlines() if line.startswith("JSON ")][-1][5:])
    run_dir = Path(payload["run_dir"])
    assert run_dir.parent == isolated_home
    assert run_dir.name.endswith("-web-oracle")
    brief = (run_dir / "brief.md").read_text(encoding="utf-8")
    assert brief.splitlines()[2].startswith("読者＝Gemini")
    assert "参考メモ" in brief
    request = json.loads((run_dir / "request.json").read_text(encoding="utf-8"))
    assert request["engine"] == "gemini" and request["via"] == "pane" and request["mode"] == "current"
    assert request["files"][0]["kind"] == "inline"
    lanes = ledger.load(paths.ledger_path())
    assert lanes[-1]["status"] == "dry_run" and lanes[-1]["engine"] == "gemini"
    assert "dry-run: brief written, nothing sent" in out


def test_ask_default_lane_is_pane_and_oracle_is_chatgpt_only(isolated_home, capsys):
    code = run_cli("ask", "--engine", "chatgpt", "-q", "PING", "--dry-run", "--json")
    assert code == oracmux.EXIT_OK
    payload = json.loads([line for line in capsys.readouterr().out.splitlines() if line.startswith("JSON ")][-1][5:])
    request = json.loads((Path(payload["run_dir"]) / "request.json").read_text(encoding="utf-8"))
    assert request["via"] == "pane"
    code = run_cli("ask", "--engine", "chatgpt", "-q", "PING", "--via", "oracle", "--dry-run", "--json")
    assert code == oracmux.EXIT_OK
    payload = json.loads([line for line in capsys.readouterr().out.splitlines() if line.startswith("JSON ")][-1][5:])
    assert json.loads((Path(payload["run_dir"]) / "request.json").read_text(encoding="utf-8"))["via"] == "oracle"
    assert run_cli("ask", "--engine", "grok", "-q", "PING", "--via", "oracle", "--dry-run") == oracmux.EXIT_PRECONDITION


def test_guard_blocks_markers_unless_allowed(isolated_home, capsys):
    code = run_cli("ask", "--engine", "grok", "-q", "この 社外秘 資料の要点は？", "--dry-run")
    assert code == oracmux.EXIT_GUARD
    assert "GUARD: blocked" in capsys.readouterr().out
    lanes = ledger.load(paths.ledger_path())
    assert lanes[-1]["status"] == "guard_blocked"
    assert run_cli("ask", "--engine", "grok", "-q", "この 社外秘 資料の要点は？", "--dry-run", "--allow-markers") == oracmux.EXIT_OK


def test_unknown_mode_falls_back_to_default(isolated_home, capsys):
    assert run_cli("ask", "--engine", "gemini", "-q", "q", "--mode", "expert", "--dry-run", "--json") == oracmux.EXIT_OK
    out = capsys.readouterr().out
    assert "mode expert is not defined for Gemini; using current" in out


def test_council_dry_run_and_reuse_via_run_dir(isolated_home, capsys):
    code = run_cli("council", "-q", "三者で比べたい問い", "--engines", "gemini,grok", "--mode-grok", "expert", "--dry-run", "--json")
    assert code == oracmux.EXIT_OK
    payload = json.loads([line for line in capsys.readouterr().out.splitlines() if line.startswith("JSON ")][-1][5:])
    run_dir = Path(payload["run_dir"])
    assert run_dir.name.endswith("-council-consult") or "council" in run_dir.name
    assert payload["modes"] == {"gemini": "current", "grok": "expert"}
    brief = (run_dir / "brief.md").read_text(encoding="utf-8")
    assert "読者＝ChatGPT / Gemini / Grok" in brief
    assert {lane["engine"] for lane in ledger.load(paths.ledger_path()) if lane["run_id"] == run_dir.name} == {"gemini", "grok"}
    # a lane re-run reuses the brief without rebuilding it
    assert run_cli("ask", "--engine", "grok", "--run-dir", str(run_dir), "--via", "cdp", "--dry-run") == oracmux.EXIT_OK
    assert run_cli("ask", "--engine", "grok", "--run-dir", str(run_dir / "missing"), "--dry-run") == oracmux.EXIT_PRECONDITION


def test_push_outside_mycmux_is_a_precondition_error_unless_dry_run(isolated_home, capsys):
    assert run_cli("push", "--engine", "gemini", "-q", "q") == oracmux.EXIT_PRECONDITION
    assert run_cli("push", "--engine", "gemini", "-q", "q", "--dry-run") == oracmux.EXIT_OK
    out = capsys.readouterr().out
    assert "would push" in out and "web-push" in out and "--preset gemini" in out
    assert run_cli("push", "--engine", "gemini", "--dry-run") == oracmux.EXIT_PRECONDITION


def test_ledger_listing(isolated_home, capsys):
    assert run_cli("ledger") == oracmux.EXIT_OK
    assert "ledger is empty" in capsys.readouterr().out
    run_cli("ask", "--engine", "gemini", "-q", "q", "--dry-run")
    capsys.readouterr()
    assert run_cli("ledger", "--json") == oracmux.EXIT_OK
    rows = json.loads(capsys.readouterr().out)
    assert rows and rows[-1]["engine"] == "gemini"


def test_expand_files_globs_and_dedupes(tmp_path):
    (tmp_path / "a.md").write_text("a", encoding="utf-8")
    (tmp_path / "b.md").write_text("b", encoding="utf-8")
    found = oracmux.expand_files([str(tmp_path / "*.md"), str(tmp_path / "a.md"), str(tmp_path / "none-*.txt")])
    names = [path.name for path in found]
    assert names == ["a.md", "b.md", "none-*.txt"]
