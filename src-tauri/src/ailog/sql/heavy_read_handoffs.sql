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
), raw AS MATERIALIZED (
    SELECT t.kind,t.session_id,t.seq,
           CASE WHEN ?3='raw' THEN t.model ELSE t.model_family END AS name
    FROM raw_ranges g CROSS JOIN turn t INDEXED BY ix_turn_ts ON t.ts>=g.lo AND t.ts<=g.hi
    JOIN session s USING(kind,session_id)
    WHERE t.ts>=?1 AND t.ts<=?2 AND t.usage_state IN ('canonical','legacy')
      AND COALESCE(s.origin,'unknown')<>'ailog-internal'
), chunks AS MATERIALIZED (
    SELECT c.kind,c.session_id,c.first_seq,c.first_name,c.last_name,c.turns
    FROM ready d JOIN heavy_handoff_chunk c USING(day) WHERE c.granularity=?3
    UNION ALL
    SELECT kind,session_id,seq,name,name,1 FROM raw WHERE name IS NOT NULL
), bridges AS (
    SELECT first_name,LAG(last_name) OVER (
        PARTITION BY kind,session_id ORDER BY first_seq) AS previous FROM chunks
), pairs AS (
    SELECT p.from_name,p.to_name,p.n FROM ready d JOIN heavy_handoff_pair p USING(day)
    WHERE p.granularity=?3
    UNION ALL
    SELECT previous,first_name,1 FROM bridges WHERE previous IS NOT NULL AND previous<>first_name
), result AS (
    SELECT from_name,to_name,SUM(n) AS n FROM pairs GROUP BY from_name,to_name
), metrics AS (
    SELECT (SELECT COUNT(*) FROM raw) AS raw_turns,
           (SELECT COUNT(*) FROM ready d JOIN heavy_handoff_chunk c USING(day)
            WHERE c.granularity=?3) AS rollup_rows,
           (SELECT COUNT(*) FROM ready) AS ready_days
)
SELECT r.from_name,r.to_name,r.n,m.raw_turns,m.rollup_rows,m.ready_days
FROM metrics m LEFT JOIN result r ON 1=1 ORDER BY r.n DESC,r.from_name,r.to_name
