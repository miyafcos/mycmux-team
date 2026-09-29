use crate::models::SessionEntry;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Matcher, Utf32Str};

pub fn rank_sessions(entries: &[SessionEntry], query: &str, limit: usize) -> Vec<SessionEntry> {
    let query = query.trim();
    if query.is_empty() {
        return entries.iter().take(limit).cloned().collect();
    }

    let mut matcher = Matcher::new(nucleo_matcher::Config::DEFAULT);
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut scored = entries
        .iter()
        .filter_map(|entry| {
            let text = entry.search_text();
            let mut buf = Vec::new();
            let haystack = Utf32Str::new(text.as_str(), &mut buf);
            pattern
                .score(haystack, &mut matcher)
                .map(|score| (score, entry))
        })
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.last_activity.cmp(&a.1.last_activity))
    });
    scored
        .into_iter()
        .take(limit)
        .map(|(_, entry)| entry.clone())
        .collect()
}
