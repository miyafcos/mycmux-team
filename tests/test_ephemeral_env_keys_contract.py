from __future__ import annotations

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]

EXPECTED_EPHEMERAL_ENV_KEYS = {
    "MYCMUX_RESUME",
    "MYCMUX_SESSION_ID",
    "MYCMUX_AGENT_KIND",
    "MYCMUX_RESUME_FORK",
    "MYCMUX_LAUNCH_TARGET",
    "MYCMUX_HANDOFF",
    "MYCMUX_HANDOFF_FROM",
    "MYCMUX_HANDOFF_PROMPT_FILE",
    "MYCMUX_HANDOFF_FROM_SESSION",
    "MYCMUX_PANE_SESSION_ID",
    "MYCMUX_TAB_ID",
    "MYCMUX_HTML_OUT",
    "MYCMUX_MARKDOWN_OUT",
    "MYCMUX_ARTIFACTS_DIR",
    "MYCMUX_RUNTIME_DIR",
    "MYCMUX_TEST_PROFILE",
    "MYCMUX_HOOK_CAP",
    "__CMUX_LAUNCHER_DONE",
}

TERMINAL_ENV_GROUPS = (
    "ALWAYS_INTERNAL",
    "RESUME_QUARTET",
    "HANDOFF_QUARTET",
)


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def strip_line_comments(text: str) -> str:
    return re.sub(r"//.*$", "", text, flags=re.M)


def assert_nonempty(keys: set[str], source: str) -> None:
    assert keys, f"{source} extraction returned no keys"


def assert_matches_expected(
    keys: set[str], source: str, expected: set[str] = EXPECTED_EPHEMERAL_ENV_KEYS
) -> None:
    unexpected = keys - expected
    stale = expected - keys
    assert not unexpected, (
        f"{source} contains ephemeral env keys that are not in "
        f"EXPECTED_EPHEMERAL_ENV_KEYS. Add them consciously: {sorted(unexpected)}"
    )
    assert not stale, (
        f"EXPECTED_EPHEMERAL_ENV_KEYS contains keys missing from {source}. "
        f"Remove stale entries consciously: {sorted(stale)}"
    )


def extract_lib_remove_var_keys() -> set[str]:
    text = read_repo_text("src-tauri/src/lib.rs")
    match = re.search(
        r"for\s+key\s+in\s+\[(?P<body>.*?)\]\s*\{\s*std::env::remove_var",
        text,
        re.S,
    )
    assert match is not None, "Missing lib.rs startup remove_var key array"
    keys = set(re.findall(r'"([^"]+)"', strip_line_comments(match.group("body"))))
    assert_nonempty(keys, "src-tauri/src/lib.rs")
    return keys


def extract_terminal_group_keys(name: str) -> set[str]:
    text = read_repo_text("src-tauri/src/commands/terminal.rs")
    match = re.search(
        rf"const\s+{re.escape(name)}\s*:\s*&\s*\[\s*&str\s*\]\s*=\s*&\s*"
        r"\[(?P<body>.*?)\]\s*;",
        text,
        re.S,
    )
    assert match is not None, f"Missing terminal.rs {name} const array"
    keys = set(re.findall(r'"([^"]+)"', strip_line_comments(match.group("body"))))
    assert_nonempty(keys, f"src-tauri/src/commands/terminal.rs {name}")
    return keys


def extract_terminal_grouped_keys() -> dict[str, set[str]]:
    return {name: extract_terminal_group_keys(name) for name in TERMINAL_ENV_GROUPS}


def extract_socket_listener_keys() -> set[str]:
    text = read_repo_text("src/components/layout/SocketListener.tsx")
    match = re.search(
        r"const\s+EPHEMERAL_LAUNCH_ENV_KEYS\s*=\s*new\s+Set\s*\(\s*"
        r"\[(?P<body>.*?)\]\s*\)\s*;",
        text,
        re.S,
    )
    assert match is not None, "Missing SocketListener.tsx EPHEMERAL_LAUNCH_ENV_KEYS set"
    keys = set(re.findall(r'"([^"]+)"', strip_line_comments(match.group("body"))))
    assert_nonempty(keys, "src/components/layout/SocketListener.tsx")
    return keys


def test_ephemeral_env_keys_stay_in_sync_across_all_guards() -> None:
    sources = {
        "src-tauri/src/lib.rs startup remove_var": (
            extract_lib_remove_var_keys(),
            EXPECTED_EPHEMERAL_ENV_KEYS,
        ),
        "src-tauri/src/commands/terminal.rs sanitize_launch_env arrays": (
            set().union(*extract_terminal_grouped_keys().values()),
            # This key is intentional launch input and must reach launcher.sh.
            # Unlike canonical internal paths, terminal.rs must not strip it.
            EXPECTED_EPHEMERAL_ENV_KEYS - {"MYCMUX_LAUNCH_TARGET"},
        ),
        "src/components/layout/SocketListener.tsx persistence filter": (
            extract_socket_listener_keys(),
            # This key is injected only by the backend after frontend state is
            # already fixed, so it cannot be persisted by SocketListener.
            EXPECTED_EPHEMERAL_ENV_KEYS - {"MYCMUX_TEST_PROFILE", "MYCMUX_HOOK_CAP"},
        ),
    }

    for source, (keys, expected) in sources.items():
        assert_nonempty(keys, source)
        assert_matches_expected(keys, source, expected)


def test_terminal_ephemeral_env_groups_are_disjoint() -> None:
    groups = extract_terminal_grouped_keys()

    for left_name, left_keys in groups.items():
        for right_name, right_keys in groups.items():
            if left_name >= right_name:
                continue
            overlap = left_keys & right_keys
            assert not overlap, (
                f"terminal.rs {left_name} and {right_name} must stay disjoint. "
                f"Overlap: {sorted(overlap)}"
            )
