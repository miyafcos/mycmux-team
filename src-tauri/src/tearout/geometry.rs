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

#[cfg(test)]
mod tests {
    use super::*;
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
