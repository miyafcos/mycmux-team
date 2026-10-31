INSERT INTO heavy_rhythm_day
SELECT ?1,((t.ts+32400000)/3600000)%24,COUNT(*),
       COALESCE(SUM(t.input_tokens),0),COALESCE(SUM(t.output_tokens),0),
       COALESCE(SUM(t.cache_read_tokens),0),
       COALESCE(SUM(t.cache_write_5m_tokens+t.cache_write_1h_tokens),0),
       COALESCE(SUM(t.cost_usd),0)
FROM turn t JOIN session s USING(kind,session_id)
WHERE t.ts>=?2 AND t.ts<=?3 AND t.usage_state IN ('canonical','legacy')
  AND COALESCE(s.origin,'unknown')<>'ailog-internal'
GROUP BY ((t.ts+32400000)/3600000)%24
