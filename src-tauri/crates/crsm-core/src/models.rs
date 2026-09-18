use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    Claude,
    Codex,
    ClaudeCodex,
}

impl AgentKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::ClaudeCodex => "claude-codex",
        }
    }

    pub fn handoff_target(&self) -> Option<Self> {
        match self {
            Self::Claude => Some(Self::Codex),
            Self::Codex => Some(Self::Claude),
            Self::ClaudeCodex => None,
        }
    }
}

impl std::fmt::Display for AgentKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for AgentKind {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "claude-codex" => Ok(Self::ClaudeCodex),
            _ => Err(format!("unknown agent kind: {value}")),
        }
    }
}

fn default_has_user_messages() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionEntry {
    pub kind: AgentKind,
    pub id: String,
    pub cwd: String,
    pub label: String,
    pub preview: String,
    pub last_activity: DateTime<Utc>,
    #[serde(default)]
    pub started_at: Option<DateTime<Utc>>,
    pub source: String,
    pub source_path: PathBuf,
    pub transcript_path: Option<PathBuf>,
    pub summary_file: Option<String>,
    pub files_modified: Vec<String>,
    pub incomplete_tasks: Vec<String>,
    #[serde(default = "default_has_user_messages")]
    pub has_user_messages: bool,
}

impl SessionEntry {
    pub fn search_text(&self) -> String {
        format!(
            "{} {} {} {} {} {}",
            self.kind,
            self.id,
            self.cwd,
            self.label,
            self.preview,
            self.files_modified.join(" ")
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpenMode {
    Resume,
    Handoff,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PaneHint {
    pub row: Option<u16>,
    pub col: Option<u16>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorksetEntry {
    pub original_agent_kind: AgentKind,
    pub target_agent_kind: AgentKind,
    pub open_mode: OpenMode,
    pub session_id: String,
    pub cwd: String,
    pub label: String,
    pub last_mtime: DateTime<Utc>,
    pub pane_hint: Option<PaneHint>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorksetLayout {
    pub kind: String,
    pub cols: Option<u16>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Workset {
    pub schema_version: u16,
    pub name: String,
    pub saved_at: DateTime<Utc>,
    pub entries: Vec<WorksetEntry>,
    pub layout: WorksetLayout,
    pub notes: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RestorePlan {
    pub schema_version: u16,
    pub name: String,
    pub entries: Vec<WorksetEntry>,
    pub layout: WorksetLayout,
}
