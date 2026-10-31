SELECT r.usage_state,SUM(r.turns),SUM(r.cost_usd)
            FROM rollup_turn_session_day_v2 r JOIN session s USING(kind,session_id)
            WHERE r.day>=? AND r.day<=?{suffix} GROUP BY r.usage_state