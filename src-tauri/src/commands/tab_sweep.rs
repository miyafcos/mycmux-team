use std::collections::HashMap;
use std::io::ErrorKind;
use std::process::Command as StdCommand;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::Instant;

const JUDGE_TIMEOUT: Duration = Duration::from_secs(90);
const NAMING_TIMEOUT: Duration = Duration::from_secs(180);
const GROUPING_TIMEOUT: Duration = Duration::from_secs(300);

type JudgeAbortRegistry = Mutex<HashMap<String, oneshot::Sender<()>>>;

fn judge_abort_registry() -> &'static JudgeAbortRegistry {
    static REGISTRY: OnceLock<JudgeAbortRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSweepJudgeError {
    code: &'static str,
    detail: String,
}

impl TabSweepJudgeError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    fn internal(detail: impl Into<String>) -> Self {
        Self::new("internal", detail)
    }
}

struct JudgeRegistration {
    request_id: String,
}

impl JudgeRegistration {
    fn register(
        request_id: String,
        sender: oneshot::Sender<()>,
    ) -> Result<Self, TabSweepJudgeError> {
        if request_id.trim().is_empty() {
            return Err(TabSweepJudgeError::internal("judge request id is empty"));
        }
        let mut registry = judge_abort_registry()
            .lock()
            .map_err(|_| TabSweepJudgeError::internal("judge registry lock is poisoned"))?;
        if registry.contains_key(&request_id) {
            return Err(TabSweepJudgeError::internal(
                "judge request id is already active",
            ));
        }
        registry.insert(request_id.clone(), sender);
        Ok(Self { request_id })
    }
}

impl Drop for JudgeRegistration {
    fn drop(&mut self) {
        if let Ok(mut registry) = judge_abort_registry().lock() {
            registry.remove(&self.request_id);
        }
    }
}

