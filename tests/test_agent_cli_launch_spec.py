"""Contract: the CLI can start every launchable catalog row, with a launch spec.

Until 2026-09-16 `--target` offered only the four kinds mycmux keeps a session
file for, and there was no way to say which model or effort to start with: the
GUI launcher's spec panel reached `addTabToPaneWithOptions` directly and the
socket route never carried the pair. A phone driving the launch therefore got
the CLI's default model however carefully it had been picked.

The two halves of that contract live here: the target list is walked against
`src/lib/agentCatalog.ts`, and model / effort are asserted to ride as request
args (the GUI turns them into MYCMUX_LAUNCH_MODEL / MYCMUX_LAUNCH_EFFORT) and
never as CLI flags of the agent itself.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import mycmux_agent_cli as cli  # noqa: E402

CATALOG = REPO_ROOT / "src" / "lib" / "agentCatalog.ts"
PANE_SESSION_ID = "11112222-3333-4444-5555-666677778888"


def catalog_agent_targets() -> set[str]:
    """Every `kind: "agent"` row of the catalog, read from the file itself."""
    text = CATALOG.read_text(encoding="utf-8")
    entries = re.findall(
        r'target:\s*"([^"]+)"[^}]*?kind:\s*"(agent|web)"', text, flags=re.S
    )
    assert entries, "the catalog entry shape changed; this reader needs updating"
    return {target for target, kind in entries if kind == "agent"}


def spawn_tab_request(argv: list[str]) -> tuple[str, dict[str, Any]]:
    namespace = cli.build_parser().parse_args(
        ["spawn-tab", "--anchor-session", PANE_SESSION_ID, *argv]
    )
    return cli.request_for(namespace)


def test_every_launchable_catalog_row_is_a_cli_target() -> None:
    missing = catalog_agent_targets() - set(cli.AGENT_TARGETS)
    assert not missing, f"catalog rows the CLI cannot start: {sorted(missing)}"


def test_the_cli_offers_no_target_the_catalog_does_not_launch() -> None:
    # shell and web are the two non-catalog targets: a bare shell, and the web
    # tab route whose own rows are `kind: "web"`.
    extra = set(cli.AGENT_TARGETS) - catalog_agent_targets() - {"shell", "web"}
    assert not extra, f"CLI targets the catalog does not offer: {sorted(extra)}"


@pytest.mark.parametrize("target", sorted(catalog_agent_targets()))
def test_a_catalog_target_builds_a_spawn_tab_request(target: str) -> None:
    method, args = spawn_tab_request(["--target", target])
    assert method == "pane.spawn_tab"
    assert args["target"] == target
    assert "commandArgv" not in args


def test_model_and_effort_ride_as_request_args() -> None:
    _, args = spawn_tab_request(["--target", "claude", "--model", "opus", "--effort", "max"])
    assert args["model"] == "opus"
    assert args["effort"] == "max"


def test_a_launch_without_a_spec_names_neither() -> None:
    _, args = spawn_tab_request(["--target", "claude"])
    assert "model" not in args and "effort" not in args


@pytest.mark.parametrize(
    "mode",
    [
        ["--resume-session", "22223333-4444-5555-6666-777788889999"],
        ["--prompt", "hello"],
    ],
)
def test_a_resume_or_prompt_carries_no_launch_spec(mode: list[str]) -> None:
    # A resume restores the session's own model and a prompt handoff inherits
    # the one it was written for; sending a second model would fight both.
    _, args = spawn_tab_request(["--target", "claude", "--model", "opus", *mode])
    assert "model" not in args and "effort" not in args


def test_a_raw_command_argv_refuses_a_launch_spec() -> None:
    # argv is the escape hatch for a real shell command. A model flag there
    # would have to be spelled into the argv itself, which is the argv-built
    # agent launch this route exists to prevent.
    namespace = cli.build_parser().parse_args(
        [
            "spawn-tab", "--anchor-session", PANE_SESSION_ID,
            "--model", "opus", "--", "powershell", "-NoLogo",
        ]
    )
    with pytest.raises(RuntimeError, match="cannot use interactive launch options"):
        cli.request_for(namespace)


def test_the_launch_spec_never_becomes_an_agent_flag() -> None:
    _, args = spawn_tab_request(["--target", "claude", "--model", "opus"])
    assert "commandArgv" not in args
    assert not any(
        isinstance(value, str) and value.startswith("--")
        for value in args.values()
    )
