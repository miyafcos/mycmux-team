from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import savepoint_cleanup as sc  # noqa: E402
import savepoint_join as sj  # noqa: E402

JST = timezone(timedelta(hours=9))
SESSION_ID = "aaaabbbb-1111-2222-3333-444455556666"


def make_bundle(
    online_dir: Path,
    name: str = "alice_aaaabbbb",
    *,
    machine: str = "test-pc",
    pinned: bool = False,
    expires_in_hours: float = 48,
    cwd_token: str = "{DROPBOX}/事務関係/案件A",
    checkpoint_id: str | None = None,
    final_checkpoint: bool = False,
) -> Path:
    bundle = online_dir / name
    (bundle / "transcript").mkdir(parents=True)
    now = datetime.now(JST)
    manifest = {
        "schema": 1,
        "author": "alice",
        "machine": machine,
        "created_at": now.isoformat(timespec="seconds"),
        "updated_at": now.isoformat(timespec="seconds"),
        "expires_at": (now + timedelta(hours=expires_in_hours)).isoformat(timespec="seconds"),
        "pinned": pinned,
        "summary_line": "テスト用サマリ",
        "cwd": cwd_token,
        "claude_session_id": SESSION_ID,
        "files_touched": [],
        "files_written": [],
        "warnings": [],
        "lifecycle": {
            "status": "closed" if final_checkpoint else "active",
            "checkpoint_id": checkpoint_id,
            "parent_checkpoint_id": None,
            "final_checkpoint": final_checkpoint,
            "closed_at": now.isoformat(timespec="seconds") if final_checkpoint else None,
            "closed_reason": "manual" if final_checkpoint else None,
        },
    }
    (bundle / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (bundle / "handoff.md").write_text("# 引き継ぎ: テスト\n", encoding="utf-8")
    (bundle / "transcript" / f"{SESSION_ID}.jsonl").write_text(
        json.dumps({"type": "mode", "sessionId": SESSION_ID}) + "\n", encoding="utf-8"
    )
    return bundle


def run_join(tmp_path: Path, bundle: Path, mode: str, dropbox_root: str | None = None) -> dict:
    argv = [
        str(bundle),
        "--mode", mode,
        "--claude-projects-dir", str(tmp_path / "projects"),
        "--config", str(tmp_path / "no-config.json"),
        "--home", str(tmp_path / "home"),
    ]
    if dropbox_root:
        argv += ["--dropbox-root", dropbox_root]
    (tmp_path / "home").mkdir(exist_ok=True)
    return sj.join(sj.build_parser().parse_args(argv))


def convert_bundle_to_codex(bundle: Path) -> None:
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["agent_kind"] = "codex"
    manifest["agent_session_id"] = SESSION_ID
    manifest.pop("claude_session_id")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")


def test_join_full_transplants_with_fresh_uuid(tmp_path: Path) -> None:
    dropbox = tmp_path / "dropbox"
    (dropbox / "事務関係" / "案件A").mkdir(parents=True)
    bundle = make_bundle(tmp_path / "online")
    result = run_join(tmp_path, bundle, "full", dropbox_root=str(dropbox))

    assert result["cwd_missing"] is False
    assert result["resolved_cwd"].endswith("案件A")
    assert result["resume_session_id"] != SESSION_ID, "常に新規UUIDで衝突回避する設計"
    transplanted = Path(result["transplanted_jsonl"])
    assert transplanted.is_file()
    assert transplanted.stem == result["resume_session_id"]
    assert result["command_argv"] == [
        "claude", "--resume", result["resume_session_id"], "--fork-session",
    ]
    # コピー先は展開後 cwd の sanitize 名の project ディレクトリ
    assert transplanted.parent.name == sj.sanitize_project_dir(result["resolved_cwd"])


def test_join_full_uses_home_fallback_when_cwd_missing(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path / "online")  # dropbox_root 未指定 → 展開不能
    result = run_join(tmp_path, bundle, "full")
    assert result["cwd_missing"] is True
    assert result["resolved_cwd"] == str(tmp_path / "home")
    assert result["resume_session_id"] is not None
    assert Path(result["transplanted_jsonl"]).is_file()
    assert result["command_argv"] == [
        "claude", "--resume", result["resume_session_id"], "--fork-session",
    ]
    assert Path(result["transplanted_jsonl"]).parent.name == sj.sanitize_project_dir(
        result["resolved_cwd"]
    )


def test_join_summary_builds_prompt_with_handoff_path(tmp_path: Path) -> None:
    checkpoint_id = "11111111-2222-4333-8444-555555555555"
    bundle = make_bundle(tmp_path / "online", checkpoint_id=checkpoint_id)
    result = run_join(tmp_path, bundle, "summary")
    assert result["handoff_path"].endswith("handoff.md")
    assert result["handoff_path"] in result["initial_prompt"]
    assert result["command_argv"][0] == "claude"
    assert result["source_checkpoint_id"] == checkpoint_id
    assert result["source_agent_kind"] == "claude"
    assert result["source_session_id"] == SESSION_ID


def test_join_summary_accepts_codex_manifest(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path / "online")
    convert_bundle_to_codex(bundle)

    result = run_join(tmp_path, bundle, "summary")

    assert result["source_agent_kind"] == "codex"
    assert result["source_session_id"] == SESSION_ID
    assert result["handoff_path"].endswith("handoff.md")


def test_join_full_refuses_codex_before_copying(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path / "online")
    convert_bundle_to_codex(bundle)

    with pytest.raises(ValueError, match="Codex full restore is supported by the mycmux app"):
        run_join(tmp_path, bundle, "full")

    assert not (tmp_path / "projects").exists()


def test_join_rejects_ambiguous_codex_identity(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path / "online")
    convert_bundle_to_codex(bundle)
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["claude_session_id"] = SESSION_ID
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="エージェント識別子が不正"):
        run_join(tmp_path, bundle, "summary")


