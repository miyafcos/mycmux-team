#[derive(Clone, Copy, Debug, Default)]
pub struct Rect { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

pub fn contains(rect: Rect, x: f64, y: f64) -> bool {
    x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height
}

pub struct ReceiverCandidate { pub label: Option<String>, pub rect: Rect, pub visible: bool }

/** Input is in native Z order; an unrelated covering window blocks adoption. */
pub fn frontmost_receiver<'a>(x: f64, y: f64, candidates: &'a [ReceiverCandidate], moving: &str) -> Option<&'a str> {
    candidates.iter().find(|candidate| candidate.visible
        && candidate.label.as_deref() != Some(moving) && contains(candidate.rect, x, y))
        .and_then(|candidate| candidate.label.as_deref())
}

/// Native screen pixels are rebased using the receiver's client origin and
/// DPI once. The moving window's scale is deliberately not an input.
pub fn receiver_client_point(point: (f64, f64), origin: (f64, f64), receiver_scale: f64) -> (f64, f64) {
    ((point.0 - origin.0) / receiver_scale.max(0.01), (point.1 - origin.1) / receiver_scale.max(0.01))
}

pub fn dwell_ready(start: Option<u64>, now: u64, painted: bool) -> bool {
    painted && start.is_some_and(|start| now.saturating_sub(start) >= 120)
}

pub fn sample_recipients<'a>(
    source: &'a str,
    moving: &'a str,
    previous: Option<&'a str>,
    receiver: Option<&'a str>,
    lifecycle: bool,
) -> Vec<&'a str> {
    let mut labels = Vec::with_capacity(4);
    if let Some(receiver) = receiver {
        labels.push(receiver);
    }
    if previous != receiver {
        if let Some(previous) = previous {
            labels.push(previous);
        }
    }
    if lifecycle {
        labels.extend([source, moving]);
    }
    let mut unique = Vec::with_capacity(labels.len());
    for label in labels {
        if !unique.contains(&label) {
            unique.push(label);
        }
    }
    unique
}

/** OS focus on the moving window is expected; another mycmux foreground is not. */
pub fn focus_stolen(
    before: usize,
    after: usize,
    moving: usize,
    mycmux: &[usize],
    moving_allowed: bool,
) -> bool {
    before != after
        && mycmux.contains(&after)
        && (!mycmux.contains(&before) || !moving_allowed || after != moving)
}

pub fn accepts_preview_revision(current: u64, proposed: u64) -> bool {
    proposed >= current
}

/// Physical monitor bounds and work area; scale converts the reserved band.
#[derive(Clone, Copy, Debug)]
pub struct MonitorArea { pub bounds: Rect, pub work: Rect, pub scale: f64 }

pub fn initial_logical_size(width: f64, height: f64, work: Rect, scale: f64) -> (f64, f64) {
    let scale = scale.max(0.01);
    let clamp = |value: f64, fallback: f64, minimum: f64, available: f64| {
        let value = if value.is_finite() && value > 0.0 { value } else { fallback };
        value.clamp(minimum, (available / scale * 0.9).max(minimum))
    };
    (clamp(width, 720.0, 240.0, work.width), clamp(height, 520.0, 160.0, work.height))
}

pub fn moved_for_dock(start: (f64, f64), point: (f64, f64), scale: f64) -> bool {
    (point.0 - start.0).hypot(point.1 - start.1) / scale.max(0.01) >= 9.0
}

/// Shared edges are excluded only along the segment occupied by the neighbor.
pub fn snap_edge_reserved(x: f64, y: f64, monitors: &[MonitorArea]) -> bool {
    let Some((index, monitor)) = monitors.iter().enumerate().find(|(_, monitor)| contains(monitor.bounds, x, y)) else {
        return false;
    };
    let b = monitor.bounds;
    let w = monitor.work;
    let band = 24.0 * monitor.scale;
    let neighbors: Vec<Rect> = monitors.iter().enumerate().filter(|(i, _)| *i != index)
        .map(|(_, monitor)| monitor.bounds).collect();
    let vertical = |r: &Rect| y >= r.y && y < r.y + r.height;
    let horizontal = |r: &Rect| x >= r.x && x < r.x + r.width;
    let touches = |a: f64, b: f64| (a - b).abs() < 1.0;
    (x < w.x + band && !neighbors.iter().any(|r| touches(r.x + r.width, b.x) && vertical(r)))
        || (x >= w.x + w.width - band && !neighbors.iter().any(|r| touches(r.x, b.x + b.width) && vertical(r)))
        || (y < w.y + band && !neighbors.iter().any(|r| touches(r.y + r.height, b.y) && horizontal(r)))
        || (y >= w.y + w.height - band && !neighbors.iter().any(|r| touches(r.y, b.y + b.height) && horizontal(r)))
}

