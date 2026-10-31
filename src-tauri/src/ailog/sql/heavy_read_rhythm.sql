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
), buckets AS (
    SELECT r.day,r.hour,r.turns,r.input,r.output,r.cache_read,r.cache_write,r.cost_usd,
           0 AS raw_turns,1 AS rollup_rows
    FROM ready d JOIN heavy_rhythm_day r USING(day)
    UNION ALL
    SELECT (t.ts+32400000)/86400000,((t.ts+32400000)/3600000)%24,COUNT(*),
           COALESCE(SUM(t.input_tokens),0),COALESCE(SUM(t.output_tokens),0),
           COALESCE(SUM(t.cache_read_tokens),0),
           COALESCE(SUM(t.cache_write_5m_tokens+t.cache_write_1h_tokens),0),
           COALESCE(SUM(t.cost_usd),0),COUNT(*),0
    FROM raw_ranges g CROSS JOIN turn t INDEXED BY ix_turn_ts ON t.ts>=g.lo AND t.ts<=g.hi
    JOIN session s USING(kind,session_id)
    WHERE t.ts>=?1 AND t.ts<=?2 AND t.usage_state IN ('canonical','legacy')
      AND COALESCE(s.origin,'unknown')<>'ailog-internal'
    GROUP BY (t.ts+32400000)/86400000,((t.ts+32400000)/3600000)%24
)
SELECT day,hour,SUM(turns),SUM(input),SUM(output),SUM(cache_read),SUM(cache_write),
       SUM(cost_usd),SUM(raw_turns),SUM(rollup_rows)
FROM buckets GROUP BY day,hour ORDER BY day,hour
