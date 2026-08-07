use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpliceError { InvalidSourceJson, InvalidReplacementJson, ExpectedRootObject, UnexpectedSyntax }
impl fmt::Display for SpliceError { fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "JSON splice error: {:?}", self) } }
impl std::error::Error for SpliceError {}

fn ws(bytes: &[u8], mut i: usize) -> usize { while i < bytes.len() && bytes[i].is_ascii_whitespace() { i += 1; } i }
fn string_end(bytes: &[u8], mut i: usize) -> Result<usize, SpliceError> {
    if bytes.get(i) != Some(&b'"') { return Err(SpliceError::UnexpectedSyntax); }
    i += 1;
    while i < bytes.len() { match bytes[i] { b'\\' => { i += 2; }, b'"' => return Ok(i + 1), 0..=31 => return Err(SpliceError::UnexpectedSyntax), _ => i += 1 } }
    Err(SpliceError::UnexpectedSyntax)
}
fn value_end(bytes: &[u8], start: usize) -> Result<usize, SpliceError> {
    if start >= bytes.len() { return Err(SpliceError::UnexpectedSyntax); }
    if bytes[start] == b'"' { return string_end(bytes, start); }
    if bytes[start] != b'{' && bytes[start] != b'[' {
        let mut i = start;
        while i < bytes.len() && bytes[i] != b',' && bytes[i] != b'}' { i += 1; }
        return Ok(ws_back(bytes, i));
    }
    let mut stack = vec![bytes[start]];
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b'"' { i = string_end(bytes, i)?; continue; }
        match bytes[i] { b'{' | b'[' => stack.push(bytes[i]), b'}' => { if stack.pop() != Some(b'{') { return Err(SpliceError::UnexpectedSyntax); } if stack.is_empty() { return Ok(i + 1); } }, b']' => { if stack.pop() != Some(b'[') { return Err(SpliceError::UnexpectedSyntax); } if stack.is_empty() { return Ok(i + 1); } }, _ => {} }
        i += 1;
    }
    Err(SpliceError::UnexpectedSyntax)
}
fn ws_back(bytes: &[u8], mut i: usize) -> usize { while i > 0 && bytes[i - 1].is_ascii_whitespace() { i -= 1; } i }
fn root_open(text: &str) -> Result<usize, SpliceError> { let i = ws(text.as_bytes(), 0); if text.as_bytes().get(i) == Some(&b'{') { Ok(i) } else { Err(SpliceError::ExpectedRootObject) } }

pub fn find_top_level_member(text: &str, key: &str) -> Result<Option<(usize, usize)>, SpliceError> {
    let b = text.as_bytes(); let mut i = root_open(text)? + 1;
    loop {
        i = ws(b, i); if b.get(i) == Some(&b'}') { return Ok(None); }
        let key_start = i; let key_end = string_end(b, i)?;
        let actual: String = serde_json::from_str(&text[key_start..key_end]).map_err(|_| SpliceError::UnexpectedSyntax)?;
        i = ws(b, key_end); if b.get(i) != Some(&b':') { return Err(SpliceError::UnexpectedSyntax); } i = ws(b, i + 1);
        let start = i; let end = value_end(b, start)?;
        if actual == key { return Ok(Some((start, end))); }
        i = ws(b, end); match b.get(i) { Some(b',') => i += 1, Some(b'}') => return Ok(None), _ => return Err(SpliceError::UnexpectedSyntax) }
    }
}
pub fn extract_top_level_member<'a>(text: &'a str, key: &str) -> Result<Option<&'a str>, SpliceError> { Ok(find_top_level_member(text, key)?.map(|(s,e)| &text[s..e])) }
pub fn replace_top_level_member(text: &str, key: &str, new_value_text: &str) -> Result<String, SpliceError> {
    let source: serde_json::Value = serde_json::from_str(text).map_err(|_| SpliceError::InvalidSourceJson)?;
    if !source.is_object() { return Err(SpliceError::ExpectedRootObject); }
    serde_json::from_str::<serde_json::Value>(new_value_text).map_err(|_| SpliceError::InvalidReplacementJson)?;
    if let Some((s,e)) = find_top_level_member(text, key)? { let mut out = String::with_capacity(text.len() - (e-s) + new_value_text.len()); out.push_str(&text[..s]); out.push_str(new_value_text); out.push_str(&text[e..]); return Ok(out); }
    let open = root_open(text)?; let b = text.as_bytes(); let next = ws(b, open + 1); let encoded = serde_json::to_string(key).map_err(|_| SpliceError::UnexpectedSyntax)?;
    let insertion = if b.get(next) == Some(&b'}') { format!("{encoded}:{new_value_text}") } else { format!("{encoded}:{new_value_text},") };
    let mut out = String::with_capacity(text.len() + insertion.len()); out.push_str(&text[..open+1]); out.push_str(&insertion); out.push_str(&text[open+1..]); Ok(out)
}
