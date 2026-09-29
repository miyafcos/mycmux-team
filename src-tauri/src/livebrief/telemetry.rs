//! Session-level agent telemetry reconstructed from transcript records that
//! livebrief already reads. Extra I/O is not introduced here.
//!
//! Claude occupancy is the latest assistant turn's
//! `input + cache_read + cache_creation`. Codex occupancy is
//! `last_token_usage.total_tokens`, falling back to input + output.
//! Cost is the ailog reference table applied through `cost_for_turn`.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ailog::price::{self, cost_for_turn, PriceTable};

const COST_SOURCE_COMPUTED: &str = "computed";
const SYNTHETIC_MODEL: &str = "<synthetic>";
/// Known families only. Unknown names omit `pct`. Claude base is 200k except
/// Sonnet 5 / 4.6 (1M). Occupancy above a 200k window is promoted to 1M;
/// occupancy above 1M omits `pct`. GPT family fallback is 200k (claude-codex).
const CONTEXT_WINDOWS: &[(&str, u64)] = &[
    ("fable-5", 200_000),
    ("mythos-5", 200_000),
    ("mythos-preview", 200_000),
    ("opus-5", 200_000),
    ("opus-4.8", 200_000),
    ("opus-4.7", 200_000),
    ("opus-4.6", 200_000),
    ("opus-4.5", 200_000),
    ("opus-4.1", 200_000),
    ("opus-4.0", 200_000),
    ("sonnet-5", 1_000_000),
    ("sonnet-4.6", 1_000_000),
    ("sonnet-4.5", 200_000),
    ("sonnet-4.0", 200_000),
    ("haiku-4.5", 200_000),
    ("gpt-5.6", 200_000),
    ("gpt-5.5", 200_000),
    ("gpt-5.4", 200_000),
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTelemetry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<TelemetryModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<TelemetryContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<TelemetryCost>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<TelemetryTurns>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryModel {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pct: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryCost {
    pub usd: f64,
    pub source: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub partial: bool,
}

impl Eq for TelemetryCost {}
impl Eq for AgentTelemetry {}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryTurns {
    pub count: u32,
    pub compacts: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BillableTokens {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write_5m: i64,
    pub cache_write_1h: i64,
    pub model: Option<String>,
}

impl BillableTokens {
    fn mass(&self) -> i64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write_5m)
            .saturating_add(self.cache_write_1h)
    }

    fn saturating_sub(&self, other: &Self) -> Self {
        Self {
            input: (self.input - other.input).max(0),
            output: (self.output - other.output).max(0),
            cache_read: (self.cache_read - other.cache_read).max(0),
            cache_write_5m: (self.cache_write_5m - other.cache_write_5m).max(0),
            cache_write_1h: (self.cache_write_1h - other.cache_write_1h).max(0),
            model: self.model.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CodexTotals {
    pub input: i64,
    pub cached: i64,
    pub cache_write: i64,
    pub output: i64,
    pub total: i64,
    pub occupancy: i64,
}

#[derive(Clone, Debug, Default)]
pub struct TelemetryDelta {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub occupancy_tokens: Option<i64>,
    pub context_window: Option<u64>,
    pub billable: Option<BillableTokens>,
    pub turn_inc: u32,
    pub compact_inc: u32,
    pub real_turn: bool,
    pub clear_occupancy: bool,
}

impl TelemetryDelta {
    pub fn is_empty(&self) -> bool {
        self.model.is_none()
            && self.effort.is_none()
            && self.occupancy_tokens.is_none()
            && self.context_window.is_none()
            && self.billable.is_none()
            && self.turn_inc == 0
            && self.compact_inc == 0
            && !self.real_turn
            && !self.clear_occupancy
    }
}

#[derive(Clone, Debug, Default)]
pub struct TelemetryAccumulator {
    model: Option<String>,
    effort: Option<String>,
    occupancy_tokens: Option<i64>,
    context_window: Option<u64>,
    cost_usd: f64,
    priced_turns: u32,
    unpriced_turns: u32,
    turns: u32,
    compacts: u32,
}

impl TelemetryAccumulator {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn apply(&mut self, delta: TelemetryDelta) {
        if delta.is_empty() {
            return;
        }
        if delta.clear_occupancy {
            self.occupancy_tokens = None;
        }
        let model_changed = delta
            .model
            .as_ref()
            .is_some_and(|model| self.model.as_ref() != Some(model));
        if let Some(model) = delta.model.clone() {
            self.model = Some(model);
        }
        if model_changed {
            self.context_window = None;
        }
        if delta.real_turn {
            self.effort = delta.effort.clone();
        } else if let Some(effort) = delta.effort.clone() {
            self.effort = Some(effort);
        }
        if let Some(tokens) = delta.occupancy_tokens {
            self.occupancy_tokens = Some(tokens);
            if delta.context_window.is_some() {
                self.context_window = delta.context_window;
            }
        } else if let Some(window) = delta.context_window {
            self.context_window = Some(window);
        }
        self.turns = self.turns.saturating_add(delta.turn_inc);
        self.compacts = self.compacts.saturating_add(delta.compact_inc);
        if let Some(bill) = delta.billable {
            if bill.mass() > 0 {
                let model = bill
                    .model
                    .as_deref()
                    .or(self.model.as_deref())
                    .unwrap_or("");
                let price = price_table().lookup(model).map(|row| &row.price);
                if price.is_some() {
                    self.priced_turns = self.priced_turns.saturating_add(1);
                    self.cost_usd += cost_for_turn(
                        price,
                        bill.input,
                        bill.output,
                        bill.cache_read,
                        bill.cache_write_5m,
                        bill.cache_write_1h,
                    )
                    .total();
                } else {
                    self.unpriced_turns = self.unpriced_turns.saturating_add(1);
                }
            }
        }
    }

    pub fn to_telemetry(&self) -> Option<AgentTelemetry> {
        if self.model.is_none()
            && self.occupancy_tokens.is_none()
            && self.priced_turns == 0
            && self.unpriced_turns == 0
            && self.turns == 0
            && self.compacts == 0
        {
            return None;
        }
        let window = self
            .context_window
            .or_else(|| context_window_tokens(self.model.as_deref()));
        Some(AgentTelemetry {
            model: self.model.as_ref().map(|name| TelemetryModel {
                name: display_model_name(name),
                effort: self.effort.clone(),
            }),
            context: self.occupancy_tokens.map(|tokens| TelemetryContext {
                pct: occupancy_pct(tokens, window),
                tokens: Some(tokens),
            }),
            cost: (self.priced_turns > 0).then_some(TelemetryCost {
                usd: self.cost_usd,
                source: COST_SOURCE_COMPUTED.to_string(),
                partial: self.unpriced_turns > 0,
            }),
            turns: (self.turns > 0 || self.compacts > 0).then_some(TelemetryTurns {
                count: self.turns,
                compacts: self.compacts,
            }),
        })
    }
}

pub fn context_window_tokens(model: Option<&str>) -> Option<u64> {
    let raw = model?.trim();
    if raw.is_empty() {
        return None;
    }
    let id = price::normalize(raw);
    CONTEXT_WINDOWS
        .iter()
        .find(|(family, _)| *family == id.family || *family == raw)
        .map(|(_, window)| *window)
}

fn occupancy_pct(tokens: i64, window: Option<u64>) -> Option<u32> {
    let mut window = window?;
    if window == 0 || tokens < 0 {
        return None;
    }
    if tokens as u64 > window && window == 200_000 {
        window = 1_000_000;
    }
    if tokens as u64 > window {
        return None;
    }
    Some(((tokens as f64) * 100.0 / window as f64).round() as u32)
}

fn display_model_name(raw: &str) -> String {
    let id = price::normalize(raw);
    if id.family == id.raw {
        raw.trim().to_string()
    } else if let Some(variant) = &id.variant {
        format!("{}-{}", id.family, variant)
    } else {
        id.family
    }
}

fn price_table() -> &'static PriceTable {
    static TABLE: OnceLock<PriceTable> = OnceLock::new();
    TABLE.get_or_init(PriceTable::from_defaults)
}

pub fn extract_claude(
    value: &Value,
    billed_by_key: &mut HashMap<String, BillableTokens>,
) -> Option<TelemetryDelta> {
    if value
        .get("isSidechain")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
    if kind == "system"
        && value.get("subtype").and_then(Value::as_str) == Some("compact_boundary")
    {
        return Some(TelemetryDelta {
            compact_inc: 1,
            clear_occupancy: true,
            ..TelemetryDelta::default()
        });
    }
    if kind != "assistant" {
        return None;
    }
    let message = value.get("message").unwrap_or(value);
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    if model.as_deref() == Some(SYNTHETIC_MODEL) {
        return None;
    }
    let usage = message.get("usage")?;
    if usage.is_null() || !usage.is_object() {
        return None;
    }
    let effort = value
        .get("effort")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string);
    let input = json_i64(usage, "input_tokens");
    let output = json_i64(usage, "output_tokens");
    let cache_read = json_i64(usage, "cache_read_input_tokens");
    let (write_5m, write_1h) = cache_creation_split(usage);
    let occupancy = input
        .saturating_add(cache_read)
        .saturating_add(write_5m)
        .saturating_add(write_1h);
    let billed = BillableTokens {
        input,
        output,
        cache_read,
        cache_write_5m: write_5m,
        cache_write_1h: write_1h,
        model: model.clone(),
    };
    let turn_key = value
        .get("requestId")
        .and_then(Value::as_str)
        .or_else(|| message.get("id").and_then(Value::as_str))
        .or_else(|| value.get("uuid").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    let (turn_inc, billable) = if turn_key.is_empty() {
        (1, Some(billed))
    } else if let Some(previous) = billed_by_key.get(&turn_key) {
        if billed.mass() > previous.mass() {
            let increment = billed.saturating_sub(previous);
            billed_by_key.insert(turn_key, billed);
            (0, Some(increment))
        } else {
            (0, None)
        }
    } else {
        billed_by_key.insert(turn_key, billed.clone());
        (1, Some(billed))
    };
    Some(TelemetryDelta {
        model,
        effort,
        occupancy_tokens: Some(occupancy),
        billable,
        turn_inc,
        real_turn: true,
        ..TelemetryDelta::default()
    })
}

/// Codex rollout telemetry. Occupancy is the current turn (`last_token_usage`).
/// Billable cost is the positive diff of cumulative `total_token_usage`.
pub fn extract_codex(
    value: &Value,
    current_model: &mut Option<String>,
    current_effort: &mut Option<String>,
    last_total: &mut Option<CodexTotals>,
) -> Option<TelemetryDelta> {
    let payload = value.get("payload").unwrap_or(value);
    let outer = value.get("type").and_then(Value::as_str).unwrap_or_default();
    let inner = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match (outer, inner) {
        ("turn_context", _) => {
            if let Some(model) = payload.get("model").and_then(Value::as_str) {
                if !model.trim().is_empty() {
                    *current_model = Some(model.to_string());
                }
            }
            if let Some(effort) = payload
                .get("effort")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|effort| !effort.is_empty())
            {
                *current_effort = Some(effort.to_string());
            } else {
                *current_effort = None;
            }
            None
        }
        ("event_msg", "thread_settings_applied") => {
            let settings = payload
                .get("thread_settings")
                .cloned()
                .unwrap_or(Value::Null);
            if current_model.is_none() {
                *current_model = settings
                    .get("model")
                    .and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty())
                    .map(str::to_string);
            }
            if current_effort.is_none() {
                *current_effort = settings
                    .get("reasoning_effort")
                    .and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty())
                    .map(str::to_string);
            }
            None
        }
        ("event_msg", "context_compacted") | ("compacted", _) => Some(TelemetryDelta {
            compact_inc: 1,
            clear_occupancy: true,
            ..TelemetryDelta::default()
        }),
        ("event_msg", "token_count") => {
            let info = payload.get("info")?;
            let last = info.get("last_token_usage")?;
            if last.is_null() || !last.is_object() {
                return None;
            }
            let total_value = info
                .get("total_token_usage")
                .cloned()
                .unwrap_or(Value::Null);
            let last_input = json_i64(last, "input_tokens");
            let last_cached = json_i64(last, "cached_input_tokens");
            let last_output = json_i64(last, "output_tokens");
            let occupancy = last
                .get("total_tokens")
                .and_then(Value::as_i64)
                .unwrap_or_else(|| last_input.saturating_add(last_output));
            let totals = CodexTotals {
                input: json_i64(&total_value, "input_tokens"),
                cached: json_i64(&total_value, "cached_input_tokens"),
                cache_write: json_i64(&total_value, "cache_write_input_tokens"),
                output: json_i64(&total_value, "output_tokens"),
                total: json_i64(&total_value, "total_tokens"),
                occupancy,
            };
            if last_total
                .as_ref()
                .is_some_and(|prev| prev.total == totals.total && prev.occupancy == occupancy)
            {
                return None;
            }
            let window = info
                .get("model_context_window")
                .and_then(Value::as_u64)
                .or_else(|| {
                    info.get("model_context_window")
                        .and_then(Value::as_i64)
                        .and_then(|n| u64::try_from(n).ok())
                });
            let (billable, turn_inc) = match last_total.as_ref() {
                Some(prev) if prev.total == totals.total => (None, 0),
                Some(prev) => {
                    let d_input = (totals.input - prev.input).max(0);
                    let d_cached = (totals.cached - prev.cached).max(0);
                    (
                        Some(BillableTokens {
                            input: (d_input - d_cached).max(0),
                            output: (totals.output - prev.output).max(0),
                            cache_read: d_cached,
                            cache_write_5m: (totals.cache_write - prev.cache_write).max(0),
                            cache_write_1h: 0,
                            model: current_model.clone(),
                        }),
                        1,
                    )
                }
                None => (
                    Some(BillableTokens {
                        input: (last_input - last_cached).max(0),
                        output: last_output,
                        cache_read: last_cached,
                        cache_write_5m: json_i64(last, "cache_write_input_tokens"),
                        cache_write_1h: 0,
                        model: current_model.clone(),
                    }),
                    1,
                ),
            };
            *last_total = Some(totals);
            Some(TelemetryDelta {
                model: current_model.clone(),
                effort: current_effort.clone(),
                occupancy_tokens: Some(occupancy),
                context_window: window,
                billable,
                turn_inc,
                real_turn: true,
                ..TelemetryDelta::default()
            })
        }
        _ => None,
    }
}

