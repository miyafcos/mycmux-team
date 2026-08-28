from __future__ import annotations

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def extract_ts_prefix() -> str:
    text = read_repo_text("src/lib/constants.ts")
    match = re.search(r'export const SESSION_ID_PREFIX = "([^"]+)";', text)
    assert match is not None, "Missing TypeScript SESSION_ID_PREFIX"
    return match.group(1)


def extract_rust_prefix() -> str:
    text = read_repo_text("src-tauri/src/session_retention.rs")
    match = re.search(r'const SESSION_ID_PREFIX: &str = "([^"]+)";', text)
    assert match is not None, "Missing Rust SESSION_ID_PREFIX"
    return match.group(1)


def extract_rust_session_format() -> str:
    text = read_repo_text("src-tauri/src/session_retention.rs")
    match = re.search(
        r"fn make_session_id\(.*?\)\s*->\s*String\s*\{\s*"
        r'format!\("([^"]+)"\)',
        text,
        re.S,
    )
    assert match is not None, "Missing Rust make_session_id format string"
    return match.group(1)


def test_session_retention_prefix_matches_frontend_prefix() -> None:
    assert extract_ts_prefix() == extract_rust_prefix() == "pty"


def test_session_retention_keeps_terminal_ids_but_mapping_uses_tab_ids() -> None:
    constants = read_repo_text("src/lib/constants.ts")
    layout_store = read_repo_text("src/stores/workspaceLayoutStore.ts")
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")
    rust_format = extract_rust_session_format()

    assert_contains(
        constants,
        "return `${SESSION_ID_PREFIX}-${workspaceId}-${paneId}`;",
        "src/lib/constants.ts",
    )
    assert_contains(
        layout_store,
        "sessionId: makeSessionId(workspaceId, `${paneId}-${tabId}`),",
        "src/stores/workspaceLayoutStore.ts",
    )
    assert_contains(socket_listener, "agentMappings[tabId]", "src/components/layout/SocketListener.tsx")
    assert "const tabSessionId = makeSessionId(cfg.id, `${paneId}-${tabId}`);" not in socket_listener
    assert rust_format == "{SESSION_ID_PREFIX}-{workspace_id}-{pane_id}-{tab_id}"
