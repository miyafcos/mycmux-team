use std::{
    collections::HashMap,
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::cli_accounts::{
    self,
    login_watch::{
        CliLoginMode, CliLoginSessionStatus, LoginMode, LoginRegistry, LoginWatch, PendingLogin,
    },
    staging, CliAccountProfile, CliAccountsSnapshot, CliProvider, CliSwitchResult,
};
use crate::util::task::run_blocking;

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("Failed to resolve application data directory: {e}"))
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
pub async fn capture_cli_account(app: AppHandle, provider: CliProvider, label: Option<String>) -> Result<CliAccountProfile, String> {
    cli_accounts::capture_resolved(&app_data_dir(&app)?, provider, label)
}

#[tauri::command(async)]
pub async fn switch_cli_account(app: AppHandle, provider: CliProvider, profile_id: String) -> Result<CliSwitchResult, String> {
    let result = cli_accounts::switch_resolved(&app_data_dir(&app)?, provider, &profile_id);
    if let Err(error) = &result {
        crate::usage::log_oauth_failure(&app, "switch_cli_account", error);
    }
    result
}

#[tauri::command(async)]
pub async fn remove_cli_account(app: AppHandle, profile_id: String) -> Result<(), String> {
    cli_accounts::remove_resolved(&app_data_dir(&app)?, &profile_id)
}

#[tauri::command(async)]
pub async fn rename_cli_account(app: AppHandle, profile_id: String, label: String) -> Result<CliAccountProfile, String> {
    cli_accounts::rename_resolved(&app_data_dir(&app)?, &profile_id, label)
}

#[tauri::command(async)]
pub async fn begin_cli_login(
    app: AppHandle,
    provider: CliProvider,
    mode: CliLoginMode,
    expected_profile_id: Option<String>,
) -> Result<CliLoginSession, String> {
    let base = app_data_dir(&app)?;

    let login_mode = match mode {
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

    let staging_dir = dir.display().to_string();
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

    let (command, args, env_key) = match provider {
        CliProvider::Claude => ("claude", Vec::new(), "CLAUDE_CONFIG_DIR"),
        CliProvider::Codex => ("codex", vec!["login".to_string()], "CODEX_HOME"),
    };
    Ok(CliLoginSession {
        login_id,
        provider,
        command: command.to_string(),
        args,
        env: HashMap::from([(env_key.to_string(), staging_dir.clone())]),
        staging_dir,
    })
}

#[tauri::command(async)]
pub async fn cancel_cli_login(app: AppHandle, login_id: String) -> Result<(), String> {
    if app.state::<LoginRegistry>().request_cancel(&login_id) {
        return Ok(());
    }
    Err(cli_accounts::ERR_LOGIN_SESSION_NOT_FOUND.to_string())
}

#[tauri::command(async)]
pub async fn list_cli_login_sessions(app: AppHandle) -> Result<Vec<CliLoginSessionStatus>, String> {
    Ok(app.state::<LoginRegistry>().list())
}
