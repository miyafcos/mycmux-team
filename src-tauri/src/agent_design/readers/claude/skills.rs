use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Visibility {
    On,
    NameOnly,
    UserOnly,
    Off,
    Unknown,
}
impl Visibility {
    fn parse(value: &Value) -> Self {
        match value.as_str() {
            Some("on") => Self::On,
            Some("name-only") => Self::NameOnly,
            Some("user-invocable-only") => Self::UserOnly,
            Some("off") => Self::Off,
            _ => Self::Unknown,
        }
    }
    fn state(self) -> &'static str {
        match self {
            Self::On => "on",
            Self::NameOnly => "name-only",
            Self::UserOnly => "user-invocable-only",
            Self::Off => "off",
            Self::Unknown => "unknown",
        }
    }
    fn listed(self) -> bool {
        matches!(self, Self::On | Self::NameOnly)
    }
}

pub(super) struct Overrides {
    known: bool,
    entries: BTreeMap<String, Visibility>,
}
impl Default for Overrides {
    fn default() -> Self {
        Self { known: true, entries: BTreeMap::new() }
    }
}
impl Overrides {
    pub(super) fn unknown() -> Self {
        Self { known: false, entries: BTreeMap::new() }
    }
    pub(super) fn from_settings(settings: &Value) -> Self {
        if !settings.is_object() {
            return Self::unknown();
        }
        let Some(value) = settings.get("skillOverrides") else {
            return Self::default();
        };
        let Some(entries) = value.as_object() else {
            return Self::unknown();
        };
        Self {
            known: true,
            entries: entries.iter().map(|(name, value)| (name.clone(), Visibility::parse(value))).collect(),
        }
    }
    fn get(&self, name: &str) -> Visibility {
        if self.known {
            self.entries.get(name).copied().unwrap_or(Visibility::On)
        } else {
            Visibility::Unknown
        }
    }
    pub(super) fn has_unknown(&self) -> bool {
        !self.known || self.entries.values().any(|mode| *mode == Visibility::Unknown)
    }
}

fn field<'a>(item: &'a Item, key: &str) -> Option<&'a str> {
    item.fields.iter().find(|field| field.key == key).map(|field| field.value.as_str())
}
fn account_component(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| {
        !value.is_empty() && value.len() <= 128
            && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}
fn account_directory(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return false; };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}
fn current_account(root: &Path, state: Option<&Value>) -> Option<PathBuf> {
    let account = &state?["oauthAccount"];
    let organization = account_component(&account["organizationUuid"])?;
    let account = account_component(&account["accountUuid"])?;
    let folder = root.join("skills/synced").join(format!("{organization}_{account}"));
    account_directory(&folder).then_some(folder)
}

pub(super) struct SyncedScan {
    account_known: bool,
    complete: bool,
}

pub(super) fn read_synced(
    scan: &mut Scan,
    root: &Path,
    cache: &BTreeMap<String, (String, String)>,
    home: &Path,
    state: Option<&Value>,
) -> (BTreeSet<String>, SyncedScan) {
    let selected = current_account(root, state);
    // Enumerate the resolved account directly: directory lookup, including its
    // casing rules, belongs to the filesystem rather than Path::starts_with.
    let current_files = selected.as_ref().and_then(|folder| safe::files(folder, Some(&["md"])));
    let account_known = selected.is_some();
    let mut complete = account_known && current_files.is_some();
    let mut files: Vec<_> = current_files.unwrap_or_default().into_iter().map(|path| (path, true)).collect();
    for folder in safe::children(&root.join("skills/synced")).unwrap_or_default() {
        if !account_directory(&folder)
            || selected.as_ref().is_some_and(|selected| safe::same_path(&folder, selected))
        {
            continue;
        }
        files.extend(safe::files(&folder, Some(&["md"])).unwrap_or_default().into_iter().map(|path| (path, false)));
    }
    let mut names = BTreeSet::new();
    let mut count = 0;
    for (path, current) in files.iter().filter(|(path, _)| safe::basename(path) == "SKILL.md") {
        let start = scan.items.len();
        let name = skill(scan, path, cache, home);
        if *current {
            count += 1;
            complete &= name.is_some();
            if let Some(name) = &name {
                names.insert(name.clone());
            }
        }
        let Some(item) = scan.items.get_mut(start) else { continue; };
        item.fields.retain(|field| field.key != "sourceKind");
        item.fields.push(Field::new("sourceKind", "synced"));
        item.fields.push(Field::new("namespace", "anthropic-skills"));
        if let Some(name) = name {
            item.fields.push(Field::new("listingName", format!("anthropic-skills:{name}")));
        }
        item.fields.push(Field::new("syncedAccount", if !account_known { "unknown" } else if *current { "current" } else { "other" }));
        item.active = account_known && *current && item.status == "present";
        if !account_known {
            item.status = "unknown".into();
        }
    }
    scan.service.stat("skillsSynced", complete.then_some(count));
    (names, SyncedScan { account_known, complete })
}

