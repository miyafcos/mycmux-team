use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::{HookMode, Provider};
use crate::util::atomic_write::AtomicWrite;

pub const OWNERSHIP_MARKER: &str = "mycmux_managed";
const GROK_BLOCK_START: &str = "# mycmux-managed-hooks:start";
const GROK_BLOCK_END: &str = "# mycmux-managed-hooks:end";
const HELPER_BYTES: &[u8] = include_bytes!("../../hooks/mycmux_hook.py");

#[derive(Debug, Clone)]
pub struct HookInstallPaths {
    pub claude_settings: PathBuf,
    pub codex_hooks: PathBuf,
    pub codex_config: PathBuf,
    pub grok_config: PathBuf,
    pub helper: PathBuf,
    pub state: PathBuf,
}

impl HookInstallPaths {
    pub fn discover() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or_else(|| "home directory is not available".to_string())?;
        let runtime = crate::test_profile::runtime_dir()?;
        let codex_home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        let grok_home = std::env::var_os("GROK_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".grok"));
        Ok(Self {
            claude_settings: home.join(".claude").join("settings.json"),
            codex_hooks: codex_home.join("hooks.json"),
            codex_config: codex_home.join("config.toml"),
            grok_config: grok_home.join("config.toml"),
            helper: runtime.join("hooks").join("v1").join("mycmux_hook.py"),
            state: runtime.join("agent-hooks-state.json"),
        })
    }
}

#[derive(Debug, Clone)]
pub struct HookInstallOutcome {
    pub enabled: bool,
    pub modes: BTreeMap<Provider, HookMode>,
    pub warnings: Vec<String>,
}

impl HookInstallOutcome {
    fn new(enabled: bool) -> Self {
        Self {
            enabled,
            modes: [Provider::Claude, Provider::Codex, Provider::Grok]
                .into_iter()
                .map(|provider| (provider, HookMode::Unavailable))
                .collect(),
            warnings: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WriteStatus {
    Changed,
    Unchanged,
}

pub fn reconcile_default(explicit_enabled: Option<bool>) -> Result<HookInstallOutcome, String> {
    reconcile(&HookInstallPaths::discover()?, explicit_enabled)
}

pub fn reconcile(
    paths: &HookInstallPaths,
    explicit_enabled: Option<bool>,
) -> Result<HookInstallOutcome, String> {
    let enabled = explicit_enabled.unwrap_or_else(|| read_enabled(&paths.state));
    if let Some(value) = explicit_enabled {
        let bytes = format!("{{\n  \"enabled\": {value}\n}}\n");
        write_if_changed(&paths.state, bytes.as_bytes(), || Ok(()))?;
    }
    let mut outcome = HookInstallOutcome::new(enabled);
    if !enabled {
        for (provider, path) in [
            (Provider::Claude, &paths.claude_settings),
            (Provider::Codex, &paths.codex_hooks),
        ] {
            if let Err(error) =
                update_json_hooks_with_helper(path, &paths.helper, provider, &[], false, || Ok(()))
            {
                outcome.warnings.push(format!(
                    "{} hook uninstall at {}: {error}",
                    provider.as_str(),
                    path.display()
                ));
            }
        }
        if let Err(error) = update_grok_config(&paths.grok_config, false, &paths.helper, || Ok(()))
        {
            outcome.warnings.push(format!(
                "grok hook uninstall at {}: {error}",
                paths.grok_config.display()
            ));
        }
        return Ok(outcome);
    }

    write_if_changed(&paths.helper, HELPER_BYTES, || Ok(()))?;
    for (provider, path, events) in [
        (
            Provider::Claude,
            &paths.claude_settings,
            provider_events(Provider::Claude),
        ),
        (
            Provider::Codex,
            &paths.codex_hooks,
            provider_events(Provider::Codex),
        ),
    ] {
        match update_json_hooks_with_helper(path, &paths.helper, provider, &events, true, || Ok(()))
        {
            Ok(_) => {
                outcome.modes.insert(provider, HookMode::Installed);
            }
            Err(error) => outcome.warnings.push(format!(
                "{} hook install at {}: {error}",
                provider.as_str(),
                path.display()
            )),
        }
    }
    match update_grok_config(&paths.grok_config, true, &paths.helper, || Ok(())) {
        Ok(_) => {
            outcome.modes.insert(Provider::Grok, HookMode::Installed);
        }
        Err(error) => outcome.warnings.push(format!(
            "grok hook install at {}: {error}",
            paths.grok_config.display()
        )),
    }

    if outcome.modes.get(&Provider::Codex) == Some(&HookMode::Installed)
        && !codex_hooks_are_trusted(&paths.codex_hooks, &paths.codex_config)?
    {
        outcome.modes.insert(Provider::Codex, HookMode::Unavailable);
        outcome.warnings.push(format!(
            "codex hooks at {} are awaiting trust",
            paths.codex_hooks.display()
        ));
    }
    Ok(outcome)
}

fn read_enabled(path: &Path) -> bool {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.get("enabled").and_then(Value::as_bool))
        .unwrap_or(true)
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to read {}: {error}", path.display())),
    }
}

fn provider_events(provider: Provider) -> Vec<(&'static str, &'static str)> {
    match provider {
        Provider::Claude => vec![
            ("UserPromptSubmit", "turn_active"),
            ("PermissionRequest", "attention_required"),
            ("Notification", "attention_required"),
            ("Stop", "turn_ended"),
            ("SessionEnd", "session_terminated"),
        ],
        Provider::Codex => vec![
            ("UserPromptSubmit", "turn_active"),
            ("PermissionRequest", "attention_required"),
            ("Stop", "turn_ended"),
            ("SessionEnd", "session_terminated"),
        ],
        Provider::Grok => vec![
            ("UserPromptSubmit", "turn_active"),
            ("Notification", "attention_required"),
            ("Stop", "turn_ended"),
            ("StopFailure", "failed"),
            ("SessionEnd", "session_terminated"),
        ],
    }
}

fn managed_group(helper: &Path, provider: Provider, event_kind: &str) -> Value {
    let helper = helper.to_string_lossy().replace('\\', "/");
    json!({
        "hooks": [{
            "type": "command",
            "command": format!("python \"{helper}\" --provider {} --event-kind {event_kind}", provider.as_str()),
            "timeout": 1,
            "statusMessage": "mycmux lifecycle observation",
            (OWNERSHIP_MARKER): true,
        }]
    })
}

fn is_managed_group(group: &Value) -> bool {
    group
        .as_object()
        .and_then(|object| object.get("hooks"))
        .and_then(Value::as_array)
        .is_some_and(|handlers| {
            !handlers.is_empty()
                && handlers.iter().all(|handler| {
                    handler
                        .as_object()
                        .and_then(|object| object.get(OWNERSHIP_MARKER))
                        .and_then(Value::as_bool)
                        == Some(true)
                })
        })
}

fn merge_install(root: &mut Value, groups: &[(&str, Value)]) -> Result<(), String> {
    let object = root
        .as_object_mut()
        .ok_or_else(|| "settings root must be a JSON object".to_string())?;
    let hooks = object.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| "settings hooks must be a JSON object".to_string())?;
    for (event, managed) in groups {
        let existing = hooks
            .entry((*event).to_string())
            .or_insert_with(|| json!([]));
        let existing = existing
            .as_array_mut()
            .ok_or_else(|| format!("settings hooks.{event} must be an array"))?;
        existing.retain(|group| !is_managed_group(group));
        existing.push(managed.clone());
    }
    Ok(())
}

