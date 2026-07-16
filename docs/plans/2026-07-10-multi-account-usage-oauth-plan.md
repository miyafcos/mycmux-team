# マルチアカウント Usage 監視 + 自前 OAuth 設計書

- 作成: 2026-07-10
- 対象: mycmux master (Tauri v2 + React 19 + Rust)
- 目的: 複数の Claude (Pro/Max) アカウントのレートリミット/使用量を mycmux のタイトルバーで一元監視する。認証はブラウザ経由で一度取得したら mycmux 側に保存し、以後は自動更新する。
- 方式決定 (2026-07-10 宮崎さん): **mycmux 自前 OAuth 方式** を採用。mycmux が OAuth(PKCE) を開始し、取得した refresh token を mycmux 側に暗号化保存して自動リフレッシュする。

---

## 0. 前提と現状把握

### 既存実装 (単一アカウント版は稼働済み)

今回はゼロからではなく、既存の usage 監視機構の拡張になる。

| レイヤ | ファイル | 現状 |
|---|---|---|
| Rust: usage 取得 | `src-tauri/src/usage/oauth_claude.rs` | `fetch()` が `~/.claude/.credentials.json` を固定パスで読み、`GET https://api.anthropic.com/api/oauth/usage` を叩く。`claudeAiOauth.accessToken` を使用、`expiresAt` で失効チェックのみ (リフレッシュはしない) |
| Rust: usage 取得 (Codex) | `src-tauri/src/usage/oauth_codex.rs` | 同様に Codex 用 |
| Rust: 型 | `src-tauri/src/usage/mod.rs` | `WindowStat { pct, resets_at }` / `UsageSummary { claude_5h, claude_7d, ... }` |
| Rust: command | `src-tauri/src/commands/usage.rs` | `get_usage_summary()` (async・引数なし)。Claude と Codex を `tokio::join!` で並行取得 |
| command 登録 | `src-tauri/src/lib.rs:263` | `commands::usage::get_usage_summary` |
| フロント: store | `src/stores/usageStore.ts` | `useUsageStore` (zustand)、`fetch()` が invoke |
| フロント: UI | `src/components/layout/UsageMeter.tsx` | タイトルバー右の常駐メーター。60秒ごと `fetch()`。`full`/`compact`/`hidden` をウィンドウ幅で自動切替 |
| フロント: UI | `src/components/layout/UsagePopover.tsx` | ホバー詳細 |
| マウント | `src/components/layout/TitleBar.tsx:230` | `<UsageMeter />` |
| CSS 変数 | `src/global.css:29-31, 551` | `--cmux-usage-ok/warn/danger` + `@keyframes cmux-usage-pulse` |

### 現状の認証取り回し

現状は mycmux 自身はトークンを**保存していない**。`claude` CLI が管理する `~/.claude/.credentials.json` (`claudeAiOauth.{accessToken, refreshToken, expiresAt, refreshTokenExpiresAt, scopes, subscriptionType, rateLimitTier}`) を都度読むだけ。失効時は「Run `claude` to re-authenticate」を返すのみ。

### usage エンドポイントの仕様 (確認済み)

- `GET https://api.anthropic.com/api/oauth/usage`
- ヘッダ: `Authorization: Bearer <token>` / `anthropic-beta: oauth-2025-04-20` / `User-Agent: claude-code/<version>` (**これが無いと 429 が続く**) / `Content-Type: application/json`
- レスポンス: `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` それぞれ `{ utilization: 0-100, resets_at: ISO8601 }`。null あり。
- レート制限は**アクセストークン単位**。同一アカウントをどのデバイスから叩いても同じ値 (サーバー側集計)。

---

## ⚠ 1. リスクと制約 (実装前に必読)

### ToS リスク (最重要)

- **2026年2月、Anthropic は「Pro/Max の OAuth トークンを Claude Code / claude.ai 以外のツールで使うのは Consumer ToS 違反」と明文化**した。Agent SDK 経由も含む。
- 2026年1月から「Claude Code ハーネスなりすまし」の検知をバックエンドで強化、4月4日以降さらに強化。検知手法は「本物のハーネスが送るはずのテレメトリの欠如・不自然なトラフィックパターン」。**User-Agent 偽装だけでは回避しきれない可能性が高い**。なりすまし検知でのアカウント停止報告も実在。
- 公式の Admin Usage API (`/v1/organizations/rate_limits`, `/v1/organizations/usage_report/messages`) は **Admin API キー必須 = 組織アカウント専用**。個人 Pro/Max では使えない (「The Admin API is unavailable for individual accounts」と明記)。
- **「使用量 read だけならセーフ」という明文の例外は見つからなかった。** グレーゾーンとして扱う。

