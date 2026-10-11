use super::*;
use std::collections::BTreeSet;

fn bare_collision(command: bool, current: bool) {
    for mode in ["on", "off"] {
        let f = home_with_accounts();
        if command {
            write(f.home(), ".claude/commands/help.md", "# Synthetic command\n");
        }
        let folder = if current { "org-a_account-a" } else { "org-b_account-b" };
        skill_file(&f, &format!("synced/{folder}/help"), "help");
        listing(&f, &["help", "anthropic-skills:help"]);
        write(f.home(), ".claude/settings.json", &json!({"skillOverrides":{"help":mode}}).to_string());
        let c = f.catalog();
        let a = service(&c, "claude");
        let bare = a.session.listing.entries.iter().find(|entry| entry.name == "help");
        assert_eq!(bare.is_some(), mode == "on", "current={current}, command={command}, mode={mode}");
        if let Some(bare) = bare {
            assert_eq!(bare.kind, if command { "command" } else { "builtin" });
            assert_eq!(bare.plugin, None);
        }
        assert_eq!(a.session.listing.count, Some(u64::from(current) + u64::from(mode == "on")));
        assert_eq!(a.session.listing.entries.iter().any(|entry| entry.name == "anthropic-skills:help"), current);
        assert_eq!(findings(&c, "unusedListing").iter().any(|finding| finding.names.contains(&"help".into())), mode == "on");
    }
}

#[test]
fn bare_command_keeps_identity_with_current_synced_collision_and_exact_off() {
    bare_collision(true, true);
}
#[test]
fn bare_command_keeps_identity_with_foreign_synced_collision_and_exact_off() {
    bare_collision(true, false);
}
#[test]
fn bare_builtin_keeps_identity_with_current_synced_collision_and_exact_off() {
    bare_collision(false, true);
}
#[test]
fn bare_builtin_keeps_identity_with_foreign_synced_collision_and_exact_off() {
    bare_collision(false, false);
}

