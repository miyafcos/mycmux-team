use super::*;
use super::super::input_proof::MAX_DOCUMENTS;
use super::super::preview_links::click_mac;

const KEY: &str = "test-only-key";
const DOC: &str = "00000000000000000000000000000001";
const ORIGIN: &str = "http://localhost:8123";
const TARGET: &str = "terminal.fixture_2:abc";
const NOW: u64 = 1_800_000_000_000;

fn signed(key: &str, doc: &str, sequence: u64, pressed: u64, origin: &str, tab: &str) -> Url {
    let message = format!("{doc}\n{sequence}\n{pressed}\n{origin}\n{tab}");
    let mac = click_mac(key, &message);
    let mut url = Url::parse(&format!("https://{REQUEST_HOST}/{doc}/{sequence}/{pressed}/{mac}")).unwrap();
    url.query_pairs_mut().append_pair("origin", origin).append_pair("tab", tab);
    url
}

fn good(sequence: u64) -> Url {
    signed(KEY, DOC, sequence, NOW, ORIGIN, TARGET)
}

fn focus() -> OperatorFocusDecision {
    OperatorFocusDecision::Focus(TARGET.to_string())
}

#[test]
fn accepts_a_fresh_signed_loopback_click() {
    for origin in ["http://localhost:8123", "http://127.0.0.1", "http://127.0.0.1:65535"] {
        let mut gate = OperatorFocusGate::with_key(KEY.into());
        let request = signed(KEY, DOC, 1, NOW, origin, TARGET);
        assert_eq!(gate.consume(&request, "browser", NOW, Instant::now(), || false), focus());
    }
}

#[test]
fn rejects_bad_proof_and_does_not_consume_the_number() {
    let mut gate = OperatorFocusGate::with_key(KEY.into());
    let now = Instant::now();
    let wrong = signed("test-other-key", DOC, 1, NOW, ORIGIN, TARGET);
    assert_eq!(gate.consume(&wrong, "browser", NOW, now, || false), OperatorFocusDecision::Discard);
    let mut changed = good(1);
    changed.query_pairs_mut().clear().append_pair("origin", ORIGIN).append_pair("tab", "terminal-other");
    assert_eq!(gate.consume(&changed, "browser", NOW, now, || false), OperatorFocusDecision::Discard);
    assert_eq!(gate.consume(&good(1), "browser", NOW, now, || false), focus());
}

#[test]
fn accepts_skipped_numbers_but_rejects_reuse_and_older_numbers() {
    let mut gate = OperatorFocusGate::with_key(KEY.into());
    let now = Instant::now();
    assert_eq!(gate.consume(&good(2), "browser", NOW, now, || false), focus());
    let later = now + Duration::from_millis(500);
    for sequence in [1, 2] {
        assert_eq!(gate.consume(&good(sequence), "browser", NOW + 500, later, || false), OperatorFocusDecision::Discard);
    }
    assert_eq!(gate.consume(&good(4), "browser", NOW + 500, later, || false), focus());
}

#[test]
fn refuses_times_outside_the_freshness_bounds_and_consumes_signed_stale_numbers() {
    let mut gate = OperatorFocusGate::with_key(KEY.into());
    let now = Instant::now();
    for (seq, pressed) in [(1, NOW - 2_001), (2, NOW + 101)] {
        let request = signed(KEY, DOC, seq, pressed, ORIGIN, TARGET);
        assert_eq!(gate.consume(&request, "browser", NOW, now, || false), OperatorFocusDecision::Discard);
    }
    for (seq, pressed, elapsed) in [(3, NOW - 2_000, 0), (4, NOW + 100, 500)] {
        let request = signed(KEY, DOC, seq, pressed, ORIGIN, TARGET);
        assert_eq!(gate.consume(&request, "browser", NOW, now + Duration::from_millis(elapsed), || false), focus());
    }
}

#[test]
fn rejects_non_loopback_or_non_http_origins() {
    let mut gate = OperatorFocusGate::with_key(KEY.into());
    let now = Instant::now();
    for (index, origin) in [
        "https://localhost", "http://example.test", "http://127.0.0.2",
        "http://asset.localhost", "http://[::1]", "http://localhost.",
    ].into_iter().enumerate() {
        let request = signed(KEY, DOC, index as u64 + 1, NOW, origin, TARGET);
        assert_eq!(gate.consume(&request, "browser", NOW, now, || false), OperatorFocusDecision::Discard, "{origin}");
    }
}