def test_join_ignores_invalid_checkpoint_id(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path / "online", checkpoint_id="11111111-2222-4333-8444-555555555555")
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["lifecycle"]["checkpoint_id"] = "../../invalid"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = run_join(tmp_path, bundle, "summary")

    assert result["source_checkpoint_id"] is None


def test_join_defaults_entire_invalid_lifecycle(tmp_path: Path) -> None:
    checkpoint_id = "11111111-2222-4333-8444-555555555555"
    bundle = make_bundle(tmp_path / "online", checkpoint_id=checkpoint_id)
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["lifecycle"]["status"] = "future-status"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = run_join(tmp_path, bundle, "summary")

    assert result["source_checkpoint_id"] is None


def test_join_rejects_unsupported_manifest_schema(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path / "online")
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["schema"] = 2
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="未対応のmanifest schema"):
        run_join(tmp_path, bundle, "summary")


def test_join_rejects_non_string_cwd(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path / "online")
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["cwd"] = ["not", "a", "path"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="必須項目が不正"):
        run_join(tmp_path, bundle, "summary")


def run_cleanup(tmp_path: Path, *, dry_run: bool = True, machine: str = "test-pc") -> dict:
    argv = [
        "--online-dir", str(tmp_path / "online"),
        "--machine", machine,
        "--config", str(tmp_path / "no-config.json"),
    ]
    if dry_run:
        argv.append("--dry-run")
    return sc.cleanup(sc.build_parser().parse_args(argv))


def test_join_and_cleanup_default_configs_follow_the_injected_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime = tmp_path / "profile-runtime"
    monkeypatch.setenv("MYCMUX_RUNTIME_DIR", str(runtime))

    assert sj.build_parser().parse_args(["bundle"]).config == str(runtime / "savepoint.json")
    assert sc.build_parser().parse_args([]).config == str(runtime / "savepoint.json")