pub(super) fn apply_overrides(scan: &mut Scan, overrides: &Overrides) {
    for item in scan.items.iter_mut().filter(|item| item.kind == "skill") {
        let Some(name) = field(item, "name").map(str::to_owned) else {
            item.active = false;
            item.fields.push(Field::new("listingState", "unknown"));
            continue;
        };
        let synced = field(item, "sourceKind") == Some("synced");
        let listing_name = if synced { format!("anthropic-skills:{name}") } else { name };
        if !synced {
            item.fields.push(Field::new("namespace", "none"));
            item.fields.push(Field::new("listingName", &listing_name));
        }
        let mode = overrides.get(&listing_name);
        item.fields.push(Field::new("skillOverride", mode.state()));
        let state = match field(item, "syncedAccount") {
            Some("other") => "otherAccount",
            Some("unknown") => "accountUnknown",
            _ if item.status == "unknown" => "unknown",
            _ => mode.state(),
        };
        item.fields.push(Field::new("listingState", state));
        item.active &= mode.listed() && item.status == "present";
        if mode == Visibility::Unknown {
            item.status = "unknown".into();
        }
    }
}

// A sampled conversation can predate the current account/settings. Preserve its
// provenance and non-skill overhead, but derive eligible entries and totals from
// the current declarations. Unknown eligibility makes the aggregate unknown.
pub(super) fn filter_listing(scan: &mut Scan, overrides: &Overrides, synced_scan: SyncedScan) {
    let listing = &mut scan.service.session.listing;
    if listing.count.is_none() && listing.text_complete.is_none() {
        return;
    }
    let mut entries = vec![];
    let mut removed = 0;
    let mut removed_chars = 0;
    let mut added_chars = 0;
    let names_complete = listing.names_complete;
    let text_complete = listing.text_complete;
    let mut unknown = text_complete == Some(false);
    let mut unknown_names = vec![];
    for mut entry in std::mem::take(&mut listing.entries) {
        let items: Vec<_> = scan.items.iter().filter(|item| item.kind == "skill" && field(item, "listingName") == Some(entry.name.as_str())).collect();
        // The record's identity is authoritative. A bare command/builtin name
        // must not inherit a namespaced synced copy's account or override.
        let synced = entry.name.starts_with("anthropic-skills:");
        let mode = overrides.get(&entry.name);
        let active = if synced { items.iter().any(|item| item.active) } else { items.is_empty() || items.iter().any(|item| item.active) };
        if !mode.listed() || !active {
            removed += 1;
            removed_chars += entry.chars;
            let uncertain = mode == Visibility::Unknown || (mode.listed()
                && ((synced && (!synced_scan.account_known || !synced_scan.complete))
                    || items.iter().any(|item| item.status == "unknown"
                        && (!synced || field(item, "syncedAccount") != Some("other")))));
            if uncertain {
                unknown = true;
                unknown_names.push(entry.name);
            }
            continue;
        }
        if mode == Visibility::NameOnly {
            removed_chars += entry.chars;
            entry.chars = entry.name.chars().count() as u64;
            added_chars += entry.chars;
        }
        if synced {
            entry.kind = "synced".into();
            entry.plugin = None;
        }
        let qualified_plugin = entry.name.split_once(':').filter(|_| !synced);
        if let Some((plugin, _)) = qualified_plugin {
            entry.kind = "plugin".into();
            entry.plugin = Some(plugin.into());
        }
        entries.push(entry);
    }
    let count = listing.count.filter(|_| !unknown).map(|count| count.saturating_sub(removed));
    let chars = listing.chars.filter(|_| !unknown).map(|chars| chars.saturating_sub(removed_chars) + added_chars);
    *listing = records::finish_listing(count, chars.unwrap_or(0), entries);
    listing.chars = chars;
    listing.unknown_names = unknown_names;
    listing.names_complete = names_complete;
    listing.text_complete = text_complete;
    listing.evidence = Some("estimated".into());
}
