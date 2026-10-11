//! Invocation-local privacy policy. It never changes another PC task's logs.
use std::future::Future;

#[derive(serde::Deserialize)]
pub enum ApiUsageCommand {
    #[serde(rename = "account.switch")]
    Switch,
    #[serde(rename = "account.use_reset_ticket")]
    ResetTicket,
    #[serde(rename = "account.usage")]
    Usage,
}

tokio::task_local! {
    static API_INVOCATION: bool;
}

pub async fn scope<T>(api_request: bool, future: impl Future<Output = T>) -> T {
    API_INVOCATION.scope(api_request, future).await
}

pub(crate) fn private_allowed() -> bool {
    !API_INVOCATION.try_with(|api| *api).unwrap_or(false)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Sink { OauthFile, Stderr, Diagnostic }

pub(crate) fn private_log(sink: Sink, message: std::fmt::Arguments<'_>, emit: impl FnOnce()) {
    if !private_allowed() { return; }
    #[cfg(test)]
    if CAPTURE.try_with(|capture| {
        capture.lock().unwrap().push((sink, message.to_string()));
    }).is_ok() { return; }
    #[cfg(not(test))]
    let _ = (sink, message);
    emit();
}

pub(crate) fn stderr(message: std::fmt::Arguments<'_>) {
    private_log(Sink::Stderr, message, || eprintln!("{message}"));
}

#[cfg(test)]
tokio::task_local! {
    static CAPTURE: std::sync::Arc<std::sync::Mutex<Vec<(Sink, String)>>>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn failures(dir: &std::path::Path) {
        for (context, detail) in [
            ("get_account_usage", "SECRET-upstream-body"),
            ("claude_token_owner_mismatch", "profile=SECRET-profile claimed=SECRET-account owner=SECRET-owner"),
            ("get_account_usage_refresh", "profile=SECRET-profile refresh_error=SECRET-refresh-code"),
        ] {
            crate::usage::log_oauth_failure_to(|| Some(dir.to_path_buf()), context, detail);
        }
        crate::usage::refresh::log_refresh_failure(401, " SECRET-diagnostic-header", "SECRET-refresh-body");
        crate::diag_warn!("usage", "SECRET-diagnostic");
    }

    #[tokio::test]
    async fn api_switch_and_reset_followup_failures_emit_no_private_data_to_any_sink() {
        let dir = tempfile::tempdir().unwrap();
        let capture = Arc::new(Mutex::new(Vec::new()));
        CAPTURE.scope(capture.clone(), async {
            // Both entry points and their separate usage IPC opt into this
            // same task-local policy, including awaited lower refresh helpers.
            for _command in [ApiUsageCommand::Switch, ApiUsageCommand::ResetTicket, ApiUsageCommand::Usage] {
                scope(true, async { failures(dir.path()); tokio::task::yield_now().await; failures(dir.path()); }).await;
            }
        }).await;
        assert!(capture.lock().unwrap().is_empty());
        assert!(!dir.path().join("logs/oauth.log").exists());
    }

    #[tokio::test]
    async fn concurrent_pc_keeps_all_detailed_sinks_while_api_is_private() {
        let dir = tempfile::tempdir().unwrap();
        let capture = Arc::new(Mutex::new(Vec::new()));
        CAPTURE.scope(capture.clone(), async {
            tokio::join!(
                scope(true, async { failures(dir.path()); tokio::task::yield_now().await; failures(dir.path()); }),
                scope(false, async { tokio::task::yield_now().await; failures(dir.path()); }),
            );
            assert!(private_allowed());
        }).await;
        let records = capture.lock().unwrap();
        assert_eq!(records.iter().filter(|(sink, _)| *sink == Sink::OauthFile).count(), 3);
        assert_eq!(records.iter().filter(|(sink, _)| *sink == Sink::Stderr).count(), 2);
        assert_eq!(records.iter().filter(|(sink, _)| *sink == Sink::Diagnostic).count(), 1);
        let messages: Vec<_> = records.iter().map(|(_, message)| message.as_str()).collect();
        for marker in ["SECRET-upstream-body", "SECRET-profile", "SECRET-account", "SECRET-owner", "SECRET-refresh-code", "SECRET-diagnostic-header", "SECRET-refresh-body", "SECRET-diagnostic"] {
            assert!(messages.iter().any(|message| message.contains(marker)), "PC detail lost: {marker}");
        }
    }
}
