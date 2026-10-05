//! Account metadata is independent of usage windows and token expiry.
//! Only dates returned by the provider are suitable for contract display.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;

pub const SUBSCRIPTION_CACHE_TTL_MS: i64 = 900_000;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionSource {
    ClaudeProfile,
    CodexUsage,
    CodexSubscription,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct AccountSubscription {
    pub plan: Option<String>,
    pub source: SubscriptionSource,
    pub checked_at: String,
    pub started_at: Option<String>,
    pub renews_at: Option<String>,
    pub ends_at: Option<String>,
    pub will_renew: Option<bool>,
}

#[derive(Clone, Default)]
pub struct CachedSubscription {
    pub identity_key: Option<String>,
    pub info: Option<AccountSubscription>,
    pub next_check_at_ms: i64,
    pub last_usage_plan: Option<String>,
    pub last_attempt_failed: bool,
}

pub fn plan_name(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|plan| !plan.is_empty() && plan.len() <= 80 && !plan.chars().any(char::is_control))
        .map(str::to_string)
}

fn date(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|date| date.to_rfc3339())
}

pub fn claude_profile(value: &Value, checked_at: String) -> AccountSubscription {
    let org = &value["organization"];
    let org_type = org["organization_type"].as_str();
    let personal = matches!(
        org_type,
        None | Some("claude_max" | "max" | "claude_pro" | "pro" | "claude_free" | "free")
    );
    let has_max = value["account"]["has_claude_max"].as_bool();
    let has_pro = value["account"]["has_claude_pro"].as_bool();
    let plan = if personal && has_max == Some(true) {
        Some("max")
    } else if personal && has_pro == Some(true) {
        Some("pro")
    } else if personal && has_max == Some(false) && has_pro == Some(false) {
        // Personal entitlements can end while the organization keeps its old type.
        Some("free")
    } else {
        match org_type {
            Some("claude_max" | "max") => Some("max"),
            Some("claude_pro" | "pro") => Some("pro"),
            Some("claude_team" | "team") => Some("team"),
            Some("claude_enterprise" | "enterprise") => Some("enterprise"),
            Some("claude_free" | "free") => Some("free"),
            _ => None,
        }
    }
    .map(str::to_string);
    AccountSubscription {
        plan,
        source: SubscriptionSource::ClaudeProfile,
        checked_at,
        started_at: date(org.get("subscription_created_at")),
        // The OAuth profile does not expose the billing period's boundary.
        renews_at: None,
        ends_at: None,
        will_renew: None,
    }
}

pub fn codex_usage(plan: String, checked_at: String) -> AccountSubscription {
    AccountSubscription {
        plan: Some(plan),
        source: SubscriptionSource::CodexUsage,
        checked_at,
        started_at: None,
        renews_at: None,
        ends_at: None,
        will_renew: None,
    }
}

/// The response of GET /backend-api/subscriptions?account_id=...
/// Cancellation wins over the entitlement's historical `renews_at` value.
pub fn codex_subscription(value: &Value, checked_at: String) -> Option<AccountSubscription> {
    let has_active = value
        .pointer("/entitlement/has_active_subscription")
        .and_then(Value::as_bool)
        .or_else(|| value["is_active"].as_bool());
    let plan = if has_active == Some(false) {
        Some("free".to_string())
    } else {
        plan_name(value.get("plan_type"))
    };
    if plan.is_none() {
        return None;
    }
    let will_renew = value["will_renew"].as_bool().or_else(|| {
        value
            .pointer("/last_active_subscription/will_renew")
            .and_then(Value::as_bool)
    });
    let active_until = date(value.get("active_until"));
    let cancels_at = date(value.pointer("/entitlement/cancels_at"));
    let (renews_at, ends_at) = if plan.as_deref() == Some("free") {
        (None, None)
    } else if will_renew == Some(false) {
        (
            None,
            cancels_at
                .or(active_until)
                .or_else(|| date(value.pointer("/entitlement/expires_at"))),
        )
    } else if will_renew == Some(true) && cancels_at.is_none() {
        (
            date(value.pointer("/entitlement/renews_at")).or(active_until),
            None,
        )
    } else {
        (None, cancels_at)
    };
    Some(AccountSubscription {
        plan,
        source: SubscriptionSource::CodexSubscription,
        checked_at,
        started_at: date(value.get("active_start")),
        renews_at,
        ends_at,
        will_renew,
    })
}

