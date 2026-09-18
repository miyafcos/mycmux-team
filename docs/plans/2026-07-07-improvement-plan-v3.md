# mycmux 改善プラン v3 (2026-07-07)

v0.9.1 リリース後の全体コードレビュー。Rust バックエンド / React フロント / テスト・リリース基盤 / UX 負債の4視点を並列調査し統合。
安定化計画 v2 (Phase A/D/B/C/E) と CHANGELOG 0.8.54〜0.9.1 で実施済みの項目、および過去に棄却済みの項目 (受信時 ACK 化 / consumer_id 検証昇格 / zero-size ペイン出力破棄) は除外済み。

親検証: `/qr` トークン漏洩は母艦が実コードを確認 (`remote/mod.rs:197,526-536` 無認証 + `:237` `0.0.0.0` bind + `lib.rs:247` 無条件起動) して確定。他は各サブエージェント報告 (要着手時に再確認)。

---

## Phase S — セキュリティ & リリース安全網 (最優先・次リリースまでに)

### S-1. [SECURITY] リモート `/qr` が無認証で平文トークンを返す
`src-tauri/src/remote/mod.rs:526-536` (`serve_qr`) / route `:197`
- **現象**: `/api/state` (`:400`) と `/ws` は `validate_token` 必須だが `/qr` だけ検証なし。`qr::connection_url(ip, port, token)` = フルの平文トークンを埋めた URL を SVG QR にして誰にでも返す。サーバーは `0.0.0.0:{port}` bind (`:237`) で起動時に無条件常駐 (`lib.rs:247`)。
- **影響**: 同一 LAN / Tailscale 上の任意ホストが `GET /qr` → SVG 内 URL からトークン奪取 → `/ws?token=…` で全ワークスペース・全ペインの読み書き。トークン認証モデルが実質バイパスされる。リモート機能を一度も使わなくても露出する。
- **修正**: `serve_qr` に `/api/state` と同じ `?token=` 検証を追加し未検証は 401。QR 生成はローカル IPC 経由の Tauri command (`get_remote_info` 系) 側に寄せ、HTTP エンドポイントからトークンを出さない。
- 工数 S / リスク low / **これを最初にやる**

### S-2. [SECURITY] リモートサーバーが常に `0.0.0.0` bind + 終了時に後始末なし
`remote/mod.rs:237` (bind) / `remote/session.rs:183-191` (`kill_all` が `#[allow(dead_code)]` で未配線)
- **現象**: 起動時に全インターフェース待受。`RemoteSessionManager::kill_all` は呼び出し元ゼロで、リモートシェルは一度作られるとアプリ終了まで reader thread ごと生存 (全リモートクライアントが同一シェル共有)。
- **影響**: 「使っていないから安全」が崩れる。S-1 と重なると意図せぬ LAN 公開端末になる。
- **修正**: 既定 bind を `127.0.0.1` にし、設定で明示的に有効化したときだけ `0.0.0.0`。`quit_app` (`commands/window.rs:64` で既に `SessionManager::kill_all` を呼ぶ経路) に `remote_state.sessions.kill_all()` を追加。
- 工数 M / リスク med (常時 LAN 公開だった挙動を変える。既存のリモート/QR 利用フロー確認が要る)

### S-3. [Release] lite の updater feed 正規化が workflow 未配線 + master はサイレントスキップ
`.github/workflows/release.yml` (master `:110-121` / lite ジョブに該当ステップなし)
- **現象**: master の「Mirror personal updater feed」は `MYCMUX_TEAM_RELEASE_TOKEN` 未設定だと `Write-Warning` + `exit 0` で成功扱い。lite ジョブには正規化ステップ自体がなく、tauri-action が吐く生 `latest.json` (plain `windows-x86_64` = MSI 直参照) がそのまま載る。
- **影響**: 0.9.x で踏んだ dual-install split-brain が lite の次回リリースで確実に再発。master は緑チェックのまま実際は何もしていない (気づけない)。
- **修正**: (a) 正規化を `scripts/normalize-updater-feed.ps1` に括り出し master/lite 両 workflow から呼ぶ (plain key → nsis エントリ上書き)。(b) secret 未設定時は `::error::` + Step Summary に赤字明示し、意図的スキップなら `continue-on-error: true` を明示。
- 工数 S+S / リスク low

