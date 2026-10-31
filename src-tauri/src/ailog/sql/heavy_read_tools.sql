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
    SELECT r.name,NULLIF(r.target,'') AS target,r.executions,r.failures,0 AS raw_rows,1 AS aggregate_rows
    FROM ready d JOIN heavy_tool_day r USING(day) JOIN requested q USING(kind,session_id)
    UNION ALL
    SELECT te.name,NULLIF(TRIM(te.target),''),COUNT(*),SUM(COALESCE(te.is_error,0)<>0),COUNT(*),0
    FROM raw_ranges g CROSS JOIN tool_event te INDEXED BY ix_tool_event_ts ON te.ts>=g.lo AND te.ts<=g.hi
    JOIN requested q USING(kind,session_id)
    JOIN session s USING(kind,session_id)
    WHERE te.ts>=?1 AND te.ts<=?2 AND COALESCE(s.origin,'unknown')<>'ailog-internal'
    GROUP BY te.name,NULLIF(TRIM(te.target),'')
) , result AS (
SELECT name,target,SUM(executions) AS executions,SUM(failures) AS failures
FROM entries GROUP BY name,target HAVING SUM(failures)>0
ORDER BY failures DESC,executions DESC,name,target LIMIT 10
), metrics AS (
    SELECT (SELECT COALESCE(SUM(turns),0) FROM raw_keys) AS raw_turns,
           COALESCE(SUM(raw_rows),0) AS raw_rows,COALESCE(SUM(aggregate_rows),0) AS aggregate_rows,
           (SELECT COUNT(*) FROM ready) AS ready_days FROM entries
)
SELECT r.name,r.target,r.executions,r.failures,m.raw_turns,m.raw_rows,m.aggregate_rows,m.ready_days
FROM metrics m LEFT JOIN result r ON 1=1
ORDER BY r.failures DESC,r.executions DESC,r.name,r.target
