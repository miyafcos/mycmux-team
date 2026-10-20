//! e2e-only tests call the real private create adapter and native PTY.
use super::*;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Listener;

const A: &str = "aaaaaaaa-1111-4222-8333-444444444444";
const MISSING: &str = "bbbbbbbb-1111-4222-8333-444444444444";
const TAB: &str = "dddddddd-1111-4222-8333-444444444444";
type Launch = (String, Vec<String>, HashMap<String, String>);
static LAUNCHES: OnceLock<Mutex<HashMap<String, Launch>>> = OnceLock::new();
struct Pause { pty: String, generation: Mutex<Option<String>>, ready: Condvar, released: Mutex<bool>, release: Condvar }
static PAUSE: OnceLock<Mutex<Option<Arc<Pause>>>> = OnceLock::new();
struct PublicationPause { pty: String, first: &'static str, second: &'static str, reached: Mutex<(bool, bool)>, ready: Condvar, released: Mutex<bool>, release: Condvar }
static PUBLICATION_PAUSE: OnceLock<Mutex<Option<Arc<PublicationPause>>>> = OnceLock::new();
pub(crate) fn retirement_checkpoint(pty: &str) { publication_checkpoint(pty, "retire-destroy"); }
pub(super) fn publication_checkpoint(pty: &str, phase: &str) {
    let pause = PUBLICATION_PAUSE.get_or_init(Default::default).lock().unwrap().clone();
    if let Some(p) = pause.filter(|p| p.pty == pty) {
        if phase == p.second { p.reached.lock().unwrap().1 = true; p.ready.notify_all(); }
        if phase == p.first {
            p.reached.lock().unwrap().0 = true; p.ready.notify_all();
            let (released, timeout) = p.release.wait_timeout_while(p.released.lock().unwrap(), Duration::from_secs(15), |r| !*r).unwrap();
            assert!(*released && !timeout.timed_out(), "controlled publication must be released");
        }
    }
}

pub(super) fn capture_launch(pty: &str, command: &str, args: &[String], env: &HashMap<String, String>) {
    LAUNCHES.get_or_init(Default::default).lock().unwrap().insert(pty.into(), (command.into(), args.into(), env.clone()));
}
pub(super) fn after_native_create(pty: &str, generation: Option<&str>) {
    let pause = PAUSE.get_or_init(Default::default).lock().unwrap().clone();
    if let Some(pause) = pause.filter(|p| p.pty == pty && generation.is_some()) {
        *pause.generation.lock().unwrap() = generation.map(str::to_string);
        pause.ready.notify_all();
        let released = pause.released.lock().unwrap();
        let (released, timeout) = pause.release.wait_timeout_while(released, Duration::from_secs(15), |r| !*r).unwrap();
        assert!(*released && !timeout.timed_out(), "controlled caller must release native creation pause");
    }
}

