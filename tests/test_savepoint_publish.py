from __future__ import annotations

import errno
import json
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import savepoint_publish as sp  # noqa: E402

SESSION_ID = "aaaabbbb-1111-2222-3333-444455556666"
CWD_WIN = "C:\\Users\\alice\\Alice Dropbox\\TeamX\\事務関係\\案件A"
DROPBOX_ROOT = "C:\\Users\\alice\\Alice Dropbox\\TeamX"


def test_rename_with_retry_recovers_from_access_denied(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    src.mkdir()
    original_rename = Path.rename
    attempts = 0
    sleeps: list[float] = []

    def flaky_rename(path: Path, target: Path) -> Path:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise PermissionError(errno.EACCES, "injected access denied", str(path))
        return original_rename(path, target)

    monkeypatch.setattr(Path, "rename", flaky_rename)
    monkeypatch.setattr(sp.time, "sleep", sleeps.append)

    sp._rename_with_retry(src, dst)

    assert attempts == 3
    assert sleeps == [0.05, 0.1]
    assert dst.is_dir()


def test_rename_with_retry_does_not_retry_other_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    src.mkdir()
    attempts = 0
    sleeps: list[float] = []

    def failed_rename(path: Path, target: Path) -> Path:
        nonlocal attempts
        attempts += 1
        raise OSError(errno.ENOSPC, "injected disk full", str(path))

    monkeypatch.setattr(Path, "rename", failed_rename)
    monkeypatch.setattr(sp.time, "sleep", sleeps.append)

    with pytest.raises(OSError) as exc_info:
        sp._rename_with_retry(src, dst)

    assert exc_info.value.errno == errno.ENOSPC
    assert attempts == 1
    assert sleeps == []


@pytest.mark.parametrize(
    ("tag", "expected"),
    [
        (0xA0000003, True),  # junction / mount point
        (0xA000000C, True),  # symbolic link
        (0x9000001A, False),  # Cloud Files placeholder (Dropbox Smart Sync)
        (0, False),
    ],
)
def test_reparse_tag_filter_allows_cloud_placeholders(tag: int, expected: bool) -> None:
    assert sp._is_name_surrogate_reparse_tag(tag) is expected


def _tool_use(name: str, file_path: str) -> dict:
    return {"type": "tool_use", "id": "toolu_x", "name": name, "input": {"file_path": file_path}}


def write_fixture_transcript(projects_dir: Path, cwd: str, session_id: str) -> Path:
    project_dir = projects_dir / sp.sanitize_project_dir(cwd)
    project_dir.mkdir(parents=True, exist_ok=True)
    lines = [
        {"type": "mode", "mode": "normal", "sessionId": session_id},
        {
            "type": "user",
            "cwd": cwd,
            "gitBranch": "master",
            "sessionId": session_id,
            "message": {"role": "user", "content": "第3問の組版を直してほしい"},
        },
        {
            "type": "user",
            "isMeta": True,
            "sessionId": session_id,
            "message": {"role": "user", "content": "<command-name>/model</command-name>"},
        },
        {
            "type": "assistant",
            "cwd": cwd,
            "sessionId": session_id,
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "了解です。原稿を確認します。"},
                    _tool_use("Read", cwd + "\\原稿\\第3問.md"),
                    _tool_use("Edit", cwd + "\\原稿\\第3問.md"),
                    _tool_use("Write", "C:\\Users\\alice\\work\\tmp_note.txt"),
                ],
            },
        },
        {
            "type": "user",
            "cwd": cwd,
            "sessionId": session_id,
            "message": {"role": "user", "content": "ありがとう。図版の差し替えまでやって"},
        },
        {
            "type": "assistant",
            "cwd": cwd,
            "sessionId": session_id,
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "図版差し替えまで完了しました。残りは検版です。"}],
            },
        },
    ]
    path = project_dir / f"{session_id}.jsonl"
    path.write_text("\n".join(json.dumps(line, ensure_ascii=False) for line in lines), encoding="utf-8")
    return path


