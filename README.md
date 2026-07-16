# mycmux

> Source note: this is the full `mycmux.exe` source tree. Edit `C:\Users\miyaz\cmux-for-linux-dev-master` when changing `C:\Users\miyaz\mycmux-app\mycmux.exe`. Do not use `C:\Users\miyaz\cmux-for-linux-dev` for full app changes; that worktree is for `mycmux-lite`.

AI エージェント用のターミナルワークスペースです。Claude Code / Codex / claude-codex を、ワークスペース、ペイン、タブ単位で並べて扱えます。

通常版の mycmux は、チーム向け lite 版に加えて、ファイルサイドバー、パスジャンプ、Claude Buddy、セーブポイント、マルチアカウント usage 監視などの個人作業向け機能を含みます。

公開配布先: <https://github.com/miyafcos/mycmux-team>

![mycmux 実機スクリーンショット](docs/images/mycmux-screenshot.png)

スクリーンショット内の端末本文と作業名は、公開用のサンプル表示に差し替えています。

## 画面の見方

| 番号 | 場所 | できること |
| --- | --- | --- |
| 1 | Workspaces | 案件、調査、実装などの単位で作業場所を切り替える |
| 2 | Split panes | Codex、Claude Code、ログ確認などを横に並べて見る |
| 3 | Active pane | 今操作しているペインを見分け、`Ctrl+Shift+Enter` で拡大する |
| 4 | Review / notes | 差分、メモ、別エージェントの出力を同時に確認する |
| 5 | Theme background | 背景画像やテーマを切り替えて、長時間作業しやすくする |

## 何ができるか

- 複数の Claude Code / Codex セッションを、1つの画面に並べて見る
- 作業テーマごとにワークスペースを分け、ペインやタブをドラッグで移動する
- `Ctrl+Shift+Enter` で今見たいペインだけを拡大する
- Claude Code / Codex セッションをローカルの「セーブポイント」として残し、必要な1件だけファイルで人へ渡す
- ペイン内のエージェントに「続きは Codex で」と頼むと、エージェント自身が引き継ぎ書つきの新しいペインを画面上に開く (v0.14.17)
  - エージェント側にこの動きをさせるためのルール規約は [docs/agent-integration.md](docs/agent-integration.md) (委譲は可視タブで行う契約の正本)
- 複数の Claude Pro/Max アカウントの使用量を、タイトルバーで一元監視する
- 誤って閉じたペインを `Ctrl+Shift+T` でセッションごと再オープンする
- Codex の Markdown 表を崩れにくく表示し、ログや回答を読みやすくする
- フォント、テーマ、背景画像を切り替えて、長時間作業しやすい見た目にする
- 右サイドバーで作業フォルダを見ながら、必要なファイルへ移動する
- Claude Buddy を画面端に置き、作業中の状態を軽く把握する

## 使い方の流れ

1. `Ctrl+Shift+N` でワークスペースを作ります。案件、調査、実装などの単位で分けます。
2. 新しいペインやタブを開くと Launch メニューが出ます。Claude Code、Codex、resume 起動、任意コマンドを選べます。
3. `Ctrl+Alt+D` で右分割、`Ctrl+Alt+Shift+D` で下分割。複数のエージェントを同時に見られます。
4. タブをドラッグすると、別ペインへの移動、ペイン端への分割、別ワークスペースへの移動ができます。
5. 1つのペインに集中したいときは `Ctrl+Shift+Enter` で拡大します。背景は通常表示と連続して見えます。
6. Settings から Themes を開くと、フォント、色、背景プリセット、背景画像を調整できます。

## Launch メニュー

| 番号 | 起動候補 | 用途 |
| --- | --- | --- |
| 1 | Claude Code | Claude Code を新規起動 |
| 2 | Codex | Codex を新規起動 |
| 3 | claude-codex | claude-codex を新規起動 |
| 4 | Claude Code (dangerous) | `claude --dangerously-skip-permissions` で起動 |
| 5 | Codex (dangerous) | `codex --dangerously-bypass-approvals-and-sandbox` で起動 |
| 6 | claude-codex (dangerous) | claude-codex を permission bypass で起動 |
| 7 | Claude Code (resume) | Claude Code の直前セッションを再開 |
| 8 | Codex (resume) | Codex の直前セッションを再開 |
| 9 | claude-codex (resume) | claude-codex の直前セッションを再開 |
| 10 | Resume (pick session) | crsm 連携のセッションピッカーで過去セッションを選んで再開 |
| 11 | Codex (Fugu Ultra) | Codex を `fugu-ultra` プロファイルで起動 |
| 12 | claude-codex (Fugu) | claude-codex を fugu バックエンドで起動 |
| 13 | Custom... | 任意コマンドを入力 |
| 14 | Change directory (開発)... | 開発系の起動ルート一覧から作業ディレクトリを変更 |
| 15 | Change directory (案件)... | 案件系の起動ルート一覧から作業ディレクトリを変更 |