#[test]
fn rejects_other_presets_and_enforces_the_interval_across_documents() {
    let mut gate = OperatorFocusGate::with_key(KEY.into());
    let now = Instant::now();
    assert_eq!(gate.consume(&good(1), "preview", NOW, now, || false), OperatorFocusDecision::Discard);
    assert_eq!(gate.consume(&good(2), "browser", NOW, now, || false), focus());
    let second_document = "00000000000000000000000000000002";
    let second = signed(KEY, second_document, 1, NOW + 499, ORIGIN, TARGET);
    assert_eq!(gate.consume(&second, "browser", NOW + 499, now + Duration::from_millis(499), || false), OperatorFocusDecision::Discard);
    let third = signed(KEY, second_document, 2, NOW + 500, ORIGIN, TARGET);
    assert_eq!(gate.consume(&third, "browser", NOW + 500, now + Duration::from_millis(500), || false), focus());
}

#[test]
fn reports_automation_only_after_other_checks_and_throttles_the_notice() {
    let mut gate = OperatorFocusGate::with_key(KEY.into());
    let now = Instant::now();
    let malformed = Url::parse("https://mycmux-operator-focus.invalid/bad").unwrap();
    let wrong = signed("test-other-key", DOC, 1, NOW, ORIGIN, TARGET);
    let stale = signed(KEY, DOC, 1, NOW - 2_001, ORIGIN, TARGET);
    let external = signed(KEY, DOC, 2, NOW, "http://example.test", TARGET);
    for (request, preset) in [
        (malformed, "browser"), (wrong, "browser"),
        (stale, "browser"), (external, "browser"), (good(3), "preview"),
    ] {
        assert_eq!(gate.consume(&request, preset, NOW, now, || panic!("automation checked early")), OperatorFocusDecision::Discard);
    }
    assert_eq!(gate.consume(&good(4), "browser", NOW, now, || true), OperatorFocusDecision::AutomationRefused);
    assert_eq!(gate.consume(&good(5), "browser", NOW + 499, now + Duration::from_millis(499), || panic!("automation checked before the interval")), OperatorFocusDecision::Discard);
    assert_eq!(gate.consume(&good(6), "browser", NOW + 500, now + Duration::from_millis(500), || true), OperatorFocusDecision::Discard);
    let later = signed(KEY, DOC, 7, NOW + 3_000, ORIGIN, TARGET);
    assert_eq!(gate.consume(&later, "browser", NOW + 3_000, now + Duration::from_millis(3_000), || true), OperatorFocusDecision::AutomationRefused);
}

#[test]
fn rejects_malformed_requests_before_they_can_consume_a_number() {
    let mut gate = OperatorFocusGate::with_key(KEY.into());
    let now = Instant::now();
    let valid = good(1);
    for scheme in ["http", "ftp"] {
        let mut url = valid.clone();
        url.set_scheme(scheme).unwrap();
        assert_eq!(gate.consume(&url, "browser", NOW, now, || false), OperatorFocusDecision::Discard);
    }
    let mut bad_port = valid.clone();
    bad_port.set_port(Some(8443)).unwrap();
    let mut bad_user = valid.clone();
    bad_user.set_username("user").unwrap();
    let mut bad_password = valid.clone();
    bad_password.set_password(Some("p")).unwrap();
    let mut bad_fragment = valid.clone();
    bad_fragment.set_fragment(Some("x"));
    let mut ambiguous = valid.clone();
    ambiguous.query_pairs_mut().append_pair("tab", TARGET);
    let long_tab = "x".repeat(129);
    let long_origin = format!("http://{}", "x".repeat(260));
    for request in [
        bad_port, bad_user, bad_password, bad_fragment, ambiguous,
        signed(KEY, DOC, 1, NOW, ORIGIN, ""),
        signed(KEY, DOC, 1, NOW, ORIGIN, &long_tab),
        signed(KEY, DOC, 1, NOW, ORIGIN, "bad\n"),
        signed(KEY, DOC, 1, NOW, ORIGIN, "悪"),
        signed(KEY, DOC, 1, NOW, ORIGIN, "bad/"),
        signed(KEY, DOC, 1, NOW, &long_origin, TARGET),
        signed(KEY, "shortdoc", 1, NOW, ORIGIN, TARGET),
    ] {
        assert_eq!(gate.consume(&request, "browser", NOW, now, || false), OperatorFocusDecision::Discard);
    }
    assert_eq!(gate.consume(&valid, "browser", NOW, now, || false), focus());
}

