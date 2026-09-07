"""Guard evasion paths found by the 2026-09-07 audit: full-width, zero-width,
spaced markers; deny_roots on question/context/upload paths; --run-dir reuse;
undecodable files."""

from __future__ import annotations

import json
from pathlib import Path

import oracmux
from oracmux_lib import brief, guard


def cfg(**overrides):
    merged = dict(guard.DEFAULT_GUARD)
    merged.update(overrides)
    return merged


def test_fullwidth_and_zero_width_markers_are_caught():
    assert guard.scan_text("ＮＤＡ 対象", cfg(), "brief")[0].detail.startswith("NDA @ line 1")
    hits = guard.scan_text("社" + chr(0x200B) + "外" + chr(0x200B) + "秘 の資料", cfg(), "brief")
    assert hits and hits[0].detail.startswith("社外秘 @ line 1")
    assert guard.scan_text("con" + chr(0x00AD) + "fidential", cfg(), "brief")[0].detail.startswith("CONFIDENTIAL")
    assert len(guard.ZERO_WIDTH) == 6 and all(ord(c) > 127 for c in guard.ZERO_WIDTH)


def test_spaced_and_multispace_markers_are_caught_with_real_line_numbers():
    text = chr(10).join(["行1", "これは 社 外 秘 です", "N D A あり", "under DO  NOT DISTRIBUTE now"])
    hits = guard.scan_text(text, cfg(), "brief")
    details = [hit.detail for hit in hits]
    assert "社外秘 @ line 2" in details
    assert "NDA @ line 3" in details
    assert "DO NOT DISTRIBUTE @ line 4" in details
    plain = guard.scan_text("社外秘 と 社 外 秘", cfg(), "brief")
    assert [hit.detail for hit in plain] == ["社外秘 @ line 1", "社外秘 @ line 1"]
    assert guard.scan_text("standard nda-like: sandal", cfg(), "brief")[0].detail.startswith("NDA @"), "hyphen is a boundary"
    assert guard.scan_text("standard sandal", cfg(), "brief") == []


def test_undecodable_attachment_is_skipped_not_mangled(tmp_path):
    bad = tmp_path / "bad.txt"
    bad.write_bytes(b"\xff\xfe\x00\x81\x39garbage\x80")
    built = brief.build("q", engine_label="Gemini", files=[bad])
    assert built.skipped and built.skipped[0].reason == brief.SKIP_UNDECODABLE
    assert "\ufffd" not in built.text


def test_question_file_must_decode(isolated_home, tmp_path, capsys):
    bad = tmp_path / "q.txt"
    bad.write_bytes(b"\xff\xfe\x00\x81\x39")
    assert oracmux.main(["ask", "--engine", "gemini", "--question-file", str(bad), "--dry-run"]) == oracmux.EXIT_PRECONDITION
    assert "neither UTF-8 nor cp932" in capsys.readouterr().out


def test_deny_roots_cover_question_context_and_upload_paths(isolated_home, tmp_path, monkeypatch, capsys):
    secret = tmp_path / "secret"
    secret.mkdir()
    question = secret / "q.md"
    question.write_text("普通の問い", encoding="utf-8")
    guard_json = tmp_path / "guard.json"
    guard_json.write_text(json.dumps({"deny_roots": [str(secret)]}), encoding="utf-8")
    monkeypatch.setenv("ORACMUX_GUARD", str(guard_json))
    assert oracmux.main(["ask", "--engine", "gemini", "--question-file", str(question), "--dry-run"]) == oracmux.EXIT_GUARD
    assert "deny root" in capsys.readouterr().out
    ok_question = tmp_path / "ok.md"
    ok_question.write_text("普通の問い", encoding="utf-8")
    upload = secret / "spec.pdf"
    upload.write_bytes(b"%PDF")
    assert oracmux.main(["ask", "--engine", "chatgpt", "--via", "oracle", "--question-file", str(ok_question), "--upload", str(upload), "--dry-run"]) == oracmux.EXIT_GUARD
    capsys.readouterr()
    assert oracmux.main(["council", "--question-file", str(ok_question), "--context-file", str(question), "--dry-run"]) == oracmux.EXIT_GUARD


def test_reused_run_dir_brief_is_rescanned(isolated_home, capsys):
    run_dir = isolated_home / "260907-0000-manual"
    run_dir.mkdir(parents=True)
    (run_dir / "brief.md").write_text("# brief\n\n社外秘 の内容\n", encoding="utf-8")
    assert oracmux.main(["ask", "--engine", "grok", "--run-dir", str(run_dir), "--dry-run"]) == oracmux.EXIT_GUARD
    assert oracmux.main(["push", "--engine", "grok", "--run-dir", str(run_dir), "--dry-run"]) == oracmux.EXIT_GUARD
    assert oracmux.main(["ask", "--engine", "grok", "--run-dir", str(run_dir), "--dry-run", "--allow-markers"]) == oracmux.EXIT_OK


def test_council_lane_command_passes_allow_markers(tmp_path):
    command = oracmux.lane_command("grok", tmp_path, "expert", 12.5, allow_markers=True)
    assert command[2] == "ask" and command[command.index("--engine") + 1] == "grok"
    assert command[command.index("--mode") + 1] == "expert"
    assert command[command.index("--timeout-min") + 1] == "12.5"
    assert command[-1] == "--allow-markers" and "--force" in command and "--json" in command
    assert "--allow-markers" not in oracmux.lane_command("grok", tmp_path, "expert", 1, allow_markers=False)


def test_size_hit_is_not_overridable(isolated_home, tmp_path, monkeypatch, capsys):
    guard_json = tmp_path / "guard.json"
    guard_json.write_text(json.dumps({"max_total_chars": 300}), encoding="utf-8")
    monkeypatch.setenv("ORACMUX_GUARD", str(guard_json))
    big = tmp_path / "big.md"
    big.write_text("x" * 400, encoding="utf-8")
    code = oracmux.main(["ask", "--engine", "gemini", "-q", "q", "--file", str(big), "--dry-run", "--allow-markers"])
    assert code == oracmux.EXIT_GUARD
    assert "max_total_chars" in capsys.readouterr().out