def run_publish(tmp_path: Path, **overrides: str) -> dict:
    projects_dir = tmp_path / "projects"
    online_dir = tmp_path / "online"
    write_fixture_transcript(projects_dir, CWD_WIN, SESSION_ID)
    argv = [
        "--cwd", CWD_WIN,
        "--session", overrides.pop("session", SESSION_ID),
        "--online-dir", str(online_dir),
        "--dropbox-root", DROPBOX_ROOT,
        "--author", "alice",
        "--machine", "test-pc",
        "--claude-projects-dir", str(projects_dir),
        "--config", str(tmp_path / "no-config.json"),
    ]
    for key, value in overrides.items():
        argv += [f"--{key.replace('_', '-')}", value]
    args = sp.build_parser().parse_args(argv)
    return sp.publish(args)


def test_sanitize_matches_observed_claude_behavior() -> None:
    assert sp.sanitize_project_dir("C:\\Users\\miyaz") == "C--Users-miyaz"
    assert sp.sanitize_project_dir("C:\\Users\\miyaz\\tmp_phase0_savepoint\\a") == (
        "C--Users-miyaz-tmp-phase0-savepoint-a"
    )


def test_publish_bundle_contents(tmp_path: Path) -> None:
    result = run_publish(tmp_path)
    bundle = Path(result["bundle_dir"])
    assert bundle.name == f"alice_{SESSION_ID[:8]}"

    manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["schema"] == 1
    assert manifest["agent_kind"] == "claude"
    assert manifest["agent_session_id"] == SESSION_ID
    assert manifest["claude_session_id"] == SESSION_ID
    assert manifest["cwd"] == "{DROPBOX}/事務関係/案件A"
    assert manifest["git_branch"] == "master"
    assert manifest["lifecycle"]["status"] == "active"
    assert manifest["lifecycle"]["final_checkpoint"] is False
    assert manifest["lifecycle"]["checkpoint_id"] == result["checkpoint_id"]
    assert "{DROPBOX}/事務関係/案件A/原稿/第3問.md" in manifest["files_written"]
    # Dropbox 外パスはトークン化されず warning に載る
    assert any("tmp_note.txt" in w for w in manifest["warnings"])

    handoff = (bundle / "handoff.md").read_text(encoding="utf-8")
    for snippet in [
        "第3問の組版を直してほしい",          # 依頼の始まり
        "図版差し替えまで完了しました",        # 現在地 = 最後の応答
        "{DROPBOX}/事務関係/案件A/原稿/第3問.md",
        "⚠Dropbox外",
        "## 次の一手",
    ]:
        assert snippet in handoff, f"handoff.md に欠落: {snippet}"
    # コマンドラッパー (isMeta) は人間の発話として扱わない
    assert "command-name" not in handoff

    transcript = bundle / "transcript" / f"{SESSION_ID}.jsonl"
    assert transcript.is_file()
    original = tmp_path / "projects" / sp.sanitize_project_dir(CWD_WIN) / f"{SESSION_ID}.jsonl"
    assert transcript.read_bytes() == original.read_bytes()


def test_upsert_keeps_created_at_and_single_entry(tmp_path: Path) -> None:
    first = run_publish(tmp_path)
    manifest1 = json.loads((Path(first["bundle_dir"]) / "manifest.json").read_text(encoding="utf-8"))
    time.sleep(1.1)  # timespec="seconds" のため
    second = run_publish(tmp_path, summary="2回目の公開")
    manifest2 = json.loads((Path(second["bundle_dir"]) / "manifest.json").read_text(encoding="utf-8"))

    assert first["bundle_dir"] == second["bundle_dir"]
    assert manifest2["created_at"] == manifest1["created_at"]
    assert manifest2["updated_at"] > manifest1["updated_at"]
    assert manifest2["summary_line"] == "2回目の公開"
    assert manifest2["lifecycle"]["checkpoint_id"] == manifest1["lifecycle"]["checkpoint_id"]
    online_dir = Path(first["bundle_dir"]).parent
    entries = [p for p in online_dir.iterdir() if p.is_dir()]
    assert len(entries) == 1, f"upsert なのにエントリが増えた: {entries}"


