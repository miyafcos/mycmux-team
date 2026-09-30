//! Model normalisation, the price ladder, and range resolution.

use crate::ailog::price::{self, ModelClass, ModelProvider, PriceTable};
use crate::ailog::Range;

#[test]
fn known_models_split_into_family_and_variant() {
    let id = price::normalize("gpt-6-astra");
    assert_eq!(id.family, "gpt-6");
    assert_eq!(id.variant.as_deref(), Some("astra"));

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

    for model in ["gpt-6-astra", "gpt-6[astra]"] {
        let astra = table.lookup(model).expect("astra priced");
        assert_eq!(astra.price.input, 10.0);
        assert_eq!(astra.price.output, 50.0);
        assert_eq!(astra.price.cache_read, 1.0);
    }

    // Codex tiers are priced individually even though they share a family.
    let sol = table.lookup("gpt-5.6-sol").expect("sol priced");
    let terra = table.lookup("gpt-5.6-terra").expect("terra priced");
    assert_eq!(sol.price.input, 4.0);
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
        anchor: None,
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
        anchor: None,
    };
    let (resolved, label) = range.resolve(NOW);
    assert_eq!(resolved.from, 555);
    assert_eq!(resolved.to, NOW);
    assert_eq!(label, "custom");

    let range = Range {
        from: None,
        to: Some(777),
        preset: Some("7d".to_string()),
        anchor: None,
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
            anchor: None,
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
            anchor: None,
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
        anchor: None,
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

#[test]
fn current_generations_have_their_own_published_rates() {
    let table = PriceTable::from_defaults();
    for (raw, family, input, output, read, write) in [
        ("claude-fable-5-1", "fable-5.1", 10.0, 50.0, 0.25, 12.5),
        ("claude-mythos-5-1", "mythos-5.1", 10.0, 50.0, 0.25, 12.5),
        ("claude-opus-5-5", "opus-5.5", 4.0, 20.0, 0.2, 5.0),
        ("claude-sonnet-5-5", "sonnet-5.5", 2.0, 10.0, 0.2, 2.5),
        ("gpt-6.1-sol", "gpt-6.1", 2.0, 10.0, 0.1, 2.5),
        ("gpt-6-sol", "gpt-6", 2.0, 10.0, 0.2, 2.5),
        ("gpt-6-luna", "gpt-6", 0.1, 0.5, 0.01, 0.125),
        ("gpt-5.6-sol", "gpt-5.6", 4.0, 20.0, 0.4, 5.0),
        ("claude-sonnet-5", "sonnet-5", 2.0, 10.0, 0.2, 2.5),
        (
            "gemini-3.8-flash",
            "gemini-3.8-flash",
            0.75,
            3.75,
            0.075,
            0.75,
        ),
        (
            "gemini-3.5-flash-lite",
            "gemini-3.5-flash-lite",
            0.3,
            2.5,
            0.03,
            0.3,
        ),
    ] {
        assert_eq!(price::normalize(raw).family, family, "{raw}");
        let p = table.lookup(raw).expect(raw).price;
        assert_eq!(p.input, input, "{raw}");
        assert_eq!(p.output, output, "{raw}");
        assert!((p.cache_read - read).abs() < 1e-12, "{raw}");
        assert_eq!(p.cache_write_5m, write, "{raw}");
    }
}

#[test]
fn snapshots_and_context_qualifiers_resolve_but_future_versions_do_not_inherit_prices() {
    let table = PriceTable::from_defaults();
    for (alias, base) in [
        ("claude-opus-5-5[1m]", "claude-opus-5-5"),
        ("claude-sonnet-5-5-20260928", "claude-sonnet-5-5"),
        ("gpt-6.1[sol]", "gpt-6.1-sol"),
        ("gpt-6.1-sol-2026-09-22", "gpt-6.1-sol"),
        ("gemini-3.8-flash-20260901", "gemini-3.8-flash"),
    ] {
        assert_eq!(
            table.lookup(alias).unwrap().price,
            table.lookup(base).unwrap().price
        );
    }
    for raw in [
        "claude-opus-5-7",
        "claude-fable-5-2",
        "claude-sonnet-5-55",
        "gpt-6.1-nova",
        "gpt-5.5-pro",
        "gpt-5.5-future",
        "gemini-3.8-flash-image",
    ] {
        assert!(
            table.lookup(raw).is_none(),
            "must not substitute a price for {raw}"
        );
    }
    assert_eq!(
        price::normalize("claude-opus-5-7").family,
        "claude-opus-5-7"
    );
}

#[test]
fn long_context_rates_use_total_input_and_respect_the_boundary() {
    let table = PriceTable::from_defaults();
    let short = table.price_for_input("gpt-6.1-sol", 272_000).unwrap();
    let long = table.price_for_input("gpt-6.1-sol", 272_001).unwrap();
    assert_eq!(short.input, 2.0);
    assert_eq!(long.input, 4.0);
    assert_eq!(long.cache_read, 0.2);
    assert_eq!(long.cache_write_5m, 5.0);
    assert_eq!(long.output, 15.0);
    assert_eq!(
        table
            .price_for_input("claude-opus-5-5", 500_000)
            .unwrap()
            .input,
        4.0
    );
    assert_eq!(table.classify("grok-4.7"), ModelClass::Reported);
    assert_eq!(table.provider("grok-4.7"), ModelProvider::Xai);
}

#[test]
fn codex_cache_writes_are_disjoint_from_ordinary_input() {
    let text = concat!(
        r#"{"type":"turn_context","payload":{"model":"gpt-6.1-sol"}}"#,
        "\n",
        r#"{"timestamp":"2026-09-30T00:00:01Z","ordinal":1,"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"cache_write_input_tokens":300,"output_tokens":200,"reasoning_output_tokens":100},"total_token_usage":{"total_tokens":1200}}}}"#,
        "\n",
    );
    let parsed = crate::ailog::parse_codex::parse_chunk(text, "cache-write");
    let turn = &parsed.sessions["cache-write"].turns[0];
    assert_eq!(turn.input_tokens, 100);
    assert_eq!(turn.cache_read_tokens, 600);
    assert_eq!(turn.cache_write_5m_tokens, 300);
    let table = PriceTable::from_defaults();
    let p = table.lookup(turn.model.as_deref().unwrap()).unwrap().price;
    let split = price::cost_for_turn(
        Some(&p),
        turn.input_tokens,
        turn.output_tokens,
        turn.cache_read_tokens,
        turn.cache_write_5m_tokens,
        0,
    );
    assert!((split.total() - 0.00301).abs() < 1e-12);
}

#[test]
fn upgrading_v2_rebuilds_existing_families_costs_and_rollups_once() {
    use rusqlite::{params, Connection};
    let conn = Connection::open_in_memory().unwrap();
    crate::ailog::schema::init(&conn).unwrap();
    conn.execute(
        "INSERT INTO index_state(key,value) VALUES ('price_catalog_version','2')",
        [],
    )
    .unwrap();
    // Emulate an old cache with no row for a newly supported model.
    conn.execute("DELETE FROM price WHERE model='fable-5.1'", [])
        .unwrap();
    conn.execute("UPDATE price SET input_per_mtok=7, output_per_mtok=9, cache_read_per_mtok=0.7, cache_write_5m_per_mtok=8.75, cache_write_1h_per_mtok=8.75, source='user', updated_at=111 WHERE model='gpt-6.1-sol'", []).unwrap();
    for (kind, id, model, family, input, output, read, write, cost) in [
        (
            "claude",
            "claude-current",
            "claude-opus-5-5",
            "opus-5",
            100,
            200,
            600,
            300,
            99.0,
        ),
        (
            "codex",
            "codex-current",
            "gpt-6.1-sol",
            "gpt-6.1-sol",
            400,
            200,
            600,
            300,
            99.0,
        ),
        (
            "codex",
            "long-context",
            "gpt-6-luna",
            "gpt-6",
            10,
            100,
            272_001,
            0,
            99.0,
        ),
        (
            "grok",
            "reported",
            "grok-4.7-build",
            "grok-4.7-build",
            10,
            10,
            0,
            0,
            2.5,
        ),
    ] {
        conn.execute("INSERT INTO session(kind,session_id,started_at,ended_at,user_msg_count) VALUES (?1,?2,1800000000000,1800000000001,3)", params![kind,id]).unwrap();
        conn.execute("INSERT INTO turn(kind,session_id,seq,ts,model,model_family,input_tokens,output_tokens,cache_read_tokens,cache_write_5m_tokens,cost_usd) VALUES (?1,?2,0,1800000000000,?3,?4,?5,?6,?7,?8,?9)", params![kind,id,model,family,input,output,read,write,cost]).unwrap();
    }
    conn.execute("INSERT INTO summary(kind,session_id,created_at,summary) VALUES ('claude','claude-current',0,'preserved summary')", []).unwrap();
    crate::ailog::migrate::apply(&conn).unwrap();
    let prices = PriceTable::load(&conn).unwrap();
    assert_eq!(
        prices.lookup("claude-fable-5-1").unwrap().price.cache_read,
        0.25
    );
    assert_eq!(
        prices
            .price_for_input("gpt-6.1-sol", 500_000)
            .unwrap()
            .input,
        7.0
    );
    let user = prices.lookup("gpt-6.1-sol").unwrap();
    assert_eq!(user.source, "user");
    assert_eq!(user.updated_at, 111);
    for (kind, id, family, input, expected) in [
        ("claude", "claude-current", "opus-5.5", 100, 0.00602),
        ("codex", "codex-current", "gpt-6.1", 100, 0.005545),
        ("codex", "long-context", "gpt-6", 10, 0.00551702),
        ("grok", "reported", "grok-4.7", 10, 2.5),
    ] {
        let row: (String, i64, f64) = conn.query_row("SELECT model_family,input_tokens,cost_usd FROM turn WHERE kind=?1 AND session_id=?2", params![kind,id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(row.0, family, "{id}");
        assert_eq!(row.1, input, "{id}");
        assert!(
            (row.2 - expected).abs() < 1e-10,
            "{id}: {} vs {expected}",
            row.2
        );
        let session: (String, f64, i64) = conn.query_row("SELECT primary_model,cost_usd,user_msg_count FROM session WHERE kind=?1 AND session_id=?2", params![kind,id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(session.0, family);
        assert!((session.1 - expected).abs() < 1e-10);
        assert_eq!(session.2, 3);
        let rolled: f64 = conn
            .query_row(
                "SELECT SUM(cost_usd) FROM rollup_turn_session_day WHERE kind=?1 AND session_id=?2",
                params![kind, id],
                |r| r.get(0),
            )
            .unwrap();
        assert!((rolled - expected).abs() < 1e-10, "rollup {id}");
    }
    let before: String = conn
        .query_row(
            "SELECT value FROM index_state WHERE key='price_generation'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    crate::ailog::migrate::apply(&conn).unwrap();
    let after: String = conn
        .query_row(
            "SELECT value FROM index_state WHERE key='price_generation'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(before, after);
    let input: i64 = conn
        .query_row(
            "SELECT input_tokens FROM turn WHERE session_id='codex-current'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(input, 100, "cache writes must be corrected only once");
    let summary: String = conn
        .query_row(
            "SELECT summary FROM summary WHERE session_id='claude-current'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(summary, "preserved summary");
}