fn launch(app: &AppHandle, pty: &str, command: &str, args: Vec<String>, env: HashMap<String, String>, output: Arc<Mutex<Vec<u8>>>) {
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Raw(bytes) = body { output.lock().unwrap().extend(bytes); }
        Ok(())
    });
    let attachment_window = crate::tearout::attachment_epoch::e2e_window_proof();
    let context_window = attachment_window.clone();
    create_session_blocking(app.clone(), app.state(), pty.into(), command.into(), args, 80, 24,
        channel, Some(std::env::var("HOME").unwrap()), Some(env), true, "restore-regression".into(), true, None,
        |existing| crate::tearout::attachment_epoch::issue_e2e_context(pty, &context_window, existing),
        attachment_window).unwrap();
}
fn wait_for(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !condition() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(30)); }
    assert!(condition(), "native fixture timed out");
}
fn env(log: &Path, id: &str) -> HashMap<String, String> {
    HashMap::from([
        ("MYCMUX_RESUME".into(), "codex".into()), ("MYCMUX_SESSION_ID".into(), id.into()),
        ("MYCMUX_TAB_ID".into(), TAB.into()), ("RESTORE_FIXTURE_LOG".into(), log.to_string_lossy().into()),
        ("PATH".into(), std::env::var("PATH").unwrap()),
    ])
}
fn records(path: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}
fn check_case(app: &AppHandle, home: &Path, command: &str, interpreter: bool, label: &str, mode: &str, aliases: &[(&str, &str)]) {
    let pty = format!("r10-{label}-{mode}");
    let log = home.join(format!("{pty}.jsonl"));
    let report = home.join(".mycmux/pane-sessions").join(format!("{pty}.codex-restore.json"));
    let id = if mode == "missing" { MISSING } else { A };
    let mut env = env(&log, id);
    for (key, value) in aliases { env.insert((*key).into(), (*value).into()); }
    if mode == "exit7" { env.insert("RESTORE_FIXTURE_EXIT".into(), "7".into()); }
    if mode == "report-fault" { env.insert("RESTORE_FIXTURE_FAULT".into(), "report".into()); }
    let mut args = if interpreter { vec!["/synthetic/codex.js".into()] } else { vec![] };
    args.extend(["resume".into(), "--no-alt-screen".into(), id.into()]);
    let output = Arc::new(Mutex::new(Vec::new()));
    launch(app, &pty, command, args, env, output.clone());
    let result = std::panic::catch_unwind(|| {
        let (spawn_command, _, spawn_env) = LAUNCHES.get().unwrap().lock().unwrap().get(&pty).unwrap().clone();
        assert_eq!(spawn_command, if cfg!(windows) { "powershell.exe" } else { "/bin/bash" }, "R10-2: real create_session_blocking must select the bounded helper for every enrolled executable");
        wait_for(|| !records(&log).is_empty());
        if mode == "report-fault" { wait_for(|| String::from_utf8_lossy(&output.lock().unwrap()).contains("Codex restore outcome could not be recorded")); }
        else { wait_for(|| report.is_file()); }
        // Allow any erroneous replay and report delivery to happen before assertions.
        std::thread::sleep(Duration::from_millis(350));
        let reserved: Vec<_> = spawn_env.keys().filter(|key| key.eq_ignore_ascii_case("MYCMUX_CODEX_RESTORE_REASON") || key.eq_ignore_ascii_case("MYCMUX_CODEX_RESTORE_GENERATION")).collect();
        assert!(reserved.iter().all(|key| matches!(key.as_str(), "MYCMUX_CODEX_RESTORE_REASON" | "MYCMUX_CODEX_RESTORE_GENERATION")), "R10-1: only backend report keys survive launch construction: {reserved:?}");
        assert_eq!(spawn_env["MYCMUX_CODEX_RESTORE_GENERATION"].len(), 36);
        assert_ne!(spawn_env["MYCMUX_CODEX_RESTORE_GENERATION"], MISSING, "backend generation must replace aliases");
        assert_eq!(spawn_env.get("MYCMUX_CODEX_RESTORE_REASON").map(String::as_str), (mode == "missing").then_some("validation-failed"));
        let calls = records(&log);
        assert_eq!(calls.len(), 1, "bounded invocation/fresh count: {calls:?}");
        let expected: Vec<&str> = if mode == "missing" { vec!["--no-alt-screen"] } else { vec!["resume", "--no-alt-screen", A] };
        let actual: Vec<_> = calls[0]["args"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        let expected = if interpreter { std::iter::once("/synthetic/codex.js").chain(expected).collect::<Vec<_>>() } else { expected };
        assert_eq!(actual, expected, "R10-2: actual caller must preserve exact A or fresh interpreter prefix");
        assert_eq!(calls[0]["report_keys"], serde_json::json!([]), "helper must remove report values before invoking CLI");
        let text = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
        let notices = text.matches("Previous conversation could not be restored").count() + text.matches("Codex restore outcome could not be recorded").count();
        assert_eq!(notices, usize::from(matches!(mode, "missing" | "report-fault")), "one explanation for downgrade/report failure");
        if mode != "report-fault" {
            let report: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&report).unwrap()).unwrap();
            assert_eq!(report["outcome"], match mode { "missing" => "fresh-completed", "exit7" => "exited", _ => "completed" });
            assert_eq!(report["generation"], spawn_env["MYCMUX_CODEX_RESTORE_GENERATION"]);
        }
    });
    let _ = app.state::<AppState>().session_manager.kill(&pty);
    if let Err(error) = result { std::panic::resume_unwind(error); }
}

