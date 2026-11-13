use std::{
    collections::HashMap,
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::cli_accounts::{
    self,
    login_watch::{
        CliLoginMode, LoginMode, LoginRegistry, LoginWatch, PendingLogin,
    },
    staging, CliAccountProfile, CliAccountsSnapshot, CliProvider, CliSwitchResult,
};
use crate::util::task::run_blocking;

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let default_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve application data directory: {e}"))?;
    Ok(crate::test_profile::app_data_dir_from(default_dir))
}

/// How the frontend must launch the CLI so it logs in *beside* the live
/// account instead of replacing it.
///
/// The command, arguments and environment are decided here rather than in the
/// UI: the isolation guarantee rests entirely on the config-directory override,
/// and a frontend that forgets it would log the user out of the live account
/// with no warning.
#[derive(Serialize)]
pub struct CliLoginSession {
    pub login_id: String,
    pub provider: CliProvider,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub staging_dir: String,
}

#[tauri::command(async)]
pub async fn list_cli_accounts(app: AppHandle) -> Result<CliAccountsSnapshot, String> {
    cli_accounts::list_resolved(&app_data_dir(&app)?)
}

#[tauri::command(async)]
pub async fn get_cli_launch_tokens(app: AppHandle) -> Result<Vec<cli_accounts::launch_tokens::LaunchTokenStatus>, String> {
    let base = app_data_dir(&app).map_err(|_| cli_accounts::ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    tauri::async_runtime::spawn_blocking(move || cli_accounts::launch_tokens::status_all(&base))
        .await.map_err(|_| cli_accounts::ERR_ACCOUNTS_UNAVAILABLE.to_string())?
}

#[tauri::command(async)]
pub async fn set_cli_launch_token(
    _trusted: crate::ipc_caller::TrustedAppCaller, app: AppHandle, profile_id: String, token: String,
) -> Result<cli_accounts::launch_tokens::LaunchTokenStatus, String> {
    let base = app_data_dir(&app).map_err(|_| cli_accounts::ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        cli_accounts::launch_tokens::save_with_outcome(&base, &cli_accounts::launch_tokens::OsLaunchTokenStore::new(&base),
            &profile_id, &token, |token| tauri::async_runtime::block_on(
                cli_accounts::token_owner::fetch_claude_launch_owner(token)))
    }).await.map_err(|_| cli_accounts::ERR_REGISTRY_SAVE_FAILED.to_string())??;
    let (result, mismatch) = match outcome {
        cli_accounts::launch_tokens::SaveOutcome::Saved(result) => (result, false),
        cli_accounts::launch_tokens::SaveOutcome::MismatchRecorded(result) => (result, true),
    };
    let _ = app.emit("tab-account-evidence-updated", serde_json::json!({ "profile_id": result.profile_id }));
    if mismatch { Err(cli_accounts::ERR_LAUNCH_TOKEN_OWNER_MISMATCH.into()) } else { Ok(result) }
}

#[tauri::command(async)]
pub async fn recheck_cli_launch_token(
    _trusted: crate::ipc_caller::TrustedAppCaller, app: AppHandle, profile_id: String,
) -> Result<cli_accounts::launch_tokens::LaunchTokenStatus, String> {
    let base = app_data_dir(&app).map_err(|_| cli_accounts::ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || cli_accounts::launch_tokens::recheck(
        &base, &cli_accounts::launch_tokens::OsLaunchTokenStore::new(&base), &profile_id,
        |token| tauri::async_runtime::block_on(cli_accounts::token_owner::fetch_claude_launch_owner(token))))
        .await.map_err(|_| cli_accounts::ERR_REGISTRY_SAVE_FAILED.to_string())??;
    let _ = app.emit("tab-account-evidence-updated", serde_json::json!({ "profile_id": result.profile_id }));
    Ok(result)
}

