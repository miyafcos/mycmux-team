# mycmux-lite

`mycmux-lite` は、チーム配布向けの軽量版ターミナルワークスペースです。Tauri v2 + React + xterm.js で動き、Claude Code / Codex / claude-codex をワークスペース、ペイン、タブ単位で並べて使えます。

公開配布先: <https://github.com/miyafcos/mycmux-team>

## 通常版との違い

lite では、チーム配布前に不安定だった機能を外しています。

- ファイルエクスプローラーサイドバー
- Ctrl+P パスジャンパー
- AI Buddy ウィジェット

ターミナル、ワークスペース、ペイン分割、タブ移動、セッション復元は使えます。

## インストール

lite の最新配布版は `v0.3.4-lite.2` です。Windows では Releases から `mycmux-lite_*_x64-setup.exe` をダウンロードして実行します。

```powershell
gh release download v0.3.4-lite.2 --repo miyafcos/mycmux-team --pattern "mycmux-lite_*_x64-setup.exe"
```

SmartScreen が出る場合は「詳細情報」から実行してください。現在の配布物は Authenticode 署名なしです。

ソースから起動する場合:

```powershell
git clone https://github.com/miyafcos/mycmux-team.git
cd mycmux-team
npm install
npm run tauri dev
```

## 最初の使い方

新しいペインやタブを開くと、Launch メニューが出ます。

| 番号 | 起動候補 | 用途 |
| --- | --- | --- |
| 1 | Claude Code | Claude Code を新規起動 |
| 2 | Claude Code (resume) | Claude Code の既存セッションを再開 |
| 3 | Claude Code (dangerous) | `claude --dangerously-skip-permissions` で起動 |
| 4 | Codex | Codex を新規起動 |
| 5 | Codex (resume) | Codex の既存セッションを再開 |
| 6 | Codex (dangerous) | `codex --dangerously-bypass-approvals-and-sandbox` で起動 |
| 7 | claude-codex | claude-codex を新規起動 |
| 8 | claude-codex (resume) | claude-codex の既存セッションを再開 |
| 9 | Custom... | 任意コマンドを入力 |

dangerous は承認やサンドボックスを弱める起動方法です。通常作業は 1 / 2 / 4 / 5 / 7 / 8 を使ってください。

## ワークスペース、ペイン、タブ

- ワークスペース: 左の一覧に並ぶ作業単位です。案件や作業テーマごとに分けます。
- ペイン: 画面分割された領域です。左右・上下に分割できます。
- タブ: 1つのペイン内に複数のターミナルを持てます。

タブやペインはドラッグできます。

- タブを別ペインへドラッグすると、そのペインへ移動します。
- タブをペイン中央へドロップすると、既存ペインのタブとして合流します。
- タブをペイン端へドロップすると、その方向に分割して移動します。
- タブやペインを左のワークスペース一覧へドラッグすると、別ワークスペースへ移動できます。
- 左下の `New workspace` へドロップすると、新しいワークスペースとして切り出せます。

## ショートカット

ショートカットは `Ctrl+,` から変更できます。

### 全体

| 操作 | ショートカット |
| --- | --- |
| サイドバー表示/非表示 | `Ctrl+B` |
| コマンドパレット | `Ctrl+Shift+P` |
| ショートカット設定 | `Ctrl+,` |

### ワークスペース移動

| 操作 | ショートカット |
| --- | --- |
| 新規ワークスペース | `Ctrl+Shift+N` |
| 次のワークスペース | `Ctrl+Tab` |
| 前のワークスペース | `Ctrl+Shift+Tab` |
| ワークスペース 1-8 へ移動 | `Ctrl+1` - `Ctrl+8` |
| 最後のワークスペースへ移動 | `Ctrl+9` |
| ワークスペースを閉じる | `Ctrl+Shift+W` |

ワークスペースを閉じるときは確認ダイアログが出ます。誤ってショートカットを押しても即削除されません。

### ペイン操作

| 操作 | ショートカット |
| --- | --- |
| 右に分割 | `Ctrl+Alt+D` |
| 下に分割 | `Ctrl+Alt+Shift+D` |
| アクティブペインを閉じる | `Ctrl+Alt+W` |
| 左/右/上/下のペインへフォーカス | `Ctrl+Alt+Arrow` |
| ペインを拡大/戻す | `Ctrl+Shift+Enter` |
| フォーカス中ペインを点滅表示 | `Ctrl+Shift+H` |

### ターミナル

| 操作 | ショートカット |
| --- | --- |
| ターミナル内検索 | `Ctrl+Shift+F` |

## セッション復元

アプリ終了後に再起動すると、ワークスペース、ペイン、タブ、作業ディレクトリ、直前のターミナル表示を復元します。Claude Code / Codex / claude-codex は保存済みのセッションIDがある場合、resume 起動を優先します。

復元できない場合でも、直前の会話表示と作業場所は残るため、その上から Launch メニューで再開できます。

## 開発

```powershell
npm install
cmd /c npx tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
cmd /c npm run tauri build
```

## ライセンス

GPL-3.0。詳しくは [LICENSE](LICENSE) を参照してください。
