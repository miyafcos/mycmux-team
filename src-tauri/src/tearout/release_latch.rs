use std::sync::Mutex;

/// Per-drag storage: the first native release remains authoritative even when
/// the cursor moves again before the sampler observes the button-state edge.
pub struct ReleaseLatch<T>(Mutex<Option<T>>);
impl<T> Default for ReleaseLatch<T> {
    fn default() -> Self { Self(Mutex::new(None)) }
}
impl<T: Copy> ReleaseLatch<T> {
    pub fn latch(&self, point: T) {
        if let Ok(mut slot) = self.0.lock() { if slot.is_none() { *slot = Some(point); } }
    }
    pub fn final_point(&self, fallback: T) -> T {
        self.latch(fallback);
        self.0.lock().unwrap_or_else(|e| e.into_inner()).unwrap_or(fallback)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_a_wins_over_later_exit_and_cursor_b() {
        let latch = ReleaseLatch::default();
        latch.latch((-1200.25, -30.5, 100, "native_up"));
        latch.latch((900.0, 700.0, 108, "native_exit"));
        assert_eq!(latch.final_point((1000.0, 800.0, 116, "poll_fallback")), (-1200.25, -30.5, 100, "native_up"));
    }
    #[test]
    fn omitted_up_is_explicit_and_does_not_change_another_drag() {
        let original = ReleaseLatch::default(); original.latch((1.0, "native_up"));
        let omitted = ReleaseLatch::default();
        assert_eq!(omitted.final_point((900.0, "poll_fallback")), (900.0, "poll_fallback"));
        assert_eq!(original.final_point((900.0, "poll_fallback")), (1.0, "native_up"));
    }
}
