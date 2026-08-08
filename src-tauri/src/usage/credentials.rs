use crate::cli_accounts::json_splice;
use serde_json::{Number, Value};
use std::fmt;

pub const REFRESH_MARGIN_MS: i64 = 5 * 60 * 1000;

#[derive(Clone)]
pub struct ClaudeTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at_ms: i64,
    pub refresh_expires_at_ms: Option<i64>,
    pub subscription_type: Option<String>,
}

#[derive(Clone)]
pub struct CodexTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub account_id: Option<String>,
    pub id_token: Option<String>,
    /// Read out of the access token's JWT `exp` claim when it has one. Codex
    /// stores no expiry field in auth.json, so this stays None for opaque
    /// tokens and callers must treat that as "unknown", not "expired".
    pub access_expires_at_ms: Option<i64>,
}

fn redacted(value: &str) -> String {
    format!("<redacted len={}>", value.len())
}

impl fmt::Debug for ClaudeTokens {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeTokens")
            .field("access_token", &redacted(&self.access_token))
            .field("refresh_token", &redacted(&self.refresh_token))
            .field("expires_at_ms", &self.expires_at_ms)
            .field("refresh_expires_at_ms", &self.refresh_expires_at_ms)
            .field("subscription_type", &self.subscription_type)
            .finish()
    }
}

impl fmt::Debug for CodexTokens {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CodexTokens")
            .field("access_token", &redacted(&self.access_token))
            .field(
                "refresh_token",
                &self.refresh_token.as_deref().map(redacted),
            )
            .field("account_id", &self.account_id)
            .field("id_token", &self.id_token.as_deref().map(redacted))
            .field("access_expires_at_ms", &self.access_expires_at_ms)
            .finish()
    }
}

fn required_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Missing required token field: {key}"))
}

fn optional_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
    })
}

fn timestamp_ms(value: &Value, key: &str) -> Result<i64, String> {
    let raw = value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("Missing required timestamp field: {key}"))?;
    Ok(normalize_timestamp_ms(raw))
}

fn optional_timestamp_ms(value: &Value, key: &str) -> Result<Option<i64>, String> {
    value
        .get(key)
        .map(|value| {
            value
                .as_i64()
                .map(normalize_timestamp_ms)
                .ok_or_else(|| format!("Invalid timestamp field: {key}"))
        })
        .transpose()
}

fn normalize_timestamp_ms(value: i64) -> i64 {
    if value < 10_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    }
}

fn original_uses_seconds(value: &Value, key: &str) -> Result<bool, String> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .map(|value| value < 10_000_000_000)
        .ok_or_else(|| format!("Missing required timestamp field: {key}"))
}

fn timestamp_value(value_ms: i64, seconds: bool) -> Value {
    Value::Number(Number::from(if seconds {
        value_ms / 1000
    } else {
        value_ms
    }))
}

fn top_level_object(text: &str, key: &str) -> Result<Value, String> {
    let member = json_splice::extract_top_level_member(text, key)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Missing top-level member: {key}"))?;
    let value: Value = serde_json::from_str(member).map_err(|error| error.to_string())?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(format!("Top-level member is not an object: {key}"))
    }
}

pub fn claude_tokens(credentials_text: &str) -> Result<ClaudeTokens, String> {
    let oauth = top_level_object(credentials_text, "claudeAiOauth")?;
    Ok(ClaudeTokens {
        access_token: required_string(&oauth, "accessToken")?,
        refresh_token: required_string(&oauth, "refreshToken")?,
        expires_at_ms: timestamp_ms(&oauth, "expiresAt")?,
        refresh_expires_at_ms: optional_timestamp_ms(&oauth, "refreshTokenExpiresAt")?,
        subscription_type: optional_string(&oauth, &["subscriptionType"]),
    })
}

pub fn codex_tokens(auth_text: &str) -> Result<CodexTokens, String> {
    let tokens = top_level_object(auth_text, "tokens")?;
    let access_token = optional_string(
        &tokens,
        &["access_token", "accessToken", "id_token", "idToken"],
    )
    .ok_or_else(|| "Missing Codex access token".to_string())?;
    let access_expires_at_ms = jwt_expiry_ms(&access_token);
    Ok(CodexTokens {
        access_token,
        refresh_token: optional_string(&tokens, &["refresh_token", "refreshToken"]),
        account_id: optional_string(&tokens, &["account_id", "accountId"]),
        id_token: optional_string(&tokens, &["id_token", "idToken"]),
        access_expires_at_ms,
    })
}