pub fn codex_subscription_url(usage_url: &str, account_id: &str) -> Option<reqwest::Url> {
    if account_id.trim().is_empty() {
        return None;
    }
    let mut url = reqwest::Url::parse(usage_url).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || !matches!(url.host_str(), Some("chatgpt.com" | "chat.openai.com"))
        || !matches!(
            url.path(),
            "/backend-api/wham/usage" | "/backend-api/codex/usage"
        )
    {
        return None;
    }
    url.set_path("/backend-api/subscriptions");
    url.set_query(None);
    url.query_pairs_mut().append_pair("account_id", account_id);
    Some(url)
}

/// Billing is best effort; it must never invalidate a working CLI login.
/// Return only a status code on failure, never provider response bodies.
pub async fn fetch_codex_at(
    client: &reqwest::Client,
    url: reqwest::Url,
    token: &str,
    account_id: &str,
) -> Result<AccountSubscription, (Option<u16>, Option<u64>)> {
    let response = client
        .get(url)
        .bearer_auth(token)
        .header("ChatGPT-Account-Id", account_id)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, "CodexBar")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| (None, None))?;
    let status = response.status();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok());
    if !status.is_success() {
        return Err((Some(status.as_u16()), retry_after));
    }
    let value = response.json::<Value>().await.map_err(|_| (None, None))?;
    // `id` names the subscription record, not the account (confirmed against
    // the live endpoint). The URL query and account header select the account.
    // Reject an explicit account identifier if a newer response supplies one.
    if value["account_id"]
        .as_str()
        .is_some_and(|id| id != account_id)
    {
        return Err((None, None));
    }
    codex_subscription(&value, Utc::now().to_rfc3339()).ok_or((None, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_plan_comes_from_current_profile_without_inventing_a_contract_date() {
        for (org_type, plan) in [
            ("claude_pro", "pro"),
            ("claude_free", "free"),
            ("claude_max", "max"),
        ] {
            let info = claude_profile(
                &json!({"organization": {"organization_type": org_type,
                "subscription_created_at": "2026-07-08T15:21:07Z",
                "claude_code_trial_ends_at": "2026-10-08T15:21:07Z"}}),
                "now".into(),
            );
            assert_eq!(info.plan.as_deref(), Some(plan));
            assert!(info.started_at.is_some());
            assert!(info.renews_at.is_none() && info.ends_at.is_none());
        }
        assert!(claude_profile(&json!({}), "now".into()).plan.is_none());
    }

    #[test]
    fn current_personal_entitlements_override_a_previous_paid_organization_type() {
        let body = json!({"account":{"has_claude_max":false,"has_claude_pro":false},
            "organization":{"organization_type":"claude_pro"}});
        assert_eq!(
            claude_profile(&body, "now".into()).plan.as_deref(),
            Some("free")
        );
        let pro = json!({"account":{"has_claude_max":false,"has_claude_pro":true},
            "organization":{"organization_type":"claude_max"}});
        assert_eq!(
            claude_profile(&pro, "now".into()).plan.as_deref(),
            Some("pro")
        );
        let team = json!({"account":{"has_claude_max":false,"has_claude_pro":false},
            "organization":{"organization_type":"claude_team"}});
        assert_eq!(
            claude_profile(&team, "now".into()).plan.as_deref(),
            Some("team")
        );
    }

    #[test]
    fn codex_cancellation_takes_precedence_over_entitlement_renewal() {
        let mut body = json!({"plan_type":"prolite", "will_renew":false,
            "active_until":"2026-10-13T22:06:51Z", "entitlement": {
                "has_active_subscription":true, "renews_at":"2026-10-13T22:06:51+00:00",
                "cancels_at":null}});
        let ends = codex_subscription(&body, "now".into()).unwrap();
        assert_eq!(ends.plan.as_deref(), Some("prolite"));
        assert!(ends.renews_at.is_none());
        assert_eq!(ends.ends_at.as_deref(), Some("2026-10-13T22:06:51+00:00"));
        body["will_renew"] = json!(true);
        let renews = codex_subscription(&body, "now".into()).unwrap();
        assert!(renews.renews_at.is_some() && renews.ends_at.is_none());
        body["entitlement"]["has_active_subscription"] = json!(false);
        let free = codex_subscription(&body, "now".into()).unwrap();
        assert_eq!(free.plan.as_deref(), Some("free"));
        assert!(free.renews_at.is_none() && free.ends_at.is_none());
    }

    #[test]
    fn unknown_renewal_state_and_invalid_dates_stay_unknown() {
        let body = json!({"plan_type":"future_plan", "active_until":"2026-10-13T22:06:51Z"});
        let info = codex_subscription(&body, "now".into()).unwrap();
        assert_eq!(info.plan.as_deref(), Some("future_plan"));
        assert!(info.renews_at.is_none() && info.ends_at.is_none());
        assert!(codex_subscription(&json!({}), "now".into()).is_none());
        assert!(codex_subscription(
            &json!({"plan_type":"pro", "will_renew":true,
            "active_until":"invalid"}),
            "now".into()
        )
        .unwrap()
        .renews_at
        .is_none());
    }

    #[test]
    fn subscription_request_stays_with_the_verified_chatgpt_origin() {
        let url =
            codex_subscription_url("https://chatgpt.com/backend-api/wham/usage", "a&b").unwrap();
        assert_eq!(url.query_pairs().next().unwrap().1, "a&b");
        for url in [
            "https://example.test/backend-api/wham/usage",
            "https://chatgpt.com.example.test/backend-api/wham/usage",
            "http://chatgpt.com/backend-api/wham/usage",
            "https://chatgpt.com/api/codex/usage",
            "https://chatgpt.com:444/backend-api/wham/usage",
        ] {
            assert!(codex_subscription_url(url, "a").is_none());
        }
        let mut credentialed =
            reqwest::Url::parse("https://chatgpt.com/backend-api/wham/usage").unwrap();
        credentialed.set_username("fixture-user").unwrap();
        assert!(codex_subscription_url(credentialed.as_str(), "a").is_none());
    }

    #[tokio::test]
    async fn billing_fetch_scopes_the_account_and_rejects_foreign_responses() {
        let (base, request) = super::super::reset_tickets::fake_http_once(
            r#"{"id":"subscription-test","plan_type":"pro","will_renew":true,"active_until":"2026-11-01T00:00:00Z"}"#).await;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let mut url = reqwest::Url::parse(&format!("{base}/subscriptions")).unwrap();
        url.query_pairs_mut()
            .append_pair("account_id", "account-test");
        let info = fetch_codex_at(&client, url, "synthetic-access", "account-test")
            .await
            .unwrap();
        assert!(info.renews_at.is_some());
        let received = request.await.unwrap().to_lowercase();
        assert!(received.starts_with("get /subscriptions?account_id=account-test "));
        assert!(received.contains("chatgpt-account-id: account-test"));
        let (base, request) = super::super::reset_tickets::fake_http_once(
            r#"{"id":"subscription-test","account_id":"another-account","plan_type":"pro","will_renew":true,"active_until":"2026-11-01T00:00:00Z"}"#).await;
        assert_eq!(
            fetch_codex_at(
                &client,
                reqwest::Url::parse(&base).unwrap(),
                "synthetic-access",
                "account-test"
            )
            .await,
            Err((None, None))
        );
        request.await.unwrap();
    }
}
