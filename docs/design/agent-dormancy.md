# 自動整理と休止の設計判断

R-05 は AI 判定と実行の間に、既存 `TabSweepPanel` / `OverlayShell` の確認を挟む。runner は `AutoSweepReview` を渡し、選ばれた候補 ID またはキャンセルを待つ。表示していない ID は実行に採用しない。確認 host がない、失敗した、閉じた場合は実行しない。DEAD fallback も同じ確認を通し、既存の `applySweep` による終了直前の再確認と件数分の restore を保つ。

M-04 は純粋関数 `evaluateDormancy` が idle・空きメモリ・全席数・通知・作業状態から段階と候補、必要な確認を返す。通常は既存時間制を維持し、圧のときだけ待機を短縮して提案する。取得不能は席数の条件も使わず `time_only` とする。別窓の既存 published fragment と窓内の全区画を数え、移動途中の workspace ID の重複は窓内の最新状態を優先する。

空きメモリは既存 `watchdog::free_ram_mib` を async command に公開する。Windows の OS 計測と既存 sysinfo を再利用し、依存を増やさない。メモリ取得と記録保存の blocking 処理は既存 `run_blocking` を使う。

既定の圧は 2048 MiB または 40 ペイン、強い圧は 1024 MiB または 60 ペイン、idle は 15 / 5 分。作者の空き 1〜3 GB・30〜60 席の中間で候補を知らせ、下限付近で知らせるまでの時間を短くする。圧のときは通常の時間を超えていても確認を待つ。承認を会話 ID・エージェント種別・最後の活動・process 状態の時刻に結び付け、1 分で失効させる。0 分の停止と作業・権限・質問の保護を優先する。

M-05 は `completion_only` と `blocking` を区別する。完了だけでも未保存なら action は `saveTranscript`、対象と一致する receipt を得て初めて `kill` が可能になる。既存 JSONL writer の flush / fsync / atomic rename が保存の根拠であり、履歴 DB の best-effort ingest は根拠にしない。読み取り時には既存の transcript decoder を使う。元の会話ファイルが移動しても保存した記録を開ける。

完了 attention の identity と receipt を `sessionAttentionStore` の端末内保存へ書き、成功後に終了する。exit / 空の snapshot は保存した完了を消さず、生存中の別 epoch・新しい仕事・新しい注意は古い完了の binding を取り除く。未読はそのまま残す。記録閲覧は既存 dashboard の会話面、会話再開は既存 jump とエージェント別 resume アダプターを使う。

終了直前に出力・process 状態・frontend 入力を再確認する。最後の非同期読み取りで権限や表示が変わることもあるため、その await の後に frontend の状態を再収集する。実際の native 終了との間を原子的にはできない既存の制約は [休止調査](../dormancy-churn-20260731.md) のとおりで、Windows 実機でも確認する。

画面と文書は「休止中・会話は再開できる (プロセスは終了している)」と表す。[設定・既定値・戻し方](../features/implemented/agent-dormancy.md#dormancy-settings) は一か所にまとめる。