#[test]
fn bare_off_cannot_be_bypassed_by_a_current_namespaced_copy() {
    for command in [false, true] {
        let f = home_with_accounts();
        if command {
            write(f.home(), ".claude/commands/help.md", "# Synthetic command\n");
        }
        skill_file(&f, "synced/org-a_account-a/help", "help");
        listing(&f, &["help", "anthropic-skills:help"]);
        write(f.home(), ".claude/settings.json", r#"{"skillOverrides":{"help":"off"}}"#);
        let c = f.catalog();
        assert_eq!(service(&c, "claude").session.listing.count, Some(1));
        assert!(service(&c, "claude").session.listing.entries.iter().all(|entry| entry.name == "anthropic-skills:help"));
        assert!(findings(&c, "unusedListing").iter().all(|finding| !finding.names.contains(&"help".into())));
    }
}

#[test]
fn account_lookup_uses_filesystem_casing_without_folding_case_sensitive_volumes() {
    let f = Fixture::new("empty");
    let organization = "abcdef01-2345-6789-abcd-ef0123456789";
    let account = "fedcba98-7654-3210-fedc-ba9876543210";
    let selected = format!("{organization}_{account}");
    skill_file(&f, &format!("synced/{}/pptx", selected.to_ascii_uppercase()), "pptx");
    write(f.home(), ".claude/settings.json", "{}");
    write(f.home(), ".claude.json", &json!({"oauthAccount":{"organizationUuid":organization,"accountUuid":account},"skillUsage":{}}).to_string());
    listing(&f, &["anthropic-skills:pptx"]);
    let insensitive = f.home().join(format!(".claude/skills/synced/{selected}")).is_dir();
    eprintln!("account lookup case-insensitive volume: {insensitive}");
    let c = f.catalog();
    let a = service(&c, "claude");
    assert_eq!(skills(&c).len(), 1, "the resolved account must not also appear as a foreign copy");
    assert_eq!(a.stats["skillsSynced"], insensitive.then_some(1));
    assert_eq!(skills(&c).iter().filter(|item| item.active).count(), usize::from(insensitive));
    assert_eq!(a.session.listing.count, insensitive.then_some(1));
    if insensitive {
        assert_eq!(field(skills(&c)[0], "syncedAccount"), Some("current"));
    }
}

#[test]
fn similar_account_components_do_not_become_current() {
    let f = home_with_accounts();
    skill_file(&f, "synced/org-a_account-a-extra/only-extra", "only-extra");
    listing(&f, &["anthropic-skills:pptx", "anthropic-skills:only-extra"]);
    let c = f.catalog();
    assert_eq!(service(&c, "claude").stats["skillsSynced"], Some(1));
    assert_eq!(service(&c, "claude").session.listing.count, Some(1));
    assert!(skills(&c).iter().filter(|item| field(item, "name") == Some("only-extra")).all(|item| !item.active));
}

#[cfg(unix)]
#[test]
fn selected_account_symlink_is_not_traversed_or_counted_as_empty() {
    let f = home_with_accounts();
    let selected = f.home().join(".claude/skills/synced/org-a_account-a");
    fs::rename(&selected, f.home().join("synthetic-account")).unwrap();
    std::os::unix::fs::symlink(f.home().join("synthetic-account"), &selected).unwrap();
    let c = f.catalog();
    assert_eq!(service(&c, "claude").stats["skillsSynced"], None);
    assert_eq!(service(&c, "claude").session.listing.count, None);
    assert!(skills(&c).iter().all(|item| !item.active));
}

fn unreadable_current(foreign: bool) {
    for oversized in [false, true] {
        let f = home_with_accounts();
        let selected = f.home().join(".claude/skills/synced/org-a_account-a/pptx/SKILL.md");
        if oversized {
            fs::write(&selected, vec![b'x'; safe::DOCUMENT_LIMIT as usize + 1]).unwrap();
        } else {
            fs::write(&selected, [0xff, 0xfe, 0xff]).unwrap();
        }
        if !foreign {
            fs::remove_file(f.home().join(".claude/skills/synced/org-b_account-b/pptx/SKILL.md")).unwrap();
        }
        listing(&f, &["anthropic-skills:pptx"]);
        let c = f.catalog();
        let a = service(&c, "claude");
        assert_eq!(a.stats["skillsSynced"], None);
        assert_eq!(a.session.listing.count, None, "foreign={foreign}, oversized={oversized}");
        assert_eq!(a.context.listing, None);
        assert_eq!(serde_json::to_value(&a.session.listing).unwrap()["unknownNames"], json!(["anthropic-skills:pptx"]));
        assert!(findings(&c, "unusedListing").is_empty());
    }
}
#[test]
fn unreadable_current_identity_without_foreign_copy_is_unknown() {
    unreadable_current(false);
}
#[test]
fn unreadable_current_identity_with_readable_foreign_copy_is_unknown() {
    unreadable_current(true);
}

fn attachment(f: &Fixture, attachment: Value) {
    let row = format!("{{\"timestamp\":\"2026-10-09T12:00:00Z\",\"type\":\"attachment\",\"attachment\":{attachment}}}\n");
    write(f.home(), &format!(".claude/projects/{}/initial.jsonl", safe::project_key(f.home())), &row);
}

#[test]
fn unsupported_listing_spans_never_yield_precise_projected_totals() {
    for mode in ["on", "off", "name-only"] {
        let f = home_with_accounts();
        skill_file(&f, "pptx", "pptx");
        write(f.home(), ".claude/settings.json", &json!({"skillOverrides":{"pptx":mode}}).to_string());
        attachment(&f, json!({"type":"skill_listing","isInitial":true,"skillCount":1,"names":["pptx"],"content":"- pptx\n"}));
        let c = f.catalog();
        let a = service(&c, "claude");
        assert_eq!(a.session.listing.count, None, "mode={mode}");
        assert_eq!(a.context.listing, None);
        assert_eq!(serde_json::to_value(&a.session.listing).unwrap()["textComplete"], false);
        assert!(findings(&c, "unusedListing").iter().all(|finding| finding.chars.is_none()));
    }
}

#[test]
fn missing_partial_or_inconsistent_listing_names_make_totals_unknown() {
    for (names, count) in [
        (Value::Null, json!(1)),
        (json!([]), json!(1)),
        (json!(["pptx"]), json!(2)),
        (json!(["pptx", null]), json!(2)),
        (json!(["pptx", "pptx"]), json!(2)),
        (json!(["pptx"]), Value::Null),
    ] {
        let f = home_with_accounts();
        skill_file(&f, "pptx", "pptx");
        attachment(&f, json!({"type":"skill_listing","isInitial":true,"skillCount":count,"names":names,"content":"- pptx: Synthetic procedure\n"}));
        let c = f.catalog();
        let a = service(&c, "claude");
        assert_eq!(a.session.listing.count, None, "names={names}, count={count}");
        assert_eq!(a.context.listing, None);
        assert_eq!(serde_json::to_value(&a.session.listing).unwrap()["textComplete"], false);
        assert!(findings(&c, "unusedListing").iter().all(|finding| finding.chars.is_none()));
        assert_eq!(a.session.listing.entries.iter().map(|entry| &entry.name).collect::<BTreeSet<_>>().len(), a.session.listing.entries.len());
        assert_eq!(a.session.listing.groups.iter().map(|group| group.count).sum::<u64>(), a.session.listing.entries.len() as u64);
        for finding in findings(&c, "unusedListing") {
            assert_eq!(finding.names.iter().collect::<BTreeSet<_>>().len(), finding.names.len());
            assert_eq!(finding.count, finding.names.len() as u64);
        }
        if names == json!(["pptx", "pptx"]) {
            assert_eq!(a.session.listing.entries.len(), 1);
            assert_eq!(a.session.listing.groups[0].count, 1);
            let unused = findings(&c, "unusedListing");
            assert_eq!(unused.len(), 1);
            assert_eq!(unused[0].names, ["pptx"]);
            assert_eq!(unused[0].count, 1);
        }
    }
}

#[test]
fn overlapping_listing_markers_cannot_hide_an_unparsed_row() {
    let f = home_with_accounts();
    skill_file(&f, "pptx", "pptx");
    write(f.home(), ".claude/settings.json", r#"{"skillOverrides":{"pptx":"off"}}"#);
    attachment(&f, json!({"type":"skill_listing","isInitial":true,"skillCount":2,"names":["pptx","pptx:tool"],"content":"- pptx:tool: Synthetic procedure\n- unaccounted: Unparsed row\n"}));
    let c = f.catalog();
    let a = service(&c, "claude");
    assert_eq!(a.session.listing.count, None);
    assert_eq!(a.context.listing, None);
    assert_eq!(serde_json::to_value(&a.session.listing).unwrap()["textComplete"], false);
    assert!(findings(&c, "unusedListing").iter().all(|finding| finding.chars.is_none()));
}

#[test]
fn projected_listing_marks_aggregate_and_flow_estimated_and_preserves_provenance() {
    let f = home_with_accounts();
    write(f.home(), ".claude/settings.json", r#"{"skillOverrides":{"anthropic-skills:pptx":"name-only"}}"#);
    attachment(&f, json!({"type":"skill_listing","isInitial":true,"skillCount":1,"names":["anthropic-skills:pptx"],"content":"- anthropic-skills:pptx: Synthetic procedure\n"}));
    let c = f.catalog();
    let a = service(&c, "claude");
    assert_eq!(a.session.file.as_deref(), Some("initial.jsonl"));
    assert_eq!(a.session.started_at.as_deref(), Some("2026-10-09T12:00:00+00:00"));
    assert_eq!(serde_json::to_value(&a.session.listing).unwrap()["evidence"], "estimated");
    assert_eq!(c.items.iter().find(|item| item.id == "claude:skillListing").unwrap().evidence, "estimated");
    let flow = c.reading_flows.iter().find(|flow| flow.service == "claude").unwrap();
    assert_eq!(flow.steps.iter().find(|step| step.id == "listing").unwrap().evidence, "estimated");
}

#[test]
fn generated_shadow_exports_with_the_japanese_overlap_label() {
    let f = home_with_accounts();
    skill_file(&f, "pptx", "pptx");
    listing(&f, &["pptx", "anthropic-skills:pptx"]);
    let c = f.catalog();
    assert_eq!(findings(&c, "shadow").len(), 1);
    let options = export_book::ExportOptions { services: vec!["claude".into()], layers: vec![5], documents: vec![] };
    let preview = export_book::prepare(&c, &options, &[], &[]).unwrap();
    assert!(preview.html.contains("同じ名前の自作と同期が両方載っている: 1 件"));
    assert!(!preview.html.contains("未対応: 1 件"));
    assert!(preview.html.contains("~/.claude/skills/pptx/SKILL.md"));
    assert!(preview.html.contains("~/.claude/skills/synced/org-a_account-a/pptx/SKILL.md"));
}

#[test]
fn valid_prefix_identities_keep_precise_totals_in_both_orders_and_all_policies() {
    let own = "- pptx: Own description 日本語\n";
    let plugin = "- pptx:tool: Plugin description 日本語\n";
    let overhead = "Available skills:\n";
    for rows in [[own, plugin], [plugin, own]] {
        for mode in ["on", "off", "name-only"] {
            let f = home_with_accounts();
            skill_file(&f, "pptx", "pptx");
            write(f.home(), ".claude/settings.json", &json!({"skillOverrides":{"pptx":mode}}).to_string());
            let content = format!("{overhead}{}{}", rows[0], rows[1]);
            attachment(&f, json!({"type":"skill_listing","isInitial":true,"skillCount":2,"names":["pptx","pptx:tool"],"content":content}));
            let c = f.catalog();
            let a = service(&c, "claude");
            let own_chars = match mode { "on" => own.chars().count(), "name-only" => "pptx".chars().count(), _ => 0 } as u64;
            let expected = (overhead.chars().count() + plugin.chars().count()) as u64 + own_chars;
            assert_eq!(a.session.listing.count, Some(if mode == "off" { 1 } else { 2 }), "rows={rows:?}, mode={mode}");
            assert_eq!(a.context.listing, Some(expected));
            assert_eq!(serde_json::to_value(&a.session.listing).unwrap()["textComplete"], true);
            assert_eq!(a.session.listing.entries.iter().find(|entry| entry.name == "pptx:tool").unwrap().chars, plugin.chars().count() as u64);
            assert_eq!(a.session.listing.entries.iter().find(|entry| entry.name == "pptx").map(|entry| entry.chars), (mode != "off").then_some(own_chars));
            let unused = findings(&c, "unusedListing");
            assert_eq!(unused.len(), 1);
            assert_eq!(unused[0].count, if mode == "off" { 1 } else { 2 });
            assert_eq!(unused[0].chars, Some(plugin.chars().count() as u64 + own_chars));
        }
    }
}

fn skill_membership(value: &Value, id: &str) -> Value {
    value["skills"].as_array().unwrap().iter().find(|row| row["id"] == id)
        .unwrap_or_else(|| panic!("missing skill identity {id}"))["listedIn"]["claude"].clone()
}

#[test]
fn unreadable_synced_identity_preserves_known_membership_through_skills_adapter() {
    let f = home_with_accounts();
    skill_file(&f, "reviewer", "reviewer");
    skill_file(&f, "disabled", "disabled");
    fs::write(f.home().join(".claude/skills/synced/org-a_account-a/pptx/SKILL.md"), [0xff, 0xfe]).unwrap();
    write(f.home(), ".claude/settings.json", r#"{"skillOverrides":{"disabled":"off"}}"#);
    listing(&f, &["reviewer", "anthropic-skills:pptx", "disabled"]);
    let c = f.catalog();
    let a = service(&c, "claude");
    assert_eq!(a.session.listing.count, None);
    assert_eq!(a.context.listing, None);
    assert_eq!(a.session.listing.unknown_names, ["anthropic-skills:pptx"]);
    let shelf = skill_read::catalog(f.home(), &c);
    assert_eq!(skill_membership(&shelf, "reviewer"), true);
    assert_eq!(skill_membership(&shelf, "disabled"), false);
    assert_eq!(skill_membership(&shelf, "anthropic-skills:pptx"), Value::Null);
}

fn mixed_case_membership_home(own: &str, synced: &str) -> Fixture {
    let f = Fixture::new("empty");
    write(f.home(), ".claude.json", r#"{"oauthAccount":{"organizationUuid":"org-a","accountUuid":"account-a"},"skillUsage":{}}"#);
    skill_file(&f, own, own);
    skill_file(&f, "disabled", "disabled");
    let folder = format!("synced/org-a_account-a/{synced}");
    skill_file(&f, &folder, synced);
    fs::write(f.home().join(format!(".claude/skills/{folder}/SKILL.md")), [0xff, 0xfe]).unwrap();
    write(f.home(), ".claude/settings.json", r#"{"skillOverrides":{"disabled":"off"}}"#);
    attachment(&f, json!({"type":"skill_listing","isInitial":true,"skillCount":3,
        "names":[own,format!("anthropic-skills:{synced}"),"disabled"],
        "content":format!("- {own}: Own procedure\n- anthropic-skills:{synced}: Synced procedure\n- disabled: Disabled procedure\n")}));
    f
}

#[test]
fn mixed_case_primary_ids_keep_known_unknown_and_excluded_membership() {
    for (own, synced) in [("reviewer", "pptx"), ("Reviewer", "PPTX")] {
        let f = mixed_case_membership_home(own, synced);
        let c = f.catalog();
        let a = service(&c, "claude");
        let qualified = format!("anthropic-skills:{synced}");
        assert_eq!(a.session.listing.count, None);
        assert_eq!(a.session.listing.chars, None);
        assert_eq!(a.context.listing, None);
        assert_eq!(a.session.listing.names_complete, Some(true));
        assert_eq!(a.session.listing.unknown_names, [qualified.clone()]);
        let shelf = skill_read::catalog(f.home(), &c);
        // Explicit opt-in synthetic evidence for replaying the actual adapter
        // output through SkillDetail; ordinary Cargo runs write no artifacts.
        if let Some(directory) = std::env::var_os("MYCMUX_AGENT_DESIGN_R5_EVIDENCE_DIR") {
            let directory = PathBuf::from(directory);
            assert!(directory.is_absolute() && directory.is_dir());
            let filename = if own == "Reviewer" { "mixed-case.json" } else { "lowercase.json" };
            let output = fs::OpenOptions::new().write(true).create_new(true)
                .open(directory.join(filename)).unwrap();
            serde_json::to_writer(output, &json!({"listing":a.session.listing,"shelf":shelf})).unwrap();
        }
        assert_eq!(json!([skill_membership(&shelf, own), skill_membership(&shelf, &qualified), skill_membership(&shelf, "disabled")]),
            json!([true, null, false]), "own={own}, synced={synced}");
    }
}

#[test]
fn mixed_case_membership_preserves_display_names_namespaces_and_exact_override_keys() {
    let f = Fixture::new("empty");
    write(f.home(), ".claude.json", r#"{"oauthAccount":{"organizationUuid":"org-a","accountUuid":"account-a"},"skillUsage":{}}"#);
    for name in ["Reviewer", "PPTX", "Disabled"] { skill_file(&f, name, name); }
    skill_file(&f, "synced/org-a_account-a/PPTX", "PPTX");
    listing(&f, &["Reviewer", "PPTX", "anthropic-skills:PPTX", "Disabled"]);
    for (overrides, expected) in [
        (json!({"reviewer":"off","pptx":"off","anthropic-skills:pptx":"off","Disabled":"off"}), json!([true,true,true,false])),
        (json!({"Reviewer":"off","PPTX":"off","Disabled":"off"}), json!([false,false,true,false])),
        (json!({"anthropic-skills:PPTX":"off","Disabled":"off"}), json!([true,true,false,false])),
    ] {
        write(f.home(), ".claude/settings.json", &json!({"skillOverrides":overrides}).to_string());
        let c = f.catalog();
        let a = service(&c, "claude");
        assert_eq!(a.session.listing.count, Some(expected.as_array().unwrap().iter().filter(|v| **v == true).count() as u64));
        assert!(a.session.listing.chars.is_some());
        let shelf = skill_read::catalog(f.home(), &c);
        let ids: BTreeSet<_> = shelf["skills"].as_array().unwrap().iter().map(|row| row["id"].as_str().unwrap()).collect();
        let mut expected_ids = BTreeSet::from(["Reviewer", "PPTX", "Disabled"]);
        if expected[2] == true { expected_ids.insert("anthropic-skills:PPTX"); }
        assert_eq!(ids, expected_ids);
        assert_eq!(json!([skill_membership(&shelf,"Reviewer"),skill_membership(&shelf,"PPTX"),skill_membership(&shelf,"Disabled")]),
            json!([expected[0],expected[1],expected[3]]));
        if expected[2] == true {
            assert_eq!(skill_membership(&shelf,"anthropic-skills:PPTX"), true);
        } else {
            // Readable excluded synced skills keep the existing shelf absence.
            assert!(a.session.listing.entries.iter().all(|entry| entry.name != "anthropic-skills:PPTX"));
        }
    }
}

#[test]
fn mixed_case_known_inclusion_precedes_an_uncertain_alias() {
    let f = mixed_case_membership_home("Reviewer", "PPTX");
    write(f.home(), ".mycmux/skills/shelf.json", r#"{"aliases":{"anthropic-skills:PPTX":"Reviewer"}}"#);
    let c = f.catalog();
    let shelf = skill_read::catalog(f.home(), &c);
    let row = shelf["skills"].as_array().unwrap().iter().find(|row| row["id"] == "Reviewer").unwrap();
    assert_eq!(row["aliases"], json!(["anthropic-skills:PPTX"]));
    assert_eq!(skill_membership(&shelf, "Reviewer"), true);
    write(f.home(), ".claude/settings.json", r#"{"skillOverrides":{"Reviewer":"off","disabled":"off"}}"#);
    let c = f.catalog();
    let shelf = skill_read::catalog(f.home(), &c);
    assert_eq!(skill_membership(&shelf, "Reviewer"), Value::Null);
    assert_eq!(skill_membership(&shelf, "disabled"), false);
}

#[test]
fn mixed_case_legacy_listing_uses_the_existing_count_fallback() {
    let f = Fixture::new("empty");
    write(f.home(), ".claude/settings.json", r#"{"skillOverrides":{"disabled":"off"}}"#);
    skill_file(&f, "Reviewer", "Reviewer");
    skill_file(&f, "disabled", "disabled");
    listing(&f, &["Reviewer", "disabled"]);
    let c = f.catalog();
    let mut serialized = serde_json::to_value(&c).unwrap();
    for service in serialized["services"].as_array_mut().unwrap() {
        service["session"]["listing"].as_object_mut().unwrap().remove("namesComplete");
    }
    let mut legacy: Catalog = serde_json::from_value(serialized).unwrap();
    assert_eq!(service(&legacy,"claude").session.listing.names_complete, None);
    let shelf = skill_read::catalog(f.home(), &legacy);
    assert_eq!(skill_membership(&shelf, "Reviewer"), true);
    assert_eq!(skill_membership(&shelf, "disabled"), false);
    legacy.services.iter_mut().find(|s| s.id == "claude").unwrap().session.listing.count = None;
    let shelf = skill_read::catalog(f.home(), &legacy);
    assert_eq!(skill_membership(&shelf, "Reviewer"), Value::Null);
    assert_eq!(skill_membership(&shelf, "disabled"), Value::Null);
}

#[test]
fn complete_names_keep_membership_when_only_text_spans_are_unsupported() {
    let f = home_with_accounts();
    skill_file(&f, "reviewer", "reviewer");
    skill_file(&f, "disabled", "disabled");
    write(f.home(), ".claude/settings.json", r#"{"skillOverrides":{"disabled":"off"}}"#);
    attachment(&f, json!({"type":"skill_listing","isInitial":true,"skillCount":2,"names":["reviewer","disabled"],"content":"- reviewer\n- disabled\n"}));
    let c = f.catalog();
    assert_eq!(service(&c, "claude").context.listing, None);
    let shelf = skill_read::catalog(f.home(), &c);
    assert_eq!(skill_membership(&shelf, "reviewer"), true);
    assert_eq!(skill_membership(&shelf, "disabled"), false);
}

#[test]
fn incomplete_name_population_keeps_skills_membership_unknown() {
    let f = home_with_accounts();
    skill_file(&f, "reviewer", "reviewer");
    skill_file(&f, "disabled", "disabled");
    write(f.home(), ".claude/settings.json", r#"{"skillOverrides":{"disabled":"off"}}"#);
    attachment(&f, json!({"type":"skill_listing","isInitial":true,"skillCount":2,"names":["reviewer"],"content":"- reviewer: Synthetic procedure\n"}));
    let c = f.catalog();
    let shelf = skill_read::catalog(f.home(), &c);
    assert_eq!(skill_membership(&shelf, "reviewer"), Value::Null);
    assert_eq!(skill_membership(&shelf, "disabled"), Value::Null);
}

#[test]
fn projected_export_provenance_calls_the_listing_an_estimate() {
    let f = home_with_accounts();
    write(f.home(), ".claude/settings.json", r#"{"skillOverrides":{"anthropic-skills:pptx":"name-only"}}"#);
    attachment(&f, json!({"type":"skill_listing","isInitial":true,"skillCount":1,"names":["anthropic-skills:pptx"],"content":"- anthropic-skills:pptx: Synthetic procedure\n"}));
    let c = f.catalog();
    let options = export_book::ExportOptions { services: vec!["claude".into()], layers: vec![5], documents: vec![] };
    let preview = export_book::prepare(&c, &options, &[], &[]).unwrap();
    assert!(preview.html.contains("今の設定を当てた推定"));
    assert!(preview.html.contains("2026-10-09T12:00:00+00:00"));
    assert!(!preview.html.contains("この会話の初期記録だけを確認しています"));
}
