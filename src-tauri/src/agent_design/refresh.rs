use super::*;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use tokio::sync::watch;

const CACHE_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const REFRESHED_EVENT: &str = "agent-design-refreshed";
static JOBS: OnceLock<Arc<RefreshJobs>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct History {
    schema_version: u8,
    contexts: Vec<Context>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Context {
    schema_version: u8,
    home: String,
    cwd: String,
    work_folder: String,
    generator: String,
}

fn work_folder(home: &Path, args: &Value) -> Result<PathBuf, String> {
    let object = args.as_object().ok_or("workFolderInvalid")?;
    let path = match object.get("workFolder") {
        Some(Value::Null) => return cwd_or_home(None, home),
        Some(Value::String(value)) => PathBuf::from(value),
        _ => return Err("workFolderInvalid".into()),
    };
    if !path.is_absolute() {
        return Err("workFolderUnknown".into());
    }
    let home_key = safe::normalized(home);
    let folder_key = safe::normalized(&path);
    if folder_key != home_key {
        // Deserialize only history headers. Document bodies never need to be
        // allocated just to decide whether a folder is a permitted context.
        let known = safe::text(&state_dir(home).join("cache.json"), CACHE_BYTES)
            .and_then(|text| serde_json::from_str::<History>(&text).ok())
            .filter(|cache| cache.schema_version == 1)
            .is_some_and(|cache| cache.contexts.iter().any(|context| {
                context.schema_version == 1
                    && !context.generator.is_empty()
                    && context.work_folder == context.cwd
                    && safe::normalized(Path::new(&context.home)) == home_key
                    && safe::normalized(Path::new(&context.work_folder)) == folder_key
            }));
        if !known {
            return Err("workFolderUnknown".into());
        }
    }
    cwd_or_home(Some(path.to_string_lossy().into()), home)
}

#[derive(Default)]
struct RefreshJobs {
    running: Mutex<BTreeMap<String, Arc<RefreshJob>>>,
}

struct RefreshJob {
    started_at: String,
    result: watch::Sender<Option<Result<Catalog, String>>>,
    notifying: AtomicBool,
}

pub(super) struct Started {
    job: Arc<RefreshJob>,
    already_running: bool,
}

impl Started {
    fn acknowledgement(&self) -> Value {
        if self.already_running {
            json!({"accepted": true, "alreadyRunning": true})
        } else {
            json!({"accepted": true, "startedAt": self.job.started_at})
        }
    }

    pub(super) async fn wait(&self) -> Result<Catalog, String> {
        let mut result = self.job.result.subscribe();
        loop {
            if let Some(value) = result.borrow_and_update().clone() {
                return value;
            }
            result.changed().await.map_err(|_| "refreshUnavailable")?;
        }
    }
}

impl RefreshJobs {
    fn start<F>(self: &Arc<Self>, key: String, task: F) -> Result<Started, String>
    where F: FnOnce() -> Result<Catalog, String> + Send + 'static {
        let mut running = self.running.lock().map_err(|_| "stateUnavailable")?;
        if let Some(job) = running.get(&key) {
            return Ok(Started { job: job.clone(), already_running: true });
        }
        let (result, _) = watch::channel(None);
        let job = Arc::new(RefreshJob {
            started_at: chrono::Utc::now().to_rfc3339(),
            result,
            notifying: AtomicBool::new(false),
        });
        running.insert(key.clone(), job.clone());
        let jobs = self.clone();
        let result = job.result.clone();
        tauri::async_runtime::spawn(async move {
            let value = run_blocking("agent_design_refresh", task).await;
            // A failed or panicking worker must not leave a permanent running
            // marker. Finish before publishing the result to UI/socket waiters.
            if let Ok(mut running) = jobs.running.lock() {
                running.remove(&key);
            }
            result.send_replace(Some(value));
        });
        Ok(Started { job, already_running: false })
    }
}

pub(super) fn queue(home: PathBuf, cwd: PathBuf) -> Result<Started, String> {
    let key = format!("{}\0{}", safe::normalized(&home), safe::normalized(&cwd));
    JOBS.get_or_init(|| Arc::new(RefreshJobs::default())).start(key, move || {
        let codex = codex_root(&home);
        let hermes = hermes_root(&home);
        refresh_catalog(&home, &cwd, &codex, &hermes, versions(&home))
    })
}

pub(crate) async fn socket_refresh(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    use tauri::Emitter;
    let started = run_blocking("agent_design_refresh_start", move || {
        let home = home()?;
        let cwd = work_folder(&home, &args)?;
        queue(home, cwd)
    }).await?;
    let acknowledgement = started.acknowledgement();
    if !started.job.notifying.swap(true, Ordering::AcqRel) {
        tauri::async_runtime::spawn(async move {
            match started.wait().await {
                Ok(catalog) => {
                    let _ = app.emit(REFRESHED_EVENT, json!({"workFolder": catalog.work_folder}));
                }
                Err(error) => crate::diag_warn!("agent-design", "Background refresh failed: {}", error),
            }
        });
    }
    Ok(acknowledgement)
}

#[cfg(test)]
#[path = "refresh_tests.rs"]
mod tests;
