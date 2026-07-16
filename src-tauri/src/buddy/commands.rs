use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use base64::Engine;
use serde::{Deserialize, Serialize};

use super::codex::run_codex_exec;
use super::BUDDY_ENABLED;

fn buddy_runtime_dir() -> Result<PathBuf, String> {
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        return Ok(PathBuf::from(user_profile).join(".claude-buddy"));
    }
    if let Ok(home) = std::env::var("HOME") {
        return Ok(PathBuf::from(home).join(".claude-buddy"));
    }
    Err("USERPROFILE/HOME is not available".to_string())
}

fn ensure_runtime_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create runtime directory {}: {error}",
                parent.display()
            )
        })?;
    }
    Ok(())
}

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    ensure_runtime_dir(path)?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("invalid file path {}", path.display()))?;
    let mut tmp_file_name = file_name.to_os_string();
    tmp_file_name.push(".tmp");
    let tmp_path = path.with_file_name(tmp_file_name);

    let write_result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(error.to_string());
    }

    if let Err(error) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error.to_string());
    }

    Ok(())
}

fn buddy_settings_path() -> Result<PathBuf, String> {
    Ok(buddy_runtime_dir()?.join("settings.json"))
}

fn legacy_buddy_settings_path() -> Result<PathBuf, String> {
    Ok(buddy_runtime_dir()?.join("config.json"))
}

fn buddy_profile_dir() -> Result<PathBuf, String> {
    Ok(buddy_runtime_dir()?.join("profile"))
}

fn buddy_profile_facet_path(facet: &str) -> Result<PathBuf, String> {
    match facet {
        "work-domain" | "patterns" | "preferences" | "projects" => {
            Ok(buddy_profile_dir()?.join(format!("{facet}.md")))
        }
        _ => Err(format!("未対応のプロファイルfacetです: {facet}")),
    }
}

fn legacy_buddy_profile_path() -> Result<PathBuf, String> {
    Ok(buddy_runtime_dir()?.join("profile.md"))
}

fn ensure_profile_dir_with_migration() -> Result<PathBuf, String> {
    let profile_dir = buddy_profile_dir()?;
    if profile_dir.exists() {
        return Ok(profile_dir);
    }

    fs::create_dir_all(&profile_dir).map_err(|error| {
        format!(
            "プロファイルディレクトリを作成できませんでした {}: {error}",
            profile_dir.display()
        )
    })?;

    let legacy_path = legacy_buddy_profile_path()?;
    if legacy_path.exists() {
        let legacy_content = fs::read_to_string(&legacy_path).map_err(|error| {
            format!(
                "旧プロファイルを読み取れませんでした {}: {error}",
                legacy_path.display()
            )
        })?;
        let patterns_path = profile_dir.join("patterns.md");
        fs::write(&patterns_path, legacy_content).map_err(|error| {
            format!(
                "初期プロファイルを書き込めませんでした {}: {error}",
                patterns_path.display()
            )
        })?;
    }

    Ok(profile_dir)
}

fn observation_state_path() -> Result<PathBuf, String> {
    Ok(buddy_runtime_dir()?.join("observation-state.json"))
}

fn codex_home_dir() -> Result<PathBuf, String> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        if !codex_home.trim().is_empty() {
            return Ok(PathBuf::from(codex_home));
        }
    }
    dirs::home_dir()
        .map(|home| home.join(".codex"))
        .ok_or_else(|| "HOME is not available".to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPetInfo {
    name: String,
    display_name: String,
    spritesheet_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileFacets {
    work_domain: String,
    patterns: String,
    preferences: String,
    projects: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationState {
    last_daily_summary: Option<String>,
    last_weekly_report: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexPetManifest {
    #[serde(rename = "displayName", alias = "display_name")]
    display_name: Option<String>,
    #[serde(
        rename = "spritesheetPath",
        alias = "spritesheet_path",
        alias = "spritesheet"
    )]
    spritesheet_path: Option<String>,
}

fn resolve_spritesheet_path(pet_dir: &Path, manifest: &CodexPetManifest) -> PathBuf {
    let raw_path = manifest
        .spritesheet_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("spritesheet.webp");
    let path = PathBuf::from(raw_path);
    if path.is_absolute() {
        path
    } else {
        pet_dir.join(path)
    }
}

fn append_jsonl(filename: &str, line: &str) -> Result<(), String> {
    let path = buddy_runtime_dir()?.join(filename);
    ensure_runtime_dir(&path)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(())
}

#[tauri::command]
pub async fn codex_judge(system_prompt: String, user_prompt: String) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        eprintln!(
            "[buddy][codex_judge] called (prompt len: system={} user={})",
            system_prompt.len(),
            user_prompt.len()
        );
    }
    let stdin_payload = format!("{system_prompt}\n\n---\n\n{user_prompt}");
    run_codex_exec(stdin_payload, "codex_judge").await
}

