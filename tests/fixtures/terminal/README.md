# Captured effort-screen fixture

`claude-2.1.319-effort-macos-42x40.bin` contains exactly the 1,368 bytes between
the supplied `start` (2390) and `effort` (3758) marks.

Source: Claude Code 2.1.319, macOS PTY (not ConPTY), 42 columns by 40 rows,
logged-out display, captured by the mothership on 2026-11-07. No other capture
bytes, paths, names, marks, or screens are included.

SHA-256: `848cb12aa608f9224e33fb7d3e0adbed295f6c08ea00243f76a6ef27e29e3f2b`.

## Windows ConPTY capture

`claude-2.1.319-effort-conpty-42x40.bin` contains the 5,775-byte
`real-261107-win/claude-42x40/raw.bin` supplied with the second review, with one
change for publication: the working-folder text in the start-up header (bytes
458-483, 26 ASCII bytes) is replaced by the neutral text `~\work\example\sample-proj`
of the same length. Every other byte, and every offset below, is unchanged.
Source: Claude Code 2.1.319, Windows kernel32 ConPTY, 42 columns by 40 rows,
captured by the mothership on 2026-11-07. The capture has effort-key offset
4666 and completed-close offset 5463; C=5064 is the reviewed partial effect.
Only raw terminal bytes are copied; marks and screens remain dispatch materials.

SHA-256: `644814a21a9c3f3b057777ce5270c57c24bd0f647cb057bc06667302e925ecbd`.
