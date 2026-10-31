INSERT INTO heavy_session_day
SELECT ?1,t.kind,t.session_id FROM turn t JOIN session s USING(kind,session_id)
WHERE t.ts>=?2 AND t.ts<=?3 AND t.usage_state IN ('canonical','legacy')
  AND COALESCE(s.origin,'unknown')<>'ailog-internal'
GROUP BY t.kind,t.session_id;
INSERT INTO heavy_file_ready(kind,session_id,ready)
SELECT kind,session_id,1 FROM heavy_build_session WHERE 1
ON CONFLICT(kind,session_id) DO UPDATE SET ready=1;
INSERT INTO heavy_aggregate_day(day,start_ts,end_ts) VALUES (?1,?2,?3)
ON CONFLICT(day) DO UPDATE SET start_ts=excluded.start_ts,end_ts=excluded.end_ts;
DELETE FROM heavy_aggregate_dirty WHERE day=?1;
INSERT INTO index_state(key,value)
SELECT 'heavy_aggregate_cursor',CAST(?1 AS TEXT) WHERE ?4
ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS INTEGER),?1) AS TEXT);