fn merge_uninstall(root: &mut Value) -> Result<(), String> {
    let object = root
        .as_object_mut()
        .ok_or_else(|| "settings root must be a JSON object".to_string())?;
    let Some(hooks) = object.get_mut("hooks") else {
        return Ok(());
    };
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| "settings hooks must be a JSON object".to_string())?;
    let events: Vec<String> = hooks.keys().cloned().collect();
    for event in events {
        let Some(groups) = hooks.get_mut(&event).and_then(Value::as_array_mut) else {
            continue;
        };
        groups.retain(|group| !is_managed_group(group));
        if groups.is_empty() {
            hooks.remove(&event);
        }
    }
    Ok(())
}

fn update_json_hooks_with_helper<F>(
    path: &Path,
    helper: &Path,
    provider: Provider,
    events: &[(&str, &str)],
    install: bool,
    before_replace: F,
) -> Result<WriteStatus, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let original = read_optional(path)?;
    if original.is_none() && !install {
        return Ok(WriteStatus::Unchanged);
    }
    let mut root = match original.as_deref() {
        Some(bytes) => serde_json::from_slice(bytes)
            .map_err(|error| format!("invalid JSON in {}: {error}", path.display()))?,
        None => json!({}),
    };
    let before = root.clone();
    if install {
        let groups: Vec<_> = events
            .iter()
            .map(|(event, event_kind)| (*event, managed_group(helper, provider, event_kind)))
            .collect();
        merge_install(&mut root, &groups)?;
    } else {
        merge_uninstall(&mut root)?;
    }
    if root == before {
        return Ok(WriteStatus::Unchanged);
    }
    let mut next = serde_json::to_vec_pretty(&root).map_err(|error| error.to_string())?;
    next.push(b'\n');
    write_if_unchanged(path, original.as_deref(), &next, before_replace)
}

