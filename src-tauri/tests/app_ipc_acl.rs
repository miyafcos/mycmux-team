// Uses the pinned Tauri resolver with build-generated policy. Also runnable
// offline via rustc against cached rlibs when the sandbox cannot build Cargo.
use std::collections::{BTreeMap, BTreeSet};
use tauri::ipc::{Origin, RuntimeAuthority};
use tauri::utils::acl::{capability::Capability, manifest::Manifest, resolved::Resolved};
use tauri::utils::platform::Target;

const REPLIES: &[&str] = &[
    "webpane_read_result", "webpane_push_result", "webpane_eval_result",
    "webpane_forward_shortcut",
];
const REMOTE_URLS: &[&str] = &[
    "https://example.test/", "https://example.test:8443/path?query=redacted#fragment", "https://chatgpt.com/dots", "https://gemini.google.com/app",
    "https://grok.com/", "https://claude.ai/", "https://notebooklm.google.com/",
    "http://localhost:3000/", "http://127.0.0.1:8080/", "http://[::1]:3000/",
    "http://asset.localhost/report.html", "https://asset.localhost/report.html",
    "asset://localhost/report.html", "asset://localhost", "about:blank",
];

// This constant is produced by Rust's own macro parser/stringify in the
// application, independently of build.rs and its restricted lexer.
use mycmux_lib::REGISTERED_APP_COMMAND_PATHS;

fn registered_commands() -> Vec<&'static str> {
    REGISTERED_APP_COMMAND_PATHS.iter()
        .map(|path| path.rsplit("::").next().unwrap().trim()).collect()
}

fn policy(target: Target) -> RuntimeAuthority {
    let manifests: BTreeMap<String, Manifest> =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    let capabilities: BTreeMap<String, Capability> =
        serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
    let resolved = Resolved::resolve(&manifests, capabilities, target).unwrap();
    // Tauri skips its app-command rejection entirely when this is false.
    assert!(resolved.has_app_acl, "C59-01: app IPC bypasses ACL without an app manifest");
    tauri::runtime_authority!(manifests, resolved)
}

#[test]
fn external_privileged_commands_are_denied_by_generated_acl() {
    let representatives = [
        "create_session", "write_to_session", "write_to_session_guarded",
        "save_editable_artifact", "save_persistent_data", "save_jev_settings",
        "open_path_with_default_app", "webpane_signin", "begin_cli_login",
        "open_child_window", "open_workspace_window", "quit_app", "socket_response",
        "claude_skills_install", "codex_app_server_start", "dsh_acp_start",
        "plugin:updater|check", "plugin:process|restart", "plugin:event|emit",
    ];
    for target in [Target::Windows, Target::MacOS, Target::Linux] {
        let authority = policy(target);
        for url in REMOTE_URLS {
            let origin = Origin::Remote { url: url.parse().unwrap() };
            for window in ["main", "mycmux-w1", "mycmux-w23"] {
                for command in representatives {
                    assert!(authority.resolve_access(command, window, "web-pane-test", &origin).is_none(),
                        "{target}: {command} allowed from {url} in {window}");
                }
                // Cover every registered app command, not just the examples.
                for command in registered_commands().into_iter().filter(|c| !REPLIES.contains(c)) {
                    assert!(authority.resolve_access(command, window, "web-pane-test", &origin).is_none(),
                        "{target}: {command} allowed from {url}");
                }
            }
        }
    }
}

#[test]
fn all_registered_commands_are_allowed_on_local_primary_webviews() {
    let registered = registered_commands();
    assert!(!registered.is_empty());
    assert_eq!(registered.len(), registered.iter().collect::<BTreeSet<_>>().len());
    for target in [Target::Windows, Target::MacOS, Target::Linux] {
        let authority = policy(target);
        for label in ["main", "mycmux-w1", "mycmux-w23"] {
            for command in &registered {
                assert!(authority.resolve_access(command, label, label, &Origin::Local).is_some(),
                    "{target}: local {label} missing {command}");
            }
        }
    }
}

#[test]
fn children_have_only_reply_permissions_even_at_local_app_urls() {
    for target in [Target::Windows, Target::MacOS, Target::Linux] {
        let authority = policy(target);
        for window in ["main", "mycmux-w1"] {
            for command in registered_commands() {
                assert_eq!(authority.resolve_access(command, window, "web-pane-test", &Origin::Local).is_some(),
                    REPLIES.contains(&command), "{target}: local child {command}");
            }
            assert!(authority.resolve_access("plugin:event|emit", window, "web-pane-test", &Origin::Local).is_none());
        }
    }
}

#[test]
fn reply_permissions_cover_presets_blank_and_asset_but_require_child_labels() {
    for target in [Target::Windows, Target::MacOS, Target::Linux] {
        let authority = policy(target);
        for url in REMOTE_URLS {
            let origin = Origin::Remote { url: url.parse().unwrap() };
            for command in REPLIES {
                assert!(authority.resolve_access(command, "main", "web-pane-test", &origin).is_some(),
                    "{target}: reply {command} missing for {url}");
                for label in ["main", "mycmux-w1", "popup-1", "unrelated"] {
                    assert!(authority.resolve_access(command, "main", label, &origin).is_none(),
                        "{target}: {label} acquired {command} for {url}");
                }
            }
        }
    }
}

#[test]
fn external_primary_documents_do_not_receive_local_privileges() {
    let authority = policy(Target::Windows);
    for url in REMOTE_URLS {
        let origin = Origin::Remote { url: url.parse().unwrap() };
        for label in ["main", "mycmux-w1"] {
            for command in registered_commands() {
                assert!(authority.resolve_access(command, label, label, &origin).is_none(),
                    "external primary {label} acquired {command} for {url}");
            }
        }
    }
}
