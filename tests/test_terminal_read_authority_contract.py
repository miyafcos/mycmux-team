"""Unparsed retained terminals must not hide PTY output; parsed blank TUIs stay blank."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_read_requires_parsing_without_changing_buffer_existence_callers():
    wrapper = (ROOT / 'src/components/terminal/XTermWrapper.tsx').read_text(encoding='utf-8')
    socket = (ROOT / 'src/components/layout/socketCommands.ts').read_text(encoding='utf-8')
    cache = (ROOT / 'src/components/terminal/terminalCache.ts').read_text(encoding='utf-8')
    exists = wrapper.split('export function hasTerminalBuffer(sessionId: string, requireParsed = false)', 1)[1].split('export function hasMountedTerminal', 1)[0]
    assert 'const term = liveTerms.get(sessionId) ?? termCache.get(sessionId)?.term;' in exists
    assert 'return Boolean(term && (!requireParsed || isTerminalBufferReady(term)));' in exists

    # Existence callers keep their default; reads require the mounted parser's
    # exact current PTY generation with no pending/failed writes or parked work.
    authority = cache.split('export function isTerminalParsingCurrentOutput(sessionId: string)', 1)[1].split('export const terminalSizeCache', 1)[0]
    assert 'const term = liveTerms.get(sessionId);' in authority
    assert 'const generation = ptyReadGeneration(sessionId);' in authority
    assert '''return Boolean(term && !termCache.has(sessionId) && isTerminalBufferReady(term)
    && parsedPtyGenerations.get(term) === generation && !pendingTerminalBufferWrites(term, generation)
    && failedWrites.get(term) !== generation && currentOutputParsers.get(term)?.());''' in authority
    parser = wrapper.split('const registerReadAuthority =', 1)[1].split('const schedulePendingWriteDrain', 1)[0]
    assert 'registerCurrentOutputParser(sessionId, mounted, () => {' in parser
    assert '''return term === mounted && !disposed && !termDisposed && canWritePendingBatches()
          && !replayActive && !scrollbackSyncInFlight && !writingBatch && pendingBatches.length === 0
          && !terminalScrollbackResyncNeeded.has(sessionId);''' in parser

    read = socket.split('export async function readPaneTail(', 1)[1].split('async function movePane', 1)[0]
    assert '''if (!preferHeadless && isTerminalParsingCurrentOutput(sessionId)) {
    return getTerminalBufferLines(sessionId, clampPaneReadLines(lines));
  }''' in read
    # A parsed blank screen returns directly too; rejected authority uses the
    # existing sized, clamped backend/headless path rather than retained text.
    assert 'return readHeadlessBufferLines(sessionId, async (since) => {' in read
    assert 'await getSessionScrollback(sessionId)' in read
    assert 'await getSessionScrollback(sessionId, since)' in read
    assert '}, clampPaneReadLines(lines), terminalSizeCache.get(sessionId),' in read
    pane = socket.split('async function readPane(', 1)[1].split('export async function readPaneTail', 1)[0]
    assert 'lines: await readPaneTail(sessionId, args?.lines, preferHeadless)' in pane
    snapshot = socket.split('async function readPaneSnapshot(', 1)[1].split('async function waitForTypedTextToSettle', 1)[0]
    assert 'const read = readPaneTail(sessionId, SEND_CONFIRM_LINES, preferHeadless || !targetMounted);' in snapshot


def test_readiness_is_tied_to_a_terminal_and_actual_parse_not_the_write_timeout():
    cache = (ROOT / 'src/components/terminal/terminalCache.ts').read_text(encoding='utf-8')
    wrapper = (ROOT / 'src/components/terminal/XTermWrapper.tsx').read_text(encoding='utf-8')
    assert 'readableTerminalBuffers = new WeakSet<Terminal>()' in cache
    ready = cache.split('export function markTerminalBufferReady(', 1)[1].split('const currentOutputParsers', 1)[0]
    assert 'readableTerminalBuffers.add(term);' in ready
    assert 'parsedPtyGenerations.set(term, generation ?? ptyReadGeneration(sessionId!))' in ready
    assert 'return readableTerminalBuffers.has(term);' in ready
    ticket = cache.split('export function beginTerminalBufferWrite(', 1)[1].split('export function cancelTerminalBufferWrites', 1)[0]
    assert 'const accepted = parsed && currentPtyRead(sessionId, generation);' in ticket
    assert 'if (!pending.delete(ticket)) return false;' in ticket
    assert 'release(); return accepted;' in ticket
    write = wrapper.split('const writeTerminalOutput =', 1)[1].split('const scheduleTuiRecoveryRedraw', 1)[0]
    assert 'const writeTerm = term;' in write
    assert 'const completeParse = beginTerminalBufferWrite(sessionId, writeTerm, sourceGeneration);' in write
    callback = write.split('writeTerm.write(rewrittenOutput, () => {', 1)[1].split('});', 1)[0]
    assert 'if (completeParse(true)) markTerminalBufferReady(writeTerm, sourceGeneration);' in callback
    assert callback.index('markTerminalBufferReady(writeTerm, sourceGeneration)') < callback.index('finish()')
    timeout = write.split('const watchdog =', 1)[1].split('const finish =', 1)[0]
    assert 'markTerminalBufferReady' not in timeout
    assert 'completeParse' not in timeout
    catch = write.split('} catch {', 1)[1]
    assert 'markTerminalBufferReady' not in catch
    assert catch.index('completeParse(false)') < catch.index('finish()')

    # Empty backend replay preserves an already parsed blank screen; it must
    # not mint current-generation parse proof for an unparsed/old Terminal.
    empty = wrapper.split('if (scrollback.byteLength === 0) {', 1)[1].split('return true;', 1)[0]
    assert 'replaceTerminalRawTail(sessionId, scrollback);' in empty
    assert 'lastSynchronizedScrollbackEnd = scrollbackSnapshot.endOffset;' in empty
    for operation in ('markTerminalBufferReady', 'beginTerminalBufferWrite', 'completeParse', 'term.reset(', 'readableTerminalBuffers', 'parsedPtyGenerations'):
        assert operation not in empty

    replay = wrapper.rsplit('const replayTerm = term;', 1)[1].split('recordPerf("xterm.replay.done"', 1)[0]
    assert 'const replayReadGeneration = ptyReadGeneration(sessionId);' in replay
    assert 'const completeParse = beginTerminalBufferWrite(sessionId, replayTerm, replayReadGeneration);' in replay
    replay_callback = replay.split('replayTerm.write(rewrittenOutput, () => {', 1)[1].split('});', 1)[0]
    assert 'if (completeParse(true)) markTerminalBufferReady(replayTerm, replayReadGeneration);' in replay_callback
    assert replay_callback.index('markTerminalBufferReady(replayTerm, replayReadGeneration)') < replay_callback.index('recordTerminalWriteCallback') < replay_callback.index('resolve()')
    replay_catch = replay.split('} catch (error) {', 1)[1]
    assert 'completeParse(false);' in replay_catch
    assert 'markTerminalBufferReady' not in replay_catch
