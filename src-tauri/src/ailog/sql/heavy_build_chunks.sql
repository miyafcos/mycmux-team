INSERT INTO heavy_handoff_chunk
SELECT ?1,granularity,kind,session_id,segment,MIN(seq),MAX(seq),
       (SELECT name FROM heavy_build_sequence n WHERE n.granularity=b.granularity
        AND n.kind=b.kind AND n.session_id=b.session_id AND n.segment=b.segment
        ORDER BY seq LIMIT 1),
       (SELECT name FROM heavy_build_sequence n WHERE n.granularity=b.granularity
        AND n.kind=b.kind AND n.session_id=b.session_id AND n.segment=b.segment
        ORDER BY seq DESC LIMIT 1),COUNT(*)
FROM heavy_build_sequence b GROUP BY granularity,kind,session_id,segment
