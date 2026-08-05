# Deploy & Release Guide

mycmux のリリース・配布・自動更新の運用手順。

> **lite 版 (mycmux-lite) は 2026-07-23 に配布終了**。worktree `C:\Users\miyaz\cmux-for-linux-dev` (branch `release/public-lite`) も撤収済みで、追従・cherry-pick は不要。本書内の lite 節は歴史的記録として残している。

---

## ブランチとリポジトリの対応

| 配布物 | ブランチ | リポジトリ | 配布先 |
|---|---|---|---|
| **mycmux** (個人版) | `master` | `miyafcos/mycmux` (private) | 自分用、`C:\Users\miyaz\mycmux-app\` |
| ~~mycmux-lite (チーム版)~~ | ~~`release/public-lite`~~ | `miyafcos/mycmux-team` (public) | **配布終了 (2026-07-23)**。public repo は個人版の履歴分離ミラー + updater feed 置き場として継続 |

## バージョニング

- 個人版タグ: `vX.Y.Z` (semver pure、例 `v0.21.17`)
- lite タグ (`vX.Y.Z-lite.N`) は配布終了に伴い新規作成しない

`package.json` と `package-lock.json` と `src-tauri/Cargo.toml` と `src-tauri/tauri.conf.json` と `Cargo.lock` の `version` はタグ作成前に揃えること (`tests/test_version_consistency.py` が5面一致を強制する)。

## ローカルビルド

> **重要:** Smart App Control の制約上、ビルドは必ずこの worktree ディレクトリ内で実行する (別ディレクトリだとブロックされる)。

### 個人版 (master worktree)

```powershell
cd C:\Users\miyaz\cmux-for-linux-dev-master
powershell -ExecutionPolicy Bypass -File build-personal.ps1
```

`build-personal.ps1` が:
1. ブランチ `master` であることを確認
2. working tree clean を確認
3. MSVC 環境 (vcvarsall.bat x64) を読込
4. `npm run tauri build` を実行
5. 既存 `C:\Users\miyaz\mycmux-app\mycmux.exe` をタイムスタンプ付き `.bak-YYYYMMDD-HHmmss` でバックアップ
6. 新しい exe を配置

### lite (配布終了・歴史的記録)

lite worktree (`C:\Users\miyaz\cmux-for-linux-dev`) と `build-lite.ps1` の運用は 2026-07-23 に終了した。

## ローカルリリース経路 (Actions 非課金運用)

GitHub Actions を使わず、個人版のビルド・署名・GitHub Release 作成・公開 updater feed のミラーをローカルで一括実行する。`build-personal.ps1` はローカル配置用であり、このリリース経路とは別。

初回のみ、署名鍵のパスワードを Windows DPAPI で保存する。平文は保存されず、現在の Windows ユーザーと端末でのみ復号できる。
秘密管理サービス側の原本は残し、`C:\Users\miyaz\.tauri\mycmux-updater.pass` はローカル実行専用の DPAPI キャッシュとして扱う。

```powershell
cd C:\Users\miyaz\cmux-for-linux-dev-master
powershell -File scripts/release-local.ps1 -SetPassword
```

リリース時は次を実行する。バージョンは `package.json` から自動取得する。

```powershell
cd C:\Users\miyaz\cmux-for-linux-dev-master
powershell -File scripts/release-local.ps1
```

前提:

- ブランチが `master` で、追跡ファイルに未コミット変更がない
- `package.json` と `src-tauri\tauri.conf.json` の version が一致する
- 対象タグが現在の `HEAD` を指し、ローカルと `origin` で同じ commit に存在する
- `gh auth status` が成功し、`miyafcos/mycmux` と `miyafcos/mycmux-team` の両方へ push できる
- `C:\Users\miyaz\.tauri\mycmux-updater.key` が存在する

失敗時の確認:

- ガードで停止: ブランチ、追跡ファイルの差分、version、タグ、`gh` 認証・権限、署名鍵を確認
- 事前検証で停止: `npx tsc --noEmit`、`npx vitest run`、`python -m pytest tests/` を個別実行
- ビルドで停止: `src-tauri\target\release\bundle\nsis\` と `msi\` に installer と同名 `.sig` があるか確認
- Release またはミラーで停止: `miyafcos/mycmux` の対象 Release と `mycmux-personal-updater` 固定 feed を確認
- 設定復元で停止: `git diff -- src-tauri\tauri.conf.json` を確認。スクリプトは元のバイト列を `finally` で復元する

## GitHub Releases (手動 workflow)

### リリース手順

1. ブランチを最新化:
   ```powershell
   git checkout master
   git pull origin master
   ```
2. バージョン5面 (`package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `Cargo.lock`) を更新
3. `CHANGELOG.md` に新バージョンセクションを追加
4. commit:
   ```powershell
   git commit -am "chore: release v0.21.17"
   ```