### S-4. [Test] updater feed の不変条件を契約テスト化
`tests/test_updater_feed_contract.py` (新設)
- **現象**: 「plain `windows-x86_64` キーは常に nsis エントリと signature/url 一致」という不変条件が `mirror-personal-updater-feed.ps1` の手続きにしか存在せず、テストゼロ。これが 0.9.x インシデントの根本 (不変条件が人間の記憶にあった)。
- **修正**: fixture または実 Release 取得の `latest.json` に対し `platforms.windows-x86_64 == platforms.windows-x86_64-nsis` (署名・URL) を pytest でアサート。CI の正規化ステップ直後に実行。
- 工数 S / リスク low

### S-5. [Test] バージョン一貫性の契約テスト
`tests/test_version_consistency.py` (新設)
- **現象**: `package-lock.json` が v0.8.50 世代で凍結 (package.json は 0.9.1)。0.8.54/0.9.0/0.9.1 のどのリリースもロックを更新していない。`npm ci` は素通り。
- **修正**: `package.json` / `package-lock.json` (root と `packages[""]`) / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` の mycmux エントリ、5点の version 一致を pytest で検証。まず lock を 0.9.1 に是正してから導入。
- 工数 S / リスク low

### S-6. [CI] release.yml にテスト job がない
`.github/workflows/release.yml` (master/lite 両方)
- **現象**: tag push で即ビルド・署名・公開。`tsc` / `vitest` / `cargo test` / `pytest` のいずれも走らない。ローカル `build-personal.ps1` も git クリーン確認のみ。CLAUDE.md の「変更後は必ず全部」を強制する仕組みがゼロ。
- **影響**: updater で全ユーザーに配信される前段の関門が人間の記憶だけ。
- **修正**: `test` job (tsc/vitest/cargo test/pytest) を追加し `build-*` の `needs:` に。S-4/S-5 もここに乗る。
- 工数 M / リスク low (既存テストを繋ぐだけ)

---

## Phase R — 信頼性 (実運用で効く)

### R-1. git 監視スレッド + 子プロセスがハング時に永久リーク
`src-tauri/src/pty/monitor.rs:664-695`
- **現象**: CWD 変化ごとに `thread::spawn` で `git rev-parse` 起動、監視側は `recv_timeout(2s)` するだけ。子プロセスへの `kill()` なし。
- **影響**: `G:/マイドライブ` (Google Drive streamed) 越しの `.git` 走査で git が応答しないと、そのたびスレッド+子プロセスが 1 本ずつ滞留 (ワークスペース数 × CWD 変化回数)。「なんとなく重くなる」原因候補。
- **修正**: `Child` ハンドルをスレッド側で保持し timeout 経路で `child.kill()`。`crsm.rs::command_output_with_timeout` に正しい同型パターンあり、流用が早い。
- 工数 M / リスク low-med

### R-2. per-machine / per-user 二重インストール検出の安全網がない
`src-tauri/src/lib.rs` `.setup()` (`:221` 付近)
- **現象**: 0.9.1 で実際に踏んだ「NSIS が MSI 側に吸われ Program Files に per-machine インストール → 実行中の per-user が永久に更新されない」を実行時に検知する仕組みがない。今回の fix は feed/ビルド側是正のみ。
- **修正**: 既存 `dirs` crate だけで `%ProgramFiles%\mycmux\mycmux.exe` と `%LOCALAPPDATA%\mycmux\mycmux.exe` 両方の存在をパスチェックし、両方あれば起動時に `tauri_plugin_dialog` (既に登録済み) で警告。新規依存ゼロ・30-50行の自己完結関数。
- 工数 S / リスク low

### R-3. launcher の無条件上書き footgun を根治
`src-tauri/src/lib.rs:63-92` (`install_launcher_script`)
- **現象**: 起動のたびバンドル版と差分があれば `~/.mycmux/bin/launcher.sh` を無条件上書き。0.9.1 では「バンドル側に機能を先取り」で回避したが、根本 (無条件上書き) は未解消。ユーザーがカスタム起動項目を足すと次リリースで黙って消える。
- **修正 (1案に絞る)**: バンドル版は無条件上書きを継続 (バグ修正の伝播は止めない)。スクリプト末尾に拡張フックを追加:
  ```sh
  [ -f "$HOME/.mycmux/bin/launcher.local.sh" ] && source "$HOME/.mycmux/bin/launcher.local.sh"
  ```
  `launcher.local.sh` (.ps1 同様) は install 側が二度と触らない。カスタマイズはこちらに一本化。マーカー比較や 3-way マージより単純。
- 工数 M / リスク low-med (フック読込とWindows PS 版での検証)

### R-4. タブ close 時の terminal dispose 順序に理論上の窓 (要ランタイム確認・確度中)
`src/components/workspace/TerminalPane.tsx:400` / `XTermWrapper.tsx:1465`
- **現象**: `handleRemoveTab` が `evictTerminalCache`(=`term.dispose()`) を `removeTabFromPane` より先に同期実行。XTermWrapper 側の `pumpTerminalWrites` は独立クロージャ `termDisposed` で防御するが、`evictTerminalCache` の dispose とは同期しない別フラグ。close 直後・再レンダ前に書き込みバッチが in-flight だと dispose 済み Terminal への書き込みが飛ぶ理論窓。
- **修正**: `evictTerminalCache` に dispose 通知を追加 (eviction cleanup 経由で `termDisposed` を立てる) か、close 順序を `removeTabFromPane` → `evictTerminalCache` に入替。
- 工数 S(調査)/M(修正) / リスク med (タイミング系・CDP 実機検証要)

---

## Phase Q — 品質 quick win (低リスク一括掃除)

### Q-1. ErrorBoundary が2系統重複 + 片方は生スタックを露出
`src/components/common/ErrorBoundary.tsx` (テーマ整形 + Retry) vs `src/components/layout/ErrorBoundary.tsx` (`error.toString()` を `<pre>` で直出し)。common 版に統一し layout 版削除 + 呼び出し元差替。工数 S / リスク low

### Q-2. 死に公開関数・死に export の掃除
`src/lib/forcedAutoUpdater.ts:137` `startForcedAutoUpdateLoop` は呼び出し元ゼロ (0.8.45 で自動更新ループ停止の名残)。同ファイルの `subscribeUpdateStatus`/`getUpdateStatusSnapshot` pub/sub も購読者ゼロ。自動更新復活は既存決定 (B案=放置) を覆さない範囲で、死に配線のみ削除。工数 S / リスク low

### Q-3. WebGL 設定のデッドコード + 事実と齟齬の UI 文言
`src/stores/settingsStore.ts:8,21,52,61` の `useWebglRenderer`/`setUseWebglRenderer` はレンダラー DOM 固定化で完全デッド。`SettingsMenu.tsx:305-317` は `disabled` チェックボックス + Windows 限定を謳う文言を全 OS に表示。store フィールド2つ削除 + 文言修正 or 項目削除。工数 S / リスク low

### Q-4. db/storage.rs の save/save_unlocked 未使用 (clippy 警告)
`src-tauri/src/db/storage.rs:469,491`。Phase A の pinned_roots merge 化で全書込が `update()` 経由になり dead code。削除 or `#[allow(dead_code)]` + 理由コメント (full-snapshot 上書きが過去の競合原因だった旨)。工数 S / リスク low