fn replacement_race(app: &AppHandle, home: &Path, command: &str) {
    let pty = "r10-replacement";
    let pause = Arc::new(Pause { pty: pty.into(), generation: Mutex::new(None), ready: Condvar::new(), released: Mutex::new(false), release: Condvar::new() });
    *PAUSE.get_or_init(Default::default).lock().unwrap() = Some(pause.clone());
    let notices = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let received = notices.clone();
    let listener = app.listen("codex-restore-notice", move |event| {
        received.lock().unwrap().push(serde_json::from_str(event.payload()).unwrap());
    });
    let worker_app = app.clone(); let command = command.to_string(); let log = home.join("r10-replacement.jsonl");
    let worker = std::thread::spawn(move || launch(&worker_app, pty, &command, vec!["resume".into(), A.into()], env(&log, A), Arc::new(Mutex::new(Vec::new()))));
    let generation = pause.generation.lock().unwrap();
    let (generation, timeout) = pause.ready.wait_timeout_while(generation, Duration::from_secs(8), |g| g.is_none()).unwrap();
    assert!(!timeout.timed_out(), "first caller reached native creation before registration");
    let generation = generation.clone().unwrap();
    let state = app.state::<AppState>();
    let old_epoch = state.session_manager.session_observation(pty).unwrap().0;
    state.session_manager.kill(pty).unwrap();
    #[cfg(unix)]
    let (shell, args) = ("/bin/bash", vec!["--noprofile".into(), "--norc".into(), "-c".into(), "sleep 10".into()]);
    #[cfg(windows)]
    let (shell, args) = ("powershell.exe", vec!["-NoProfile".into(), "-Command".into(), "Start-Sleep 10".into()]);
    launch(app, pty, shell, args, HashMap::from([("PATH".into(), std::env::var("PATH").unwrap())]), Arc::new(Mutex::new(Vec::new())));
    let new_epoch = state.session_manager.session_observation(pty).unwrap().0;
    assert_ne!(old_epoch, new_epoch);
    let report = home.join(".mycmux/pane-sessions/r10-replacement.codex-restore.json");
    std::fs::write(report, serde_json::json!({"generation": generation, "tab_id": TAB, "outcome": "downgrade", "reason": "missing-id"}).to_string()).unwrap();
    *pause.released.lock().unwrap() = true; pause.release.notify_all();
    worker.join().unwrap();
    std::thread::sleep(Duration::from_millis(800));
    *PAUSE.get().unwrap().lock().unwrap() = None;
    let _ = state.session_manager.kill(pty);
    app.unlisten(listener);
    assert!(notices.lock().unwrap().is_empty(), "R10-3: old caller/report must not notify replacement instance: {:?}", notices.lock().unwrap());
}

fn lifecycle_publication(app: &AppHandle, home: &Path) {
    let pty = "r11-same-pty";
    #[cfg(unix)]
    let (shell, args) = ("/bin/bash", vec!["--noprofile".into(), "--norc".into(), "-c".into(), "sleep 10".into()]);
    #[cfg(windows)]
    let (shell, args) = ("powershell.exe", vec!["-NoProfile".into(), "-Command".into(), "Start-Sleep 10".into()]);
    let launch_shell = || launch(app, pty, shell, args.clone(), env(&home.join("r11-unused.jsonl"), A)
        .into_iter().filter(|(key, _)| !matches!(key.as_str(), "MYCMUX_RESUME" | "MYCMUX_SESSION_ID")).collect(), Arc::new(Mutex::new(Vec::new())));
    launch_shell();
    // The real native query reads E1. Hold that reply while another caller replaces P/T.
    let e1 = tauri::async_runtime::block_on(get_codex_restore_epoch(app.state(), pty.into())).unwrap();
    let publication = Arc::new(Mutex::new(Vec::new())); let events = publication.clone(); let manager = app.state::<AppState>().session_manager.clone();
    let listener = app.listen("codex-restore-invalidated", move |event| {
        let value: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
        if value["session_id"] == pty { events.lock().unwrap().push(manager.session_observation(pty).map(|v| v.0)); }
    });
    app.state::<AppState>().session_manager.kill(pty).unwrap();
    launch_shell();
    let e2 = tauri::async_runtime::block_on(get_codex_restore_epoch(app.state(), pty.into())).unwrap();
    app.unlisten(listener); app.state::<AppState>().session_manager.kill(pty).unwrap();
    assert_ne!(e1, e2);
    assert_eq!(*publication.lock().unwrap(), vec![None], "R11-2: invalidate every window before E2 is published; unchanged P/T cannot preserve delivery revision");
    println!("R11-2 held native E1={e1:?}; replacement E2={e2:?}; invalidation before publication");
}

