use super::{document, model::*};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub id: u8,
    pub role: String,
    pub item_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowStep {
    pub id: String,
    pub stage: u8,
    pub timing: String,
    pub chars: Option<u64>,
    pub evidence: String,
    pub item_ids: Vec<String>,
    pub hook_scripts: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingFlow {
    pub service: String,
    pub steps: Vec<FlowStep>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareCell {
    pub service: String,
    pub state: String,
    pub item_ids: Vec<String>,
    pub values: BTreeMap<String, Option<u64>>,
    pub fields: Vec<Field>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareRow {
    pub id: String,
    pub tag: String,
    pub cells: Vec<CompareCell>,
}
pub const ROLES: [&str; 14] = [
    "globalInstructions",
    "folderInstructions",
    "rules",
    "settings",
    "permissions",
    "memory",
    "ownSkills",
    "skillListing",
    "plugins",
    "agents",
    "mcp",
    "hooks",
    "scheduled",
    "references",
];
pub fn complete(catalog: &mut Catalog, home: &Path, cwd: &Path) {
    let layer_roles = [
        "runtime",
        "settings",
        "instructions",
        "memory",
        "skills",
        "automation",
        "references",
    ];
    catalog.layers = (1..=7)
        .map(|id| Layer {
            id,
            role: layer_roles[id as usize - 1].into(),
            item_ids: catalog
                .items
                .iter()
                .filter(|i| i.layer == id)
                .map(|i| i.id.clone())
                .collect(),
        })
        .collect();
    let names = [
        "settings",
        "instructions",
        "memory",
        "listing",
        "startup",
        "request",
        "tools",
        "conditional",
        "skillBody",
        "references",
        "response",
        "end",
    ];
    let stages = [0, 1, 1, 1, 1, 2, 3, 4, 4, 4, 5, 6];
    catalog.reading_flows = catalog
        .services
        .iter()
        .map(|s| ReadingFlow {
            service: s.id.clone(),
            steps: if s.id == "hermes" {
                vec![]
            } else {
                names
                    .iter()
                    .enumerate()
                    .map(|(n, name)| {
                        let events: &[&str] = match n {
                            4 => &["SessionStart"],
                            5 => &["UserPromptSubmit", "UserPrompt"],
                            6 => &["PreToolUse", "PostToolUse", "PreToolCall", "PostToolCall"],
                            10 => &["Stop", "AfterAgent", "Response"],
                            11 => &["SessionEnd"],
                            _ => &[],
                        };
                        let amount = match n {
                            1 => s.context.instructions,
                            2 => s.context.memory,
                            3 => s.context.listing,
                            4 => s.context.startup,
                            _ => None,
                        };
                        let kinds: &[&str] = match n {
                            0 => &["settings", "settingsLocal", "permissionRules"],
                            1 => &["instruction", "override", "shadowedInstruction", "rule"],
                            2 => &["memoryIndex"],
                            3 => &["skillListing"],
                            7 => &["rule"],
                            8 => &["skill", "command"],
                            9 => &["reference", "memoryDirectory"],
                            _ => &["hooks"],
                        };
                        FlowStep {
                            id: (*name).into(),
                            stage: stages[n],
                            timing: if (1..=4).contains(&n) {
                                "always"
                            } else if n == 7 {
                                "conditional"
                            } else if [8, 9].contains(&n) {
                                "onDemand"
                            } else {
                                "outside"
                            }
                            .into(),
                            chars: amount,
                            evidence: if (n == 3 && amount.is_some())
                                || (n == 4 && amount.is_some())
                                || (s.id == "codex" && [1, 2].contains(&n) && amount.is_some())
                            {
                                "measured"
                            } else {
                                "declaration"
                            }
                            .into(),
                            item_ids: catalog
                                .items
                                .iter()
                                .filter(|i| {
                                    i.service == s.id
                                        && kinds.contains(&i.kind.as_str())
                                        && (n != 1 || (i.active && i.read_timing == "always"))
                                        && (n != 7 || i.read_timing == "conditional")
                                })
                                .map(|i| i.id.clone())
                                .collect(),
                            hook_scripts: s
                                .hooks
                                .iter()
                                .filter(|h| events.contains(&h.event.as_str()))
                                .map(|h| h.script.clone())
                                .collect(),
                        }
                    })
                    .collect()
            },
        })
        .collect();
    catalog.compare_rows = ROLES
        .iter()
        .enumerate()
        .map(|(row, role)| {
            let damaged = catalog
                .services
                .iter()
                .any(|s| s.id == "codex" && !s.session.listing.disabled_counts.is_empty());
            CompareRow {
                id: (*role).into(),
                tag: if row == 8 && damaged {
                    "damaged"
                } else if row == 2 {
                    "claudeOnly"
                } else if [1, 4, 6].contains(&row) {
                    "differentForm"
                } else if [9, 10, 11, 12, 13].contains(&row) {
                    "differentCount"
                } else {
                    "sameRole"
                }
                .into(),
                cells: catalog
                    .services
                    .iter()
                    .map(|s| {
                        let root = super::safe::normalized(Path::new(&s.root));
                        let selected: Vec<_> = catalog
                            .items
                            .iter()
                            .filter(|i| {
                                if i.service != s.id {
                                    return false;
                                }
                                let inside = i.path.as_ref().is_some_and(|p| {
                                    super::safe::normalized(Path::new(p))
                                        .starts_with(&(root.clone() + "/"))
                                });
                                match row {
                                    0 => i.kind == "instruction" && inside,
                                    1 => {
                                        ["instruction", "override", "shadowedInstruction"]
                                            .contains(&i.kind.as_str())
                                            && !inside
                                    }
                                    2 => i.kind == "rule",
                                    3 => i.kind == "settings",
                                    4 => {
                                        i.kind
                                            == if s.id == "claude" {
                                                "settings"
                                            } else {
                                                "permissionRules"
                                            }
                                    }
                                    5 => i.kind == "memoryIndex",
                                    6 => i.kind == "skill",
                                    7 => i.kind == "skillListing",
                                    8 => i.kind == "plugins",
                                    9 => i.kind == "agent",
                                    10 => i.kind == "mcp",
                                    11 => i.kind == "hooks",
                                    12 => i.kind == "scheduled",
                                    _ => i.kind == "reference",
                                }
                            })
                            .collect();
                        let mut values = BTreeMap::new();
                        if row <= 1 {
                            let active: Vec<_> = selected.iter().filter(|i| i.active).collect();
                            values.insert(
                                "chars".into(),
                                if active.is_empty() {
                                    None
                                } else {
                                    active
                                        .iter()
                                        .map(|i| i.size.chars)
                                        .collect::<Option<Vec<_>>>()
                                        .map(|v| v.iter().sum())
                                },
                            );
                        }
                        let keys: &[&str] = match row {
                            2 => &["rules", "rulesAlways", "rulesConditional"],
                            4 => &["allow", "allowLocal", "rulesBytes"],
                            5 => &["memoryFiles"],
                            6 => &["skillsOwn", "skillsCodex", "skillsAgents"],
                            8 => &["plugins", "pluginsEnabled"],
                            9 => &["agents"],
                            10 => &["mcp", "mcpUser", "mcpProject", "mcpCommented"],
                            11 => &["hookEvents", "hookHandlers"],
                            12 => &["scheduledJobs", "scheduledEnabled"],
                            13 => &["references"],
                            _ => &[],
                        };
                        for key in keys {
                            values.insert((*key).into(), s.stats.get(*key).copied().flatten());
                        }
                        if row == 5 {
                            values.insert("chars".into(), s.context.memory);
                        }
                        if row == 6 {
                            values.insert(
                                "listed".into(),
                                s.session
                                    .listing
                                    .groups
                                    .iter()
                                    .find(|g| {
                                        g.kind == if s.id == "claude" { "own" } else { "user" }
                                    })
                                    .map(|g| g.count),
                            );
                        }
                        if row == 7 {
                            values.insert("count".into(), s.session.listing.count);
                            values.insert("chars".into(), s.session.listing.chars);
                        }
                        let fields = match row {
                            3 => s
                                .settings
                                .iter()
                                .filter(|f| {
                                    ["model", "effortLevel", "model_reasoning_effort"]
                                        .contains(&f.key.as_str())
                                })
                                .cloned()
                                .collect(),
                            4 => s
                                .settings
                                .iter()
                                .filter(|f| {
                                    ["defaultMode", "approval_policy", "sandbox_mode"]
                                        .contains(&f.key.as_str())
                                })
                                .cloned()
                                .collect(),
                            _ => vec![],
                        };
                        CompareCell {
                            service: s.id.clone(),
                            state: s.state.clone(),
                            item_ids: selected.iter().map(|i| i.id.clone()).collect(),
                            values,
                            fields,
                        }
                    })
                    .collect(),
            }
        })
        .collect();
    catalog.documents = catalog
        .items
        .iter()
        .filter(|i| i.document_allowed)
        .filter_map(|i| {
            document(home, cwd, catalog, &i.id)
                .ok()
                .map(|doc| (i.id.clone(), doc))
        })
        .collect();
}
