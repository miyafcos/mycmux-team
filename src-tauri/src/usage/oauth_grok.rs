use serde_json::Value;

use super::{NamedWindow, WindowStat};
use super::util::normalize_pct;

pub const GROK_BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

pub struct GrokUsage {
    pub seven_day: Option<WindowStat>,
    pub model_windows: Vec<NamedWindow>,
}

pub async fn fetch_with_token(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<GrokUsage, (Option<u16>, String)> {
    let response = client
        .get(GROK_BILLING_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| (None, format!("network error: {error}")))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| (None, format!("response read failed: {error}")))?;
    if !status.is_success() {
        return Err((Some(status.as_u16()), format!("HTTP {}", status.as_u16())));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|error| (None, format!("JSON parse failed: {error}")))?;
    parse_usage(&value).ok_or_else(|| (None, "billing windows missing in response".to_string()))
}

pub fn parse_usage(value: &Value) -> Option<GrokUsage> {
    let config = value.get("config")?;
    let resets_at = config
        .get("currentPeriod")?
        .get("end")?
        .as_str()?
        .to_string();
    let seven_day = config
        .get("creditUsagePercent")
        .and_then(Value::as_f64)
        .map(|pct| WindowStat { pct: normalize_pct(pct), resets_at: resets_at.clone() });
    let model_windows = config
        .get("productUsage")
        .and_then(Value::as_array)
        .map(|products| {
            products.iter().filter_map(|product| {
                let key = product.get("product")?.as_str()?.to_string();
                let pct = product.get("usagePercent")?.as_f64()?;
                Some(NamedWindow {
                    key,
                    window: WindowStat { pct: normalize_pct(pct), resets_at: resets_at.clone() },
                })
            }).collect()
        })
        .unwrap_or_default();
    seven_day.map(|seven_day| GrokUsage { seven_day: Some(seven_day), model_windows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_weekly_and_product_windows() {
        let value: Value = serde_json::json!({"config":{"creditUsagePercent":64.0,"currentPeriod":{"end":"2026-08-27T00:00:00Z"},"productUsage":[{"product":"GrokBuild","usagePercent":58.0}]}});
        let usage = parse_usage(&value).unwrap();
        assert_eq!(usage.seven_day.unwrap().pct, 64.0);
        assert_eq!(usage.model_windows[0].key, "GrokBuild");
    }
}