/// Logical grip coordinates; screen coordinates remain signed physical pixels.
#[derive(Clone, Copy, Debug)]
pub struct GrabOffset { pub x: f64, pub y: f64 }

pub fn origin_under_cursor(point: (i32, i32), logical_width: f64, offset: GrabOffset, scale: f64) -> (i32, i32) {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let width = if logical_width.is_finite() { logical_width } else { 720.0 };
    let bounded = |value: f64, max: f64| if value.is_finite() { value.clamp(0.0, max.max(0.0)) } else { 0.0 };
    (point.0 - (bounded(offset.x, width - 40.0) * scale).round() as i32,
        point.1 - (bounded(offset.y, 30.0) * scale).round() as i32)
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub struct CursorPlacement {
    pub origin: (i32, i32),
    pub scale: f64,
    pub placements: u8,
    pub settled: bool,
}

/// Own the initial window-scale read and reread only after successful moves.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn settle_from_window_scale<E>(
    point: (i32, i32),
    logical_width: f64,
    offset: GrabOffset,
    mut read_scale: impl FnMut() -> Result<f64, E>,
    mut move_to: impl FnMut((i32, i32)) -> Result<(), E>,
) -> Result<CursorPlacement, E> {
    let initial_scale = read_scale()?;
    settle_under_cursor(point, logical_width, offset, initial_scale, |origin| {
        move_to(origin)?;
        read_scale()
    })
}