操作はキーボード専用です。`↑↓` で移動、`Enter` か数字キーで決定、`d` で開発 dir、`a` で案件 dir、`/` で custom、`Esc`/`q` でそのままシェルに入ります。

dangerous は承認やサンドボックスを弱める起動方法です。通常作業では dangerous 以外を使ってください。

Codex は `--no-alt-screen` 付きで起動します。ターミナルのスクロール履歴を残し、入力欄表示のちらつきや復元時の表示崩れを抑えるためです。

起動ルート一覧は `~/.mycmux/launch-roots.txt` で管理します。メニューを自分用に拡張したい場合は `~/.mycmux/bin/launcher.local.sh` / `launcher.local.ps1` に書くと、アプリ更新で上書きされずに残ります。

## セーブポイント (通常版のみ)

Claude Code / Codex の作業途中や終了時の状態を、このPCのローカル領域へ「セーブポイント」として保存します。普段は個人利用の履歴として扱い、人へ渡したいときだけ選んだ1件を `.mycmux-transfer` ファイルにします。共有フォルダ、期限付きリンク、受信コードは使いません。

### 保存する側

- Claude Code タブのタブバーにあるしおりボタンを押すと、サマリ1行 (空欄なら自動生成) を確認して保存できます
- 進捗は「履歴要約 → 引き継ぎ書生成 → バンドル作成 → 登録」の4ステップで表示されます
- **作業途中**は同じセッションの引き継ぎ記録を上書き更新します。**終了時**は変更しない区切りの記録として残します
- セーブポイント一覧の「このPCの作業」からも保存・上書き更新できます。会話履歴があれば未起動のペイン (復元候補) からも保存可能です
- 一覧でカードを開いて「人に渡す」を押すか、カードを持ち上げたときだけ現れる「人に渡す」トレイへドロップすると、受け渡しファイルを1つ作れます

### 引き継ぐ側

タイトルバーのしおりボタン、または設定 (⚙) →「セーブポイント」→「セーブポイントを開く」から一覧を開けます。受け渡しファイルは一覧の「受け取る」から選ぶか、mycmuxの画面へドロップするだけで取り込めます。同じファイルを再度取り込んでも重複しません。

取り込んだカードには「受信」バッジが付きます。カードを選ぶと次の2つのモードで新しいペインを開けます。

- **要約から開始** (既定) — 新規セッションに引き継ぎ書 (handoff.md) を読ませて続きから作業
- **完全再開** — トランスクリプトを自機に配置し、会話の全記憶つきの派生セッション (`--fork-session`) として再開。元のセッションには影響しません

エントリは最終更新から48時間でローカルのゴミ箱へ移動します (ピン留めで延長)。受け渡しファイルには会話履歴と引き継ぎ書だけを含み、作業フォルダ全体は含みません。受信側に元の作業パスがなければ警告を表示し、勝手に別の共有フォルダへ接続しません。

## エージェントからペインを立ち上げる (通常版のみ)

v0.14.17 から、ペインの中で動いている Claude Code / Codex が、mycmux に「新しいペインを開いて」と命令できるようになりました。

「この続きの実装は Codex にやらせたい」というとき、これまではセッション要約を人間がコピーして新しいペインに貼り付けるか、エージェントが裏で別プロセスを起動して見えないまま作業させるかの二択でした。この機能を使うと、エージェント自身が引き継ぎ書を書き、目に見える新ペインを右分割で開いて、そこで相手のエージェントを起動するところまで進みます。作業は画面上のペインとして動くので途中経過を目で追えますし、そのペインをいつでも人間が直接引き継げます。

### 仕組み

mycmux は起動時に 127.0.0.1 のランダムポートで待ち受け、ポート番号を `~/.mycmux/mycmux.port` に書き出します。同梱の CLI (`scripts/mycmux_agent_cli.py`、Python 標準ライブラリのみで動作) がこのポートに JSON を1行送り、mycmux 側がペイン操作を実行して結果の JSON を返します。待ち受けはループバック限定で、外部ネットワークからは接続できません。

