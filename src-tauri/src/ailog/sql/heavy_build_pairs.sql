INSERT INTO heavy_handoff_pair
SELECT ?1,granularity,kind,session_id,segment,previous,name,COUNT(*)
FROM heavy_build_sequence
WHERE previous IS NOT NULL AND previous<>name
GROUP BY granularity,kind,session_id,segment,previous,name
