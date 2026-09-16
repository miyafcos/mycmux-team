# mycmux 残り開発の作戦 — 観測契約を主軸に置く (2026-08-31 確定)

**前提**: 対象 = `C:\Users\miyaz\cmux-for-linux-dev-master` (branch master)。数字は 2026-08-31 10:00 時点の実測 (git・稼働 exe・各 worktree・mycmux の全タブ画面・docs/plans 5 本・project memory 4 本)。

この文書は `docs/plans/2026-08-27-mothership-dev-schedule.md` を置き換える。あちらの進捗ログは 8/28 の v0.58.0 配信で止まっており、その後 v0.58.x 〜 v0.60.3 の配信と、8/30〜8/31 の 15 コミットが反映されていない。

**2026-08-31 宮崎さん裁定**: 主軸は「観測契約の一本化」。メール監視・Web ペイン・iPhone・処置の拡張はその従属物として後ろに並べる。

## 1. 現在地

| 項目 | 値 |
|---|---|
| 最新タグ・feed | v0.60.3 (2026-08-30 11:32) |
| master / origin | `91cc0bd2` で一致 (push 済み・タグ未) |
| 未リリース | 15 コミット (v0.60.3 → HEAD) |
| ソースの版 | `tauri.conf.json` = 0.60.3 (bump 未) |
| 稼働 exe | `C:\Users\miyaz\AppData\Local\mycmux\mycmux.exe` 0.60.3 |
| 作業ツリー | クリーン。worktree 16 本 (prunable は 8/31 に prune 済み) |
| 版番号の扱い | **今回の作戦に含めない** (宮崎さん指示・後で考える) |

未リリース 15 コミットの内訳は `reports/_quick/2026-08` の棚卸し HTML と memory `project-unreleased-after-v0603` を参照。

## 2. 壊してはいけない前提

| 前提 | 実状 | 効き方 |
|---|---|---|
| pocket-mycmux レーン 2 本 | 稼働中 (pad 実測・Mac 疎通) | 別リポ・別プロセス。本体作業と衝突しない |
| AI ハブ 調査連携 | server.py の空き待ち | pocket と資源を取り合う。本体とは無関係 |
| Rust テストの RAM ゲート 5GB | 待機式 (最大 120 分)。8/31 は 1 回目が届かず、PC 再起動後の 10.18GB で通過 | ゲートは下げない (BSOD 履歴)。テスト前に終わったタブを閉じるのが一番効く |
| `TAB_GROUPING_ENTRY_ENABLED` | true (v0.58.0 で解除済み) | タブ再配置はもう封印下にない |
| Oracle | 入力欄残留・CDP 拒否の履歴 | 最終判定に使うなら復旧手順を先に踏む |
| 同一 worktree の並行レーン | `0a0bebb6` が実例 | 新レーンは bunshin で別 worktree に出す |

## 3. 階層 — 4 層のパイプ

mycmux は「観測 → 判断 → 提示 → 処置」の 1 本のパイプに、入口と出口が複数ぶら下がった構造。残件はすべてこのどこかに属する。

- **L1 観測 (入口)**: 画面スキャン (稼働) / rollout パーサ (稼働) / **agent hook (新・未検証)** / **session-board (新・未検証)** / メール (未着手)
- **L2 判断**: reconciler + attention rules ← 唯一の合流点 / grouping 判定 (LLM) / 返信案・次の一手 / WorkOrder エンジン (段2 未)
- **L3 提示**: AttentionCards / ミニマップ・配置図 / タブ・ペイン・ターンチップ
- **L4 処置 (出口)**: キー送出 (単一キーのみ) / Web ペイン push (新) / iPhone 承認 (別リポ) / 通知 (toast・ntfy)

## 4. 主従

**主軸 = L1 → L2 の観測契約を 1 本にする。**

