"""Online savepoint cleanup (Phase 3 of docs/plans/2026-07-10-online-savepoint-plan.md).

期限切れの引き継ぎ記録を読み取り専用で確認する。

実削除は、publisherと同じロックを持ち、期限切れデータをゴミ箱へ移す
mycmuxアプリ内のcleanupへ一本化した。このCLIは --dry-run のみ受け付ける。
"""

from __future__ import annotations

import argparse
import json
import platform
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from savepoint_publish import (
    FINAL_RECORDS_DIR,
    SCHEMA_VERSION,
    is_link_or_junction,
    load_config,
    manifest_identity,
    resolve_local_savepoint_dir,
    safe_final_records_dir,
)

STALE_TMP_SECONDS = 24 * 3600


def is_generated_publish_artifact_name(name: str) -> bool:
    return bool(
        re.fullmatch(r"\..+\.tmp-(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{32})", name)
        or re.fullmatch(r".+\.old-\d+-[0-9a-fA-F]{8}", name)
    )


def is_savepoint_manifest(value: Any) -> bool:
    if (
        not isinstance(value, dict)
        or type(value.get("schema")) is not int
        or value["schema"] != SCHEMA_VERSION
    ):
        return False
    try:
        manifest_identity(value)
    except ValueError:
        return False
    return True


def parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def cleanup(args: argparse.Namespace) -> dict[str, Any]:
    config = load_config(Path(args.config).expanduser())
    online_dir_raw = str(resolve_local_savepoint_dir(args.online_dir, config))
    if not args.dry_run:
        raise RuntimeError(
            "savepoint_cleanup.py の実削除は無効です。mycmuxアプリ内のcleanupを使用してください"
        )
    machine = args.machine or config.get("machine") or platform.node()
    online_dir = Path(online_dir_raw).expanduser()
    now = datetime.now().astimezone()

    deleted: list[dict[str, str]] = []
    kept: list[dict[str, str]] = []

    if not online_dir.is_dir():
        return {"online_dir": str(online_dir), "dry_run": args.dry_run, "deleted": [], "kept": []}

    online_root = online_dir.resolve(strict=True)
    scan_roots = [(online_root, "")]
    final_records_root = safe_final_records_dir(online_root, False)
    if final_records_root is not None:
        scan_roots.append((final_records_root, FINAL_RECORDS_DIR + "/"))

    for scan_root, name_prefix in scan_roots:
        for entry in sorted(scan_root.iterdir()):
            if not entry.is_dir():
                continue
            name = entry.name
            if scan_root == online_root and name == FINAL_RECORDS_DIR:
                continue
            display_name = name_prefix + name
            if is_link_or_junction(entry):
                kept.append({"entry": display_name, "reason": "linked-path"})
                continue
            try:
                resolved_entry = entry.resolve(strict=True)
            except OSError:
                kept.append({"entry": display_name, "reason": "path-unreadable"})
                continue
            if resolved_entry != entry or resolved_entry.parent != scan_root:
                kept.append({"entry": display_name, "reason": "outside-online-dir"})
                continue
            if final_records_root is not None and resolved_entry == final_records_root:
                kept.append({"entry": display_name, "reason": "records-container"})
                continue
            # atomic swap の残骸。生成時の厳密な名前と valid manifest の
            # 両方が揃うものだけを mycmux 所有とみなす。
            if is_generated_publish_artifact_name(name):
                try:
                    artifact_manifest = json.loads(
                        (resolved_entry / "manifest.json").read_text(encoding="utf-8")
                    )
                except (OSError, json.JSONDecodeError):
                    artifact_manifest = None
                if not is_savepoint_manifest(artifact_manifest):
                    kept.append({"entry": display_name, "reason": "artifact-unowned"})
                    continue
                age = time.time() - resolved_entry.stat().st_mtime
                if age > STALE_TMP_SECONDS:
                    deleted.append({"entry": display_name, "reason": "stale-tmp"})
                else:
                    kept.append({"entry": display_name, "reason": "tmp-too-recent"})
                continue
            manifest_path = resolved_entry / "manifest.json"
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                kept.append({"entry": display_name, "reason": "manifest-unreadable"})
                continue
            if not is_savepoint_manifest(manifest):
                kept.append({"entry": display_name, "reason": "manifest-unreadable"})
                continue
            if manifest.get("pinned"):
                kept.append({"entry": display_name, "reason": "pinned"})
                continue
            expires_at = parse_iso(manifest.get("expires_at"))
            if expires_at is None:
                kept.append({"entry": display_name, "reason": "no-expiry"})
                continue
            if expires_at.tzinfo is None:
                expires_at = expires_at.astimezone()
            if expires_at < now:
                deleted.append({"entry": display_name, "reason": "expired"})
            else:
                kept.append({"entry": display_name, "reason": "not-expired"})

    return {
        "online_dir": str(online_dir),
        "machine": machine,
        "dry_run": args.dry_run,
        "deleted": deleted,
        "kept": kept,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="期限切れの引き継ぎ記録を読み取り専用で確認する")
    parser.add_argument("--online-dir", help="対象を明示指定 (既定: mycmux のローカル保存先)")
    parser.add_argument("--machine", help="自機名 (既定: config → hostname)")
    parser.add_argument("--config", default="~/.mycmux/savepoint.json")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    print(json.dumps(cleanup(args), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
