"""Online savepoint publisher (Phase 1 of docs/plans/2026-07-10-online-savepoint-plan.md).

Claude Code の作業をローカルの「引き継ぎ記録」として保存する CLI。

bundle layout:
    <online-dir>/<author>_<session-id 先頭8桁>/  ... 更新可能な作業途中の記録
        manifest.json   ... metadata (schema v1)
        handoff.md      ... 引き継ぎ要約 (人間可読・要約モード join の注入元)
        transcript/<session-id>.jsonl
    <online-dir>/_records/<checkpoint-id>/      ... 変更しない終了時の記録

upsert: 同じ作業の再保存は同フォルダを atomic swap で上書き (created_at は維持)。
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import platform
import re
import shutil
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
DEFAULT_EXPIRE_HOURS = 48
FINAL_RECORDS_DIR = "_records"
TRASHED_FINAL_CHECKPOINT_FIELD = "trashed_final_checkpoint"
RECORD_KINDS = ("current", "final")
CLOSE_REASONS = ("manual", "tab_closed", "pane_closed", "workspace_closed", "app_closed")
FILE_PATH_TOOLS = {"Read", "Write", "Edit", "MultiEdit", "NotebookEdit"}
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
DROPBOX_TOKEN = "{DROPBOX}"
IO_REPARSE_TAG_NAME_SURROGATE = 0x20000000


def resolve_local_savepoint_dir(
    explicit_dir: str | None,
    config: dict[str, Any],
    *,
    home: Path | None = None,
) -> Path:
    """Resolve the local-first store while preserving an old local mycmux path."""
    if explicit_dir:
        return Path(explicit_dir).expanduser()

    configured_local = config.get("local_dir")
    if isinstance(configured_local, str) and configured_local.strip():
        candidate = Path(configured_local).expanduser()
        if candidate.is_absolute():
            return candidate

    home = (home or Path.home()).resolve()
    default = home / ".mycmux" / "savepoints"
    legacy = config.get("online_dir")
    if isinstance(legacy, str) and legacy.strip():
        candidate = Path(legacy).expanduser()
        try:
            resolved = candidate.resolve(strict=True)
            mycmux_home = (home / ".mycmux").resolve(strict=True)
            if resolved.is_dir() and resolved.is_relative_to(mycmux_home):
                return resolved
        except OSError:
            pass
    return default


def now_jst() -> datetime:
    return datetime.now(timezone(timedelta(hours=9)))


def sanitize_project_dir(cwd: str) -> str:
    """Claude Code の project ディレクトリ名変換 (非英数字 -> '-')。

    例: C:\\Users\\miyaz\\tmp_x -> C--Users-miyaz-tmp-x (Phase 0 実測で確認済み)
    """
    return re.sub(r"[^A-Za-z0-9]", "-", cwd.rstrip("/\\"))


def norm_slashes(path: str) -> str:
    return path.replace("\\", "/")


def manifest_identity(manifest: dict[str, Any]) -> tuple[str, str]:
    """Return a strict, backward-compatible savepoint agent identity."""
    generic_kind = manifest.get("agent_kind")
    generic_id_raw = manifest.get("agent_session_id")
    legacy_id_raw = manifest.get("claude_session_id")
    generic_id = generic_id_raw.strip() if isinstance(generic_id_raw, str) else None
    legacy_id = legacy_id_raw.strip() if isinstance(legacy_id_raw, str) else None
    generic_id = generic_id or None
    legacy_id = legacy_id or None

    if generic_kind is None and generic_id is None and legacy_id is not None:
        return ("claude", legacy_id)
    if (
        generic_kind == "claude"
        and generic_id is not None
        and legacy_id == generic_id
    ):
        return ("claude", generic_id)
    if generic_kind == "codex" and generic_id is not None and legacy_id is None:
        return ("codex", generic_id)
    raise ValueError("Savepoint agent identity is invalid")


@dataclass
class SessionDigest:
    session_id: str
    cwd: str | None = None
    git_branch: str | None = None
    user_prompts: list[str] = field(default_factory=list)
    last_assistant_text: str = ""
    files_read: list[str] = field(default_factory=list)
    files_written: list[str] = field(default_factory=list)
    turn_count: int = 0


def _iter_content_blocks(entry: dict[str, Any]) -> list[dict[str, Any]]:
    message = entry.get("message")
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def _user_text(entry: dict[str, Any]) -> str | None:
    if entry.get("type") != "user" or entry.get("isMeta"):
        return None
    message = entry.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    text: str | None = None
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        text = "\n".join(p for p in parts if p) or None
    if not text:
        return None
    stripped = text.strip()
    # skill/コマンド起動のラッパーや tool_result 行は人間の発話ではないので除外
    if stripped.startswith("<command-name>") or stripped.startswith("<local-command"):
        return None
    return stripped


def digest_transcript(jsonl_path: Path, session_id: str) -> SessionDigest:
    digest = SessionDigest(session_id=session_id)
    seen_read: set[str] = set()
    seen_written: set[str] = set()
    with jsonl_path.open(encoding="utf-8") as fh:
        for line in fh:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(entry, dict):
                continue
            if isinstance(entry.get("cwd"), str):
                digest.cwd = entry["cwd"]
            if isinstance(entry.get("gitBranch"), str) and entry["gitBranch"]:
                digest.git_branch = entry["gitBranch"]
            user_text = _user_text(entry)
            if user_text:
                digest.user_prompts.append(user_text)
                digest.turn_count += 1
            if entry.get("type") == "assistant":
                for block in _iter_content_blocks(entry):
                    btype = block.get("type")
                    if btype == "text" and block.get("text"):
                        digest.last_assistant_text = str(block["text"])
                    elif btype == "tool_use" and block.get("name") in FILE_PATH_TOOLS:
                        file_path = (block.get("input") or {}).get("file_path")
                        if not isinstance(file_path, str) or not file_path:
                            continue
                        if block["name"] in WRITE_TOOLS:
                            if file_path not in seen_written:
                                seen_written.add(file_path)
                                digest.files_written.append(file_path)
                        elif file_path not in seen_read:
                            seen_read.add(file_path)
                            digest.files_read.append(file_path)
    return digest


@dataclass
class PathMapper:
    dropbox_root: str | None

    def tokenize(self, path: str) -> tuple[str, bool]:
        """絶対パスを {DROPBOX} トークン形式へ。戻り値 (パス, Dropbox内かどうか)。"""
        normalized = norm_slashes(path)
        if self.dropbox_root:
            root = norm_slashes(self.dropbox_root).rstrip("/")
            if normalized.lower().startswith(root.lower() + "/"):
                return DROPBOX_TOKEN + normalized[len(root):], True
            if normalized.lower() == root.lower():
                return DROPBOX_TOKEN, True
        return normalized, False


def detect_dropbox_root() -> str | None:
    home = Path.home()
    candidates = [home / "Dropbox"]
    # 会社アカウント形式 "<名前> Dropbox/<チーム名>" にも対応
    candidates.extend(sorted(home.glob("* Dropbox/*/")))
    for candidate in candidates:
        if candidate.is_dir():
            return str(candidate)
    return None


def load_config(config_path: Path) -> dict[str, Any]:
    if config_path.is_file():
        try:
            loaded = json.loads(config_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                return loaded
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def locate_transcript(projects_dir: Path, cwd: str, session: str) -> tuple[Path, str]:
    """(jsonl パス, session_id) を返す。session='latest' は当該 cwd の最新セッション。"""
    project_dir = projects_dir / sanitize_project_dir(cwd)
    if session == "latest":
        if not project_dir.is_dir():
            raise FileNotFoundError(f"project ディレクトリがありません: {project_dir}")
        jsonls = sorted(project_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not jsonls:
            raise FileNotFoundError(f"セッション jsonl が見つかりません: {project_dir}")
        return jsonls[0], jsonls[0].stem
    candidate = project_dir / f"{session}.jsonl"
    if candidate.is_file():
        return candidate, session
    # cwd の sanitize 結果と実際の置き場所がずれた場合の保険: 全 project を横断検索
    for fallback in projects_dir.glob(f"*/{session}.jsonl"):
        return fallback, session
    raise FileNotFoundError(f"セッション {session} の jsonl が見つかりません ({projects_dir} 配下)")


def truncate(text: str, limit: int) -> str:
    flattened = " ".join(text.split())
    return flattened if len(flattened) <= limit else flattened[: limit - 1] + "…"


def build_summary_line(explicit: str | None, digest: SessionDigest) -> str:
    if explicit:
        return truncate(explicit, 80)
    if digest.user_prompts:
        return truncate(digest.user_prompts[-1], 80)
    return "(サマリ未設定)"


def build_handoff_md(
    digest: SessionDigest,
    mapper: PathMapper,
    summary_line: str,
    author: str,
    next_step: str | None,
) -> tuple[str, list[str]]:
    warnings: list[str] = []

    def render_paths(paths: list[str]) -> list[str]:
        lines = []
        for raw in paths:
            tokenized, inside = mapper.tokenize(raw)
            if not inside:
                warnings.append(f"{tokenized} は Dropbox 外 (相手側に存在しない可能性)")
            lines.append(f"- `{tokenized}`" + ("" if inside else " ⚠Dropbox外"))
        return lines

    cwd_line = "(不明)"
    if digest.cwd:
        cwd_token, cwd_inside = mapper.tokenize(digest.cwd)
        cwd_line = f"`{cwd_token}`" + ("" if cwd_inside else " ⚠Dropbox外")
        if not cwd_inside:
            warnings.append(f"作業ディレクトリ {cwd_token} は Dropbox 外")

    first_prompt = truncate(digest.user_prompts[0], 300) if digest.user_prompts else "(記録なし)"
    last_assistant = truncate(digest.last_assistant_text, 600) if digest.last_assistant_text else "(記録なし)"

    lines: list[str] = [
        f"# 引き継ぎ: {summary_line}",
        "",
        f"- 記録者: {author} / やり取り {digest.turn_count} 往復",
        f"- 作業ディレクトリ: {cwd_line}",
    ]
    if digest.git_branch:
        lines.append(f"- git ブランチ: `{digest.git_branch}`")
    lines += [
        "",
        "## 依頼の始まり (最初の指示)",
        first_prompt,
        "",
        "## 現在地 (最後の応答の要旨)",
        last_assistant,
        "",
        "## 次の一手",
        next_step or "(記録者が未記入 — 会話ごと続ける場合は、会話の続きから確認してください)",
        "",
        "## 変更したファイル",
    ]
    lines += render_paths(digest.files_written) or ["- (なし)"]
    lines += ["", "## 参照したファイル"]
    lines += render_paths(digest.files_read) or ["- (なし)"]
    lines += [
        "",
        "## 環境の前提",
        "- 会話の記憶は引き継がれますが、記録者のマシンにあるツール・MCP・権限は付いてきません。",
        "- パスの `{DROPBOX}` はあなたのローカル Dropbox ルートに読み替えてください (mycmux は自動展開)。",
        "",
    ]
    return "\n".join(lines), warnings


def atomic_swap_dir(tmp_dir: Path, target_dir: Path) -> None:
    """tmp_dir を target_dir へ入れ替える (受け手が読取り中でも壊れないように)。"""
    old_dir = target_dir.parent / (target_dir.name + f".old-{os.getpid()}-{uuid.uuid4().hex[:8]}")
    if target_dir.exists():
        target_dir.rename(old_dir)
    try:
        tmp_dir.rename(target_dir)
    except OSError:
        if old_dir.exists():  # 失敗時は旧版を戻す
            old_dir.rename(target_dir)
        raise
    if old_dir.exists():
        shutil.rmtree(old_dir, ignore_errors=True)


def atomic_create_dir(tmp_dir: Path, target_dir: Path) -> bool:
    """tmp_dir を未作成の target_dir として確定する。既存の終了記録は上書きしない。"""
    if target_dir.exists():
        return False
    try:
        tmp_dir.rename(target_dir)
    except OSError:
        if target_dir.exists():
            return False
        raise
    return True


def _normalized_checkpoint_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        return None
    return str(parsed)


def _default_lifecycle() -> dict[str, Any]:
    return {
        "status": "interrupted",
        "checkpoint_id": None,
        "parent_checkpoint_id": None,
        "final_checkpoint": False,
        "closed_at": None,
        "closed_reason": None,
    }


def lifecycle_from_manifest(manifest: dict[str, Any] | None) -> dict[str, Any]:
    raw = manifest.get("lifecycle") if isinstance(manifest, dict) else None
    if not isinstance(raw, dict):
        return _default_lifecycle()
    status = raw.get("status", "interrupted")
    if status not in {"active", "interrupted", "closed"}:
        return _default_lifecycle()
    for key in ("checkpoint_id", "parent_checkpoint_id", "closed_at", "closed_reason"):
        if raw.get(key) is not None and not isinstance(raw.get(key), str):
            return _default_lifecycle()
    final_checkpoint = raw.get("final_checkpoint", False)
    if not isinstance(final_checkpoint, bool):
        return _default_lifecycle()
    return {
        "status": status,
        "checkpoint_id": _normalized_checkpoint_id(raw.get("checkpoint_id")),
        "parent_checkpoint_id": _normalized_checkpoint_id(raw.get("parent_checkpoint_id")),
        "final_checkpoint": final_checkpoint,
        "closed_at": raw.get("closed_at"),
        "closed_reason": raw.get("closed_reason"),
    }


def read_manifest_if_valid(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return value if isinstance(value, dict) else None


def read_head_manifest_with_recovery(head_dir: Path) -> dict[str, Any] | None:
    direct = read_manifest_if_valid(head_dir / "manifest.json")
    if direct is not None:
        return direct
    def modified_time(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0

    candidates = sorted(head_dir.parent.glob(f"{head_dir.name}.old-*"), key=modified_time, reverse=True)
    for candidate in candidates:
        if not candidate.is_dir() or is_link_or_junction(candidate):
            continue
        recovered = read_manifest_if_valid(candidate / "manifest.json")
        if lifecycle_from_manifest(recovered)["checkpoint_id"] is not None:
            return recovered
    return None


def _is_name_surrogate_reparse_tag(tag: Any) -> bool:
    return type(tag) is int and bool(tag & IO_REPARSE_TAG_NAME_SURROGATE)


def is_link_or_junction(path: Path) -> bool:
    try:
        metadata = path.lstat()
        return path.is_symlink() or _is_name_surrogate_reparse_tag(
            getattr(metadata, "st_reparse_tag", 0)
        )
    except OSError:
        return True


def safe_final_records_dir(online_dir: Path, create: bool) -> Path | None:
    online_root = online_dir.resolve(strict=True)
    candidate = online_root / FINAL_RECORDS_DIR
    if candidate.exists():
        if is_link_or_junction(candidate) or not candidate.is_dir():
            raise RuntimeError(f"Final records path must be a real directory: {candidate}")
    elif create:
        try:
            candidate.mkdir()
        except FileExistsError:
            pass
    else:
        return None
    records_root = candidate.resolve(strict=True)
    if (
        records_root != candidate
        or records_root.parent != online_root
        or is_link_or_junction(candidate)
    ):
        raise RuntimeError(f"Final records path escapes {online_root}")
    return records_root


def write_bundle_temp(
    tmp_dir: Path,
    manifest: dict[str, Any],
    handoff_md: str,
    transcript_path: Path,
) -> None:
    (tmp_dir / "transcript").mkdir(parents=True)
    (tmp_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (tmp_dir / "handoff.md").write_text(handoff_md, encoding="utf-8")
    shutil.copy2(transcript_path, tmp_dir / "transcript" / transcript_path.name)


def validate_final_record(
    manifest: dict[str, Any], target_dir: Path, session_id: str, checkpoint_id: str
) -> None:
    lifecycle = lifecycle_from_manifest(manifest)
    try:
        identity = manifest_identity(manifest)
    except ValueError:
        identity = None
    if (
        identity != ("claude", session_id)
        or lifecycle["status"] != "closed"
        or not lifecycle["final_checkpoint"]
        or lifecycle["checkpoint_id"] != checkpoint_id
    ):
        raise RuntimeError(f"Immutable record identity mismatch: {target_dir}")


def write_head_from_final_record(
    final_dir: Path,
    head_dir: Path,
    online_dir: Path,
) -> dict[str, Any]:
    """確定済みの終了記録を正として、更新可能な現在地を closed 状態へ収束させる。"""
    final_manifest = read_manifest_if_valid(final_dir / "manifest.json")
    if final_manifest is None:
        raise RuntimeError(f"Immutable record manifest is unreadable: {final_dir}")
    final_lifecycle = lifecycle_from_manifest(final_manifest)
    current_head = read_manifest_if_valid(head_dir / "manifest.json")
    current_head_lifecycle = lifecycle_from_manifest(current_head)
    current_head_id = current_head_lifecycle["checkpoint_id"]
    replaces_trashed_parent = bool(
        current_head is not None
        and current_head_id
        and current_head.get(TRASHED_FINAL_CHECKPOINT_FIELD) == current_head_id
        and final_lifecycle["parent_checkpoint_id"] == current_head_id
    )
    if (
        current_head is not None
        and current_head_id not in {None, final_lifecycle["checkpoint_id"]}
        and not replaces_trashed_parent
    ):
        return final_manifest
    head_manifest = dict(final_manifest)
    head_manifest["lifecycle"] = {**final_lifecycle, "final_checkpoint": False}
    handoff_md = (final_dir / "handoff.md").read_text(encoding="utf-8")
    transcripts = sorted((final_dir / "transcript").glob("*.jsonl"))
    if not transcripts:
        raise FileNotFoundError(f"transcript/*.jsonl がありません: {final_dir}")
    head_tmp = online_dir / f".{head_dir.name}.tmp-{uuid.uuid4().hex[:8]}"
    try:
        write_bundle_temp(head_tmp, head_manifest, handoff_md, transcripts[0])
        atomic_swap_dir(head_tmp, head_dir)
    finally:
        if head_tmp.exists():
            shutil.rmtree(head_tmp, ignore_errors=True)
    return final_manifest


def publish(args: argparse.Namespace) -> dict[str, Any]:
    config = load_config(Path(args.config).expanduser())
    dropbox_root = args.dropbox_root or config.get("dropbox_root") or detect_dropbox_root()
    online_dir_raw = str(resolve_local_savepoint_dir(args.online_dir, config))
    author = args.author or config.get("author") or getpass.getuser()
    machine = args.machine or config.get("machine") or platform.node()
    projects_dir = Path(args.claude_projects_dir).expanduser()
    cwd = args.cwd or os.getcwd()

    jsonl_path, session_id = locate_transcript(projects_dir, cwd, args.session)
    digest = digest_transcript(jsonl_path, session_id)
    mapper = PathMapper(dropbox_root=dropbox_root)
    summary_line = build_summary_line(args.summary, digest)
    handoff_md, warnings = build_handoff_md(digest, mapper, summary_line, author, args.next_step)

    online_dir = Path(online_dir_raw).expanduser()
    online_dir.mkdir(parents=True, exist_ok=True)
    online_dir = online_dir.resolve(strict=True)
    final_records_dir = safe_final_records_dir(online_dir, args.record_kind == "final")
    author_slug = re.sub(r"[^A-Za-z0-9]", "-", author) or "user"
    head_dir = online_dir / f"{author_slug}_{session_id[:8]}"

    updated_at = now_jst()
    updated_at_text = updated_at.isoformat(timespec="seconds")
    previous = read_head_manifest_with_recovery(head_dir)
    previous_lifecycle = lifecycle_from_manifest(previous)
    previous_checkpoint_id = previous_lifecycle["checkpoint_id"]
    previous_final_exists = bool(
        previous_checkpoint_id
        and final_records_dir is not None
        and (final_records_dir / previous_checkpoint_id).exists()
    )
    previous_final_was_trashed = bool(
        previous_checkpoint_id
        and (previous or {}).get(TRASHED_FINAL_CHECKPOINT_FIELD) == previous_checkpoint_id
    )
    starts_new_generation = (
        args.record_kind == "current"
        and (previous_lifecycle["status"] == "closed" or previous_final_exists)
    ) or (
        args.record_kind == "final" and previous_final_was_trashed
    )
    checkpoint_id = (
        str(uuid.uuid4())
        if starts_new_generation
        else previous_lifecycle["checkpoint_id"] or str(uuid.uuid4())
    )
    parent_checkpoint_id = (
        previous_lifecycle["checkpoint_id"]
        if starts_new_generation
        else previous_lifecycle["parent_checkpoint_id"]
    )
    previous_created_at = (previous or {}).get("created_at")
    created_at = (
        updated_at_text
        if starts_new_generation or not isinstance(previous_created_at, str)
        else previous_created_at
    )
    previous_pinned = (previous or {}).get("pinned")
    pinned = previous_pinned if isinstance(previous_pinned, bool) else False
    if args.record_kind == "current":
        target_dir = head_dir
    else:
        if final_records_dir is None:
            raise RuntimeError("Final records directory was not created")
        target_dir = final_records_dir / checkpoint_id
    updated = (target_dir / "manifest.json").is_file()

    cwd_token = mapper.tokenize(digest.cwd)[0] if digest.cwd else norm_slashes(cwd)
    lifecycle = {
        "status": "active" if args.record_kind == "current" else "closed",
        "checkpoint_id": checkpoint_id,
        "parent_checkpoint_id": parent_checkpoint_id,
        "final_checkpoint": args.record_kind == "final",
        "closed_at": updated_at_text if args.record_kind == "final" else None,
        "closed_reason": args.close_reason if args.record_kind == "final" else None,
    }
    manifest: dict[str, Any] = {
        "schema": SCHEMA_VERSION,
        "author": author,
        "machine": machine,
        "created_at": created_at,
        "updated_at": updated_at_text,
        "expires_at": (updated_at + timedelta(hours=args.expire_hours)).isoformat(timespec="seconds"),
        "pinned": pinned,
        "summary_line": summary_line,
        "cwd": cwd_token,
        "agent_kind": "claude",
        "agent_session_id": session_id,
        "claude_session_id": session_id,
        "files_touched": [mapper.tokenize(p)[0] for p in digest.files_written + digest.files_read],
        "files_written": [mapper.tokenize(p)[0] for p in digest.files_written],
        "git_branch": digest.git_branch,
        "warnings": warnings,
        "lifecycle": lifecycle,
    }

    if args.record_kind == "final" and (
        previous_lifecycle["checkpoint_id"] is None or starts_new_generation
    ):
        # Persist the generated identity before immutable creation so a retry
        # after an interrupted finalize resolves to the same checkpoint.
        bootstrap_manifest = dict(manifest)
        bootstrap_manifest["lifecycle"] = {
            "status": "active",
            "checkpoint_id": checkpoint_id,
            "parent_checkpoint_id": parent_checkpoint_id,
            "final_checkpoint": False,
            "closed_at": None,
            "closed_reason": None,
        }
        bootstrap_tmp = online_dir / f".{head_dir.name}.tmp-{uuid.uuid4().hex[:8]}"
        try:
            write_bundle_temp(bootstrap_tmp, bootstrap_manifest, handoff_md, jsonl_path)
            atomic_swap_dir(bootstrap_tmp, head_dir)
        finally:
            if bootstrap_tmp.exists():
                shutil.rmtree(bootstrap_tmp, ignore_errors=True)

    target_dir.parent.mkdir(parents=True, exist_ok=True)
    used_existing_final = False
    tmp_dir = target_dir.parent / f".{target_dir.name}.tmp-{uuid.uuid4().hex[:8]}"
    try:
        write_bundle_temp(tmp_dir, manifest, handoff_md, jsonl_path)
        if args.record_kind == "current":
            latest_final_records_dir = safe_final_records_dir(online_dir, False)
            if (
                latest_final_records_dir is not None
                and (latest_final_records_dir / checkpoint_id).exists()
            ):
                raise RuntimeError(
                    "This checkpoint was finalized while saving. Retry the current save."
                )
            atomic_swap_dir(tmp_dir, target_dir)
        else:
            created = atomic_create_dir(tmp_dir, target_dir)
            actual_manifest = read_manifest_if_valid(target_dir / "manifest.json")
            if actual_manifest is None:
                raise RuntimeError(f"Immutable record manifest is unreadable: {target_dir}")
            validate_final_record(actual_manifest, target_dir, session_id, checkpoint_id)
            manifest = write_head_from_final_record(target_dir, head_dir, online_dir)
            used_existing_final = not created
            updated = updated or used_existing_final
    finally:
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)

    result_lifecycle = lifecycle_from_manifest(manifest)
    result_summary = manifest.get("summary_line")
    result_files_written = manifest.get("files_written")
    return {
        "bundle_dir": str(target_dir),
        "session_id": session_id,
        "summary_line": result_summary if isinstance(result_summary, str) else summary_line,
        "files_written": (
            len(result_files_written) if isinstance(result_files_written, list) else len(digest.files_written)
        ),
        "files_read": 0 if used_existing_final else len(digest.files_read),
        "warnings": manifest.get("warnings") if isinstance(manifest.get("warnings"), list) else warnings,
        "updated": updated,
        "record_kind": args.record_kind,
        "checkpoint_id": result_lifecycle["checkpoint_id"] or checkpoint_id,
        "parent_checkpoint_id": result_lifecycle["parent_checkpoint_id"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Claude Code セッションを引き継ぎ記録として保存する")
    parser.add_argument("--cwd", help="セッションの作業ディレクトリ (既定: カレント)")
    parser.add_argument("--session", default="latest", help="セッションID または latest (既定)")
    parser.add_argument("--online-dir", help="保存先を明示指定 (既定: mycmux のローカル保存先)")
    parser.add_argument("--dropbox-root", help="自機の Dropbox ルート (既定: 自動検出)")
    parser.add_argument("--author", help="記録者の表示名 (既定: config → OSユーザー名)")
    parser.add_argument("--machine", help="マシン名 (既定: hostname)")
    parser.add_argument("--summary", help="一覧に出すサマリ1行 (既定: 最後の指示から自動生成)")
    parser.add_argument("--next-step", help="handoff.md の「次の一手」欄")
    parser.add_argument("--expire-hours", type=int, default=DEFAULT_EXPIRE_HOURS)
    parser.add_argument("--record-kind", choices=RECORD_KINDS, default="current")
    parser.add_argument("--close-reason", choices=CLOSE_REASONS, default="manual")
    parser.add_argument("--config", default="~/.mycmux/savepoint.json")
    parser.add_argument("--claude-projects-dir", default=str(Path.home() / ".claude" / "projects"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result = publish(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