#[cfg(windows)]
async fn terminate_child_tree(child: &mut Child) -> Result<(), String> {
    let tree_result = if let Some(pid) = child.id() {
        let mut taskkill = StdCommand::new("taskkill.exe");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        {
            use std::os::windows::process::CommandExt;
            taskkill.creation_flags(crate::util::process::CREATE_NO_WINDOW);
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
pub async fn abort_tab_sweep_judge(request_id: String) -> Result<bool, TabSweepJudgeError> {
    let sender = judge_abort_registry()
        .lock()
        .map_err(|_| TabSweepJudgeError::internal("judge registry lock is poisoned"))?
        .remove(&request_id);
    Ok(sender.is_some_and(|sender| sender.send(()).is_ok()))
}

#[tauri::command]
pub async fn run_tab_sweep_judge(
    app: tauri::AppHandle,
    prompt: String,
    request_id: String,
    mode: Option<String>,
) -> Result<String, TabSweepJudgeError> {
    let cfg = crate::ai::resolve(&app);
    if !cfg.enabled {
        return Err(TabSweepJudgeError::new("ai_disabled", "ai features are disabled in settings"));
    }
    let timeout = match mode.as_deref() {
        None | Some("judge") => JUDGE_TIMEOUT,
        Some("naming") => NAMING_TIMEOUT,
        Some("grouping") => GROUPING_TIMEOUT,
        Some(value) => {
            return Err(TabSweepJudgeError::new(
                "invalid_mode",
                format!("unsupported tab sweep mode: {value}"),
            ));
        }
    };
    let (cancel_sender, mut cancel_receiver) = oneshot::channel();
    let _registration = JudgeRegistration::register(request_id, cancel_sender)?;
    let mut command = Command::from(crate::ai::build_command(&cfg, std::env::vars()));
    command.kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| {
        let code = if error.kind() == ErrorKind::NotFound {
            "cli_not_found"
        } else {
            "internal"
        };
        TabSweepJudgeError::new(code, format!("failed to start tab sweep judge: {error}"))
    })?;
    let deadline = Instant::now() + timeout;

    let Some(mut stdin) = child.stdin.take() else {
        let cleanup = terminate_child_tree(&mut child).await.err();
        return Err(TabSweepJudgeError::internal(format!(
            "tab sweep judge stdin unavailable{}",
            cleanup
                .map(|detail| format!("; cleanup failed: {detail}"))
                .unwrap_or_default()
        )));
    };
    let Some(stdout) = child.stdout.take() else {
        let cleanup = terminate_child_tree(&mut child).await.err();
        return Err(TabSweepJudgeError::internal(format!(
            "tab sweep judge stdout unavailable{}",
            cleanup
                .map(|detail| format!("; cleanup failed: {detail}"))
                .unwrap_or_default()
        )));
    };
    let Some(stderr) = child.stderr.take() else {
        let cleanup = terminate_child_tree(&mut child).await.err();
        return Err(TabSweepJudgeError::internal(format!(
            "tab sweep judge stderr unavailable{}",
            cleanup
                .map(|detail| format!("; cleanup failed: {detail}"))
                .unwrap_or_default()
        )));
    };
    let mut stdout_task = tokio::spawn(read_pipe(stdout));
    let mut stderr_task = tokio::spawn(read_pipe(stderr));

    let write_result = tokio::select! {
        _ = &mut cancel_receiver => None,
        result = tokio::time::timeout_at(deadline, stdin.write_all(prompt.as_bytes())) => Some(result),
    };
    match write_result {
        None => {
            let cleanup = terminate_child_tree(&mut child).await.err();
            abort_output_tasks(&stdout_task, &stderr_task);
            return Err(TabSweepJudgeError::new(
                "cancelled",
                cleanup
                    .map(|detail| format!("judge cancelled; cleanup failed: {detail}"))
                    .unwrap_or_else(|| "judge cancelled".to_string()),
            ));
        }
        Some(Ok(Ok(()))) => drop(stdin),
        Some(Ok(Err(error))) => {
            let cleanup = terminate_child_tree(&mut child).await.err();
            abort_output_tasks(&stdout_task, &stderr_task);
            return Err(TabSweepJudgeError::internal(format!(
                "failed to write tab sweep judge prompt: {error}{}",
                cleanup
                    .map(|detail| format!("; cleanup failed: {detail}"))
                    .unwrap_or_default()
            )));
        }
        Some(Err(_)) => {
            let cleanup = terminate_child_tree(&mut child).await.err();
            abort_output_tasks(&stdout_task, &stderr_task);
            return Err(TabSweepJudgeError::new(
                "timeout",
                format!(
                    "tab sweep judge timed out after {} seconds{}",
                    timeout.as_secs(),
                    cleanup
                        .map(|detail| format!("; cleanup failed: {detail}"))
                        .unwrap_or_default()
                ),
            ));
        }
    }

    let wait_result = tokio::select! {
        _ = &mut cancel_receiver => None,
        result = tokio::time::timeout_at(deadline, child.wait()) => Some(result),
    };
    let status = match wait_result {
        None => {
            let cleanup = terminate_child_tree(&mut child).await.err();
            abort_output_tasks(&stdout_task, &stderr_task);
            return Err(TabSweepJudgeError::new(
                "cancelled",
                cleanup
                    .map(|detail| format!("judge cancelled; cleanup failed: {detail}"))
                    .unwrap_or_else(|| "judge cancelled".to_string()),
            ));
        }
        Some(Ok(Ok(status))) => status,
        Some(Ok(Err(error))) => {
            let cleanup = terminate_child_tree(&mut child).await.err();
            abort_output_tasks(&stdout_task, &stderr_task);
            return Err(TabSweepJudgeError::internal(format!(
                "tab sweep judge wait failed: {error}{}",
                cleanup
                    .map(|detail| format!("; cleanup failed: {detail}"))
                    .unwrap_or_default()
            )));
        }
        Some(Err(_)) => {
            let cleanup = terminate_child_tree(&mut child).await.err();
            abort_output_tasks(&stdout_task, &stderr_task);
            return Err(TabSweepJudgeError::new(
                "timeout",
                format!(
                    "tab sweep judge timed out after {} seconds{}",
                    timeout.as_secs(),
                    cleanup
                        .map(|detail| format!("; cleanup failed: {detail}"))
                        .unwrap_or_default()
                ),
            ));
        }
    };
    let output_result = tokio::select! {
        _ = &mut cancel_receiver => None,
        result = tokio::time::timeout_at(deadline, async {
            let stdout = (&mut stdout_task)
                .await
                .map_err(|error| format!("tab sweep judge stdout task failed: {error}"))??;
            let stderr = (&mut stderr_task)
                .await
                .map_err(|error| format!("tab sweep judge stderr task failed: {error}"))??;
            Ok::<_, String>((stdout, stderr))
        }) => Some(result),
    };
    let (stdout, stderr) = match output_result {
        None => {
            abort_output_tasks(&stdout_task, &stderr_task);
            return Err(TabSweepJudgeError::new("cancelled", "judge cancelled"));
        }
        Some(Ok(Ok(result))) => result,
        Some(Ok(Err(error))) => return Err(TabSweepJudgeError::internal(error)),
        Some(Err(_)) => {
            abort_output_tasks(&stdout_task, &stderr_task);
            return Err(TabSweepJudgeError::new(
                "timeout",
                format!(
                    "tab sweep judge timed out after {} seconds",
                    timeout.as_secs()
                ),
            ));
        }
    };
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr);
        return Err(TabSweepJudgeError::new(
            "cli_failed",
            format!("tab sweep judge exited with {status}: {}", detail.trim()),
        ));
    }
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;


    #[tokio::test]
    async fn abort_signal_is_request_scoped_and_idempotent() {
        let request_id = "tab-sweep-abort-test".to_string();
        let (sender, receiver) = oneshot::channel();
        let registration =
            JudgeRegistration::register(request_id.clone(), sender).expect("register judge");

        assert!(abort_tab_sweep_judge(request_id.clone())
            .await
            .expect("abort judge"));
        receiver.await.expect("receive abort signal");
        assert!(!abort_tab_sweep_judge(request_id)
            .await
            .expect("second abort is a no-op"));
        drop(registration);
    }

    #[test]
    fn duplicate_request_ids_do_not_replace_the_active_sender() {
        let request_id = "tab-sweep-duplicate-test".to_string();
        let (first_sender, _first_receiver) = oneshot::channel();
        let registration = JudgeRegistration::register(request_id.clone(), first_sender)
            .expect("register first judge");
        let (second_sender, _second_receiver) = oneshot::channel();
        let error = JudgeRegistration::register(request_id, second_sender)
            .err()
            .expect("duplicate is rejected");
        assert_eq!(error.code, "internal");
        drop(registration);
    }

}