#[tauri::command]
pub async fn codex_summarize(prompt: String) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        eprintln!(
            "[buddy][codex_summarize] called (prompt len={})",
            prompt.len()
        );
    }
    run_codex_exec(prompt, "codex_summarize").await
}

#[tauri::command(async)]
pub fn load_buddy_environment() -> Result<String, String> {
    Ok(super::environment::build_environment_text())
}

#[tauri::command(async)]
pub fn load_session_tail(
    session_id: String,
    cwd: String,
    max_turns: usize,
) -> Result<String, String> {
    Ok(super::session_log::load_session_tail(
        &session_id,
        &cwd,
        max_turns,
    ))
}

#[tauri::command(async)]
pub fn load_buddy_settings() -> Result<String, String> {
    let path = buddy_settings_path()?;
    if path.exists() {
        return fs::read_to_string(&path)
            .map_err(|error| format!("failed to read settings {}: {error}", path.display()));
    }

    let legacy_path = legacy_buddy_settings_path()?;
    if !legacy_path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&legacy_path)
        .map_err(|error| format!("failed to read settings {}: {error}", legacy_path.display()))
}

#[tauri::command(async)]
pub fn save_buddy_settings(json: String) -> Result<(), String> {
    let path = buddy_settings_path()?;
    ensure_runtime_dir(&path)?;
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|error| format!("settings json is invalid: {error}"))?;
    write_atomic(&path, &json)
        .map_err(|error| format!("failed to write settings {}: {error}", path.display()))
}

#[tauri::command(async)]
pub fn list_codex_pets() -> Result<Vec<CodexPetInfo>, String> {
    let pets_dir = codex_home_dir()?.join("pets");
    if !pets_dir.is_dir() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&pets_dir).map_err(|error| {
        format!(
            "failed to read pets directory {}: {error}",
            pets_dir.display()
        )
    })?;
    let mut pets = Vec::new();

    for entry_result in entries {
        let entry = match entry_result {
            Ok(entry) => entry,
            Err(error) => {
                eprintln!("[buddy] failed to read Codex Pet entry: {error}");
                continue;
            }
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                eprintln!("[buddy] failed to read Codex Pet file type: {error}");
                continue;
            }
        };
        if !file_type.is_dir() {
            continue;
        }

        let pet_dir = entry.path();
        let manifest_path = pet_dir.join("pet.json");
        if !manifest_path.is_file() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let manifest_raw = match fs::read_to_string(&manifest_path) {
            Ok(raw) => raw,
            Err(error) => {
                eprintln!(
                    "[buddy] failed to read Codex Pet manifest {}: {error}",
                    manifest_path.display()
                );
                continue;
            }
        };
        let manifest = match serde_json::from_str::<CodexPetManifest>(&manifest_raw) {
            Ok(manifest) => manifest,
            Err(error) => {
                eprintln!(
                    "[buddy] failed to parse Codex Pet manifest {}: {error}",
                    manifest_path.display()
                );
                continue;
            }
        };
        let spritesheet_path = resolve_spritesheet_path(&pet_dir, &manifest);
        pets.push(CodexPetInfo {
            display_name: manifest.display_name.unwrap_or_else(|| name.clone()),
            name,
            spritesheet_path: spritesheet_path.to_string_lossy().to_string(),
        });
    }

    pets.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(pets)
}

#[tauri::command(async)]
pub fn read_codex_pet_spritesheet(pet_name: String) -> Result<String, String> {
    if pet_name.is_empty()
        || pet_name.contains('/')
        || pet_name.contains('\\')
        || pet_name.contains("..")
    {
        return Err(format!("invalid pet name: {pet_name}"));
    }
    let pet_dir = codex_home_dir()?.join("pets").join(&pet_name);
    let manifest_path = pet_dir.join("pet.json");
    if !manifest_path.is_file() {
        return Err(format!(
            "pet manifest not found: {}",
            manifest_path.display()
        ));
    }
    let manifest_raw = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("failed to read manifest {}: {e}", manifest_path.display()))?;
    let manifest = serde_json::from_str::<CodexPetManifest>(&manifest_raw)
        .map_err(|e| format!("failed to parse manifest {}: {e}", manifest_path.display()))?;
    let sheet_path = resolve_spritesheet_path(&pet_dir, &manifest);
    let bytes = fs::read(&sheet_path)
        .map_err(|e| format!("failed to read spritesheet {}: {e}", sheet_path.display()))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command(async)]
