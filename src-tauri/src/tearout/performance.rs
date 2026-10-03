//! Bounded drag diagnostics and display-rate sample pacing, without UI work.
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Instant,
};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Distribution {
    pub count: u64,
    pub median: Option<f64>,
    pub p95: Option<f64>,
    pub max: Option<f64>,
    pub over20: u64,
    pub over33: u64,
}

/// 0.25-unit bins up to 128, with an overflow bin and an exact maximum.
pub struct Histogram {
    bins: [u64; 513],
    count: u64,
    max: f64,
    over20: u64,
    over33: u64,
}
impl Default for Histogram {
    fn default() -> Self {
        Self {
            bins: [0; 513],
            count: 0,
            max: 0.0,
            over20: 0,
            over33: 0,
        }
    }
}
impl Histogram {
    pub fn add(&mut self, value: f64) {
        if !value.is_finite() || value < 0.0 {
            return;
        }
        let index = ((value * 4.0).ceil() as usize).min(512);
        self.bins[index] += 1;
        self.count += 1;
        self.max = self.max.max(value);
        self.over20 += u64::from(value > 20.0);
        self.over33 += u64::from(value > 33.0);
    }
    pub fn summary(&self) -> Distribution {
        let percentile = |fraction: f64| {
            if self.count == 0 {
                return None;
            }
            let wanted = (self.count as f64 * fraction).ceil() as u64;
            let mut count = 0;
            for (index, n) in self.bins.iter().enumerate() {
                count += n;
                if count >= wanted {
                    return Some(if index == 512 {
                        self.max
                    } else {
                        index as f64 / 4.0
                    });
                }
            }
            Some(self.max)
        };
        Distribution {
            count: self.count,
            median: percentile(0.5),
            p95: percentile(0.95),
            max: (self.count > 0).then_some(self.max),
            over20: self.over20,
            over33: self.over33,
        }
    }
}