/// Best-effort expiry for a Codex access token. Reuses the identity decoder, so
/// there is one JWT parser in the tree. A token that is not a JWT, or one
/// without a numeric `exp`, yields None -- an unknown expiry, not an expired one.
fn jwt_expiry_ms(token: &str) -> Option<i64> {
    crate::cli_accounts::codex::decode_id_token_claims(token)
        .ok()
        .and_then(|claims| claims.expires_at_ms)
}

pub fn claude_credentials_with(
    credentials_text: &str,
    next: &ClaudeTokens,
) -> Result<String, String> {
    let mut oauth = top_level_object(credentials_text, "claudeAiOauth")?;
    let expires_in_seconds = original_uses_seconds(&oauth, "expiresAt")?;
    let current_refresh = required_string(&oauth, "refreshToken")?;
    let refresh_expiry_in_seconds = oauth
        .get("refreshTokenExpiresAt")
        .map(|_| original_uses_seconds(&oauth, "refreshTokenExpiresAt"))
        .transpose()?;
    let object = oauth
        .as_object_mut()
        .ok_or_else(|| "Top-level member is not an object: claudeAiOauth".to_string())?;
    object.insert(
        "accessToken".to_string(),
        Value::String(next.access_token.clone()),
    );
    object.insert(
        "expiresAt".to_string(),
        timestamp_value(next.expires_at_ms, expires_in_seconds),
    );
    if current_refresh != next.refresh_token {
        object.insert(
            "refreshToken".to_string(),
            Value::String(next.refresh_token.clone()),
        );
    }
    if let Some(refresh_expires_at_ms) = next.refresh_expires_at_ms {
        object.insert(
            "refreshTokenExpiresAt".to_string(),
            timestamp_value(
                refresh_expires_at_ms,
                refresh_expiry_in_seconds.unwrap_or(false),
            ),
        );
    }
    let replacement = serde_json::to_string(&oauth).map_err(|error| error.to_string())?;
    json_splice::replace_top_level_member(credentials_text, "claudeAiOauth", &replacement)
        .map_err(|error| error.to_string())
}

pub fn codex_auth_with(
    auth_text: &str,
    next: &CodexTokens,
    last_refresh_rfc3339: Option<&str>,
) -> Result<String, String> {
    let mut tokens = top_level_object(auth_text, "tokens")?;
    let object = tokens
        .as_object_mut()
        .ok_or_else(|| "Top-level member is not an object: tokens".to_string())?;
    replace_existing_string(object, &["access_token", "accessToken"], &next.access_token);
    if let Some(refresh_token) = &next.refresh_token {
        replace_existing_string(object, &["refresh_token", "refreshToken"], refresh_token);
    }
    if let Some(account_id) = &next.account_id {
        replace_existing_string(object, &["account_id", "accountId"], account_id);
    }
    if let Some(id_token) = &next.id_token {
        replace_existing_string(object, &["id_token", "idToken"], id_token);
    }
    let replacement = serde_json::to_string(&tokens).map_err(|error| error.to_string())?;
    let updated = json_splice::replace_top_level_member(auth_text, "tokens", &replacement)
        .map_err(|error| error.to_string())?;
    replace_last_refresh(&updated, last_refresh_rfc3339)
}

fn replace_existing_string(
    object: &mut serde_json::Map<String, Value>,
    keys: &[&str],
    value: &str,
) {
    for key in keys {
        if object.contains_key(*key) {
            object.insert((*key).to_string(), Value::String(value.to_string()));
        }
    }
}