pub fn read_codex_pet_layout(pet_name: String) -> Result<String, String> {
    if pet_name.is_empty()
        || pet_name.contains('/')
        || pet_name.contains('\\')
        || pet_name.contains("..")
    {
        return Err(format!("invalid pet name: {pet_name}"));
    }
    let layout_path = codex_home_dir()?
        .join("pets")
        .join(&pet_name)
        .join("layout.json");
    if !layout_path.is_file() {
        return Ok(String::new());
    }
    fs::read_to_string(&layout_path)
        .map_err(|e| format!("failed to read pet layout {}: {e}", layout_path.display()))
}

#[tauri::command(async)]
pub fn append_buddy_log(line: String) -> Result<(), String> {
    append_jsonl("log.jsonl", &line)
}

#[tauri::command(async)]
pub fn append_buddy_chat(line: String) -> Result<(), String> {
    append_jsonl("chat.jsonl", &line)
}

#[tauri::command(async)]
pub fn load_recent_chat(limit: usize) -> Result<Vec<serde_json::Value>, String> {
    let path = buddy_runtime_dir()?.join("chat.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read chat log {}: {error}", path.display()))?;
    let mut entries: Vec<serde_json::Value> = content
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(limit)
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .collect();
    entries.reverse();
    Ok(entries)
}

#[tauri::command(async)]
pub fn load_chat_since(timestamp_ms: i64) -> Result<Vec<serde_json::Value>, String> {
    let path = buddy_runtime_dir()?.join("chat.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read chat log {}: {error}", path.display()))?;
    let entries: Vec<serde_json::Value> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|value| {
            value
                .get("timestampMs")
                .and_then(|ts| ts.as_i64())
                .map(|ts| ts >= timestamp_ms)
                .unwrap_or(false)
        })
        .collect();
    Ok(entries)
}

#[tauri::command(async)]
pub fn load_buddy_profile_facets() -> Result<ProfileFacets, String> {
    let profile_dir = ensure_profile_dir_with_migration()?;
    let read_facet = |name: &str| -> Result<String, String> {
        let path = profile_dir.join(format!("{name}.md"));
        if !path.exists() {
            return Ok(String::new());
        }
        fs::read_to_string(&path).map_err(|error| {
            format!(
                "プロファイルfacetを読み取れませんでした {}: {error}",
                path.display()
            )
        })
    };

    Ok(ProfileFacets {
        work_domain: read_facet("work-domain")?,
        patterns: read_facet("patterns")?,
        preferences: read_facet("preferences")?,
        projects: read_facet("projects")?,
    })
}

#[tauri::command(async)]
pub fn save_buddy_profile_facet(facet: String, content: String) -> Result<(), String> {
    ensure_profile_dir_with_migration()?;
    let path = buddy_profile_facet_path(&facet)?;
    write_atomic(&path, &content).map_err(|error| {
        format!(
            "プロファイルfacetを書き込めませんでした {}: {error}",
            path.display()
        )
    })
}

#[tauri::command(async)]
pub fn load_observation_state() -> Result<ObservationState, String> {
    let path = observation_state_path()?;
    if !path.exists() {
        return Ok(ObservationState::default());
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "観測ステートを読み取れませんでした {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str::<ObservationState>(&content).map_err(|error| {
        format!(
            "観測ステートのJSONを解析できませんでした {}: {error}",
            path.display()
        )
    })
}

#[tauri::command(async)]
pub fn save_observation_state(state: ObservationState) -> Result<(), String> {
    let path = observation_state_path()?;
    ensure_runtime_dir(&path)?;
    let content = serde_json::to_string_pretty(&state)
        .map_err(|error| format!("観測ステートをJSON化できませんでした: {error}"))?;
    write_atomic(&path, &content).map_err(|error| {
        format!(
            "観測ステートを書き込めませんでした {}: {error}",
            path.display()
        )
    })
}

#[tauri::command]
pub fn set_buddy_enabled(enabled: bool) -> bool {
    BUDDY_ENABLED.store(enabled, Ordering::Relaxed);
    enabled
}

#[tauri::command]
pub fn is_buddy_enabled() -> bool {
    BUDDY_ENABLED.load(Ordering::Relaxed)
}