#[derive(Default)]
pub struct SamplePacer {
    last_at: Option<u64>,
    receiver: Option<String>,
    x: f64,
    y: f64,
}
impl SamplePacer {
    /// Edges and lifecycle are never delayed; dwell still gets fresh samples.
    pub fn allow(
        &mut self,
        at: u64,
        receiver: Option<&str>,
        x: f64,
        y: f64,
        lifecycle: bool,
        approved: bool,
        legacy: bool,
    ) -> bool {
        let changed_receiver = self.receiver.as_deref() != receiver;
        let stationary = self.x == x && self.y == y;
        let interval = if receiver.is_none() || stationary && approved {
            120
        } else {
            16
        };
        if !legacy
            && !lifecycle
            && !changed_receiver
            && self
                .last_at
                .is_some_and(|last| at.saturating_sub(last) < interval)
        {
            return false;
        }
        self.last_at = Some(at);
        self.receiver = receiver.map(str::to_owned);
        self.x = x;
        self.y = y;
        true
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeSummary {
    pub elapsed_ms: f64,
    pub polled: u64,
    pub emitted: u64,
    pub delivered: u64,
    pub samples_per_second: f64,
    pub receiver_scan_ms: Distribution,
    pub emit_work_ms: Distribution,
    pub main_thread_wait_ms: Distribution,
    pub main_thread_probe_skipped: u64,
    pub cursor_window_lag_px: Distribution,
    pub diagnostic_probe: bool,
    pub legacy_samples: bool,
}

#[derive(Default)]
struct Work {
    receiver: Histogram,
    emit: Histogram,
    wait: Histogram,
    lag: Histogram,
}
pub struct NativeMetrics {
    start: Instant,
    work: Mutex<Work>,
    pub enabled: AtomicBool,
    pub probe: AtomicBool,
    pub legacy: AtomicBool,
    pub probe_started: AtomicBool,
    pub probe_pending: AtomicBool,
    pub probe_skipped: AtomicU64,
    polled: AtomicU64,
    emitted: AtomicU64,
    delivered: AtomicU64,
}
impl Default for NativeMetrics {
    fn default() -> Self {
        Self {
            start: Instant::now(),
            work: Mutex::new(Work::default()),
            enabled: AtomicBool::new(true),
            probe: AtomicBool::new(false),
            legacy: AtomicBool::new(false),
            probe_started: AtomicBool::new(false),
            probe_pending: AtomicBool::new(false),
            probe_skipped: AtomicU64::new(0),
            polled: AtomicU64::new(0),
            emitted: AtomicU64::new(0),
            delivered: AtomicU64::new(0),
        }
    }
}
impl NativeMetrics {
    pub fn poll(&self, scan_ms: Option<f64>) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        self.polled.fetch_add(1, Ordering::Relaxed);
        if let Some(scan_ms) = scan_ms {
            self.work
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .receiver
                .add(scan_ms);
        }
    }
    pub fn emit(&self, work_ms: f64, delivered: usize) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        self.emitted.fetch_add(1, Ordering::Relaxed);
        self.delivered
            .fetch_add(delivered as u64, Ordering::Relaxed);
        self.work
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .emit
            .add(work_ms);
    }
    pub fn wait(&self, ms: f64) {
        self.work
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .wait
            .add(ms);
    }
    pub fn lag(&self, px: f64) {
        if self.enabled.load(Ordering::Relaxed) {
            self.work
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .lag
                .add(px);
        }
    }
    pub fn summary(&self) -> NativeSummary {
        let elapsed_ms = self.start.elapsed().as_secs_f64() * 1000.0;
        let emitted = self.emitted.load(Ordering::Relaxed);
        let work = self.work.lock().unwrap_or_else(|e| e.into_inner());
        NativeSummary {
            elapsed_ms,
            polled: self.polled.load(Ordering::Relaxed),
            emitted,
            delivered: self.delivered.load(Ordering::Relaxed),
            samples_per_second: emitted as f64 * 1000.0 / elapsed_ms.max(1.0),
            receiver_scan_ms: work.receiver.summary(),
            emit_work_ms: work.emit.summary(),
            main_thread_wait_ms: work.wait.summary(),
            main_thread_probe_skipped: self.probe_skipped.load(Ordering::Relaxed),
            cursor_window_lag_px: work.lag.summary(),
            diagnostic_probe: self.probe.load(Ordering::Relaxed),
            legacy_samples: self.legacy.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pacing_preserves_receiver_edges_end_and_dwell() {
        let mut p = SamplePacer::default();
        assert!(p.allow(0, Some("a"), 1.0, 1.0, true, false, false));
        assert!(!p.allow(8, Some("a"), 2.0, 1.0, false, false, false));
        assert!(p.allow(16, Some("a"), 3.0, 1.0, false, false, false));
        assert!(p.allow(17, Some("b"), 3.0, 1.0, false, false, false));
        assert!(p.allow(18, None, -1.0, -1.0, false, false, false));
        assert!(p.allow(19, None, -1.0, -1.0, true, false, false));
        let mut p = SamplePacer::default();
        let sent: Vec<_> = (0..=160)
            .step_by(8)
            .filter(|at| p.allow(*at, Some("a"), 1.0, 1.0, false, false, false))
            .collect();
        assert!(sent.contains(&128)); // Fresh dwell sample after 120ms.
        assert_eq!(sent.len(), 11);
    }
    #[test]
    fn stationary_approved_samples_are_bounded_and_motion_resumes() {
        let mut p = SamplePacer::default();
        assert!(p.allow(0, Some("a"), 1.0, 1.0, true, true, false));
        for at in (8..120).step_by(8) {
            assert!(!p.allow(at, Some("a"), 1.0, 1.0, false, true, false));
        }
        assert!(p.allow(120, Some("a"), 1.0, 1.0, false, true, false));
        assert!(p.allow(136, Some("a"), 2.0, 1.0, false, true, false));
        assert!(p.allow(137, Some("a"), 2.0, 1.0, false, true, true));
    }
    #[test]
    fn histogram_is_bounded_ignores_invalid_values_and_keeps_exact_max() {
        let mut h = Histogram::default();
        for _ in 0..100_000 {
            h.add(16.7);
        }
        h.add(1000.1);
        h.add(f64::NAN);
        h.add(-1.0);
        let s = h.summary();
        assert_eq!(s.count, 100_001);
        assert_eq!(s.p95, Some(16.75));
        assert_eq!(s.max, Some(1000.1));
        assert_eq!(s.over33, 1);
        assert_eq!(h.bins.len(), 513);
    }
}
