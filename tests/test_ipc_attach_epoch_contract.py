from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def test_create_session_commits_attach_epoch_only_after_backend_success() -> None:
    ipc = read_repo_text("src/lib/ipc.ts")
    attach_epoch = read_repo_text("src/lib/attachEpoch.ts")

    reserve_pos = ipc.index("const attach = beginSessionAttach(sessionId, {")
    invoke_pos = ipc.index('response = await withTerminalDeadline(invoke<AttachmentContext>("create_session",', reserve_pos)
    validate_pos = ipc.index("if (!sameAttachmentContext(response, attachmentContext)", invoke_pos)
    publish_pos = ipc.index("activePtyChannels.set(sessionId, { channel, context: attachmentContext });", validate_pos)
    commit_pos = ipc.index("attach.commit();", reserve_pos)
    failure_pos = ipc.index("attach.fail();", commit_pos)

    assert reserve_pos < invoke_pos < validate_pos < publish_pos < commit_pos < failure_pos
    assert "attach.commit();" not in ipc[reserve_pos:validate_pos]
    assert "!attachmentAttempt.current()" in ipc[validate_pos:publish_pos]
    assert "options.stillOwned && !options.stillOwned()" in ipc[validate_pos:publish_pos]
    assert "throw new SessionClosedError(sessionId)" in ipc[validate_pos:publish_pos]

    for snippet in [
        "beginSessionAttach",
        "epoch=${attach.epoch}",
        "channel.onmessage = (frame) => {",
        "attach.ingest(decodeFrontendDataBatch(frame));",
        "attach.commit();",
        "attach.fail();",
    ]:
        assert_contains(ipc, snippet, "src/lib/ipc.ts")

    for snippet in [
        "const sessionAttachNextEpoch = new Map<string, number>();",
        "function reserveSessionAttachEpoch(sessionId: string): number",
        "const previousEpoch = sessionAttachEpoch.get(sessionId) ?? 0;",
        "const pendingBatches: FrontendDataBatch[] = [];",
        "if (!attachResolved && !attachFailed && (current ?? 0) === previousEpoch) {",
        "pendingBatches.push(batch);",
        "sessionAttachEpoch.set(sessionId, epoch);",
        "flushPendingBatches();",
        "handlers.ackStale(batch, sessionAttachEpoch.get(sessionId));",
    ]:
        assert_contains(attach_epoch, snippet, "src/lib/attachEpoch.ts")
