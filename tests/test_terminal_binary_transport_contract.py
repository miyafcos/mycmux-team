from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_pty_output_and_scrollback_use_raw_binary_frames() -> None:
    session = read_repo_text("src-tauri/src/pty/session.rs")
    terminal_commands = read_repo_text("src-tauri/src/commands/terminal.rs")
    ipc = read_repo_text("src/lib/ipc.ts")
    wire = read_repo_text("src/lib/terminalWire.ts")

    assert "Channel<InvokeResponseBody>" in session
    assert "InvokeResponseBody::Raw(batch.into_wire())" in session
    assert 'frame.extend_from_slice(b"MCX1")' in session
    assert 'frame.extend_from_slice(b"MCS1")' in session
    assert "Response::new(snapshot.into_wire())" in terminal_commands
    assert "Channel<FrontendDataBatch>" not in session
    assert "new Channel<ArrayBuffer>()" in ipc
    assert "decodeFrontendDataBatch(frame)" in ipc
    assert 'invoke<ArrayBuffer>("get_session_scrollback"' in ipc
    assert "DATA_HEADER_BYTES = 40" in wire
    assert "SNAPSHOT_HEADER_BYTES = 24" in wire


def test_terminal_input_and_frontend_backlog_are_bounded() -> None:
    session = read_repo_text("src-tauri/src/pty/session.rs")
    terminal_cache = read_repo_text("src/components/terminal/terminalCache.ts")

    assert "mpsc::channel::<QueuedInput>(INPUT_QUEUE_MESSAGE_CAP)" in session
    assert "INPUT_QUEUE_BYTE_CAP" in session
    assert "PTY_INPUT_BACKPRESSURE" in session
    assert "unbounded_channel::<Vec<u8>>" not in session
    assert "reader_flow.mark_dropped();" in session
    assert "INPUT_BACKPRESSURE_RETRY_DELAYS_MS" in terminal_cache
    assert "takeTerminalInputBatch" in terminal_cache
