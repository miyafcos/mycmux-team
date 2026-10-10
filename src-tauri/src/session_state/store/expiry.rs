//! One weak-owner driver for clock projections; no per-output sleeping tasks.
use super::{SessionRecord, SessionStateStore, StoreInner};
use crate::session_state::{derive_ui_state, Lifecycle, SessionView, UiSessionState, QUIET_AFTER_MS};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::sync::Notify;

const FRESHNESS_WAIT: Duration = Duration::from_secs(1);

pub(super) type ObservationProvider = Arc<dyn Fn(&str) -> Option<(u64, Option<u64>)> + Send + Sync>;
type WorkerFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
type WorkerWait = Arc<dyn Fn(WaitPlan) -> WorkerFuture + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct QuietDeadline {
    epoch: u64,
    output_at: u64,
    generation: u64,
    due_at: Option<u64>,
    armed: bool,
}

/// Protected attention, absent output and terminal epochs have no timer/watch.
pub(super) fn quiet_identity(view: &SessionView) -> Option<(u64, u64)> {
    if view.lifecycle == Lifecycle::Exited
        || derive_ui_state(view) != UiSessionState::Working
        || view.last_output_at == 0
    {
        return None;
    }
    Some((view.session_epoch?, view.last_output_at))
}

impl SessionRecord {
    pub(super) fn refresh_deadline(&mut self) -> bool {
        let identity = quiet_identity(&self.view);
        let next = identity.map(|(epoch, output_at)| {
            let due_at = output_at.checked_add(QUIET_AFTER_MS);
            QuietDeadline {
                epoch,
                output_at,
                generation: self.deadline_generation,
                due_at,
                armed: self.ui_state == UiSessionState::Working && due_at.is_some(),
            }
        });
        if next == self.quiet_deadline {
            return false;
        }
        self.deadline_generation = self.deadline_generation.saturating_add(1);
        self.quiet_deadline = next.map(|mut token| {
            token.generation = self.deadline_generation;
            token
        });
        true
    }
}

pub(super) struct WorkerSignal {
    started: AtomicBool,
    stopped: AtomicBool,
    wake: Notify,
}

impl WorkerSignal {
    pub(super) fn new() -> Self {
        Self {
            started: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            wake: Notify::new(),
        }
    }

    pub(super) fn reschedule(&self) {
        // notify_one retains a permit even before the driver starts waiting.
        self.wake.notify_one();
    }

    pub(super) fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        self.reschedule();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WaitPlan {
    sampled_at: u64,
    eligible_sessions: usize,
    delay: Option<Duration>,
}

impl SessionStateStore {
    /// Copy/drop all manager guards before returning. This callback only reads
    /// in-memory timestamps and must not recursively call gated store methods.
    pub(crate) fn set_observation_provider(&self, provider: ObservationProvider) {
        *self
            .inner
            .observation_provider
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(provider);
        self.inner.quiet_worker.reschedule();
    }

    /// Explicit setup only: constructing a store never needs an async runtime.
    pub(crate) fn start_quiet_worker(&self) -> bool {
        let wait: WorkerWait = Arc::new(|plan| {
            Box::pin(async move {
                match plan.delay {
                    Some(delay) => tokio::time::sleep(delay).await,
                    None => std::future::pending::<()>().await,
                }
            })
        });
        if let Some(task) = self.quiet_worker_task(wait) {
            tauri::async_runtime::spawn(task);
            true
        } else {
            false
        }
    }

    pub(crate) fn stop_quiet_worker(&self) {
        // No operation/map gate or async wait in the native shutdown callback.
        self.inner.quiet_worker.shutdown();
    }

    fn quiet_worker_task(&self, wait: WorkerWait) -> Option<WorkerFuture> {
        let signal = self.inner.quiet_worker.clone();
        if signal.stopped.load(Ordering::Acquire)
            || signal
                .started
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return None;
        }
        let owner: Weak<StoreInner> = Arc::downgrade(&self.inner);
        Some(Box::pin(async move {
            loop {
                // Arm before choosing the wait so an output arriving between
                // the pass and select cannot be lost. Only the signal (not the
                // store or manager) is owned across the await.
                let notified = signal.wake.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if signal.stopped.load(Ordering::Acquire) {
                    break;
                }
                let plan = {
                    let Some(inner) = owner.upgrade() else {
                        break;
                    };
                    SessionStateStore { inner }.quiet_worker_pass()
                };
                let Some(plan) = plan else {
                    break;
                };
                if signal.stopped.load(Ordering::Acquire) {
                    break;
                }
                tokio::select! {
                    biased;
                    _ = &mut notified => {},
                    _ = wait(plan) => {},
                }
            }
        }))
    }

    fn quiet_worker_pass(&self) -> Option<WaitPlan> {
        let _operation_guard = self.operation_guard();
        if self.inner.quiet_worker.stopped.load(Ordering::Acquire) {
            return None;
        }
        let now = (self.inner.clock)();
        // No collected token ever authorizes a mutation. Every wake samples
        // the latest canonical epoch/output/generation under this gate and
        // refreshes real reader timestamps before computing the projection.
        self.reconcile_locked(None, now);
        let mut eligible_sessions = 0;
        let mut delay = FRESHNESS_WAIT;
        for record in self.inner.sessions.iter() {
            let Some(token) = record.quiet_deadline else {
                continue;
            };
            eligible_sessions += 1;
            if token.armed && now != 0 && now >= token.output_at {
                if let Some(remaining) = token.due_at.and_then(|due| due.checked_sub(now)) {
                    if remaining > 0 {
                        delay = delay.min(Duration::from_millis(remaining));
                    }
                }
            }
        }
        // Elapsed/overflowed deadlines retain a one-second freshness watch,
        // never a zero wait. No eligible records means notification-only sleep.
        Some(WaitPlan {
            sampled_at: now,
            eligible_sessions,
            delay: (eligible_sessions > 0).then_some(delay),
        })
    }
}

#[cfg(test)]
mod tests;
