CREATE TABLE IF NOT EXISTS heavy_aggregate_day (
    day INTEGER PRIMARY KEY, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS heavy_aggregate_dirty (day INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS heavy_session_day (
    day INTEGER NOT NULL, kind TEXT NOT NULL, session_id TEXT NOT NULL,
    PRIMARY KEY(day,kind,session_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_heavy_session_day_session
    ON heavy_session_day(kind,session_id,day);
CREATE TABLE IF NOT EXISTS heavy_rhythm_day (
    day INTEGER NOT NULL, hour INTEGER NOT NULL, turns INTEGER NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL, cost_usd REAL NOT NULL,
    PRIMARY KEY(day,hour)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS heavy_handoff_chunk (
    day INTEGER NOT NULL, granularity TEXT NOT NULL, kind TEXT NOT NULL,
    session_id TEXT NOT NULL, segment INTEGER NOT NULL,
    first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL, turns INTEGER NOT NULL,
    PRIMARY KEY(day,granularity,kind,session_id,segment)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS heavy_handoff_pair (
    day INTEGER NOT NULL, granularity TEXT NOT NULL, kind TEXT NOT NULL,
    session_id TEXT NOT NULL, segment INTEGER NOT NULL,
    from_name TEXT NOT NULL, to_name TEXT NOT NULL, n INTEGER NOT NULL,
    PRIMARY KEY(day,granularity,kind,session_id,segment,from_name,to_name)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS heavy_tool_day (
    day INTEGER NOT NULL, kind TEXT NOT NULL, session_id TEXT NOT NULL,
    name TEXT NOT NULL, target TEXT NOT NULL, executions INTEGER NOT NULL,
    failures INTEGER NOT NULL,
    PRIMARY KEY(day,kind,session_id,name,target)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_heavy_tool_day_session
    ON heavy_tool_day(kind,session_id,day);
CREATE TABLE IF NOT EXISTS heavy_file_session (
    kind TEXT NOT NULL, session_id TEXT NOT NULL, path TEXT NOT NULL,
    edit_count INTEGER NOT NULL,
    PRIMARY KEY(kind,session_id,path)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS heavy_file_ready (
    kind TEXT NOT NULL, session_id TEXT NOT NULL, ready INTEGER NOT NULL,
    PRIMARY KEY(kind,session_id)
) WITHOUT ROWID;
INSERT OR IGNORE INTO index_state(key,value) VALUES ('heavy_aggregate_version','1');

-- Remove the unshipped 33adbba49 prototype without modifying any v0.90.0 trigger.
DROP TRIGGER IF EXISTS heavy_legacy_session_insert;
DROP TRIGGER IF EXISTS heavy_legacy_session_update;
DROP TRIGGER IF EXISTS heavy_legacy_session_delete;
DROP TRIGGER IF EXISTS heavy_legacy_turn_insert;
DROP TRIGGER IF EXISTS heavy_legacy_turn_update;
DROP TRIGGER IF EXISTS heavy_legacy_turn_delete;
DROP TRIGGER IF EXISTS heavy_legacy_tool_event_insert;
DROP TRIGGER IF EXISTS heavy_legacy_tool_event_update;
DROP TRIGGER IF EXISTS heavy_legacy_tool_event_delete;
DROP TRIGGER IF EXISTS heavy_legacy_file_touch_insert;
DROP TRIGGER IF EXISTS heavy_legacy_file_touch_update;
DROP TRIGGER IF EXISTS heavy_legacy_file_touch_delete;
DROP TABLE IF EXISTS heavy_aggregate_untracked_session;
DELETE FROM index_state WHERE key='heavy_aggregate_writer_guard';