| サブコマンド | ソケットコマンド | 動き |
| --- | --- | --- |
| `workspaces` | `workspace.list` | ワークスペース一覧を返す |
| `panes` | `pane.list` | ペイン一覧を返す (`send` / `read` に使う sessionId の確認用) |
| `spawn` | `pane.spawn_tab` / `pane.spawn` | エージェントを立ち上げる。**既定は呼び出し元ペインの新タブへ、アクティブなタブを移動せずに起動** (`MYCMUX_PANE_SESSION_ID` から自動判定。呼び出し元との関係がタブ並びで見える)。`--activate` で新しいタブへ切り替える。`--split` (または `--direction` / `--anchor-pane` / `--workspace` 指定、ペイン外からの実行) で従来のペイン分割。戻り値に `paneId` / `sessionId` が入る |
| `send` | `pane.send_text` | 既存ペインの端末へ入力を送る (`--enter` で Enter 付き) |
| `read` | `pane.read` | 既存ペインの画面末尾を読む (既定80行、最大400行) |

### 使用例

```bash
# 今の作業ディレクトリで、指示書を読ませた Codex を開く (既定=呼び出し元ペインの新タブ、アクティブなタブは移動しない。切り替えるときは --activate)
python scripts/mycmux_agent_cli.py spawn --target codex \
  --prompt "docs/plans/xxx.md を読んで、残りの実装を進めてください"

# 新しい分割ペインとして開きたい場合
python scripts/mycmux_agent_cli.py spawn --target codex --split --prompt "..."

# 既存セッションの内容から引き継ぎ書を自動生成して渡す (セーブポイントと同じ CRSM handoff)
python scripts/mycmux_agent_cli.py spawn --target claude --handoff-from-session <セッションID>

# 過去セッションを resume で新ペインに開く
python scripts/mycmux_agent_cli.py spawn --target codex --resume-session <セッションID>

# 立ち上げたペインの画面を読む / 追加の指示を打ち込む
python scripts/mycmux_agent_cli.py read --session <sessionId> --lines 80
python scripts/mycmux_agent_cli.py send --session <sessionId> --text "テストも書いて" --enter
```

`spawn` の起動モードは4つあり、上から優先されます。

1. `--handoff-from-session` : 既存セッションの履歴から引き継ぎ書を自動生成して開始
2. `--prompt` / `--prompt-file` : 指定した指示書を新ペインのエージェントに読ませて開始 (`--prompt` の本文は `~/.mycmux/agent-prompts/` に自動保存)
3. `--resume-session` : セッション ID を指定して resume 起動
4. 指定なし : エージェントを新規起動 (`--target shell` なら通常のシェル)

### 注意

- `send` は生の端末入力です。送り先を間違えると他の作業を壊すので、`panes` で対象の sessionId を確認してから使ってください
- 立ち上げに使う環境変数 (`MYCMUX_LAUNCH_TARGET` や `MYCMUX_HANDOFF_*`) は保存データに残らないようフィルタされます。アプリを再起動しても、過去の spawn が原因でエージェントが勝手に立ち上がることはありません

## Usage 監視 (通常版のみ)

複数の Claude Pro/Max アカウントの使用量をタイトルバーで一元監視できます。

- 各アカウントの 5時間・週次・Opus/Sonnet 消費率とリセット時刻を、消費の激しい順のチップで表示。詳細はホバーのポップオーバーで確認できます
- アカウント追加は設定 → 「Usage アカウント管理」からブラウザの OAuth (PKCE) 認証で行います。refresh token は Windows Credential Manager に暗号化保存され、期限が近づくと自動リフレッシュします
- 取得スコープは `user:profile` のみ (read-only)。推論 API には一切触れません
- refresh token が失効したアカウントは警告表示になり、再認証ボタンから復帰できます。429 (レート制限) 時は解除目安のカウントダウンを表示し、「認証をやり直す」から新しい認証フローを開始できます

> 使用量取得は Anthropic の非公式エンドポイントを利用します。複数アカウントの追加・自動取得により、規約上のリスク (アカウント制限・停止) がゼロではない旨を設定画面に明記しています。

## 通常版と lite 版

| 項目 | mycmux | mycmux-lite |
| --- | --- | --- |
| ワークスペース / ペイン / タブ | あり | あり |
| Claude Code / Codex / claude-codex 起動 | あり | あり |
| セッション復元 | あり | あり |
| テーマ / フォント / 背景設定 | あり | あり |
| ファイルサイドバー | あり | なし |
| パスジャンプ | あり | なし |
| Claude Buddy | あり | なし |
| セーブポイント | あり | なし |
| マルチアカウント usage 監視 | あり | なし |
| エージェントからのペイン立ち上げ (`pane.spawn`) | あり | なし |

lite 版はチーム配布向けに、作業の中心になるターミナル機能だけを残した構成です。

## インストール

### Windows

Releases から `mycmux_*_x64-setup.exe` をダウンロードして実行します。

