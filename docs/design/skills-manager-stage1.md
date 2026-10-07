# スキル画面 段1の設計

スキルの正本は各サービスの SKILL.md とフォルダであり、画面は読取りと新しいペインの起動を行う。個人の棚定義と Codex の利用記録は ~/.mycmux/skills に置く。本文、設定、フック、エージェントの認証はこの画面から書き換えない。

## 外枠と埋め込み

SkillsButton は上の帯の入口、SkillsPanel は全面の OverlayShell とその終了アニメーションを持つ。SkillsView は棚・一覧・詳細・画面内通知・キーボード処理を持ち、OverlayShell、ポータル、固定位置に依存しない。

```tsx
<SkillsView initialSkillId={selectedSkillId} onClose={returnToParent} />
```

SkillsViewProps は initialSkillId?: string | null、onClose: () => void、api?: typeof skillsApi、initialCatalog?: SkillCatalog。指定された id が変わると「すべて」の棚へ戻してその1本を選ぶ。データ到着前の id も保持し、未登録なら最初の行に戻す。api と initialCatalog は読取りの差し替え口であり、合成ホームの画面検証にも使う。親は高さのある領域と既存の cmux テーマ変数を供給する。

表示は workspace store を購読しない。「始める」と「AI に直してもらう」だけが useWorkspaceListStore、useWorkspaceLayoutStore、useUiStore を読み、現在のワークスペースとセッションを含むタブに addTabToPaneWithOptions で新しいペインを作る。initialPrompt は /名前 または $名前。戻る処理は onClose に委ねる。

## 読取りと層

Rust skills モジュールは Claude、Codex、.agents、Hermes、コマンド、プラグイン、同期、skill_listing をまとめる。個人定義 > metadata.pocket > 配る定義 > AI の案 > 推定の順で各フィールドを重ねる。公開用 defaults.json には棚だけを持ち、個人スキルの名前・表示名・別名・非表示設定を含めない。

共有保存先の移行は pocket の保存処理だけを変更した。新しいファイルがあればそれを優先し、なければ従来の _state を読む。書込みは新しい場所だけ。起動時の移行は読取り worker の最初に行い、既存の新ファイルを上書きしない。個人定義の初回コピーには、公開側に持ち込めない既存の配布定義も重ね、有効な表示を維持する。元のファイルは残す。

前回の目録は cache.json に保存する。隔離 profile では cache をその profile の runtime 配下に置く。8つの Tauri command は async と run_blocking を使い、UI thread でファイル探索をしない。画面はメモリまたはディスクの前回結果を表示し、遅い旧キャッシュが新しい結果を上書きしない。

## 本文、置き場所、共有

YAML は対象の形を小さい読み手で解釈する。境界改行を除く pocket と同じ frontmatter 抽出を行い、ブロック値の末尾改行も PyYAML に合わせる。Markdown は comrak と安全な要素の一覧で整える。script、イベント属性、危険な URL、外部画像を残さない。目次は整えた HTML の見出しから作る。

置き場所では本体・入口・写し・独自・生きた／壊れた junction を表示し、入口の行き先、説明の違い、allow_implicit_invocation、更新と行数を見せる。Codex の重複には標準の skills フォルダだけでなくプラグインも含める。行差分は要求時だけ計算し、巨大な差分には上限を設ける。

共有は Python の選定規則と同じ 50 MB／5,000 ファイルの上限を使う。名前で鍵らしいファイルを開く前に除外し、*.env* も対象とする。キャッシュとリンクは再選択できず、記録・出力などは選び直せる。ファイルを開いた handle の行き先を確認し、ZIP は一時ファイルから上書き禁止で保存する。保存後はパスをコピーし、既存の reveal_in_explorer で場所を示す。

## 検証

公開してよい合成ホームを prepare_home.py で作り、Python collect_skills / build_plan / select_files と同じデータを Rust で読む。通常の Rust テストは単独でも動き、MYCMUX_POCKET_SOURCE を指定した検証では Python の結果と17フィールドおよびファイル選定を照合する。206本の実物との PyYAML 照合台本と実物目録は手元の evidence のみに置き、commit しない。

画面試験は実物の SkillsPanel / SkillsView / SkillDetail を使う。棚・検索・詳細・キーボード・共有・埋め込みと、全 SF Symbols 名の対応を確認する。写真用の Vite 入口も実物の部品を使い、個人データを使わない。global.css、依存一覧、既存の設定、稼働中アプリはこの便では変更しない。
