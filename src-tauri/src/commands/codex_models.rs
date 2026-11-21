//! GUI Codex model choices from the default CLI cache.

use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::terminal::is_launch_spec_value;

const CACHE_FILE: &str = "models_cache.json";
const MAX_CACHE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CHOICES: usize = 40;
const MAX_LABEL_CHARS: usize = 80;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct CodexModelChoice {
    value: String,
    label: String,
    efforts: Vec<String>,
}

fn should_strip_label_char(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{061c}' | '\u{200b}' | '\u{200e}' | '\u{200f}'
                | '\u{202a}'..='\u{202e}' | '\u{2060}' | '\u{2066}'..='\u{2069}' | '\u{feff}'
        )
}

fn is_visible_label_char(character: char) -> bool {
    // Keep joiners and variation selectors in labels, and require a visible character.
    !character.is_whitespace()
        && !matches!(
            character,
            '\u{00ad}' | '\u{034f}' | '\u{115f}' | '\u{1160}' | '\u{200c}' | '\u{200d}'
                | '\u{2063}' | '\u{2800}' | '\u{3164}' | '\u{fe00}'..='\u{fe0f}'
                | '\u{ffa0}' | '\u{e0100}'..='\u{e01ef}'
        )
}

fn model_choice(row: &Value) -> Option<CodexModelChoice> {
    if row.get("visibility")?.as_str()? != "list" {
        return None;
    }
    let value = row.get("slug")?.as_str()?;
    if !is_launch_spec_value(value) {
        return None;
    }

    let cleaned_label: String = row.get("display_name")?.as_str()?.chars()
        .filter(|&character| !should_strip_label_char(character))
        .skip_while(|character| character.is_whitespace())
        .take(MAX_LABEL_CHARS)
        .collect();
    let label = if cleaned_label.chars().any(is_visible_label_char) {
        cleaned_label.trim_end().to_owned()
    } else {
        value.chars().take(MAX_LABEL_CHARS).collect()
    };

    let mut seen = HashSet::new();
    let supported = row.get("supported_reasoning_levels")?.as_array()?;
    let efforts: Vec<_> = supported.iter()
        .filter_map(|level| level.get("effort")?.as_str())
        .filter(|effort| is_launch_spec_value(effort) && seen.insert(*effort))
        .take(MAX_CHOICES)
        .map(str::to_owned)
        .collect();
    if !supported.is_empty() && efforts.is_empty() {
        return None;
    }

    Some(CodexModelChoice { value: value.to_owned(), label, efforts })
}

fn choices_from_cache(text: &str) -> Vec<CodexModelChoice> {
    let Ok(cache) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else {
        return Vec::new();
    };
    let Some(models) = cache.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut seen = HashSet::new();
    models.iter()
        .filter_map(model_choice)
        .filter(|choice| seen.insert(choice.value.clone()))
        .take(MAX_CHOICES)
        .collect()
}

fn read_cache(path: &Path) -> Vec<CodexModelChoice> {
    // Follow parent links/junctions so a relocated .codex directory works.
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A FIFO must not block the open before its file type can be checked.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let Ok(file) = options.open(path) else {
        return Vec::new();
    };
    if !file.metadata().is_ok_and(|metadata| {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return false;
            }
        }
        metadata.is_file() && metadata.len() <= MAX_CACHE_BYTES
    }) {
        return Vec::new();
    }

    // Keep the read bounded if the opened file grows after the metadata check.
    let mut text = String::new();
    if file.take(MAX_CACHE_BYTES + 1).read_to_string(&mut text).is_err()
        || text.len() as u64 > MAX_CACHE_BYTES
    {
        return Vec::new();
    }
    choices_from_cache(&text)
}

