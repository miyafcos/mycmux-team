use serde::Deserialize;

use super::input_proof::{authenticates, fresh, is_hex, Sequences};
use super::WebPaneForwardedKey;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ShortcutProof {
    document: String,
    sequence: u64,
    pressed_at: u64,
    mac: String,
}

pub(super) struct ShortcutProofGate {
    key: String,
    sequences: Sequences,
}

impl ShortcutProofGate {
    pub(super) fn with_key(key: String) -> Self {
        Self { key, sequences: Sequences::default() }
    }

    pub(super) fn accepts(
        &mut self,
        payload: &WebPaneForwardedKey,
        now: u64,
        blocks: impl FnOnce(u64) -> bool,
    ) -> bool {
        let Some(proof) = &payload.proof else { return false };
        let ShortcutProof { document, sequence, pressed_at, mac } = proof;
        if !is_hex(document, 32) || *sequence == 0 || !is_hex(mac, 64) {
            return false;
        }
        // The shape check has already ruled out newlines in user-supplied strings.
        let message = format!(
            "{document}\n{sequence}\n{pressed_at}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            payload.tab_id, payload.key, payload.code, payload.location,
            payload.ctrl_key, payload.alt_key, payload.shift_key, payload.meta_key,
            payload.repeat, payload.is_composing,
        );
        if !authenticates(&self.key, &message, mac) {
            return false;
        }
        if !self.sequences.consume(document, *sequence, *pressed_at, |previous| *sequence > previous) {
            return false;
        }
        fresh(*pressed_at, now) && !blocks(*pressed_at)
    }
}

#[cfg(test)]
#[path = "webpane_shortcut_proof_tests.rs"]
mod tests;
