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

#[cfg(test)]
mod tests {
    use super::*;
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
