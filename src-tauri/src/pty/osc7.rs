//! OSC 7 parser — extracts CWD from shell `\x1b]7;file://host/path\x07` (or ST `\x1b\\`).
//!
//! The parser is a side-channel observer called from the PTY reader thread.
//! Bytes are NOT stripped from the stream — xterm.js and `xterm` ignore unknown
//! OSC sequences, so passing them through to the renderer is harmless.
//!
//! Security posture:
//!   * payload is capped at `MAX_PAYLOAD` bytes (DoS protection)
//!   * `file://` prefix is mandatory; other schemes are rejected
//!   * host must be empty, `localhost`, or match `HOSTNAME` / `COMPUTERNAME`
//!   * `..` in path is rejected (traversal protection)
//!   * invalid UTF-8 or percent-escapes are rejected

use super::path_norm::posix_drive_to_windows;

const MAX_PAYLOAD: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    SawEsc,
    SawOscOpen,
    SawPrefixDigit, // seen "\x1b]7"
    InPayload,
    InPayloadEsc,
}

pub struct Osc7Parser {
    state: State,
    payload: Vec<u8>,
}

impl Default for Osc7Parser {
    fn default() -> Self {
        Self::new()
    }
}

impl Osc7Parser {
    pub fn new() -> Self {
        Self {
            state: State::Idle,
            payload: Vec::with_capacity(256),
        }
    }

    /// Feed a byte slice. Returns the last completed CWD in this chunk, if any.
    /// Partial sequences spanning chunks are preserved in internal state.
    pub fn feed(&mut self, chunk: &[u8]) -> Option<String> {
        let mut last: Option<String> = None;
        for &b in chunk {
            match self.state {
                State::Idle => {
                    if b == 0x1B {
                        self.state = State::SawEsc;
                    }
                }
                State::SawEsc => {
                    self.state = match b {
                        b']' => State::SawOscOpen,
                        0x1B => State::SawEsc,
                        _ => State::Idle,
                    };
                }
                State::SawOscOpen => {
                    self.state = match b {
                        b'7' => State::SawPrefixDigit,
                        0x1B => State::SawEsc,
                        _ => State::Idle,
                    };
                }
                State::SawPrefixDigit => {
                    self.state = match b {
                        b';' => {
                            self.payload.clear();
                            State::InPayload
                        }
                        0x1B => State::SawEsc,
                        _ => State::Idle,
                    };
                }
                State::InPayload => {
                    if b == 0x07 {
                        if let Some(cwd) = parse_payload(&self.payload) {
                            last = Some(cwd);
                        }
                        self.reset();
                    } else if b == 0x1B {
                        self.state = State::InPayloadEsc;
                    } else if self.payload.len() >= MAX_PAYLOAD {
                        self.reset();
                    } else {
                        self.payload.push(b);
                    }
                }
                State::InPayloadEsc => {
                    if b == b'\\' {
                        if let Some(cwd) = parse_payload(&self.payload) {
                            last = Some(cwd);
                        }
                        self.reset();
                    } else {
                        // ESC was not followed by \; treat as literal inside payload.
                        if self.payload.len() + 2 >= MAX_PAYLOAD {
                            self.reset();
                        } else {
                            self.payload.push(0x1B);
                            self.payload.push(b);
                            self.state = State::InPayload;
                        }
                    }
                }
            }
        }
        last
    }

    fn reset(&mut self) {
        self.state = State::Idle;
        self.payload.clear();
    }
}

fn parse_payload(payload: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(payload).ok()?;
    let rest = s.strip_prefix("file://")?;
    let slash = rest.find('/')?;
    let host = &rest[..slash];
    let path = &rest[slash..];
    if !host_is_allowed(host) {
        return None;
    }
    let decoded = percent_decode(path)?;
    if decoded.split(['/', '\\']).any(|seg| seg == "..") {
        return None;
    }
    let normalized = posix_drive_to_windows(&decoded);
    if normalized.is_empty() {
        return None;
    }
    Some(normalized)
}

