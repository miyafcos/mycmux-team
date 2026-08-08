//! Helpers for moving blocking work off the Tauri main (UI) thread.

/// Run `task` on the blocking pool and flatten the join error into the
/// command's own `Result<_, String>`.
///
/// `label` names the work in the join-failure message (`join <label>: ...`),
/// which is the only clue left when the blocking pool thread panics.
pub async fn run_blocking<T, F>(label: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("join {label}: {error}"))?
}
