//! Opt-in, single-session aggregates. No per-read rows or unbounded sample list.
use super::PerfMark;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static ENABLED: AtomicBool = AtomicBool::new(false);
static GENERATION: AtomicU64 = AtomicU64::new(0);
const STAGES: [&str; 10] = [
    "read",
    "read_process",
    "queue",
    "collect",
    "reserve",
    "channel",
    "flush_delay",
    "queue_drop",
    "auto_consume",
    "channel_error",
];

#[derive(Clone, Copy)]
pub(crate) enum FlowStage {
    Read,
    ReadProcess,
    Queue,
    Collect,
    Reserve,
    Channel,
    FlushDelay,
    QueueDrop,
    AutoConsume,
    ChannelError,
}

#[derive(Clone, Copy)]
pub(crate) struct FlowToken {
    generation: u64,
    started: Instant,
}

impl FlowToken {
    pub(crate) fn since(mut self, started: Instant) -> Self {
        self.started = started;
        self
    }
}

#[derive(Clone, Copy, Default)]
struct Aggregate {
    calls: u64,
    bytes: u64,
    total_us: u64,
    max_us: u64,
    first_at_us: u64,
    last_at_us: u64,
}

struct Trace {
    session: String,
    generation: u64,
    started: Instant,
    stages: [Aggregate; STAGES.len()],
}

impl Trace {
    fn new(session: String, generation: u64, started: Instant) -> Self {
        Self {
            session,
            generation,
            started,
            stages: [Aggregate::default(); STAGES.len()],
        }
    }

    fn record(
        &mut self,
        session: &str,
        stage: FlowStage,
        token: FlowToken,
        bytes: usize,
        ended: Instant,
        wall_us: u64,
    ) {
        if self.session != session || self.generation != token.generation {
            return;
        }
        // The first blocking read may have started before tracing was enabled.
        let us = ended
            .saturating_duration_since(token.started.max(self.started))
            .as_micros()
            .min(u64::MAX as u128) as u64;
        let point = &mut self.stages[stage as usize];
        point.calls = point.calls.saturating_add(1);
        point.bytes = point.bytes.saturating_add(bytes as u64);
        point.total_us = point.total_us.saturating_add(us);
        point.max_us = point.max_us.max(us);
        if point.first_at_us == 0 {
            point.first_at_us = wall_us;
        }
        point.last_at_us = wall_us;
    }
}

fn trace() -> &'static Mutex<Option<Trace>> {
    static TRACE: OnceLock<Mutex<Option<Trace>>> = OnceLock::new();
    TRACE.get_or_init(|| Mutex::new(None))
}

fn epoch_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros()
        .min(u64::MAX as u128) as u64
}

pub(super) fn start(session: String) {
    ENABLED.store(false, Ordering::Release);
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    if let Ok(mut current) = trace().lock() {
        *current = Some(Trace::new(session, generation, Instant::now()));
        ENABLED.store(true, Ordering::Release);
    }
}

pub(super) fn stop() {
    ENABLED.store(false, Ordering::Release);
}

pub(crate) fn flow_start() -> Option<FlowToken> {
    ENABLED.load(Ordering::Acquire).then(|| FlowToken {
        generation: GENERATION.load(Ordering::Relaxed),
        started: Instant::now(),
    })
}

pub(crate) fn record_flow(session: &str, stage: FlowStage, token: Option<FlowToken>, bytes: usize) {
    let Some(token) = token else {
        return;
    };
    if !ENABLED.load(Ordering::Acquire) {
        return;
    }
    if let Ok(mut current) = trace().lock() {
        if let Some(current) = current.as_mut() {
            current.record(session, stage, token, bytes, Instant::now(), epoch_us());
        }
    }
}

pub(super) fn snapshot() -> Vec<PerfMark> {
    let Ok(current) = trace().lock() else {
        return Vec::new();
    };
    let Some(current) = current.as_ref() else {
        return Vec::new();
    };
    let at_ms = epoch_us() as f64 / 1000.0;
    let mut result = vec![PerfMark {
        name: "pty.flow.active".into(),
        at_ms,
        id: Some(current.session.clone()),
        value: Some(u64::from(ENABLED.load(Ordering::Acquire))),
    }];
    for (name, point) in STAGES.iter().zip(current.stages.iter()) {
        if point.calls == 0 {
            continue;
        }
        for (field, value) in [
            ("calls", point.calls),
            ("bytes", point.bytes),
            ("totalUs", point.total_us),
            ("maxUs", point.max_us),
            ("firstAtUs", point.first_at_us),
            ("lastAtUs", point.last_at_us),
        ] {
            result.push(PerfMark {
                name: format!("pty.flow.{name}.{field}").into(),
                at_ms,
                id: Some(current.session.clone()),
                value: Some(value),
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn trace_clips_an_older_read_and_keeps_only_the_requested_session_and_generation() {
        let start = Instant::now();
        let mut trace = Trace::new("one".into(), 7, start);
        let token = FlowToken {
            generation: 7,
            started: start - Duration::from_millis(20),
        };
        trace.record(
            "one",
            FlowStage::Read,
            token,
            4096,
            start + Duration::from_millis(3),
            100,
        );
        trace.record("other", FlowStage::Read, token, 8000, start, 200);
        trace.record(
            "one",
            FlowStage::Read,
            FlowToken {
                generation: 6,
                ..token
            },
            8000,
            start,
            300,
        );
        let point = trace.stages[FlowStage::Read as usize];
        assert_eq!(
            (point.calls, point.bytes, point.total_us, point.max_us),
            (1, 4096, 3000, 3000)
        );
        assert_eq!((point.first_at_us, point.last_at_us), (100, 100));
        assert_eq!(trace.stages.len(), 10);
    }

    #[test]
    fn aggregates_do_not_retain_a_row_per_batch() {
        let start = Instant::now();
        let mut trace = Trace::new("one".into(), 1, start);
        let token = FlowToken {
            generation: 1,
            started: start,
        };
        for at in 1..=200_000 {
            trace.record(
                "one",
                FlowStage::Queue,
                token,
                64,
                start + Duration::from_micros(2),
                at,
            );
        }
        let point = trace.stages[FlowStage::Queue as usize];
        assert_eq!(
            (point.calls, point.bytes, point.total_us),
            (200_000, 12_800_000, 400_000)
        );
        assert_eq!((point.first_at_us, point.last_at_us), (1, 200_000));
    }
}
