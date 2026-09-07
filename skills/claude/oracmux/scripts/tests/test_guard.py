from __future__ import annotations

import json
from pathlib import Path

import pytest

from oracmux_lib import guard


def cfg(**overrides):
    merged = dict(guard.DEFAULT_GUARD)
    merged.update(overrides)
    return merged


def test_japanese_markers_hit_with_line_numbers():
    hits = guard.scan_text("行1\n行2 社外秘 資料\n", cfg(), "brief")
    assert [hit.kind for hit in hits] == [guard.KIND_MARKER]
    assert hits[0].detail == "社外秘 @ line 2"


def test_ascii_markers_respect_word_boundaries():
    assert guard.scan_text("standard procedure", cfg(), "brief") == []
    assert guard.scan_text("this is under nda now", cfg(), "brief")[0].detail.startswith("NDA @")
    assert guard.scan_text("Confidential - internal", cfg(), "brief")[0].detail.startswith("CONFIDENTIAL @")


def test_marker_hits_are_capped_per_marker():
    text = "機密 " * 10
    hits = guard.scan_text(text, cfg(), "brief")
    assert len(hits) == 3


def test_deny_roots_block_paths_case_insensitively(tmp_path):
    root = tmp_path / "Clients" / "SecretCo"
    root.mkdir(parents=True)
    inside = root / "spec.md"
    inside.write_text("x", encoding="utf-8")
    outside = tmp_path / "public.md"
    outside.write_text("x", encoding="utf-8")
    hits = guard.scan_paths([inside, outside, Path(str(root).upper()) / "other.md"], cfg(deny_roots=[str(root)]))
    assert [hit.kind for hit in hits] == [guard.KIND_DENY_ROOT, guard.KIND_DENY_ROOT]
    assert str(inside) in hits[0].where


def test_size_hit_and_blocking_override():
    hits = guard.scan("社外秘 " + "a" * 30, [], cfg(max_total_chars=20))
    kinds = sorted(hit.kind for hit in hits)
    assert kinds == [guard.KIND_MARKER, guard.KIND_SIZE]
    remaining = guard.blocking(hits, allow_markers=True)
    assert [hit.kind for hit in remaining] == [guard.KIND_SIZE]
    assert len(guard.blocking(hits, allow_markers=False)) == 2


def test_guard_json_merges_over_defaults(tmp_path, monkeypatch):
    target = tmp_path / "guard.json"
    target.write_text(json.dumps({"deny_roots": ["C:/nda"], "markers_ja": ["極秘"]}), encoding="utf-8")
    loaded = guard.load(target)
    assert loaded["deny_roots"] == ["C:/nda"]
    assert loaded["markers_ja"] == ["極秘"]
    assert loaded["markers_ascii"] == guard.DEFAULT_GUARD["markers_ascii"]
    target.write_text(json.dumps({"deny_roots": "not-a-list"}), encoding="utf-8")
    with pytest.raises(ValueError):
        guard.load(target)


def test_shipped_guard_json_loads():
    from oracmux_lib import paths

    loaded = guard.load(paths.guard_json())
    assert "社外秘" in loaded["markers_ja"]
    assert isinstance(loaded["deny_roots"], list)
