//! Usage rhythm: absolute totals, active days, streaks, and the shape of a
//! working day.
//!
//! One filtered day/hour GROUP BY supplies every rhythm view. Only those
//! compact buckets are materialised, and totals/days/weekdays are folded from
//! the same snapshot instead of scanning the complete turn range four times.
//! No LLM, child process or network is involved.
//!
//! Token semantics match the rest of ailog: `total` is
//! `input + output + cache_read + cache_write`, and reasoning tokens are
//! excluded because both providers already count them inside `output`
//! (see [`super::price::cost_for_turn`]).

use std::collections::BTreeMap;
use std::time::Instant;

use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};

use crate::ailog::query::{
    index_freshness, log_report_timings, shared_where, IndexFreshness, RangeOut, ReportTimings,
    DAY_BOUNDARY_OFFSET_MIN,
};
use crate::ailog::{Filters, Range};

const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmTotals {
    pub turns: i64,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    /// input + output + cache_read + cache_write.
    pub total: i64,
    /// input + output. What was actually sent and generated fresh.
    pub io: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmDay {
    /// Start of the local day, as a UTC epoch-millisecond timestamp, so it can
    /// be formatted with the same helper as every other day bucket.
    pub day: i64,
    pub turns: i64,
    pub io: i64,
    pub total: i64,
    pub cost_usd: f64,
}

/// One hour-of-day (0-23) or weekday (0 = Sunday) slot. Always emitted for the
/// full cycle, including slots with no activity, so the shape of the week is
/// not distorted by dropped entries.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmSlot {
    pub slot: i64,
    pub turns: i64,
    pub io: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreakInfo {
    /// Consecutive active days ending at [`Self::current_through_day`] — which
    /// is the last day with activity, not necessarily today. The caller shows
    /// the end date so a stale streak cannot read as an ongoing one.
    pub current: i64,
    pub current_through_day: Option<i64>,
    pub longest: i64,
    pub longest_end_day: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRhythmReport {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<super::report_cache::SnapshotInfo>,
    pub range: RangeOut,
    /// Minutes east of UTC used to cut days. Returned so the UI can label the
    /// axis honestly instead of assuming a timezone.
    pub day_offset_minutes: i64,
    pub totals: RhythmTotals,
    pub days: Vec<RhythmDay>,
    pub by_hour: Vec<RhythmSlot>,
    pub by_weekday: Vec<RhythmSlot>,
    /// Days with at least one turn.
    pub active_days: i64,
    /// Calendar days between the first and last active day, inclusive. Zero
    /// when there is no activity at all.
    pub span_days: i64,
    pub first_day: Option<i64>,
    pub last_day: Option<i64>,
    pub streak: StreakInfo,
    pub busiest_total: Option<RhythmDay>,
    pub busiest_io: Option<RhythmDay>,
    pub index_freshness: IndexFreshness,
    pub timings: ReportTimings,
}

pub fn rhythm(
    conn: &Connection,
    range: &Range,
    filters: &Filters,
    now_ms: i64,
) -> Result<UsageRhythmReport, String> {
    super::report_cache::report(
        conn,
        range,
        filters,
        "rhythm",
        &[],
        now_ms,
        || rhythm_fresh(conn, range, filters, now_ms),
    )
}

fn rhythm_fresh(
    conn: &Connection,
    range: &Range,
    filters: &Filters,
    now_ms: i64,
) -> Result<UsageRhythmReport, String> {
    let started = Instant::now();
    let (resolved, label) = range.resolve(now_ms);
    let (where_sql, params) = shared_where(&resolved, filters);
    let shift = DAY_BOUNDARY_OFFSET_MIN * 60_000;

    let sql = format!(
        "SELECT (t.ts + {shift}) / {DAY_MS} AS d, \
         ((t.ts + {shift}) / 3600000) % 24 AS h, COUNT(*), \
         COALESCE(SUM(t.input_tokens),0), COALESCE(SUM(t.output_tokens),0), \
         COALESCE(SUM(t.cache_read_tokens),0), \
         COALESCE(SUM(t.cache_write_5m_tokens + t.cache_write_1h_tokens),0), \
         COALESCE(SUM(t.cost_usd),0) \
         FROM turn t JOIN session s ON s.kind=t.kind AND s.session_id=t.session_id \
         WHERE {where_sql} GROUP BY d, h ORDER BY d, h"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("prepare usage buckets: {err}"))?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |row| {
            let input: i64 = row.get(3)?;
            let output: i64 = row.get(4)?;
            let cache_read: i64 = row.get(5)?;
            let cache_write: i64 = row.get(6)?;
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                RhythmTotals {
                    turns: row.get(2)?,
                    input,
                    output,
                    cache_read,
                    cache_write,
                    total: input + output + cache_read + cache_write,
                    io: input + output,
                    cost_usd: row.get(7)?,
                },
            ))
        })
        .map_err(|err| format!("run usage buckets: {err}"))?;
    let mut totals = RhythmTotals::default();
    let mut daily = BTreeMap::<i64, RhythmDay>::new();
    let mut by_hour = empty_slots(24);
    let mut by_weekday = empty_slots(7);
    for row in rows {
        let (index, hour, bucket) = row.map_err(|err| format!("usage bucket row: {err}"))?;
        totals.turns += bucket.turns;
        totals.input += bucket.input;
        totals.output += bucket.output;
        totals.cache_read += bucket.cache_read;
        totals.cache_write += bucket.cache_write;
        totals.total += bucket.total;
        totals.io += bucket.io;
        totals.cost_usd += bucket.cost_usd;
        let day = daily.entry(index).or_insert_with(|| RhythmDay {
            day: index * DAY_MS - shift,
            turns: 0,
            io: 0,
            total: 0,
            cost_usd: 0.0,
        });
        day.turns += bucket.turns;
        day.io += bucket.io;
        day.total += bucket.total;
        day.cost_usd += bucket.cost_usd;
        for slot in [
            &mut by_hour[hour.rem_euclid(24) as usize],
            &mut by_weekday[(index + 4).rem_euclid(7) as usize],
        ] {
            slot.turns += bucket.turns;
            slot.io += bucket.io;
            slot.total += bucket.total;
        }
    }
    let indices: Vec<i64> = daily.keys().copied().collect();
    let days: Vec<RhythmDay> = daily.into_values().collect();

    let index_freshness = index_freshness(conn);
    let sql_ms = started.elapsed().as_millis().try_into().unwrap_or(u64::MAX);

    let streak = streaks(&indices, shift);
    let active_days = days.len() as i64;
    let span_days = match (indices.first(), indices.last()) {
        (Some(first), Some(last)) => last - first + 1,
        _ => 0,
    };
    let busiest_total = days
        .iter()
        .max_by_key(|day| day.total)
        .filter(|day| day.total > 0)
        .cloned();
    let busiest_io = days
        .iter()
        .max_by_key(|day| day.io)
        .filter(|day| day.io > 0)
        .cloned();

    let timings = ReportTimings {
        sql_ms,
        rows_scanned: totals.turns.max(0) as u64,
        build_ms: started
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
            .saturating_sub(sql_ms),
        path: "raw",
    };
    log_report_timings("usage_rhythm", timings);

    Ok(UsageRhythmReport {
        cache: None,
        range: RangeOut {
            from: resolved.from,
            to: resolved.to,
            label,
        },
        day_offset_minutes: DAY_BOUNDARY_OFFSET_MIN,
        totals,
        first_day: days.first().map(|day| day.day),
        last_day: days.last().map(|day| day.day),
        days,
        by_hour,
        by_weekday,
        active_days,
        span_days,
        streak,
        busiest_total,
        busiest_io,
        index_freshness,
        timings,
    })
}