5. tag を作成して push (tag push だけでは workflow は起動しない):
   ```powershell
   git tag v0.21.17
   git push origin v0.21.17
   ```
6. GitHub の Actions 画面から `release.yml` を `workflow_dispatch` で手動実行 (runner は `windows-latest` / `self-hosted` を選択) → test job (tsc / vitest / `run_windows_tests.py` / pytest) → Windows ビルド → 署名 → release 作成 → `latest.json` + `.exe` + `.exe.sig` を assets に upload
7. リリースを確認: https://github.com/miyafcos/mycmux/releases
8. 個人版は private repo の Release asset を Tauri updater が直接読めないため、署名済みアセットを public repo の固定 feed にミラーする:
   - feed tag: `mycmux-personal-updater`
   - endpoint: `https://github.com/miyafcos/mycmux-team/releases/download/mycmux-personal-updater/latest.json`
   - `latest.json` 内の download URL は `miyafcos/mycmux-team/releases/download/mycmux-personal-updater/...` に書き換える
   - release は `--prerelease --latest=false` にして、lite の `/releases/latest` を壊さない

### Updater 用 `latest.json` の URL

- 個人版: `https://github.com/miyafcos/mycmux-team/releases/download/mycmux-personal-updater/latest.json`
- lite (配布終了): `https://github.com/miyafcos/mycmux-team/releases/latest/download/latest.json`

private GitHub Release は標準 Tauri updater から認証なしで取得できない。個人版の source は private のまま、updater に必要な署名済み配布物だけを public fixed feed に置く。

## Tauri Updater 鍵管理

### 鍵ファイル

| 配布物 | 秘密鍵 | パスワード保管場所 |
|---|---|---|
| 個人版 | `C:\Users\miyaz\.tauri\mycmux-updater.key` | `C:\Users\miyaz\.tauri\mycmux-updater.pass` (DPAPI) |
| lite | `C:\Users\miyaz\.tauri\mycmux-lite-updater.key` | 1Password / Bitwarden |

個人版の鍵は 2026-07-31 に作り直した。旧鍵のパスフレーズが失われ、1Password にも見つからなかったため。
旧鍵は `mycmux-updater.key.old-20260731` / `mycmux-updater.key.pub.old-20260731` として同じディレクトリに残してある。

新しいパスフレーズはランダム生成した 40 文字で、人間が覚える前提ではない。DPAPI で暗号化して
`mycmux-updater.pass` に置いてあり、**この Windows ユーザーがこの端末でのみ**復号できる。
`release-local.ps1` が自動で読むので、リリース時にパスワードを入力する必要はない。

このため:

- 端末を移行・再セットアップするときは鍵とパスワードを両方持ち込むか、鍵を作り直して
  `tauri.conf.json` の `pubkey` を更新し、新版を1回だけ手動インストールする
- GitHub Secrets の `TAURI_KEY_PERSONAL` / `TAURI_KEY_PERSONAL_PASSWORD` は **2026-08-05 に現行鍵
  (key-id `bbf2382d7a0753cc`) へ更新済み**。7/31 の鍵ローテート時に secret だけ旧鍵
  (`edfd48df84ad2477`) のまま取り残され、8/5 の CI リリース (v0.21.16) が更新失敗になって発覚した経緯がある。
  secret を再設定するときは PowerShell のパイプを使わない (PS 5.1 が BOM を付けて CI の base64 decode が
  壊れる)。Bash から `printf '%s' "$(tr -d '\r\n' < ~/.tauri/mycmux-updater.key)" | gh secret set ...` で渡す
- リリース後の feed 検証は版数だけでは不十分。`latest.json` の signature をデコードして key-id が
  `tauri.conf.json` の `pubkey` と一致することまで確認する
- 0.21.2 以前をインストールしている端末は、旧公開鍵しか持たないので新版を更新ボタンでは受け取れない。
  0.21.3 以降を1回だけ手動インストールする必要がある

### GitHub Secrets

| repo | secret 名 |
|---|---|
| `miyafcos/mycmux` | `TAURI_KEY_PERSONAL`, `TAURI_KEY_PERSONAL_PASSWORD` (2026-08-05 現行鍵へ更新済み), `MYCMUX_TEAM_RELEASE_TOKEN` (mirror ステップ用) |
| `miyafcos/mycmux-team` | (lite 終了に伴い新規リリースでは未使用) |

### 鍵を失った場合

**Updater 鍵は失うと既存配布バージョンの自動更新が永続的に壊れる**。新規鍵で署名した release は古いユーザーには「署名検証エラー」で適用されず、手動再インストールが必要になる。

復旧手順:
1. 新鍵を生成: `npm run tauri -- signer generate --ci -p "<新パスワード>" -w "$HOME\.tauri\mycmux-updater.key" -f`
2. 公開鍵を `tauri.conf.json` の `pubkey` に書換 (両ブランチ別 endpoint で実施)
3. GitHub Secrets を新鍵に置換
4. 新バージョンを release
5. 既存ユーザーには「手動で新版を再インストールしてください」と告知

