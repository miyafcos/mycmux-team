//! Benign native argv/environment recorder. No provider code or network.
use std::{env, fs, io::Write, path::PathBuf};
fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    let report_keys: Vec<_> = env::vars().filter(|(key, _)| {
        key.eq_ignore_ascii_case("MYCMUX_CODEX_RESTORE_REASON")
            || key.eq_ignore_ascii_case("MYCMUX_CODEX_RESTORE_GENERATION")
    }).collect();
    let path = env::var("RESTORE_FIXTURE_LOG").expect("synthetic log");
    let mut log = fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    writeln!(log, "{}", serde_json::json!({"args": args, "report_keys": report_keys})).unwrap();
    if env::var("RESTORE_FIXTURE_FAULT").as_deref() == Ok("report") {
        let home = env::var("HOME").unwrap();
        let pty = env::var("MYCMUX_PANE_SESSION_ID").unwrap();
        let path = PathBuf::from(home).join(".mycmux/pane-sessions").join(format!("{pty}.codex-restore.json"));
        let _ = fs::remove_file(&path);
        fs::create_dir_all(path).unwrap();
    }
    std::process::exit(env::var("RESTORE_FIXTURE_EXIT").ok().and_then(|v| v.parse().ok()).unwrap_or(0));
}