fn publication_overlap(app: &AppHandle, home: &Path, create_first: bool) {
    let pty = if create_first { "r12-create-first" } else { "r12-kill-first" };
    let start = |app: &AppHandle| {
        #[cfg(unix)]
        let (command, args) = ("/bin/bash", vec!["--noprofile".into(), "--norc".into(), "-c".into(), "sleep 10".into()]);
        #[cfg(windows)]
        let (command, args) = ("powershell.exe", vec!["-NoProfile".into(), "-Command".into(), "Start-Sleep 10".into()]);
        launch(app, pty, command, args, HashMap::from([("MYCMUX_TAB_ID".into(), TAB.into())]), Arc::new(Mutex::new(Vec::new())));
    };
    start(app);
    let old_epoch = app.state::<AppState>().session_manager.session_observation(pty).unwrap().0;
    if create_first { tauri::async_runtime::block_on(kill_session(app.clone(), app.state(), pty.into())).unwrap(); }
    let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let listeners: Vec<_> = ["codex-restore-invalidated", "codex-restore-published", "codex-restore-notice"].into_iter().map(|name| {
        let events = events.clone(); app.listen(name, move |event| {
            let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
            if payload["session_id"] == pty { events.lock().unwrap().push(serde_json::json!({"name": name, "payload": payload})); }
        })
    }).collect();
    let pause = Arc::new(PublicationPause { pty: pty.into(), first: if create_first { "create-publish" } else { "kill-publish" }, second: if create_first { "kill-enter" } else { "create-enter" }, reached: Mutex::new((false, false)), ready: Condvar::new(), released: Mutex::new(false), release: Condvar::new() });
    *PUBLICATION_PAUSE.get().unwrap().lock().unwrap() = Some(pause.clone());
    std::thread::scope(|scope| {
        let first = scope.spawn(|| { if create_first { start(app); } else { tauri::async_runtime::block_on(kill_session(app.clone(), app.state(), pty.into())).unwrap(); } });
        let (reached, timeout) = pause.ready.wait_timeout_while(pause.reached.lock().unwrap(), Duration::from_secs(8), |r| !r.0).unwrap();
        assert!(!timeout.timed_out(), "first publisher captured its observation"); drop(reached);
        let (done, completion) = std::sync::mpsc::channel();
        let second = scope.spawn(move || { if create_first { tauri::async_runtime::block_on(kill_session(app.clone(), app.state(), pty.into())).unwrap(); } else { start(app); } done.send(()).unwrap(); });
        let (reached, timeout) = pause.ready.wait_timeout_while(pause.reached.lock().unwrap(), Duration::from_secs(8), |r| !r.1).unwrap();
        assert!(!timeout.timed_out(), "second native operation entered while publication is held"); drop(reached);
        let blocked = completion.recv_timeout(Duration::from_secs(1)).is_err();
        *pause.released.lock().unwrap() = true; pause.release.notify_all();
        first.join().unwrap(); second.join().unwrap();
        *PUBLICATION_PAUSE.get().unwrap().lock().unwrap() = None;
        let current = tauri::async_runtime::block_on(get_codex_restore_epoch(app.state(), pty.into())).unwrap();
        for epoch in [old_epoch, current.unwrap_or(old_epoch), current.unwrap_or(old_epoch)] {
            app.emit("codex-restore-notice", serde_json::json!({"session_id": pty, "session_epoch": epoch, "generation": MISSING, "tab_id": TAB, "reason": "missing-id"})).unwrap();
        }
        let trace = events.lock().unwrap().clone();
        std::io::Write::write_all(&mut std::fs::OpenOptions::new().create(true).append(true).open(home.join("r12-publications.jsonl")).unwrap(), format!("{}\n", serde_json::json!({"pty": pty, "tab": TAB, "old_epoch": old_epoch, "current_epoch": current, "events": trace})).as_bytes()).unwrap();
        for listener in listeners { app.unlisten(listener); }
        let _ = app.state::<AppState>().session_manager.kill(pty);
        assert!(blocked, "R12-1: second mutation must wait for the first captured publication");
        let published: Vec<_> = trace.iter().filter(|e| e["name"] == "codex-restore-published").map(|e| e["payload"]["session_epoch"].clone()).collect();
        assert_eq!(published.last(), Some(&serde_json::json!(current)), "R12-1: last publication must describe the active instance");
        assert_eq!(current.is_none(), create_first);
    });
}

