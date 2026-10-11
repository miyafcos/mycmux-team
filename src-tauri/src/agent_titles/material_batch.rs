//! Bounded blocking readers. Kept separate so scheduling is tested with real Tokio.
use std::{sync::Arc, time::Instant};
use tokio::sync::Semaphore;

pub(crate) async fn read_batch<T, R, F>(requests: Vec<T>, limit: Arc<Semaphore>, deadline: Instant, reader: F) -> Vec<R>
where T: Send + 'static, R: Send + 'static, F: Fn(T, Instant) -> R + Clone + Send + 'static {
    // The caller caps batches at 64; completed values remain bounded even while
    // submission waits for a permit. A blocked OS reader keeps its permit.
    let (sender, mut completed) = tokio::sync::mpsc::channel(requests.len().clamp(1, 64));
    for request in requests {
        if Instant::now() >= deadline { break; }
        let wait = deadline.saturating_duration_since(Instant::now());
        let Ok(Ok(permit)) = tokio::time::timeout(wait, limit.clone().acquire_owned()).await else { break; };
        let reader = reader.clone();
        let sender = sender.clone();
        let _task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let value = reader(request, deadline);
            let _ = sender.blocking_send(value);
        });
    }
    drop(sender);
    let mut result = Vec::new();
    loop {
        while let Ok(value) = completed.try_recv() { result.push(value); }
        if Instant::now() >= deadline { break; }
        let wait = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(wait, completed.recv()).await {
            Ok(Some(value)) => result.push(value),
            _ => break,
        }
    }
    // Do not throw away completions queued before the shared deadline.
    while let Ok(value) = completed.try_recv() { result.push(value); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    #[tokio::test]
    async fn stalled_first_reader_keeps_completed_followers() {
        let limit = Arc::new(Semaphore::new(4));
        let result = read_batch(vec!["slow", "fast-b", "fast-c"], limit.clone(),
            Instant::now() + Duration::from_millis(150), |id, _| {
                if id == "slow" { std::thread::sleep(Duration::from_millis(500)); }
                id
            }).await;
        // The OS reader is still running; it must retain its permit.
        assert_eq!(limit.available_permits(), 3);
        let mut result = result; result.sort();
        assert_eq!(result, vec!["fast-b", "fast-c"]);
    }
    #[tokio::test]
    async fn permit_wait_deadline_still_drains_already_finished_readers() {
        let result = read_batch(vec!["fast", "slow", "never"], Arc::new(Semaphore::new(1)),
            Instant::now() + Duration::from_millis(150), |id, _| {
                if id == "slow" { std::thread::sleep(Duration::from_millis(500)); }
                id
            }).await;
        assert_eq!(result, vec!["fast"]);
    }
    #[tokio::test]
    async fn returns_in_completion_order_before_deadline() {
        let result = read_batch(vec!["slow", "fast"], Arc::new(Semaphore::new(4)),
            Instant::now() + Duration::from_secs(2), |id, _| {
                if id == "slow" { std::thread::sleep(Duration::from_millis(100)); }
                id
            }).await;
        assert_eq!(result, vec!["fast", "slow"]);
    }
}
