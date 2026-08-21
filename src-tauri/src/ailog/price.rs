//! Model-name normalisation and the reference price table.
//!
//! # Why the numbers here are "reference", not "cost"
//!
//! The operator of this app is on flat-rate plans (Claude Max, Codex Pro), so
//! nothing in the database is an invoice. Every amount answers a different
//! question: *if this exact traffic had been billed per token, what would it
//! have cost?* Every aggregation API therefore reports `price_source` so the
//! UI can label the figure as an estimate.
//!
//! # Sourcing rule
//!
//! A model only gets a row if a published rate was available when this table
//! was written. Anything else is classified explicitly and never receives a
//! nearby model's rate, because a wrong number that looks precise is worse
//! than an honest coverage boundary.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;

/// Deterministic classification rules for model names. These constants are the
/// single source of truth for the zero-configuration price policy.
pub const MODEL_CLASS_RULES: ModelClassRules = ModelClassRules {
    internal_exact: &["<synthetic>"],
    local_markers: &["ollama/"],
    flat_markers: &["fugu"],
    reported_markers: &["grok"],
    provider_prefixes: &[
        ("claude-", ModelProvider::Anthropic),
        ("gpt-", ModelProvider::Openai),
        ("gemini-", ModelProvider::Google),
        ("grok-", ModelProvider::Xai),
    ],
};

pub struct ModelClassRules {
    pub internal_exact: &'static [&'static str],
    pub local_markers: &'static [&'static str],
    pub flat_markers: &'static [&'static str],
    pub reported_markers: &'static [&'static str],
    pub provider_prefixes: &'static [(&'static str, ModelProvider)],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelClass {
    Priced,
    Local,
    Internal,
    Flat,
    Reported,
    Unknown,
}

/// Company inferred from a recorded model name. This is deliberately separate
/// from [`ModelClass`]: an unpriced `gpt-*` model is still OpenAI, while an
/// arbitrary slash-delimited local model has no cloud provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelProvider {
    Anthropic,
    Openai,
    Google,
    Xai,
    Local,
    Other,
}

impl ModelProvider {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Openai => "openai",
            Self::Google => "google",
            Self::Xai => "xai",
            Self::Local => "local",
            Self::Other => "other",
        }
    }
}

impl ModelClass {
    pub const fn is_covered(self) -> bool {
        matches!(
            self,
            Self::Priced | Self::Local | Self::Flat | Self::Reported
        )
    }
}

/// Per-million-token rates in USD.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write_5m: f64,
    pub cache_write_1h: f64,
}

impl Price {
    const fn anthropic(input: f64, output: f64) -> Self {
        // Anthropic publishes cache rates as multiples of the base input rate:
        // reads ~0.1x, 5-minute writes 1.25x, 1-hour writes 2x.
        Self {
            input,
            output,
            cache_read: input * 0.1,
            cache_write_5m: input * 1.25,
            cache_write_1h: input * 2.0,
        }
    }

    const fn openai(input: f64, output: f64, cache_read: f64) -> Self {
        // OpenAI bills a cache write as ordinary input (no write premium), so
        // both write columns mirror the input rate.
        Self {
            input,
            output,
            cache_read,
            cache_write_5m: input,
            cache_write_1h: input,
        }
    }
}

/// Reference rates, keyed by the most specific name that has its own price.
///
/// Anthropic rows: model list cached 2026-06-24 (Claude API reference).
/// OpenAI rows: GPT-5.6 Sol/Terra/Luna lineup recorded 2026-08-10;
/// terra/luna corrected and gpt-5.5 / gpt-5.4 added 2026-08-18
/// (independent aggregator cross-check + cache-read = 10% of input).
pub const DEFAULT_PRICES: &[(&str, Price)] = &[
    // --- Anthropic -------------------------------------------------------
    ("fable-5", Price::anthropic(10.0, 50.0)),
    ("mythos-5", Price::anthropic(10.0, 50.0)),
    ("opus-5", Price::anthropic(5.0, 25.0)),
    ("opus-4.8", Price::anthropic(5.0, 25.0)),
    ("opus-4.7", Price::anthropic(5.0, 25.0)),
    ("opus-4.6", Price::anthropic(5.0, 25.0)),
    ("sonnet-5", Price::anthropic(3.0, 15.0)),
    ("sonnet-4.6", Price::anthropic(3.0, 15.0)),
    ("haiku-4.5", Price::anthropic(1.0, 5.0)),
    // --- OpenAI (Codex) --------------------------------------------------
    ("gpt-5.6-sol", Price::openai(5.0, 30.0, 0.50)),
    ("gpt-5.6-terra", Price::openai(2.0, 12.0, 0.20)),
    ("gpt-5.6-luna", Price::openai(0.20, 1.20, 0.02)),
    ("gpt-5.5", Price::openai(5.0, 30.0, 0.50)),
    ("gpt-5.4", Price::openai(2.50, 15.00, 0.25)),
];