## 自動更新の動作確認

1. 現バージョン (例 `v0.3.0`) で起動 → Settings → 更新を確認 → 「最新版です」と表示
2. 新バージョン `v0.3.1` を release
3. 同じ起動中アプリで Settings → 更新を確認 → `v0.3.1 を取得中…` → ダウンロード → 自動再起動
4. 再起動後にバージョンが `v0.3.1` になっていることを確認

エラー時の確認:
- ネットワーク失敗 → endpoint URL を再確認
- 署名検証失敗 → `tauri.conf.json` の `pubkey` と CI で使った秘密鍵が対応しているか確認
- ダウンロード途中で中断 → 再度「更新を確認」を押す
- lite が個人版を見てしまう → `mycmux-team/releases/latest` を個人版に使っていないか確認。個人版は必ず `mycmux-personal-updater` 固定 tag を使う

## lite リリース前に必要な cherry-pick と workflow 追記 (改善プラン v3 S-3 — lite 配布終了により失効・歴史的記録)

master (`cmux-for-linux-dev-master`) では以下を実施済み:
- `scripts/normalize-updater-feed.ps1` を新設し、latest.json の plain `windows-x86_64` キーを `windows-x86_64-nsis` エントリの signature/url で上書きする正規化ロジックを括り出した (入力パス→出力パスの純関数的スクリプト)
- `scripts/mirror-personal-updater-feed.ps1` は上記スクリプトを呼ぶ形にリファクタ済み
- `.github/workflows/release.yml` (master) の `test` job (tsc/vitest/cargo test/pytest) と、Mirror ステップの secret 未設定時エラー可視化 (`::error::` + Step Summary + `continue-on-error: true`)

lite (`cmux-for-linux-dev` / `release/public-lite` worktree) は **別リポジトリ (`miyafcos/mycmux-team`) 向けの独自 workflow** を持つため、上記は自動反映されない。lite の次回リリース前に以下を実施すること:

1. master の該当コミットを lite worktree に cherry-pick する:
   ```powershell
   cd C:\Users\miyaz\cmux-for-linux-dev
   git cherry-pick <scripts/normalize-updater-feed.ps1 追加コミットのハッシュ>
   git cherry-pick <scripts/mirror-personal-updater-feed.ps1 リファクタコミットのハッシュ>
   ```
   master 専用シンボル (RemoteControl 等) を含むコミットとは競合しやすいので、`scripts/` 配下だけの変更であることを `git show --stat` で確認してから cherry-pick する。
2. lite の release workflow (`build-lite` job相当) に、tauri-action のビルド後・アップロード前の位置へ正規化ステップを追加する。lite は latest.json を直接 `miyafcos/mycmux-team` の `releases/latest` に出すため、mirror script 経由ではなく **ビルド直後に正規化してから upload** する形になる:
   ```yaml
   - name: Normalize updater feed (windows-x86_64 fallback key)
     shell: powershell
     run: |
       $latestJson = Get-ChildItem -Path . -Recurse -Filter "latest.json" | Select-Object -First 1
       if (-not $latestJson) { throw "latest.json not found after tauri build" }
       .\scripts\normalize-updater-feed.ps1 -InputPath $latestJson.FullName
   ```
   (実際の latest.json の出力パスは tauri-action のバンドル設定・ランナー環境に依存するため、導入時に `Get-ChildItem` の起点を実パスに合わせて調整すること。)
3. lite 側にも `test` job を追加し `build-lite` の `needs:` に含める (master の `test` job 定義をそのまま流用可能。Python セットアップ含め master と同一の pytest スイートを走らせる)。
4. 反映後、`tests/test_updater_feed_contract.py` と同等の契約テストが lite 側 CI でも `pytest tests/` 経由で走ることを確認する (このリポジトリの `tests/` は両 worktree で共有されるファイル群ではないため、lite worktree 側の `tests/` にも同じテストファイルが cherry-pick で反映されているか要確認)。

## ロールバック

| 状況 | 戻し方 |
|---|---|
| Phase 1 (CPU 修正) でリグレッション | `git reset --hard pre-cpu-fix-master-2026-04-23` (master), `pre-cpu-fix-lite-2026-04-23` (lite) |
| 配布 exe が壊れた | `C:\Users\miyaz\mycmux-app\mycmux.exe.bak-YYYYMMDD-HHmmss` から復元 |
| Release が壊れた | `gh release delete v0.3.1 --repo miyafcos/mycmux` → tag も削除 → 古い release が再び `latest` |

## 参考プラン

- 安定化プラン全体: `.claude/plans/1e57cfe-initial-witty-marble.md`
- CPU 観測ベースライン: `.claude/plans/mycmux-cpu-investigation-baseline.md`
