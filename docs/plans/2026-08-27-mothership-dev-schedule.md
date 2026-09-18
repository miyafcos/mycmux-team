# mycmux 開発工程表 — 次リリースまで (2026-08-27 母艦整理)

<div class="callout accent">稼働版は v0.57.0 (8/25 に更新ボタン経由で適用・feed も同版・master と origin は e962f50 で一致)。いま走っている開発はタブ再配置 (ダッシュボード大型アップデート) の Gate 3 と、v0.57.0 の残課題 7 件のうち 5 件の 2 本。この 2 本が終わった時点で v0.58.0 を切り、配信後に Web ペイン (ChatGPT Pro) とメール監視を別 worktree の並行レーンで着手する。開発は今日は始めない (宮崎さん指示)。</div>

**前提**: 対象 = `C:\Users\miyaz\cmux-for-linux-dev-master` (branch master)。数字は 2026-08-27 12:10 時点の実測 (git・feed・稼働 exe・2 セッションの transcript・`dispatch/260825-tab-grouping-gates/STATUS.md`)。

## 1. 現在地

| 項目 | 値 | 根拠 |
|---|---|---|
| ソースの版 | 0.57.0 | `src-tauri/tauri.conf.json` / `Cargo.toml` |
| 最新タグ・GitHub Release | v0.57.0 (2026-08-25) | `git tag` / `gh release list` |
| updater feed | 0.57.0 (2026-08-25 09:13Z) | `mycmux-team/releases/mycmux-personal-updater/latest.json` |
| 稼働中 exe | `C:\Users\miyaz\AppData\Local\mycmux\mycmux.exe` 0.57.0 (8/25 18:13) | `Get-Process mycmux` |
| master / origin | 一致・未 push なし (12:35 時点。レーン A の G3-3b `cfef3bd`・ロードマップ `8405cd4` を含む) | `git status -sb` |
| 走行中レーン | 2 本 (タブ再配置 / 残課題 7 件) | §2・§3 |
| 待機中の開発 | 2 本 (メール監視 / Web ペイン) | §4 |

<div class="callout warn">訂正候補: CLAUDE.md の「稼働中 exe = ~/mycmux-app/mycmux.exe (updater 対象外・deploy スクリプトで差し替え)」は旧記述。そちらの exe は 0.29.0 で、実際に動いているのは updater 管理の AppData\Local\mycmux 側。deploy-update.ps1 の手順を使う前に、どちらを差し替えるつもりかを確認してから CLAUDE.md を直す (宮崎さん確認後)。</div>

## 2. 走行中レーン A — タブ再配置 (セッション cf93a4f2・母艦 Fable)

<ol class="steps"><li class="done">Gate 0 仕様</li><li class="done">Gate 1 エンジン</li><li class="done">Gate 2 store</li><li class="now">Gate 3 Panel</li><li>Gate 4 実操作</li><li>Gate 5a 試触</li><li>Gate 5 実機性能</li><li>Gate 6 監査</li><li>封印解除</li></ol>

旧 7f45612b と同一個体 (sessionId が途中で cf93a4f2 に変わっている)。正本は `~/.claude/dispatch/260825-tab-grouping-gates/STATUS.md`。

