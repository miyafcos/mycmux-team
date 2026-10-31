# 日ごとの使用量

曜日（月曜はじまり）×週の草で日別の量を示し、横棒の順位で選択範囲のモデル等の内訳を示す。日付を選ぶ操作と、画面全体をその日に絞る操作を分ける。日次の既存レポートだけを使い、端点を含む地方日を補う。全期間は最初の記録日から始める。

草は量だけを表す独立した緑の濃淡で、モデルの系列色には混ぜない。明色は `#5eb964 #399a43 #26792f #195920`、暗色は `#3d8241 #49a14f #5cc063 #75e07c`。段0は `color-mix(in srgb, var(--cmux-text) 9.9%, transparent)`。段1〜4は全組み込みテーマで、段1と面のコントラスト2以上、OKLabの明るさの単調性と段差0.06以上、色相幅10度以下を検査する。暗色popoverはsurface 93%と白7%をsRGBで合成する。文字はテーマの文字色を保つ。

正の値の最近順位四分位（25・50・75%）を使い、しきい値と同値は下の段に含める。正の値が1種類だけなら段4、0以下は段0。凡例は各段に実際に入る値の最小〜最大とし、空の段は「—」にする。セッションは日の重複除外済み値、期間はその延べ合計を使い、モデル別の割合は出さない。

Tabの停止点は1マス。上下は前後の日、左右は前後の週、Home/Endは最初/最後の日。Enter/Spaceで選択または解除、Escで選択解除。フォーカスとマウスのプレビューは内訳とヒントを切り替え、草を離れると選択日または期間全体へ戻る。

契約の試験は `tests/unit/usageGrass.test.ts`（日付・四分位・集計・内訳）、`usageGrassScale.test.ts`（全テーマの色）、`usageGrassView.test.tsx`（操作と描画の分離）。模型 `usageGrassModel.ts` の計算と日別内訳は一度構築し、hoverで格子全体を再描画しない。

記録なし・記録ありで指標が0・正の値ありを模型で区別し、正の日がなければ最多を出さない。内訳は正の行だけを上位化する。回数のヒントには指標名を付け、凡例は単独値と値幅を読み上げられる形にする。

幅760px以上は左を草と数字の2列一覧の内容幅に合わせ、間24pxで内訳320〜720pxを配置する。左が草より広いときは草を右寄せ、凡例も草の右端（草が狭いときは左端）に合わせる。内訳の列は期間全体と全日の最長表示で固定し、全角は2字分と数える。名前は40%・18chを上限に省略し、横棒は残りを使う。算定用の行は非表示・高さ0・読み上げ対象外。期間の行数×28pxと注記の場所を保ち、見出し・操作・右端の合計の配置を安定させる。

Escapeは固定・下見がある間だけ伝播を止める。内側の固定印と外側のfocus-visibleの輪を分け、取り直しで日が残れば固定とTab停止点を保持する。曜日札はスクロール枠の外、上2段のヒントは下側、数値表は高さ320pxまでとする。

段0は原則として既存の文字色を9.9%で重ねる。yoi-ai・yogiri・synthwaveだけは中立の不透明な灰にする。全30テーマと暗色の既定を対象に、面との比1.10・段1との比1.25・OKLCHのC上限0.03を例外なしで試験する。ほかのテーマの段0と、全テーマの段1〜4は変えない。


G1では草だけの幅測定をlayout effectへ移し、列の組み方は草の専用コンテナの幅でも決める。初回の幅0から縦積みが表示されることを防ぎ、共有の幅hookは変更しない。7日表示は凡例の幅を保ち、実マスの右端も右へそろえて内訳との24pxを保つ。ヒントは内訳の矩形を避けて配置し、位置合わせだけの再描画を起こさない。全日の表と日数の一覧は模型が同じ間は描き直さない。

数値の丸め・単位・表示文字列を保ったまま、en-USの桁区切りと小数1桁のIntl.NumberFormatを使い回す。


