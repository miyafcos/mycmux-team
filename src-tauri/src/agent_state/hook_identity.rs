pub(crate) fn verified_identity_kind<'a>(
    provider: &'a str,
    requested_kind: Option<&'a str>,
    session_id: &str,
    mapping: Option<(&'a str, &str)>,
) -> &'a str {
    let compatible = |kind: &&str| *kind == provider || (provider == "claude" && *kind == "claude-codex");
    mapping
        .filter(|(_, mapped_session)| *mapped_session == session_id)
        .map(|(kind, _)| kind)
        .filter(compatible)
        .or_else(|| requested_kind.filter(compatible))
        .unwrap_or(provider)
}

#[cfg(test)]
mod tests {
    use super::verified_identity_kind;

    #[test]
    fn new_wrapper_keeps_the_matching_launcher_mapping_without_a_resume_request() {
        assert_eq!(verified_identity_kind("claude", None, "new", Some(("claude-codex", "new"))), "claude-codex");
    }

    #[test]
    fn resume_and_rollover_keep_the_explicit_wrapper_kind() {
        for session in ["saved", "successor"] {
            assert_eq!(verified_identity_kind("claude", Some("claude-codex"), session, None), "claude-codex");
        }
    }

    #[test]
    fn other_conversation_and_cross_provider_mappings_cannot_change_identity() {
        assert_eq!(verified_identity_kind("claude", None, "new", Some(("claude-codex", "old"))), "claude");
        for provider in ["claude", "codex", "grok"] {
            for foreign in ["claude", "codex", "grok", "claude-codex"] {
                let expected = if foreign == provider || (provider == "claude" && foreign == "claude-codex") { foreign } else { provider };
                assert_eq!(verified_identity_kind(provider, None, "current", Some((foreign, "current"))), expected);
            }
        }
    }

    #[test]
    fn plain_supported_providers_and_missing_mappings_keep_their_provider() {
        for provider in ["claude", "codex", "grok"] {
            assert_eq!(verified_identity_kind(provider, None, "session", None), provider);
            assert_eq!(verified_identity_kind(provider, Some(provider), "session", Some((provider, "session"))), provider);
        }
    }
}
