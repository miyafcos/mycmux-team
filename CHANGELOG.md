# 変更履歴 (mycmux-lite)

このファイルはチーム配布版 `mycmux-lite` の変更履歴です。personal 版は master worktree 側の `CHANGELOG.md` で管理します。

---

## [0.7.32-lite.1] - 2026-06-18

- 修正: pane 分割時に横スクロールで逃げず、画面幅いっぱいの範囲内で各 pane が細くなるようにしました。
- 修正: 保存済みの古い `columnWidths` / `rowHeightsPerCol` が画面幅を超えていても、現在の表示領域へ縮尺してから Allotment に渡すようにしました。
- 修正: active pane 追従用の `scrollIntoView` を廃止し、pane 追加時に下部や左右のスクロールバーが出る原因を取り除きました。

## [0.7.31-lite.1] - 2026-06-18

- 修正: pane 数が増えたときに、列ごとの最小幅 `420px` が画面幅を超えて横スクロール前提になり、pane が画面内に収まらない問題を修正しました。列幅は表示領域に合わせて縮むようにし、狭い状態でも全 pane が画面内に残ります。
- 修正: 横分割後に新しい pane が active にならず、作った pane が見えない位置に残って「pane が開かない」ように見える問題を修正しました。分割直後は新 pane にフォーカスします。
- 修正: `splitColumns` と実際の pane 一覧がずれた場合に、pane は存在するのに描画対象から外れる問題を修正しました。保存・復元・表示の各入口で欠けた pane ID を補正します。
- 修正: active 状態が tab session ID を指しているとき、ショートカットの横分割・縦分割・zoom が対象 pane を見つけられない問題を修正しました。
- 改善: レイアウト安定性テストを更新し、固定幅スクロール前提ではなく、画面幅追従・pane 欠損補正・分割後フォーカスを契約として検証するようにしました。

## [0.7.30-lite.1] - 2026-06-18

- 修正: ワークスペース復元時に、横分割を勝手に縦積みへ変換してしまう問題を修正しました。
- 修正: pane 操作、復元、保存のすべてで、保存済みの分割方向を保ったままレイアウトを整理するようにしました。
- 修正: stale な `column_widths` / `row_heights_per_col` は、現在の `split_columns` と形が合わない場合に使わないようにしました。
- 修正: 端末描画を WebGL から安定優先の DOM 描画へ戻し、透明背景・複数 pane 環境で文字が斑に欠ける症状を抑えました。
- 修正: 分割・リサイズ中に一時的に 0 サイズ扱いになった pane の出力を破棄せず、表示復帰後に描画するようにしました。
- 修正: mycmux-lite の二重起動を防ぎ、複数プロセスが同じ `data.json` を競合保存してレイアウトを壊す経路を止めました。
- 修正: `data.json` の読み書きにもプロセス間ロックを追加し、万一の同時保存でも直列化されるようにしました。

## [0.7.29-lite.1] - 2026-06-18

- 修正: 複数 pane のワークスペースが復元後に読めないほど細い列へ潰れる問題を修正しました。
- 修正: pane 分割構造が変わったとき、幅・高さの保存値を捨てっぱなしにせず、使える範囲で整合させるようにしました。
- 変更: 端末グリッドに最小列幅・最小行高を設定し、必要な場合は横スクロールで読める状態を保つようにしました。

## [0.7.28-lite.1] - 2026-06-17

- 修正: 起動時復元で、同じ agent session ID が複数 pane に残る問題を修正しました。active tab を優先し、重複側の resume 情報を落とします。
- 修正: `session_id` ごとの PTY 作成を直列化し、復元・再接続経路が同じ session を二重 spawn しないようにしました。
- 修正: 保存時の agent session mapping を serialized workspace snapshot に反映し、起動後に launch した agent が次回復元から漏れないようにしました。

## [0.7.27-lite.1] - 2026-06-07

- 追加: Markdown artifact を HTML 変換経由ではなく、Markdown 本文を直接編集・保存できる source edit にしました。
- 追加: 編集中の `Ctrl+S` / `Cmd+S` で即保存できるようにしました。保存後も編集画面を閉じず、続けて作業できます。
- 変更: Markdown 編集中は保存できない装飾 tool を隠し、保持できない font・数式などを誤って入れないようにしました。
- 改善: DOCX preview / save で、下線、打消し線、文字色、highlight、上付き / 下付き、空段落を保持するようにしました。
- 修正: 画像、脚注、comment、変更履歴、Word 管理の番号、結合 cell を含む DOCX は、簡易保存で壊さないよう保存前に止めるようにしました。
- 修正: Markdown / Word preview HTML の更新先へ書けない場合、一時 folder へ fallback して保存動作を安定化しました。