**判断**: 既存の単一版 UsageMeter が既にこのグレーゾーンに片足を入れている。マルチアカウント化はそれを増幅する。この設計書は技術的に実現可能な形を示すが、**リスク受容は宮崎さんの判断前提**。緩和策 (下記) を必ず組み込む。

### 緩和策 (実装必須)

1. **User-Agent は `claude-code/<version>` に固定**、ポーリング間隔は**アカウントあたり 180秒以上**を厳守 (60秒はやめる)。複数アカウントを同時に叩かず、少し間隔をずらす。
2. **read only に徹する** — このツールは usage エンドポイントしか叩かない。推論 API (`/v1/messages`) には一切触れない。
3. 429/失効時は**バックオフして静かに劣化**する。リトライ嵐でトラフィックパターンを悪目立ちさせない。
4. アカウント停止のリスクは個人利用規模でも残る旨を Settings UI に注記する。

### エンドポイント未確定 (Phase 0 のブロッカー)

OAuth の authorize / token エンドポイントの**正確なホストが未確定**。調査で出典間の食い違いを確認した:
- authorize: `https://console.anthropic.com/oauth/authorize` 説 と `https://claude.ai/oauth/authorize` 説
- token: `https://console.anthropic.com/v1/oauth/token` 説 と `https://claude.ai/v1/oauth/token` 説

いずれも非公式リバースエンジニアリング。**Phase 0 で現物確定してから Phase 1 に進む** (下記)。

---

## 2. 全体アーキテクチャ

```
[Settings UI]「+ アカウント追加」
   │
   ▼
[Rust] oauth_login command
   │  1. PKCE (verifier/challenge/state) 生成
   │  2. authorize URL を組み立て tauri-plugin-shell で既定ブラウザを開く
   │  3. コールバック受信 (方式は Phase 0 で確定 — localhost リスナー or 手動コード貼付)
   │  4. token エンドポイントに交換 POST → access/refresh token 取得
   │  5. プロフィール取得でアカウント識別名を確定
   ▼
[Token Store] 暗号化して保存 (Windows DPAPI 経由)
   │  account_id → { access_token, refresh_token, expires_at, label }
   ▼
[Rust] get_multi_usage command (60→180秒ごとにフロントから)
   │  各 account:
   │    - expires_at 近接なら refresh_token でトークン更新 → Store 書き戻し
   │    - GET /api/oauth/usage を Bearer で叩く (User-Agent 固定)
   │  → Vec<AccountUsage> を返す
   ▼
[UI] UsageMeter (アカウント配列でループ) + UsagePopover (アカウントごとにセクション)
```

---

## 3. Phase 別実装計画

### Phase 0: OAuth エンドポイント現物確定 (ブロッカー・宮崎さん or 母艦)

- 目的: authorize/token ホスト・redirect 方式・レスポンス形を**現物で**確定する。推測で Phase 1 を書かない。
- 手段 (いずれか):
  - (a) `claude` CLI のログイン (`claude` 初回認証 or `/login`) 実行中の HTTPS 通信をキャプチャ (Fiddler/mitmproxy)。mycmux 既存の usage 実装と同じ「公式ハーネスの動きを再現」する原則に沿う。
  - (b) 稼働中の第三者実装 (opencode-claude-auth 等) のソースで authorize URL・token endpoint・redirect_uri・PKCE パラメータを確定し、実際に 1 アカウントで通ることを確認。
- 確定すべき項目:
  - client_id (候補: `9d1c250a-e61b-44d9-88ed-5944d1962f5e` = Claude Code 公式流用)
  - scope (候補: `org:create_api_key user:profile user:inference`)
  - authorize host / path、token host / path
  - redirect_uri 方式: **localhost callback か、認証後コード手動貼付 (out-of-band) か**。mycmux には localhost リスナーの前例が無い (socket.rs / remote は用途別)。**手動コード貼付なら実装が大幅に単純化する**ので、CLI がそちらを許すなら第一候補。
  - token レスポンスのキー名 (`access_token`/`refresh_token`/`expires_in`/`expires_at`)
- 完了条件: 1 アカウントで「ブラウザ認証 → token 取得 → usage 取得」が手動でも通る cURL/スクリプトを1本残す。

### Phase 1: OAuth ログインフロー (Rust)

- 新モジュール `src-tauri/src/usage/oauth_login.rs`:
  - `generate_pkce()` — verifier (32B 乱数 → base64url)、challenge (SHA-256 → base64url)、state。
  - `build_authorize_url(pkce) -> String`。
  - `exchange_code(code, verifier) -> TokenSet` — token エンドポイントへ POST。`reqwest` 既存依存 (`Cargo.toml:27`) を使用。
  - `fetch_profile(access_token) -> AccountIdentity` — アカウント識別名 (メール/表示名) を取得しラベル化。
