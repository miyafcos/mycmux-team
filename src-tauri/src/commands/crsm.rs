use serde_json::Value;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// crsm list serves a fresh cache in ~0.1s, but a TTL-expired call rescans
// incrementally first (measured 1.5-2.5s, longer under disk pressure); 4s
// killed those rescans mid-flight and surfaced spawn errors in the palette.
const CRSM_LIST_TIMEOUT: Duration = Duration::from_secs(15);
const CRSM_HANDOFF_TIMEOUT: Duration = Duration::from_secs(10);

struct CrsmOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn crsm_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let exe_name = format!("crsm{}", std::env::consts::EXE_SUFFIX);
    candidates.push(PathBuf::from("crsm"));
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("bin").join(&exe_name));
        candidates.push(
            home.join("crsm")
                .join("target")
                .join("release")
                .join(&exe_name),
        );
        candidates.push(
            home.join("crsm")
                .join("target")
                .join("debug")
                .join(&exe_name),
        );
    }
    candidates
}

fn temp_output_path(stream: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "mycmux-crsm-{stream}-{}-{timestamp}.tmp",
        std::process::id()
    ))
}

fn read_file_bytes(path: &Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    if let Ok(mut file) = File::open(path) {
        let _ = file.read_to_end(&mut bytes);
    }
    bytes
}

fn command_output_with_timeout(
    candidate: &Path,
    args: &[String],
    timeout: Duration,
) -> Result<CrsmOutput, String> {
    let stdout_path = temp_output_path("stdout");
    let stderr_path = temp_output_path("stderr");
    let stdout_file = File::create(&stdout_path)
        .map_err(|error| format!("create {}: {error}", stdout_path.display()))?;
    let stderr_file = File::create(&stderr_path)
        .map_err(|error| format!("create {}: {error}", stderr_path.display()))?;

    let mut command = Command::new(candidate);
    command
        .args(args)
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(crate::util::process::CREATE_NO_WINDOW);
    }
    let mut child = match command.spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let _ = fs::remove_file(&stdout_path);
            let _ = fs::remove_file(&stderr_path);
            return Err(error.to_string());
        }
    };

    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = read_file_bytes(&stdout_path);
                let stderr = read_file_bytes(&stderr_path);
                let _ = fs::remove_file(&stdout_path);
                let _ = fs::remove_file(&stderr_path);
                return Ok(CrsmOutput {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let stderr =
                        String::from_utf8_lossy(&read_file_bytes(&stderr_path)).to_string();
                    let _ = fs::remove_file(&stdout_path);
                    let _ = fs::remove_file(&stderr_path);
                    return Err(format!(
                        "{} timed out after {} ms{}",
                        candidate.display(),
                        timeout.as_millis(),
                        if stderr.trim().is_empty() {
                            String::new()
                        } else {
                            format!(": {}", stderr.trim())
                        }
                    ));
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&stdout_path);
                let _ = fs::remove_file(&stderr_path);
                return Err(error.to_string());
            }
        }
    }
}

fn run_crsm_json(args: &[String], timeout: Duration) -> Result<Value, String> {
    let mut last_error = String::new();
    for candidate in crsm_candidates() {
        let output = command_output_with_timeout(&candidate, args, timeout);
        match output {
            Ok(output) if output.status.success() => {
                return serde_json::from_slice(&output.stdout).map_err(|error| {
                    format!("parse crsm JSON from {}: {error}", candidate.display())
                });
            }
            Ok(output) => {
                last_error = format!(
                    "{} exited with {}: {}",
                    candidate.display(),
                    output.status,
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            Err(error) => {
                last_error = format!("spawn {}: {error}", candidate.display());
            }
        }
    }
    Err(last_error)
}

async fn run_crsm_json_async(args: Vec<String>, timeout: Duration) -> Result<Value, String> {
    crate::util::task::run_blocking("crsm command", move || run_crsm_json(&args, timeout)).await
}

#[tauri::command]
pub async fn crsm_list_sessions(
    query: Option<String>,
    limit: Option<usize>,
    refresh: Option<bool>,
) -> Result<Value, String> {
    let mut args = vec![
        "list".to_string(),
        "--json".to_string(),
        "--limit".to_string(),
        limit.unwrap_or(200).to_string(),
    ];
    if refresh.unwrap_or(false) {
        args.push("--refresh".to_string());
    }
    if let Some(query) = query.filter(|value| !value.trim().is_empty()) {
        args.push("--query".to_string());
        args.push(query);
    }
    run_crsm_json_async(args, CRSM_LIST_TIMEOUT).await
}

#[tauri::command]
pub async fn crsm_create_handoff(
    session_id: String,
    from_kind: Option<String>,
    target_kind: String,
    recent_turns: Option<usize>,
) -> Result<Value, String> {
    let mut args = vec![
        "handoff".to_string(),
        "--session-id".to_string(),
        session_id,
        "--target".to_string(),
        target_kind,
        "--recent-turns".to_string(),
        recent_turns.unwrap_or(20).to_string(),
        "--json".to_string(),
    ];
    if let Some(from_kind) = from_kind.filter(|value| !value.trim().is_empty()) {
        args.push("--from".to_string());
        args.push(from_kind);
    }
    run_crsm_json_async(args, CRSM_HANDOFF_TIMEOUT).await
}
