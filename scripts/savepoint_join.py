"""Online savepoint joiner (Phase 3 core of docs/plans/2026-07-10-online-savepoint-plan.md).

バンドルを受け取り、join に必要な情報を決定的に準備して JSON で返す。
mycmux の「引き継ぎ記録」画面は、この出力を使って作業を再開する。

modes:
    summary ... 新規セッション用: 展開済み cwd + handoff.md を読ませる初期プロンプト
    full    ... 会話ごと続ける: transcript を join 側 project ディレクトリへ新規 UUID 名でコピーし、
                `claude --resume <UUID> --fork-session` コマンドを返す (Phase 0 実証済みの2手)
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any

from savepoint_publish import (
    DROPBOX_TOKEN,
    SCHEMA_VERSION,
    lifecycle_from_manifest,
    load_config,
    manifest_identity,
    norm_slashes,
    sanitize_project_dir,
)

# Must stay byte-identical to onlineStrings.ts joinPrompt (modulo the
# placeholder), see tests/test_savepoint_drag_contract.py.
SUMMARY_PROMPT_TEMPLATE = (
    "引き継ぎ書 {handoff} を Read ツールで読んでください。"
    "読んだら、(1) 何の作業か（目的と現在地） (2) 前提・制約 (3) 未確定・要確認の点 "
    "(4) そのまま進める場合の次の一手（案） の4点だけを簡潔に提示し、"
    "そこで止まってこちらの指示を待ってください。"
    "指示があるまでファイルの変更・コマンド実行はしないでください。"
)


def read_manifest(bundle_dir: Path) -> dict[str, Any]:
    manifest_path = bundle_dir / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"manifest.json がありません: {bundle_dir}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError(f"manifest.json が不正です: {manifest_path}")
    if type(manifest.get("schema")) is not int or manifest["schema"] != SCHEMA_VERSION:
        raise ValueError(f"未対応のmanifest schemaです: {manifest_path}")
    required_strings = (
        "author",
        "machine",
        "created_at",
        "updated_at",
        "expires_at",
        "summary_line",
        "cwd",
    )
    if any(not isinstance(manifest.get(field), str) for field in required_strings):
        raise ValueError(f"manifest.json の必須項目が不正です: {manifest_path}")
    if "pinned" in manifest and type(manifest["pinned"]) is not bool:
        raise ValueError(f"manifest.json の pinned が不正です: {manifest_path}")
    for field in ("files_written", "warnings"):
        value = manifest.get(field, [])
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            raise ValueError(f"manifest.json の {field} が不正です: {manifest_path}")
    try:
        manifest_identity(manifest)
    except ValueError as error:
        raise ValueError(f"manifest.json のエージェント識別子が不正です: {manifest_path}") from error
    return manifest


def expand_cwd(cwd_token: str | None, dropbox_root: str | None, home: Path) -> tuple[str, bool]:
    """{DROPBOX} トークンを自機パスへ展開。実在しなければ home へフォールバック。

    戻り値: (解決済み cwd, cwd_missing)
    """
    if not cwd_token:
        return str(home), True
    candidate = cwd_token
    if candidate.startswith(DROPBOX_TOKEN):
        if not dropbox_root:
            return str(home), True
        candidate = norm_slashes(dropbox_root).rstrip("/") + candidate[len(DROPBOX_TOKEN):]
    if Path(candidate).is_dir():
        return candidate, False
    return str(home), True


def find_transcript(bundle_dir: Path) -> Path:
    transcripts = sorted((bundle_dir / "transcript").glob("*.jsonl"))
    if not transcripts:
        raise FileNotFoundError(f"transcript/*.jsonl がありません: {bundle_dir}")
    return transcripts[0]


def prepare_summary(bundle_dir: Path, resolved_cwd: str, cwd_missing: bool) -> dict[str, Any]:
    handoff = bundle_dir / "handoff.md"
    if not handoff.is_file():
        raise FileNotFoundError(f"handoff.md がありません: {bundle_dir}")
    handoff_path = norm_slashes(str(handoff))
    prompt = SUMMARY_PROMPT_TEMPLATE.format(handoff=handoff_path)
    return {
        "mode": "summary",
        "resolved_cwd": resolved_cwd,
        "cwd_missing": cwd_missing,
        "handoff_path": handoff_path,
        "initial_prompt": prompt,
        "command_argv": ["claude", prompt],
    }


def prepare_full(
    bundle_dir: Path, resolved_cwd: str, cwd_missing: bool, projects_dir: Path
) -> dict[str, Any]:
    transcript = find_transcript(bundle_dir)
    project_dir = projects_dir / sanitize_project_dir(resolved_cwd)
    project_dir.mkdir(parents=True, exist_ok=True)
    # 常に新規 UUID 名でコピー = ID 衝突が構造的に起きない (Phase 0 でファイル名が正と実証済み)
    resume_id = str(uuid.uuid4())
    target = project_dir / f"{resume_id}.jsonl"
    shutil.copy2(transcript, target)
    return {
        "mode": "full",
        "resolved_cwd": resolved_cwd,
        "cwd_missing": cwd_missing,
        "resume_session_id": resume_id,
        "transplanted_jsonl": norm_slashes(str(target)),
        "command_argv": ["claude", "--resume", resume_id, "--fork-session"],
    }


def join(args: argparse.Namespace) -> dict[str, Any]:
    config = load_config(Path(args.config).expanduser())
    dropbox_root = args.dropbox_root or config.get("dropbox_root")
    bundle_dir = Path(args.bundle_dir)
    manifest = read_manifest(bundle_dir)
    source_agent_kind, source_session_id = manifest_identity(manifest)
    if args.mode == "full" and source_agent_kind != "claude":
        raise ValueError(
            "Codex full restore is supported by the mycmux app, not this Claude-only CLI"
        )
    home = Path(args.home).expanduser() if args.home else Path.home()
    resolved_cwd, cwd_missing = expand_cwd(manifest.get("cwd"), dropbox_root, home)
    if args.mode == "summary":
        result = prepare_summary(bundle_dir, resolved_cwd, cwd_missing)
    else:
        result = prepare_full(
            bundle_dir, resolved_cwd, cwd_missing, Path(args.claude_projects_dir).expanduser()
        )
    result["source_agent_kind"] = source_agent_kind
    result["source_session_id"] = source_session_id
    result["source_checkpoint_id"] = lifecycle_from_manifest(manifest)["checkpoint_id"]
    result["summary_line"] = manifest.get("summary_line")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="引き継ぎ記録から作業を続ける準備をする")
    parser.add_argument("bundle_dir", help="バンドルフォルダのパス")
    parser.add_argument("--mode", choices=["summary", "full"], default="summary")
    parser.add_argument("--dropbox-root", help="自機の Dropbox ルート (既定: config)")
    parser.add_argument("--config", default="~/.mycmux/savepoint.json")
    parser.add_argument("--claude-projects-dir", default=str(Path.home() / ".claude" / "projects"))
    parser.add_argument("--home", help="cwd フォールバック先 (テスト用・既定: ホーム)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    print(json.dumps(join(args), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
