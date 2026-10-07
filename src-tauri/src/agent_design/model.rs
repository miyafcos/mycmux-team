use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Size {
    pub chars: Option<u64>,
    pub lines: Option<u64>,
    pub bytes: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub key: String,
    pub value: String,
}
impl Field {
    pub fn new(key: &str, value: impl ToString) -> Self {
        Self {
            key: key.into(),
            value: value.to_string(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub service: String,
    pub layer: u8,
    pub display_name: String,
    pub path: Option<String>,
    pub kind: String,
    pub status: String,
    pub size: Size,
    pub read_timing: String,
    pub evidence: String,
    pub modified_at: Option<u64>,
    pub fields: Vec<Field>,
    pub conditions: Vec<String>,
    pub document_allowed: bool,
    pub active: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub id: String,
    pub from: String,
    pub to: String,
    pub source_service: String,
    pub target_service: String,
    pub relation: String,
    pub evidence: String,
    pub line: Option<u64>,
    pub target_path: Option<String>,
    pub exists: Option<bool>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hook {
    pub event: String,
    pub matcher: String,
    pub script: String,
    pub source: String,
    pub line: Option<u64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedSkill {
    pub name: String,
    pub chars: u64,
    pub kind: String,
    pub plugin: Option<String>,
    pub path: Option<String>,
    pub usage_recorded: Option<bool>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingGroup {
    pub kind: String,
    pub count: u64,
    pub chars: u64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub count: Option<u64>,
    pub chars: Option<u64>,
    pub entries: Vec<ListedSkill>,
    pub groups: Vec<ListingGroup>,
    pub plugin_counts: BTreeMap<String, u64>,
    pub disabled_counts: BTreeMap<String, u64>,
    pub disabled_chars: Option<u64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub kind: String,
    pub chars: u64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub file: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    pub lines_read: u64,
    pub bytes_consumed: u64,
    pub stopped_at: String,
    pub listing: Listing,
    pub startup_hooks: Vec<Field>,
    pub startup_chars: Option<u64>,
    pub sections: Vec<Section>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextAmount {
    pub instructions: Option<u64>,
    pub memory: Option<u64>,
    pub listing: Option<u64>,
    pub startup: Option<u64>,
    pub product: Option<u64>,
    pub total: Option<u64>,
    pub known_total: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: String,
    pub display_name: String,
    pub root: String,
    pub state: String,
    pub version: Option<String>,
    pub settings: Vec<Field>,
    pub stats: BTreeMap<String, Option<u64>>,
    pub hooks: Vec<Hook>,
    pub session: Session,
    pub context: ContextAmount,
}
impl Service {
    pub fn new(id: &str, label: &str, root: &std::path::Path) -> Self {
        Self {
            id: id.into(),
            display_name: label.into(),
            root: root.to_string_lossy().into(),
            state: if root.is_dir() { "present" } else { "absent" }.into(),
            version: None,
            settings: vec![],
            stats: BTreeMap::new(),
            hooks: vec![],
            session: Session::default(),
            context: ContextAmount::default(),
        }
    }
    pub fn stat(&mut self, key: &str, value: Option<u64>) {
        self.stats.insert(key.into(), value);
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub path: Option<String>,
    pub line: Option<u64>,
    pub record: Option<String>,
    pub rule: String,
    pub fields: Vec<Field>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub kind: String,
    pub service: String,
    pub layer: u8,
    pub severity: String,
    pub count: u64,
    pub chars: Option<u64>,
    pub evidence: Vec<Evidence>,
    pub unknowns: Vec<String>,
    pub proposal: String,
    pub item_ids: Vec<String>,
    pub names: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub schema_version: u8,
    pub generated_at: String,
    #[serde(default)]
    pub generator: String,
    #[serde(default)]
    pub work_folder: String,
    pub home: String,
    pub cwd: String,
    pub refresh_ms: f64,
    pub services: Vec<Service>,
    pub items: Vec<Item>,
    pub links: Vec<Link>,
    pub findings: Vec<Finding>,
    pub closed_count: u64,
    pub warnings: Vec<String>,
    #[serde(default)]
    pub layers: Vec<super::portable::Layer>,
    #[serde(default)]
    pub reading_flows: Vec<super::portable::ReadingFlow>,
    #[serde(default)]
    pub compare_rows: Vec<super::portable::CompareRow>,
    #[serde(default)]
    pub documents: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub closed_revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Closure {
    pub id: String,
    #[serde(rename = "workFolder", alias = "cwd")]
    pub cwd: String,
    pub reason: String,
    #[serde(rename = "closedAt", alias = "date")]
    pub date: String,
    #[serde(default = "default_place")]
    pub closed_from: String,
}
fn default_place() -> String {
    "pc".into()
}
fn schema_one() -> u8 {
    1
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Closed {
    #[serde(default = "schema_one")]
    pub schema_version: u8,
    #[serde(default)]
    pub revision: u64,
    pub closed: Vec<Closure>,
}
impl Default for Closed {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            closed: vec![],
        }
    }
}
