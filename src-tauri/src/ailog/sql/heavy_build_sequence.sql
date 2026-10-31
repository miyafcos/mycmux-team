INSERT INTO heavy_build_sequence
WITH names AS (
    SELECT t.kind,t.session_id,t.seq,(t.ts+32400000)/86400000 AS day,
           'raw' AS granularity,t.model AS name
    FROM heavy_build_session q CROSS JOIN turn t USING(kind,session_id)
    JOIN session s USING(kind,session_id)
    WHERE t.usage_state IN ('canonical','legacy') AND t.model IS NOT NULL
      AND COALESCE(s.origin,'unknown')<>'ailog-internal'
    UNION ALL
    SELECT t.kind,t.session_id,t.seq,(t.ts+32400000)/86400000,
           'family',t.model_family
    FROM heavy_build_session q CROSS JOIN turn t USING(kind,session_id)
    JOIN session s USING(kind,session_id)
    WHERE t.usage_state IN ('canonical','legacy') AND t.model_family IS NOT NULL
      AND COALESCE(s.origin,'unknown')<>'ailog-internal'
), previous AS (
    SELECT *,LAG(day) OVER (
        PARTITION BY granularity,kind,session_id ORDER BY seq) AS previous_day
    FROM names
), segmented AS (
    SELECT *,SUM(CASE WHEN day=previous_day THEN 0 ELSE 1 END) OVER (
        PARTITION BY granularity,kind,session_id ORDER BY seq) AS segment
    FROM previous
), selected AS (
    SELECT * FROM segmented WHERE day=?1
)
SELECT granularity,kind,session_id,segment,seq,name,
       LAG(name) OVER (PARTITION BY granularity,kind,session_id,segment ORDER BY seq)
FROM selected
