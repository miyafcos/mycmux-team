# AILog Ben2 baseline

Measured on 2026-08-17 00:40 JST against `C:\Users\miyaz\.mycmux\ailog.db`.
The connection used `SQLITE_OPEN_READ_ONLY`; `PRAGMA query_only` returned `1`.
No schema initialization, migration, backfill, or database write path was used.

| Scenario | Report | SQL ms | Rows scanned | Build ms | Path |
| --- | --- | ---: | ---: | ---: | --- |
| 30d overview + breakdown + sessions | overview | 1090 | 213123 | 532 | raw |
| 30d overview + breakdown + sessions | breakdown | 651 | 142064 | 52 | raw |
| 30d overview + breakdown + sessions | sessions | 585 | 1898 | 0 | raw |
| 90d overview + breakdown + sessions | overview | 1576 | 319740 | 807 | raw |
| 90d overview + breakdown + sessions | breakdown | 993 | 241776 | 84 | raw |
| 90d overview + breakdown + sessions | sessions | 942 | 4118 | 0 | raw |
| 30d efficiency | efficiency | 937 | 251664 | 782 | raw |

The machine-readable record is `C:\Users\miyaz\cmux-for-linux-dev-master\scripts\perf\results\ailog-baseline-ben2.json`.
