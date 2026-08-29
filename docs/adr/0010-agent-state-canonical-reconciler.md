# エージェントの状態は reconciler が確定する。hook も rollout も観測源の一つに過ぎない

Status: accepted (2026-08-29 Oracle 設計ゲート裁定)

エージェント hook を入れた後も、既存の Codex rollout JSONL パーサを「hook が使えないときの予備」に降格させるのではなく、**hook・rollout・process metadata・title をすべて単一の canonical event reconciler への入力**にする。真実はどの観測源でもなく、reconciler が構築する canonical state である。観測源から直接 toast・badge・カード・OS 通知を発火させない。orca の 30 分鮮度窓は採らず、**turn 単位の短い grace (初期 3 秒)** にする。

前提の受け口設計は [ADR 0009](0009-agent-hook-realm-and-per-launch-capability.md)。要件本体は `docs/plans/2026-08-29-orca-adoption-requirements.md`。

## 検討した選択肢

- **hook を truth、rollout を fallback として優先順位で切り替える** — 却下。一見素直だが、両者とも**不完全な観測源**である事実を隠してしまう。hook は仕込まれていない launch・未信頼の Codex・helper 不通で欠落し、rollout は provider が限られ shell 完了を見られない。どちらかを truth と呼ぶと、切替の境界 (どの時点でどちらを信じるか) が UI 側に漏れ出し、二重発火と取りこぼしの両方を生む。
- **既存 rollout パーサを削除して hook だけにする** — 却下。hook を仕込んでいない素の codex、古いバージョン、trust を与えていない環境で完了検知が丸ごと死ぬ。
- **orca と同じ 30 分の鮮度窓で title / fallback へ落とす** — 却下。同じエージェントが 30 分以内に複数 turn を完了した場合に**正当な fallback を抑止**してしまう。逆に同一 turn の hook と rollout が 30 分以上離れた場合の重複は防げない。窓の大きさが turn の粒度と噛み合っていない。
- **provider の `Stop` をそのまま「完了」として扱う** — 却下。Claude Code の `Stop` は応答が終わったときに発火するもので、ユーザーが意図したタスク全体の完了を保証しない。これを完了と呼ぶと、hook 導入後にむしろ「一回答しただけで完了通知」が増えて精度が下がる。
- **配送レイヤーで exactly-once を作る** — 却下。at-least-once の ingress を前提にし、**user-visible な副作用の側だけを exactly-once** にする方が現実的で、app 再起動後の rollout 再走査にも耐える。

## 結果

- **入力源とその権限**を次のように定める。

  | 入力源 | 役割 | 単独で OS 通知してよいか |
  |---|---|---|
  | Valid hook | 高信頼な semantic evidence | reconciler 確定後のみ |
  | Rollout JSONL | fallback / 先行する provisional evidence | grace 後のみ |
  | Process metadata | 生存・終了の事実 | 「process terminated」だけ |
  | title / shell heuristic | 低信頼な表示ヒント | 不可 |

- **normalized state を分ける**: `TURN_ACTIVE` / `ATTENTION_REQUIRED` / `TURN_ENDED` / `PROCESS_EXITED` / `SESSION_TERMINATED` / `FAILED` / `CANCELLED` / `RATE_LIMITED`。UI 上の「完了」が `TURN_ENDED` を指すのか `SESSION_TERMINATED` を指すのかを実装前に確定する。
- **canonical identity**: `app_instance_id` / `pane_id` / `launch_generation` / `provider` / `provider_session_id` / `provider_turn_id` (無い provider は reconciler が `TURN_ACTIVE` 遷移時に発行する synthetic generation) / `event_kind`。**時刻を丸めただけの dedup key は使わない**。
- **grace は turn 単位で短く**: hook が正常に仕込まれている launch では、rollout の terminal を `PROVISIONAL` として記録し**初期 3 秒だけ** hook を待つ。到着すれば merge、3 秒経過すれば fallback を確定。hook 未導入・未信頼・helper 不通の launch は grace なしで即確定。fallback 確定後に late hook が来たら state は更新してよいが、**同じカード・unread・OS 通知は再発火しない**。3 秒は初期受入値で、実測 p99 に基づき 0.5〜5 秒で調整する。30 分のような大窓へは戻さない。
- **grace の判定は受信時の monotonic clock で行う** (provider の timestamp は表示と永続記録の専用)。
- **exactly-once は副作用側に置く**。durable ledger に最低限 `canonical_event_id` / `source_event_ids[]` / `payload_hashes[]` / `current_state` / `state_version` / `card_created_at` / `unread_incremented_at` / `native_notification_emitted_at` / `acknowledged_at` を持つ。イベント受理と `notification_emitted_at` の確保を同一トランザクションか durable outbox で行い、app 再起動後に rollout を再走査しても同じ通知を再送しない。event ID の保持は最低 7 日、または rollout cursor が完全に通過するまで。
- **状態競合の優先規則**を明記する。
  - valid な `ATTENTION_REQUIRED` は provisional な `TURN_ENDED` より優先
  - process exit は「終了」であって「成功完了」ではない
  - 旧 launch generation のイベントを新 launch へ**絶対に適用しない**
  - 同一 turn の同一 terminal event は何回来ても一回
  - terminal から active へ戻すには新しい turn ID / generation が必要
  - ユーザーが明示的に閉じた後の terminal event は ledger に残すが通知しない
  - fallback 確定後の late hook は訂正できるが通知を再発火しない
- **副作用の所有権は Rust backend に一本化する**。canonical state・unread 加算・native notification は backend だけが発行し、React 側は read model を表示するだけにする。React Strict Mode は開発時に effect の setup / cleanup を追加実行するため、renderer の effect 内で通知やカード生成を行うと listener の cleanup 漏れだけで二重発火する。複数 window 化しても各 WebView が同じ event で副作用を起こしてはいけない。
- **実装順を UI より先にする**。hook・rollout・process exit・restart・pane 再利用を時系列 fixture にして、canonical state と副作用が一意に収束することを破壊試験で確認してから UI に触る。

## この裁定が誤りと分かる観測

実ログ上、hook と rollout を**同一 turn へ結び付けられる ID が存在せず**、3 秒以内でも異なる turn の誤 merge が発生する場合。そのときは provider 別 reconciler へ分割し、rollout cursor / transcript 位置を identity に追加する。

## 帰結

- 既存の `pty/monitor/codex_rollout.rs` は残すが、そこから直接 UI 状態を変える経路は Phase 3 で削除し、reconciler への入力に付け替える。
- `pending` / `attention` を導出している既存の統一関数 (`lib/notificationStatus.ts`) は read model 側に留まる。判定そのものは backend へ移る。
- 観測性のために `received` / `accepted` / `rejected_invalid_cap` / `rejected_stale_launch` / `rejected_wrong_provider` / `deduplicated` / `provisional` / `promoted_by_timeout` / `merged_with_hook` / `late_hook` / `queue_dropped` / `notification_emitted` / `notification_suppressed` を計数する。秘密は含めない。
- 破壊試験に「同じ hook を 100 回送信」「rollout terminal 後 0〜10 秒で hook 到着」「hook 到着後に rollout 再走査」「hook が逆順に到着」「pane close と terminal hook を同時実行」「同じ pane で即再 launch」「app crash 後に再起動」を必ず含める。
