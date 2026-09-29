//! Searchable, evidence-backed event history. This layer is deliberately
//! mechanical: it neither invokes models nor exposes Tauri commands.

mod capsule;
mod model;
mod schema;
mod search;
mod store;

pub(crate) use model::{HistoryError, Hit, IngestInput, JournalEvent, SearchFilters};

pub(crate) fn try_ingest(input: &IngestInput<'_>) {
    let Ok(path) = store::db_path() else {
        return;
    };
    let _ = store::ingest_at(&path, input);
}

pub(crate) fn try_ingest_at(path: &std::path::Path, input: &IngestInput<'_>) {
    let _ = store::ingest_at(path, input);
}

pub(crate) fn search(
    query: &str,
    filters: &SearchFilters,
    limit: usize,
) -> Result<Vec<Hit>, HistoryError> {
    let path = store::db_path()?;
    store::search_at(&path, query, filters, limit)
}

#[cfg(test)]
mod eval;
#[cfg(test)]
mod tests;