G1-3では、rollupの版が一致すれば、dirtyの日と部分日だけをrawで読み、きれいな完全日は既存rollupで読む。全期間の下限は最初の記録日の境界へそろえる。複数SQLはcommandのreader transactionで同じ版を見る。DBの表・列・index・取り込み処理は変えない。

軽い集計は2枠、model_handoffs・rework_rankings・usage_rhythm・efficiencyは別の1枠を使う。任意のreportRequest引数は、実際の窓のlabel・endpoint・channel・idで取消を分離する。共有fetchOnceを待つ部品がある要求はsupersedesへ入れない。待機は中止し、実行中のSQLはinterrupt、Rustの重い組み立てはcheckpointで止める。取消は画面の失敗として表示しない。取り込み・要約は対象外で、引数のない呼び方も動く。

モデル切り替えのraw/familyは、欠けた名前を除いてからSQLのLAGで前後を数える。providerは狭い列のstreamを使う。つまずきランキングは、選択したセッションのJSONを読み取り専用の関係として使い、期間全体で集約してから上位10件を返す。成功回数も分母へ含め、空白除去と並びを保つ。時間帯の全期間・絞り込みなしだけは、timestamp indexを経由する全件のランダム参照を避ける。

モデル切り替えとつまずきランキングも、既存report_cacheの保存済みを先に出す。forceによる同じ表示の取り直しでは今の表示を保つ。日別再利用は現在のcacheEpochと元resourceの有効な値を確認し、要求順の版で、より新しい日の取得結果を守る。新しい親期間を取り直したときは、古いseedだけを更新できる。全期間のフロントとRustの下限表現は同じ無限下限として照合する。

診断のsql_msは行の取得と型への変換、build_msは残りの組み立てを表す。raw_rowsとrollup_rowsは集計の論理行数で、混合経路ではsession/day等の集約行を数える。handoffのSQL版は返された隣接ペアの集約行、stream版と時間帯集計は一致した入力turn行を数える。raw_turnsはrawのturn集約・streamの入力数で、tool_callやfile_touchの処理行数を表さない。つまずきランキングのpathと行数は選択キーの集約と上位結果に対応し、rawのtool/file問い合わせがなくなった意味ではない。SQL時間はこれらの問い合わせも含む。rows_scannedは既存のcoverage等の補助行も含み、raw_rowsとrollup_rowsの合計とは異なる場合がある。どの値もSQLiteの物理I/O数ではない。同じ入力を別のSQLが読む場合はその都度数え、行キャッシュを使った場合も論理的な入力数となる。handoffでは欠けた名前をSQLの前段で除く。sessions_buildのaggregate/node_sql/path/rank/model/assembly/hydrateは、セッション表の工程別の時間である。


## G1-4 daily heavy aggregates

The additive `heavy_aggregate_version=1` extension leaves every existing table,
column, index, `rollup_version=3`, and `usage_rollup_version=2` unchanged. A
legacy v0.90.0 migration/read/write implementation can still use the database.
Initialization installs empty tables and schedules one background worker; it
does not backfill them synchronously or add a UI component or command.

`heavy_aggregate_day` publishes complete timestamp intervals only after all
parts of a day commit. `heavy_aggregate_dirty` excludes invalidated days until
that same atomic rebuild succeeds. `heavy_aggregate_cursor` in `index_state`
resumes initial construction; dirty days take priority without advancing that
cursor. Reads complement the ready intervals with timestamp-indexed raw gaps,
so scattered dirty days, partial boundary days, interruptions and empty days
retain the same result as a fully raw read.

- `heavy_handoff_chunk` and `heavy_handoff_pair` retain raw/family adjacency
  inside contiguous day segments of each session's `seq` order. Segment ends
  bridge across ready and raw intervals. A session that revisits an older day,
  has sequence gaps, or skips missing names therefore keeps its exact order.
- `heavy_session_day` provides distinct eligible session keys.
  `heavy_tool_day` preserves successes as well as failures and normalized
  targets; ranking and the top-ten cutoff run after all days are combined.