- redirect 方式が **手動コード貼付**の場合:
  - command `start_oauth_login() -> { authorize_url }` を返し、フロントが `open(authorize_url)` (tauri-plugin-shell、`XTermWrapper.tsx:8` に既存 import パターンあり) でブラウザを開く。
  - Settings UI にコード入力欄を出し、command `complete_oauth_login(code) -> AccountIdentity` で交換。
- redirect 方式が **localhost callback** の場合:
  - `start_oauth_login()` 内で `TcpListener::bind("127.0.0.1:0")` (socket.rs:164 に前例あり) を一時起動し、`?code=...&state=...` を1回受けて即クローズ。受信後に自動で交換まで進める。
  - こちらは前例が薄いので Phase 0 で手動貼付が可能なら回避する。
- 検証: `cargo test` で PKCE 生成の単体テスト (challenge が verifier の SHA-256 base64url であること)。

### Phase 2: トークン保存 + 自動リフレッシュ (Rust)

- **秘匿情報の平文保存は避ける。** refresh token は長期有効。`data.json` は平文なので**そのままは NG**。
- 保存方式の選択 (推奨順):
  1. **Windows DPAPI (`CryptProtectData`/`CryptUnprotectData`) で暗号化**して専用ファイル `%APPDATA%/com.miyazaki.mycmux/accounts.enc` に保存。`keyring` クレート (Windows は Credential Manager を使う) を足すのが最短。mycmux は現状 keyring/stronghold 依存が**無い** (`Cargo.toml` に無し) ので新規追加。
  2. tauri-plugin-stronghold (オーバースペック気味)。
  3. `claude` CLI と同じ `.credentials.json` 形式で `~/.claude-acctN/` に書く (公式フォーマット再利用・CLI とも相互運用可)。ただし平文回避にはならない。
- 推奨: **`keyring` クレート**。account ごとに1エントリ (`service="mycmux-usage", account=<account_id>`)、値は TokenSet の JSON。data.json にはアカウントの**メタ情報のみ** (account_id, label, 有効/無効フラグ) を保存し、`AppSettings` (`storage.rs:153-192`) に `usage_accounts: Vec<UsageAccountMeta>` を追加。
- 自動リフレッシュ:
  - `ensure_fresh_token(account_id) -> access_token` — `expires_at` の残り < 5分なら refresh_token で更新し Store に書き戻す。
  - refresh 失敗 (refresh token 失効) 時は当該アカウントを「要再認証」状態にし、UI にバッジ表示。
- 検証: `cargo test` で「期限切れ判定」「メタ情報の serde round-trip」。keyring は実機依存なので手動確認。

### Phase 3: マルチアカウント usage 取得 (Rust)

- `oauth_claude.rs::fetch()` を **`fetch_with_token(access_token: &str)`** にリファクタ (固定パス読みを剥がす)。既存の単一版は「既定アカウント = `~/.claude/.credentials.json`」として温存し後方互換を保つ。
- 新 command `src-tauri/src/commands/usage.rs::get_multi_usage()`:
  - `AppSettings.usage_accounts` を列挙。
  - 各 account: `ensure_fresh_token` → `fetch_with_token`。**同時全叩きを避け、100-200ms ずつずらす**か低並列 (2) で。
  - 返り値 `Vec<AccountUsage { account_id, label, kind: Claude|Codex, summary: UsageSummary, error: Option<String> }>`。
  - `#[tauri::command] pub async fn` にする → **`tests/test_command_sync_contract.py` の SYNC_ALLOWLIST 更新は不要** (async のため)。
- command 登録: `lib.rs:222-289` の `invoke_handler` に追加、`commands/mod.rs` は既存 `pub mod usage;` のまま。
- 既存 `get_usage_summary` は当面残し (単一版 UI が使用中)、UI 切替後に整理。
- 検証: `cargo test` / `npx tsc --noEmit` / `python -m pytest tests/` (sync 契約) / `npx vitest run`。

### Phase 4: UI 拡張 (React)

