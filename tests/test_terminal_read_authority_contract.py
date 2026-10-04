"""Unparsed retained terminals must not hide PTY output; parsed blank TUIs stay blank."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_read_requires_parsing_without_changing_buffer_existence_callers():
    wrapper = (ROOT / 'src/components/terminal/XTermWrapper.tsx').read_text(encoding='utf-8')
    socket = (ROOT / 'src/components/layout/socketCommands.ts').read_text(encoding='utf-8')
    assert 'hasTerminalBuffer(sessionId: string, requireParsed = false)' in wrapper
    assert '!requireParsed || isTerminalBufferReady(term)' in wrapper
    assert 'hasTerminalBuffer(sessionId, true)' in socket
    assert 'terminalSizeCache.get(sessionId)' in socket
    assert 'getTerminalBufferLines(sessionId, clampPaneReadLines(lines))' in socket


def test_readiness_is_tied_to_a_terminal_and_actual_parse_not_the_write_timeout():
    cache = (ROOT / 'src/components/terminal/terminalCache.ts').read_text(encoding='utf-8')
    wrapper = (ROOT / 'src/components/terminal/XTermWrapper.tsx').read_text(encoding='utf-8')
    assert 'readableTerminalBuffers = new WeakSet<Terminal>()' in cache
    write = wrapper.split('const writeTerminalOutput =', 1)[1].split('const scheduleTuiRecoveryRedraw', 1)[0]
    callback = write.split('writeTerm.write(rewrittenOutput, () => {', 1)[1].split('});', 1)[0]
    assert callback.index('markTerminalBufferReady(writeTerm)') < callback.index('finish()')
    timeout = write.split('const watchdog =', 1)[1].split('const finish =', 1)[0]
    assert 'markTerminalBufferReady' not in timeout
    catch = write.split('} catch {', 1)[1]
    assert 'markTerminalBufferReady' not in catch
    empty = wrapper.split('if (scrollback.byteLength === 0) {', 1)[1].split('return true;', 1)[0]
    assert 'markTerminalBufferReady(term)' in empty
    assert 'replayTerm.write(rewrittenOutput, () => {\n            markTerminalBufferReady(replayTerm);' in wrapper