/// Stem -> display family. Longest matching stem wins; a raw string that
/// matches no stem is left completely alone (spec §4.4: never guess).
const FAMILY_STEMS: &[(&str, &str)] = &[
    ("claude-fable-5", "fable-5"),
    ("claude-mythos-5", "mythos-5"),
    ("claude-mythos-preview", "mythos-preview"),
    ("claude-opus-5", "opus-5"),
    ("claude-opus-4-8", "opus-4.8"),
    ("claude-opus-4-7", "opus-4.7"),
    ("claude-opus-4-6", "opus-4.6"),
    ("claude-opus-4-5", "opus-4.5"),
    ("claude-opus-4-1", "opus-4.1"),
    ("claude-opus-4-0", "opus-4.0"),
    ("claude-sonnet-5", "sonnet-5"),
    ("claude-sonnet-4-6", "sonnet-4.6"),
    ("claude-sonnet-4-5", "sonnet-4.5"),
    ("claude-sonnet-4-0", "sonnet-4.0"),
    ("claude-haiku-4-5", "haiku-4.5"),
    ("gpt-5.6", "gpt-5.6"),
    ("gpt-5.5", "gpt-5.5"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelId {
    pub raw: String,
    pub family: String,
    pub variant: Option<String>,
}

/// Split a raw model string into a display family plus a variant.
///
/// Recognised shapes (after a stem match): `<stem>`, `<stem>-<variant>` and
/// `<stem>[<variant>]`. Anything else — including a stem followed by an
/// unexpected character, such as `gpt-5.55` against the `gpt-5.5` stem — is
/// treated as unknown and passes through untouched.
pub fn normalize(raw: &str) -> ModelId {
    let trimmed = raw.trim();
    let mut best: Option<(&str, &str)> = None;
    for (stem, family) in FAMILY_STEMS {
        if !trimmed.starts_with(stem) {
            continue;
        }
        let rest = &trimmed[stem.len()..];
        let variant_ok = rest.is_empty()
            || rest.starts_with('-')
            || (rest.starts_with('[') && rest.ends_with(']'));
        if !variant_ok {
            continue;
        }
        if best.map_or(true, |(prev, _)| stem.len() > prev.len()) {
            best = Some((stem, family));
        }
    }

    match best {
        Some((stem, family)) => {
            let rest = &trimmed[stem.len()..];
            let variant = if rest.is_empty() {
                None
            } else if let Some(inner) = rest.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
                Some(inner.to_string())
            } else {
                rest.strip_prefix('-').map(str::to_string)
            };
            ModelId {
                raw: trimmed.to_string(),
                family: family.to_string(),
                variant: variant.filter(|v| !v.is_empty()),
            }
        }
        None => ModelId {
            raw: trimmed.to_string(),
            family: trimmed.to_string(),
            variant: None,
        },
    }
}

#[derive(Debug, Clone)]
pub struct PriceRow {
    pub model: String,
    pub price: Price,
    pub source: String,
    pub updated_at: i64,
}

/// In-memory view of the `price` table with the lookup ladder applied.
#[derive(Debug, Clone, Default)]
pub struct PriceTable {
    rows: HashMap<String, PriceRow>,
}

impl PriceTable {
    pub fn load(conn: &Connection) -> Result<Self, String> {
        let mut stmt = conn
            .prepare(
                "SELECT model, input_per_mtok, output_per_mtok, cache_read_per_mtok, \
                 cache_write_5m_per_mtok, cache_write_1h_per_mtok, source, updated_at FROM price",
            )
            .map_err(|err| format!("prepare price select: {err}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(PriceRow {
                    model: row.get(0)?,
                    price: Price {
                        input: row.get(1)?,
                        output: row.get(2)?,
                        cache_read: row.get(3)?,
                        cache_write_5m: row.get(4)?,
                        cache_write_1h: row.get(5)?,
                    },
                    source: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    updated_at: row.get::<_, Option<i64>>(7)?.unwrap_or_default(),
                })
            })
            .map_err(|err| format!("query price: {err}"))?;

        let mut map = HashMap::new();
        for row in rows {
            let row = row.map_err(|err| format!("read price row: {err}"))?;
            map.insert(row.model.clone(), row);
        }
        Ok(Self { rows: map })
    }

    pub fn from_defaults() -> Self {
        let mut rows = HashMap::new();
        for (model, price) in DEFAULT_PRICES {
            rows.insert(
                (*model).to_string(),
                PriceRow {
                    model: (*model).to_string(),
                    price: *price,
                    source: "default".to_string(),
                    updated_at: 0,
                },
            );
        }
        Self { rows }
    }

    pub fn all(&self) -> Vec<PriceRow> {
        let mut out: Vec<PriceRow> = self.rows.values().cloned().collect();
        out.sort_by(|a, b| a.model.cmp(&b.model));
        out
    }

    /// Classify a model before resolving a rate. Local, internal, and flat
    /// models intentionally do not resolve to an interchangeable catalog rate.
    pub fn classify(&self, raw: &str) -> ModelClass {
        let normalized = raw.trim().to_ascii_lowercase();
        if MODEL_CLASS_RULES
            .internal_exact
            .iter()
            .any(|name| raw.trim() == *name)
        {
            return ModelClass::Internal;
        }
        if is_local_model(raw, &normalized) {
            return ModelClass::Local;
        }
        if MODEL_CLASS_RULES
            .flat_markers
            .iter()
            .any(|marker| normalized.contains(marker))
        {
            return ModelClass::Flat;
        }
        if MODEL_CLASS_RULES
            .reported_markers
            .iter()
            .any(|marker| normalized.contains(marker))
        {
            return ModelClass::Reported;
        }
        if self.lookup_catalog(raw).is_some() {
            ModelClass::Priced
        } else {
            ModelClass::Unknown
        }
    }

    /// Classify the company from the raw model name using the same rule table
    /// as price classes. Local takes precedence so slash-delimited local
    /// distribution names cannot be misreported as a cloud model.
    pub fn provider(&self, raw: &str) -> ModelProvider {
        let normalized = raw.trim().to_ascii_lowercase();
        if is_local_model(raw, &normalized) {
            return ModelProvider::Local;
        }
        MODEL_CLASS_RULES
            .provider_prefixes
            .iter()
            .find_map(|(prefix, provider)| normalized.starts_with(prefix).then_some(*provider))
            .unwrap_or(ModelProvider::Other)
    }

    /// Resolve only metered catalog rates. All other classes intentionally
    /// produce a zero cost, including a historical manual override.
    pub fn lookup(&self, raw: &str) -> Option<&PriceRow> {
        if self.classify(raw) != ModelClass::Priced {
            return None;
        }
        self.lookup_catalog(raw)
    }

    /// Ladder: exact raw name, then `family-variant`, then family.
    fn lookup_catalog(&self, raw: &str) -> Option<&PriceRow> {
        let id = normalize(raw);
        if let Some(row) = self.rows.get(&id.raw) {
            return Some(row);
        }
        if let Some(variant) = &id.variant {
            if let Some(row) = self.rows.get(&format!("{}-{}", id.family, variant)) {
                return Some(row);
            }
        }
        self.rows.get(&id.family)
    }

    /// `"default" | "user" | "mixed"` describing where the rates came from.
    pub fn source_summary(&self) -> String {
        let mut has_default = false;
        let mut has_user = false;
        for row in self.rows.values() {
            match row.source.as_str() {
                "user" => has_user = true,
                _ => has_default = true,
            }
        }
        match (has_default, has_user) {
            (true, true) => "mixed".to_string(),
            (false, true) => "user".to_string(),
            _ => "default".to_string(),
        }
    }
}

