WITH ready AS MATERIALIZED (
    SELECT d.day,d.start_ts,d.end_ts FROM heavy_aggregate_day d
    WHERE d.start_ts>=?1 AND d.end_ts<=?2
      AND NOT EXISTS(SELECT 1 FROM heavy_aggregate_dirty x WHERE x.day=d.day)
      AND NOT EXISTS(SELECT 1 FROM rollup_dirty x WHERE x.day=d.day)
), raw_ranges AS MATERIALIZED (
    SELECT lo,hi FROM (
        SELECT COALESCE(LAG(end_ts) OVER (ORDER BY start_ts)+1,?1) AS lo,start_ts-1 AS hi FROM ready
        UNION ALL SELECT COALESCE(MAX(end_ts)+1,?1),?2 FROM ready
    ) WHERE lo<=hi
), raw_keys AS MATERIALIZED (
    SELECT t.kind,t.session_id,COUNT(*) AS turns
    FROM raw_ranges g CROSS JOIN turn t INDEXED BY ix_turn_ts ON t.ts>=g.lo AND t.ts<=g.hi
    JOIN session s USING(kind,session_id)
    WHERE t.ts>=?1 AND t.ts<=?2 AND t.usage_state IN ('canonical','legacy')
      AND COALESCE(s.origin,'unknown')<>'ailog-internal'
    GROUP BY t.kind,t.session_id
), requested(kind,session_id) AS MATERIALIZED (
    SELECT k.kind,k.session_id FROM ready d JOIN heavy_session_day k USING(day)
    UNION SELECT kind,session_id FROM raw_keys
), entries AS MATERIALIZED (
    SELECT r.path,r.edit_count,0 AS raw_rows,1 AS aggregate_rows FROM requested q
    JOIN heavy_file_ready f USING(kind,session_id)
    JOIN heavy_file_session r USING(kind,session_id) WHERE f.ready=1
    UNION ALL
    SELECT ft.path,ft.edit_count,1,0 FROM requested q JOIN file_touch ft USING(kind,session_id)
    JOIN session s USING(kind,session_id)
    WHERE COALESCE(ft.edit_count,0)>=3 AND COALESCE(s.origin,'unknown')<>'ailog-internal'
      AND NOT EXISTS(SELECT 1 FROM heavy_file_ready f
                     WHERE f.kind=q.kind AND f.session_id=q.session_id AND f.ready=1)
) , result AS (
SELECT path,SUM(edit_count) AS edits,COUNT(*) AS sessions FROM entries GROUP BY path
ORDER BY edits DESC,sessions DESC,path LIMIT 10
), metrics AS (
    SELECT COALESCE(SUM(raw_rows),0) AS raw_rows,COALESCE(SUM(aggregate_rows),0) AS aggregate_rows,
           (SELECT COALESCE(SUM(turns),0) FROM raw_keys) AS raw_turns FROM entries
)
SELECT r.path,r.edits,r.sessions,m.raw_rows,m.aggregate_rows,m.raw_turns
FROM metrics m LEFT JOIN result r ON 1=1 ORDER BY r.edits DESC,r.sessions DESC,r.path
