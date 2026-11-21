use super::*;
use super::super::preview_links::click_mac;

const KEY: &str = "test-only-shortcut-key";
const DOC: &str = "0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c";
const NOW: u64 = 1_800_000_000_000;

fn payload() -> WebPaneForwardedKey {
    WebPaneForwardedKey {
        tab_id: "tab_1".into(), key: "Tab".into(), code: "Tab".into(), location: 0,
        ctrl_key: true, alt_key: false, shift_key: false, meta_key: false,
        repeat: false, is_composing: false, proof: None,
    }
}

fn signed(mut key: WebPaneForwardedKey, document: &str, sequence: u64, pressed_at: u64) -> WebPaneForwardedKey {
    let fields = [
        document.into(), sequence.to_string(), pressed_at.to_string(),
        key.tab_id.clone(), key.key.clone(), key.code.clone(), key.location.to_string(),
        key.ctrl_key.to_string(), key.alt_key.to_string(), key.shift_key.to_string(),
        key.meta_key.to_string(), key.repeat.to_string(), key.is_composing.to_string(),
    ];
    key.proof = Some(ShortcutProof {
        document: document.into(), sequence, pressed_at, mac: click_mac(KEY, &fields.join("\n")),
    });
    key
}

fn gate() -> ShortcutProofGate {
    ShortcutProofGate::with_key(KEY.into())
}

#[test]
fn accepts_the_document_start_vm_proof_and_emits_only_the_key() {
    let mut key = payload();
    key.proof = Some(ShortcutProof {
        document: DOC.into(),
        sequence: 1,
        pressed_at: NOW,
        mac: "b8b51c94446f11bb8642e96c63b0a88ef10e091aec18445325bf433f52f6305c".into(),
    });
    assert!(super::super::authorize_forwarded_shortcut(
        "web-pane-tab_1", &["ctrl+tab".to_string()], &key, false, &mut gate(), NOW, &super::super::input_activity::InputIntervals::default(),
    ).is_ok());
    let forwarded = serde_json::to_value(key).unwrap();
    assert_eq!(forwarded["code"], "Tab");
    assert!(forwarded.get("proof").is_none());
}

#[test]
fn rejects_absent_or_false_proofs_without_consuming_a_valid_number() {
    let mut verifier = gate();
    let key = payload();
    assert!(!verifier.accepts(&key, NOW, |_| false));
    let valid = signed(key, DOC, 1, NOW);
    let mut invalid = valid.clone();
    invalid.proof.as_mut().unwrap().mac = "a".repeat(64);
    assert!(!verifier.accepts(&invalid, NOW, |_| false));
    assert!(verifier.accepts(&valid, NOW, |_| false));
}

#[test]
fn accepts_only_newer_numbers_of_each_document_even_if_some_keys_arrive_out_of_order() {
    let mut verifier = gate();
    let one = signed(payload(), DOC, 1, NOW);
    let two = signed(payload(), DOC, 2, NOW);
    let three = signed(payload(), DOC, 3, NOW);
    let four = signed(payload(), DOC, 4, NOW);
    assert!(verifier.accepts(&one, NOW, |_| false));
    assert!(verifier.accepts(&three, NOW, |_| false));
    assert!(!verifier.accepts(&two, NOW, |_| false));
    assert!(!verifier.accepts(&three, NOW, |_| false));
    assert!(verifier.accepts(&four, NOW, |_| false));

    let another = signed(payload(), "00000000000000000000000000000001", 1, NOW);
    assert!(verifier.accepts(&another, NOW, |_| false));
}

#[test]
fn rejects_signed_keys_outside_the_shared_time_window() {
    let mut verifier = gate();
    for (seq, pressed) in [(1, NOW - 2_001), (2, NOW + 101)] {
        let key = signed(payload(), DOC, seq, pressed);
        assert!(!verifier.accepts(&key, NOW, |_| false));
    }
    for (seq, pressed) in [(3, NOW - 2_000), (4, NOW + 100)] {
        let key = signed(payload(), DOC, seq, pressed);
        assert!(verifier.accepts(&key, NOW, |_| false));
    }
}