### Q-5. 残 clippy 警告2件
`buddy/work_context.rs:54` (`sort_by_key`) / `pty/monitor.rs:686` (`unwrap_or_default`)。提案どおり書換で `cargo clippy --release` グリーン化。工数 S / リスク low

### Q-6. ドキュメントの実在しないスクリプト参照
`CLAUDE.md:29` (`~/deploy-mycmux-v2.ps1` 実体なし・`Test-Path` False) / `docs/plans/2026-07-03-…-v2.md:211` 同名参照。実体を `~/` に作るか、記述を実在手順 (手動コピー) に書換。工数 S / リスク low

---

## Phase M — 保守性 (次のリファクタサイクルでまとめて)

### M-1. god file 分割の残り (pure-move パターン横展開)
- `XTermWrapper.tsx` (2,028行): markdown テーブル整形 (~150行) / display-width 計算 (~80行) / テーマ構築 (`buildThemeFromConfig` 系) / 通知音再生 が state なし純関数のまま同居。`terminalMarkdownFormat.ts` / `terminalDisplayWidth.ts` / `terminalTheme.ts` へ移動。工数 M / リスク low
- `FileExplorerSidebar.tsx` (1,597行): `MenuItem`/`TreeRow`/`IconButton` + 純関数10近くが分離可能形で同居。工数 M / リスク low
- `CrsmPalette.tsx` (1,428行): `crsmSessionsApi.ts` + `crsmPaletteFormat.ts` へ fetch 層・純関数を切出し。工数 M / リスク low

### M-2. store 越境結合の設計整理
`workspaceLayoutStore.ts` が `workspaceListStore.ts` の "private" `_updateWorkspacePanes` を25箇所以上 `.getState()` 直叩き。focus の whack-a-mole (E-1 で解消) と同型リスク源。`_updateWorkspacePanes` を正式 public API に昇格 or 両 store マージの設計判断。まず境界の文書化・命名から。工数 L / リスク low-med

