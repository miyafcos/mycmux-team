// A separate main-thread Tauri host, never the production entry point/plugins.
#[cfg(feature = "e2e")]
fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(args.len(), 3, "usage: codex_restore_orchestration SYNTHETIC_HOME FIXTURE_BINARY");
    let home = std::path::PathBuf::from(&args[1]);
    assert!(home.is_absolute() && home.join("restore-fixture-home").is_file());
    std::env::set_var("MYCMUX_E2E_HOME", &home);
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    for (key, leaf) in [("CODEX_HOME", ".codex"), ("GROK_HOME", ".grok"), ("CLAUDE_CONFIG_DIR", ".claude"),
                        ("APPDATA", "appdata"), ("LOCALAPPDATA", "localappdata")] {
        std::env::set_var(key, home.join(leaf));
    }
    std::env::set_var("XDG_CONFIG_HOME", home.join("config"));
    std::env::set_var("XDG_DATA_HOME", home.join("data"));
    #[cfg(unix)]
    std::env::set_var("SHELL", "/bin/true");
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "com.mycmux.restore-fixture".into();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default().build(context).expect("synthetic Tauri host");
    let failures = mycmux_lib::run_codex_restore_orchestration(app.handle().clone(), &home, &args[2]);
    std::process::exit(if failures == 0 { 0 } else { 1 });
}

#[cfg(not(feature = "e2e"))]
fn main() { panic!("this fixture requires --features e2e"); }
