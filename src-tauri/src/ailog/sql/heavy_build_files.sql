INSERT INTO heavy_file_session
SELECT ft.kind,ft.session_id,ft.path,ft.edit_count
FROM heavy_build_session q CROSS JOIN file_touch ft USING(kind,session_id)
CROSS JOIN session s USING(kind,session_id)
WHERE COALESCE(ft.edit_count,0)>=3 AND COALESCE(s.origin,'unknown')<>'ailog-internal'
