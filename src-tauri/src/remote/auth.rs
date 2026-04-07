use rand::RngCore;
use std::path::PathBuf;

/// Path to the persisted authentication token.
fn token_path() -> PathBuf {
    let mut p = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    p.push(".mycmux");
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
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let tok = hex::encode(bytes);
    let _ = std::fs::write(&path, &tok);
    tok
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
