//! The model chips the launcher offers for claude-codex, read from the
//! claude-codex install's own model table every time a panel asks.
//!
//! claude-codex keeps its models in `~/.claude-codex/config/models.json`. The
//! dialog used to carry a copy of that list, and the copy went stale the day
//! OpenRouter delisted one of its models (Union Alpha, 2026-09-18). Reading the
//! table means a model added or removed on the claude-codex side reaches the
//! chips without a mycmux release.
//!
//! The selection follows what the proxy's dispatcher publishes to Claude Code's
//! /model picker (`GET /router/v1/models`): the gpt, claude and fugu profiles,
//! plus the fcc profile's cloud `open_router/` ids. gemini is outside that
//! shared discovery, and the fcc profile's local routes (`fcc-default`,
//! `ollama/`) hold less context than the main profile's guard.
//!
//! `Get-MycmuxClaudeCodexModelChoices` in launcher.ps1 applies the same rules
//! to the terminal menu; `tests/fixtures/claude_codex_models/` pins both to the
//! same expected lists, including the shapes either could read loosely (keys
//! that differ in case, a string where a list belongs, an object in an array).
//! What still differs is outside anything claude-codex writes: PowerShell's
//! ConvertFrom-Json takes UTF-16 files and single-quoted keys and refuses keys
//! that differ only in case, serde_json the other way round.

use std::collections::HashSet;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

use super::terminal::is_launch_spec_value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelChoice {
    pub value: String,
    pub label: String,
}

/// Profiles in the order the chips list them, each with the family segment the
/// dispatcher puts in a gateway picker id (`_picker_model_id` in its routes.py).
const PROFILES: [(&str, &str); 4] = [
    ("gpt", "codex"),
    ("claude", "claude"),
    ("fugu", "fugu"),
    ("fcc", "fcc"),
];

/// The family rows whose display names double as chip labels, in the order a
/// name is looked for when several rows point at the same model.
const ALIAS_FAMILIES: [&str; 4] = ["fable", "opus", "sonnet", "haiku"];

/// The only fcc ids the main profile's picker publishes.
const FCC_SHARED_PREFIX: &str = "open_router/";

fn models_json_path() -> Option<PathBuf> {
    // Same base the claude-codex launcher resolves ($HomeDir in claude-codex.ps1).
    let home = std::env::var_os("CLAUDE_CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)?;
    Some(home.join(".claude-codex").join("config").join("models.json"))
}

/// The chips for one models.json. Anything it cannot read yields no chips, and
/// the caller falls back to the catalog's own list.
pub fn choices_from_models_json(text: &str) -> Vec<ModelChoice> {
    let Ok(root) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else {
        return Vec::new();
    };
    let Some(backends) = root.get("backends").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut choices = Vec::new();
    for (profile, family) in PROFILES {
        let Some(backend) = backends.get(profile) else { continue };
        let Some(ids) = backend.get("availableModels").and_then(Value::as_array) else { continue };
        for id in ids.iter().filter_map(Value::as_str).map(str::trim) {
            if profile == "fcc" && !id.starts_with(FCC_SHARED_PREFIX) {
                continue;
            }
            // A plain id is routed by its prefix; an id with a slash only
            // passes Claude Code's --model check in the gateway spelling
            // (a bare "grok-4.3" is sent to codex and refused there).
            let value = if id.contains('/') {
                format!("anthropic/gateway/{family}/{id}")
            } else {
                id.to_string()
            };
            if !is_launch_spec_value(&value) || !seen.insert(value.clone()) {
                continue;
            }
            choices.push(ModelChoice { label: label_for(backend, id), value });
        }
    }
    choices
}

fn label_for(backend: &Value, id: &str) -> String {
    for family in ALIAS_FAMILIES {
        let target = backend.get("aliases").and_then(|aliases| aliases.get(family)).and_then(Value::as_str);
        if target != Some(id) {
            continue;
        }
        let name = backend
            .get("display")
            .and_then(|display| display.get(format!("{family}Name")))
            .and_then(Value::as_str)
            .map(clean_label)
            .unwrap_or_default();
        if !name.is_empty() {
            return name;
        }
    }
    match id.rsplit('/').next() {
        Some(tail) if !tail.is_empty() => tail.to_string(),
        _ => id.to_string(),
    }
}

/// A label reaches a chip and a terminal menu, so control characters (escape
/// sequences, line breaks) are dropped before it is trimmed.
fn clean_label(name: &str) -> String {
    name.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string()
}

/// Empty when claude-codex is not installed here (neither Mac has it as of
/// 2026-09-18) or its table cannot be read.
#[tauri::command]
pub async fn claude_codex_model_choices() -> Vec<ModelChoice> {
    tauri::async_runtime::spawn_blocking(|| {
        models_json_path()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .map(|text| choices_from_models_json(&text))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../tests/fixtures/claude_codex_models/models.json");
    const EXPECTED: &str = include_str!("../../../tests/fixtures/claude_codex_models/expected.json");
    const SHAPES: &str = include_str!("../../../tests/fixtures/claude_codex_models/shapes.json");
    const SHAPES_EXPECTED: &str =
        include_str!("../../../tests/fixtures/claude_codex_models/shapes_expected.json");

    #[derive(serde::Deserialize)]
    struct Expected {
        value: String,
        label: String,
    }

    #[test]
    fn the_fixture_yields_the_shared_expected_list() {
        let expected: Vec<Expected> = serde_json::from_str(EXPECTED).unwrap();
        let expected: Vec<ModelChoice> = expected
            .into_iter()
            .map(|choice| ModelChoice { value: choice.value, label: choice.label })
            .collect();
        assert_eq!(choices_from_models_json(FIXTURE), expected);
    }

    #[test]
    fn loose_shapes_offer_what_the_powershell_reader_offers() {
        let expected: Vec<Expected> = serde_json::from_str(SHAPES_EXPECTED).unwrap();
        let expected: Vec<ModelChoice> = expected
            .into_iter()
            .map(|choice| ModelChoice { value: choice.value, label: choice.label })
            .collect();
        assert_eq!(choices_from_models_json(SHAPES), expected);
    }

    #[test]
    fn a_byte_order_mark_is_not_a_parse_error() {
        let with_bom = format!("\u{feff}{FIXTURE}");
        assert_eq!(choices_from_models_json(&with_bom), choices_from_models_json(FIXTURE));
    }

    #[test]
    fn an_unreadable_or_foreign_table_offers_nothing() {
        for text in ["", "not json", "{}", r#"{"backends": []}"#, r#"{"availableModels": ["some-model"]}"#] {
            assert!(choices_from_models_json(text).is_empty(), "{text:?}");
        }
    }

    #[test]
    fn every_value_passes_the_launch_spec_check() {
        for choice in choices_from_models_json(FIXTURE) {
            assert!(is_launch_spec_value(&choice.value), "{}", choice.value);
        }
    }
}