fn slow_retirement(app: &AppHandle, home: &Path) {
    let pty = "r13-slow-retirement";
    let scrollback = home.join("retirement-scrollback");
    std::fs::create_dir_all(&scrollback).unwrap();
    app.state::<AppState>().scrollback_dir.set(scrollback.clone()).unwrap();
    let start = |app: &AppHandle| {
        #[cfg(unix)]
        let (command, args) = ("/bin/bash", vec!["--noprofile".into(), "--norc".into(), "-c".into(), "sleep 10".into()]);
        #[cfg(windows)]
        let (command, args) = ("powershell.exe", vec!["-NoProfile".into(), "-Command".into(), "Start-Sleep 10".into()]);
        launch(app, pty, command, args, HashMap::new(), Arc::new(Mutex::new(Vec::new())));
    };
    start(app);
    let old = app.state::<AppState>().session_manager.session_observation(pty).unwrap().0;
    let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let listeners: Vec<_> = ["codex-restore-invalidated", "codex-restore-published"].into_iter().map(|name| {
        let events = events.clone(); app.listen(name, move |event| {
            let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
            if payload["session_id"] == pty { events.lock().unwrap().push(serde_json::json!({"name": name, "payload": payload})); }
        })
    }).collect();
    let pause = Arc::new(PublicationPause { pty: pty.into(), first: "retire-destroy", second: "create-enter", reached: Mutex::new((false, false)), ready: Condvar::new(), released: Mutex::new(false), release: Condvar::new() });
    *PUBLICATION_PAUSE.get().unwrap().lock().unwrap() = Some(pause.clone());
    let (progressed, before, after, current) = std::thread::scope(|scope| {
        let kill = scope.spawn(|| tauri::async_runtime::block_on(kill_session(app.clone(), app.state(), pty.into())).unwrap());
        let (reached, timeout) = pause.ready.wait_timeout_while(pause.reached.lock().unwrap(), Duration::from_secs(8), |r| !r.0).unwrap();
        assert!(!timeout.timed_out(), "real kill reached the owned session destruction boundary"); drop(reached);
        assert!(app.state::<AppState>().session_manager.session_observation(pty).is_none(), "removal precedes slow destruction");
        let (done, completion) = std::sync::mpsc::channel();
        let create = scope.spawn(move || { start(app); done.send(()).unwrap(); });
        let (reached, timeout) = pause.ready.wait_timeout_while(pause.reached.lock().unwrap(), Duration::from_secs(8), |r| !r.1).unwrap();
        assert!(!timeout.timed_out(), "successor entered from another real worker"); drop(reached);
        let progressed = completion.recv_timeout(Duration::from_secs(2)).is_ok();
        let before = events.lock().unwrap().clone();
        if progressed { std::fs::write(scrollback.join(format!("{pty}.bin")), b"E2 scrollback").unwrap(); }
        *pause.released.lock().unwrap() = true; pause.release.notify_all();
        kill.join().unwrap(); create.join().unwrap();
        *PUBLICATION_PAUSE.get().unwrap().lock().unwrap() = None;
        let current = tauri::async_runtime::block_on(get_codex_restore_epoch(app.state(), pty.into())).unwrap().unwrap();
        (progressed, before, events.lock().unwrap().clone(), current)
    });
    for listener in listeners { app.unlisten(listener); }
    let view = app.state::<AppState>().session_state_store.current_view(pty);
    app.state::<AppState>().session_manager.kill(pty).unwrap();
    std::fs::write(home.join("r13-retirement.json"), serde_json::json!({"pty": pty, "old_epoch": old, "current_epoch": current, "progressed": progressed, "before_release": before, "after_release": after}).to_string()).unwrap();
    assert!(progressed, "R13-1: slow physical destruction must not keep the lifecycle gate");
    assert_eq!(before, after, "R13-1: retired teardown cannot emit a lifecycle publication after E2");
    let epochs: Vec<_> = after.iter().filter(|e| e["name"] == "codex-restore-published").map(|e| e["payload"]["session_epoch"].clone()).collect();
    assert_eq!(epochs, vec![serde_json::Value::Null, serde_json::json!(current)]);
    assert_ne!(old, current);
    assert_eq!(view.unwrap().session_epoch, Some(current), "retired exit evidence cannot replace E2");
    assert_eq!(std::fs::read(scrollback.join(format!("{pty}.bin"))).unwrap(), b"E2 scrollback", "retired cleanup cannot remove E2 scrollback");
}

