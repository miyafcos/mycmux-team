use super::*;

/// Number of dedicated worker threads that run `git rev-parse` off the
/// monitor thread. A small fixed pool bounds concurrent `git` child
/// processes while still letting several slow CWDs resolve in parallel
/// instead of serially blocking every session behind them (RS-5).
pub(super) const GIT_BRANCH_WORKER_COUNT: usize = 4;

/// A CWD that needs its git branch (re-)resolved.
pub(super) struct GitBranchRequest {
    pub(super) session_id: String,
    pub(super) cwd: String,
}

/// Result of resolving `GitBranchRequest` on a worker thread. `cwd` is
/// echoed back so the monitor loop can tell whether the CWD moved on
/// again while the request was in flight.
pub(super) struct GitBranchResult {
    pub(super) session_id: String,
    pub(super) cwd: String,
    pub(super) git_branch: Option<String>,
}

/// Spawn the fixed-size git-detection worker pool and return the sender used
/// to submit CWD lookups. All workers pull from the same request queue (a
/// `Mutex`-guarded `Receiver`, the standard way to fan a single mpsc channel
/// out to multiple consumers) so bursts of simultaneous CWD changes are
/// resolved concurrently rather than one-at-a-time on the monitor thread.
///
/// Each worker calls `git_branch_with_timeout`, which still owns the
/// kill+wait guarantee on timeout (R-1, CHANGELOG 0.9.2) — moving the call
/// off the monitor thread does not change that guarantee, it only changes
/// which thread blocks for up to `timeout` while enforcing it.
pub(super) fn spawn_git_branch_workers(
    result_tx: mpsc::Sender<GitBranchResult>,
) -> mpsc::Sender<GitBranchRequest> {
    let (request_tx, request_rx) = mpsc::channel::<GitBranchRequest>();
    let request_rx = Arc::new(Mutex::new(request_rx));

    for _ in 0..GIT_BRANCH_WORKER_COUNT {
        let request_rx = Arc::clone(&request_rx);
        let result_tx = result_tx.clone();
        thread::spawn(move || {
            loop {
                let request = {
                    // Only the `recv()` call itself needs the lock; it is
                    // released again as soon as a request is dequeued (or the
                    // channel closes), so other idle workers can immediately
                    // claim the next queued request instead of queueing
                    // behind this one's git invocation.
                    let rx = request_rx.lock().unwrap_or_else(|e| e.into_inner());
                    rx.recv()
                };
                let Ok(request) = request else {
                    // Sender dropped (monitor thread exiting) — stop the worker.
                    break;
                };
                let git_branch = git_branch_with_timeout(&request.cwd, Duration::from_secs(2));
                let sent = result_tx.send(GitBranchResult {
                    session_id: request.session_id,
                    cwd: request.cwd,
                    git_branch,
                });
                if sent.is_err() {
                    // Receiver dropped — monitor thread is gone, no point continuing.
                    break;
                }
            }
        });
    }

    request_tx
}

/// Run `git rev-parse --abbrev-ref HEAD` in `cwd` with a hard timeout.
/// The child is killed on timeout so a hung git (e.g. on a slow network
/// filesystem) does not leak a process + thread per CWD change.
pub(super) fn git_branch_with_timeout(cwd: &str, timeout: Duration) -> Option<String> {
    let mut git_cmd = Command::new("git");
    git_cmd
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    git_cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = git_cmd.spawn().ok()?;
    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    use std::io::Read;
                    let _ = pipe.read_to_string(&mut stdout);
                }
                return if status.success() {
                    Some(stdout.trim().to_string())
                } else {
                    None
                };
            }
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    #[cfg(debug_assertions)]
                    {
                        eprintln!("[monitor] git rev-parse timed out for {}", cwd);
                    }
                    return None;
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}