#[tauri::command(async)]
pub async fn remove_cli_launch_token(
    _trusted: crate::ipc_caller::TrustedAppCaller, app: AppHandle, profile_id: String,
) -> Result<(), String> {
    let base = app_data_dir(&app).map_err(|_| cli_accounts::ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    let removed_profile_id = profile_id.clone();
    tauri::async_runtime::spawn_blocking(move || cli_accounts::launch_tokens::remove(
        &base, &cli_accounts::launch_tokens::OsLaunchTokenStore::new(&base), &profile_id))
        .await.map_err(|_| cli_accounts::ERR_REMOVE_FAILED.to_string())??;
    let _ = app.emit("tab-account-evidence-updated", serde_json::json!({ "profile_id": removed_profile_id }));
    Ok(())
}

#[tauri::command(async)]
pub async fn get_tab_account_evidence(
    _trusted: crate::ipc_caller::TrustedAppCaller, app: AppHandle, session_id: String,
) -> Result<Option<cli_accounts::tab_evidence::TabAccountEvidence>, String> {
    let base = app_data_dir(&app).map_err(|_| cli_accounts::ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    let manager = app.state::<crate::AppState>().session_manager.clone();
    tauri::async_runtime::spawn_blocking(move || cli_accounts::tab_evidence::get(&base, &session_id, |id| manager.is_alive(id)))
        .await.map_err(|_| cli_accounts::ERR_ACCOUNTS_UNAVAILABLE.to_string())?
}

#[tauri::command(async)]
pub async fn recheck_tab_account(
    _trusted: crate::ipc_caller::TrustedAppCaller, app: AppHandle, session_id: String,
) -> Result<Option<cli_accounts::tab_evidence::TabAccountEvidence>, String> {
    let base = app_data_dir(&app).map_err(|_| cli_accounts::ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    let manager = app.state::<crate::AppState>().session_manager.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || cli_accounts::tab_evidence::recheck_with_outcome(
        &base, &session_id, |id| manager.is_alive(id), |profile_id| cli_accounts::launch_tokens::recheck(
            &base, &cli_accounts::launch_tokens::OsLaunchTokenStore::new(&base), profile_id,
            |token| tauri::async_runtime::block_on(cli_accounts::token_owner::fetch_claude_launch_owner(token)))))
        .await.map_err(|_| cli_accounts::ERR_ACCOUNTS_UNAVAILABLE.to_string())?;
    let profile_id = outcome.token_record_saved_for.as_ref().or_else(|| match outcome.result.as_ref() {
        Ok(Some(evidence)) => Some(&evidence.profile_id),
        _ => None,
    });
    if let Some(profile_id) = profile_id {
        let _ = app.emit("tab-account-evidence-updated", serde_json::json!({ "profile_id": profile_id }));
    }
    outcome.result
}

async fn prewarm_claude_token(app: &AppHandle, token: &str) {
    let state = app.state::<crate::usage::UsageState>();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(6),
        cli_accounts::token_owner::claude_token_owner(&state.http, token)).await;
}

async fn prewarm_claude_live(app: &AppHandle) {
    if let Some(token) = cli_accounts::claude::ClaudePaths::resolve().ok()
        .and_then(|paths| cli_accounts::claude::read_credentials(&paths))
        .and_then(|text| cli_accounts::token_owner::claude_access_token(&text)) {
        prewarm_claude_token(app, &token).await;
    }
}

#[tauri::command(async)]
pub async fn capture_cli_account(
    _trusted: crate::ipc_caller::TrustedAppCaller, app: AppHandle, provider: CliProvider, label: Option<String>) -> Result<CliAccountProfile, String> {
    if provider == CliProvider::Claude {
        prewarm_claude_live(&app).await;
    }
    cli_accounts::capture_resolved(&app_data_dir(&app)?, provider, label)
}

#[tauri::command(async)]
pub async fn switch_cli_account(
    _trusted: crate::ipc_caller::TrustedAppCaller, app: AppHandle, provider: CliProvider, profile_id: String, api_request: Option<bool>) -> Result<CliSwitchResult, String> {
    let api_request = api_request.unwrap_or(false);
    crate::usage::logging::scope(api_request, switch_cli_account_inner(app, provider, profile_id, api_request)).await
}

async fn switch_cli_account_inner(app: AppHandle, provider: CliProvider, profile_id: String, api_request: bool) -> Result<CliSwitchResult, String> {
    let _activity = cli_accounts::api::switch_activity(provider, api_request)?;
    if crate::test_profile::is_active() {
        return Err("CLI account switching is disabled while a test profile is active".to_string());
    }
    let base = app_data_dir(&app)?;
    if api_request {
        cli_accounts::api::preflight_target(&base, provider, &profile_id)?;
    }
    if provider == CliProvider::Claude {
        prewarm_claude_live(&app).await;
        if let Some(token) = cli_accounts::claude_snapshot_access_token(&base, &profile_id) {
            prewarm_claude_token(&app, &token).await;
        }
    }
    let result = if api_request {
        cli_accounts::api::switch_resolved(&base, provider, &profile_id)
    } else {
        cli_accounts::switch_resolved(&base, provider, &profile_id)
    };
    if !api_request {
        if let Err(error) = &result {
            crate::usage::log_oauth_failure(&app, "switch_cli_account", error);
        }
    }
    result
}

#[tauri::command(async)]
pub async fn remove_cli_account(app: AppHandle, profile_id: String) -> Result<(), String> {
    let base = app_data_dir(&app)?;
    let manager = app.state::<crate::AppState>().session_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let provider = cli_accounts::registered_profile_provider(&base, &profile_id)?;
        if provider == CliProvider::Claude { return cli_accounts::remove_resolved(&base, &profile_id); }
        cli_accounts::account_homes::unregister_and(&base, provider, &profile_id, |id| manager.is_alive(id),
            || cli_accounts::remove_resolved(&base, &profile_id))
    }).await.map_err(|_| cli_accounts::ERR_REMOVE_FAILED.to_string())?
}

