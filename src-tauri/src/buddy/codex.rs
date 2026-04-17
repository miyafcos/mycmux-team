use std::process::Stdio;
use std::time::Duration;
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

pub async fn run_codex_exec(stdin_payload: String, label: &'static str) -> Result<String, String> {
    let temp_dir = tempdir().map_err(|error| format!("tempdir failed: {error}"))?;
    let out_path = temp_dir.path().join("codex-last-message.txt");
    let out_path_string = out_path.to_string_lossy().into_owned();

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut command = TokioCommand::new("cmd");
        command.args([
            "/C",
            "codex",
            "exec",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "--color",
            "never",
            "-c",
            "model_reasoning_effort='low'",
            "--output-last-message",
            &out_path_string,
            "-",
        ]);
        command
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut command = TokioCommand::new("codex");
        command.args([
            "exec",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "--color",
            "never",
            "-c",
            r#"model_reasoning_effort="low""#,
            "--output-last-message",
            &out_path_string,
            "-",
        ]);
        command
    };

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|error| format!("failed to spawn codex: {error}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open codex stdin".to_string())?;
    stdin
        .write_all(stdin_payload.as_bytes())
        .await
        .map_err(|error| format!("failed to write stdin: {error}"))?;
    drop(stdin);

    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture codex stderr".to_string())?;
    let stderr_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        stderr.read_to_end(&mut buffer).await.map(|_| buffer)
    });

    let status = match timeout(Duration::from_secs(40), child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            eprintln!("[buddy][{label}] wait failed: {error}");
            return Err(format!("codex exec wait failed: {error}"));
        }
        Err(_) => {
            eprintln!("[buddy][{label}] timed out after 40s, killing child");
            let _ = child.kill().await;
            let _ = child.wait().await;
            let stderr_bytes = stderr_task
                .await
                .map_err(|error| format!("failed to join stderr task: {error}"))?
                .map_err(|error| format!("failed to read stderr: {error}"))?;
            let stderr_text = String::from_utf8_lossy(&stderr_bytes);
            if stderr_text.trim().is_empty() {
                return Err("codex exec timed out after 40s".to_string());
            }
            return Err(format!(
                "codex exec timed out after 40s: {}",
                stderr_text.trim()
            ));
        }
    };

    let stderr_bytes = stderr_task
        .await
        .map_err(|error| format!("failed to join stderr task: {error}"))?
        .map_err(|error| format!("failed to read stderr: {error}"))?;
    let stderr_text = String::from_utf8_lossy(&stderr_bytes);

    if !status.success() {
        eprintln!(
            "[buddy][{label}] exit non-zero {status}, stderr: {}",
            stderr_text.trim()
        );
        return Err(format!(
            "codex exec exited with {status}: {}",
            stderr_text.trim()
        ));
    }

    let content = tokio::fs::read_to_string(&out_path)
        .await
        .map_err(|error| format!("failed to read output {}: {error}", out_path.display()))?;

    if content.trim().is_empty() {
        eprintln!(
            "[buddy][{label}] empty result, stderr: {}",
            stderr_text.trim()
        );
        return Err(format!(
            "codex exec completed without a final message: {}",
            stderr_text.trim()
        ));
    }

    eprintln!(
        "[buddy][{label}] returned ({} bytes): {}",
        content.len(),
        content.trim()
    );
    Ok(content)
}
