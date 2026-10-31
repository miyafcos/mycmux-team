INSERT INTO heavy_tool_day
SELECT ?1,te.kind,te.session_id,te.name,COALESCE(NULLIF(TRIM(te.target),''),''),
       COUNT(*),SUM(COALESCE(te.is_error,0)<>0)
FROM tool_event te JOIN session s USING(kind,session_id)
WHERE te.ts>=?2 AND te.ts<=?3 AND COALESCE(s.origin,'unknown')<>'ailog-internal'
GROUP BY te.kind,te.session_id,te.name,COALESCE(NULLIF(TRIM(te.target),''),'')