#[tauri::command]
pub async fn codex_model_choices() -> Vec<CodexModelChoice> {
    tauri::async_runtime::spawn_blocking(|| {
        // Account homes have their own caches. This read uses the default
        // home until the account-specific path can be verified end to end.
        dirs::home_dir()
            .map(|home| read_cache(&home.join(".codex").join(CACHE_FILE)))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs::{self, File};

    fn model(id: &str, label: &str, visibility: &str, efforts: &[&str]) -> Value {
        json!({
            "slug": id,
            "display_name": label,
            "visibility": visibility,
            "supported_reasoning_levels": efforts.iter().map(|effort| json!({ "effort": effort })).collect::<Vec<_>>(),
        })
    }

    #[test]
    fn codex_cache_keeps_list_order_and_efforts_without_extra_fields() {
        let cache = json!({
            "identity": "synthetic",
            "etag": "synthetic",
            "models": [
                model("gpt-next-b", "<em>Next B</em>", "list", &["high", "low", "high"]),
                model("gpt-private", "Private", "hide", &["ultra"]),
                model("gpt-next-a", "Next A", "list", &[]),
                model("gpt-next-b", "Duplicate", "list", &["ultra"]),
            ],
        });
        let choices = choices_from_cache(&cache.to_string());
        assert_eq!(serde_json::to_value(choices).unwrap(), json!([
            { "value": "gpt-next-b", "label": "<em>Next B</em>", "efforts": ["high", "low"] },
            { "value": "gpt-next-a", "label": "Next A", "efforts": [] },
        ]));
    }

    #[test]
    fn codex_cache_discards_invalid_rows_and_caps_values_and_labels() {
        let label = "\u{754c}".repeat(100);
        let mut models = vec![
            json!("malformed row"),
            model("-flag", "Invalid", "list", &["low"]),
            model("unsafe name", "Invalid", "list", &["low"]),
            model(&"a".repeat(129), "Too long", "list", &["low"]),
            model("gpt-long-label", &label, "list", &["high", "-flag", "bad effort", &"a".repeat(129)]),
        ];
        for i in 1..=45 {
            models.push(model(&format!("gpt-next-{i}"), "Next", "list", &["medium"]));
        }
        let choices = choices_from_cache(&json!({ "models": models }).to_string());
        assert_eq!(choices.len(), MAX_CHOICES);
        assert_eq!(choices[0].value, "gpt-long-label");
        assert_eq!(choices[0].label.chars().count(), MAX_LABEL_CHARS);
        assert_eq!(choices[0].efforts, ["high"]);
        assert_eq!(choices[MAX_CHOICES - 1].value, "gpt-next-39");
    }

    #[test]
    fn codex_cache_discards_nonempty_effort_lists_with_no_valid_value() {
        let mut malformed = model("gpt-malformed", "Malformed", "list", &[]);
        malformed["supported_reasoning_levels"] = json!([{}, {"effort": 2}]);
        let invalid = model("gpt-invalid-effort", "Invalid", "list", &["-flag", ""]);
        let cache = json!({ "models": [malformed.clone(), invalid.clone()] });
        assert!(choices_from_cache(&cache.to_string()).is_empty());

        let cache = json!({ "models": [
            malformed, invalid,
            model("gpt-valid-empty", "Empty", "list", &[]),
            model("gpt-valid-mixed", "Mixed", "list", &["-flag", "high"]),
        ] });
        assert_eq!(serde_json::to_value(choices_from_cache(&cache.to_string())).unwrap(), json!([
            { "value": "gpt-valid-empty", "label": "Empty", "efforts": [] },
            { "value": "gpt-valid-mixed", "label": "Mixed", "efforts": ["high"] },
        ]));
    }

    #[test]
    fn codex_cache_strips_invisible_formatting_and_uses_id_for_an_empty_label() {
        let cache = json!({ "models": [
            model("gpt-unicode", "\u{202e}\u{65e5}\u{672c}\u{8a9e} \u{200b}\u{00c9}lan \u{2069}\u{0645}\u{0631}\u{062d}\u{0628}\u{0627}\u{061c}", "list", &[]),
            model("gpt-id-label", " \u{0007}\u{0085}\u{200e}\u{200f}\u{202a}\u{202b}\u{202c}\u{202d}\u{202e}\u{2060}\u{2066}\u{2067}\u{2068}\u{2069}\u{feff} ", "list", &[]),
        ] });
        let choices = choices_from_cache(&cache.to_string());
        assert_eq!(choices[0].label, "\u{65e5}\u{672c}\u{8a9e} \u{00c9}lan \u{0645}\u{0631}\u{062d}\u{0628}\u{0627}");
        assert_eq!(choices[1].label, "gpt-id-label");
    }

    #[test]
    fn codex_cache_preserves_joined_and_visible_label_characters() {
        for label in [
            "\u{1f469}\u{200d}\u{1f4bb}",
            "\u{8fbb}\u{e0100}",
            "\u{0645}\u{06cc}\u{200c}\u{0631}\u{0648}\u{0645}",
            "\u{0600}\u{0661}",
            "\u{2764}\u{fe0f}",
            "\u{2801}\u{2803}",
            "Text\u{2800}\u{3164}\u{115f}\u{1160}\u{ffa0}",
            "Soft\u{00ad}hyphen\u{034f}\u{2063} model",
        ] {
            let choice = model_choice(&model("gpt-label", label, "list", &[])).unwrap();
            assert_eq!(choice.label, label);
        }
    }

    #[test]
    fn codex_cache_uses_id_when_the_label_has_no_visible_character() {
        for label in [
            "\u{2800}",
            "\u{3164}",
            "\u{115f}",
            "\u{1160}",
            "\u{ffa0}",
            " \u{a0}\u{2002}",
            "\u{200c}\u{200d}\u{fe00}\u{fe0f}\u{e0100}\u{e01ef} \u{2800}",
            "\u{00ad}",
            "\u{034f}",
            "\u{2063}",
            " \u{200d}\u{2066}\u{feff}\u{00ad}\u{e0100}\u{034f}\u{2063} ",
        ] {
            let choice = model_choice(&model("gpt-id-label", label, "list", &[])).unwrap();
            assert_eq!(choice.label, "gpt-id-label", "{label:?}");
        }
    }

    #[test]
    fn codex_cache_validates_the_open_handle_before_reading() {
        let (_, reader) = include_str!("codex_models.rs")
            .split_once("fn read_cache(").unwrap();
        let (body, _) = reader.split_once("pub async fn codex_model_choices(").unwrap();
        let (before_read, _) = body.split_once(".read_to_string(").unwrap();
        let (before_open, opened) = before_read.split_once("open(path)").unwrap();
        assert!(!before_open.contains("symlink_metadata("));
        assert!(opened.contains("file.metadata()"));
        assert!(opened.contains(".is_file()"));
        assert!(opened.contains("metadata.len() <= MAX_CACHE_BYTES"));
        assert!(before_open.contains("O_NOFOLLOW"));
        assert!(before_open.contains("options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)"));
        assert!(opened.contains("FILE_ATTRIBUTE_REPARSE_POINT"));
    }

    #[test]
    fn codex_cache_file_failures_return_no_choices() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CACHE_FILE);
        assert!(read_cache(&path).is_empty());
        assert!(read_cache(dir.path()).is_empty());
        for contents in ["{broken", "{}", r#"{"models":{}}"#, r#"{"models":[]}"#] {
            fs::write(&path, contents).unwrap();
            assert!(read_cache(&path).is_empty());
        }
        write_valid_cache(&path);
        assert_eq!(read_cache(&path)[0].value, "gpt-next");
        File::create(&path).unwrap().set_len(MAX_CACHE_BYTES + 1).unwrap();
        assert!(read_cache(&path).is_empty());
    }

    fn write_valid_cache(path: &Path) {
        fs::write(path, format!("\u{feff}{}", json!({
            "models": [model("gpt-next", "Next", "list", &["low"])],
        }))).unwrap();
    }

    #[cfg(any(unix, windows))]
    fn assert_cache_link_handling(
        link_file: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
        link_dir: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let real_parent = dir.path().join("real-parent");
        fs::create_dir(&real_parent).unwrap();
        let path = real_parent.join(CACHE_FILE);
        write_valid_cache(&path);
        let choices = read_cache(&path);
        assert_eq!(choices.len(), 1);
        assert_eq!(choices[0].value, "gpt-next");

        let final_link = dir.path().join(CACHE_FILE);
        link_file(&path, &final_link).unwrap();
        assert!(read_cache(&final_link).is_empty());

        let linked_parent = dir.path().join("linked-parent");
        link_dir(&real_parent, &linked_parent).unwrap();
        assert_eq!(read_cache(&linked_parent.join(CACHE_FILE)), choices);
    }

    #[cfg(unix)]
    #[test]
    fn codex_cache_checks_final_and_parent_symlinks_on_unix() {
        use std::os::unix::fs::symlink;

        assert_cache_link_handling(|src, dst| symlink(src, dst), |src, dst| symlink(src, dst));
    }

    #[cfg(windows)]
    #[test]
    fn codex_cache_checks_final_and_parent_symlinks_on_windows() {
        use std::os::windows::fs::{symlink_dir, symlink_file};

        assert_cache_link_handling(|src, dst| symlink_file(src, dst), |src, dst| symlink_dir(src, dst));
    }

    #[test]
    fn fixed_catalog_model_ids_pass_the_rust_launch_value_boundary() {
        let catalog = include_str!("../../../src/lib/agentCatalog.ts");
        let ids: Vec<_> = catalog.lines().filter_map(|line| {
            let fields = line.trim().strip_prefix("{ value: \"")?;
            fields.split_once("\", label: \"").map(|(id, _)| id)
        }).collect();
        assert!(!ids.is_empty());
        for id in ids {
            assert!(is_launch_spec_value(id), "{id}");
        }
    }
}