fn update_grok_config<F>(
    path: &Path,
    install: bool,
    helper: &Path,
    before_replace: F,
) -> Result<WriteStatus, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let original = read_optional(path)?;
    if original.is_none() && !install {
        return Ok(WriteStatus::Unchanged);
    }
    let current = original
        .as_deref()
        .map(|bytes| String::from_utf8(bytes.to_vec()))
        .transpose()
        .map_err(|error| format!("invalid UTF-8 in {}: {error}", path.display()))?
        .unwrap_or_default();
    let without_managed = remove_grok_block(&current)?;
    let next = if install {
        append_grok_block(&without_managed, helper)
    } else {
        without_managed
    };
    if next == current {
        return Ok(WriteStatus::Unchanged);
    }
    write_if_unchanged(path, original.as_deref(), next.as_bytes(), before_replace)
}

fn remove_grok_block(current: &str) -> Result<String, String> {
    let marker_start = current.find(GROK_BLOCK_START);
    let Some(marker_start) = marker_start else {
        return Ok(current.to_string());
    };
    let start = if marker_start > 0 && current.as_bytes().get(marker_start - 1) == Some(&b'\n') {
        marker_start - 1
    } else {
        marker_start
    };
    let relative_end = current[marker_start..]
        .find(GROK_BLOCK_END)
        .ok_or_else(|| "unterminated mycmux Grok hook block".to_string())?;
    let mut end = marker_start + relative_end + GROK_BLOCK_END.len();
    if current.as_bytes().get(end) == Some(&b'\r') {
        end += 1;
    }
    if current.as_bytes().get(end) == Some(&b'\n') {
        end += 1;
    }
    let mut result = String::with_capacity(current.len());
    result.push_str(&current[..start]);
    result.push_str(&current[end..]);
    Ok(result)
}

fn append_grok_block(current: &str, helper: &Path) -> String {
    let helper = helper.to_string_lossy().replace('\\', "/");
    let mut next = current.to_string();
    if !next.is_empty() {
        next.push('\n');
    }
    next.push_str(GROK_BLOCK_START);
    next.push('\n');
    for (event, event_kind) in provider_events(Provider::Grok) {
        next.push_str(&format!(
            "[[hooks.{event}]]\n  [[hooks.{event}.hooks]]\n  type = \"command\"\n  command = 'python \"{helper}\" --provider grok --event-kind {event_kind}'\n  timeout = 1\n  statusMessage = \"mycmux lifecycle observation\"\n  {OWNERSHIP_MARKER} = true\n\n"
        ));
    }
    next.push_str(GROK_BLOCK_END);
    next.push('\n');
    next
}

fn write_if_changed<F>(path: &Path, next: &[u8], before_replace: F) -> Result<WriteStatus, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let original = read_optional(path)?;
    if original.as_deref() == Some(next) {
        return Ok(WriteStatus::Unchanged);
    }
    write_if_unchanged(path, original.as_deref(), next, before_replace)
}

fn write_if_unchanged<F>(
    path: &Path,
    original: Option<&[u8]>,
    next: &[u8],
    before_replace: F,
) -> Result<WriteStatus, String>
where
    F: FnOnce() -> Result<(), String>,
{
    before_replace()?;
    let live = read_optional(path)?;
    if live.as_deref() != original {
        return Err(format!("concurrent edit detected at {}", path.display()));
    }
    AtomicWrite::new(
        "temporary hook settings",
        "Failed to replace hook settings atomically",
    )
    .create_parents()
    .write_bytes(path, next)?;
    Ok(WriteStatus::Changed)
}

fn codex_hooks_are_trusted(hooks_path: &Path, config_path: &Path) -> Result<bool, String> {
    let hooks_bytes = match fs::read(hooks_path) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    let hooks: Value = serde_json::from_slice(&hooks_bytes)
        .map_err(|error| format!("invalid JSON in {}: {error}", hooks_path.display()))?;
    let config = match fs::read_to_string(config_path) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    let trusted = parse_codex_trust(&config);
    let Some(events) = hooks.get("hooks").and_then(Value::as_object) else {
        return Ok(false);
    };
    let source = hooks_path.to_string_lossy();
    let mut found = false;
    for (event, groups) in events {
        let Some(groups) = groups.as_array() else {
            continue;
        };
        for (group_index, group) in groups.iter().enumerate() {
            if !is_managed_group(group) {
                continue;
            }
            let Some(handlers) = group.get("hooks").and_then(Value::as_array) else {
                return Ok(false);
            };
            for (handler_index, handler) in handlers.iter().enumerate() {
                found = true;
                let key = format!(
                    "{}:{}:{group_index}:{handler_index}",
                    source,
                    snake_case_event(event)
                );
                let expected = codex_trusted_hash(event, group, handler)?;
                if trusted.get(&key) != Some(&expected) {
                    return Ok(false);
                }
            }
        }
    }
    Ok(found)
}

