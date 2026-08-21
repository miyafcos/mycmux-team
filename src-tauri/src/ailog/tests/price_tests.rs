//! Model normalisation, the price ladder, and range resolution.

use crate::ailog::price::{self, ModelClass, ModelProvider, PriceTable};
use crate::ailog::Range;

#[test]
fn known_models_split_into_family_and_variant() {
    let id = price::normalize("claude-opus-5[1m]");
    assert_eq!(id.family, "opus-5");
    assert_eq!(id.variant.as_deref(), Some("1m"));

    let id = price::normalize("claude-haiku-4-5-20251001");
    assert_eq!(id.family, "haiku-4.5");
    assert_eq!(id.variant.as_deref(), Some("20251001"));

    let id = price::normalize("gpt-5.6-terra");
    assert_eq!(id.family, "gpt-5.6");
    assert_eq!(id.variant.as_deref(), Some("terra"));

    let id = price::normalize("gpt-5.5");
    assert_eq!(id.family, "gpt-5.5");
    assert_eq!(id.variant, None);

    let id = price::normalize("claude-opus-5");
    assert_eq!(id.family, "opus-5");
    assert_eq!(id.variant, None);
}

#[test]
fn unknown_model_strings_pass_through_untouched() {
    // Nothing in the table matches, so the raw string becomes the family and
    // no variant is invented.
    let id = price::normalize("totally-unknown-model-x");
    assert_eq!(id.family, "totally-unknown-model-x");
    assert_eq!(id.variant, None);

    let id = price::normalize("<synthetic>");
    assert_eq!(id.family, "<synthetic>");
    assert_eq!(id.variant, None);

    // A stem that is a textual prefix but not a structural one must not match:
    // `gpt-5.5` is a prefix of `gpt-5.55`, yet they are different models.
    let id = price::normalize("gpt-5.55");
    assert_eq!(id.family, "gpt-5.55");
    assert_eq!(id.variant, None);
}

#[test]
fn longest_stem_wins() {
    // `claude-opus-4-8` and `claude-opus-4-7` must not collapse together, and
    // neither may be swallowed by a shorter stem.
    assert_eq!(price::normalize("claude-opus-4-8").family, "opus-4.8");
    assert_eq!(price::normalize("claude-opus-4-7").family, "opus-4.7");
    assert_eq!(price::normalize("claude-sonnet-4-6").family, "sonnet-4.6");
    assert_eq!(price::normalize("claude-sonnet-5").family, "sonnet-5");
}

#[test]
fn price_lookup_walks_raw_then_variant_then_family() {
    let table = PriceTable::from_defaults();

    // Codex tiers are priced individually even though they share a family.
    let sol = table.lookup("gpt-5.6-sol").expect("sol priced");
    let terra = table.lookup("gpt-5.6-terra").expect("terra priced");
    assert_eq!(sol.price.input, 5.0);
    assert_eq!(terra.price.input, 2.0);
    assert!(sol.price.input > terra.price.input);

    // A dated Claude snapshot falls back to its family rate.
    let haiku = table
        .lookup("claude-haiku-4-5-20251001")
        .expect("haiku priced via family");
    assert_eq!(haiku.price.input, 1.0);
    assert_eq!(haiku.price.output, 5.0);

    // The 1M-context variant is the same model at the same rate.
    let opus = table.lookup("claude-opus-5[1m]").expect("opus priced");
    assert_eq!(opus.price.input, 5.0);

    assert!(table.lookup("totally-unknown-model-x").is_none());
}

#[test]
fn model_classes_follow_the_zero_configuration_rules() {
    let table = PriceTable::from_defaults();
    let cases = [
        ("gpt-5.6-terra", ModelClass::Priced),
        ("ollama/llama3", ModelClass::Local),
        ("foo/bar", ModelClass::Local),
        ("<synthetic>", ModelClass::Internal),
        ("fugu-ultra", ModelClass::Flat),
        ("gpt-5.55", ModelClass::Unknown),
        // Slash-delimited local distribution names have precedence over a
        // fugu substring, as fixed by MODEL_CLASS_RULES ordering.
        ("fugu/ultra", ModelClass::Local),
    ];
    for (model, expected) in cases {
        assert_eq!(table.classify(model), expected, "{model}");
    }
}

#[test]
fn model_providers_follow_the_shared_classification_rules() {
    let table = PriceTable::from_defaults();
    let cases = [
        ("claude-opus-5", ModelProvider::Anthropic),
        // A price-table miss must not erase the company classification.
        ("gpt-5.55", ModelProvider::Openai),
        ("gemini-2.5-pro", ModelProvider::Google),
        ("grok-4.6", ModelProvider::Xai),
        ("grok-4.6-build", ModelProvider::Xai),
        ("ollama/llama3", ModelProvider::Local),
        ("fugu/ultra", ModelProvider::Local),
        ("<synthetic>", ModelProvider::Other),
        ("totally-unknown-model-x", ModelProvider::Other),
    ];
    for (model, expected) in cases {
        assert_eq!(table.provider(model), expected, "{model}");
    }
}

#[test]
fn anthropic_cache_rates_follow_the_published_multipliers() {
    let table = PriceTable::from_defaults();
    let opus = table.lookup("claude-opus-5").expect("priced");
    assert!((opus.price.cache_read - 0.5).abs() < 1e-9);
    assert!((opus.price.cache_write_5m - 6.25).abs() < 1e-9);
    assert!((opus.price.cache_write_1h - 10.0).abs() < 1e-9);
}

