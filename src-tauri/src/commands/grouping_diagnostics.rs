use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupingTraceRecord {
    operation_id: String,
    stages: GroupingStages,
    reason: GroupingReason,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct GroupingStages {
    entry: u64,
    settings: Option<u64>,
    scan: Option<u64>,
    jev: Option<u64>,
    prepare: Option<u64>,
    apply: Option<u64>,
    finish: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum GroupingReason {
    Shown,
    Applied,
    Undone,
    Folded,
    Cancelled,
    Timeout,
    Error,
    Frame,
    Timer,
}

fn format_record(record: &GroupingTraceRecord) -> Result<String, String> {
    if record.operation_id.is_empty()
        || record.operation_id.len() > 48
        || !record.operation_id.bytes().all(|b| b.is_ascii_digit() || b == b'-')
        || record.stages.finish < record.stages.entry
    {
        return Err("invalid_grouping_diagnostic".into());
    }
    serde_json::to_string(record)
        .map(|json| format!("[grouping] {json}"))
        .map_err(|_| "invalid_grouping_diagnostic".into())
}

/// A fixed-schema record cannot carry conversation text, names, or paths.
#[tauri::command]
pub async fn log_grouping_operation(record: GroupingTraceRecord) -> Result<(), String> {
    crate::diag::log(&format_record(&record)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_fixed_stages_on_one_line() {
        let record: GroupingTraceRecord = serde_json::from_str(
            r#"{"operationId":"123-1","stages":{"entry":1,"scan":2,"finish":3},"reason":"shown"}"#,
        ).unwrap();
        let line = format_record(&record).unwrap();
        assert!(line.starts_with("[grouping] "));
        assert!(!line.contains('\n'));
        assert!(line.contains("\"finish\":3"));
    }

    #[test]
    fn rejects_free_text_names_unknown_fields_and_reasons() {
        for json in [
            r#"{"operationId":"Project name","stages":{"entry":1,"finish":2},"reason":"shown"}"#,
            r#"{"operationId":"1-1","stages":{"entry":1,"finish":2},"reason":"Project name"}"#,
            r#"{"operationId":"1-1","stages":{"entry":1,"finish":2},"reason":"shown","name":"Project"}"#,
        ] {
            let parsed = serde_json::from_str::<GroupingTraceRecord>(json);
            assert!(parsed.is_err() || format_record(&parsed.unwrap()).is_err());
        }
    }
}
