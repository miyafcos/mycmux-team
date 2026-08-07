use std::collections::HashMap;
use std::process::{Command as StdCommand, Stdio};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::commands::terminal::{prepare_spawn_command, sanitize_launch_env};

const JUDGE_MODEL: &str = "claude-haiku-4-5-20251001";
const JUDGE_TIMEOUT: Duration = Duration::from_secs(90);

fn judge_args() -> Vec<String> {
    vec![
        "-p".to_string(),
        "--model".to_string(),
        JUDGE_MODEL.to_string(),
        "--output-format".to_string(),
        "text".to_string(),
    ]
}

fn judge_environment<I>(env: I) -> HashMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut sanitized: HashMap<String, String> = env.into_iter().collect();
    sanitize_launch_env(&mut sanitized);
    // The PTY sanitizer intentionally preserves valid resume/handoff payloads.
    // A one-shot judge must never inherit any mycmux control channel, even if
    // the parent process was started from such a shell.
    sanitized.retain(|key, _| !key.to_ascii_uppercase().starts_with("MYCMUX_"));
    sanitized
}

fn build_judge_command<I>(env: I) -> StdCommand
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut args = judge_args();
    let program = prepare_spawn_command("claude", &mut args);
    let mut command = StdCommand::new(program);
    command
        .args(args)
        .env_clear()
        .envs(judge_environment(env))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(windows)]
async fn terminate_child_tree(child: &mut Child) -> Result<(), String> {
    let tree_result = if let Some(pid) = child.id() {
        let mut taskkill = StdCommand::new("taskkill.exe");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            taskkill.creation_flags(CREATE_NO_WINDOW);
        }
        let mut taskkill = Command::from(taskkill);
        taskkill.kill_on_drop(true);
        match tokio::time::timeout(Duration::from_secs(5), taskkill.status()).await {
            Ok(Ok(status)) if status.success() => Ok(()),
            Ok(Ok(status)) => Err(format!("taskkill exited with {status}")),
            Ok(Err(error)) => Err(format!("taskkill failed: {error}")),
            Err(_) => Err("taskkill timed out".to_string()),
        }
    } else {
        Ok(())
    };
    let _ = child.kill().await;
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    tree_result
}

#[cfg(not(windows))]
async fn terminate_child_tree(child: &mut Child) -> Result<(), String> {
    child.kill().await.map_err(|error| error.to_string())?;
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    Ok(())
}

fn abort_output_tasks(
    stdout_task: &JoinHandle<Result<Vec<u8>, String>>,
    stderr_task: &JoinHandle<Result<Vec<u8>, String>>,
) {
    stdout_task.abort();
    stderr_task.abort();
}

async fn read_pipe<R>(mut pipe: R) -> Result<Vec<u8>, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut output = Vec::new();
    pipe.read_to_end(&mut output)
        .await
        .map_err(|error| error.to_string())?;
    Ok(output)
}