fn cache_creation_split(usage: &Value) -> (i64, i64) {
    if let Some(detail) = usage.get("cache_creation") {
        let five = json_i64(detail, "ephemeral_5m_input_tokens");
        let hour = json_i64(detail, "ephemeral_1h_input_tokens");
        if five > 0 || hour > 0 {
            return (five, hour);
        }
    }
    (json_i64(usage, "cache_creation_input_tokens"), 0)
}

fn json_i64(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn claude_usage(input: i64, output: i64, cache_read: i64, cache_write: i64) -> Value {
        json!({
            "input_tokens": input,
            "output_tokens": output,
            "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": cache_write
        })
    }

    #[test]
    fn claude_later_usage_on_same_message_replaces_zero_first_billable() {
        let mut billed = HashMap::new();
        let first = extract_claude(
            &json!({
                "type": "assistant",
                "uuid": "u1",
                "message": {
                    "id": "resp_0664",
                    "model": "claude-sonnet-4-6",
                    "usage": claude_usage(0, 0, 0, 0)
                }
            }),
            &mut billed,
        )
        .unwrap();
        assert_eq!(first.turn_inc, 1);
        assert_eq!(first.occupancy_tokens, Some(0));

        let second = extract_claude(
            &json!({
                "type": "assistant",
                "uuid": "u2",
                "message": {
                    "id": "resp_0664",
                    "model": "claude-sonnet-4-6",
                    "usage": claude_usage(46_708, 755, 0, 0)
                }
            }),
            &mut billed,
        )
        .unwrap();
        assert_eq!(second.turn_inc, 0);
        assert_eq!(second.occupancy_tokens, Some(46_708));
        let increment = second.billable.as_ref().unwrap();
        assert_eq!(increment.input, 46_708);
        assert_eq!(increment.output, 755);

        let mut acc = TelemetryAccumulator::default();
        acc.apply(first);
        acc.apply(second);
        let telemetry = acc.to_telemetry().unwrap();
        assert_eq!(telemetry.turns.as_ref().unwrap().count, 1);
        assert!(telemetry.cost.as_ref().unwrap().usd > 0.0);
    }

    #[test]
    fn claude_synthetic_records_are_ignored() {
        let mut billed = HashMap::new();
        assert!(extract_claude(
            &json!({
                "type": "assistant",
                "message": {
                    "id": "end",
                    "model": "<synthetic>",
                    "usage": claude_usage(0, 0, 0, 0)
                }
            }),
            &mut billed,
        )
        .is_none());
    }

    #[test]
    fn claude_compact_clears_occupancy() {
        let mut billed = HashMap::new();
        let mut acc = TelemetryAccumulator::default();
        acc.apply(
            extract_claude(
                &json!({
                    "type": "assistant",
                    "requestId": "req_1",
                    "effort": "high",
                    "message": {
                        "id": "m1",
                        "model": "claude-sonnet-4-6",
                        "usage": claude_usage(68_000, 10, 0, 0)
                    }
                }),
                &mut billed,
            )
            .unwrap(),
        );
        assert_eq!(acc.to_telemetry().unwrap().context.as_ref().unwrap().pct, Some(7));
        acc.apply(
            extract_claude(
                &json!({"type": "system", "subtype": "compact_boundary"}),
                &mut billed,
            )
            .unwrap(),
        );
        let telemetry = acc.to_telemetry().unwrap();
        assert_eq!(telemetry.turns.as_ref().unwrap().compacts, 1);
        assert!(telemetry.context.is_none());
        assert_eq!(telemetry.model.as_ref().unwrap().effort.as_deref(), Some("high"));
    }

    #[test]
    fn claude_sidechain_is_ignored() {
        let mut billed = HashMap::new();
        assert!(extract_claude(
            &json!({
                "type": "assistant",
                "isSidechain": true,
                "requestId": "req",
                "message": {
                    "model": "claude-sonnet-4-6",
                    "usage": claude_usage(10, 10, 0, 0)
                }
            }),
            &mut billed,
        )
        .is_none());
    }

    #[test]
    fn unknown_model_omits_cost_and_pct() {
        let mut acc = TelemetryAccumulator::default();
        acc.apply(TelemetryDelta {
            model: Some("totally-unknown-model-x".to_string()),
            occupancy_tokens: Some(12_000),
            billable: Some(BillableTokens {
                input: 1000,
                output: 2000,
                ..BillableTokens::default()
            }),
            turn_inc: 1,
            real_turn: true,
            ..TelemetryDelta::default()
        });
        let telemetry = acc.to_telemetry().unwrap();
        assert_eq!(telemetry.model.as_ref().unwrap().name, "totally-unknown-model-x");
        assert_eq!(telemetry.context.as_ref().unwrap().tokens, Some(12_000));
        assert_eq!(telemetry.context.as_ref().unwrap().pct, None);
        assert!(telemetry.cost.is_none());
    }

    #[test]
    fn mixed_priced_and_unpriced_sets_partial_cost() {
        let mut acc = TelemetryAccumulator::default();
        acc.apply(TelemetryDelta {
            model: Some("claude-sonnet-4-6".to_string()),
            billable: Some(BillableTokens {
                input: 1_000_000,
                output: 0,
                model: Some("claude-sonnet-4-6".to_string()),
                ..BillableTokens::default()
            }),
            turn_inc: 1,
            real_turn: true,
            ..TelemetryDelta::default()
        });
        acc.apply(TelemetryDelta {
            model: Some("mystery-model".to_string()),
            billable: Some(BillableTokens {
                input: 1_000,
                output: 1_000,
                model: Some("mystery-model".to_string()),
                ..BillableTokens::default()
            }),
            turn_inc: 1,
            real_turn: true,
            ..TelemetryDelta::default()
        });
        let cost = acc.to_telemetry().unwrap().cost.unwrap();
        assert!((cost.usd - 3.0).abs() < 1e-9);
        assert!(cost.partial);
        assert_eq!(cost.source, "computed");
    }

    #[test]
    fn occupancy_above_1m_omits_pct() {
        let mut acc = TelemetryAccumulator::default();
        acc.apply(TelemetryDelta {
            model: Some("claude-sonnet-4-6".to_string()),
            occupancy_tokens: Some(1_200_000),
            real_turn: true,
            turn_inc: 1,
            ..TelemetryDelta::default()
        });
        let context = acc.to_telemetry().unwrap().context.unwrap();
        assert_eq!(context.tokens, Some(1_200_000));
        assert_eq!(context.pct, None);
    }

    #[test]
    fn opus_family_promotes_200k_to_1m_for_real_occupancy() {
        let mut acc = TelemetryAccumulator::default();
        acc.apply(TelemetryDelta {
            model: Some("opus-5".to_string()),
            occupancy_tokens: Some(349_426),
            real_turn: true,
            turn_inc: 1,
            ..TelemetryDelta::default()
        });
        let context = acc.to_telemetry().unwrap().context.unwrap();
        assert_eq!(context.tokens, Some(349_426));
        assert_eq!(context.pct, Some(35));
    }

    #[test]
    fn gpt_family_fallback_window_is_200k() {
        assert_eq!(context_window_tokens(Some("gpt-5.5")), Some(200_000));
        assert_eq!(context_window_tokens(Some("gpt-5.6")), Some(200_000));
        let mut acc = TelemetryAccumulator::default();
        acc.apply(TelemetryDelta {
            model: Some("gpt-5.5".to_string()),
            occupancy_tokens: Some(40_000),
            real_turn: true,
            turn_inc: 1,
            ..TelemetryDelta::default()
        });
        assert_eq!(acc.to_telemetry().unwrap().context.unwrap().pct, Some(20));
    }

    #[test]
    fn record_window_does_not_stick_after_windowless_model_change() {
        let mut acc = TelemetryAccumulator::default();
        acc.apply(TelemetryDelta {
            model: Some("gpt-5.5".to_string()),
            occupancy_tokens: Some(227_666),
            context_window: Some(258_400),
            real_turn: true,
            turn_inc: 1,
            ..TelemetryDelta::default()
        });
        assert_eq!(acc.to_telemetry().unwrap().context.unwrap().pct, Some(88));
        acc.apply(TelemetryDelta {
            model: Some("claude-sonnet-4-6".to_string()),
            occupancy_tokens: Some(68_000),
            context_window: None,
            real_turn: true,
            turn_inc: 1,
            ..TelemetryDelta::default()
        });
        let context = acc.to_telemetry().unwrap().context.unwrap();
        assert_eq!(context.tokens, Some(68_000));
        assert_eq!(context.pct, Some(7));
    }

    #[test]
    fn known_family_uses_its_own_window() {
        let mut acc = TelemetryAccumulator::default();
        acc.apply(TelemetryDelta {
            model: Some("claude-sonnet-4-6".to_string()),
            occupancy_tokens: Some(68_000),
            billable: Some(BillableTokens {
                input: 1_000_000,
                output: 0,
                model: Some("claude-sonnet-4-6".to_string()),
                ..BillableTokens::default()
            }),
            turn_inc: 1,
            real_turn: true,
            ..TelemetryDelta::default()
        });
        let telemetry = acc.to_telemetry().unwrap();
        assert_eq!(telemetry.context.as_ref().unwrap().pct, Some(7));
        assert!((telemetry.cost.as_ref().unwrap().usd - 3.0).abs() < 1e-9);
        assert!(!telemetry.cost.as_ref().unwrap().partial);
    }

    #[test]
    fn latest_real_turn_without_effort_clears_previous_effort() {
        let mut acc = TelemetryAccumulator::default();
        acc.apply(TelemetryDelta {
            model: Some("claude-sonnet-4-6".to_string()),
            effort: Some("high".to_string()),
            real_turn: true,
            turn_inc: 1,
            occupancy_tokens: Some(10),
            ..TelemetryDelta::default()
        });
        acc.apply(TelemetryDelta {
            model: Some("claude-sonnet-4-6".to_string()),
            effort: None,
            real_turn: true,
            turn_inc: 1,
            occupancy_tokens: Some(20),
            ..TelemetryDelta::default()
        });
        assert!(acc.to_telemetry().unwrap().model.unwrap().effort.is_none());
    }

    fn token_count(
        ordinal: i64,
        timestamp: &str,
        total: i64,
        last_input: i64,
        last_cached: i64,
        last_output: i64,
        window: Option<i64>,
        total_input: i64,
        total_cached: i64,
        total_output: i64,
        last_total: Option<i64>,
    ) -> Value {
        json!({
            "timestamp": timestamp,
            "ordinal": ordinal,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "model_context_window": window,
                    "total_token_usage": {
                        "input_tokens": total_input,
                        "cached_input_tokens": total_cached,
                        "cache_write_input_tokens": 0,
                        "output_tokens": total_output,
                        "total_tokens": total
                    },
                    "last_token_usage": {
                        "input_tokens": last_input,
                        "cached_input_tokens": last_cached,
                        "cache_write_input_tokens": 0,
                        "output_tokens": last_output,
                        "total_tokens": last_total.unwrap_or(last_input + last_output)
                    }
                }
            }
        })
    }

    #[test]
    fn codex_occupancy_uses_last_not_cumulative_total() {
        let mut model = Some("gpt-5.5".to_string());
        let mut effort = Some("high".to_string());
        let mut last_total = None;
        let delta = extract_codex(
            &token_count(
                1,
                "2026-08-25T00:08:45Z",
                10_012_216,
                227_460,
                100_000,
                206,
                Some(258_400),
                9_900_000,
                8_000_000,
                112_216,
                None,
            ),
            &mut model,
            &mut effort,
            &mut last_total,
        )
        .unwrap();
        assert_eq!(delta.occupancy_tokens, Some(227_666));
        assert_eq!(delta.context_window, Some(258_400));
        let mut acc = TelemetryAccumulator::default();
        acc.apply(delta);
        let context = acc.to_telemetry().unwrap().context.unwrap();
        assert_eq!(context.tokens, Some(227_666));
        assert_eq!(context.pct, Some(88));
    }

    #[test]
    fn codex_renotification_with_new_ordinal_same_total_is_skipped() {
        let mut model = Some("gpt-5.5".to_string());
        let mut effort = None;
        let mut last_total = None;
        let first = token_count(
            229,
            "2026-08-25T00:02:43.000Z",
            3_699_066,
            164_503,
            129_792,
            206,
            Some(258_400),
            3_500_000,
            2_000_000,
            199_066,
            None,
        );
        let second = token_count(
            232,
            "2026-08-25T00:02:44.000Z",
            3_699_066,
            164_503,
            129_792,
            206,
            Some(258_400),
            3_500_000,
            2_000_000,
            199_066,
            None,
        );
        let first_delta = extract_codex(&first, &mut model, &mut effort, &mut last_total).unwrap();
        assert_eq!(first_delta.turn_inc, 1);
        assert!(extract_codex(&second, &mut model, &mut effort, &mut last_total).is_none());
    }

    #[test]
    fn codex_compact_then_smaller_last_resets_pct() {
        let mut model = Some("gpt-5.5".to_string());
        let mut effort = None;
        let mut last_total = None;
        let mut acc = TelemetryAccumulator::default();
        acc.apply(
            extract_codex(
                &token_count(
                    1,
                    "t0",
                    10_012_216,
                    227_460,
                    0,
                    206,
                    Some(258_400),
                    10_000_000,
                    0,
                    12_216,
                    None,
                ),
                &mut model,
                &mut effort,
                &mut last_total,
            )
            .unwrap(),
        );
        acc.apply(
            extract_codex(
                &json!({"type":"event_msg","payload":{"type":"context_compacted"}}),
                &mut model,
                &mut effort,
                &mut last_total,
            )
            .unwrap(),
        );
        assert!(acc.to_telemetry().unwrap().context.is_none());
        acc.apply(
            extract_codex(
                &token_count(
                    2,
                    "t1",
                    10_012_216,
                    0,
                    0,
                    0,
                    Some(258_400),
                    10_000_000,
                    0,
                    12_216,
                    Some(30_698),
                ),
                &mut model,
                &mut effort,
                &mut last_total,
            )
            .unwrap(),
        );
        let context = acc.to_telemetry().unwrap().context.unwrap();
        assert_eq!(context.tokens, Some(30_698));
        assert_eq!(context.pct, Some(12));
    }

    #[test]
    fn codex_first_turn_bills_last_usage() {
        let mut model = Some("gpt-5.5".to_string());
        let mut effort = Some("high".to_string());
        let mut last_total = None;
        extract_codex(
            &json!({"type":"turn_context","payload":{"model":"gpt-5.5","effort":"high"}}),
            &mut model,
            &mut effort,
            &mut last_total,
        );
        let delta = extract_codex(
            &token_count(1, "t", 1100, 1000, 400, 100, Some(258_400), 1000, 400, 100, None),
            &mut model,
            &mut effort,
            &mut last_total,
        )
        .unwrap();
        assert_eq!(delta.occupancy_tokens, Some(1100));
        let bill = delta.billable.as_ref().unwrap();
        assert_eq!(bill.input, 600);
        assert_eq!(bill.cache_read, 400);
        assert_eq!(bill.output, 100);
        let mut acc = TelemetryAccumulator::default();
        acc.apply(delta);
        let telemetry = acc.to_telemetry().unwrap();
        assert_eq!(telemetry.model.as_ref().unwrap().effort.as_deref(), Some("high"));
        assert_eq!(telemetry.context.as_ref().unwrap().pct, Some(0));
    }

    #[test]
    fn codex_turn_context_without_effort_clears_extractor_effort() {
        let mut model = None;
        let mut effort = None;
        let mut last_total = None;
        let mut acc = TelemetryAccumulator::default();
        assert!(extract_codex(
            &json!({"type":"turn_context","payload":{"model":"gpt-5.5","effort":"high"}}),
            &mut model,
            &mut effort,
            &mut last_total,
        )
        .is_none());
        let first = extract_codex(
            &token_count(1, "t0", 1100, 1000, 400, 100, Some(258_400), 1000, 400, 100, None),
            &mut model,
            &mut effort,
            &mut last_total,
        )
        .unwrap();
        assert_eq!(first.effort.as_deref(), Some("high"));
        acc.apply(first);
        assert_eq!(
            acc.to_telemetry().unwrap().model.unwrap().effort.as_deref(),
            Some("high")
        );

        assert!(extract_codex(
            &json!({"type":"turn_context","payload":{"model":"gpt-5.5"}}),
            &mut model,
            &mut effort,
            &mut last_total,
        )
        .is_none());
        assert!(effort.is_none());
        let second = extract_codex(
            &token_count(2, "t1", 2200, 1000, 400, 100, Some(258_400), 2000, 800, 200, None),
            &mut model,
            &mut effort,
            &mut last_total,
        )
        .unwrap();
        assert!(second.effort.is_none());
        acc.apply(second);
        assert!(acc.to_telemetry().unwrap().model.unwrap().effort.is_none());
    }
}