/// Read the assigned scale after each placement, but never place a third time.
/// An unsettled result retains the scale used for the final origin calculation.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn settle_under_cursor<E>(
    point: (i32, i32),
    logical_width: f64,
    offset: GrabOffset,
    initial_scale: f64,
    mut place: impl FnMut((i32, i32)) -> Result<f64, E>,
) -> Result<CursorPlacement, E> {
    let scale = if initial_scale.is_finite() && initial_scale > 0.0 { initial_scale } else { 1.0 };
    let origin = origin_under_cursor(point, logical_width, offset, scale);
    let assigned = place(origin)?;
    if (assigned - scale).abs() <= 0.001 {
        return Ok(CursorPlacement { origin, scale, placements: 1, settled: true });
    }
    let scale = assigned;
    let origin = origin_under_cursor(point, logical_width, offset, scale);
    let assigned = place(origin)?;
    Ok(CursorPlacement { origin, scale, placements: 2, settled: (assigned - scale).abs() <= 0.001 })
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
pub struct StartAlignment {
    pub cursor: [f64; 2], pub before: [f64; 2], pub expected: [f64; 2], pub after: [f64; 2],
    pub scale: f64, pub error_before_px: f64, pub error_after_px: f64,
}
impl StartAlignment {
    /// Windows passes physical pixels with unit=1; AppKit passes points with unit=backing scale.
    pub fn measure(cursor: [f64; 2], before: [f64; 2], expected: [f64; 2], after: [f64; 2], scale: f64, unit: f64) -> Self {
        let error = |position: [f64; 2]| (position[0] - expected[0]).hypot(position[1] - expected[1]) * unit;
        Self { cursor, before, expected, after, scale, error_before_px: error(before), error_after_px: error(after) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn settle_model(point: (i32, i32), width: f64, grip: GrabOffset, model: &mut SeamModel) -> CursorPlacement {
        let model = RefCell::new(model);
        settle_from_window_scale(point, width, grip, || Ok(model.borrow().window_scale),
            |origin| model.borrow_mut().place(origin).map(|_| ())).unwrap()
    }

    #[test]
    fn cursor_placement_settles_once_inside_a_single_scale_screen() {
        for scale in [1.0, 1.5, 1.75] {
            let grip = GrabOffset { x: 90.0, y: 18.0 };
            let mut model = SeamModel::new(false, 720.0, scale, scale, scale);
            let result = settle_model((900, 700), 720.0, grip, &mut model);
            assert_eq!(result, CursorPlacement { origin: origin_under_cursor((900, 700), 720.0, grip, scale),
                scale, placements: 1, settled: true });
            assert_eq!(model.positions, [result.origin]);
        }
    }

    /// Scale follows the center computed with the window's size BEFORE placing.
    /// Updating that scale also updates the size used by the next placement.
    struct SeamModel {
        vertical: bool,
        extent: f64,
        negative_scale: f64,
        positive_scale: f64,
        window_scale: f64,
        positions: Vec<(i32, i32)>,
    }
    impl SeamModel {
        fn new(vertical: bool, extent: f64, negative_scale: f64, positive_scale: f64, window_scale: f64) -> Self {
            Self { vertical, extent, negative_scale, positive_scale, window_scale, positions: vec![] }
        }
        fn place(&mut self, origin: (i32, i32)) -> Result<f64, &'static str> {
            self.positions.push(origin);
            let axis = if self.vertical { origin.1 } else { origin.0 };
            let center = axis as f64 + self.extent * self.window_scale / 2.0;
            self.window_scale = if center < 0.0 { self.negative_scale } else { self.positive_scale };
            Ok(self.window_scale)
        }
    }

    #[test]
    fn follower_and_native_keep_the_same_window_scale_in_the_dual_stable_band() {
        let width = 400.0;
        let grip = GrabOffset { x: 300.0, y: 18.0 }; // Right half: k = 300 - 400/2 = 100.
        for (high, low, expected_edges) in [(1.75_f64, 1.0_f64, (100.0, 175.0)), (1.5, 1.0, (100.0, 150.0))] {
            let edge = |scale: f64| (grip.x * scale).round() - width * scale / 2.0;
            let (low_edge, high_edge) = (edge(low), edge(high));
            assert_eq!((low_edge, high_edge), expected_edges);
            // Both scales are consistent for cursor x in [k*low, k*high).
            for x in [low_edge as i32, ((low_edge + high_edge) / 2.0) as i32, high_edge as i32 - 1] {
                let point = (x, 500);
                let mut high_model = SeamModel::new(false, width, high, low, high);
                let from_high = settle_model(point, width, grip, &mut high_model);
                let mut low_model = SeamModel::new(false, width, high, low, low);
                let from_low = settle_model(point, width, grip, &mut low_model);
                assert!(from_high.settled && from_low.settled);
                assert_eq!((from_high.placements, from_high.scale), (1, high));
                assert_eq!((from_low.placements, from_low.scale), (1, low));
                // Reading a fixed initial scale would collapse this difference to zero.
                let difference = (grip.x * (high - low)).round() as i32;
                assert_eq!(from_low.origin.0 - from_high.origin.0, difference);

                // The previous native start used cursor-monitor scale (low),
                // even though the window still had its incoming high scale.
                let old_origin = origin_under_cursor(point, width, grip, low);
                let mut old_model = SeamModel::new(false, width, high, low, high);
                assert_eq!(old_model.place(old_origin).unwrap(), low); // No old second correction.
                assert_eq!(old_origin.0 - from_high.origin.0, difference);
                if high == 1.75 { assert_eq!(old_origin.0 - from_high.origin.0, 225); }
            }
            let mut boundary = SeamModel::new(false, width, high, low, high);
            let result = settle_model((high_edge as i32, 500), width, grip, &mut boundary);
            assert!(result.settled);
            assert_eq!((result.placements, result.scale), (2, low));
        }
    }

    #[test]
    fn oscillating_horizontal_and_vertical_seams_stop_after_two_placements() {
        let grip = GrabOffset { x: 90.0, y: 18.0 }; // Left half of width 720.
        for (vertical, extent, high, low, expected_edges) in [
            (false, 720.0_f64, 1.75_f64, 1.0_f64, (270.0, 472.0)),
            (false, 720.0, 1.5, 1.0, (270.0, 405.0)),
            (false, 720.0, 1.75, 1.5, (405.0, 472.0)),
            (true, 520.0, 1.75, 1.0, (242.0, 423.0)),
            (true, 520.0, 1.5, 1.0, (242.0, 363.0)),
        ] {
            let offset = if vertical { grip.y } else { grip.x };
            // Ideal distances are (extent/2 - offset)*scale:
            // x: 270..472.5, y: 242..423.5 at 100/175%.
            // Integer origins round the grip: x becomes 270..472, y 242..423.
            let edge = |scale: f64| extent * scale / 2.0 - (offset * scale).round();
            let (low_edge, high_edge) = (edge(low), edge(high));
            assert_eq!((low_edge, high_edge), expected_edges);
            let point = |axis| if vertical { (500, axis) } else { (axis, 500) };
            // Center==0 belongs to the positive screen, so the oscillating
            // cursor interval is [-high_edge, -low_edge) from either incoming scale.
            // From low, the first center is axis+low_edge, the second axis+high_edge.
            for initial_scale in [high, low] {
                let final_scale = if initial_scale == high { low } else { high };
                for axis in [-high_edge as i32, -((low_edge + high_edge) / 2.0) as i32, -low_edge as i32 - 1] {
                    let mut model = SeamModel::new(vertical, extent, high, low, initial_scale);
                    let result = settle_model(point(axis), 720.0, grip, &mut model);
                    assert!(!result.settled);
                    assert_eq!(result.placements, 2);
                    assert_eq!(model.positions.len(), 2); // Never enqueue a third placement.
                    assert_eq!(result.origin, origin_under_cursor(point(axis), 720.0, grip, final_scale));
                    assert_eq!(result.scale, final_scale); // Scale used for the final origin.
                    assert_eq!(model.window_scale, initial_scale);
                }
                let left_placements = if initial_scale == high { 1 } else { 2 };
                let right_placements = if initial_scale == high { 2 } else { 1 };
                for (axis, placements, scale) in [(-high_edge as i32 - 1, left_placements, high), (-low_edge as i32, right_placements, low)] {
                    let mut model = SeamModel::new(vertical, extent, high, low, initial_scale);
                    let result = settle_model(point(axis), 720.0, grip, &mut model);
                    assert!(result.settled);
                    assert_eq!((result.placements, result.scale), (placements, scale));
                    assert_eq!(model.positions.len(), placements as usize);
                    assert_eq!(model.window_scale, scale);
                }
            }
        }
    }

    #[test]
    fn window_scale_entry_reads_once_more_than_it_places_and_never_a_third_time() {
        let grip = GrabOffset { x: 90.0, y: 18.0 };
        for (point, width, offset, model, placements, settled) in [
            ((900, 700), 720.0, grip, SeamModel::new(false, 720.0, 1.5, 1.5, 1.5), 1, true),
            ((175, 500), 400.0, GrabOffset { x: 300.0, y: 18.0 }, SeamModel::new(false, 400.0, 1.75, 1.0, 1.75), 2, true),
            ((-400, 500), 720.0, grip, SeamModel::new(false, 720.0, 1.75, 1.0, 1.75), 2, false),
        ] {
            let model = RefCell::new(model);
            let reads = Cell::new(0);
            let moves = Cell::new(0);
            let result = settle_from_window_scale(point, width, offset, || {
                reads.set(reads.get() + 1);
                Ok(model.borrow().window_scale)
            }, |origin| {
                moves.set(moves.get() + 1);
                model.borrow_mut().place(origin).map(|_| ())
            }).unwrap();
            assert_eq!((result.placements, result.settled), (placements, settled));
            assert_eq!(moves.get(), placements);
            assert_eq!(reads.get(), placements + 1);
            assert_eq!(model.borrow().positions.len(), placements as usize);
        }
    }

    #[test]
    fn window_scale_entry_propagates_read_or_placement_failures_without_retrying() {
        for (fail_read, fail_move, expected_reads, expected_moves, error) in [
            (Some(1), None, 1, 0, "scale read failed"),
            (None, Some(1), 1, 1, "placement failed"),
            (Some(2), None, 2, 1, "scale read failed"),
            (None, Some(2), 2, 2, "placement failed"),
            (Some(3), None, 3, 2, "scale read failed"),
        ] {
            let reads = Cell::new(0);
            let moves = Cell::new(0);
            let result = settle_from_window_scale((100, 500), 720.0, GrabOffset { x: 90.0, y: 18.0 }, || {
                reads.set(reads.get() + 1);
                if Some(reads.get()) == fail_read { Err("scale read failed") }
                else { Ok(if reads.get() == 1 { 1.75 } else { 1.0 }) }
            }, |_| {
                moves.set(moves.get() + 1);
                if Some(moves.get()) == fail_move { Err("placement failed") } else { Ok(()) }
            });
            assert_eq!(result.unwrap_err(), error);
            assert_eq!((reads.get(), moves.get()), (expected_reads, expected_moves));
        }
    }
    #[test]
    fn realignment_uses_current_destination_dpi_and_signed_screen_coordinates() {
        let grip = GrabOffset { x: 90.0, y: 18.0 };
        assert_eq!(origin_under_cursor((900, 500), 720.0, grip, 1.0), (810, 482));
        assert_eq!(origin_under_cursor((-100, 500), 720.0, grip, 1.5), (-235, 473));
        // The cursor crossed from 100% at reveal to 150% before native start.
        let revealed = origin_under_cursor((20, 500), 720.0, grip, 1.0);
        let expected = origin_under_cursor((-100, 500), 720.0, grip, 1.5);
        let alignment = StartAlignment::measure([-100.0, 500.0], [revealed.0 as f64, revealed.1 as f64],
            [expected.0 as f64, expected.1 as f64], [expected.0 as f64, expected.1 as f64], 1.5, 1.0);
        assert!(alignment.error_before_px > 160.0);
        assert_eq!(alignment.error_after_px, 0.0);
    }
    #[test]
    fn grip_offsets_clamp_and_round_in_the_destination_band() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let origin = origin_under_cursor((100, -600), 240.0, GrabOffset { x: 900.0, y: 99.0 }, scale);
            assert_eq!(origin, (100 - (200.0 * scale).round() as i32, -600 - (30.0 * scale).round() as i32));
        }
        assert_eq!(origin_under_cursor((0, 0), 720.0, GrabOffset { x: -20.0, y: -10.0 }, 1.5), (0, 0));
        assert_eq!(origin_under_cursor((0, 0), f64::NAN, GrabOffset { x: f64::NAN, y: f64::INFINITY }, f64::NAN), (0, 0));
    }
    #[test]
    fn receiver_dpi_and_signed_origins_convert_once_r5() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let origin = (-2560.0, -1440.0);
            let expected = (150.25, 75.5);
            let point = (origin.0 + expected.0 * scale, origin.1 + expected.1 * scale);
            assert_eq!(receiver_client_point(point, origin, scale), expected);
        }
    }
    #[test]
    fn maximized_app_receiver_at_exterior_snap_edge_stays_eligible_r4() {
        let area = MonitorArea { bounds: Rect { x: -2560.0, y: -1440.0, width: 2560.0, height: 1440.0 },
            work: Rect { x: -2560.0, y: -1440.0, width: 2560.0, height: 1400.0 }, scale: 1.5 };
        let covering = [ReceiverCandidate { label: Some("moving".into()), rect: area.work, visible: true },
            ReceiverCandidate { label: Some("receiver".into()), rect: area.work, visible: true }];
        assert!(snap_edge_reserved(-2559.0, -1300.0, &[area]));
        assert_eq!(frontmost_receiver(-2559.0, -1300.0, &covering, "moving"), Some("receiver"));
        assert_eq!(frontmost_receiver(-2561.0, -1300.0, &covering, "moving"), None);
    }

    #[test]
    fn initial_size_preserves_logical_pixels_and_caps_the_destination_work_area() {
        let work = Rect { width: 2560.0, height: 1520.0, ..Rect::default() };
        assert_eq!(initial_logical_size(600.0, 400.0, work, 1.25), (600.0, 400.0));
        assert_eq!(initial_logical_size(600.0, 400.0, work, 2.0), (600.0, 400.0));
        assert_eq!(initial_logical_size(5000.0, 5000.0, work, 2.0), (1152.0, 684.0));
        assert_eq!(initial_logical_size(10.0, 10.0, work, 1.0), (240.0, 160.0));
        assert_eq!(initial_logical_size(f64::NAN, f64::INFINITY, work, 1.0), (720.0, 520.0));
    }

    #[test]
    fn nine_logical_pixels_gate_docking_without_delaying_native_movement() {
        assert!(!moved_for_dock((10.0, 20.0), (10.0, 20.0), 1.5));
        assert!(!moved_for_dock((10.0, 20.0), (23.0, 20.0), 1.5));
        assert!(moved_for_dock((10.0, 20.0), (23.5, 20.0), 1.5));
        assert!(moved_for_dock((10.0, 20.0), (1.0, 20.0), 1.0));
    }

    #[test]
    fn only_exterior_work_area_edges_reserve_24_logical_pixels() {
        let main = MonitorArea { bounds: Rect { width: 2560.0, height: 1600.0, ..Rect::default() },
            work: Rect { width: 2560.0, height: 1520.0, ..Rect::default() }, scale: 1.25 };
        let above = MonitorArea { bounds: Rect { x: 232.0, y: -1440.0, width: 3440.0, height: 1440.0 },
            work: Rect { x: 232.0, y: -1440.0, width: 3440.0, height: 1440.0 }, scale: 1.0 };
        let monitors = [main, above];
        for (x, y) in [(0.0, 500.0), (29.0, 500.0), (2559.0, 500.0), (1000.0, 1490.0),
            (100.0, 0.0), (1000.0, -1440.0), (3671.0, -500.0), (3000.0, -1.0)] {
            assert!(snap_edge_reserved(x, y, &monitors), "exterior {x},{y}");
        }
        for (x, y) in [(30.0, 500.0), (2529.0, 500.0), (1000.0, 1489.0),
            (232.0, 0.0), (1000.0, 0.0), (1000.0, -1.0), (1000.0, -1416.0)] {
            assert!(!snap_edge_reserved(x, y, &monitors), "shared or interior {x},{y}");
        }
    }

    #[test]
    fn a_side_neighbor_excludes_only_its_shared_segment() {
        let main = MonitorArea { bounds: Rect { width: 1000.0, height: 1000.0, ..Rect::default() },
            work: Rect { width: 1000.0, height: 900.0, ..Rect::default() }, scale: 2.0 };
        let right = MonitorArea { bounds: Rect { x: 1000.0, y: 200.0, width: 500.0, height: 500.0 },
            work: Rect { x: 1000.0, y: 200.0, width: 500.0, height: 500.0 }, scale: 1.0 };
        assert!(snap_edge_reserved(999.0, 199.0, &[main, right]));
        assert!(!snap_edge_reserved(999.0, 200.0, &[main, right]));
        assert!(!snap_edge_reserved(999.0, 699.0, &[main, right]));
        assert!(snap_edge_reserved(999.0, 700.0, &[main, right]));
        assert!(!snap_edge_reserved(1000.0, 400.0, &[main, right]));
        assert!(!snap_edge_reserved(5000.0, 400.0, &[main, right]));
    }

    #[test]
    fn frontmost_excludes_self_and_obeys_occlusion_and_visibility() {
        let r = Rect { width: 300.0, height: 200.0, ..Rect::default() };
        let mut candidates = vec![
            ReceiverCandidate { label: Some("moving".into()), rect: r, visible: true },
            ReceiverCandidate { label: Some("front".into()), rect: r, visible: true },
            ReceiverCandidate { label: Some("back".into()), rect: r, visible: true },
        ];
        assert_eq!(frontmost_receiver(50.0, 50.0, &candidates, "moving"), Some("front"));
        candidates[1].label = None;
        assert_eq!(frontmost_receiver(50.0, 50.0, &candidates, "moving"), None);
        candidates[1].visible = false;
        assert_eq!(frontmost_receiver(50.0, 50.0, &candidates, "moving"), Some("back"));
        assert_eq!(frontmost_receiver(301.0, 50.0, &candidates, "moving"), None);
    }
    #[test]
    fn dwell_requires_120ms_and_a_painted_frame() {
        assert!(!dwell_ready(Some(10), 129, true));
        assert!(dwell_ready(Some(10), 130, true));
        assert!(!dwell_ready(Some(10), 500, false));
        assert!(!dwell_ready(None, 500, true));
    }
    #[test]
    fn steady_samples_only_reach_receiver_and_leaving_clears_the_previous_window() {
        assert_eq!(
            sample_recipients("main", "moving", Some("receiver"), Some("receiver"), false),
            ["receiver"]
        );
        assert_eq!(
            sample_recipients("main", "moving", Some("receiver"), None, false),
            ["receiver"]
        );
        assert_eq!(
            sample_recipients("main", "moving", Some("front"), Some("back"), false),
            ["back", "front"]
        );
        assert_eq!(
            sample_recipients("main", "moving", Some("main"), Some("main"), true),
            ["main", "moving"]
        );
        assert_eq!(
            sample_recipients("moving", "moving", None, None, true),
            ["moving"]
        );
    }
    #[test]
    fn focus_changes_only_flag_external_to_mycmux_or_another_mycmux_window() {
        let windows = [1, 2, 3];
        assert!(!focus_stolen(1, 2, 2, &windows, true));
        assert!(focus_stolen(9, 2, 2, &windows, true));
        assert!(focus_stolen(9, 2, 2, &windows, false));
        assert!(focus_stolen(9, 1, 2, &windows, true));
        assert!(focus_stolen(2, 3, 2, &windows, true));
        assert!(!focus_stolen(2, 9, 2, &windows, true));
        assert!(!focus_stolen(2, 2, 2, &windows, false));
    }
    #[test]
    fn late_approval_cannot_replace_a_newer_target_or_its_clear() {
        assert!(!accepts_preview_revision(3, 2));
        assert!(accepts_preview_revision(3, 3));
        assert!(accepts_preview_revision(3, 4));
    }
}