fn replace_last_refresh(auth_text: &str, next_rfc3339: Option<&str>) -> Result<String, String> {
    let Some(next_rfc3339) = next_rfc3339 else {
        return Ok(auth_text.to_string());
    };
    let Some(member) = json_splice::extract_top_level_member(auth_text, "last_refresh")
        .map_err(|error| error.to_string())?
    else {
        return Ok(auth_text.to_string());
    };
    let current: Value = serde_json::from_str(member).map_err(|error| error.to_string())?;
    let replacement = if current.is_string() {
        Value::String(next_rfc3339.to_string())
    } else if let Some(number) = current.as_i64() {
        let parsed = chrono::DateTime::parse_from_rfc3339(next_rfc3339)
            .map_err(|error| error.to_string())?;
        Value::Number(Number::from(if number < 10_000_000_000 {
            parsed.timestamp()
        } else {
            parsed.timestamp_millis()
        }))
    } else {
        return Ok(auth_text.to_string());
    };
    let replacement = serde_json::to_string(&replacement).map_err(|error| error.to_string())?;
    json_splice::replace_top_level_member(auth_text, "last_refresh", &replacement)
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenPlan {
    UseLive,
    WaitForCli,
    UseSnapshot,
    RefreshSnapshot,
    NeedsRelogin,
}

/// Decide where a row's access token comes from.
///
/// `access_expires_at_ms` is None when the expiry is unknown, which is the norm
/// for Codex: auth.json carries no expiry field and the access token is not
/// always a JWT. Unknown is not expired. Treating it as expired would hide the
/// active account's usage behind WaitForCli and re-refresh every inactive
/// snapshot on every poll, so an unknown expiry falls through to "try the token
/// we already hold" and lets a 401 be the thing that triggers a refresh.
pub fn plan_token_source(
    is_active: bool,
    access_expires_at_ms: Option<i64>,
    refresh_expires_at_ms: Option<i64>,
    now_ms: i64,
) -> TokenPlan {
    let access_expired = access_expires_at_ms
        .is_some_and(|expires_at_ms| now_ms.saturating_add(REFRESH_MARGIN_MS) >= expires_at_ms);
    if is_active {
        // Never refresh an account the CLI is logged into. Both processes would
        // be spending the same refresh token, and if the provider rotates it the
        // loser is logged out -- which for the CLI means the user's terminal.
        return if access_expired {
            TokenPlan::WaitForCli
        } else {
            TokenPlan::UseLive
        };
    }
    if refresh_expires_at_ms.is_some_and(|expires_at_ms| expires_at_ms <= now_ms) {
        return TokenPlan::NeedsRelogin;
    }
    if access_expired {
        TokenPlan::RefreshSnapshot
    } else {
        TokenPlan::UseSnapshot
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_tokens_parses_fixture() {
        let tokens = claude_tokens(include_str!(
            "../cli_accounts/fixtures/claude_credentials_sample.json"
        ))
        .unwrap();
        assert_eq!(tokens.access_token, "synthetic-access");
        assert_eq!(tokens.refresh_token, "synthetic-refresh");
        assert_eq!(tokens.expires_at_ms, 4_102_444_800_000);
        assert_eq!(tokens.refresh_expires_at_ms, Some(4_102_444_800_000));
        assert_eq!(tokens.subscription_type.as_deref(), Some("max"));
        let seconds = r#"{"claudeAiOauth":{"accessToken":"synthetic-access","refreshToken":"synthetic-refresh","expiresAt":4102444800,"refreshTokenExpiresAt":4102444800}}"#;
        assert_eq!(
            claude_tokens(seconds).unwrap().expires_at_ms,
            tokens.expires_at_ms
        );
        assert_eq!(
            claude_tokens(seconds).unwrap().refresh_expires_at_ms,
            tokens.refresh_expires_at_ms
        );
    }

    #[test]
    fn claude_writeback_preserves_sibling_bytes() {
        let text = "{\n  \"before\" : [ 1, 2 ],\n  \"claudeAiOauth\" : { \"accessToken\": \"synthetic-access\", \"refreshToken\": \"synthetic-refresh\", \"expiresAt\": 4102444800 },\n  \"after\" : { \"keep\" : true }\n}";
        let next = ClaudeTokens {
            access_token: "synthetic-next-access".into(),
            refresh_token: "synthetic-refresh".into(),
            expires_at_ms: 4_102_444_900_000,
            refresh_expires_at_ms: None,
            subscription_type: None,
        };
        let updated = claude_credentials_with(text, &next).unwrap();
        let (start, end) = json_splice::find_top_level_member(text, "claudeAiOauth")
            .unwrap()
            .unwrap();
        assert_eq!(&updated[..start], &text[..start]);
        assert_eq!(&updated[updated.len() - (text.len() - end)..], &text[end..]);
        serde_json::from_str::<Value>(&updated).unwrap();
    }

    #[test]
    fn claude_writeback_keeps_original_expiry_unit() {
        for (source, expected) in [
            (
                r#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":4102444800}}"#,
                "4102444801",
            ),
            (
                r#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":4102444800000}}"#,
                "4102444801000",
            ),
        ] {
            let next = ClaudeTokens {
                access_token: "b".into(),
                refresh_token: "r".into(),
                expires_at_ms: 4_102_444_801_000,
                refresh_expires_at_ms: None,
                subscription_type: None,
            };
            assert!(claude_credentials_with(source, &next)
                .unwrap()
                .contains(expected));
        }
    }

    #[test]
    fn codex_writeback_preserves_openai_api_key_and_auth_mode() {
        let source = "{\n \"auth_mode\" : \"chatgpt\",\n \"OPENAI_API_KEY\" : \"synthetic-key\",\n \"tokens\" : {\"access_token\":\"synthetic-access\",\"refresh_token\":\"synthetic-refresh\"}\n}";
        let next = CodexTokens {
            access_token: "synthetic-next-access".into(),
            refresh_token: Some("synthetic-next-refresh".into()),
            account_id: Some("synthetic-account".into()),
            id_token: Some("synthetic-next-id".into()),
            access_expires_at_ms: None,
        };
        let updated = codex_auth_with(source, &next, None).unwrap();
        let (start, end) = json_splice::find_top_level_member(source, "tokens")
            .unwrap()
            .unwrap();
        assert_eq!(&updated[..start], &source[..start]);
        assert_eq!(
            &updated[updated.len() - (source.len() - end)..],
            &source[end..]
        );
    }

    #[test]
    fn codex_tokens_falls_back_to_id_token() {
        let source = r#"{"tokens":{"id_token":"synthetic-id-token"}}"#;
        assert_eq!(
            codex_tokens(source).unwrap().access_token,
            "synthetic-id-token"
        );
    }

    #[test]
    fn plan_token_source_never_refreshes_active() {
        let now = 1_000_000;
        // Whatever we know or do not know about the expiry, an account the CLI
        // is logged into is only ever read. Refreshing it would spend the same
        // refresh token the CLI holds and can log the user out of their shell.
        for expires_at in [
            Some(now - 1),
            Some(now + REFRESH_MARGIN_MS - 1),
            Some(now + REFRESH_MARGIN_MS),
            Some(now + REFRESH_MARGIN_MS + 1),
            None,
        ] {
            for refresh_expires_at in [Some(now - 1), Some(now + 1), None] {
                let plan = plan_token_source(true, expires_at, refresh_expires_at, now);
                assert!(
                    matches!(plan, TokenPlan::UseLive | TokenPlan::WaitForCli),
                    "active row planned {plan:?} for expiry {expires_at:?}"
                );
            }
        }
    }

    #[test]
    fn plan_token_source_unknown_expiry_uses_current_token() {
        let now = 1_000_000;
        // Codex stores no expiry. Unknown must not be read as expired: doing so
        // hid the active account's usage entirely and re-refreshed every
        // inactive snapshot on every poll.
        assert_eq!(plan_token_source(true, None, None, now), TokenPlan::UseLive);
        assert_eq!(
            plan_token_source(false, None, None, now),
            TokenPlan::UseSnapshot
        );
        // A dead refresh token still wins over an unknown access expiry.
        assert_eq!(
            plan_token_source(false, None, Some(now - 1), now),
            TokenPlan::NeedsRelogin
        );
    }

    fn synthetic_jwt(payload: &str) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        format!(
            "{}.{}.{}",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#),
            URL_SAFE_NO_PAD.encode(payload.as_bytes()),
            URL_SAFE_NO_PAD.encode(b"sig")
        )
    }

    #[test]
    fn codex_tokens_reads_jwt_expiry() {
        let jwt = synthetic_jwt(r#"{"exp":2000000000,"email":"synthetic@example.test"}"#);
        let auth = format!(r#"{{"tokens":{{"access_token":"{jwt}"}}}}"#);
        assert_eq!(
            codex_tokens(&auth).unwrap().access_expires_at_ms,
            Some(2_000_000_000_000)
        );

        // Opaque and malformed tokens leave the expiry unknown rather than
        // failing the read -- callers treat None as "try it and see".
        for token in [
            "synthetic-opaque-token",
            "not.a.jwt",
            "only-one-segment",
            "a.b.c.d",
        ] {
            let auth = format!(r#"{{"tokens":{{"access_token":"{token}"}}}}"#);
            let tokens = codex_tokens(&auth).expect("token still parses");
            assert_eq!(tokens.access_expires_at_ms, None, "token {token}");
        }

        // A JWT without a numeric exp is also unknown, not an error.
        let no_exp = synthetic_jwt(r#"{"email":"synthetic@example.test"}"#);
        let auth = format!(r#"{{"tokens":{{"access_token":"{no_exp}"}}}}"#);
        assert_eq!(codex_tokens(&auth).unwrap().access_expires_at_ms, None);
    }

    #[test]
    fn codex_auth_with_ignores_access_expiry() {
        let source = r#"{"tokens":{"access_token":"synthetic-access"}}"#;
        let next = CodexTokens {
            access_token: "synthetic-next-access".into(),
            refresh_token: None,
            account_id: None,
            id_token: None,
            access_expires_at_ms: Some(2_000_000_000_000),
        };
        let updated = codex_auth_with(source, &next, None).unwrap();
        // auth.json has no field for the expiry, so none may be invented.
        assert!(!updated.contains("access_expires_at_ms"));
        assert!(!updated.contains("2000000000000"));
        let tokens = serde_json::from_str::<Value>(&updated).unwrap()["tokens"].clone();
        assert_eq!(tokens["access_token"], "synthetic-next-access");
        assert_eq!(tokens.as_object().unwrap().len(), 1);
    }

    #[test]
    fn plan_token_source_table() {
        let now = 1_000_000;
        for (active, access, refresh, expected) in [
            (true, now + REFRESH_MARGIN_MS + 1, None, TokenPlan::UseLive),
            (true, now + REFRESH_MARGIN_MS, None, TokenPlan::WaitForCli),
            (
                false,
                now + REFRESH_MARGIN_MS + 1,
                Some(now),
                TokenPlan::NeedsRelogin,
            ),
            (
                false,
                now + REFRESH_MARGIN_MS + 1,
                None,
                TokenPlan::UseSnapshot,
            ),
            (
                false,
                now + REFRESH_MARGIN_MS,
                None,
                TokenPlan::RefreshSnapshot,
            ),
        ] {
            assert_eq!(plan_token_source(active, Some(access), refresh, now), expected);
        }
    }

    #[test]
    fn tokens_debug_is_redacted() {
        let claude = ClaudeTokens {
            access_token: "synthetic-access".into(),
            refresh_token: "synthetic-refresh".into(),
            expires_at_ms: 1,
            refresh_expires_at_ms: None,
            subscription_type: None,
        };
        let codex = CodexTokens {
            access_token: "synthetic-access".into(),
            refresh_token: Some("synthetic-refresh".into()),
            account_id: None,
            id_token: Some("synthetic-id".into()),
            access_expires_at_ms: None,
        };
        let text = format!("{claude:?} {codex:?}");
        assert!(!text.contains("synthetic-access"));
        assert!(!text.contains("synthetic-refresh"));
    }

    #[test]
    fn codex_writeback_does_not_invent_missing_keys() {
        let source = r#"{"tokens":{"id_token":"synthetic-id"}}"#;
        let next = CodexTokens {
            access_token: "synthetic-access".into(),
            refresh_token: Some("synthetic-refresh".into()),
            account_id: Some("synthetic-account".into()),
            id_token: Some("synthetic-next-id".into()),
            access_expires_at_ms: None,
        };
        let updated = codex_auth_with(source, &next, None).unwrap();
        let tokens = serde_json::from_str::<Value>(&updated).unwrap()["tokens"].clone();
        assert!(tokens.get("access_token").is_none());
        assert!(tokens.get("refresh_token").is_none());
        assert!(tokens.get("account_id").is_none());
        assert_eq!(tokens["id_token"], "synthetic-next-id");
    }

    #[test]
    fn codex_writeback_updates_last_refresh_only_when_present() {
        let next = CodexTokens {
            access_token: "synthetic-next-access".into(),
            refresh_token: None,
            account_id: None,
            id_token: None,
            access_expires_at_ms: None,
        };
        let string_source = r#"{"last_refresh":"old","tokens":{"access_token":"old"}}"#;
        let string_updated =
            codex_auth_with(string_source, &next, Some("2026-08-08T00:00:00Z")).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&string_updated).unwrap()["last_refresh"],
            "2026-08-08T00:00:00Z"
        );
        let number_source = r#"{"last_refresh":100,"tokens":{"access_token":"old"}}"#;
        let number_updated =
            codex_auth_with(number_source, &next, Some("2026-08-08T00:00:00Z")).unwrap();
        assert!(
            serde_json::from_str::<Value>(&number_updated).unwrap()["last_refresh"].is_number()
        );
        let absent = r#"{"tokens":{"access_token":"old"}}"#;
        let absent_updated = codex_auth_with(absent, &next, Some("2026-08-08T00:00:00Z")).unwrap();
        assert!(serde_json::from_str::<Value>(&absent_updated)
            .unwrap()
            .get("last_refresh")
            .is_none());
    }
}