1. 今週それが 3 本に増えた。画面スキャンだけだった観測に、hook (`f462bfbd` / `0a0bebb6`) と session-board (`9ee419c2`) が 2 日で入った。orca 要件の D2 は「hook と既存 rollout パーサを単一 reconciler へ入力する」と裁定済みだが、そこに session-board という 3 本目が後から加わり、**その合流の仕方が実装で暗黙に決まっている** (§4.1)
2. 下流がすべてここに依存する。カード・ミニマップ・通知・iPhone の承認画面・メール監視は全部「気づき 1 件」を受け取る側。形が確定していなければそれぞれが自分用に解釈する
3. いちばん安く直せるのが今。入口 3 本・出口 2 本のうちに決めれば直す対象は reconciler 1 か所。メールと iPhone を足すと 5 入口 4 出口になる

### 4.1 実装を読んで判明した現状 (2026-08-31)

作戦を立てる時点では「session-board の rank と mycmux の attention rules のどちらが勝つか未定義」と書いたが、コードを読むと**既に暗黙に決まっており、しかも情報が 1 つ捨てられている**。

- `src-tauri/src/attention/session_board.rs:275` — `let _ = (&item.severity, &item.actor, &item.freshness);`。session-board が出す **severity (blocking / warning / advisory) を明示的に捨てている**。actor と freshness も同様
- 結果、session-board 由来はすべて単一の kind `sessionBoardIncident` になる
- `src/components/dashboard/attentionModel.ts` の `KIND_PRIORITY` で、その kind は **一律 2 位に固定** (0 = agentAsked / 1 = workStopped / 2 = sessionBoardIncident / 3 以下 = その他)
- producer の `sourceRank` は `sessionBoardIncident` **同士の中でしか効かない** (第 2 キー)

つまり「producer 側の rank を保持 (再ランクしない)」という `9ee419c2` の記述は並び順については正しいが、**重大度は保持されていない**。session-board が blocking と判定した件も advisory と判定した件も、mycmux の画面では同じ高さに並び、必ず agentAsked と workStopped の下に来る。

段1 の 2 番目 (優先の裁定) は、この事実の上で決める。取りうる形は 3 つ:

| 案 | 内容 | 規模 |
|---|---|---|
| A | severity を既存の kind へ写像する (blocking を workStopped と同格に上げ、advisory を下位へ) | 小 |
| B | 現状維持 — session-board は常に中位・rank 順 | ゼロ |
| C | 全入口共通の重大度軸を新設し、`KIND_PRIORITY` を廃止して severity で並べる | 大 (段1 の本丸) |

**従属 (主軸が固まるまで拡張しない)**

- 処置の拡張 — 回答送出は「カーソル位置が観測できないので multi-select は載らない」という構造的な壁に当たっている (`ce698fdc`)
- 入口の追加 (メール) — 4 本目の入口。契約が動いている最中に 0a を書くと書き直しになる
- 別面 (Web ペイン・iPhone) — 独立性が高く並行できるが、attention を消費する部分だけは主軸に従う

## 5. 順番 — 6 段階

### 段0 — 出荷可能な状態に戻す

Rust スイートを通す。直近 3 コミット (`91cc0bd2` / `9ee419c2` / `0a0bebb6`) が未検証のまま積み上がっており、この状態が続くほど切り分けが高くつく。版を上げるかは別の話なので、ここではテストを緑にするところまで。

障害は RAM。`run_windows_tests.py` の RAM ゲートは **待機式** で、空きが `MIN_BUILD_RAM_GB = 5.0` に達するまで 60 秒ごとにポーリングしながら最大 120 分待ち、届かなければ中止する (fail-closed)。8GB 未満なら cargo の並列度を絞る。**ゲートは下げない** (BSOD 0x133 の履歴)。

したがって走行中レーンを止める必要はなく、仕掛けておけば空いた瞬間に自動で走る。ただし 8/31 の 1 回目は 120 分待っても 5GB に届かず (空き 0.3〜3.0GB を往復)、PC 再起動でプロセスごと落ちた。