def test_upsert_preserves_pinned(tmp_path: Path) -> None:
    first = run_publish(tmp_path)
    manifest_path = Path(first["bundle_dir"]) / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["pinned"] = True
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    second = run_publish(tmp_path, summary="ピン維持の確認")
    manifest2 = json.loads((Path(second["bundle_dir"]) / "manifest.json").read_text(encoding="utf-8"))
    assert manifest2["pinned"] is True


def test_final_record_is_immutable_and_next_publish_starts_child(tmp_path: Path) -> None:
    current = run_publish(tmp_path)
    finalized = run_publish(tmp_path, record_kind="final")

    assert finalized["record_kind"] == "final"
    assert finalized["checkpoint_id"] == current["checkpoint_id"]
    final_dir = Path(finalized["bundle_dir"])
    assert final_dir.parent.name == sp.FINAL_RECORDS_DIR
    final_manifest = json.loads((final_dir / "manifest.json").read_text(encoding="utf-8"))
    assert final_manifest["lifecycle"]["status"] == "closed"
    assert final_manifest["lifecycle"]["final_checkpoint"] is True
    assert final_manifest["lifecycle"]["closed_reason"] == "manual"
    original_record = (final_dir / "manifest.json").read_bytes()

    repeated = run_publish(tmp_path, record_kind="final", summary="上書きされてはいけない見出し")
    assert repeated["updated"] is True
    assert repeated["summary_line"] == finalized["summary_line"]
    assert repeated["files_read"] == 0
    assert (final_dir / "manifest.json").read_bytes() == original_record

    head_dir = final_dir.parents[1] / f"alice_{SESSION_ID[:8]}"
    head_manifest = json.loads((head_dir / "manifest.json").read_text(encoding="utf-8"))
    assert head_manifest["lifecycle"]["status"] == "closed"
    assert head_manifest["lifecycle"]["final_checkpoint"] is False

    resumed = run_publish(tmp_path, summary="続きの現在地")
    assert resumed["checkpoint_id"] != finalized["checkpoint_id"]
    assert resumed["parent_checkpoint_id"] == finalized["checkpoint_id"]
    resumed_manifest = json.loads((head_dir / "manifest.json").read_text(encoding="utf-8"))
    assert resumed_manifest["lifecycle"]["status"] == "active"

    newer_head = (head_dir / "manifest.json").read_bytes()
    sp.write_head_from_final_record(final_dir, head_dir, final_dir.parents[1])
    assert (head_dir / "manifest.json").read_bytes() == newer_head


def test_finalize_after_trashed_final_starts_new_checkpoint(tmp_path: Path) -> None:
    current = run_publish(tmp_path)
    finalized = run_publish(tmp_path, record_kind="final")
    final_dir = Path(finalized["bundle_dir"])
    online_dir = final_dir.parents[1]
    head_dir = online_dir / f"alice_{SESSION_ID[:8]}"
    trash_dir = online_dir / "_trash" / "11111111-2222-4333-8444-555555555555"
    trash_dir.parent.mkdir()
    sp._rename_with_retry(final_dir, trash_dir)

    head_manifest_path = head_dir / "manifest.json"
    head_manifest = json.loads(head_manifest_path.read_text(encoding="utf-8"))
    head_manifest[sp.TRASHED_FINAL_CHECKPOINT_FIELD] = finalized["checkpoint_id"]
    head_manifest_path.write_text(json.dumps(head_manifest), encoding="utf-8")

    repeated = run_publish(tmp_path, record_kind="final", summary="ゴミ箱移動後の続き")

    assert current["checkpoint_id"] == finalized["checkpoint_id"]
    assert repeated["checkpoint_id"] != finalized["checkpoint_id"]
    assert repeated["parent_checkpoint_id"] == finalized["checkpoint_id"]
    assert trash_dir.is_dir()
    assert Path(repeated["bundle_dir"]).is_dir()
    repaired_head = json.loads(head_manifest_path.read_text(encoding="utf-8"))
    assert sp.TRASHED_FINAL_CHECKPOINT_FIELD not in repaired_head