- `heavy_file_session` and `heavy_file_ready` summarize lifetime file edits for
  each distinct selected session. File edits are not date-prorated or counted
  repeatedly when a session appears on several days. Invalidation also clears
  the session's file-ready marker; incomplete sessions read `file_touch`.
- `heavy_rhythm_day` retains complete day/hour counts and token/cost sums.

The default unfiltered raw/family handoff, rework and rhythm requests use these
paths. Any nonempty kinds/models/projects/branches/efforts/origins filter, any
`minCost`, or a nonempty search query keeps the G1-3 query path. Provider
handoffs also keep that path because price classification is evaluated there.
An empty search, `includeSidechain` (currently not a SQL predicate), range
presets/explicit bounds, and renderer snapshot preference do not disable the
new path. Unsupported filters never approximate a result.

The existing rollup dirty hooks mark both sets inside the ingestion transaction,
including pre-reset old days, post-write new days and repricing. Tool-event
dates and previously aggregated tool-event dates are also marked, even when
that session has no turn on those days; the new
`ix_heavy_tool_day_session(kind,session_id,day)` index bounds that lookup. Finalization
requests a new pass. A pending-request bit prevents a request at the worker's
completion boundary from being lost. Each day uses a separate immediate
transaction, an 8 MiB SQLite page cache, file-backed sort storage and a 100 ms
yield; the OS thread uses background/low priority. Before every chunk the worker
checks the database drive for at least 5 GiB free. Unknown/insufficient space
pauses it with one diagnostic and readers continue using the same fallback.
Passive WAL checkpoints follow every commit; a reader-held WAL over 64 MiB
pauses construction after a bounded truncate attempt instead of growing it
through further chunks. No existing rollup version is bumped.

Build and read SQL live in `src-tauri/src/ailog/sql/heavy_*.sql`. Rust includes
those exact bytes with `include_str!`; the Windows snapshot-copy harness reads
the same files and records SHA256 identities. SQL measurements exclude Rust,
queueing and IPC; synthetic Mac measurements remain a separate result set.

`[ailog] heavy_aggregate action=complete version=1` marks a completed pass.
`action=paused reason=disk_below_5GiB_or_unknown` and `reason=wal_reader_hold`
explain a safe pause. Report `path`, `sql_ms`, `build_ms`, `raw_rows`,
`rollup_rows`, and `raw_turns` distinguish the selected path and logical inputs,
not physical disk I/O. Rework counts key/turn, event and file input units in its
raw/aggregate row diagnostics; its turn counter describes key selection.
The live application and real-data Rust/IPC timings are not exercised by the
snapshot SQL or synthetic fixture tests.


### G1-3R-001: persisted heavy reports precede the heavy lane

The three heavy report commands share `report_cache::heavy_report`. Prefer
requests register cancellation first, then probe the bounded on-disk snapshot
on a blocking worker before acquiring the heavy permit. Fresh and stale hits
both return immediately. A miss retains its open reader without a read
transaction while waiting, then computes under the single heavy permit.
Refresh requests skip the probe and acquire the heavy permit normally. Window,
endpoint, channel and request identity still bound cancellation; indexing and
summary commands are unaffected. A superseded probe normalizes SQLite interrupts
to the cancellation marker before returning an inner worker error. The regression test holds an unrelated heavy
permit until after each of the three persisted report probes has returned.


### G1-3R-002: failed and cancelled replacements finish their status

Handoff and rework catches clear the saved report's `refreshing` marker while
retaining the displayed value. Failures retain their error message; cancellation
leaves the error empty and does not render the failure or in-progress label.
The same real-store tests cover usage, handoffs and rework for both outcomes.


### G1-3R-003: logical raw keys and unmeasured inputs

A G1-3 DISTINCT-key fallback adds every selected session key to `raw_rows`,
even when no tool/file ranking row exists. It does not count input turns, so
`raw_turns_measured=false` distinguishes its placeholder zero from a measured
empty input. New daily rework SQL counts raw key-selection turns explicitly;
its `raw_turns_measured=true`, including a genuine empty input. The Boolean is
serialized and logged alongside `raw_turns`; older saved payloads deserialize
as unmeasured. These remain logical report input units, never physical I/O.

