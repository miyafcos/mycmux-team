use std::collections::VecDeque;

use super::preview_links::click_mac;
use super::super::webpane_native::input_activity::{CLOCK_SKEW_MS, PROOF_AGE_MS};

pub(super) const MAX_DOCUMENTS: usize = 8;

pub(super) fn new_key() -> String {
    hex::encode(rand::random::<[u8; 32]>())
}

pub(super) fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn authenticates(key: &str, message: &str, mac: &str) -> bool {
    // The caller validates that the supplied digest has exactly 64 hex bytes.
    let expected = click_mac(key, message);
    let difference = expected.bytes().zip(mac.bytes())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right));
    difference == 0
}

pub(super) fn fresh(pressed: u64, now: u64) -> bool {
    pressed >= now.saturating_sub(PROOF_AGE_MS) && pressed <= now.saturating_add(CLOCK_SKEW_MS)
}

struct DocumentSequence {
    nonce: String,
    number: u64,
    latest_press: u64,
}

#[derive(Default)]
pub(super) struct Sequences {
    documents: VecDeque<DocumentSequence>,
    evicted_through: Option<u64>,
}

impl Sequences {
    pub(super) fn consume(
        &mut self,
        nonce: &str,
        number: u64,
        pressed: u64,
        in_order: impl FnOnce(u64) -> bool,
    ) -> bool {
        let position = self.documents.iter().position(|doc| doc.nonce == nonce);
        if !in_order(position.map_or(0, |index| self.documents[index].number)) {
            return false;
        }
        if position.is_none() && self.evicted_through.is_some_and(|time| pressed <= time) {
            return false;
        }

        let mut document = position.and_then(|index| self.documents.remove(index))
            .unwrap_or_else(|| DocumentSequence { nonce: nonce.into(), number: 0, latest_press: 0 });
        document.number = number;
        document.latest_press = document.latest_press.max(pressed);
        self.documents.push_back(document);

        // Freshness alone must not let a proof replay after its document is evicted.
        if self.documents.len() > MAX_DOCUMENTS {
            if let Some(evicted) = self.documents.pop_front() {
                self.evicted_through = Some(self.evicted_through.unwrap_or(0).max(evicted.latest_press));
            }
        }
        true
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.documents.len()
    }
}