## [0.7.26-lite.1] - 2026-06-07

- 追加: Word artifact edit mode に、配置、indent / outdent、font family、font size、数式挿入の control を追加しました。
- 変更: Word document 編集は page 風の document surface で表示し、typography、table border、数式表示を読みやすくしました。
- 修正: DOCX preview / save で、配置、indent、bold、italic、font family、font size、数式 fallback text などの実用的な書式を保持するようにしました。

## [0.7.25-lite.1] - 2026-06-07

- 変更: HTML、Markdown、編集可能 Word artifact tab の右上 toolbar action を Edit、Open、Explorer 表示へ統一しました。
- 追加: Word `.docx` / `.docm` / `.dotx` / `.dotm` artifact を pane 内で軽く編集し、timestamp backup を作って元 file へ保存できるようにしました。
- 修正: Explorer action は `/select,` と path を分けて渡し、Documents / Desktop へ fallback せず対象 document の folder を開くようにしました。

## [0.7.24-lite.1] - 2026-06-07

- 修正: artifact toolbar の Open action が local file を Windows 既定 app で安定して開けるようにしました。
- 修正: Explorer action は元 document path を canonicalize し、preview 生成先ではなく実 file の folder を reveal / select するようにしました。
- 変更: Word、Excel、PowerPoint の OOXML document を pane 内 preview で読めるようにし、編集は desktop Open を基本にしました。

## [0.7.23-lite.1] - 2026-06-06

- 修正: artifact toolbar の Explorer button が生成 preview HTML ではなく、元 document の場所を開くようにしました。
- 変更: preview mode の toolbar を静かにし、編集 control は編集中だけ表示するようにしました。
- 変更: Markdown preview を document 風 layout にし、heading、table、code、mobile spacing を改善しました。
- 追加: Word、Excel、PowerPoint artifact link を preview pane で開き、source metadata と desktop app 起動を使えるようにしました。

## [0.7.22-lite.1] - 2026-06-06

- 修正: artifact preview / editor pane の zoom shortcut を iframe 内で処理し、HTML / Markdown preview に focus があっても `Ctrl+Shift+Enter` が効くようにしました。
- 変更: read-only local HTML / Markdown preview は no-script `srcdoc` document で表示し、relative assets を保ちながら shortcut capture できるようにしました。

## [0.7.21-lite.1] - 2026-06-06

- 修正: HTML / Markdown artifact preview / editor iframe が mycmux shortcut を workspace へ forward し、preview focus 中でも pane zoom / pane navigation shortcut が効くようにしました。
- 変更: artifact edit mode では `Ctrl+B` / `Ctrl+I` が global shortcut ではなく document body の bold / italic として動くようにしました。

## [0.7.20-lite.1] - 2026-06-06

- 修正: artifact editor toolbar の Explorer button は `plugin-shell.open` ではなく native Tauri IPC path で preview HTML を reveal するようにしました。
- 変更: toolbar の icon size と status / file-kind badge を軽くし、右上 action cluster の視覚的な重さを下げました。

## [0.7.19-lite.1] - 2026-06-06

- 追加: terminal preview pane から開いた HTML / Markdown artifact を Word 風 WYSIWYG editor で編集し、元 file へ保存できるようにしました。
- 追加: 保存前に同じ folder へ timestamp backup を作るようにしました。
- 追加: editor toolbar に text formatting、table cell 編集、row / column 挿入・削除を追加しました。
- 変更: Markdown 保存では一般的な Markdown 構造を保ち、複雑な table は embedded HTML として残します。

## [0.7.18-lite.1] - 2026-06-06

- 変更: local HTML / Markdown artifact link は active terminal tab を置き換えず、右側 preview pane で開くようにしました。
- 変更: 同じ artifact を再クリックすると preview を reload し、別 artifact は preview pane 内に別 tab として開きます。

## [0.7.17-lite.1] - 2026-06-06

- 修正: narrow pane で terminal wrap により space が消えた場合でも、長い Dropbox / 日本語 HTML path を in-app preview tab で開けるようにしました。

## [0.7.16-lite.1] - 2026-06-06

- 修正: narrow pane で長い日本語・space 含み HTML path が terminal row をまたいでも、padding space を正規化して preview できるようにしました。

