use rand::RngCore;
use std::path::PathBuf;

/// Path to the persisted authentication token.
fn token_path() -> PathBuf {
    let mut p = crate::test_profile::runtime_dir().unwrap_or_else(|_| PathBuf::from("/tmp/.mycmux"));
    std::fs::create_dir_all(&p).ok();
    p.push("remote-token");
    p
}

/// Load existing token or generate a new one (32 random bytes, hex-encoded).
pub fn load_or_create_token() -> String {
    let path = token_path();
    if let Ok(tok) = std::fs::read_to_string(&path) {
        let tok = tok.trim().to_string();
        if tok.len() == 64 {
            return tok;
        }
    }
    let tok = generate_token();
    let _ = std::fs::write(&path, &tok);
    tok
}

/// Generate a new 32-byte hex token.
fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Generate and persist a new token.
pub fn rotate_token() -> Result<String, String> {
    let tok = generate_token();
    std::fs::write(token_path(), &tok).map_err(|e| format!("Failed to write remote token: {e}"))?;
    Ok(tok)
}

/// Constant-time-ish comparison (good enough for single-user LAN).
pub fn validate_token(provided: &str, expected: &str) -> bool {
    if provided.len() != expected.len() {
        return false;
    }
    provided
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_token_has_expected_hex_length() {
        let token = generate_token();

        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn test_validate_token_accepts_matching_token() {
        let token = "a".repeat(64);

        assert!(validate_token(&token, &token));
    }

    #[test]
    fn test_validate_token_rejects_wrong_same_length_token() {
        let expected = "a".repeat(64);
        let provided = format!("{}b", "a".repeat(63));

        assert!(!validate_token(&provided, &expected));
    }

    #[test]
    fn test_validate_token_rejects_wrong_length_token() {
        assert!(!validate_token("abc", &"a".repeat(64)));
    }
}
