# Deploy & Release Guide

mycmux と mycmux-lite の リリース・配布・自動更新の運用手順。

---

## ブランチとリポジトリの対応

| 配布物 | ブランチ | リポジトリ | 配布先 |
|---|---|---|---|
| **mycmux** (個人版) | `master` | `miyafcos/mycmux` (private) | 自分用、`C:\Users\miyaz\mycmux-app\` |
| **mycmux-lite** (チーム版) | `release/public-lite` | `miyafcos/mycmux-team` (public) | チーム配布、`C:\Users\miyaz\mycmux-lite-app\` |

両者は Bundle ID / config dir / localStorage key / インストールパスが完全分離されているので **同一 Windows 上で並行起動可能**。

## バージョニング

- 個人版タグ: `vX.Y.Z` (semver pure、例 `v0.3.0`, `v0.3.1`)
- lite タグ: `vX.Y.Z-lite.N` (例 `v0.3.0-lite.1`, `v0.3.0-lite.2`)
- `release.yml` workflow は tag 名で job を分岐 (`build-personal` / `build-lite`)。

`package.json` と `src-tauri/Cargo.toml` と `src-tauri/tauri.conf.json` の `version` フィールドはタグ作成前に書き換えること。tag に `-lite.` 接尾辞があっても `tauri.conf.json` の `version` は `"0.3.0"` のような semver の本体だけにする (Tauri Updater がここを比較するため)。

## ローカルビルド

### 個人版

```powershell
cd C:\Users\miyaz\cmux-for-linux-dev
git checkout master
powershell -ExecutionPolicy Bypass -File build-personal.ps1
```

`build-personal.ps1` が:
1. ブランチ `master` であることを確認
2. working tree clean を確認
3. MSVC 環境 (vcvarsall.bat x64) を読込
4. `npm run tauri build` を実行
5. 既存 `C:\Users\miyaz\mycmux-app\mycmux.exe` をタイムスタンプ付き `.bak-YYYYMMDD-HHmmss` でバックアップ
6. 新しい exe を配置

### lite

```powershell
cd C:\Users\miyaz\cmux-for-linux-dev
git checkout release/public-lite
powershell -ExecutionPolicy Bypass -File build-lite.ps1
```

`build-lite.ps1` は同等動作で:
- 出力 exe 名 = `mycmux-lite.exe`
- 配布先 = `C:\Users\miyaz\mycmux-lite-app\`
- NSIS / MSI / `latest.json` などの配布アセットがあれば `dist-uploads/` に集約

## GitHub Releases (自動)

### リリース手順

1. ブランチを最新化:
   ```powershell
   git checkout master  # or release/public-lite
   git pull origin master
   ```
2. `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` の `version` を更新
3. `CHANGELOG.md` (個人版) または `CHANGELOG-lite.md` (lite) に新バージョンセクションを追加
4. commit:
   ```powershell
   git commit -am "chore: release v0.3.1"
   ```
5. tag を作成して push:
   ```powershell
   git tag v0.3.1                  # 個人版
   # または
   git tag v0.3.0-lite.2            # lite
   git push origin v0.3.1
   ```
6. GitHub Actions が自動で `release.yml` を実行 → Windows ビルド → 署名 → release 作成 → `latest.json` + `.exe` + `.exe.sig` を assets に upload
7. リリースを確認:
   - 個人版: https://github.com/miyafcos/mycmux/releases
   - lite: https://github.com/miyafcos/mycmux-team/releases

### Updater 用 `latest.json` の URL

- 個人版: `https://github.com/miyafcos/mycmux/releases/latest/download/latest.json`
- lite: `https://github.com/miyafcos/mycmux-team/releases/latest/download/latest.json`

private リポジトリでも Releases assets は公開ダウンロード可能なので、認証なしで取得できる。

## Tauri Updater 鍵管理

### 鍵ファイル

| 配布物 | 秘密鍵 | パスワード保管場所 |
|---|---|---|
| 個人版 | `C:\Users\miyaz\.tauri\mycmux-updater.key` | 1Password / Bitwarden |
| lite | `C:\Users\miyaz\.tauri\mycmux-lite-updater.key` | 1Password / Bitwarden |

### GitHub Secrets

| repo | secret 名 |
|---|---|
| `miyafcos/mycmux` | `TAURI_KEY_PERSONAL`, `TAURI_KEY_PERSONAL_PASSWORD`, `TAURI_KEY_LITE`, `TAURI_KEY_LITE_PASSWORD` |
| `miyafcos/mycmux-team` | `TAURI_KEY_LITE`, `TAURI_KEY_LITE_PASSWORD` |

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

## ロールバック

| 状況 | 戻し方 |
|---|---|
| Phase 1 (CPU 修正) でリグレッション | `git reset --hard pre-cpu-fix-master-2026-04-23` (master), `pre-cpu-fix-lite-2026-04-23` (lite) |
| 配布 exe が壊れた | `C:\Users\miyaz\mycmux-app\mycmux.exe.bak-YYYYMMDD-HHmmss` から復元 |
| Release が壊れた | `gh release delete v0.3.1 --repo miyafcos/mycmux` → tag も削除 → 古い release が再び `latest` |

## 参考プラン

- 安定化プラン全体: `.claude/plans/1e57cfe-initial-witty-marble.md`
- CPU 観測ベースライン: `.claude/plans/mycmux-cpu-investigation-baseline.md`