## [0.7.15-lite.1] - 2026-06-05

- 修正: narrow pane や agent output により raw Windows path が hard line break されても、space / 日本語 folder を含む local artifact path を clickable に保つようにしました。

## [0.7.14-lite.1] - 2026-06-05

- 修正: narrow pane で raw Windows path や `file:///...` preview link が terminal row をまたいでも、local artifact link が clickable のまま残るようにしました。

## [0.7.13-lite.1] - 2026-06-05

- 修正: raw Windows artifact path 専用の terminal link provider を追加し、space / 日本語 folder を含む `HTML: C:\Users\miyaz\report.html` 形式も in-app preview tab で開けるようにしました。
- 変更: pane tab bar の手動 Preview artifact eye button を削除し、artifact preview は terminal link から開く方式にしました。

## [0.7.12-lite.1] - 2026-06-05

- 修正: raw Windows artifact path を local `.html` / `.htm` / `.md` / `.markdown` として in-app preview tab で開けるようにしました。
- 変更: 外部 local Markdown file は session preview cache に safe static HTML として render します。

## [0.7.11-lite.1] - 2026-06-05

- 追加: AI artifact preview を lite pane に追加しました。
- 追加: 各 PTY へ `MYCMUX_MARKDOWN_OUT` と `MYCMUX_ARTIFACTS_DIR` を渡し、`out.html` は直接、`out.md` は safe static HTML として開きます。
- 追加: active session に属する `file:///...` artifact link を mycmux browser tab 内で開けるようにしました。

## [0.7.10-lite.1] - 2026-06-05

- 修正: zoom 中の pane を閉じたとき、または zoom 対象を含まない workspace に切り替えたときに画面が空になる問題を修正しました。
- 修正: stale な `zoomedPaneId` を store 側で消し、`AppShell` にも自己回復 guard を残しました。

## [0.7.8-lite.1] - 2026-05-18

- 修正: theme picker で選んだ theme が実際に反映されるようにしました。
- 変更: UI 色を theme token ベースへ整理し、light theme でも正しく表示できるようにしました。
- 修正: 背景画像の上で terminal 文字色が薄くなりすぎる問題を修正しました。
- 修正: 大量 agent output 時の terminal 表示安定性を改善し、PTY 出力を捨てず backpressure をかけるようにしました。

## [0.7.4-lite.1] - 2026-05-16

- 変更: title bar の文字・icon shadow を theme-aware にし、実際の chrome 背景明度で shadow を切り替えるようにしました。

## [0.7.2-lite.1] - 2026-05-15

- 追加: pane tab の double-click / context menu rename に対応しました。
- 追加: Resume palette で user message のない session を非表示にできる設定を追加しました。
- 変更: Usage Meter は Anthropic OAuth `/usage` endpoint の live 値を読むようにしました。
- 変更: ChatGPT rate-limit endpoint に到達できない場合は Codex usage section を自動で隠します。

## [0.7.1-lite.1] - 2026-05-14

- 追加: PTY metrics、SessionManager create log、frontend attach epoch、xterm 1 秒統計、WebGL loss、termCache lifecycle、initial replay log を入れ、表示欠け・復元不具合の調査をしやすくしました。
- 修正: TitleBar の文字色 token を調整し、視認性を上げました。
- 修正: Claude usage 集計から `cache_read_input_tokens` を除外しました。
- 修正: usage tier の `max_20x` と Codex limit の初期値を実測寄りに校正しました。
- 備考: WebGL 表示、SessionManager channel 差し替え、scrollback / replay 重複表示は次段の調査対象として残しました。

## [0.7.0-lite.1] - 2026-05-13

- 追加: TitleBar に Claude Code / Codex の Usage Meter を追加しました。
- 追加: Rust native の usage 集計モジュールと `get_usage_summary` Tauri command を追加しました。
- 修正: 同一 `session_id` の二重 `create_session` が既存 PTY を壊す問題を修正しました。
- 修正: cwd 検証経路と spawn 経路で参照 path がずれる問題を修正しました。
- 修正: 並列復元 race を抑えるため、startup autosave hold、mapping refresh、初回 mount delay を調整しました。
- 変更: `scripts/backfill-sessions.ps1` を deprecated にしました。

## [0.6.2-lite.1] - 2026-05-07

