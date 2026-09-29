use std::collections::HashMap;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiProvider {
    ClaudeCode,
    Codex,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiConfig {
    pub provider: AiProvider,
    pub model: String,
    pub enabled: bool,
}

impl AiProvider {
    pub fn program(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude",
            Self::Codex => {
                if cfg!(windows) {
                    "codex.cmd"
                } else {
                    "codex"
                }
            }
        }
    }
    pub fn default_model(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-haiku-4-5-20251001",
            Self::Codex => "gpt-5.6-luna",
        }
    }
    pub fn display_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
        }
    }
    pub fn cli_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude",
            Self::Codex => "codex",
        }
    }
    pub fn from_storage(value: &str) -> Self {
        if value == "claude-code" {
            Self::ClaudeCode
        } else {
            Self::Codex
        }
    }
    pub fn as_storage(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }
}

impl AiConfig {
    pub fn sanitized_model(&self) -> String {
        let model = self.model.trim();
        if model.is_empty() || model.starts_with('-') || model.chars().any(char::is_control) {
            crate::diag_warn!(
                "ai",
                "unsafe model setting for {}; using default",
                self.provider.cli_name()
            );
            self.provider.default_model().to_string()
        } else {
            model.to_string()
        }
    }
    pub fn args(&self) -> Vec<String> {
        let model = self.sanitized_model();
        match self.provider {
            AiProvider::ClaudeCode => vec![
                "-p".into(),
                "--model".into(),
                model,
                "--output-format".into(),
                "text".into(),
            ],
            // Background judges must not inherit the operator's interactive
            // codex profile: on 2026-08-30 the grouping judge ran five times
            // at the profile's `model_reasoning_effort = "max"` with five MCP
            // servers loaded, spent ~48s starting and never answered inside
            // the 300s budget. `--ignore-user-config` skips config.toml (auth
            // still comes from CODEX_HOME) and the effort is pinned low.
            AiProvider::Codex => vec![
                "exec".into(),
                "--model".into(),
                model,
                "--ignore-user-config".into(),
                "-c".into(),
                "model_reasoning_effort=low".into(),
                "-c".into(),
                "features.fast_mode=false".into(),
                "-".into(),
            ],
        }
    }
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: AiProvider::Codex,
            model: AiProvider::Codex.default_model().to_string(),
            enabled: true,
        }
    }
}

pub fn sanitized_env<I>(env: I) -> HashMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut sanitized: HashMap<String, String> = env.into_iter().collect();
    crate::commands::terminal::sanitize_launch_env(&mut sanitized);
    sanitized.retain(|key, _| !key.to_ascii_uppercase().starts_with("MYCMUX_"));
    sanitized
}

pub fn build_command<I>(cfg: &AiConfig, env: I) -> Command
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut args = cfg.args();
    let program =
        crate::commands::terminal::prepare_spawn_command(cfg.provider.program(), &mut args);
    let mut command = Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(sanitized_env(env))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(crate::util::process::CREATE_NO_WINDOW);
    }
    command
}

pub fn resolve(app: &tauri::AppHandle) -> AiConfig {
    crate::db::storage::load(app)
        .map(|data| AiConfig {
            provider: AiProvider::from_storage(&data.settings.ai_provider),
            model: data.settings.ai_model,
            enabled: data.settings.ai_enabled,
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