- 到達点: Gate 2 は条件付き PASS (`GATE2_DONE.md`)。Gate 3 の実装便は G3-1 → G3-1c → G3-2 → G3-2c (並置+接続線・宮崎さん承認) → G3-2d → G3-3 `e962f50` (系譜階層・脈動チップ) → G3-3b `cfef3bd` まで全部受理・push 済み。完成度は宮崎さん評価で 20%
- 残り (正本 = `docs/plans/2026-08-27-tab-grouping-ux-roadmap.md` `8405cd4`・Oracle × sol の判定を統合): **L1** (legacy 経路の物理削除・preview 一本化) → **UX-1** (編集モデル `EditCommand`・編集内 undo) と **UX-1b** (生体・系譜の本番契約) を並走 → **UX-2** (編集可能な After 配置図・「この案で確認」・モック再提出) → **UX-3** (Pointer DnD 正常系) → **UX-4** (DnD 中断系) → **UX-5** (線の仕上げ) → **G4** (実操作マトリクス) → **G5-P** (100 タブ性能) と **G5-R** (実機・オーナー試触ビルド) → **Gate 6** (Opus 監査) → **解除** (宮崎さんが実機で 4 シナリオを説明なしで完了 → `TAB_GROUPING_ENTRY_ENABLED=true`)。**残り 11 便**。12:35 時点は L1 / UX-1 / UX-1b の order 起草中 (実装は静止)
- 完了条件: Gate 6 ACCEPT + 宮崎さんの実機 GO で `TAB_GROUPING_ENTRY_ENABLED` を true にする (それまで false 固定)。タグ・リリース・封印解除・実機再起動はレーンでなく宮崎さんと母艦の管轄
- 持ち越し台帳 (受理に算入しない): `appliedLayoutSignature` の全量 hash ~140ms/適用 / undo が label・agentKind まで巻き戻す / focus trap 18 停止
- <span class="chip ok">解消</span> 未回答だった 1 問「GitHub にあげたセッションの様子が見えるか」は 2026-08-27 12:20 に宮崎さんが**今回は見送り**と裁定。レーン A はこの項目なしで G3-3 以降を進める (後で入れるときは系譜モデルを再度触る)
- <span class="chip warn">運用</span> Oracle が CDP 拒否・プロンプト未投入で 5 回失敗 → 判断者を Codex sol max に代替中。最終盤で `oracle-chrome up` により復旧

## 3. 走行中レーン B — v0.57.0 残課題 7 件 (セッション 312ce6a4「開発 タブ復元」)