- 修正: personal v0.6.2 の startup restore behavior を lite へ同期しました。
- 修正: 保存済み Claude / Codex / claude-codex session または pane-session mapping を持つ全 workspace を復元対象にしました。
- 変更: inactive workspace は active workspace の後に短い queue で mount し、通常起動の応答性を保ちながら復元します。
- 修正: `shell-starter` / session-less pane は pane-session mapping から `agent_kind` と `agent_session_id` を復元できます。
- 修正: 起動復元中は autosave を短時間止め、中間状態の `data.json` で上書きされにくくしました。

## [0.6.1-lite.1] - 2026-05-07

- 修正: personal v0.6.1 の session history persistence 修正を lite へ同期しました。
- 修正: `onPtyMetadata` が `paneMetadataStore` へだけ流れ、保存時に `agentKind` / `agentSessionId` が `null` になる問題を修正しました。
- 注意: 既存 v0.6.0 の `data.json` は勝手に書き換えません。一度 agent を起動し直すと、次回保存から自動再接続できるようになります。
- 備考: env leak 防止の仕組みは維持しました。

## [0.6.0] - 2026-05-05

- 追加: v0.5.x 系の修正をまとめて正式反映しました。
- 修正: session history persistence を戻し、再起動時に各 pane が以前の Claude / Codex session へ再接続できるようにしました。
- 追加: Settings に Terminal renderer (WebGL) toggle を追加しました。
- 確認: launcher menu の 10 item 構成を normal → dangerous → resume の順に揃えました。

## [0.5.6] - 2026-05-05

- 修正: `SocketListener.tsx::toConfig` が live の `claudeSessionId` / `agentKind` / `agentSessionId` を `data.json` に保存するように戻しました。
- 修正: `data.json` と `~/.mycmux-lite/pane-sessions/*.txt` mapping cache を使い、再起動後に各 pane が以前の Claude / Codex session へ戻れるようにしました。
- 注意: v0.4 で無効化していた理由は `MYCMUX_*` env leak でしたが、v0.4.x で防御済みのため再有効化しました。

## [0.5.5] - 2026-05-05

- 追加: Settings に Terminal renderer (WebGL) toggle を追加しました。
- 変更: 既定は macOS=ON、Windows=OFF、Linux=OFF です。
- 修正: Windows は DOM renderer を既定に戻し、WebView2 + WebGL の濃く重い描画を避けました。
- 注意: renderer の切り替えは次に作る pane から反映されます。

## [0.5.4] - 2026-05-05

- 確認: `src-tauri/src/launcher.sh` の launcher menu を canonical な 10 item 構成へ揃えました。
- 変更: normal → dangerous → resume の順で表示します。
- 備考: source file は既にこの順でしたが、installer を更新して `~/.mycmux-lite/bin/launcher.sh` も一致させました。

## [0.5.3] - 2026-05-05

- 修正: `terminal_config.rs` の unused variable lint を抑制しました。
- 備考: v0.5.2 tag に混ざっていた Windows clippy 修正を、きれいな version として再配布した release です。

## [0.5.2] - 2026-05-05

- 修正: macOS で native window decoration を使い、idle CPU 異常を回避しました。
- 追加: xterm WebGL addon を接続し、context loss 時は DOM fallback へ戻るようにしました。
- 変更: unused な `ghostty-web` dependency を削除しました。
- 追加: macOS build path を正式サポートしました。
- 変更: macOS の `Cmd+...` を Windows 由来の `Ctrl+...` shortcut と同等に扱います。
- 修正: macOS / Linux build failure と `crsm` CLI lookup の `.exe` 決め打ちを修正しました。
- 備考: personal v0.5.2 と lite identity / UI variant の差分を同期しました。

## [0.5.1] - 2026-05-05

- 改善: Resume / CRSM Palette は cached session list から即表示し、背後で CRSM を更新するようにしました。
- 改善: 大量履歴でも重くならないよう、request dedupe、10 秒 auto-refresh cooldown、初回 1000 session load、明示 deep load を入れました。
- 備考: Buddy-only 変更は lite から除外しています。

## [0.5.0] - 2026-05-04

- 変更: personal `master` v0.5.0 と本体 version を同期するための minor release です。
- 備考: lite には機能差分はありません。Buddy / Codex Pet 関連機能は lite には含めません。
- 変更: 以後、mycmux 本体機能の bump は master / lite で揃え、Buddy 関連は master 側で別管理します。

## [0.4.4] - 2026-05-04

