//! A shutdown worker owns all filesystem and PTY teardown. The native exit
//! callback only waits for its completion, with one deadline for the whole job.
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

pub(crate) const SHUTDOWN_BUDGET: Duration = Duration::from_secs(3);

pub(crate) struct Cleanup {
    completion: Mutex<mpsc::Receiver<()>>,
    deadline: Instant,
}

impl Cleanup {
    pub(crate) fn start(budget: Duration, task: impl FnOnce(Instant) + Send + 'static) -> Result<Self, String> {
        let deadline = Instant::now() + budget;
        let (done, completion) = mpsc::channel();
        std::thread::Builder::new().name("mycmux-shutdown".into()).spawn(move || {
            task(deadline);
            let _ = done.send(());
        }).map_err(|error| format!("start shutdown worker: {error}"))?;
        Ok(Self { completion: Mutex::new(completion), deadline })
    }

    pub(crate) fn wait(&self) -> bool {
        self.completion.lock().unwrap_or_else(|p| p.into_inner())
            .recv_timeout(self.deadline.saturating_duration_since(Instant::now())).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn blocked_shutdown_io_runs_on_another_thread_and_exit_returns_at_the_deadline() {
        let lock = Arc::new(Mutex::new(()));
        let held = lock.lock().unwrap();
        let worker_lock = lock.clone();
        let caller = std::thread::current().id();
        let (entered_tx, entered_rx) = mpsc::channel();
        let cleanup = Cleanup::start(Duration::from_millis(60), move |_| {
            entered_tx.send(std::thread::current().id()).unwrap();
            let _guard = worker_lock.lock().unwrap();
        }).unwrap();
        assert_ne!(entered_rx.recv_timeout(Duration::from_secs(1)).unwrap(), caller);
        let started = Instant::now();
        assert!(!cleanup.wait());
        assert!(started.elapsed() < Duration::from_millis(500));
        // Repeated exit notifications never grant a second waiting budget.
        assert!(!cleanup.wait());
        drop(held);
        assert!(cleanup.completion.lock().unwrap().recv_timeout(Duration::from_secs(1)).is_ok());
    }

    #[test]
    fn completed_shutdown_is_observed_without_spending_the_wait_budget() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let cleanup = Cleanup::start(Duration::from_secs(3), move |_| { entered_tx.send(()).unwrap(); }).unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(cleanup.wait());
    }
}