```powershell
gh release download --repo miyafcos/mycmux-team --pattern "mycmux_*_x64-setup.exe"
```

SmartScreen が出る場合は「詳細情報」から実行してください。現在の配布物は Authenticode 署名なしです。

ソースから起動する場合:

```powershell
git clone https://github.com/miyafcos/mycmux-team.git
cd mycmux-team
npm install
npm run tauri dev
```

### macOS (ソースビルド)

macOS 向けの公式 release バイナリは現状ありません。ソースから `.app` を作って `/Applications` に置く運用です。Apple Silicon (arm64) を想定。

前提:
- Xcode Command Line Tools (`xcode-select --install`)
- Rust (rustup) と Node.js / npm

```bash
git clone https://github.com/miyafcos/mycmux.git ~/dev/mycmux
cd ~/dev/mycmux
npm install
npm run tauri build
mv "/Applications/mycmux.app" ~/.Trash/ 2>/dev/null   # 既存があれば
cp -R src-tauri/target/release/bundle/macos/mycmux.app /Applications/
xattr -cr /Applications/mycmux.app                    # Gatekeeper の quarantine 属性を除去
open /Applications/mycmux.app
```

Resume palette (`Cmd+P`) を使うには `crsm` を別途 build しておく必要があります。

```bash
git clone https://github.com/miyafcos/crsm.git ~/crsm
cd ~/crsm
cargo build --release
# 以後、mycmux は ~/crsm/target/release/crsm を自動検出します
```

## 主なショートカット

ショートカットは `Ctrl+,` から変更できます。

> **macOS**: 表記は `Ctrl+…` ですが、macOS では `Cmd+…` も等価扱いされます。Mac ネイティブ慣習どおり `Cmd+P` で Resume、`Cmd+Shift+N` で新規ワークスペースが開きます。

| 操作 | ショートカット |
| --- | --- |
| サイドバー表示/非表示 | `Ctrl+B` |
| ショートカット設定 | `Ctrl+,` |
| 新規ワークスペース | `Ctrl+Shift+N` |
| 次のワークスペース | `Ctrl+Tab` |
| 前のワークスペース | `Ctrl+Shift+Tab` |
| ワークスペース 1-8 へ移動 | `Ctrl+1` - `Ctrl+8` |
| 最後のワークスペースへ移動 | `Ctrl+9` |
| ワークスペースを閉じる | `Ctrl+Shift+W` |
| 右にペイン分割 | `Ctrl+Alt+D` |
| 下にペイン分割 | `Ctrl+Alt+Shift+D` |
| アクティブペインを閉じる | `Ctrl+Alt+W` |
| 閉じたペインを再オープン | `Ctrl+Shift+T` |
| 左/右/上/下のペインへフォーカス | `Ctrl+Alt+Arrow` |
| ペインを拡大/戻す | `Ctrl+Shift+Enter` |
| ペイン内の次/前のタブへ移動 | `Ctrl+Alt+PageDown` / `Ctrl+Alt+PageUp` |
| ターミナル内検索 | `Ctrl+Shift+F` |
| CRSM Palette (過去セッション一覧) | `Ctrl+P` |

## セッション復元

アプリ終了後に再起動すると、ワークスペース、ペイン、タブ、作業ディレクトリ、直前のターミナル表示に加えて、ウィンドウの位置・サイズ・最大化状態も復元します。

Claude Code / Codex / claude-codex の前回セッションは、直前の会話表示と作業場所がペインに残ります。再開の導線は3つあります。

- `Ctrl+P` で CRSM Palette を開き、過去セッション一覧から選んで resume 起動する
- Launch メニューの resume 系項目からセッションピッカーで選ぶ
- 誤って閉じたペインは `Ctrl+Shift+T` でセッションごと再オープンする

> v0.4.0 以降、保存済みセッション ID を使った自動 resume 起動は廃止しました。新規ペインに `MYCMUX_RESUME` などの環境変数が伝播してエージェントモードが意図せず暴発する事故 (env 汚染) を防ぐためです。CRSM Palette の手動選択がデフォルトの再開フローになります。

## 開発

### Windows

```powershell
npm install
cmd /c npx tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --release -- -D warnings
cmd /c npm run tauri build
```

### macOS

```bash
npm install
npx tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --release -- -D warnings
npm run tauri build
# 起動の体感を計りたいときは:
bash scripts/measure-mac.sh baseline   # /tmp/mycmux-measure-*.json に出力
```

ビルド成果物は `src-tauri/target/release/bundle/macos/mycmux.app`。`/Applications` に配置するときは `xattr -cr` を忘れずに。

## ライセンス

GPL-3.0。詳しくは [LICENSE](LICENSE) を参照してください。