**2026-08-31 完了 — 4 スイート全緑**。再起動後の空き 10.18GB でゲートを通過。

| スイート | 結果 |
|---|---|
| `python scripts/run_windows_tests.py` | **1029 passed** / 0 failed / 10 ignored (270 秒) |
| `npx tsc --noEmit` | **0 errors** |
| `npx vitest run` | **3735 passed** (112 秒) |
| `python -m pytest tests/` | **403 passed** (60 秒) |

未検証だった 3 コミット (`91cc0bd2` / `9ee419c2` / `0a0bebb6`) の Rust 検証はこれで済んだ。tsc / vitest / pytest はコミットメッセージ上は緑と報告されていたが、母艦が自分で通し直して確認した (委譲先の自己申告は成果と見なさない)。

教訓として、**実測で 5GB を安定して空けられない日がある**。claude が 11〜14 プロセスで 5〜6GB を占めるため、走行レーンを 10 本以上抱えた状態では待っても届かない。ゲートを下げるのではなく、テストを回す前に終わったタブを閉じる (これが一番効く)。

### 段1 — 観測契約の一本化 (主軸)

1. **語彙を 1 枚に固定** — 「気づき」1 件が持つ項目 (種別・重大度・fingerprint・rank・解決条件・観測の完全性) を、hook / スキャン / session-board / メールのどれから来ても同じ形にする
2. **優先の裁定** — 2026-08-31 に**案 C で確定** ([ADR 0011](../adr/0011-attention-order-by-who-waits-and-severity.md)・status = proposed)。`KIND_PRIORITY` を廃止し `waiting` × `severity` で並べる
3. **重複の裁定** — 同じ 1 件が hook とスキャンの両方から来たときに 1 枚になること。fingerprint の作り方をここで決める
4. **観測不完全の扱いを統一** — session-board は「観測未完了カード」を出す設計を持つ (`9ee419c2`)。hook 側にもスキャン側にも同じ概念が要る

成果物 = ADR 1 本 + reconciler の実装 1 便。`docs/plans/2026-08-29-orca-adoption-requirements.md` の D2 を session-board を含む形に更新するのが実体。

**進捗 (2026-08-31)**

| # | 項目 | 状態 |
|---|---|---|
| 1 | 語彙を 1 枚に固定 | **部分** — `waiting` / `severity` / `actor` / `freshness` は入った (`56d6368c`)。fingerprint と解決条件はまだ |
| 2 | 優先の裁定 | **完了** — [ADR 0011](../adr/0011-attention-order-by-who-waits-and-severity.md) accepted、実装受理 (`56d6368c`) |
| 3 | 重複の裁定 (fingerprint) | **未着手** |
| 4 | 観測不完全の扱いを統一 | **部分** — session-board 側だけ。hook 側とスキャン側に同じ概念がまだ無い |

`56d6368c` の中身は +579 / −122 の 11 ファイル。`KIND_PRIORITY` を削除し、写像表を `kind.native_axes()` の 1 メソッドに閉じ込め、`session_board.rs` の `let _` を外した。マイグレーションは列追加 → 写像表で backfill → schema_version を 2 へ → NULL ゼロを検証。受け入れは母艦が 4 スイートを取り直して確認 (Rust 1031 / tsc 0 / vitest 3737 / pytest 403)。

T3 は並び替えに `kind` を読ませない Proxy を食わせており、旧実装なら型ではなく**規則**で落ちる。ADR の「`kind` は序列を決めない」が実行時に強制されている。

**段1 の残り = 3 と 4。** これが次の便になる。

### 段2 — 実機で効果を測る

hook を入れた目的は「気づく速さ」の改善 (`42c35a3d` で返答経路の改善ではないと確定済み)。**まだ一度も実機で測っていない。** 設定書き込みの安全性は検証済みだが、実エージェントからの報告が届いてカードになるところは未確認。