/// Pad the complete cycle so callers can index slots without holes.
fn empty_slots(cycle: i64) -> Vec<RhythmSlot> {
    (0..cycle)
        .map(|slot| RhythmSlot {
            slot,
            turns: 0,
            io: 0,
            total: 0,
        })
        .collect()
}

/// Longest and current run of consecutive active days.
///
/// `indices` must be the sorted, de-duplicated local-day indices produced by
/// the `GROUP BY`. The current run is measured backwards from the last active
/// day rather than from today: a streak that ended last week is reported with
/// its end date instead of being silently presented as ongoing.
fn streaks(indices: &[i64], shift: i64) -> StreakInfo {
    if indices.is_empty() {
        return StreakInfo::default();
    }
    let mut longest = 1i64;
    let mut longest_end = indices[0];
    let mut run = 1i64;
    for window in indices.windows(2) {
        if window[1] == window[0] + 1 {
            run += 1;
        } else {
            run = 1;
        }
        if run > longest {
            longest = run;
            longest_end = window[1];
        }
    }

    let mut current = 1i64;
    for window in indices.windows(2).rev() {
        if window[1] == window[0] + 1 {
            current += 1;
        } else {
            break;
        }
    }
    let last = *indices.last().expect("non-empty");

    StreakInfo {
        current,
        current_through_day: Some(last * DAY_MS - shift),
        longest,
        longest_end_day: Some(longest_end * DAY_MS - shift),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(days: &[i64]) -> StreakInfo {
        streaks(days, 0)
    }

    #[test]
    fn empty_history_has_no_streak() {
        let out = info(&[]);
        assert_eq!(out.current, 0);
        assert_eq!(out.longest, 0);
        assert!(out.current_through_day.is_none());
    }

    #[test]
    fn single_day_counts_as_one() {
        let out = info(&[100]);
        assert_eq!(out.current, 1);
        assert_eq!(out.longest, 1);
        assert_eq!(out.current_through_day, Some(100 * DAY_MS));
    }

    #[test]
    fn longest_run_is_reported_with_its_end_date() {
        // 10..14 is five days; 20..21 is the most recent, shorter run.
        let out = info(&[10, 11, 12, 13, 14, 20, 21]);
        assert_eq!(out.longest, 5);
        assert_eq!(out.longest_end_day, Some(14 * DAY_MS));
        assert_eq!(out.current, 2);
        assert_eq!(out.current_through_day, Some(21 * DAY_MS));
    }

    #[test]
    fn a_gap_before_the_last_day_resets_the_current_run() {
        let out = info(&[1, 2, 3, 9]);
        assert_eq!(out.current, 1);
        assert_eq!(out.longest, 3);
    }
}