- 修正: GitHub Actions の release workflow で、`workflow_dispatch` の tag input を渡しても release upload が skip される問題を修正しました。
- 変更: release workflow を repo 別の専用 job へ整理しました。lite worktree は `build-lite` のみです。

## [0.4.3] - 2026-05-04

- 修正: 背景画像有効時、Settings menu や通知 dropdown に `panelOpacity` が乗って読みにくくなる問題を修正しました。
- 追加: popover 系だけを不透明にする `--cmux-popover` を導入しました。
- 変更: CRSM Palette を Resume にリブランドしました。内部 symbol と localStorage key は互換性維持のため変更していません。
- 変更: Settings 内の Resume 関連設定を1ブロックにまとめました。

## [0.4.2] - 2026-05-04

- 追加: 右上 Settings menu に `Themes` / `Keybindings` と並んで `CRSM Palette` button を追加しました。
- 変更: CRSM Palette で非表示にした kind は、handoff target button と Tab key cycle からも消えるようにしました。

## [0.4.1] - 2026-05-04

- 追加: Settings に `Claude Code` / `Codex` / `Hybrid` の表示 ON/OFF checkbox を追加しました。
- 備考: personal 側の Remote Terminal URL 形式変更と embedded client refresh は、この時点では lite へ反映していません。

## [0.4.0] - 2026-05-04

- 修正: CRSM Palette 経由の env が親プロセスから他の PTY へ漏れ、新規 pane が意図せず resume される問題を修正しました。
- 修正: CRSM CLI 呼び出し時に Windows console window が一瞬出る問題を抑制しました。
- 修正: Remote terminal で WebSocket 接続失敗時に terminal 読み込みを待ってから status banner を出すようにしました。
- 追加: 詳細 subpanel、cwd filter chip、kind badge、相対時刻、さらに過去の session 読み込みを追加しました。
- 変更: CRSM Palette を 1200px 幅の 2 column 構造へ拡張しました。
- 変更: `agent_session_id` / `agent_kind` / `claude_session_id` を `data.json` に保存しない仕様へ変更しました。再起動後は Ctrl+P から手動 resume します。

## [0.3.3-lite.1] - 2026-04-24

- 追加: cache / background pane の Codex approval prompt を検出し、高頻度 `runScan()` loop を戻さずに通知できるようにしました。
- 追加: Settings updater UI を完成させ、現在 version、update available 状態、update failure log を出せるようにしました。
- 備考: Windows MSI 互換のため app/package version は `0.3.3` のまま、公開 tag は `v0.3.3-lite.1` です。

## [0.3.2-lite.1] - 2026-04-24

- 修正: PTY から frontend への IPC path を制御し、WebView stall 時に Tauri Channel queue が無制限に増えないようにしました。
- 修正: local MSVC linker path の決め打ちを外し、GitHub-hosted Windows runner の `link.exe` を使えるようにしました。
- 追加: GitHub Actions で updater artifact generation を有効化し、public lite release に `latest.json` と signed installer metadata を含めました。
- 備考: Windows MSI 互換のため app/package version は `0.3.2` のまま、公開 tag は `v0.3.2-lite.1` です。

## [0.3.0-lite.1] - 2026-04-23

- 修正: hidden workspace / hidden tab が裏で動き続ける問題を personal v0.3.0 から取り込みました。
- 改善: workspace mount set を LRU 3件に制限し、pane は active tab だけ render します。
- 追加: `tauri-plugin-updater` v2 による in-app auto-update を追加しました。Settings → 更新を確認 から確認、署名検証、download、自動再起動まで行います。
- 変更: lite 用署名鍵を personal と分離しました。
- 追加: `build-lite.ps1` を personal 用 build script から分離し、branch 確認、clean 確認、MSVC 読込、build、backup、配置、配布 asset 集約を1コマンド化しました。
- 変更: tag 命名は `vX.Y.Z-lite.N` です。

## [0.2.0] - 2026-04-22

- 変更: personal 版から lite 版へ配布するため、個人機能と重い開発用要素を整理しました。
- 除外: File Explorer Sidebar、Buddy / Persona / Codex bridge、fs watcher、`tauri-plugin-dialog`、古い build/package script、個人版 docs を lite から外しました。
- 変更: 製品名を `mycmux-lite`、bundle ID を `com.miyazaki.mycmux-lite`、config dir を `~/.mycmux-lite/`、localStorage key を `mycmux-lite-settings` にしました。
- 備考: personal 版 `mycmux` と同じ PC で並行起動できます。