測るもの = 裏タブの質問が出てから画面に出るまでの時間 / スキャン経路との差 / 取りこぼし。ここで効果が出なければ段3 以降の前提が崩れるので、段1 と段3 の間に必ず置く。

### 段3 — 処置を一段だけ進める

単一キーで決まる質問 (承認・単一選択) の回答をカードから送れるようにする。multi-select は据え置き — カーソル位置が観測できない以上、今の設計では載らない。ここは「広げない」ことがそのまま設計判断。

### 段4 — 入口を 1 本足す (メール)

0a (契約の文書化) → 0b (判定の土台) → 1a (気づく) の順。段1 で語彙が固まっていれば、0a は「メール固有の項目を既存の語彙に写像する」作業に縮む。正本 `docs/mail-spec-260827.md`。

### 段5 — 別面

- **Web ペイン**: 添付 (`DOM.setFileInputFiles`) / Phase 2 の oracle attach spike / 逆方向 (ChatGPT から mycmux を見る)
- **iPhone (pocket-mycmux)**: 便1b (端末別トークン・使い捨てペアリング・HTTPS) / 残件 R-1 (見るだけモードでキー入力が PTY に素通り)

主軸と触る場所が違うので段1〜3 と並行して動かせる。実際 pocket は現在も走行中。

## 6. 隙間便

段の合間に 1 便ずつ入れる、独立した小物。

| 件 | 内容 | 依存 |
|---|---|---|
| Gate 6 台帳 | Medium 6 + Low 8 + G5P-01 | なし |
| bridge WIP 復元 | 8/24 の退避分の復元と単独監査 | なし |
| レーン B #7 | 再起動時のペイン復活が不安定。**2026-08-31 に実害**: PC 再起動でワークスペースが 3 → 2 に減り、別 WS のタブが混ざった (`grid_template_id` と `split_columns` の不整合という原因候補と符合) | なし |
| AI ログ #1 の残り | dedup → rollup v2 → 包含 | なし |
| 返信案の置き場所 | ①現状 ②タブ/ミニマップの通知から ③ペイン側に小さく | 宮崎さんの裁定待ち |
| WorkOrder 段2 | EventJournal / TurnCapsule / FTS5・版切替 API・カードの実機確認 | 規模が大きい。段扱いにするか要判断 |

## 7. 体制

- 母艦 = PM (計画・裁定・受理・品質ゲート) / 実装 = Codex (terra 既定・fail で sol 昇格) / 監査 = Opus 5 / 最終判定 = Oracle (不調時は Codex sol max で代替し復帰時に照合)
- 新レーンは bunshin で別 worktree。同一 worktree で並行するときは帰属確認 → パス指定ステージ (stash 禁止)
- 各便の受理 = 隔離 worktree で red → green の反転を母艦が自分で再現 → 閉鎖確認 → コミット → push
- タグ・リリース・実機再起動・deploy はレーンではなく宮崎さんと母艦の管轄

## 8. 宮崎さんに要る判断

| # | 判断 | いつ | 状態 |
|---|---|---|---|
| 1 | 主軸の置き方 | — | **済** (2026-08-31・観測契約の一本化) |
| 2 | session-board の severity の扱い (§4.1 の案 A / B / C) | 段1 着手前 | **済** (2026-08-31・案 C → ADR 0011 起草) |
| 3 | 返信案の置き場所 | 隙間便の着手前 | 未 (v0.60.2 から持ち越し) |
| 4 | WorkOrder 段2 を独立した段にするか隙間便のままか | 段2 の頃 | 未 |
| 5 | 段0 の Rust テストをいつ回すか | 直近 | **済** (2026-08-31・Rust 1029 passed) |
| 6 | ADR 0011 の可否 (実機のカードの並びが変わる) | 実装便の発注前 | 未 |
