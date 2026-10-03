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

/// Same executor boundary for commands whose errors have a typed wire schema.
pub async fn run_blocking_result<T, E, F>(label: &'static str, task: F) -> Result<T, E>
where
    T: Send + 'static,
    E: From<String> + Send + 'static,
    F: FnOnce() -> Result<T, E> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| E::from(format!("join {label}: {error}")))?
}

/// Infallible IPC payloads keep their original shape. A worker panic remains a
/// panic rather than being silently converted to a misleading empty payload.
pub async fn run_blocking_value<T, F>(label: &'static str, task: F) -> T
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .unwrap_or_else(|error| panic!("join {label}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn async_result_wrappers_preserve_the_existing_successful_ipc_payloads() {
        use tauri::ipc::{InvokeResponse, InvokeResponseBody, IpcResponse};
        fn same_body<T: serde::Serialize + Clone>(value: T) {
            let previous = value.clone().body().unwrap();
            let wrapped = InvokeResponse::from(Ok::<T, String>(value));
            match (previous, wrapped) {
                (InvokeResponseBody::Json(previous), InvokeResponse::Ok(InvokeResponseBody::Json(current))) => assert_eq!(current, previous),
                other => panic!("unexpected IPC response: {other:?}"),
            }
        }
        same_body(vec!["pane-one".to_string(), "pane-two".to_string()]);
        same_body(std::collections::HashMap::from([("one".to_string(), Some(42u64)), ("two".to_string(), None)]));
        same_body(true);
        same_body(false);
        same_body(()); // quit_prepared, quit_saved and set_window_close_intent.
        same_body(crate::status_feed::SnapshotPayload { server_epoch: "epoch".into(), seq: 7, sessions: Vec::new() });
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_work_does_not_occupy_the_only_async_worker() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let job = tokio::spawn(run_blocking("executor-state-test", move || {
            started_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            Ok(42)
        }));
        tokio::time::timeout(Duration::from_secs(1), async {
            while started_rx.try_recv().is_err() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }).await.expect("the async timer must run while the blocking worker waits");
        release_tx.send(()).unwrap();
        assert_eq!(job.await.unwrap().unwrap(), 42);
    }

    #[tokio::test]
    async fn typed_storage_errors_keep_their_wire_kind() {
        let result = run_blocking_result("typed-error", || {
            Err::<(), _>(crate::db::storage::PersistentStorageError::unsupported_schema(999))
        }).await;
        assert_eq!(serde_json::to_value(result.unwrap_err()).unwrap()["kind"], "unsupportedSchema");
        assert_eq!(run_blocking_value("value", || vec![1, 2]).await, vec![1, 2]);
        let result = run_blocking_result::<(), crate::db::storage::PersistentStorageError, _>(
            "panic", || panic!("intentional worker panic"),
        ).await;
        assert_eq!(serde_json::to_value(result.unwrap_err()).unwrap()["kind"], "storage");
    }
}