#[test]
fn refuses_keys_during_input_or_grace_including_held_proofs_after_completion() {
    use super::super::input_activity::{InputAttempt, InputIntervals};
    use std::sync::Mutex;

    let mut verifier = gate();
    let registered = ["ctrl+tab".to_string()];
    let label = "web-pane-tab_1";
    let table = Mutex::new(InputIntervals::default());
    let running = InputAttempt::begin_in(&table, label, None, NOW, || NOW + 100);
    let receipt = running.receipt();
    assert!(receipt.begin_pending());
    let accepts = |gate: &mut ShortcutProofGate, seq, pressed, arrival| {
        let key = signed(payload(), DOC, seq, pressed);
        super::super::authorize_forwarded_shortcut(
            label, &registered, &key, false, gate, arrival, &table.lock().unwrap(),
        ).is_ok()
    };

    assert!(!accepts(&mut verifier, 1, NOW - 500, NOW + 50));
    drop(running);
    let delayed = NOW + 3_600_000;
    assert!(!accepts(&mut verifier, 2, delayed, delayed));
    receipt.complete(delayed);
    for (seq, pressed) in [(3, delayed - 50), (4, delayed + 1_500)] {
        assert!(!accepts(&mut verifier, seq, pressed, delayed + 1_700));
    }
    assert!(accepts(&mut verifier, 5, delayed + 1_501, delayed + 1_701));
}

#[test]
fn only_a_valid_registered_key_blocked_by_an_outstanding_reply_gets_the_wait_reason() {
    use super::super::input_activity::{InputAttempt, InputIntervals};
    use super::super::{authorize_forwarded_shortcut, ShortcutForwardingDenial};
    use std::sync::Mutex;

    let label = "web-pane-tab_1";
    let registered = ["ctrl+tab".to_string()];
    let table = Mutex::new(InputIntervals::default());
    let input = InputAttempt::begin_in(&table, label, None, NOW, || NOW + 60);
    let receipt = input.receipt();
    let authorize = |key: &WebPaneForwardedKey, shortcuts: &[String], now| {
        authorize_forwarded_shortcut(label, shortcuts, key, false, &mut gate(), now, &table.lock().unwrap())
    };
    let valid = signed(payload(), DOC, 1, NOW);
    assert_eq!(authorize(&valid, &registered, NOW), Err(ShortcutForwardingDenial::Rejected));

    assert!(receipt.begin_pending());
    assert_eq!(authorize(&valid, &registered, NOW), Err(ShortcutForwardingDenial::AwaitingReply));
    assert_eq!(authorize(&valid, &[], NOW), Err(ShortcutForwardingDenial::Rejected));
    assert_eq!(authorize(&payload(), &registered, NOW), Err(ShortcutForwardingDenial::Rejected));
    assert_eq!(authorize(&valid, &registered, NOW + 2_001), Err(ShortcutForwardingDenial::Rejected));

    drop(input);
    receipt.complete(NOW + 100);
    assert_eq!(authorize(&valid, &registered, NOW + 101), Err(ShortcutForwardingDenial::Rejected));
    let fresh = signed(payload(), DOC, 2, NOW + 1_601);
    assert_eq!(authorize(&fresh, &registered, NOW + 1_601), Ok(()));
}

#[test]
fn authenticates_all_forwarded_fields() {
    let original = signed(payload(), DOC, 1, NOW);
    let edits: [fn(&mut WebPaneForwardedKey); 10] = [
        |key| key.tab_id = "other".into(), |key| key.key = "ArrowUp".into(),
        |key| key.code = "NumpadEnter".into(), |key| key.location = 1,
        |key| key.ctrl_key = false, |key| key.alt_key = true,
        |key| key.shift_key = true, |key| key.meta_key = true,
        |key| key.repeat = true, |key| key.is_composing = true,
    ];
    let mut verifier = gate();
    for edit in edits {
        let mut changed = original.clone();
        edit(&mut changed);
        assert!(!verifier.accepts(&changed, NOW, |_| false));
    }
    assert!(verifier.accepts(&original, NOW, |_| false));
}

#[test]
fn matches_the_rfc_4231_jefe_vector() {
    assert!(super::super::input_proof::authenticates(
        "Jefe", "what do ya want for nothing?",
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    ));
}


#[test]
fn production_length_shortcut_key_matches_the_vm_and_node_vector() {
    let key = "0123456789abcdef".repeat(4);
    let message = format!("{DOC}\n1\n{NOW}\ntab_1\nTab\nTab\n0\ntrue\nfalse\nfalse\nfalse\nfalse\nfalse");
    assert!(super::super::input_proof::authenticates(&key, &message, "4774fa48cba1f5cd7a834ec45374dff04a0ea4e51d8886c35b927c2bd33cf675"));
}