def test_trashed_final_retry_reuses_bootstrapped_checkpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    finalized = run_publish(tmp_path, record_kind="final")
    final_dir = Path(finalized["bundle_dir"])
    online_dir = final_dir.parents[1]
    head_dir = online_dir / f"alice_{SESSION_ID[:8]}"
    trash_dir = online_dir / "_trash" / "11111111-2222-4333-8444-555555555555"
    trash_dir.parent.mkdir()
    sp._rename_with_retry(final_dir, trash_dir)
    head_manifest_path = head_dir / "manifest.json"
    head_manifest = json.loads(head_manifest_path.read_text(encoding="utf-8"))
    head_manifest[sp.TRASHED_FINAL_CHECKPOINT_FIELD] = finalized["checkpoint_id"]
    head_manifest_path.write_text(json.dumps(head_manifest), encoding="utf-8")

    original_atomic_create_dir = sp.atomic_create_dir
    bootstrapped: dict[str, str] = {}

    def fail_after_bootstrap(_tmp_dir: Path, _target_dir: Path) -> bool:
        bootstrap = json.loads(head_manifest_path.read_text(encoding="utf-8"))
        bootstrapped["checkpoint_id"] = bootstrap["lifecycle"]["checkpoint_id"]
        assert bootstrapped["checkpoint_id"] != finalized["checkpoint_id"]
        assert bootstrap["lifecycle"]["parent_checkpoint_id"] == finalized["checkpoint_id"]
        raise RuntimeError("injected immutable creation failure")

    monkeypatch.setattr(sp, "atomic_create_dir", fail_after_bootstrap)
    with pytest.raises(RuntimeError, match="injected immutable creation failure"):
        run_publish(tmp_path, record_kind="final")
    monkeypatch.setattr(sp, "atomic_create_dir", original_atomic_create_dir)

    repeated = run_publish(tmp_path, record_kind="final")

    assert repeated["checkpoint_id"] == bootstrapped["checkpoint_id"]
    assert repeated["parent_checkpoint_id"] == finalized["checkpoint_id"]
    records = [
        path.name
        for path in (online_dir / sp.FINAL_RECORDS_DIR).iterdir()
        if path.is_dir() and not path.name.startswith(".")
    ]
    assert records == [repeated["checkpoint_id"]]


def test_final_identity_mismatch_is_not_overwritten(tmp_path: Path) -> None:
    current = run_publish(tmp_path)
    online_dir = Path(current["bundle_dir"]).parent
    final_dir = online_dir / sp.FINAL_RECORDS_DIR / current["checkpoint_id"]
    final_dir.mkdir(parents=True)
    mismatch = {
        "schema": 1,
        "agent_kind": "codex",
        "agent_session_id": SESSION_ID,
        "lifecycle": {
            "status": "closed",
            "checkpoint_id": current["checkpoint_id"],
            "final_checkpoint": True,
        },
    }
    manifest_path = final_dir / "manifest.json"
    manifest_path.write_text(json.dumps(mismatch), encoding="utf-8")
    original = manifest_path.read_bytes()

    with pytest.raises(RuntimeError, match="identity mismatch"):
        run_publish(tmp_path, record_kind="final")

    assert manifest_path.read_bytes() == original


def test_current_rotates_when_final_exists_but_head_is_active(tmp_path: Path) -> None:
    current = run_publish(tmp_path)
    finalized = run_publish(tmp_path, record_kind="final")
    final_dir = Path(finalized["bundle_dir"])
    head_dir = final_dir.parents[1] / f"alice_{SESSION_ID[:8]}"
    head_manifest = json.loads((head_dir / "manifest.json").read_text(encoding="utf-8"))
    head_manifest["lifecycle"]["status"] = "active"
    head_manifest["lifecycle"]["final_checkpoint"] = False
    (head_dir / "manifest.json").write_text(json.dumps(head_manifest), encoding="utf-8")

    resumed = run_publish(tmp_path, summary="取りこぼし後の続き")

    assert current["checkpoint_id"] == finalized["checkpoint_id"]
    assert resumed["checkpoint_id"] != finalized["checkpoint_id"]
    assert resumed["parent_checkpoint_id"] == finalized["checkpoint_id"]


