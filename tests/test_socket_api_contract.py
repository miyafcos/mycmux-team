from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def test_socket_api_frontend_bridge_returns_responses() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")

    for snippet in [
        'listen<SocketRequestPayload>("socket-request"',
        "handleSocketCommand(cmd, args)",
        "await sendSocketResponse(id, result, null);",
        "await sendSocketResponse(id, null, message);",
        'case "workspace.list":',
        'case "pane.list":',
    ]:
        assert_contains(socket_listener, snippet, "src/components/layout/SocketListener.tsx")


def test_socket_api_rust_bridge_emits_frontend_requests() -> None:
    socket_rs = read_repo_text("src-tauri/src/socket.rs")
    ipc_ts = read_repo_text("src/lib/ipc.ts")

    assert_contains(socket_rs, 'app.emit("socket-request", &req)', "src-tauri/src/socket.rs")
    assert_contains(ipc_ts, 'invoke("socket_response"', "src/lib/ipc.ts")