#[tauri::command(async)]
pub async fn rename_cli_account(app: AppHandle, profile_id: String, label: String) -> Result<CliAccountProfile, String> {
    cli_accounts::rename_resolved(&app_data_dir(&app)?, &profile_id, label)
}

#[tauri::command(async)]
pub async fn begin_cli_login(
    _trusted: crate::ipc_caller::TrustedAppCaller,
    app: AppHandle,
    provider: CliProvider,
    mode: Option<CliLoginMode>,
    expected_profile_id: Option<String>,
    purpose: Option<cli_accounts::account_homes::LoginPurpose>,
) -> Result<CliLoginSession, String> {
    let base = app_data_dir(&app).map_err(|_| cli_accounts::account_homes::ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?;
    if let Some(cli_accounts::account_homes::LoginPurpose::AccountHome { profile_id }) = purpose {
        let manager = app.state::<crate::AppState>().session_manager.clone();
        let home_base = base.clone();
        let status = tauri::async_runtime::spawn_blocking(move || {
            let source = cli_accounts::account_homes::global_home(provider)?;
            cli_accounts::account_homes::begin_login(&home_base, provider, &profile_id, |id| manager.is_alive(id), &source)
        }).await.map_err(|_| cli_accounts::account_homes::ERR_HOME_ISOLATION_UNAVAILABLE.to_string())??;
        cli_accounts::account_homes::spawn_login_watch(app, base, status.login_id.clone());
        return Ok(CliLoginSession { login_id: status.login_id, provider, command: String::new(), args: Vec::new(), env: HashMap::new(), staging_dir: String::new() });
    }

    let login_mode = match mode.unwrap_or(CliLoginMode::New) {
        CliLoginMode::New => LoginMode::New,
        CliLoginMode::Reauth => {
            let profile_id = expected_profile_id
                .ok_or_else(|| cli_accounts::ERR_PROFILE_NOT_FOUND.to_string())?;
            let base = base.clone();
            let expected_identity_key = run_blocking("cli login identity", move || {
                cli_accounts::profile_identity_key(&base, provider, &profile_id)
            })
            .await?;
            LoginMode::Reauth {
                expected_identity_key,
            }
        }
    };

    let staging_base = base.clone();
    let dir = run_blocking("cli login staging", move || {
        let dir = staging::create_staging_dir(&staging_base)?;
        if provider == CliProvider::Claude {
            // Best-effort onboarding skip; a failure only costs wizard clicks.
            if let Ok(live) = cli_accounts::claude::ClaudePaths::resolve() {
                staging::seed_claude_staging(&dir, &live);
            }
        }
        Ok(dir)
    })
    .await?;

    let login_id = Uuid::new_v4().simple().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    // Claiming the slot and starting the watcher happen after the directory
    // exists, so a refused claim can take its own staging directory with it.
    let claimed = app.state::<LoginRegistry>().try_insert(PendingLogin {
        login_id: login_id.clone(),
        provider,
        dir: dir.clone(),
        mode: login_mode.clone(),
        started_at: Instant::now(),
        cancel: cancel.clone(),
    });
    if !claimed {
        staging::cleanup_staging(&dir);
        return Err(cli_accounts::ERR_LOGIN_ALREADY_RUNNING.to_string());
    }

    cli_accounts::login_watch::spawn(
        app.clone(),
        base,
        LoginWatch {
            login_id: login_id.clone(),
            provider,
            dir,
            mode: login_mode,
            label: None,
            cancel,
        },
    );

    // Legacy fields stay empty for wire compatibility. Only the opaque ID is
    // returned; create_session resolves command/argv/home from LoginRegistry.
    Ok(CliLoginSession {
        login_id, provider, command: String::new(), args: Vec::new(),
        env: HashMap::new(), staging_dir: String::new(),
    })
}

#[tauri::command(async)]
pub async fn list_cli_account_homes(app: AppHandle) -> Result<Vec<cli_accounts::account_homes::AccountHomeStatus>, String> {
    let base = app_data_dir(&app).map_err(|_| cli_accounts::account_homes::ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?;
    tauri::async_runtime::spawn_blocking(move || cli_accounts::account_homes::list(&base))
        .await.map_err(|_| cli_accounts::account_homes::ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?
}

#[tauri::command(async)]
pub async fn get_cli_account_home_login(app: AppHandle, login_id: String) -> Result<cli_accounts::account_homes::HomeLoginStatus, String> {
    let base = app_data_dir(&app).map_err(|_| cli_accounts::account_homes::ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?;
    tauri::async_runtime::spawn_blocking(move || cli_accounts::account_homes::login_status(&base, &login_id))
        .await.map_err(|_| cli_accounts::account_homes::ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?
}

#[tauri::command(async)]
pub async fn unregister_cli_account_home(
    _trusted: crate::ipc_caller::TrustedAppCaller, app: AppHandle, provider: CliProvider, profile_id: String,
) -> Result<(), String> {
    let base = app_data_dir(&app).map_err(|_| cli_accounts::account_homes::ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?;
    let manager = app.state::<crate::AppState>().session_manager.clone();
    tauri::async_runtime::spawn_blocking(move || cli_accounts::account_homes::unregister(&base, provider, &profile_id, |id| manager.is_alive(id)))
        .await.map_err(|_| cli_accounts::account_homes::ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?
}

#[tauri::command(async)]
pub async fn cancel_cli_login(app: AppHandle, login_id: String) -> Result<(), String> {
    let base = app_data_dir(&app).map_err(|_| cli_accounts::account_homes::ERR_HOME_ISOLATION_UNAVAILABLE.to_string())?;
    if cli_accounts::account_homes::cancel_login(&base, &login_id)
        || app.state::<LoginRegistry>().request_cancel(&login_id) {
        return Ok(());
    }
    Err(cli_accounts::ERR_LOGIN_SESSION_NOT_FOUND.to_string())
}
