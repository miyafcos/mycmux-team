use std::{
    fs,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use tauri::{AppHandle, Emitter};

use super::{import::parse_mru, model::LauncherDirsView, scan, store};

static SCANNING: AtomicBool = AtomicBool::new(false);
const INTERVAL: Duration = Duration::from_secs(3 * 60 * 60);

struct ScanGuard;

impl Drop for ScanGuard {
    fn drop(&mut self) {
        SCANNING.store(false, Ordering::Release);
    }
}

pub async fn scan_now(app: AppHandle) -> Result<LauncherDirsView, String> {
    SCANNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "scan already running".to_string())?;
    let guard = ScanGuard;
    let view = tauri::async_runtime::spawn_blocking(move || {
        // The guard follows the blocking task even if its caller is cancelled.
        let _guard = guard;
        let snapshot = store::with_doc(|_| Ok(()))?.doc;
        let outcome = scan::run_all(&snapshot);
        let runtime = crate::test_profile::runtime_dir()?;
        let mru = fs::read_to_string(runtime.join("launch-dirs-mru.txt"))
            .map(|text| parse_mru(&text))
            .unwrap_or_default();
        store::with_doc(|doc| {
            scan::apply(doc, &outcome, &mru);
            Ok(())
        })
    })
    .await
    .map_err(|error| error.to_string())??;
    app.emit("launcher-dirs://changed", ())
        .map_err(|error| error.to_string())?;
    Ok(view)
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        let mut interval = tokio::time::interval(INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let schedule_app = app.clone();
            let due = tauri::async_runtime::spawn_blocking(move || {
                let view = store::with_doc(|_| Ok(()))?;
                if view.external_imported {
                    schedule_app.emit("launcher-dirs://changed", ()).map_err(|error| error.to_string())?;
                }
                let doc = view.doc;
                let at = doc
                    .last_scan
                    .as_ref()
                    .and_then(|value| value.get("at"))
                    .and_then(|value| value.as_str())
                    .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok());
                Ok::<_, String>(at.is_none_or(|at| {
                    chrono::Local::now().signed_duration_since(at).num_seconds()
                        >= INTERVAL.as_secs() as i64 - 60
                }))
            })
            .await;
            match due {
                Ok(Ok(true)) => {
                    if let Err(error) = scan_now(app.clone()).await {
                        if error != "scan already running" {
                            crate::diag_warn!("launcher_dirs", "scheduled scan failed: {error}");
                        }
                    }
                }
                Ok(Ok(false)) => {}
                Ok(Err(error)) => {
                    crate::diag_warn!("launcher_dirs", "scan schedule read failed: {error}")
                }
                Err(error) => {
                    crate::diag_warn!("launcher_dirs", "scan schedule task failed: {error}")
                }
            }
        }
    });
}