### G1-4R-001: full ingestion resets heavy derived rows

A full ingestion clears every heavy table row and the heavy aggregate cursor
inside the same transaction that clears the raw records. Tables and
heavy_aggregate_version remain installed. Empty input, removed sessions, and
an interrupted replacement therefore cannot retain published days, stale file
summaries, or a cursor past the new input. Restart rebuilds from the remaining
raw data; a failed reset rolls back raw and heavy rows together.

### G1-4R-002: keep the whole G1-3 path until coverage is usable

The range gate requires every complete selected day within the raw history to
have been published. At most seven of those published days may be dirty in
either rollup family. Unbuilt complete days, an initial build stopped for low
disk space, or more than seven dirty days select the entire G1-3 reader:
learning_keys_with_timings/measured_hybrid_rows for rework, and the original
handoff/rhythm SQL selection (including sequential all-history scans).
Heavy tables plus raw gaps apply only after this gate passes; partial boundary
days remain raw. A reader whose coverage check fails also keeps G1-3.

### G1-4R-003: reuse the existing source revision as a fingerprint

The new index_state key heavy_aggregate_source_mark stores a v1 tuple of the
existing report_database_id and report_revision. v0.90.0 already increments
report_revision transactionally for session, turn, source_file, price, rework,
tool_event, file_touch and summary mutations. This also detects repricing,
internal-origin backfill, repair and file-only writes without a source_file
change. It adds no trigger and no per-row work. The two indexed key lookups
avoid scanning source_file, raw history or the per-file parser state.

The low-priority worker compares the saved fingerprint only once at process
startup. Foreground migration never reads it, scans turns, dirties every day,
or deletes aggregate rows. Until that check completes, a process-local set of
checked database identities keeps readers on G1-3. Readers never compare the
revision during normal operation; current-process writes use rollup dirty
hooks instead. The Windows single-instance mutex name is identical to
v0.90.0, so the two versions cannot concurrently write the same runtime DB.

A matching mark preserves all publications. A missing mark with no published
day or cursor only records the current mark and starts normal cursor building.
A mismatch, or a missing mark with published state, first commits
heavy_aggregate_reset and removes the build cursor. Subsequent worker steps
delete at most 256 primary-key rows from one heavy table per transaction,
checkpoint WAL and yield to ingestion. The persisted table-stage number
resumes an interrupted purge. Readers stay on G1-3 until all nine tables are
cleared and the worker commits the current mark. Startup ingestion cannot
overwrite the old mark before this check. Existing rollup versions are unchanged. Migration drops only the unshipped
33adbba49 prototype table/triggers and keeps all existing report_revision
triggers. Frozen v0.90.0 opening, ingestion and light/rhythm SQL continue to
test nonempty values, ordered updated results and two old-version reopens.

### G1-4R-004: count both independent rework key selections

The tool and file SQL each return their raw key-selection turn count, including
an empty ranking result. Rework adds both counts to raw_turns and raw_rows,
then adds raw tool-event and file inputs to raw_rows. The same selection turn
is counted twice when both SQL statements read it. raw_turns_measured remains
true for these measured inputs; G1-3 DISTINCT session-key counts retain false.


### G1-5R-002: cover empty days when history grows into the past

heavy_aggregate_lower_day records the raw build's earliest day. Once dirty
work is drained, a missing lower bound or an older raw minimum atomically
stores the new bound and rewinds the cursor to the preceding day. Existing
publications are skipped, while every missing empty day is built. Both the
builder and publication gate use the inclusive raw minimum/maximum day range.
Full ingestion and startup reset remove the lower bound with the cursor.
Current incremental ingestion and frozen v0.90.0 writes are tested through
completion and another startup, including new-reader SQL traces and raw parity.


### G1-5R-003: save own writes without runtime fingerprint comparison