fn serialized_epoch_lookup(app: &AppHandle, home: &Path) {
    let pty = "r13-epoch-boundary";
    let pause = Arc::new(PublicationPause { pty: pty.into(), first: "create-publish", second: "epoch-enter", reached: Mutex::new((false, false)), ready: Condvar::new(), released: Mutex::new(false), release: Condvar::new() });
    *PUBLICATION_PAUSE.get().unwrap().lock().unwrap() = Some(pause.clone());
    let (blocked, queried, current) = std::thread::scope(|scope| {
        let create = scope.spawn(|| {
            #[cfg(unix)]
            let (command, args) = ("/bin/bash", vec!["--noprofile".into(), "--norc".into(), "-c".into(), "sleep 10".into()]);
            #[cfg(windows)]
            let (command, args) = ("powershell.exe", vec!["-NoProfile".into(), "-Command".into(), "Start-Sleep 10".into()]);
            launch(app, pty, command, args, HashMap::new(), Arc::new(Mutex::new(Vec::new())));
        });
        let (reached, timeout) = pause.ready.wait_timeout_while(pause.reached.lock().unwrap(), Duration::from_secs(8), |r| !r.0).unwrap();
        assert!(!timeout.timed_out(), "replacement is installed but publication remains inside the gate"); drop(reached);
        let (done, completion) = std::sync::mpsc::channel();
        let query = scope.spawn(move || {
            let epoch = tauri::async_runtime::block_on(get_codex_restore_epoch(app.state(), pty.into())).unwrap();
            done.send(epoch).unwrap();
        });
        let (reached, timeout) = pause.ready.wait_timeout_while(pause.reached.lock().unwrap(), Duration::from_secs(8), |r| !r.1).unwrap();
        assert!(!timeout.timed_out(), "real lookup worker entered"); drop(reached);
        let early = completion.recv_timeout(Duration::from_secs(1)).ok();
        *pause.released.lock().unwrap() = true; pause.release.notify_all();
        create.join().unwrap(); query.join().unwrap();
        *PUBLICATION_PAUSE.get().unwrap().lock().unwrap() = None;
        let queried = early.unwrap_or_else(|| completion.recv_timeout(Duration::from_secs(8)).unwrap());
        (early.is_none(), queried, app.state::<AppState>().session_manager.session_observation(pty).map(|v| v.0))
    });
    app.state::<AppState>().session_manager.kill(pty).unwrap();
    std::fs::write(home.join("r13-epoch-boundary.json"), serde_json::json!({"blocked": blocked, "queried": queried, "current": current}).to_string()).unwrap();
    assert!(blocked, "R13-2: authoritative epoch lookup must wait for an active replacement transaction");
    assert_eq!(queried, current);
    assert!(current.is_some());
}

