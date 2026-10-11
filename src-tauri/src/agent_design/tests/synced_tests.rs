use super::*;

#[path = "synced_tests/review_tests.rs"]
mod review_tests;

fn skill_file(f: &Fixture, folder: &str, name: &str) {
    write(f.home(), &format!(".claude/skills/{folder}/SKILL.md"),
        &format!("---\nname: {name}\ndescription: Synthetic procedure\n---\n# Synthetic\n"));
}
fn listing(f: &Fixture, names: &[&str]) -> String {
    let content = format!("Available skills:\n{}", names.iter().map(|name| format!("- {name}: Synthetic procedure 日本語\n")).collect::<String>());
    let row = json!({"type":"attachment","attachment":{"type":"skill_listing","isInitial":true,"skillCount":names.len(),"names":names,"content":content}});
    write(f.home(), &format!(".claude/projects/{}/initial.jsonl", safe::project_key(f.home())), &format!("{row}\n"));
    content
}
fn home_with_accounts() -> Fixture {
    let f = Fixture::new("empty");
    write(f.home(), ".claude/settings.json", "{}");
    write(f.home(), ".claude.json", r#"{"oauthAccount":{"organizationUuid":"org-a","accountUuid":"account-a"},"skillUsage":{}}"#);
    skill_file(&f, "synced/org-a_account-a/pptx", "pptx");
    skill_file(&f, "synced/org-b_account-b/pptx", "pptx");
    skill_file(&f, "synced/org-b_account-b/foreign-only", "foreign-only");
    listing(&f, &["anthropic-skills:pptx", "anthropic-skills:foreign-only"]);
    f
}
fn field<'a>(item: &'a Item, key: &str) -> Option<&'a str> {
    item.fields.iter().find(|field| field.key == key).map(|field| field.value.as_str())
}
fn skills(c: &Catalog) -> Vec<&Item> {
    c.items.iter().filter(|item| item.service == "claude" && item.kind == "skill").collect()
}
fn findings<'a>(c: &'a Catalog, kind: &str) -> Vec<&'a Finding> {
    c.findings.iter().filter(|finding| finding.service == "claude" && finding.kind == kind).collect()
}

#[test]
fn only_current_account_is_active_and_counted() {
    let f = home_with_accounts();
    skill_file(&f, "synced/org-a_account-a/pdf", "pdf");
    listing(&f, &["anthropic-skills:pptx", "anthropic-skills:pdf", "anthropic-skills:foreign-only"]);
    let c = f.catalog();
    assert_eq!(service(&c, "claude").stats["skillsSynced"], Some(2));
    assert_eq!(skills(&c).iter().filter(|item| item.active).count(), 2);
    assert_eq!(skills(&c).iter().filter(|item| field(item, "listingState") == Some("otherAccount") && !item.active).count(), 2);
    assert!(skills(&c).iter().all(|item| field(item, "sourceKind") == Some("synced")));
    assert!(findings(&c, "duplicate").is_empty());
    let a = service(&c, "claude");
    assert_eq!(a.session.listing.count, Some(2));
    assert!(a.session.listing.entries.iter().all(|entry| entry.kind == "synced" && entry.name != "anthropic-skills:foreign-only"));
    assert_eq!(a.context.listing, Some("Available skills:\n".chars().count() as u64 + a.session.listing.entries.iter().map(|entry| entry.chars).sum::<u64>()));
    assert!(!findings(&c, "unusedListing")[0].names.contains(&"anthropic-skills:foreign-only".into()));
}

#[test]
fn own_and_current_synced_name_produce_one_shadow_with_both_identities() {
    let f = home_with_accounts();
    skill_file(&f, "pptx", "pptx");
    listing(&f, &["pptx", "anthropic-skills:pptx"]);
    let c = f.catalog();
    assert!(findings(&c, "duplicate").is_empty());
    let shadow = findings(&c, "shadow");
    assert_eq!(shadow.len(), 1);
    let shadow = shadow[0];
    assert_eq!(shadow.id, "claude:shadow:pptx");
    assert_eq!(shadow.severity, "watch");
    assert_eq!(shadow.count, 1);
    assert_eq!(shadow.evidence.len(), 2);
    for (folder, namespace, name) in [("pptx", "none", "pptx"), ("synced/org-a_account-a/pptx", "anthropic-skills", "anthropic-skills:pptx")] {
        assert!(shadow.evidence.iter().any(|evidence| {
            evidence.path.as_deref().is_some_and(|path| safe::same_path(Path::new(path), &f.home().join(format!(".claude/skills/{folder}/SKILL.md"))))
                && evidence.fields.iter().any(|field| field.key == "namespace" && field.value == namespace)
                && evidence.fields.iter().any(|field| field.key == "listingName" && field.value == name)
        }));
    }
}