After startup reconciliation, ingestion records the source mark in its existing
transaction, and full ingestion retains its atomic raw/heavy reset. Every
completed day saves the current mark in the publication transaction; a failed
day rolls back both. The single low-priority worker stays idle after completion,
wakes immediately for ingestion requests, and records the mark every 180 idle
seconds. A shared mutex/condition variable prevents lost wakeups without polling.

Real summary success and failure persistence changes report_revision but not
the four heavy inputs. During construction and after completion, these writes
leave eligibility/publications/dirty days intact. Readers never compare that
revision. A crash after an own write but before the next persisted mark can
appear as a startup mismatch; it safely rebuilds the heavy tables on reopening.


### G1-5R-004: audit product write paths

The product write-path audit covers both v0.90.0 and this version, excluding
test modules and diagnostic/error-message strings. Ingestion, copy accounting,
repair, legacy classification, rederivation and repricing all reach the old
rollup hooks, which also invalidate heavy inputs. Internal-origin backfill now
marks each affected session before changing origin in the same transaction;
without rollup tables there are no derived rows to invalidate. Price updates
also wake the worker after commit. Full ingestion clears all derived rows.

The old 24 revision triggers cover every mutated heavy-input table. Auxiliary
usage/checkpoint/alias/repair metadata, derived rollups and the separate report
cache also have product writes; these are explicitly distinguished from
heavy-input writes rather than claimed to be trigger-covered source tables.


### G1-6R-001: serialize worker transactions with product writers

A process-wide writer mutex is acquired immediately before source-database
write transactions: incremental ingestion, full clear, repair family swaps and
finalization, summary success/error persistence, user price/repricing, origin
backfill and the price catalog/accounting migrations. WriteTransaction owns
the SQLite transaction before its mutex guard, so commit finishes, or error
unwinding rolls back, before the guard is released. Borrowing helpers (rollups,
accounting, rederivation, repricing and backfill inside an existing transaction)
reuse the outer transaction and never acquire the mutex again. The repair
retry path consumes its transaction/guard before staging another family.
Ingestion and each repair swap/finalization load the price table from that
transaction immediately after acquiring the gate, so a price commit made
while they waited cannot be overwritten by stale rates. The ingestion writer
waits for the first WriteMsg (or channel closure) before acquiring the gate,
then processes that message and the remaining channel in one transaction.
Cancellation before the first message and an empty file list still run rollup,
last_finished_at, source fingerprint, commit and scheduling finalization.
Only set_price bounds its gate wait to 5,000ms and returns SQLite busy
(database is locked) on expiry; its waiter count is cleared on every exit.
Other product writers (ingestion, repair, summary saves, migrations and
clear_all) retain unbounded blocking acquisition because their blocking threads
should wait for completion rather than fail under ordinary contention.

The background worker uses try_lock for each startup/reset transaction, each
day's publication (including lower/cursor repair), and each idle fingerprint
save. Every worker transaction starts with BEGIN IMMEDIATE. A contended lock
returns without waiting or starting a transaction; the worker retries after
100ms, or wakes for a product request. Pending product writers have priority,
so the worker cannot repeatedly reacquire ahead of an already queued writer.
No guard spans WAL checkpoints, disk-space checks, the 180-second idle wait, AI
calls, discovery or the first transcript result before ingestion writes,
or repair's file-reading stage in its separate in-memory database. Read-only
report snapshots and the separate report-cache database do not take this lock.

A product writer queued behind the worker waits for its current transaction,
not a whole history build. The prior G1-4R actual-copy measurement's largest
chunk was 4,234ms, below the existing 5,000ms SQLite busy timeout; this is an
observed maximum, not a new enforced wall-clock deadline. No new runtime
performance guarantee or low-memory measurement is claimed here. Product
transactions retain their existing behavior; only the worker uses IMMEDIATE.
Two-connection WAL tests pause real ingestion immediately after parsed_lines,
and pause actual summary/price persistence before its first write. The worker
must yield, product progress/raw/rollups must commit atomically, and a later
worker retry must save the new fingerprint. Removing only the ingestion guard
reproduces the stale-snapshot failure at the intended ingestion assertion.