#[tauri::command]
pub async fn run_tab_sweep_judge(prompt: String) -> Result<String, String> {
    let mut command = Command::from(build_judge_command(std::env::vars()));
    command.kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start tab sweep judge: {error}"))?;
    let deadline = Instant::now() + JUDGE_TIMEOUT;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "tab sweep judge stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "tab sweep judge stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "tab sweep judge stderr unavailable".to_string())?;
    let mut stdout_task = tokio::spawn(read_pipe(stdout));
    let mut stderr_task = tokio::spawn(read_pipe(stderr));

    match tokio::time::timeout_at(deadline, stdin.write_all(prompt.as_bytes())).await {
        Ok(Ok(())) => drop(stdin),
        Ok(Err(error)) => {
            let cleanup = terminate_child_tree(&mut child).await.err();
            abort_output_tasks(&stdout_task, &stderr_task);
            return Err(format!(
                "failed to write tab sweep judge prompt: {error}{}",
                cleanup
                    .map(|detail| format!("; cleanup failed: {detail}"))
                    .unwrap_or_default()
            ));
        }
        Err(_) => {
            let cleanup = terminate_child_tree(&mut child).await.err();
            abort_output_tasks(&stdout_task, &stderr_task);
            return Err(format!(
                "tab sweep judge timed out after 90 seconds{}",
                cleanup
                    .map(|detail| format!("; cleanup failed: {detail}"))
                    .unwrap_or_default()
            ));
        }
    }

    let status = match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            let cleanup = terminate_child_tree(&mut child).await.err();
            abort_output_tasks(&stdout_task, &stderr_task);
            return Err(format!(
                "tab sweep judge wait failed: {error}{}",
                cleanup
                    .map(|detail| format!("; cleanup failed: {detail}"))
                    .unwrap_or_default()
            ));
        }
        Err(_) => {
            let cleanup = terminate_child_tree(&mut child).await.err();
            abort_output_tasks(&stdout_task, &stderr_task);
            return Err(format!(
                "tab sweep judge timed out after 90 seconds{}",
                cleanup
                    .map(|detail| format!("; cleanup failed: {detail}"))
                    .unwrap_or_default()
            ));
        }
    };
    let (stdout, stderr) = match tokio::time::timeout_at(deadline, async {
        let stdout = (&mut stdout_task)
            .await
            .map_err(|error| format!("tab sweep judge stdout task failed: {error}"))??;
        let stderr = (&mut stderr_task)
            .await
            .map_err(|error| format!("tab sweep judge stderr task failed: {error}"))??;
        Ok::<_, String>((stdout, stderr))
    })
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            abort_output_tasks(&stdout_task, &stderr_task);
            return Err("tab sweep judge timed out after 90 seconds".to_string());
        }
    };
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr);
        return Err(format!(
            "tab sweep judge exited with {status}: {}",
            detail.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn judge_arguments_are_stable_and_do_not_contain_the_prompt() {
        let prompt = "do not put this prompt in argv";
        let args = judge_args();
        assert_eq!(
            args,
            vec![
                "-p",
                "--model",
                "claude-haiku-4-5-20251001",
                "--output-format",
                "text",
            ]
        );
        assert!(!args.iter().any(|argument| argument.contains(prompt)));
    }

    #[test]
    fn judge_environment_strips_every_mycmux_control_variable() {
        let env = judge_environment([
            ("PATH".to_string(), "safe-path".to_string()),
            ("MYCMUX_RESUME".to_string(), "claude".to_string()),
            ("MYCMUX_SESSION_ID".to_string(), "saved-session".to_string()),
            ("MYCMUX_AGENT_KIND".to_string(), "claude".to_string()),
            ("MYCMUX_HANDOFF".to_string(), "1".to_string()),
            (
                "MYCMUX_HANDOFF_FROM_SESSION".to_string(),
                "source-session".to_string(),
            ),
            ("MYCMUX_LAUNCH_TARGET".to_string(), "codex".to_string()),
            ("mycmux_lowercase_probe".to_string(), "leak".to_string()),
            ("__CMUX_LAUNCHER_DONE".to_string(), "1".to_string()),
        ]);
        assert_eq!(env.get("PATH").map(String::as_str), Some("safe-path"));
        assert!(!env.keys().any(|key| key.starts_with("MYCMUX_")));
        assert!(!env
            .keys()
            .any(|key| key.to_ascii_uppercase().starts_with("MYCMUX_")));
        assert!(!env.contains_key("__CMUX_LAUNCHER_DONE"));
    }

    #[test]
    fn built_command_applies_sanitized_environment_and_piped_stdio() {
        let command = build_judge_command([
            ("PATH".to_string(), "safe-path".to_string()),
            ("MYCMUX_RESUME".to_string(), "claude".to_string()),
        ]);
        let environment: HashMap<_, _> = command
            .get_envs()
            .filter_map(|(key, value)| {
                value.map(|value| {
                    (
                        key.to_string_lossy().into_owned(),
                        value.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect();
        assert_eq!(
            environment.get("PATH").map(String::as_str),
            Some("safe-path")
        );
        assert!(!environment
            .keys()
            .any(|key| key.to_ascii_uppercase().starts_with("MYCMUX_")));
        let args: Vec<_> = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
        assert!(args.ends_with(&judge_args()));
    }

    #[cfg(windows)]
    #[test]
    fn cmd_shim_uses_comspec_without_mutating_process_path() {
        let directory = tempfile::tempdir().expect("temp dir");
        let shim = directory.path().join("claude.cmd");
        std::fs::write(&shim, "@echo off\r\n").expect("write shim");
        let mut args = judge_args();
        let program = prepare_spawn_command(&shim.to_string_lossy(), &mut args);
        let expected_comspec = std::env::var("COMSPEC")
            .unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_string());
        assert_eq!(program, expected_comspec);
        assert_eq!(args[0..2], ["/d", "/c"]);
        assert_eq!(args[2], shim.to_string_lossy());
        assert_eq!(args[3..], judge_args());
    }
}