fn parse_codex_trust(config: &str) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    let mut section: Option<String> = None;
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[hooks.state.") && trimmed.ends_with(']') {
            let raw = &trimmed[13..trimmed.len() - 1];
            section = raw
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
                .or_else(|| {
                    raw.strip_prefix('"')
                        .and_then(|value| value.strip_suffix('"'))
                })
                .map(str::to_string);
            continue;
        }
        if trimmed.starts_with('[') {
            section = None;
            continue;
        }
        if let (Some(key), Some(value)) = (
            section.as_ref(),
            trimmed
                .strip_prefix("trusted_hash")
                .and_then(|value| value.trim_start().strip_prefix('='))
                .map(str::trim)
                .and_then(|value| value.strip_prefix('"'))
                .and_then(|value| value.strip_suffix('"')),
        ) {
            result.insert(key.clone(), value.to_string());
        }
    }
    result
}

fn snake_case_event(event: &str) -> String {
    let mut result = String::new();
    for (index, character) in event.chars().enumerate() {
        if character.is_ascii_uppercase() {
            if index > 0 {
                result.push('_');
            }
            result.push(character.to_ascii_lowercase());
        } else {
            result.push(character);
        }
    }
    result
}

#[derive(Serialize)]
struct CanonicalCodexHandler<'a> {
    #[serde(rename = "async")]
    asynchronous: bool,
    command: &'a str,
    #[serde(rename = "statusMessage", skip_serializing_if = "Option::is_none")]
    status_message: Option<&'a str>,
    timeout: u64,
    #[serde(rename = "type")]
    kind: &'a str,
}

