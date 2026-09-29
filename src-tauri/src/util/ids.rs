//! Identifier shape checks shared by the terminal commands and the PTY monitor.

/// Accept only canonical UUID shapes (8-4-4-4-12 hex).
///
/// Used for re-injected tab ids, agent session ids parsed out of a process
/// command line, and Codex rollout file names. Deliberately stricter than
/// `Uuid::parse_str` (no braces, no urn: prefix, no unhyphenated form) because
/// every producer we accept from writes the hyphenated form.
pub fn is_uuid_like(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_canonical_uuid() {
        assert!(is_uuid_like("019bc371-82cf-7d82-ad0b-96d026aaca73"));
    }

    #[test]
    fn rejects_wrong_length_and_misplaced_dashes() {
        assert!(!is_uuid_like(""));
        assert!(!is_uuid_like("019bc371-82cf-7d82-ad0b-96d026aaca7"));
        assert!(!is_uuid_like("019bc37182cf7d82ad0b96d026aaca73xxxx"));
        assert!(!is_uuid_like("019bc371x82cf-7d82-ad0b-96d026aaca73"));
    }

    #[test]
    fn rejects_non_hex_payload() {
        assert!(!is_uuid_like("019bc371-82cf-7d82-ad0b-96d026aaczz3"));
    }
}