#[test]
fn an_unpriced_model_costs_exactly_zero() {
    let split = price::cost_for_turn(None, 1_000_000, 1_000_000, 1_000_000, 0, 0);
    assert_eq!(split.ingest, 0.0);
    assert_eq!(split.generate, 0.0);
    assert_eq!(split.total(), 0.0);
}

#[test]
fn ingest_and_generate_always_sum_to_the_total() {
    let table = PriceTable::from_defaults();
    let price = table.lookup("claude-opus-5").unwrap().price;
    let split = price::cost_for_turn(Some(&price), 1_000, 2_000, 30_000, 4_000, 5_000);

    let expected_ingest =
        (1_000.0 * 5.0 + 30_000.0 * 0.5 + 4_000.0 * 6.25 + 5_000.0 * 10.0) / 1_000_000.0;
    let expected_generate = 2_000.0 * 25.0 / 1_000_000.0;
    assert!((split.ingest - expected_ingest).abs() < 1e-12);
    assert!((split.generate - expected_generate).abs() < 1e-12);
    assert!((split.total() - (split.ingest + split.generate)).abs() < 1e-12);
}

#[test]
fn reasoning_tokens_are_not_priced_twice() {
    // Codex reports reasoning as a subset of output. `cost_for_turn` has no
    // reasoning parameter at all, so a session whose output is entirely
    // reasoning costs the same as one with none.
    let table = PriceTable::from_defaults();
    let price = table.lookup("gpt-5.6-terra").unwrap().price;
    let split = price::cost_for_turn(Some(&price), 0, 1_000, 0, 0, 0);
    assert!((split.generate - 1_000.0 * 12.0 / 1_000_000.0).abs() < 1e-12);
}

// ---------------------------------------------------------------------------
// Range resolution
// ---------------------------------------------------------------------------

const NOW: i64 = 1_800_000_000_000;
const DAY: i64 = 86_400_000;

#[test]
fn explicit_bounds_beat_the_preset() {
    let range = Range {
        from: Some(100),
        to: Some(200),
        preset: Some("7d".to_string()),
    };
    let (resolved, label) = range.resolve(NOW);
    assert_eq!(resolved.from, 100);
    assert_eq!(resolved.to, 200);
    assert_eq!(label, "custom");
}

#[test]
fn a_single_explicit_bound_still_wins_its_side() {
    let range = Range {
        from: Some(555),
        to: None,
        preset: Some("30d".to_string()),
    };
    let (resolved, label) = range.resolve(NOW);
    assert_eq!(resolved.from, 555);
    assert_eq!(resolved.to, NOW);
    assert_eq!(label, "custom");

    let range = Range {
        from: None,
        to: Some(777),
        preset: Some("7d".to_string()),
    };
    let (resolved, _) = range.resolve(NOW);
    assert_eq!(resolved.from, NOW - 7 * DAY);
    assert_eq!(resolved.to, 777);
}

#[test]
fn presets_resolve_to_their_windows() {
    for (preset, days) in [("7d", 7), ("30d", 30), ("90d", 90)] {
        let range = Range {
            from: None,
            to: None,
            preset: Some(preset.to_string()),
        };
        let (resolved, label) = range.resolve(NOW);
        assert_eq!(resolved.from, NOW - days * DAY, "preset {preset}");
        assert_eq!(resolved.to, NOW);
        assert_eq!(label, preset);
    }
}

#[test]
fn all_and_unknown_presets_open_the_window() {
    for preset in [None, Some("all".to_string()), Some("nonsense".to_string())] {
        let range = Range {
            from: None,
            to: None,
            preset,
        };
        let (resolved, label) = range.resolve(NOW);
        assert!(resolved.from < 0, "expected an open lower bound");
        assert_eq!(resolved.to, NOW);
        assert_eq!(label, "all");
    }
}

#[test]
fn ytd_starts_at_the_first_of_january() {
    use chrono::{Datelike, TimeZone, Utc};
    let range = Range {
        from: None,
        to: None,
        preset: Some("ytd".to_string()),
    };
    let (resolved, label) = range.resolve(NOW);
    assert_eq!(label, "ytd");
    let start = Utc.timestamp_millis_opt(resolved.from).single().unwrap();
    let now = Utc.timestamp_millis_opt(NOW).single().unwrap();
    assert_eq!(start.year(), now.year());
    assert_eq!(start.month(), 1);
    assert_eq!(start.day(), 1);
}

#[test]
fn coverage_counts_priced_local_and_flat_but_not_internal_or_unknown() {
    use crate::ailog::price::PriceTable;
    use crate::ailog::query::PriceCoverageAcc;

    let prices = PriceTable::from_defaults();
    let mut coverage = PriceCoverageAcc::default();
    for (model, tokens) in [
        ("gpt-5.6-terra", 100),
        ("ollama/llama3", 200),
        ("fugu-ultra", 300),
        ("<synthetic>", 400),
        ("totally-unknown-model-x", 500),
    ] {
        coverage.add_model_tokens(Some(model), tokens, &prices);
    }
    let coverage = coverage.finish();
    assert_eq!(coverage.priced.tokens, 100);
    assert_eq!(coverage.local.tokens, 200);
    assert_eq!(coverage.flat.tokens, 300);
    assert_eq!(coverage.internal.tokens, 400);
    assert_eq!(coverage.unknown.tokens, 500);
    // 600 covered out of 1100 cost-bearing tokens; the 400 internal tokens
    // stay out of the denominator.
    assert!((coverage.covered_token_ratio - 600.0 / 1100.0).abs() < f64::EPSILON);
}