def test_cleanup_reports_all_expired_unpinned_in_the_local_store(tmp_path: Path) -> None:
    online = tmp_path / "online"
    expired = make_bundle(online, "alice_expired1", expires_in_hours=-1)
    make_bundle(online, "alice_pinned01", expires_in_hours=-1, pinned=True)
    make_bundle(online, "bob_expired01", expires_in_hours=-1, machine="other-pc")
    make_bundle(online, "alice_alive001", expires_in_hours=48)
    final_expired = make_bundle(
        online / sc.FINAL_RECORDS_DIR,
        "11111111-2222-4333-8444-555555555555",
        expires_in_hours=-1,
        checkpoint_id="11111111-2222-4333-8444-555555555555",
        final_checkpoint=True,
    )

    result = run_cleanup(tmp_path)
    deleted_names = {d["entry"] for d in result["deleted"]}
    assert deleted_names == {
        "alice_expired1",
        "bob_expired01",
        f"{sc.FINAL_RECORDS_DIR}/11111111-2222-4333-8444-555555555555",
    }
    assert expired.exists()
    assert final_expired.exists()
    assert (online / sc.FINAL_RECORDS_DIR).is_dir()
    kept_reasons = {k["entry"]: k["reason"] for k in result["kept"]}
    assert kept_reasons["alice_pinned01"] == "pinned"
    assert kept_reasons["alice_alive001"] == "not-expired"


def test_cleanup_dry_run_deletes_nothing(tmp_path: Path) -> None:
    online = tmp_path / "online"
    expired = make_bundle(online, "alice_expired1", expires_in_hours=-1)
    result = run_cleanup(tmp_path, dry_run=True)
    assert {d["entry"] for d in result["deleted"]} == {"alice_expired1"}
    assert expired.exists(), "dry-run では実削除しない"


def test_cleanup_recognizes_expired_codex_manifest(tmp_path: Path) -> None:
    bundle = make_bundle(
        tmp_path / "online", "alice_codex001", expires_in_hours=-1
    )
    convert_bundle_to_codex(bundle)

    result = run_cleanup(tmp_path)

    assert {item["entry"] for item in result["deleted"]} == {"alice_codex001"}
    assert bundle.exists()


def test_cleanup_reports_stale_tmp_dirs_only_when_old(tmp_path: Path) -> None:
    online = tmp_path / "online"
    fresh_tmp = make_bundle(online, ".alice_x.tmp-deadbeef")
    stale_tmp = make_bundle(online, ".alice_y.tmp-cafebabe")
    unrelated_hidden = online / ".git"
    unrelated_hidden.mkdir()
    unrelated_old = online / "notes.old-copy"
    unrelated_old.mkdir()
    past = time.time() - 2 * 24 * 3600
    import os

    os.utime(stale_tmp, (past, past))
    os.utime(unrelated_hidden, (past, past))
    os.utime(unrelated_old, (past, past))
    result = run_cleanup(tmp_path)
    assert {d["entry"] for d in result["deleted"]} == {".alice_y.tmp-cafebabe"}
    assert fresh_tmp.exists()
    assert stale_tmp.exists()
    assert unrelated_hidden.is_dir()
    assert unrelated_old.is_dir()


def test_cleanup_non_dry_run_is_disabled(tmp_path: Path) -> None:
    expired = make_bundle(tmp_path / "online", "alice_expired1", expires_in_hours=-1)

    with pytest.raises(RuntimeError, match="実削除は無効"):
        run_cleanup(tmp_path, dry_run=False)

    assert expired.exists()


def test_cleanup_missing_online_dir_is_noop(tmp_path: Path) -> None:
    result = run_cleanup(tmp_path)
    assert result["deleted"] == [] and result["kept"] == []


def test_cleanup_keeps_non_object_manifest(tmp_path: Path) -> None:
    bundle = tmp_path / "online" / "invalid-manifest"
    bundle.mkdir(parents=True)
    (bundle / "manifest.json").write_text("[]", encoding="utf-8")

    result = run_cleanup(tmp_path)

    assert {item["entry"]: item["reason"] for item in result["kept"]} == {
        "invalid-manifest": "manifest-unreadable"
    }
    assert bundle.is_dir()