<div class="bar ok"><b>完了 3/7 (#2 #4 #6)・実装済み待ち 1 (#3)・着手前 1 (#1)・Gate 3 後 2 (#5 #7)</b><span style="width:43%"></span></div>

宮崎さんの記憶どおり、7 件のうち #5 と #7 はこのセッションのスコープ外。01:02 の回答「独立領域を先に並行着手」で「#5 アイコン・#7 ペイン復活は Gate 3 の push 後に回す」(レーン A と同じファイル群に触るため) が確定している。

| # | 件名 | 状態 | 残り |
|---|---|---|---|
| 1 | AI ログ分析の集計が狂う | 真因確定。Codex 内部サブエージェントが `is_sidechain` で除外され直近 30 日で $14,602 (23.5%) が消失、claude の親会話も sidechain 化 ($4,303)。codex 元ログは 5 日で自動削除 (4〜7 月分は消滅・被覆 14%) | 保全便 = 元ログの生 gzip ミラー (裁定: 全文を無期限で Drive へ)。Drive の置き場所決定 → 容量警告 → sol 指摘 4 件 (execution 正本性・turn occurrence・増分 checkpoint・旧ログ backfill) の再設計 → dedup → rollup v2 → 包含 |
| 2 | ターミナルのスクロール飛び・拡大戻りの崩れ | 完了 `6ed846b` | — |
| 3 | grok の週間制限がログイン間隔で消える | Rust 実装済み (`cli_accounts/grok.rs` に live `auth.json` への楽観ロック書き込み・`commands/usage.rs` で宛先分岐)。未コミット | `scripts/run_windows_tests.py` 緑 → コミット |
| 4 | grok 制限の数字 3 つの意味 | 完了 `120294d` | — |
| 5 | 上部右 5 アイコンが幅で消える | 方針確定 (ダッシュ → ズーム → 新規タブの順に畳む。⋮・✕・分割は残す) | 実装はレーン A の Gate 4 以降 (PaneTabBar が安定してから) |
| 6 | 会話履歴が開けずダッシュボードへ飛ぶ | 完了 `6ed846b` | — |
| 7 | 再起動時のペイン復活が不安定 | 原因候補: `grid_template_id` が 1x1 なのにペイン 5 枚 → `split_columns` 喪失時に 1 列縦積みへフォールバック | 実装はレーン A の Gate 4 以降 (workspaceLayoutStore・復元経路が安定してから) |

- 完了条件: 7 件すべてコミット + 4 スイート緑 + 実機で再現手順が消えていること
- <span class="chip ng">ブロッカー</span> RAM 33.8GB 中 96% 使用 (空き 1.1GB) で Rust テストラッパーの閾値 5GB を割り、#3 のテストが停滞。走行中の Codex タブ (モモスタ・理科など 8 本前後) を減らすか、夜間に回す
- <span class="chip warn">運用</span> Oracle は入力欄に前回の 145,488 文字が残留して `prompt-commit-timeout`。sol max を代替判定者にしている。復旧手順 = `oracle-chrome show` → 入力欄の残留を消す → サイドバーの Chat (個人 Pro) 側に切替 → PING

## 4. 待機中の開発 2 本

<div class="cards">
<div class="card"><p class="card-t">4a メール監視 (mail-spec v4・637 行)</p><p>Oracle 再レビューは NO-GO (閉じた 8 / 部分 10 / 未了 1) → v4 で 21 項目を反映済み。段階は 0a 契約の正本化 (文書) → 0b 判定の土台 → 1a 気づく → 1b ダッシュボード統合 (大型アップデート後) → 2 消し込み → 2.5 下書き → 3 移管。宮崎さんの位置づけは「まだ要件定義段階」。0a の残りは 6 例の完全 JSON・fixture manifest・依存の実値。0b の着手条件 = 0a 完了 + レーン A の封印解除 + 宮崎さんの指示。正本 <code>docs/mail-spec-260827.md</code></p></div>
<div class="card"><p class="card-t">4b Web ペイン (ChatGPT Pro)</p><p>要件確定済み (<code>docs/plans/2026-08-27-web-pane-chatgpt-requirements.md</code>・ADR 0008)。Phase 1 = WebView2 child webview のタブ + ランチャー項目 + push (composer に載せて止める) / Phase 2 = oracle を同じ WebView2 に attach する spike。着手前の確認 = K2 ChatGPT のログイン方式 (Google だと WebView2 で拒否の可能性)・K9 ChatGPT Pro の添付上限。規模の目安 Rust 400〜600 行・TS 300〜400 行</p></div>
</div>

## 5. 順序と依存

<ul class="timeline"><li class="now"><b>今</b> レーン A = L1 → UX-1/UX-1b (残り 11 便) / レーン B = #3 コミット・#1 保全便 (並行・別セッション)</li><li><b>A の UX-2 以降</b> レーン B #5・#7 に着手 (PaneTabBar・復元経路が安定してから)</li><li><b>両レーン完了</b> v0.58.0 を 1 本 (タブ再配置の解除 + 残課題 7 件)。宮崎さん裁定 12:45 = 案 (b)。レーン A の G5-R オーナー試触ビルドをそのままリリース前検証に使う</li><li><b>v0.58.0 配信後</b> レーン C = Web ペイン Phase 1 / レーン D = メール 0a → 0b → 1a (bunshin で別 worktree・並行)</li><li><b>順次</b> v0.59.0 = Web Phase 1 / v0.60.0 = メール 0b+1a / v0.61.0 = メール 1b+2 (Web Phase 2 は spike 合格時に同乗) / v0.62.0 = メール 2.5 / v0.63.0 = メール 3</li></ul>

依存の要点:

- 刻み方は案 (b) で確定 (12:45)。レーン A の残り 11 便 (DnD 正常系・中断系・性能・実機) が終わるまで feed は 0.57.0 のまま。却下した案 (a) = レーン B 完了分で先に 0.58.0 を切る (封印下の Gate 2 store 変更を同梱するため、テスト機 smoke が別途要る)
- レーン C (Web ペイン) は `workspaceLayoutStore.ts`・`PaneTabBar.tsx` を触る。レーン A の UX 便がこの 2 ファイルを動かしている間は衝突しやすい → C の着手は A の UX-2 着地後、または A 完了後

- メール 1b (AttentionCards 統合) はレーン A の完了が前提。0b はそれより前でも着手できるが、宮崎さんの位置づけが「要件定義段階」のため v0.58.0 配信後に置く
- レーン C と D は触る領域が違う (C = Rust webview・layout store・launcher / D = 判定エンジン・TitleBar・通知パネル・mail-*.json)。data.json の schema guard だけ C が触るので、D は data.json を使わない設計 (§8 の 3 ファイル) を守る
- 「GitHub にあげたセッションの様子」は今回見送り (12:20 裁定)。入れるなら v0.59.0 以降の別便
- Oracle の復旧は両レーンの判定と Web Phase 2 の前提。Work 枠の週次上限が切れているときは Chat 側に切り替える (memory `reference-oracle-work-weekly-limit`)

## 6. リリース手順 (毎版共通・CLAUDE.md の蒸留)

<ol class="steps wide"><li>走行レーン停止</li><li>4 スイート</li><li>clean tree</li><li>タグ単独検証</li><li>tag push</li><li>CI / runner</li><li>feed mirror</li><li>key-id 照合</li><li>テスト機で更新</li><li>公開ミラー</li><li>memory</li></ol>

1. 走行中の委譲レーンを止める (ビルド中の書き込みは本番バイナリに混ざる)
2. `npx tsc --noEmit` / `npx vitest run` / `python scripts/run_windows_tests.py` / `python -m pytest tests/` を全部通す
3. `git status --porcelain` が空であること (build-personal.ps1 は clean tree 必須・untracked も残さない)
4. 一時 worktree でタグ対象コミットだけを checkout して `cargo test --no-run` (ステージ漏れ ×2 の実害あり)
5. 版を `tauri.conf.json` と `Cargo.toml` の両方で上げてコミット → タグは 1 個ずつ push (multi-tag push は workflow trigger 漏れ)
6. GitHub Actions の枠が無いときは `scripts/start-release-runner.ps1` で self-hosted runner (秘密系 env を剥がす)
7. `scripts/mirror-personal-updater-feed.ps1 -SourceTag vX.Y.Z` を手元で実行し latest.json の version を確認 (CI の mirror ステップは secret 未設定で成功表示のまま skip される)
8. latest.json の signature をデコードして key-id が `bbf2382d7a0753cc` (tauri.conf.json の pubkey) と一致することを確認。不一致だと更新ボタンが検証エラーで失敗する
9. テスト機を `--profile` 隔離で並行起動し、更新ボタンから実際に更新できることを確認してから本番に GO (本番の再起動は宮崎さんの明示 GO)
10. 公開ミラー `miyafcos/mycmux-team` へ `git commit-tree "master^{tree}" -p <team master HEAD>` の sync コミットを push (ブランチ直接 push は禁止)
11. memory の project エントリを更新 (版・残件・次の一手)

版番号は 0.5x.y で刻む。1.0 の宣言は宮崎さんの判断 (memory `project-v1-roadmap`)。

## 7. 体制とルール (この工程で固定)

- 母艦 = Fable (レーン A は cf93a4f2・レーン C/D は新タブの Fable 母艦) / 作業 = Codex (terra 既定・fail で sol 昇格) / 監査 = Opus 5 / 判断 = Oracle (不調時は Codex sol max で代替し復帰時に照合) / 品質保証 = Fable
- 同一 worktree で並行するレーンはコミット規律を守る (帰属確認 → パス指定ステージ・stash 禁止)。新レーン C/D は bunshin で別 worktree
- 各便の受理の型: 隔離 worktree で red → green の反転を母艦が自分で再現 → Opus 閉鎖確認 → コミット → push
- タグ・リリース・封印解除・実機再起動・deploy はレーンは実施しない (宮崎さんと母艦の管轄)

## 8. 宮崎さんに要る判断 (1 問ずつ)

| # | 判断 | いつ |
|---|---|---|
| 1 | ~~「GitHub にあげたセッションの様子」の意味~~ → 12:20 に「今回は見送り」で解消 | 済 |
| 2 | ~~v0.58.0 の切り方~~ → 12:45 に (b) 両レーン完了で 1 本、で確定 | 済 |
| 3 | K2 ChatGPT のログイン方式 (Google / メール+パスワード / Apple) | レーン C 着手前 |
| 4 | メール 0a (文書のみ) を両レーン完了前に始めるか (Oracle は可としている) | 任意 |
| 5 | CLAUDE.md の稼働 exe 記述の訂正 (§1) | 任意 |

## 9. 進捗ログ (母艦の確認記録・新しい順)

### 2026-08-28 10:20 — v0.58.0 配信完了 (タブ再配置の封印解除)

- **feed 0.58.0 公開・検証 PASS**: 3 プラットフォーム (windows-x86_64 / -msi / -nsis) すべて 0.58.0 の URL・private URL 残存なし・署名 key-id `CC53077A2D38F2BB` が `tauri.conf.json` の pubkey と一致。稼働 exe はまだ 0.57.0 (宮崎さんが「設定 → アプリ情報 → 更新を確認」を押せば当たる)
- **封印解除**: `TAB_GROUPING_ENTRY_ENABLED = true` (`774daa9`)。Gate 6 は 3 回かかった — 1 回目 High 2 (オーバーレイのテーマ喪失 / poison レイアウトの保存)・2 回目 High 2 (格上げ: future schema での作業消失 / Undo が tab 名・cwd を巻き戻す)・3 回目 GO。修正は `d47b8a1`
- **母艦の介入 2 件**: (1) bridge WIP (8/24 の未コミット 7 ファイル) の退避裁定 → クリーンな tree でリリース (2) momosta レーンの Codex が投げた暴走 PowerShell (14KB の JSON を読むだけで CPU 1569 秒・5.4GB) を承認を得て kill → 空き 0.58GB → 5.85GB で Rust テストの RAM ゲートを解除。Rust 964 passed
- **Gate 6 の収束裁定**: 3 回目の監査範囲を「H-A/H-B/H-C の閉鎖確認 + 4 スイート」に限定し新規探索を禁止。基準を動かしながら回すと収束しないため
- 同梱: レーン B の 5 件 (#1 保全便 / #2 / #3 / #4 / #6)・data.json schema guard・ailog アーカイブルート・設定の AISET 再構成・配置図の生体化・README 全面改訂
- **次**: v0.58.1 (bridge WIP の復元+単独監査・レーン B の #5 #7・Gate 6 台帳の Medium 6 + Low 8 + G5P-01) → レーン C (ChatGPT 連携 Phase 1・order 343 行は起草済み) → レーン D (メール 0a)


### 2026-08-28 07:50 — レーン A は Gate 6 監査中 (v0.58.0 の直前)・レーン B は #5/#7 を残して待機

- レーン A: 22:33 UX-5 `cec0040` → 01:23 UX-5b `15e378e` → 02:15 G5-P 性能ベンチ `0d7a56e` → 03:46 **G4 実操作行列 `3b793b1`** (78 tests・production 欠陥 4 件を同便で修正) → 03:50 **G5-R 試触ビルド** (HEAD + 封印フラグ一時 true・`--profile grouping` で並行起動・34.1MB) → 宮崎さん試触 **GO** (「Go してください。ほかの開発ももろもろこめて更新いけるようにしておこう」) → 現在 **Gate 6 独立監査 (sol) 走行中**。受理後 = 封印解除の 1 行差分 (`TAB_GROUPING_ENTRY_ENABLED = true`) → v0.58.0 (レーン B の 5 件同梱) → feed。Gate 6 台帳 9 件持ち込み
- レーン B: 変化なし。スコープ内 5 件 (#1 保全便・#2・#3・#4・#6) は master にあり試触ビルドにも同梱済み。**#5 (上部アイコン折りたたみ) と #7 (ペイン復活) は未着手**のまま — Gate 3 は終わったので着手可能だが、いま `PaneTabBar` / 復元経路を触ると Gate 6 の監査対象と試触済みビルドがずれる。**推奨 = v0.58.0 はこのまま切り、#5/#7 は v0.58.1 (小さな追い便)**
- 待機中 2 本 (Web ペイン ChatGPT Pro / メール監視) は着手なし (v0.58.0 配信後に開始・§5 のとおり)
- v0.58.0 に同乗する master の開発中項目: data.json schema guard / ailog アーカイブルート / 設定の AISET 再構成 (AI 7 機能一覧・自動化タブ) / 配置図の生体化 (G3-3)
- README 全面改訂 `b1ae81d` (325→1,161 行) は完了・push 済み
- RAM 86% (空き 4.3 GB) に回復。テスト機は閉じられており本番 1 本のみ稼働

### 2026-08-27 22:20 — レーン A は UX-5 まで到達・コード増量の内訳

- レーン A: UX-3 (Pointer DnD) `f5ffbbc` 19:15 → UX-4+4b (中断系・自動スクロール・背面遮断) `7009ec0` 21:13 → **UX-5 (線の仕上げ) 完了・閉鎖確認監査中** (253 files / vitest 3,434 緑・反転 PASS 71/71)。受理なら G4 ∥ G5-P へ。母艦は圧縮済みで CTX 約 20%・effort high 維持。11 便中 7 着地 (L1・UX-1・UX-1b・UX-2・UX-3・UX-4・UX-5 直前)
- 1 便あたりの所要 = 1〜2.7 時間 (UX-3 は監査 REJECT → UX-3b 修正で 2h40m)。内訳は Codex sol の実装 30〜90 分 + 隔離 worktree の反転検証 + Opus/Codex の閉鎖確認 + 差し戻し修正。時間の大半は工程 (2 段監査) と差し戻し、コード量そのものではない
- **コード増量 (v0.57.0 タグ → HEAD・2 日間)**: 全体 +33,736 / −1,960 (純増 +31,776 行・205 ファイル)。用途別 = テスト・モック +18,095 (54%) / フロント +10,435 / Rust +2,783 / 文書 +2,022 / スクリプト +272。レーン別 = タブ再配置 フロント +11,518 / −3,021 (純増 +8.5k・製品コード) と テスト +16,230 / −914 (製品:テスト ≈ 1:1.8)、レーン B ほか Rust +2,840 / フロント +1,185 / テスト +2,541。製品コードの総量 (src + src-tauri/src・テスト除く) = 172,740 行。vitest は 3,102 → 3,434 件 (+332・今日 1 日)
- モック (`src/mock/` 771 行) は製品コードから未参照 → バンドルに入らない
- RAM 91% (空き 2.8 GB) に改善。テスト機ビルドにはまだ足りない (目安 5 GB)

### 2026-08-27 18:45

- レーン A: 12:55 以降に 4 便着地 — L1 `6e3f6eb` (legacy 646 行削除) / L1b `3ed282b` / UX-1+UX-1b `0cd915d` / UX-2 `d259419` (16:35 受理)。宮崎さん指示 (15:55)「モック提出は終了・以後の提出物は Gate 5R の実機ビルド」/ (15:58)「監査・起草は Codex へ (Fable 節約)」。UX-3 (Pointer DnD) は監査で受理不可 (Blocker 1 テストソース上書き・High 2 drop ID 衝突/高速 release) → **UX-3b 修正便 実行中** (18:43 時点 rollout 成長中・BLOCKER なし)。残 = UX-3b → UX-4 → UX-5 → G4 ∥ G5P → G5R 実機ビルド → Gate 6 → 解除。**母艦セッション cf93a4f2 は CTX 100%** — UX-3b 着地後に `/compact` + `/model` で effort 復帰が要る (STATUS.md と order ファイルが正本なので復旧可)
- レーン B: スコープ内 5 件すべてコミット・push 済 — #1 `7cdccf5` (スケジュール索引+元ログ全文ミラー) / #2 `6ed846b` `7a5fae7` / #3 `f1f6036` / #4 `0591a4c` (真の症状 = 3 つの数字 65%・↻8/29・13:45 を言葉に) / #6 `6ed846b`。検証 tsc 0 / vitest 3,300 / Rust 964 / pytest 369。**実機未確認**。本人は「mycmux 再起動が要る」と言うが、正しくはテスト機 `--profile` 隔離の並行起動 (再起動不要)。ビルドの前提 = レーン A が書き込んでいない瞬間 + RAM 空き 5 GB 以上。#5/#7 は Gate 4 以降 (変更なし)
- RAM 97% (空き 0.9 GB): claude 13 プロセス 4.3 GB / codex 11 プロセス 3.1 GB / chrome 30 プロセス 2.7 GB / msedgewebview2 46 プロセス 2.6 GB / Dropbox 1.7 GB / ChatGPT デスクトップアプリ 0.7 GB / Slack 0.7 GB / node 64 プロセス 0.7 GB。テスト機ビルドと Rust テストはこのままでは回らない — 終わった Claude/Codex タブを close-tab するのが一番効く
