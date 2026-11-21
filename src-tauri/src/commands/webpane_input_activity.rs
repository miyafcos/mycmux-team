use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub(in crate::commands) const PROOF_AGE_MS: u64 = 2_000;
pub(in crate::commands) const CLOCK_SKEW_MS: u64 = 100;
const INPUT_GRACE_MS: u64 = 1_500;

pub(in crate::commands) fn unix_millis() -> u64 {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
}

#[cfg_attr(not(any(windows, target_os = "macos", test)), allow(dead_code))]
struct InputInterval {
    #[cfg(any(windows, target_os = "macos", test))]
    id: u64,
    #[cfg(any(windows, target_os = "macos", test))]
    window: Option<String>,
    start: u64,
    returned: Option<u64>,
    pending: usize,
    last_reply: u64,
}

impl InputInterval {
    #[cfg(any(windows, target_os = "macos", test))]
    fn decrement_pending(&mut self) {
        debug_assert!(self.pending > 0, "web pane input has no pending reply");
        self.pending = self.pending.saturating_sub(1);
    }

    fn end(&self) -> Option<u64> {
        if self.pending != 0 {
            return None;
        }
        self.returned.map(|returned| returned.max(self.last_reply))
    }

    fn blocks(&self, pressed: u64) -> bool {
        self.end().is_none_or(|end| {
            (self.start.saturating_sub(CLOCK_SKEW_MS)..=end.saturating_add(INPUT_GRACE_MS))
                .contains(&pressed)
        })
    }
}

#[derive(Default)]
pub(in crate::commands) struct InputIntervals {
    tabs: HashMap<String, Vec<InputInterval>>,
    #[cfg(any(windows, target_os = "macos", test))]
    next_id: u64,
}

impl InputIntervals {
    pub(in crate::commands) fn waiting_for_reply(&self, label: &str) -> bool {
        self.tabs.get(label).is_some_and(|intervals| {
            intervals.iter().any(|interval| interval.pending > 0)
        })
    }

    pub(in crate::commands) fn blocks(&self, label: &str, pressed: u64, now: u64) -> bool {
        self.tabs.get(label).is_some_and(|intervals| {
            intervals.iter().any(|interval| Self::relevant(interval, now) && interval.blocks(pressed))
        })
    }

    fn relevant(interval: &InputInterval, now: u64) -> bool {
        interval.end().is_none_or(|end| now <= end.saturating_add(INPUT_GRACE_MS + PROOF_AGE_MS))
    }

    fn prune(&mut self, now: u64) {
        self.tabs.retain(|_, intervals| {
            intervals.retain(|interval| Self::relevant(interval, now));
            !intervals.is_empty()
        });
    }
}

#[cfg(any(windows, target_os = "macos", test))]
impl InputIntervals {
    fn forget_webview(&mut self, label: &str) {
        self.tabs.remove(label);
    }

    fn forget_window(&mut self, label: &str) {
        self.tabs.retain(|_, intervals| {
            intervals.retain(|interval| interval.window.as_deref() != Some(label));
            !intervals.is_empty()
        });
    }
}

fn lock(table: &Mutex<InputIntervals>) -> MutexGuard<'_, InputIntervals> {
    table.lock().unwrap_or_else(|error| error.into_inner())
}

fn shared_activity() -> &'static Mutex<InputIntervals> {
    static ACTIVITY: OnceLock<Mutex<InputIntervals>> = OnceLock::new();
    ACTIVITY.get_or_init(Mutex::default)
}

pub(in crate::commands) fn activity_at(now: u64) -> MutexGuard<'static, InputIntervals> {
    let mut table = lock(shared_activity());
    table.prune(now);
    table
}

#[cfg(any(windows, target_os = "macos"))]
pub(in crate::commands) fn forget_webview(label: &str) {
    lock(shared_activity()).forget_webview(label);
}

#[cfg(any(windows, target_os = "macos"))]
pub(super) fn forget_window(label: &str) {
    lock(shared_activity()).forget_window(label);
}

#[cfg(any(windows, target_os = "macos", test))]
pub(in crate::commands) struct InputAttempt<'a> {
    receipt: InputReceipt<'a>,
    clock: fn() -> u64,
}

#[cfg(any(windows, target_os = "macos"))]
impl InputAttempt<'static> {
    pub(super) fn begin(label: &str, window: Option<String>) -> Self {
        Self::begin_in(shared_activity(), label, window, unix_millis(), unix_millis)
    }
}

#[cfg(any(windows, target_os = "macos", test))]
impl<'a> InputAttempt<'a> {
    pub(in crate::commands) fn begin_in(
        table: &'a Mutex<InputIntervals>,
        label: &str,
        window: Option<String>,
        start: u64,
        clock: fn() -> u64,
    ) -> Self {
        let mut intervals = lock(table);
        intervals.prune(start);
        let id = intervals.next_id;
        intervals.next_id += 1;
        intervals.tabs.entry(label.to_owned()).or_default().push(InputInterval {
            id, window, start, pending: 0, returned: None, last_reply: start,
        });
        Self { receipt: InputReceipt { table, label: label.to_owned(), id }, clock }
    }

