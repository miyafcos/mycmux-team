//! Restricted Rust lexer for the one app-command registration macro.
//! Comments/literals are tokens, never delimiters. Unsupported entries fail the build.
use std::collections::BTreeSet;

#[derive(Debug, PartialEq)]
enum Token {
    Ident(String),
    Punct(u8),
    Literal,
}

fn quoted_end(bytes: &[u8], quote: usize) -> Result<usize, String> {
    let delimiter = bytes[quote];
    let mut cursor = quote + 1;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'\\' => cursor += 2,
            byte if byte == delimiter => return Ok(cursor + 1),
            _ => cursor += 1,
        }
    }
    Err("unterminated Rust literal in command inventory".into())
}

fn literal_end(bytes: &[u8], start: usize) -> Result<Option<usize>, String> {
    if bytes[start] == b'"' { return quoted_end(bytes, start).map(Some); }
    if bytes[start] == b'\'' {
        // A lifetime is punctuation + identifier, not a character literal.
        let next = start + 1;
        if bytes.get(next) == Some(&b'\\') { return quoted_end(bytes, start).map(Some); }
        let width = std::str::from_utf8(&bytes[next..]).map_err(|_| "invalid UTF-8")?
            .chars().next().map(char::len_utf8).unwrap_or(0);
        if width > 0 && bytes.get(next + width) == Some(&b'\'') { return Ok(Some(next + width + 1)); }
        return Ok(None);
    }
    let mut cursor = start;
    if matches!(bytes[cursor], b'b' | b'c') {
        cursor += 1;
        if cursor < bytes.len() && matches!(bytes[cursor], b'"' | b'\'') {
            return quoted_end(bytes, cursor).map(Some);
        }
    }
    if bytes.get(cursor) != Some(&b'r') { return Ok(None); }
    cursor += 1;
    let hash_start = cursor;
    while bytes.get(cursor) == Some(&b'#') { cursor += 1; }
    if bytes.get(cursor) != Some(&b'"') { return Ok(None); }
    let hashes = cursor - hash_start;
    cursor += 1;
    while cursor < bytes.len() {
        if bytes[cursor] == b'"' && bytes.get(cursor + 1..cursor + 1 + hashes)
            .is_some_and(|suffix| suffix.iter().all(|byte| *byte == b'#')) {
            return Ok(Some(cursor + 1 + hashes));
        }
        cursor += 1;
    }
    Err("unterminated raw Rust literal in command inventory".into())
}

fn lex(source: &str) -> Result<Vec<Token>, String> {
    let bytes = source.as_bytes();
    let mut cursor = 0;
    let mut tokens = Vec::new();
    while cursor < bytes.len() {
        if bytes[cursor].is_ascii_whitespace() { cursor += 1; continue; }
        if bytes.get(cursor..cursor + 2) == Some(b"//") {
            while cursor < bytes.len() && bytes[cursor] != b'\n' { cursor += 1; }
            continue;
        }
        if bytes.get(cursor..cursor + 2) == Some(b"/*") {
            cursor += 2;
            let mut depth = 1;
            while cursor < bytes.len() && depth != 0 {
                if bytes.get(cursor..cursor + 2) == Some(b"/*") { depth += 1; cursor += 2; }
                else if bytes.get(cursor..cursor + 2) == Some(b"*/") { depth -= 1; cursor += 2; }
                else { cursor += 1; }
            }
            if depth != 0 { return Err("unterminated block comment in command inventory".into()); }
            continue;
        }
        if let Some(end) = literal_end(bytes, cursor)? {
            tokens.push(Token::Literal); cursor = end; continue;
        }
        if bytes[cursor].is_ascii_alphabetic() || bytes[cursor] == b'_' {
            let start = cursor;
            cursor += 1;
            while cursor < bytes.len() && (bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == b'_') {
                cursor += 1;
            }
            tokens.push(Token::Ident(source[start..cursor].into()));
        } else {
            if !bytes[cursor].is_ascii() { return Err("non-ASCII command path is unsupported".into()); }
            tokens.push(Token::Punct(bytes[cursor])); cursor += 1;
        }
    }
    Ok(tokens)
}

fn closing(open: u8) -> Option<u8> {
    match open { b'[' => Some(b']'), b'(' => Some(b')'), b'{' => Some(b'}'), _ => None }
}

pub fn parse_commands(source: &str, macro_name: &str) -> Result<Vec<String>, String> {
    let tokens = lex(source)?;
    let marker = lex(macro_name)?;
    let mut groups = Vec::new();
    for start in 0..tokens.len() {
        if start > 0 && tokens[start - 1] == Token::Punct(b':') { continue; }
        let end = start + marker.len();
        if tokens.get(start..end) != Some(marker.as_slice()) || tokens.get(end) != Some(&Token::Punct(b'!')) {
            continue;
        }
        let Some(Token::Punct(open)) = tokens.get(end + 1) else {
            return Err("command macro requires a delimited token group".into());
        };
        let Some(close) = closing(*open) else {
            return Err("unsupported command macro delimiter".into());
        };
        let mut stack = vec![close];
        let body_start = end + 2;
        let mut cursor = body_start;
        while cursor < tokens.len() {
            if let Token::Punct(byte) = &tokens[cursor] {
                if let Some(close) = closing(*byte) { stack.push(close); }
                else if matches!(byte, b']' | b')' | b'}') {
                    if stack.pop() != Some(*byte) { return Err("mismatched command macro delimiters".into()); }
                    if stack.is_empty() { break; }
                }
            }
            cursor += 1;
        }
        if !stack.is_empty() { return Err("unclosed command macro token group".into()); }
        groups.push(&tokens[body_start..cursor]);
    }
    if groups.len() != 1 { return Err(format!("expected one {macro_name} registration, found {}", groups.len())); }
    let body = groups[0];
    let mut cursor = 0;
    let mut commands = Vec::new();
    let mut seen = BTreeSet::new();
    while cursor < body.len() {
        let Some(Token::Ident(first)) = body.get(cursor) else {
            return Err("only simple command paths are supported (no attributes or expressions)".into());
        };
        let mut name = first;
        cursor += 1;
        while body.get(cursor) == Some(&Token::Punct(b':')) {
            if body.get(cursor + 1) != Some(&Token::Punct(b':')) {
                return Err("command paths require :: separators".into());
            }
            let Some(Token::Ident(next)) = body.get(cursor + 2) else {
                return Err("command path component must be an identifier".into());
            };
            name = next; cursor += 3;
        }
        if !seen.insert(name.clone()) { return Err(format!("duplicate app command: {name}")); }
        commands.push(name.clone());
        if cursor == body.len() { break; }
        if body[cursor] != Token::Punct(b',') { return Err("unsupported command entry syntax".into()); }
        cursor += 1;
    }
    if commands.is_empty() { return Err("app command inventory must not be empty".into()); }
    Ok(commands)
}
