CREATE TEMP TABLE IF NOT EXISTS heavy_build_session (
    kind TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(kind,session_id)
) WITHOUT ROWID;
CREATE TEMP TABLE IF NOT EXISTS heavy_build_sequence (
    granularity TEXT NOT NULL,kind TEXT NOT NULL,session_id TEXT NOT NULL,
    segment INTEGER NOT NULL,seq INTEGER NOT NULL,name TEXT NOT NULL,previous TEXT,
    PRIMARY KEY(granularity,kind,session_id,segment,seq)
) WITHOUT ROWID;
DELETE FROM heavy_build_session;
DELETE FROM heavy_build_sequence;
INSERT INTO heavy_build_session
SELECT kind,session_id FROM turn WHERE ts>=?2 AND ts<=?3
UNION SELECT kind,session_id FROM heavy_session_day WHERE day=?1;
DELETE FROM heavy_handoff_pair WHERE day=?1;
DELETE FROM heavy_handoff_chunk WHERE day=?1;
DELETE FROM heavy_rhythm_day WHERE day=?1;
DELETE FROM heavy_tool_day WHERE day=?1;
DELETE FROM heavy_session_day WHERE day=?1;
DELETE FROM heavy_file_session WHERE (kind,session_id) IN (SELECT kind,session_id FROM heavy_build_session);