pub(crate) fn run(app: AppHandle, home: &Path, fixture: &str) -> usize {
    assert_eq!(dirs::home_dir().as_deref(), Some(home), "all provider lookups must use synthetic HOME");
    for key in ["MYCMUX_E2E_HOME", "HOME", "USERPROFILE"] {
        assert_eq!(std::env::var_os(key).as_deref(), Some(home.as_os_str()), "fixture home must be explicit: {key}");
    }
    for (key, leaf) in [("CODEX_HOME", ".codex"), ("GROK_HOME", ".grok"), ("CLAUDE_CONFIG_DIR", ".claude")] {
        assert_eq!(std::env::var_os(key).map(PathBuf::from), Some(home.join(leaf)), "provider override escaped isolation: {key}");
    }
    assert_eq!(crate::test_profile::runtime_dir().unwrap(), home.join(".mycmux"));
    assert_eq!(crate::test_profile::agent_projects_dir("claude"), Some(home.join(".claude/projects")));
    assert_eq!(resolve_launch_cwd(None).as_deref(), home.to_str());
    let manager = Arc::new(crate::pty::manager::SessionManager::new());
    let store = crate::session_state::SessionStateStore::new();
    let metadata = crate::pty::monitor::new_metadata_store();
    app.manage(AppState {
        session_manager: manager.clone(), scrollback_dir: OnceLock::new(),
        status_feed: crate::status_feed::StatusFeed::new(store.clone()), session_state_store: store,
        frontend_visible: Arc::new(std::sync::atomic::AtomicBool::new(true)), metadata_store: metadata.clone(),
        livebrief_service: crate::livebrief::LiveBriefService::new(manager, metadata),
        hook_service: crate::agent_state::HookService::new(), window_registry: crate::window_registry::WindowRegistry::new(),
    });
    let sessions = home.join(".codex/sessions"); std::fs::create_dir_all(&sessions).unwrap();
    std::fs::write(sessions.join(format!("rollout-2026-10-11-{A}.jsonl")), serde_json::json!({"type":"session_meta", "payload":{"id": A, "cwd": home}}).to_string()).unwrap();
    let bin = home.join("fixture-bin"); std::fs::create_dir_all(&bin).unwrap();
    let forms = [("codex", false), ("node", true), ("bun", true), ("CODEX.EXE", false), ("CODEX.CMD", false)];
    let mut failures = 0; let mut total = 0;
    for (name, interpreter) in forms {
        let mut path = bin.join(name);
        #[cfg(windows)]
        if !name.contains('.') { path.set_extension("exe"); }
        #[cfg(windows)]
        if name.ends_with(".CMD") { std::fs::write(&path, format!("@echo off\r\n\"{}\" %*\r\n", fixture)).unwrap(); }
        else { std::fs::copy(fixture, &path).unwrap(); }
        #[cfg(unix)]
        std::os::unix::fs::symlink(fixture, &path).unwrap();
        for mode in ["valid", "missing", "exit7", "report-fault"] {
            total += 1;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check_case(&app, home, path.to_str().unwrap(), interpreter, name, mode, &[])));
            if result.is_err() { failures += 1; }
            println!("R10-2 {name}/{mode}: {}", if result.is_ok() { "ok" } else { "FAILED" });
        }
    }
    let codex = bin.join(if cfg!(windows) { "codex.exe" } else { "codex" });
    for (label, aliases) in [("lower-alias", [("mycmux_codex_restore_reason", "validation-failed"), ("mycmux_codex_restore_generation", MISSING)]),
                            ("mixed-alias", [("MyCmUx_CoDeX_ReStOrE_ReAsOn", "spawn-failed"), ("MyCmUx_CoDeX_ReStOrE_GeNeRaTiOn", MISSING)])] {
        total += 1;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check_case(&app, home, codex.to_str().unwrap(), false, label, "valid", &aliases)));
        if result.is_err() { failures += 1; }
        println!("R10-1 {label}: {}", if result.is_ok() { "ok" } else { "FAILED" });
    }
    total += 1;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| replacement_race(&app, home, codex.to_str().unwrap())));
    if result.is_err() { failures += 1; }
    println!("R10-3 two-caller replacement: {}", if result.is_ok() { "ok" } else { "FAILED" });
    total += 1;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| lifecycle_publication(&app, home)));
    if result.is_err() { failures += 1; }
    println!("R11-2 same-P/T publication: {}", if result.is_ok() { "ok" } else { "FAILED" });
    for create_first in [false, true] {
        total += 1;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| publication_overlap(&app, home, create_first)));
        if result.is_err() { failures += 1; }
        println!("R12-1 publication overlap create_first={create_first}: {}", if result.is_ok() { "ok" } else { "FAILED" });
    }
    total += 1;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| slow_retirement(&app, home)));
    if result.is_err() { failures += 1; }
    println!("R13-1 slow owned PTY destruction: {}", if result.is_ok() { "ok" } else { "FAILED" });
    total += 1;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| serialized_epoch_lookup(&app, home)));
    if result.is_err() { failures += 1; }
    println!("R13-2 serialized authoritative epoch lookup: {}", if result.is_ok() { "ok" } else { "FAILED" });
    app.state::<AppState>().session_manager.kill_all();
    println!("restore orchestration: {} passed; {failures} failed; {total} cases", total - failures);
    failures
}