    pub(in crate::commands) fn receipt(&self) -> InputReceipt<'a> {
        self.receipt.clone()
    }
}

#[cfg(any(windows, target_os = "macos", test))]
impl Drop for InputAttempt<'_> {
    fn drop(&mut self) {
        let now = (self.clock)();
        self.receipt.update(|interval| interval.returned = Some(now));
    }
}

/// A callback can outlive the async command. The ID is never reused when a tab
/// is recreated, so a callback for a destroyed webview can't change its replacement.
#[cfg(any(windows, target_os = "macos", test))]
#[derive(Clone)]
pub(in crate::commands) struct InputReceipt<'a> {
    table: &'a Mutex<InputIntervals>,
    label: String,
    id: u64,
}

#[cfg(any(windows, target_os = "macos", test))]
impl InputReceipt<'_> {
    fn update<T>(&self, update: impl FnOnce(&mut InputInterval) -> T) -> Option<T> {
        lock(self.table).tabs.get_mut(&self.label)?
            .iter_mut().find(|interval| interval.id == self.id).map(update)
    }

    pub(in crate::commands) fn begin_pending(&self) -> bool {
        self.update(|interval| {
            if interval.returned.is_some() {
                return false;
            }
            interval.pending += 1;
            true
        }).unwrap_or(false)
    }

    pub(in crate::commands) fn cancel_pending(&self) {
        self.update(InputInterval::decrement_pending);
    }

    pub(in crate::commands) fn complete(&self, now: u64) {
        self.update(|interval| {
            interval.decrement_pending();
            interval.last_reply = interval.last_reply.max(now);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: u64 = 1_800_000_000_000;
    const LABEL: &str = "web-pane-source";
    const OTHER: &str = "web-pane-other";
    const HOUR: u64 = 3_600_000;

    fn attempt<'a>(table: &'a Mutex<InputIntervals>, label: &str) -> InputAttempt<'a> {
        InputAttempt::begin_in(table, label, Some("main".into()), START, || START + 600)
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "web pane input has no pending reply")]
    fn cancelling_a_reply_reports_underflow_in_a_debug_build() {
        let table = Mutex::default();
        attempt(&table, LABEL).receipt().cancel_pending();
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "web pane input has no pending reply")]
    fn completing_a_reply_reports_underflow_in_a_debug_build() {
        let table = Mutex::default();
        attempt(&table, LABEL).receipt().complete(START + 10);
    }

    #[test]
    fn renderer_termination_ends_only_its_own_wait_and_ignores_late_replies() {
        let table = Mutex::default();
        let input = attempt(&table, LABEL);
        let survivor = attempt(&table, OTHER);
        let receipt = input.receipt();
        assert!(receipt.begin_pending());
        assert!(survivor.receipt().begin_pending());
        let now = START + 200;
        assert!(lock(&table).blocks(LABEL, now, now));

        lock(&table).forget_webview(LABEL);
        assert!(!lock(&table).blocks(LABEL, now, now));
        assert!(lock(&table).blocks(OTHER, now, now));
        assert!(!receipt.begin_pending());

        let replacement = InputAttempt::begin_in(&table, LABEL, None, now, || START + 250);
        assert!(replacement.receipt().begin_pending());
        receipt.complete(now + 1);
        drop(input);
        assert!(lock(&table).waiting_for_reply(LABEL));
        replacement.receipt().complete(now + 2);
        assert!(!lock(&table).waiting_for_reply(LABEL));
    }

    #[test]
    fn blocks_the_press_during_input_and_during_the_following_grace_period() {
        let table = Mutex::default();
        let input = attempt(&table, LABEL);
        assert!(lock(&table).blocks(LABEL, START, START + 500));
        drop(input);
        let intervals = lock(&table);
        assert!(intervals.blocks(LABEL, START - 100, START + 900));
        assert!(!intervals.blocks(LABEL, START - 101, START + 900));
        assert!(intervals.blocks(LABEL, START + 2_100, START + 2_101));
        assert!(!intervals.blocks(LABEL, START + 2_101, START + 2_101));
    }

    #[test]
    fn blocks_a_held_proof_after_the_arrival_grace_period() {
        let table = Mutex::default();
        drop(InputAttempt::begin_in(&table, LABEL, None, START, || START + 10));
        let intervals = lock(&table);
        assert!(intervals.blocks(LABEL, START + 5, START + 1_610));
        assert!(intervals.blocks(LABEL, START + 20, START + 1_610));
        assert!(!intervals.blocks(LABEL, START + 1_611, START + 1_611));
    }

    #[test]
    fn blocks_at_arrival_when_an_input_is_active_even_for_an_earlier_press() {
        let table = Mutex::default();
        let input = attempt(&table, LABEL);
        assert!(lock(&table).blocks(LABEL, START - 500, START + 50));
        drop(input);
        assert!(!lock(&table).blocks(LABEL, START - 500, START + 700));
    }

    #[test]
    fn command_without_return_blocks_even_an_hour_later() {
        let table = Mutex::default();
        let _input = attempt(&table, LABEL);
        assert!(lock(&table).blocks(LABEL, START + HOUR, START + HOUR));
        assert!(!lock(&table).blocks(OTHER, START + HOUR, START + HOUR));
    }

    #[test]
    fn dropping_a_future_before_native_input_records_its_return() {
        let table = Mutex::default();
        let input = attempt(&table, LABEL);
        let receipt = input.receipt();
        let future = async move {
            let _input = input;
            std::future::pending::<()>().await;
        };
        drop(future);
        assert!(!receipt.begin_pending());
        let intervals = lock(&table);
        assert!(intervals.blocks(LABEL, START + 2_100, START + 2_100));
        assert!(!intervals.blocks(LABEL, START + 2_101, START + 2_101));
    }

    #[test]
    fn late_reply_extends_the_grace_after_the_waiter_is_dropped() {
        let table = Mutex::default();
        let input = attempt(&table, LABEL);
        let receipt = input.receipt();
        assert!(receipt.begin_pending());
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let future = async move { let _input = input; let _ = rx.await; };
        drop(future);
        lock(&table).prune(START + HOUR);
        assert!(lock(&table).blocks(LABEL, START + HOUR - 1, START + HOUR));
        assert!(tx.send(()).is_err());
        receipt.complete(START + HOUR);
        let intervals = lock(&table);
        assert!(intervals.blocks(LABEL, START + HOUR + 1_500, START + HOUR + 1_500));
        assert!(!intervals.blocks(LABEL, START + HOUR + 1_501, START + HOUR + 1_501));
    }

    #[test]
    fn overlapping_commands_keep_their_independent_completion_windows() {
        let table = Mutex::default();
        let input1 = attempt(&table, LABEL);
        let receipt1 = input1.receipt();
        let input2 = attempt(&table, LABEL);
        let receipt2 = input2.receipt();
        assert!(receipt1.begin_pending());
        assert!(receipt2.begin_pending());
        assert!(receipt2.begin_pending());
        drop(input1);
        drop(input2);
        receipt1.complete(START + 20);
        receipt2.complete(START + 3_000);
        assert!(lock(&table).blocks(LABEL, START + HOUR, START + HOUR));
        receipt2.complete(START + 3_100);
        let intervals = lock(&table);
        assert!(intervals.blocks(LABEL, START + 4_600, START + 4_600));
        assert!(!intervals.blocks(LABEL, START + 4_601, START + 4_601));
    }

    #[test]
    fn failed_dispatch_cancels_pending_and_uses_return_for_expiry() {
        let table = Mutex::default();
        let input = attempt(&table, LABEL);
        let receipt = input.receipt();
        assert!(receipt.begin_pending());
        receipt.cancel_pending();
        drop(input);
        let mut intervals = lock(&table);
        assert!(intervals.blocks(LABEL, START + 2_100, START + 2_100));
        assert!(!intervals.blocks(LABEL, START + 2_101, START + 2_101));
        intervals.prune(START + 4_100);
        assert!(intervals.tabs.contains_key(LABEL));
        intervals.prune(START + 4_101);
        assert!(!intervals.tabs.contains_key(LABEL));
    }

    #[test]
    fn destroyed_webview_drops_the_record_and_ignores_old_completions() {
        let table = Mutex::default();
        let old = attempt(&table, LABEL);
        let old_receipt = old.receipt();
        assert!(old_receipt.begin_pending());
        lock(&table).forget_webview(LABEL);
        assert!(!lock(&table).blocks(LABEL, START, START));
        let recreated = attempt(&table, LABEL);
        let new_receipt = recreated.receipt();
        assert!(new_receipt.begin_pending());
        drop(recreated);
        old_receipt.complete(START + 10);
        drop(old);
        assert!(lock(&table).blocks(LABEL, START + HOUR, START + HOUR));
        new_receipt.complete(START + 100);
        assert!(!lock(&table).blocks(LABEL, START + HOUR, START + HOUR));
    }

    #[test]
    fn window_destruction_clears_only_its_own_attempts() {
        let table = Mutex::default();
        let _old = attempt(&table, LABEL);
        let _new = InputAttempt::begin_in(&table, OTHER, Some("other".into()), START, || START);
        let mut intervals = lock(&table);
        intervals.forget_window("main");
        assert!(!intervals.blocks(LABEL, START, START));
        assert!(intervals.blocks(OTHER, START, START));
    }
}