fn host_is_allowed(host: &str) -> bool {
    if host.is_empty() || host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(current) = std::env::var(key) {
            if host.eq_ignore_ascii_case(&current) {
                return true;
            }
        }
    }
    false
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex_val(bytes[i + 1])?;
            let lo = hex_val(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_all(bytes: &[u8]) -> Option<String> {
        let mut p = Osc7Parser::new();
        p.feed(bytes)
    }

    #[test]
    fn parses_bel_terminated_localhost() {
        let seq = b"\x1b]7;file://localhost/home/me\x07";
        assert_eq!(parse_all(seq).as_deref(), Some("/home/me"));
    }

    #[test]
    fn parses_st_terminated() {
        let seq = b"\x1b]7;file:///home/me\x1b\\";
        assert_eq!(parse_all(seq).as_deref(), Some("/home/me"));
    }

    #[test]
    fn parses_empty_host() {
        let seq = b"\x1b]7;file:///tmp\x07";
        assert_eq!(parse_all(seq).as_deref(), Some("/tmp"));
    }

    #[test]
    fn converts_git_bash_drive_path() {
        let seq = b"\x1b]7;file:///c/Users/me\x07";
        assert_eq!(parse_all(seq).as_deref(), Some("C:\\Users\\me"));
    }

    #[test]
    fn decodes_percent_escapes() {
        let seq = b"\x1b]7;file:///home/me/a%20b\x07";
        assert_eq!(parse_all(seq).as_deref(), Some("/home/me/a b"));
    }

    #[test]
    fn rejects_unknown_host() {
        let seq = b"\x1b]7;file://evil.example.com/etc/passwd\x07";
        assert_eq!(parse_all(seq), None);
    }

    #[test]
    fn rejects_traversal() {
        let seq = b"\x1b]7;file:///home/me/../../etc\x07";
        assert_eq!(parse_all(seq), None);
    }

    #[test]
    fn rejects_non_file_scheme() {
        let seq = b"\x1b]7;http://localhost/\x07";
        assert_eq!(parse_all(seq), None);
    }

    #[test]
    fn tolerates_chunk_boundary() {
        let mut p = Osc7Parser::new();
        let chunks: &[&[u8]] = &[
            b"\x1b]",
            b"7;file:",
            b"//localhost/home",
            b"/me",
            b"\x07trailing",
        ];
        let mut last: Option<String> = None;
        for c in chunks {
            if let Some(v) = p.feed(c) {
                last = Some(v);
            }
        }
        assert_eq!(last.as_deref(), Some("/home/me"));
    }

    #[test]
    fn recovers_from_huge_garbage() {
        let mut p = Osc7Parser::new();
        // Pretend attacker sends a never-terminated OSC 7 larger than MAX_PAYLOAD.
        let garbage = vec![b'A'; MAX_PAYLOAD + 100];
        let mut seq = b"\x1b]7;file:///".to_vec();
        seq.extend(&garbage);
        assert_eq!(p.feed(&seq), None);
        // Follow-up legitimate OSC 7 must still parse.
        let valid = b"\x1b]7;file:///tmp\x07";
        assert_eq!(p.feed(valid).as_deref(), Some("/tmp"));
    }

    #[test]
    fn ignores_other_escapes() {
        // CSI cursor position report, bracketed paste end, etc. should not trigger.
        let seq = b"\x1b[2J\x1b[1;1H\x1b[?2004l";
        assert_eq!(parse_all(seq), None);
    }

    #[test]
    fn picks_latest_cwd_when_multiple() {
        let seq =
            b"\x1b]7;file:///home/a\x07prompt\x1b]7;file:///home/b\x07prompt";
        assert_eq!(parse_all(seq).as_deref(), Some("/home/b"));
    }

    #[test]
    fn rejects_invalid_percent() {
        let seq = b"\x1b]7;file:///tmp/%zz\x07";
        assert_eq!(parse_all(seq), None);
    }
}