#[test]
fn bounds_recent_documents_without_reusing_an_evicted_number() {
    let mut gate = OperatorFocusGate::with_key(KEY.into());
    let now = Instant::now();
    let first = good(1);
    assert_eq!(gate.consume(&first, "browser", NOW, now, || false), focus());
    for doc in 2..=MAX_DOCUMENTS + 2 {
        let elapsed = doc as u64;
        let request = signed(KEY, &format!("{doc:032x}"), 1, NOW + elapsed, ORIGIN, TARGET);
        assert_eq!(gate.consume(&request, "browser", NOW + elapsed, now + Duration::from_millis(elapsed), || false), OperatorFocusDecision::Discard);
    }
    assert_eq!(gate.document_count(), MAX_DOCUMENTS);
    assert_eq!(gate.consume(&first, "browser", NOW + 500, now + Duration::from_millis(500), || false), OperatorFocusDecision::Discard);
}


#[test]
fn automation_mark_applies_to_the_source_label_regardless_of_press_time() {
    let source = super::super::webview_label("source").unwrap();
    let other = super::super::webview_label("other").unwrap();
    let mut touches = AutomationTouches::default();
    touches.mark(&source);
    for pressed in [NOW - 1_500, NOW, NOW + 50] {
        let url = signed(KEY, DOC, 1, pressed, ORIGIN, TARGET);
        let now = Instant::now();
        // A fresh gate represents a new webview under the same tab ID.
        let mut recreated = OperatorFocusGate::with_key(KEY.into());
        assert_eq!(
            operator_focus_decision(&mut recreated, &url, "browser", &source, NOW, now, &touches),
            OperatorFocusDecision::AutomationRefused,
        );
        let mut clean = OperatorFocusGate::with_key(KEY.into());
        assert_eq!(
            operator_focus_decision(&mut clean, &url, "browser", &other, NOW, now, &touches),
            focus(),
        );
    }
}



#[test]
fn command_origin_defaults_to_marking_before_an_already_signed_request_arrives() {
    let source = super::super::webview_label("command-source").unwrap();
    let other = super::super::webview_label("unrelated-source").unwrap();
    let now = Instant::now();
    let request = signed(KEY, DOC, 1, NOW - 100, ORIGIN, TARGET);
    for (automation, expected) in [
        (None, OperatorFocusDecision::AutomationRefused),
        (Some(true), OperatorFocusDecision::AutomationRefused),
        (Some(false), focus()),
    ] {
        let mut touches = AutomationTouches::default();
        touches.record_command(&source, automation);
        let mut gate = OperatorFocusGate::with_key(KEY.into());
        assert_eq!(
            operator_focus_decision(&mut gate, &request, "browser", &source, NOW, now, &touches),
            expected,
            "origin: {automation:?}",
        );
        let mut other_gate = OperatorFocusGate::with_key(KEY.into());
        assert_eq!(
            operator_focus_decision(&mut other_gate, &request, "browser", &other, NOW, now, &touches),
            focus(),
        );
    }
}

#[test]
fn acknowledgement_matches_one_unexpired_request_and_consumes_it() {
    let mut pending = PendingFocusRequests::default();
    let now = Instant::now();
    let expected = pending.remember("main", now);
    let other = pending.remember("mycmux-w2", now);
    assert_ne!(expected, other);
    assert!(is_hex(&expected, 32));
    assert_eq!(pending.consume(Some("00000000000000000000000000000000"), now), None);
    assert_eq!(pending.consume(Some("invalid"), now), None);
    assert_eq!(pending.consume(Some(&expected), now + Duration::from_millis(4_999)), Some("main".into()));
    assert_eq!(pending.consume(Some(&expected), now), None);
    assert_eq!(pending.consume(Some(&other), now + ACK_TIMEOUT), None);
    assert!(pending.0.is_empty());
}


#[test]
fn production_length_click_key_matches_the_vm_and_node_vector() {
    let key = "0123456789abcdef".repeat(4);
    let url = signed(&key, "07070707070707070707070707070707", 1, NOW, ORIGIN, "terminal.fixture-1:2");
    assert_eq!(url.path_segments().unwrap().last(), Some("68209799e620ec44dfcf78f0339df6da92fcae02e70181aac891dc23cf713ebc"));
}