def test_finalize_recovers_checkpoint_id_from_interrupted_swap(tmp_path: Path) -> None:
    current = run_publish(tmp_path)
    finalized = run_publish(tmp_path, record_kind="final")
    final_dir = Path(finalized["bundle_dir"])
    head_dir = final_dir.parents[1] / f"alice_{SESSION_ID[:8]}"
    stranded_head = head_dir.with_name(head_dir.name + ".old-crash")
    sp._rename_with_retry(head_dir, stranded_head)

    repeated = run_publish(tmp_path, record_kind="final")

    assert repeated["checkpoint_id"] == current["checkpoint_id"]
    assert repeated["checkpoint_id"] == finalized["checkpoint_id"]
    records = [path for path in final_dir.parent.iterdir() if path.is_dir() and not path.name.startswith(".")]
    assert records == [final_dir]
    repaired = json.loads((head_dir / "manifest.json").read_text(encoding="utf-8"))
    assert repaired["lifecycle"]["status"] == "closed"


def test_final_records_path_must_be_a_real_directory(tmp_path: Path) -> None:
    online_dir = tmp_path / "online"
    online_dir.mkdir()
    (online_dir / sp.FINAL_RECORDS_DIR).write_text("not a directory", encoding="utf-8")

    with pytest.raises(RuntimeError, match="real directory"):
        sp.safe_final_records_dir(online_dir, True)


def test_local_store_resolver_ignores_an_old_shared_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A mycmux pane injects MYCMUX_RUNTIME_DIR; this test models the no-env case.
    monkeypatch.delenv("MYCMUX_RUNTIME_DIR", raising=False)
    home = tmp_path / "home"
    shared = tmp_path / "shared"
    (home / ".mycmux").mkdir(parents=True)
    shared.mkdir()

    resolved = sp.resolve_local_savepoint_dir(
        None,
        {"online_dir": str(shared)},
        home=home,
    )

    assert resolved == home.resolve() / ".mycmux" / "savepoints"


def test_local_store_resolver_uses_the_injected_runtime_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime = tmp_path / "profile-runtime"
    monkeypatch.setenv("MYCMUX_RUNTIME_DIR", str(runtime))

    resolved = sp.resolve_local_savepoint_dir(None, {}, home=tmp_path / "home")

    assert resolved == runtime / "savepoints"


def test_local_store_resolver_reuses_an_existing_mycmux_legacy_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("MYCMUX_RUNTIME_DIR", raising=False)
    home = tmp_path / "home"
    existing = home / ".mycmux" / "online-dev"
    existing.mkdir(parents=True)

    resolved = sp.resolve_local_savepoint_dir(
        None,
        {"online_dir": str(existing)},
        home=home,
    )

    assert resolved == existing.resolve()


def test_latest_picks_most_recent_session(tmp_path: Path) -> None:
    projects_dir = tmp_path / "projects"
    older = "99998888-1111-2222-3333-444455556666"
    write_fixture_transcript(projects_dir, CWD_WIN, older)
    old_file = projects_dir / sp.sanitize_project_dir(CWD_WIN) / f"{older}.jsonl"
    past = time.time() - 3600
    import os

    os.utime(old_file, (past, past))
    result = run_publish(tmp_path, session="latest")
    assert result["session_id"] == SESSION_ID


def test_missing_session_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        run_publish(tmp_path, session="00000000-0000-0000-0000-000000000000")


def test_summary_autogenerated_from_last_prompt(tmp_path: Path) -> None:
    result = run_publish(tmp_path)
    assert result["summary_line"].startswith("ありがとう。図版の差し替え")