#[test]
fn off_is_scoped_to_the_exact_own_or_namespaced_identity() {
    for disabled in ["pptx", "anthropic-skills:pptx"] {
        let f = home_with_accounts();
        skill_file(&f, "pptx", "pptx");
        listing(&f, &["pptx", "anthropic-skills:pptx"]);
        write(f.home(), ".claude/settings.json", &json!({"skillOverrides":{disabled:"off"}}).to_string());
        let c = f.catalog();
        assert!(findings(&c, "shadow").is_empty());
        assert!(findings(&c, "duplicate").is_empty());
        let a = service(&c, "claude");
        assert_eq!(a.session.listing.count, Some(1));
        assert_eq!(a.stats["skillsSynced"], Some(1));
        assert!(a.session.listing.entries.iter().all(|entry| entry.name != disabled));
        assert!(findings(&c, "unusedListing")[0].names.iter().all(|name| name != disabled));
        let disabled_item = skills(&c).into_iter().find(|item| field(item, "listingName") == Some(disabled) && field(item, "syncedAccount") != Some("other")).unwrap();
        assert!(!disabled_item.active);
        assert_eq!(field(disabled_item, "skillOverride"), Some("off"));
    }
}

#[test]
fn missing_invalid_or_unmatched_oauth_never_activates_synced_copies() {
    for state in [None, Some("not-json"), Some("{}"), Some(r#"{"oauthAccount":null,"skillUsage":{}}"#), Some(r#"{"oauthAccount":{"organizationUuid":"org-a"},"skillUsage":{}}"#), Some(r#"{"oauthAccount":{"organizationUuid":7,"accountUuid":"account-a"},"skillUsage":{}}"#), Some(r#"{"oauthAccount":{"organizationUuid":"org-missing","accountUuid":"account-a"},"skillUsage":{}}"#), Some(r#"{"oauthAccount":{"organizationUuid":"../org-a","accountUuid":"account-a"},"skillUsage":{}}"#)] {
        let f = home_with_accounts();
        if let Some(state) = state {
            write(f.home(), ".claude.json", state);
        } else {
            fs::remove_file(f.home().join(".claude.json")).unwrap();
        }
        let c = f.catalog();
        assert_eq!(service(&c, "claude").stats["skillsSynced"], None);
        assert!(skills(&c).iter().all(|item| !item.active && item.status == "unknown" && field(item, "syncedAccount") == Some("unknown")));
        assert!(service(&c, "claude").session.listing.entries.is_empty());
        assert_eq!(service(&c, "claude").context.listing, None);
        assert!(findings(&c, "duplicate").is_empty());
        assert!(findings(&c, "shadow").is_empty());
    }
}

#[test]
fn override_modes_control_duplicates_shadow_unused_and_character_counts() {
    for (mode, listed, unknown) in [(json!("on"), true, false), (json!("name-only"), true, false), (json!("off"), false, false), (json!("user-invocable-only"), false, false), (json!("future-mode"), false, true), (Value::Null, false, true), (json!(true), false, true), (json!({"mode":"on"}), false, true)] {
        let f = home_with_accounts();
        skill_file(&f, "pptx", "pptx");
        skill_file(&f, "another-copy", "pptx");
        let content = listing(&f, &["pptx", "anthropic-skills:pptx"]);
        write(f.home(), ".claude/settings.json", &json!({"skillOverrides":{"pptx":mode}}).to_string());
        let c = f.catalog();
        assert_eq!(findings(&c, "duplicate").len(), usize::from(listed));
        assert_eq!(findings(&c, "shadow").len(), usize::from(listed));
        assert_eq!(skills(&c).iter().filter(|item| field(item, "sourceKind") == Some("own") && item.active).count(), if listed { 2 } else { 0 });
        let a = service(&c, "claude");
        let own_entry = a.session.listing.entries.iter().find(|entry| entry.name == "pptx");
        assert_eq!(own_entry.is_some(), listed);
        let unused = findings(&c, "unusedListing");
        assert_eq!(unused[0].names.contains(&"pptx".into()), listed);
        assert_eq!(unused[0].chars, Some(a.session.listing.entries.iter().map(|entry| entry.chars).sum()));
        if mode == "name-only" {
            assert_eq!(own_entry.unwrap().chars, 4);
            assert!(a.context.listing.unwrap() < content.chars().count() as u64);
        }
        if unknown {
            assert_eq!(a.session.listing.count, None);
            assert_eq!(a.context.listing, None);
            assert!(skills(&c).iter().filter(|item| field(item, "sourceKind") == Some("own")).all(|item| item.status == "unknown" && field(item, "skillOverride") == Some("unknown")));
        } else {
            assert_eq!(a.session.listing.count, Some(if listed { 2 } else { 1 }));
            assert_eq!(a.context.listing, Some("Available skills:\n".chars().count() as u64 + a.session.listing.entries.iter().map(|entry| entry.chars).sum::<u64>()));
        }
    }
}

#[test]
fn namespaced_name_only_counts_the_full_listing_name_without_description() {
    let f = home_with_accounts();
    write(f.home(), ".claude/settings.json", r#"{"skillOverrides":{"anthropic-skills:pptx":"name-only"}}"#);
    let c = f.catalog();
    let a = service(&c, "claude");
    assert_eq!(a.session.listing.count, Some(1));
    assert_eq!(a.session.listing.entries[0].chars, "anthropic-skills:pptx".len() as u64);
    assert_eq!(a.context.listing, Some("Available skills:\n".len() as u64 + "anthropic-skills:pptx".len() as u64));
}

#[test]
fn hidden_entries_leave_no_unused_listing_or_description_characters() {
    for mode in ["off", "user-invocable-only"] {
        let f = home_with_accounts();
        skill_file(&f, "pptx", "pptx");
        listing(&f, &["pptx", "anthropic-skills:pptx"]);
        write(f.home(), ".claude/settings.json", &json!({"skillOverrides":{"pptx":mode,"anthropic-skills:pptx":mode}}).to_string());
        let c = f.catalog();
        let a = service(&c, "claude");
        assert_eq!(a.session.listing.count, Some(0));
        assert!(a.session.listing.entries.is_empty());
        assert!(a.session.listing.groups.is_empty());
        assert_eq!(a.context.listing, Some("Available skills:\n".len() as u64));
        assert!(findings(&c, "unusedListing").is_empty());
    }
}

#[test]
fn malformed_override_maps_and_settings_remain_unknown_without_panics() {
    for settings in ["not-json", "null", "[]", r#"{"skillOverrides":null}"#, r#"{"skillOverrides":false}"#, r#"{"skillOverrides":[]}"#, r#"{"skillOverrides":"on"}"#] {
        let f = home_with_accounts();
        skill_file(&f, "pptx", "pptx");
        listing(&f, &["pptx", "anthropic-skills:pptx", "help"]);
        write(f.home(), ".claude/settings.json", settings);
        let c = f.catalog();
        let a = service(&c, "claude");
        assert!(skills(&c).iter().all(|item| !item.active));
        assert!(a.settings.iter().any(|field| field.key == "skillOverrides" && field.value == "unknown"));
        assert_eq!(a.session.listing.count, None);
        assert_eq!(a.context.listing, None);
        assert!(a.session.listing.entries.is_empty());
        assert!(findings(&c, "unusedListing").is_empty());
        assert!(findings(&c, "shadow").is_empty());
    }
}

#[test]
fn true_duplicate_synced_names_compare_the_namespaced_identity_only() {
    let f = home_with_accounts();
    skill_file(&f, "synced/org-a_account-a/second-copy", "PPTX");
    let c = f.catalog();
    let duplicate = findings(&c, "duplicate");
    assert_eq!(duplicate.len(), 1);
    assert_eq!(duplicate[0].id, "claude:duplicate:anthropic-skills:pptx");
    assert_eq!(duplicate[0].evidence.len(), 2);
    assert_eq!(service(&c, "claude").stats["skillsSynced"], Some(2));
    assert!(duplicate[0].evidence.iter().all(|evidence| !evidence.path.as_ref().unwrap().contains("org-b_account-b")));
}

#[test]
fn a_plugin_with_the_same_suffix_keeps_its_plugin_identity() {
    let f = home_with_accounts();
    listing(&f, &["other-plugin:pptx", "anthropic-skills:pptx"]);
    let c = f.catalog();
    let a = service(&c, "claude");
    let plugin = a.session.listing.entries.iter().find(|entry| entry.name == "other-plugin:pptx").unwrap();
    assert_eq!(plugin.kind, "plugin");
    assert_eq!(plugin.plugin.as_deref(), Some("other-plugin"));
    assert_eq!(a.session.listing.plugin_counts["other-plugin"], 1);
}

#[test]
fn existing_closed_duplicate_records_are_preserved_and_do_not_close_the_shadow() {
    let f = home_with_accounts();
    skill_file(&f, "pptx", "pptx");
    let path = f.home().join(".mycmux/agent_design/closed.json");
    let closed = json!({"schemaVersion":1,"revision":4,"closed":(0..13).map(|n| json!({"id":format!("claude:duplicate:skill{n}"),"workFolder":f.home(),"reason":"Intentional synthetic closure","closedAt":"2026-10-09T12:00:00Z","closedFrom":"pc"})).collect::<Vec<_>>()}).to_string();
    write(f.home(), ".mycmux/agent_design/closed.json", &closed);
    let c = f.catalog();
    assert_eq!(c.closed_revision, 4);
    assert_eq!(c.closed_count, 13);
    assert_eq!(fs::read_to_string(path).unwrap(), closed);
    assert_eq!(findings(&c, "shadow").len(), 1);
}