fn codex_trusted_hash(event: &str, group: &Value, handler: &Value) -> Result<String, String> {
    let handler = handler
        .as_object()
        .ok_or_else(|| "Codex handler must be an object".to_string())?;
    let canonical_handler = CanonicalCodexHandler {
        asynchronous: handler
            .get("async")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        command: required_json_text(handler, "command")?,
        status_message: handler.get("statusMessage").and_then(Value::as_str),
        timeout: handler.get("timeout").and_then(Value::as_u64).unwrap_or(60),
        kind: required_json_text(handler, "type")?,
    };
    let mut canonical = Map::new();
    canonical.insert("event_name".into(), Value::String(snake_case_event(event)));
    canonical.insert(
        "hooks".into(),
        Value::Array(vec![
            serde_json::to_value(canonical_handler).map_err(|error| error.to_string())?
        ]),
    );
    if let Some(matcher) = group.get("matcher") {
        canonical.insert("matcher".into(), matcher.clone());
    }
    let bytes = serde_json::to_vec(&Value::Object(canonical)).map_err(|error| error.to_string())?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

fn required_json_text<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Codex handler is missing {key}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn helper() -> PathBuf {
        PathBuf::from("C:/Users/example/.mycmux/hooks/v1/mycmux_hook.py")
    }

    #[test]
    fn merge_preserves_user_groups_order_and_unrelated_keys() {
        let user_a = json!({"matcher": "a", "hooks": [{"type": "command", "command": "a"}]});
        let user_b = json!({"matcher": "b", "hooks": [{"type": "command", "command": "b"}]});
        let mut root =
            json!({"theme": "dark", "hooks": {"Stop": [user_a.clone(), user_b.clone()]}});
        merge_install(
            &mut root,
            &[(
                "Stop",
                managed_group(&helper(), Provider::Claude, "turn_ended"),
            )],
        )
        .unwrap();
        assert_eq!(root["theme"], "dark");
        assert_eq!(root["hooks"]["Stop"][0], user_a);
        assert_eq!(root["hooks"]["Stop"][1], user_b);
        assert!(is_managed_group(&root["hooks"]["Stop"][2]));
    }

    #[test]
    fn install_is_idempotent_and_replaces_only_managed_groups() {
        let managed = managed_group(&helper(), Provider::Claude, "turn_ended");
        let mut root =
            json!({"hooks": {"Stop": [managed.clone(), {"hooks": [{"command": "user"}]}]}});
        merge_install(&mut root, &[("Stop", managed.clone())]).unwrap();
        merge_install(&mut root, &[("Stop", managed)]).unwrap();
        let groups = root["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert!(!is_managed_group(&groups[0]));
        assert!(is_managed_group(&groups[1]));
    }

    #[test]
    fn uninstall_restores_prior_state_and_keeps_lookalikes() {
        let lookalike = json!({"hooks": [{"type": "command", "command": "python mycmux_hook.py"}]});
        let original = json!({"theme": "dark", "hooks": {"Stop": [lookalike.clone()]}});
        let mut root = original.clone();
        merge_install(
            &mut root,
            &[
                (
                    "Stop",
                    managed_group(&helper(), Provider::Claude, "turn_ended"),
                ),
                (
                    "SessionEnd",
                    managed_group(&helper(), Provider::Claude, "session_terminated"),
                ),
            ],
        )
        .unwrap();
        merge_uninstall(&mut root).unwrap();
        assert_eq!(root, original);
    }

    #[test]
    fn concurrent_edit_is_detected_without_clobbering() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, b"{\"hooks\":{}}\n").unwrap();
        let error = update_json_hooks_with_helper(
            &path,
            &helper(),
            Provider::Claude,
            &[("Stop", "turn_ended")],
            true,
            || {
                fs::write(&path, b"{\"owner_edit\":true}\n").unwrap();
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.contains("concurrent edit detected"));
        assert_eq!(fs::read(&path).unwrap(), b"{\"owner_edit\":true}\n");
    }

    #[test]
    fn semantic_no_change_skips_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut root = json!({});
        merge_install(
            &mut root,
            &[(
                "Stop",
                managed_group(&helper(), Provider::Claude, "turn_ended"),
            )],
        )
        .unwrap();
        fs::write(&path, serde_json::to_vec_pretty(&root).unwrap()).unwrap();
        let status = update_json_hooks_with_helper(
            &path,
            &helper(),
            Provider::Claude,
            &[("Stop", "turn_ended")],
            true,
            || panic!("no-op update reached replace hook"),
        )
        .unwrap();
        assert_eq!(status, WriteStatus::Unchanged);
    }

    #[test]
    fn codex_hash_matches_observed_local_contract() {
        let session = json!({
            "matcher": "^startup$",
            "hooks": [{
                "type": "command",
                "command": "python C:/Users/miyaz/.codex/hooks/scripts/hooks_dispatch.py --event=SessionStart",
                "timeout": 5,
                "statusMessage": "Codex session starting"
            }]
        });
        assert_eq!(
            codex_trusted_hash("SessionStart", &session, &session["hooks"][0]).unwrap(),
            "sha256:56e50007a77111b5e461a15043c592e30cad02b53e067f6472a515c778c99f9d"
        );
    }

    #[test]
    fn codex_untrusted_hooks_select_existing_detection() {
        let dir = tempfile::tempdir().unwrap();
        let paths = HookInstallPaths {
            claude_settings: dir.path().join(".claude/settings.json"),
            codex_hooks: dir.path().join(".codex/hooks.json"),
            codex_config: dir.path().join(".codex/config.toml"),
            grok_config: dir.path().join(".grok/config.toml"),
            helper: dir.path().join(".mycmux/hooks/v1/mycmux_hook.py"),
            state: dir.path().join(".mycmux/agent-hooks-state.json"),
        };
        fs::create_dir_all(paths.codex_config.parent().unwrap()).unwrap();
        fs::write(&paths.codex_config, b"[hooks.state]\n").unwrap();
        let outcome = reconcile(&paths, Some(true)).unwrap();
        assert_eq!(outcome.modes[&Provider::Codex], HookMode::Unavailable);
        assert_eq!(outcome.modes[&Provider::Claude], HookMode::Installed);
        assert_eq!(outcome.modes[&Provider::Grok], HookMode::Installed);
    }

    #[test]
    fn grok_block_round_trip_preserves_owner_config() {
        let owner = "model = \"grok-code-fast-1\"\n";
        let installed = append_grok_block(owner, &helper());
        assert!(installed.contains("[[hooks.StopFailure]]"));
        assert_eq!(remove_grok_block(&installed).unwrap(), owner);
    }

    #[test]
    fn question_notification_events_follow_provider_contracts() {
        assert!(provider_events(Provider::Claude)
            .contains(&("Notification", "attention_required")));
        assert!(provider_events(Provider::Grok)
            .contains(&("Notification", "attention_required")));
        assert!(!provider_events(Provider::Codex)
            .iter()
            .any(|(event, _)| *event == "Notification"));
        assert!(provider_events(Provider::Codex)
            .contains(&("PermissionRequest", "attention_required")));
    }
}