### M-3. IPC 失敗 / updater 失敗の可視化 (クリティカルパス限定)
`invoke()` 48箇所にトースト/通知の仕組みなし。`killSession(...).catch(() => {})` 等の黙殺 catch 複数、更新失敗は Settings を開かないと見えない。軽量トースト (1コンポーネント + store) を追加し、重要な invoke 失敗 (セッション作成/削除/write) と手動 updater チェック結果だけ配線。ACK 黒穴のような「見た目正常・内部失敗」系の次回診断コストを下げる観測装置。工数 M / リスク low-med (出しすぎ防止で対象を絞る)

### M-4. 振る舞いテストの新設 (grep 契約テストの補完)
`tests/*.py` 11本はほぼソース文字列 grep で振る舞い検証ではない (socket API ハンドラ・session mapping 復元が実質無テスト)。`socket.rs` 主要コマンドを実プロセスに投げる統合テスト、`SessionManager` 永続化→復元ラウンドトリップの `#[tokio::test]` を各1本。工数 L / リスク med

### M-5. master ⇔ lite 共有ファイルドリフト検知
cherry-pick 漏れを検知する仕組みが皆無。buddy 非依存のコア (pty/**, session_mapping.rs, ipc.ts 等) をアローリスト化し、週次 cron で `git diff master release/public-lite -- <allowlist>` の非ゼロ diff を Issue/Slack 通知。自動マージ不要、"気づける" だけで十分。工数 M / リスク low

### M-6. インライン style の部分的クラス化
`style={{…}}` が23ファイル361箇所。全面 CSS Modules 化は過剰投資。再レンダ頻度が高い経路 (タブバー・ステータスバッジ・memo 化子コンポーネントに親から style を渡す箇所) だけ対象を絞ってクラスベース化。工数 S(絞る)〜M / リスク low

### M-7. metadataBySession 構築の重複を共有フック化
`PaneTabBar.tsx:206-212` と `TabBar.tsx:78-81` が同型ロジック独立実装。`useSessionMetadataMap(tabs)` へ抽出。工数 S / リスク low

---

## 推奨着手順

1. **S-1 (`/qr` トークン漏洩)** — 唯一のネットワーク越し実害バグ。1関数に検証1行追加、S 工数 low リスク。単独で即パッチ (v0.9.2) に値する。
2. **S-3 + S-4 + S-5 + S-6 (リリース安全網)** — 0.9.x で踏んだインシデントが lite の次回リリースで再発する経路を塞ぎ、不変条件を人間の記憶からテストへ移す。CI テスト job を土台に契約テストを乗せる。
3. **S-2 (bind 既定 localhost + remote kill_all)** — S-1 と同じリモート領域なので一括で後始末。
4. 以降 R-1/R-2/R-3 (実運用の信頼性) → Q 群 (低リスク一括掃除) → M 群 (次リファクタサイクル)。

## 追記 (2026-07-07 夜 実装後の Fable 総ざらいで発見・次サイクル候補)

- **R-5 候補**: `buddy/codex.rs` は Windows で `cmd /C codex ...` 経由起動のため、40s timeout 時の `child.kill()` が直接子 (cmd.exe) にしか効かず codex.exe が orphan 化しうる。頻度は稀 (timeout 経路のみ)。Job Object か `taskkill /T` 相当が要る。工数 S-M / リスク low
- **S-2 関連メモ**: `remote/qr.rs` の `tailscale ip -4` / `ip -4` は `.output()` に timeout なし。QR/remote info 要求時のみ実行されるが、S-1/S-2 のリモート領域リワークに含めること
- 上記以外の thread::spawn / Command 実行 / フロント setInterval は全数確認済み — PTY reader (設計上常駐)・crsm (timeout+kill 済)・buddy codex (40s timeout 済)・diag interval (DEV限定)・UsageMeter/BuddyAvatar (cleanup 済) で追加リークなし

## 除外・確認済み (問題なし)
- TODO/FIXME/HACK 実コード0件 (vendor `xterm.css` 1件のみ)。型安全性良好 (`any` は `ipc.ts:436` の1件・`@ts-expect-error` 0・strict)。
- 旧 BrowserPane は iframe artifact プレビューへ転用済みで機能。死んだ UI ボタンなし。
- PTY 背圧コア・ロック規律は綺麗で追加リークなし (git 監視スレッドの R-1 は別種)。termCache eviction 自体は明示 close に正しく紐付き無制限成長なし。focus SoT (E-1) は完全に効き `setActivePaneId` 直呼び 0 件。
