"""Parser and request contract for background workspace creation."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import mycmux_agent_cli as cli  # noqa: E402


def request(argv: list[str]) -> tuple[str, dict[str, Any]]:
    return cli.request_for(cli.build_parser().parse_args(["workspace-new", *argv]))


def test_defaults_to_callers_cwd(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    assert request(["--name", "lane"]) == (
        "workspace.new", {"name": "lane", "cwd": os.getcwd()},
    )


def test_explicit_cwd_takes_precedence(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    assert request(["--name", "lane", "--cwd", "C:/work/lane/"]) == (
        "workspace.new", {"name": "lane", "cwd": "C:/work/lane/"},
    )


def test_grid_maps_to_socket_argument() -> None:
    assert request(["--name", "lane", "--cwd", "C:/work", "--grid", "2x2"]) == (
        "workspace.new", {"name": "lane", "cwd": "C:/work", "gridTemplateId": "2x2"},
    )


def test_name_is_required() -> None:
    with pytest.raises(SystemExit) as exc:
        request([])
    assert exc.value.code == 2


def test_invalid_grid_is_rejected() -> None:
    with pytest.raises(SystemExit) as exc:
        request(["--name", "lane", "--grid", "9x9"])
    assert exc.value.code == 2


def test_grid_choices_match_typescript_source() -> None:
    source = (REPO_ROOT / "src/lib/gridTemplates.ts").read_text(encoding="utf-8")
    match = re.search(r"export const GRID_TEMPLATES\b[^=]*=\s*\{(.*?)^\};", source, re.S | re.M)
    assert match is not None
    keys = set(re.findall(r'^\s*"([^"\n]+)"\s*:', match.group(1), re.M))
    assert keys
    assert set(cli.GRID_TEMPLATE_IDS) == keys


def test_workspace_new_is_in_help() -> None:
    assert "workspace-new" in cli.build_parser().format_help()


def test_select_flag_is_not_available() -> None:
    with pytest.raises(SystemExit) as exc:
        request(["--name", "lane", "--select"])
    assert exc.value.code == 2


@pytest.mark.parametrize("target", ["claude", "codex"])
def test_followup_spawn_routes_to_new_workspace(target: str) -> None:
    args = cli.build_parser().parse_args([
        "spawn", "--split", "--workspace", "new-workspace-id", "--target", target, "--no-activate",
    ])
    command, payload = cli.request_for(args)
    assert command == "pane.spawn"
    assert payload["workspaceId"] == "new-workspace-id"
    assert payload["target"] == target
    assert payload["activate"] is False
