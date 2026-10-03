//! Capability declarations are owned by the product adapters, not inferred from a TUI.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const CAPABILITY_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityLevel {
    Enforced,
    RequestedOnly,
    Unsupported,
    Unverified,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationCapability {
    pub level: CapabilityLevel,
    pub scope: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationObservation {
    /// Null means unspecified, not the agent's actual default.
    pub requested: Value,
    /// Only adapter responses/events may populate this; never copy requested here.
    pub effective: Value,
    pub source: Option<String>,
    pub observed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilities {
    pub version: u32,
    pub agent: String,
    pub mode: String,
    pub enabled: bool,
    pub executable_version: Option<String>,
    pub tested_executable_version: Option<String>,
    pub required_executable_version: Option<String>,
    pub tested_scope: Vec<String>,
    pub operations: std::collections::BTreeMap<String, OperationCapability>,
    pub configuration: ConfigurationObservation,
    pub sources: Vec<String>,
}

fn capability(level: CapabilityLevel, scope: &str) -> OperationCapability {
    OperationCapability {
        level,
        scope: scope.into(),
    }
}

/// Existing launchers are declarative inputs. This does not certify that a CLI processed them.
pub fn legacy_capabilities(agent: &str) -> Result<AdapterCapabilities, String> {
    if ![
        "claude",
        "codex",
        "claude-codex",
        "grok",
        "agy",
        "hermes",
        "omp",
    ]
    .contains(&agent)
    {
        return Err(format!("unsupported: agent adapter {agent}"));
    }
    let tracked = ["claude", "codex", "claude-codex", "grok"].contains(&agent);
    let mut operations = std::collections::BTreeMap::new();
    operations.insert(
        "start".into(),
        capability(
            CapabilityLevel::RequestedOnly,
            "Existing launcher arguments; process/model acceptance is not observed here.",
        ),
    );
    for name in ["resume", "fork"] {
        operations.insert(
            name.into(),
            capability(
                if tracked {
                    CapabilityLevel::RequestedOnly
                } else {
                    CapabilityLevel::Unsupported
                },
                if tracked {
                    "Existing conversation/clone route; actual CLI acceptance is unverified."
                } else {
                    "This adapter has no supported conversation resume/fork contract."
                },
            ),
        );
    }
    operations.insert(
        "send".into(),
        capability(
            CapabilityLevel::RequestedOnly,
            "Guarded PTY input; successful writing is not agent acceptance or turn start.",
        ),
    );
    for name in ["steer", "interrupt"] {
        operations.insert(name.into(), capability(CapabilityLevel::Unsupported,
            "No structured active-turn operation; do not replace with input or process termination."));
    }
    for name in ["readEvents", "usage"] {
        operations.insert(name.into(), capability(
            if tracked { CapabilityLevel::Unverified } else { CapabilityLevel::Unsupported },
            if tracked { "Existing hook/transcript adapter; executable version and completeness unverified." }
            else { "No registered event/usage adapter." }));
    }
    Ok(AdapterCapabilities {
        version: CAPABILITY_VERSION, agent: agent.into(), mode: "pty".into(), enabled: true,
        executable_version: None, tested_executable_version: None, required_executable_version: None,
        tested_scope: vec!["Static inspection of existing launcher and transcript adapters; no live CLI certification.".into()],
        operations, configuration: ConfigurationObservation::default(),
        sources: vec!["docs/agent-integration.md".into(), "docs/adr/0014-agent-neutral-workspace-and-handoff-contracts.md".into()],
    })
}

pub fn codex_app_server_capabilities(
    enabled: bool,
    executable_version: Option<String>,
    configuration: ConfigurationObservation,
) -> AdapterCapabilities {
    let mut operations = std::collections::BTreeMap::new();
    for (name, scope) in [
        ("start", "One ephemeral thread; initialize and thread/start response required."),
        ("send", "One logical turn with an operation ID; receipt and started/completed events kept separately."),
        ("steer", "turn/steer with expectedTurnId; accepted input is not proof of model use."),
        ("interrupt", "turn/interrupt; completion requires an interrupted turn/completed event."),
        ("readEvents", "Bounded stdio notifications scoped to this connection/thread/turn; no screen reads."),
        ("usage", "Reported thread token usage / allowance only; monetary amounts remain unknown."),
    ] {
        operations.insert(name.into(), capability(CapabilityLevel::Enforced, scope));
    }
    for name in ["resume", "fork"] {
        operations.insert(name.into(), capability(CapabilityLevel::Unsupported,
            "Outside the one-thread experiment; never fall back to starting a new conversation."));
    }
    AdapterCapabilities {
        version: CAPABILITY_VERSION, agent: "codex".into(), mode: "appServerStdioExperiment".into(), enabled,
        executable_version, tested_executable_version: Some(crate::codex_app_server::PINNED_VERSION.into()),
        required_executable_version: Some(crate::codex_app_server::PINNED_VERSION.into()),
        tested_scope: vec![
            "Codex CLI 0.160.0 Windows: initialize/thread/start/turn/start and one completed text turn.".into(),
            "Rust protocol/transport fixtures: event ordering, steer, interrupt, loss, duplicate IDs, unsupported requests.".into(),
            "Live steer/interrupt, resume/fork, reconnection and other CLI versions are unverified.".into(),
        ],
        operations, configuration,
        sources: vec!["https://learn.chatgpt.com/docs/app-server".into(), "docs/plans/2026-10-03-openai-o1-o2-o3.md".into()],
    }
}

pub async fn snapshot(state: &crate::codex_app_server::CodexAppServerState) -> Value {
    let current = state.snapshot().await;
    let mut adapters: Vec<_> = [
        "claude",
        "codex",
        "claude-codex",
        "grok",
        "agy",
        "hermes",
        "omp",
    ]
    .into_iter()
    .map(|agent| {
        crate::livebrief::AgentAdapter::new(agent)
            .map(|adapter| adapter.capabilities())
            .unwrap_or_else(|_| legacy_capabilities(agent).expect("registered adapter"))
    })
    .collect();
    adapters.push(codex_app_server_capabilities(
        current.enabled,
        current.cli_version,
        current.configuration,
    ));
    json!({ "version": CAPABILITY_VERSION, "adapters": adapters })
}

#[tauri::command]
pub async fn agent_adapter_capabilities(
    state: tauri::State<'_, crate::codex_app_server::CodexAppServerState>,
) -> Result<Value, String> {
    Ok(snapshot(&state).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_adapters_declare_exactly_the_eight_operations_and_unknown_versions() {
        let names: Vec<_> = vec![
            "fork",
            "interrupt",
            "readEvents",
            "resume",
            "send",
            "start",
            "steer",
            "usage",
        ];
        for agent in [
            "claude",
            "codex",
            "claude-codex",
            "grok",
            "agy",
            "hermes",
            "omp",
        ] {
            let declaration = legacy_capabilities(agent).unwrap();
            assert_eq!(
                declaration
                    .operations
                    .keys()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                names
            );
            assert!(declaration.executable_version.is_none());
            assert!(!declaration.configuration.observed);
            assert!(declaration.configuration.effective.is_null());
            assert_eq!(
                declaration.operations["send"].level,
                CapabilityLevel::RequestedOnly
            );
        }
        assert!(legacy_capabilities("unknown")
            .unwrap_err()
            .starts_with("unsupported:"));
    }

    #[test]
    fn experimental_capability_is_version_pinned_and_never_substitutes_resume_or_fork() {
        let declaration =
            codex_app_server_capabilities(false, None, ConfigurationObservation::default());
        assert!(!declaration.enabled);
        assert_eq!(
            declaration.required_executable_version.as_deref(),
            Some("0.160.0")
        );
        for name in ["resume", "fork"] {
            assert_eq!(
                declaration.operations[name].level,
                CapabilityLevel::Unsupported
            );
        }
        let encoded = serde_json::to_value(&declaration).unwrap();
        assert!(encoded["configuration"]["effective"].is_null());
        assert_eq!(encoded["operations"]["steer"]["level"], "enforced");
    }
}