fn is_local_model(raw: &str, normalized: &str) -> bool {
    MODEL_CLASS_RULES
        .local_markers
        .iter()
        .any(|marker| normalized.contains(marker))
        || raw.trim().contains('/')
}

/// Cost split into the two halves spec §4.5 treats as exact.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CostSplit {
    pub ingest: f64,
    pub generate: f64,
}

impl CostSplit {
    pub fn total(&self) -> f64 {
        self.ingest + self.generate
    }
}

/// Price one turn.
///
/// `reasoning_tokens` is deliberately absent from the arithmetic: on Codex it
/// is a subset of `output_tokens`, and on Claude thinking is already billed
/// inside `output_tokens`. Adding it would double count, and would break the
/// `ingest + generate == total` invariant the API promises.
pub fn cost_for_turn(
    price: Option<&Price>,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write_5m: i64,
    cache_write_1h: i64,
) -> CostSplit {
    let Some(price) = price else {
        return CostSplit::default();
    };
    const M: f64 = 1_000_000.0;
    let ingest = (input as f64 * price.input
        + cache_read as f64 * price.cache_read
        + cache_write_5m as f64 * price.cache_write_5m
        + cache_write_1h as f64 * price.cache_write_1h)
        / M;
    let generate = (output as f64 * price.output) / M;
    CostSplit { ingest, generate }
}

/// Insert any missing default rows. Existing rows (including user edits) are
/// left untouched.
pub fn seed_defaults(conn: &Connection) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut stmt = conn
        .prepare(
            "INSERT OR IGNORE INTO price (model, input_per_mtok, output_per_mtok, \
             cache_read_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok, \
             source, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'default', ?7)",
        )
        .map_err(|err| format!("prepare price insert: {err}"))?;
    for (model, price) in DEFAULT_PRICES {
        stmt.execute(rusqlite::params![
            model,
            price.input,
            price.output,
            price.cache_read,
            price.cache_write_5m,
            price.cache_write_1h,
            now,
        ])
        .map_err(|err| format!("seed price {model}: {err}"))?;
    }
    Ok(())
}