- `usageStore.ts`: `summary: UsageSummary` → `accounts: AccountUsage[]` に拡張 (単一版は `accounts[0]` 互換ビューを残す)。ポーリング間隔を **60_000 → 180_000** に変更 (`UsageMeter.tsx:18`)。
- `UsageMeter.tsx`: `FullMeter`/`CompactMeter` をアカウント配列でループ。ラベルは `CC:acctA 5h` のように account label を前置。危険域 (>=95%) のアカウントを優先表示、狭幅時は最悪値のみ compact 表示。
- `UsagePopover.tsx`: `UsageSection` をアカウント数だけ繰り返し。「要再認証」バッジ + 「再認証」ボタン (Phase 1 の login command 呼び出し)。
- `SettingsMenu.tsx` (757行): 「Usage アカウント」セクション新設 (`CrsmPaletteSection` (699行) の独立コンポーネント切り出しパターンに倣う)。「+ アカウント追加」(OAuth 開始)、一覧、削除、有効/無効トグル、ToS 注記。
- 検証: `npx tsc --noEmit` / `npx vitest run` / 実機で 2 アカウント表示確認。

### Phase 5: 統合検証・ビルド

- 全検証コマンド (CLAUDE.md 準拠): `npx tsc --noEmit` / `npx vitest run` / `cd src-tauri && cargo test --release` / `python -m pytest tests/`。
- `npm run tauri build` (cargo build 単体は壊れた exe になるので厳禁)。
- deploy は外部 PowerShell から `~/deploy-mycmux-v2.ps1`。
- 実機: 2 アカウントで 180秒ポーリング・失効→自動リフレッシュ・要再認証バッジ→再認証を確認。
- push/tag/Release は宮崎さん判断 (既定は止める)。

---

## 4. 変更ファイル一覧 (見積の基礎)

| ファイル | 種別 | 概要 |
|---|---|---|
| `src-tauri/src/usage/oauth_login.rs` | 新規 | PKCE・authorize URL・code 交換・profile 取得 |
| `src-tauri/src/usage/token_store.rs` | 新規 | keyring 経由の暗号化保存・ensure_fresh_token |
| `src-tauri/src/usage/oauth_claude.rs` | 改修 | `fetch()` → `fetch_with_token()` に分離 |
| `src-tauri/src/usage/mod.rs` | 改修 | `AccountUsage` 型追加、`pub mod oauth_login; pub mod token_store;` |
| `src-tauri/src/commands/usage.rs` | 改修 | `get_multi_usage` / `start_oauth_login` / `complete_oauth_login` / `remove_usage_account` |
| `src-tauri/src/lib.rs` | 改修 | invoke_handler に新 command 登録 |
| `src-tauri/src/db/storage.rs` | 改修 | `AppSettings.usage_accounts: Vec<UsageAccountMeta>` 追加 |
| `src-tauri/Cargo.toml` | 改修 | `keyring` (+ 必要なら `sha2`/`base64`/`rand`) 依存追加 |
| `src/stores/usageStore.ts` | 改修 | `accounts[]` 化、間隔 180s |
| `src/lib/ipc.ts` | 改修 | 新 command ラッパー |
| `src/components/layout/UsageMeter.tsx` | 改修 | アカウント配列ループ |
| `src/components/layout/UsagePopover.tsx` | 改修 | アカウントごとセクション + 再認証 |
| `src/components/layout/SettingsMenu.tsx` | 改修 | Usage アカウント管理セクション |

## 5. 工数見積 (粗い)

| Phase | 内容 | 目安 |
|---|---|---|
| 0 | エンドポイント現物確定 | 0.5〜1日 (キャプチャ環境しだい) |
| 1 | OAuth ログイン (Rust) | 1〜1.5日 |
| 2 | トークン保存 + 自動リフレッシュ | 1日 |
| 3 | マルチ usage 取得 (Rust) | 0.5日 |
| 4 | UI 拡張 | 1〜1.5日 |
| 5 | 統合検証・ビルド・実機 | 0.5日 |

Phase 0 が最大のリスク。ここで手動貼付方式が使えると分かれば Phase 1 が半減する。

## 6. 委譲方針 (母艦=司令塔)

- Phase 0: 母艦 (キャプチャ・確定) — 判断が絡むので直轄。
- Phase 1-3 (Rust 実装): **Codex (gpt-5.5/high)** — 新規100行超・3ファイル超に該当。spec は本設計書 + Phase 0 の確定結果を接続先として渡す。
- Phase 4 (UI): **Sonnet サブエージェント** or Codex。既存 UsageMeter を接続先に直読みさせる。
- 検証 (tsc/vitest/cargo/pytest): 母艦が独立実行してからコミット (既存 mycmux 運用と同じ)。

## 7. 代替案 (却下したが記録)

- **CLAUDE_CONFIG_DIR プロファイル方式** (認証を claude CLI に任せ、mycmux は複数パスを読むだけ): ToS リスク最小・既存アーキと最も親和的だったが、宮崎さんの「mycmux 内で認証を完結して保存」の要望に対し、認証が CLI 依存で mycmux 内完結にならないため今回は不採用。将来 ToS 懸念が高まった場合のフォールバック先として有効。
