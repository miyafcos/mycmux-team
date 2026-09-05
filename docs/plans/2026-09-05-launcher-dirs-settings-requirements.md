# ランチャーの「開発」「案件」を環境ごとに設定できるようにする 要件定義 (2026-09-05)

読者 = この実装を担当するエージェント / 語り手 = mycmux 開発者 (弊社) / 相手 = 宮崎さん (GO 判断) / その先 = GitHub からインストールした利用者 (`miyafcos/mycmux-team` の閲覧者)。

モック (静止・実寸): `docs/plans/mockups/2026-09-05-launcher-dirs-settings-mock.html`
前段の設計: `docs/plans/2026-09-03-launcher-redesign-requirements.md` (React ペイン化・5 セクション・240px)

---

## 1. 背景

### 1.1 依頼 (2026-09-05 宮崎さん)

> このアプリ、GitHub から入れた人らがどんな環境でも自分の環境に合わせて使えるように、ランチャーについて。「開発」「案件」のところの設計については、設定からそれぞれの環境に合わせてサジェストと設定 (追加、削除、何をリストに入れる、自動登録する) みたいなところを、やれるようにするべき。

### 1.2 実測した現状 — 「開発」「案件」は宮崎さんの PC でしか育たない

| # | 事実 | 出典 |
|---|---|---|
| P1 | 開発・案件の中身は `~/.mycmux/launch-roots.txt` (`表示名\|パス`、`案件:` 接頭辞で振り分け) を読むだけ。**アプリ側に書き込む経路が 1 本もない** (grep で書き込みは 0 件) | `src-tauri/src/commands/launcher.rs:79-96` |
| P2 | 設定 → ランチャー タブは表示/非表示のチェックだけ。「開発」の説明文が **「~/.mycmux/launch-roots.txt の開発フォルダ」** で、利用者にファイルの手編集を求めている | `src/components/settings/tabs/LauncherTab.tsx:13-14` |
| P3 | 自動登録の実体は **リポジトリ外の私設スクリプト 2 本** — `~/.claude/scripts/update_launch_dev.py` (毎朝 6:35・タスクスケジューラ `mycmux-launch-roots-dev`) と `update_launch_anken.py` (毎朝 6:30 `mycmux-launch-roots-anken` + bash 側の 3 時間おき再生成。docstring は「週次月曜」と書いているが、ログは 09/03〜09/05 毎日走っている)。GitHub 利用者の手元には存在しない | 2 スクリプトの docstring / `schtasks /Query` で 2 タスクとも Ready・次回 09/06 を確認 / `~/.mycmux/launch-roots-anken.log` (2026-09-05) |
| P4 | 同梱の `launcher.sh` がその私設スクリプトを名指しで呼ぶ (`$HOME/.claude/scripts/update_launch_anken.py`)。無ければ黙って何もしない | `src-tauri/src/launcher.sh:1221-1235` |
| P5 | 表示短縮が **`事務関係/`** (宮崎さんの Dropbox 階層) を決め打ち | `src-tauri/src/launcher.sh:1202-1212` |
| P6 | 案件スクリプトの走査根は `エデュ・プラニング合同会社 Dropbox/…/事務関係`、セッションログの検索語も `事務関係`、常連 3 案件がハードコード。開発スクリプトの走査親は `~` `~/apps` `~/tools` `~/agmsg-research` | `update_launch_anken.py:30-60` / `update_launch_dev.py:34-39` |
| P7 | 新規インストールでは `launch-roots.txt` が無く、開発・案件は空のまま。何をどう書けば出るかは README §6 の 1 段落だけ | `README.md:310` |
| P8 | React ランチャーは MRU (`launch-dirs-mru.txt`) を **読むが描かず、選んでも記録しない**。bash 側だけが育てる | `LauncherPane.tsx:289-346, 508-513` / `launcher.rs:86` |
| P9 | README 付録 E の設定タブ一覧は 11 タブで、9/4 に足した「ランチャー」タブが載っていない | `README.md:1057-1075` / `SettingsDialog.tsx:60` |

まとめると、「開発」「案件」という 2 枠は良いが、**中身を入れる手段が宮崎さんの私設スクリプトと手編集しかない**。GitHub から入れた人はこの 2 セクションを一生空のまま眺めることになる。

### 1.3 既にある土台 (作らずに呼ぶ)

| # | 事実 | 出典 |
|---|---|---|
| T1 | `launch-roots.txt` のパーサ (Rust) とテスト 4 本。`LauncherDirEntry { label, path }` | `src-tauri/src/commands/launcher.rs:32-71, 98-159` |
| T2 | フォルダ選択ダイアログは導入済みで、New Workspace が既に使っている (`open({ directory: true })`)。capability `dialog:allow-open` も許可済み | `src/components/setup/WorkspaceSetup.tsx:80-90` / `src-tauri/capabilities/default.json:26` |
| T3 | 設定タブの部品 (`checkboxLabelStyle` / `sectionHeadingStyle` / `dialogButtonStyle` / `dividerStyle`) | `src/components/settings/tabStyles.ts` |
| T4 | ailog が Claude / Codex の全セッションを SQLite に索引済みで、`session` テーブルに **`cwd`** がある。「自分がエージェントを動かした場所」は走査せずに引ける | `src-tauri/src/ailog/index.rs:774` |
| T5 | `crsm_list_sessions` も `cwd` / `last_activity` を返す (crsm は外部ビルドなので新規環境には無いことがある) | `src/lib/ipc.ts:850` / `README.md:83-90` |
| T6 | ランチャーの表示/非表示 (`launcherHiddenIds`) は zustand persist (localStorage) に保存済み。セクション id `dev` / `anken` をキーにしている | `src/stores/settingsStore.ts:83, 145` |
| T7 | ランタイム dir はプロファイルごとに分かれる (`~/.mycmux` / `~/.mycmux-<profile>`)。テスト機は本番の台帳を見ない | `src-tauri/src/test_profile.rs:58-62` |
| T8 | アプリ管理ファイルの先例: `launcher.sh` は「アプリが書き出す。手で編集すると上書きされる。拡張は `launcher.local.sh`」 | `README.md:265, 324-326` / `src-tauri/src/lib.rs:156-186` |
| T9 | 「案件」行の `(●09/03)` を分離する `splitDirLabel` と、中間省略 `middleEllipsis` | `src/components/workspace/launcherModel.ts:107-125, 190-196` |

---

## 2. 決定事項

- **D1. 正本を JSON に移す。** `~/.mycmux/launch-dirs.json` (ランタイム dir・プロファイル別) に、セクション・登録フォルダ・無視リスト・自動登録ルール・最終走査を 1 ファイルで持つ。localStorage には置かない (WebView2 のデータ消去で消える・bash から読めない・プロファイルで分けられない)。
- **D2. `launch-roots.txt` は派生ファイルにする。** アプリが JSON から書き出す (T8 と同じ「アプリ管理・手編集は上書き」の扱い)。bash ランチャー (`d` / `a` キー) はこの派生ファイルを今までどおり読むので、bash 側の読み取りは変えない。ファイルが外部で変更されていたら設定タブに「取り込む / 上書き」を出す (§9.2)。
- **D3. セクションは 2 つのまま、名前を変えられるようにする。** id は `dev` / `anken` で固定 (T6 の hidden id と bash の `案件:` 振り分けを保つ)。表示名は利用者が変える (「Repos」「Clients」など)。**セクションを増やす機能は付けない** (§2.1)。2 枠の意味は「git リポジトリ」と「作業フォルダ」で、これは環境によらない区別。
- **D4. 自動登録はアプリ内蔵のルールにする。** 私設スクリプト 2 本の判定をそのまま Rust に移し、走査先・窓・上限・除外を設定で持つ。ルールは 4 種 (§5)。宮崎さんの現行設定は全数がこの 4 種に写る (§5.2)。
- **D5. 候補 (サジェスト) と自動登録を分ける。** ルールごとに「候補にする」「自動で登録する」を選ぶ。候補は設定タブに出るだけで、ランチャーペインには載らない。新規インストールの既定は候補のみ (勝手に増えない)。
- **D6. 登録は「手動」か「自動」の 2 種だけ。** 自動で入った行は、次の走査で条件を外れると消える。残したければ「固定」する (= 手動に昇格)。宮崎さんの `PINNED` は手動登録として写す。別途ピン留めフラグは持たない。
- **D7. 無視リストを持つ。** 候補や自動登録で「もう出さない」を選んだパスは `ignored_paths` に入り、以後どのルールからも出ない。解除は設定タブの詳細から。
- **D8. 走査はすべて Rust・非同期・上限つき。** フロントは JSON を読むだけで、ペインを開いても走査は起きない。走査は起動 15 秒後 (前回から 3 時間以上なら) と 3 時間おき、および設定タブの「今すぐ」。テストプロファイルでは自動走査をしない (手動の「今すぐ」だけ効く)。
- **D9. 起動経路は変えない。** 選んだフォルダは今までどおり `cwd` として `launcher.sh` に渡る (前段 D5)。本件はリストの中身の話であって、起動の話ではない。

### 2.1 非目標

- セクションを 3 つ以上にする (データは `section` を文字列 id で持つので、将来足せる)
- 候補をランチャーペインに並べる (ペインは静かに保つ。空のときの案内 1 行だけ)
- `launcher.ps1` に Change directory を足す (現状も無い。派生ファイルは bash 向けだけ)
- 私設スクリプトを残したまま両立させる (§9.3 で退役)

---

## 3. 語彙と階層 (先に固定する)

同じ語を別の層で使わない。設定タブ・ペイン・JSON・文書で以下に統一する。

| 語 | 意味 | 反対語 / 隣の語 |
|---|---|---|
| セクション | 「開発」「案件」の 2 枠。id は `dev` / `anken`、表示名は変更可 | — |
| 登録 (する) | セクションに行を入れること。手動でもルールでも「登録」 | 削除 |
| 手動 | 利用者が入れた行。並びは利用者の順。走査で消えない | 自動 |
| 自動 | ルールが入れた行。新しい順。条件を外れると次の走査で消える | 手動 |
| 固定 (する) | 自動の行を手動に昇格させ、消えなくする | — |
| 候補 | ルールや履歴が見つけたが、まだ登録していないフォルダ | 無視 |
| 無視 (する) | 候補・自動から外し、以後出さない。`ignored_paths` | 解除 |
| ルール | 自動登録の走査設定 1 件。種類は 4 つ (§5) | — |
| 走査 | ルールを実行して候補・自動を作ること | — |
| 印 | 行の右端の `●09/03` / `09/03`。自動の行だけに付く (§7) | — |

階層 (設定タブの上から下): **表示 → フォルダ (今あるもの) → 候補 (入れられるもの) → 自動登録 (入る仕組み) → 詳細 (ファイル・無視リスト)**。読む順が「今 → 次 → 仕組み」になる。

---

## 4. データモデル

### 4.1 `~/.mycmux/launch-dirs.json` (v1)

```json
{
  "version": 1,
  "sections": [
    { "id": "dev",   "label": "開発" },
    { "id": "anken", "label": "案件" }
  ],
  "entries": [
    { "id": "e1", "section": "dev", "label": "mycmux (master)",
      "path": "C:/Users/miyaz/cmux-for-linux-dev-master",
      "source": "manual", "added_at": "2026-09-05T12:00:00+09:00" },
    { "id": "e2", "section": "anken", "label": "駿台/モモスタ/数学",
      "path": "C:/Users/miyaz/エデュ・プラニング合同会社 Dropbox/…/事務関係/駿台/モモスタ/数学",
      "source": "auto", "rule_id": "r2", "signal": "mention",
      "seen_at": "2026-09-05", "added_at": "2026-09-03T06:31:00+09:00" }
  ],
  "ignored_paths": ["C:/Users/miyaz/cmux-for-linux-dev"],
  "rules": [ /* §5 */ ],
  "last_scan": { "at": "2026-09-05T06:35:00+09:00", "counts": { "r1": 10, "r2": 20, "r3": 0 } },
  "export": { "roots_txt_written_at": "2026-09-05T06:35:01+09:00" }
}
```

- `source`: `manual` | `auto`。`auto` のときだけ `rule_id` / `signal` / `seen_at` を持つ。
- `signal`: `git` (リポジトリ活動) / `folder` (ファイル更新) / `session` (エージェントを動かした場所) / `mention` (セッション本文で触れた場所)。印の字形を決める (§7)。
- 並び: 手動は `entries` の順。自動は `seen_at` の新しい順。表示時に「手動 → 自動」で連結する。
- 書き込みは tmp → rename。1 世代の `.bak` を残す。Rust 側で Mutex 直列化 (子ウィンドウが複数あっても backend は 1 つ)。

### 4.2 パスの正規化 (比較・重複判定の共通関数)

- 区切りは `/` に統一、末尾の `/` は落とす。`~` は読み込み時に展開し、保存は絶対パス。
- Windows: ドライブ文字を大文字に、比較は大文字小文字を無視 (`update_launch_dev.py:99` の `lower()` と同じ)。`/c/Users/…` (MSYS 形式) は `C:/Users/…` に直す (bash 側 `__norm_path_into` と同じ規則)。
- macOS / Linux: そのまま比較。
- 重複は正規化後のパスで判定する。同じパスは全セクション・候補・無視を通じて 1 つ。

### 4.3 派生ファイル `launch-roots.txt` の書式

```
# generated by mycmux from launch-dirs.json — 設定 → ランチャー で編集してください (手編集は上書きされます)
# short-root: C:/Users/miyaz/エデュ・プラニング合同会社 Dropbox/エデュ・プラニング間屋口　亨/事務関係
mycmux (master)|C:/Users/miyaz/cmux-for-linux-dev-master
案件: 駿台/モモスタ/数学 (●09/05)|C:/Users/miyaz/…/事務関係/駿台/モモスタ/数学
```

- 1 行 = `表示名|パス`。`anken` の行だけ `案件: ` を前置。bash の `__load_roots_section` (`launcher.sh:1453-1471`) はこのままで読める。
- 自動の行は印を `(●MM/DD)` / `(MM/DD)` として表示名に含める (T9 の `splitDirLabel` が分離する)。
- 表示名の `|` と改行は書式を壊すので、書き出し時に `｜` (全角) と空白へ置き換える。
- `# short-root:` は §8 の表示短縮に使う (`事務関係/` 決め打ちの置き換え)。`folder-root` / `session-mentions` ルールの `root` を列挙する。

---

## 5. 自動登録ルール

### 5.1 ルール 4 種

| 種類 | 何を見つけるか | フィールド (既定) | 元になった実装 |
|---|---|---|---|
| `git-parents` | 親フォルダ直下の git リポジトリ (通常 / worktree の `gitdir:` ファイル両対応) のうち、`.git/{index,HEAD,FETCH_HEAD,COMMIT_EDITMSG}` の最新 mtime が窓の中のもの。深掘りしない | `parents[]` / `window_days` (30) / `max` (10) / `exclude.prefixes` (`_` `.` `~$`) / `exclude.names` (`AppData` `Dropbox` `OneDrive`) / `exclude.substrings` (`backup`) | `update_launch_dev.py:52-109` |
| `folder-root` | 根の下を `max_depth` (6) まで歩き、ファイルの mtime が窓の中の枝を「代表階層」(`depth`、先頭要素ごとの上書き `depth_overrides`) で束ねる | `root` / `depth` (2) / `depth_overrides[]` (例 `駿台→3`) / `window_days` (21) / `max` (20) / `exclude.prefixes` / `exclude.substrings` / `top_level_exclude[]` | `update_launch_anken.py:74-103` |
| `session-cwd` | エージェントを動かした作業ディレクトリ。ailog の `session.cwd` (T4) から窓の中のものを新しい順に。`root` を指定すればその配下だけ | `window_days` (30) / `max` (20) / `root` (任意) / `min_sessions` (1) | 新規 (走査なし・SQL 1 本) |
| `session-mentions` | セッション本文で `root` 配下のパスに触れた回数が `min_mentions` 以上の枝を代表階層で束ねる。窓の中の jsonl だけ読む。`launch-roots` 自身の残響行は飛ばす | `root` / `depth` (2) / `depth_overrides[]` / `window_days` (14) / `min_mentions` (3) / `max` (20) | `update_launch_anken.py:105-147` |

各ルールは共通で `id` / `section` (`dev` \| `anken`) / `mode` (`suggest` \| `auto`) / `enabled` を持つ。

### 5.2 宮崎さん環境の対応表 (全数・移行時にこの表どおり JSON を作る)

| 現行 | 移行後のルール | 値 |
|---|---|---|
| `update_launch_dev.py` 全体 | `r1` `git-parents` → `dev` `auto` | parents = `~` `~/apps` `~/tools` `~/agmsg-research` / window 30 / max 10 / prefixes `_` `.` `~$` / names `AppData` `Dropbox` `OneDrive` / substrings `backup` |
| `update_launch_anken.py` の `scan_sessions` (●) | `r2` `session-mentions` → `anken` `auto` | root = `…/事務関係` / depth 2 / overrides `駿台→3` / window 14 / min_mentions 3 / max 20 |
| 同 `scan_recent` (~) | `r3` `folder-root` → `anken` `auto` | root = `…/事務関係` / depth 2 / overrides `駿台→3` / window 21 / max 20 / prefixes `_` `.` `99_` `~$` `★` `☆` `◆` / substrings `請求` `見積` `送り状` `著作権` `外部スタッフ` `図版検索` / top_level_exclude `数学` `理科` `社会` `国語` `英語` `社会進行管理` `見積用` |
| 同 `PINNED` 3 件 | `anken` の手動登録 3 行 | `これヤバ (なるゼミ数学)` / `モモスタ数学` / `モモスタ情報` |
| 手書きの開発 18 行 (活動順 12 + 休眠 6) | `dev` の手動登録 18 行 | 現行の表示名のまま |
| `MAX_AUTO` 20 + PINNED 別枠 | `r2` `r3` の `max` 20、手動は上限なし | 同じ挙動 |
| ● / ~ の印 | `signal` = `mention` / `folder` | §7 の字形 |
| タスクスケジューラ 2 本 + bash の 3 時間再生成 | D8 のスケジューラ | 起動 15 秒後 + 3 時間おき |

`r2` と `r3` が同じパスを出したら `r2` (mention) が勝つ (現行も session 側を先に詰めている: `build_block` の順)。

### 5.3 新規インストール時の既定

| 項目 | 既定 |
|---|---|
| セクション表示名 | `開発` / `案件` (README に「Repos / Clients などに変えてよい」と書く) |
| ルール | `git-parents` (parents = `~`、`suggest`) と `session-cwd` (`suggest`) の 2 本 |
| 登録 | 0 行。ペインの各セクションは空状態の案内 (§7) |
| 走査 | 起動 15 秒後に 1 回。以後 3 時間おき |

`~` 直下の走査は 1 階層だけなので数十ミリ秒で終わる。候補が設定タブに並び、押した分だけ登録される。何も押さなければ何も変わらない。

### 5.4 候補の合成と自動の寿命

- 候補 = (`mode = suggest` のルール結果) ∪ (`session-cwd` 既定) ∪ (MRU `launch-dirs-mru.txt`) − 登録済み − 無視。1 パス 1 行、信号は強い順 (`mention` > `session` > `git` > `folder` > MRU) に 1 つ。上限 30、超えた分は「さらに N 件」。
- `mode = auto` のルールは走査ごとに、そのルール由来の自動行を結果で置き換える。結果から外れた行は消える。手動に固定した行は対象外。
- 無視したパスはどのルールからも出ない。解除すると次の走査で戻る。

### 5.5 走査の上限 (性能ガード)

| 項目 | 上限 |
|---|---|
| 1 ルールで訪れるディレクトリ数 | 50,000 |
| 深さ | `max_depth` (既定 6) |
| シンボリックリンク / ジャンクション | 追わない |
| 1 ルールの時間 | 30 秒で打ち切り、そこまでの結果を使う |
| `session-mentions` が読む jsonl | mtime が窓の中のものだけ・1 ファイル 50 MB まで |
| 同時実行 | 走査は 1 本ずつ (`spawn_blocking` 1 スレッド) |

打ち切ったときは `last_scan.counts` に `truncated: true` を添え、設定タブに「上限で打ち切り」と出す。

---

## 6. 設定 UI 仕様 (設定 → ランチャー)

ダイアログの本文幅で描く (ペインの 240px 制約はここには無い)。既存の「新規に起動」「Web」チェックはそのまま上に残す。

### 6.1 ブロック (上から)

1. **表示** — 既存の「新規に起動」「Web」チェック (変更なし)。「セクション」の 3 チェック (続きから / 開発 / 案件) は次のブロックの見出しへ移す。
2. **フォルダ** — セクションごとに 1 ブロック。見出し行 = `[表示名 (クリックで編集)] [N 件] [表示 ☑] [フォルダを選んで登録…]`。行 = §6.2。空なら「登録がありません。下の候補から登録するか、フォルダを選んでください」。
3. **候補** — §5.4 の一覧。行 = `[印] [名前] [パス (薄字・中間省略)] [信号の説明] [開発に登録] [案件に登録] [無視]`。上に `[候補を更新] 最終走査 09/05 06:35`。0 件なら「候補はありません」。
4. **自動登録** — セクションごとにルールのカード。カード = `[種類のラベル] [要約 1 行 (例: ~ ~/apps ~/tools の直下・30 日・上限 10)] [候補にする ○ / 自動で登録する ○] [有効 ☑] [編集] [削除]`。下に `[ルールを追加 ▾]` (4 種の説明つき) と `[今すぐ走査]`。走査中はボタンを減光して「走査中…」。
5. **詳細** — `正本: ~/.mycmux/launch-dirs.json [開く]` / `bash 用: ~/.mycmux/launch-roots.txt (書き出し 09/05 06:35) [今すぐ書き出す]` / 外部変更の取り込み結果 1 行 (§9.2・ボタンは無い) / 無視リスト (`[パス] [解除]`)。旧 `launch-roots.txt` の取り込みは初回起動で自動 (§9.2) なのでボタンは置かない。

### 6.2 フォルダ行の構成

`[⠿ 並べ替え (手動のみ)] [名前 (クリックで編集)] [パス (薄字・中間省略・ホバーで全文)] [印] [手動|自動 バッジ] [固定 (自動のみ)] [削除 (手動) / 無視 (自動)]`

- 名前の編集は行内。Enter で確定、Esc で戻す。空なら フォルダ名 に戻す。
- 並べ替えは手動行だけ (⠿ のドラッグと ↑↓ ボタン。右クリックは使わない)。自動行は新しい順で固定。
- 削除は確認なし (候補に戻るだけで失うものがない)。無視は確認なし (詳細で解除できる)。
- パスが存在しないときは行を薄くして「見つかりません」を添える (削除は利用者に任せる)。

### 6.3 ルールの編集フォーム

種類ごとに §5.1 のフィールドだけ出す。フォルダ系の入力 (`parents` / `root`) は `[選ぶ…]` (T2 のダイアログ) と手入力の両方。数値は `<input type="number">`。除外は 1 行 1 語の `<textarea>`。ネイティブ `<select>` は使わない (前段 §13 の教訓: WebView2 のポップアップは幅と配色をアプリが制御できない)。種類の選択はチップ 4 つ。

---

## 7. ランチャーペイン側の変更

- セクション見出しの文字は `sections[].label` から取る (`launcherStrings.dev` / `.anken` は既定値として残す)。
- 並びは §4.1 (手動 → 自動)。印は自動行だけ: `signal = mention | session` → `●MM/DD`、`git | folder` → `MM/DD`。手動行に印は無い。
- **空状態**: セクションに登録が 0 件なら 1 行で「登録なし — 設定で登録 (候補 N 件)」。押すと設定ダイアログをランチャータブで開く (U7)。
- フォルダ行を選んだら MRU を記録する (新コマンド `launcher_record_dir_mru`、bash の `__record_dir_mru` と同じ 8 件・先頭挿入)。**表示は今回しない** (U1)。
- 走査は起こさない。JSON を読むコマンド 1 本 (`launcher_dirs_get`) で済ませ、設定タブで変更があればイベントで再読込。

---

## 8. bash 側 (`src-tauri/src/launcher.sh`) の変更

| 箇所 | 現行 | 変更 |
|---|---|---|
| `__refresh_anken_roots_bg` (1221-1235) | `~/.claude/scripts/update_launch_anken.py` を裏で起動 | **関数ごと削除**。再生成はアプリの責務 (D8)。残すと退役後の私設スクリプトが派生ファイルを上書きする |
| `__short_path_into` (1202-1212) | `*事務関係/*` を決め打ちで短縮 | 派生ファイルの `# short-root:` 行を読み、その配下なら `…/` 起点で短縮。無ければ `~` 起点 |
| `__select_launch_root` の見出し (1481, 1497) | `案件 (自動更新: update_launch_anken.py)` / `開発 (edit ~/.mycmux/launch-roots.txt)` | `案件` / `開発` に「設定 → ランチャーで編集」を添える |
| `__load_roots_section` (1453-1471) | — | **変更なし** (派生ファイルの書式を合わせる側で吸収) |

`launcher.ps1` は Change directory を持たないので触らない。`tests/perf/test_week1_day1_behavior_contracts.py` はメニュー配列と数字キーを見るので影響なし。

---

## 9. 移行

### 9.1 新規インストール

JSON が無ければ §5.3 の既定で作る。`launch-roots.txt` も無いので派生ファイルを書く (空に近い)。

### 9.2 `launch-roots.txt` だけがある環境 (宮崎さんと、README を読んで手書きした人)

1. 初回起動で JSON が無く txt がある → **取り込み**: `#` 以外の全行を読み、`案件:` の有無でセクションを決める。`# === AUTO-DEV` / `# === AUTO-ANKEN` ブロック内の行は `source: auto, rule_id: legacy-dev | legacy-anken` として入れ、ブロック外は `manual`。`(●MM/DD)` / `(~MM/DD)` / `(MM/DD)` の印は `seen_at` と `signal` に写す (`~` は `folder`、`●` は `mention`、無印は `git`)。
2. `launch-roots.txt.bak-YYYYMMDD` を残し、派生ファイルを書き直す。`export.roots_txt_written_at` を記録。
3. 以後、txt の mtime が前回書き出し時 (`export.roots_txt_mtime_ms`) より新しければ **読み込みのたびに自動で取り込む** (Phase 1 着手時 2026-09-05 に「バナー + 取り込む / 上書き」から変更。宮崎さんの私設スクリプトが Phase 3 まで毎朝 txt を書くので、その更新を止めずに流すため。README を読んで手書きした利用者の編集も同じ経路で拾える)。規則: AUTO ブロック内の行は `legacy-*` の自動行を丸ごと置き換える (増減と印を写す) / ブロック外の行で未登録・未無視のパスは手動として追加する / 手動の行は txt から消えていても消さない / 無視したパスは取り込まない。取り込み後に派生ファイルを書き直し、設定タブの詳細に「launch-roots.txt の外部変更を取り込みました (時刻)」を 1 行出す。ランチャーペインは JSON だけを見る。
4. `legacy-*` の自動行は、対応するルール (`r1` / `r2` / `r3`) の初回走査で置き換わる。ルールが無い環境ではそのまま残る (消えない)。

### 9.3 宮崎さん環境 (Phase 3・GO 後に弊社が実施)

1. 2 タスク (`mycmux-launch-roots-dev` / `mycmux-launch-roots-anken`) を **無効化** (削除はしない・戻せるように)。
2. §9.2 の取り込みを走らせ、§5.2 の表どおり `r1` `r2` `r3` と手動 21 行 (開発 18 + PINNED 3) を JSON に入れる。
3. 走査を 1 回回し、**現行 txt の dev 28 / anken 20 と JSON の一覧を機械照合** (パス集合の差分が PINNED 由来の追加だけなら合格。手動と自動で同じパスが出たら手動 1 行に畳む (§4.2)。順序と印は別表で目視)。
4. 私設スクリプト 2 本は `~/.claude/scripts/_retired/` へ移す (削除しない)。`launch-roots-dev.log` / `-anken.log` は残す。
5. 1 週間運用して差分が出なければタスクを削除。

### 9.4 テストプロファイル

`~/.mycmux-<profile>/launch-dirs.json` は既定 (§5.3) で作られる。自動走査は止め、「今すぐ走査」だけ効く (`MYCMUX_TEST_PROFILE=1` の判定は既存)。E2E で本番の台帳を見たいときは JSON をコピーする (前段 D-5 と同じ運用)。

---

## 10. 契約テストと検証

| 対象 | 内容 |
|---|---|
| Rust 単体 (新規 `launcher_dirs/`) | JSON 読み書き往復 / txt 取り込み (AUTO ブロック・印・`案件:`) / 派生 txt 書き出し (`\|` 置換・`short-root`) / パス正規化 (`/c/…`・大小・末尾 `/`) / `git-parents` (tempdir に `.git` dir と `gitdir:` ファイルを作り mtime を操作) / `folder-root` (depth・overrides・excludes・top_level_exclude) / `session-mentions` (正規表現・min_mentions・自己残響の除外) / 自動行の置換と手動の保護 / 無視リスト / 上限打ち切り |
| Rust 既存 | `launcher.rs` のパーサテスト 4 本はそのまま通す (派生ファイルの読み手として残る) |
| `tests/test_command_sync_contract.py` | 新コマンドは全部 `async` (`std::fs` を触るので sync に置けない) |
| `tests/unit/launcherModel.test.ts` | 手動 → 自動の連結順・印の字形・空状態の判定 |
| 新規 `tests/unit/launcherDirsModel.test.ts` | 候補の合成 (登録済み・無視の除外・信号の優先) / ルールの要約 1 行 / 行内編集の確定と戻し |
| 新規 `tests/test_launcher_roots_export_contract.py` | Rust の書き出し定数 (`案件: ` 接頭辞・`|` 区切り・`# short-root:`) と `launcher.sh` の `__load_roots_section` / `__short_path_into` の読み取りが一致すること (既存 `test_launcher_catalog_contract.py` と同じソース照合方式) |
| `tests/unit/uiQualityTokens.test.ts` | 設定タブの日本語は 11px 以上 (モックも同じ規約で作ってある) |
| README | §6「別のフォルダで立てたい」を設定タブ起点に書き直す / 付録 E に「ランチャー」タブの行を足す (P9) / 付録 G に `launch-dirs.json` を足し `launch-roots.txt` を派生に書き換える / 私設スクリプトへの言及が無いことを確認 |

完了条件は各 Phase で `npx tsc --noEmit` / `npx vitest run` / `python scripts/run_windows_tests.py` / `python -m pytest tests/` の全通過。

---

## 11. 段階

- **Phase 1 — 台帳と手動登録。** Rust `launcher_dirs/{model,paths,store,import,export,strings}.rs` と非同期コマンド (`launcher_dirs_get` / `_set_section_label` / `_add_entry` / `_update_entry` / `_remove_entry` / `_move_entry` / `_pin_entry` / `_ignore_path` / `_unignore_path` / `_export_roots` / `launcher_record_dir_mru`)。取り込みは自動 (§9.2) なのでコマンドを持たない。派生書き出し (§4.3)。設定タブのブロック 1・2・5 (§6)。ペインは JSON を読む (§7)。`launcher.sh` の 3 箇所 (§8)。委譲 spec = `C:/Users/miyaz/dispatch/260905-launcher-dirs-p1/spec.md`。**この段階で GitHub 利用者は画面から登録・削除・並べ替えができる。**
- **Phase 2 — 自動登録と候補。** 走査エンジン 4 種 (§5.1)・スケジューラ (D8)・候補の合成 (§5.4)・設定タブのブロック 3・4 (§6)・ルール編集フォーム (§6.3)。§5.3 の既定ルール。
- **Phase 3 — 移行と文書。** §9.3 の宮崎さん環境移行 (機械照合つき)・README 4 箇所・CHANGELOG・version bump (5 ファイル)・テスト機で触って GO → feed。

規模の見込み: Rust 1,100 行 / TS 900 行 / テスト 700 行。3 ファイル超なので実行と監査を分ける (`rules/delegation.md`)。実行は Codex `gpt-6-astra` max の可視タブ (設計時点の「Codex 枠切れ」は 9/5 の GPT-6 切替で解消していた)、監査は親が引き取る。実績は §14。

---

## 12. 未決事項 (推奨つき)

| ID | 論点 | 推奨 |
|---|---|---|
| U1 | MRU (`最近使った`) をペインに出すか。前段 D4 で 5 セクションの順が確定しているので、6 つ目を足すのは宮崎さんの判断 | **v1 は記録だけ** (§7)。候補の信号としては使う (§5.4)。表示は実機で 1 週間使ってから決める |
| U2 | セクションを増やせるようにするか | **非目標** (D3)。`section` は文字列 id なので後から足せる |
| U3 | 候補をペインにも出すか | **出さない** (D5)。空状態の 1 行だけ |
| U4 | `session-cwd` の取得元。ailog の `session` テーブルに `cwd` はある (T4) が、最終活動の時刻列の有無と、ailog を止めている環境の扱いは【要確認】 | 時刻列が無ければ ailog のセッション単位の最新 `ts` を使う。ailog が無効なら crsm (T5)、それも無ければ MRU だけ |
| U5 | macOS のパス比較 (APFS は既定で大小を区別しない) | **Windows だけ大小無視**。macOS は実機報告があってから |
| U6 | 表示名に `\|` が入ったときの派生ファイル | **全角 `｜` に置換** (§4.3) |
| U7 | ペインの空状態から設定タブを開く経路。`TitleBar.tsx:95` の `settingsTab` は `"appearance" \| "usage"` の 2 値のローカル state | `uiStore` に `requestedSettingsTab` を足し、TitleBar がそれを読んで開く。子ウィンドウでも効くこと |
| U8 | 派生ファイルを書かない選択肢 (bash ランチャーを使わない人) | **常に書く**。数 KB で害がなく、選択肢を増やすほうが説明が要る |

---

## 13. 着手前の必須手順

前段の文書は「新しく作る」と書いたものを 3 回見落とした。本件でも、実装前に必ず既存を探す。

```bash
grep -ril "launch-dirs\|launcher_dirs\|record_dir_mru\|suggest" src/lib/ src/components/ src-tauri/src/
grep -rn "directory: true" src/                      # フォルダ選択の呼び方 (T2)
grep -n "FROM session" src-tauri/src/ailog/index.rs   # session-cwd の元 (T4・U4)
grep -n "settingsTab" src/components/layout/TitleBar.tsx src/stores/uiStore.ts   # U7
```

見つかったら作らずに呼ぶ。仕様との差分だけを実装する。モックを実装の手本として渡すときは、モック自身が日本語 11px 以上を満たしているかを先に検査する (前段 A-06 の再発防止)。

---

## 14. Phase 1 実装記録 (2026-09-05)

master に合流済み (`c3ec4cb9`〜`5cc370fb` の 14 コミット・origin/master `4c75d324` の上に rebase・ff-merge)。委譲 spec と裁定 = `C:/Users/miyaz/dispatch/260905-launcher-dirs-p1/` (`spec.md` / `RESOLVE-1.md` / `RESOLVE-2.md` / `fix_spec_1.md` / `DONE.md` / `DONE-2.md`)。実行 = Codex `gpt-6-astra` max (可視タブ・8 + 5 コミット)、親の準備 1 + テスト修正 1。

**受け入れ (rebase 後のツリーで親が独立実行):** tsc 0 / vitest 3,831 (master 3,822 + 9) / Rust 1,078 (1,051 + 27) / pytest 450 (442 + 8)。変更 26 ファイル (レーン 21 + 親 5)。

**仕様からの変更 (実装中に確定):**
- §9.2 step 3 — 外部変更は「バナー + 取り込む / 上書き」でなく読み込みのたびに自動取り込み (宮崎さんの私設スクリプトが Phase 3 まで毎朝 txt を書くため)。
- §4.3 — 派生 txt は legacy 由来の自動行を `# === AUTO-DEV BEGIN ===`〜`END` / `AUTO-ANKEN` で囲んで書く (親監査 F1)。私設スクリプトはこの目印の内側だけを書き換えるので、目印が無いと「マーカーが見つからない」で止まる。legacy 行が無い環境では目印を書かない。
- 保存は内容が変わったときだけ (F2・`.bak` は変更前の版を保つ)。JSON 破損時は `.bak` → txt 取り込み → 既定の順で復旧 (F3)。MRU 記録は変更イベントを出さない (F4)。印の解釈は legacy ブロック内の行だけ (F5)。
- 「続きから」の表示チェックはブロック 1 の下に 1 行 (dev / anken だけ見出しへ移した)。深リンク (U7) は `uiStore.requestedSettingsTab` + `SettingsDialog` の `initialTab` 追従。

**レーンで出た BLOCKER 2 件と裁定:** ①受け入れ条件の比較基準 `master..HEAD` は master がレーン開始後に進むため拾い過ぎる → 開始点 `c3ec4cb9..HEAD` に変更 (次回の spec も開始点固定で書く)。②`tests/test_profile_isolation_contract.py` が削除した `__refresh_anken_roots_bg` 内のガード行を検査していた → 親が「私設リフレッシュが無いこと」の検査に書き換え。

**未実施:** テスト機での目視 (feed 前に行う・Phase 3)。macOS 実機。README 4 箇所 (Phase 3)。

---

## 15. Phase 2 実装記録 (2026-09-05)

master に合流済み (`85beb840`〜`0e12ea5e`・origin/master `65b2994e` からの ff・親の準備 1 + Codex `gpt-6-astra` max の 5 コミット)。委譲 spec と裁定 = `C:/Users/miyaz/dispatch/260905-launcher-dirs-p2/` (`spec.md` / `RESOLVE-1.md` / `DONE.md`)。

**受け入れ (親が独立実行):** tsc 0 / vitest 3,843 (+12) / Rust 1,095 (+17・`run_windows_tests.py`) / pytest 451 (+1)。変更 24 ファイル (新規 10)。

**実装の要点と、仕様から確定した細部:**
- ルールは JSON に `Vec<Value>` のまま保存し、使うときに `rules.rs::Rule::from_value` で解釈する (未知の `type` は保持して走査しない)。既定値: window 30/21/30/14 日・max 10/20/20/20・depth 2・max_depth 6・min_mentions 3・min_sessions 1。
- 走査は 1 ルールずつ・`spawn_blocking`・LOCK の外。予算 = 1 ルール 30 秒 / 50,000 ディレクトリ (打ち切りでも集めた分は適用し `truncated` を記録)。リンク判定は `file_type().is_symlink()` (Windows ではジャンクションを含む) だけ — **Dropbox / OneDrive のクラウド用 reparse point を「リンク」扱いすると走査対象が丸ごと消えるため**、属性 0x400 での一律除外はしない (レーンの自己修正 `0e12ea5e`)。
- 除外語の大小区別は移植元に忠実: 案件 (`folder-root`) は区別あり・開発 (`git-parents`) は小文字化して比較。
- 適用: `auto` は自ルール由来の行を置き換え (同パスは id・added_at を保つ)、手動・他ルール・無視は保護。あるセクションで `auto` ルールが 1 本でも成功したら legacy 行を消す。ルール削除・auto→suggest で自ルールの自動行を消す。`ScanOutcome` はルールのスナップショットを持ち、走査中にルールが変わったら結果を捨てる。
- 候補 = suggest ルール ∪ `session-cwd` ∪ MRU − 登録 − 無視。優先 mention > session > git > folder > MRU。上限 30 + `more`。変更・取り込みのたびに `prune_candidates` で登録済みを落とす。
- スケジューラ: 起動 15 秒後に `last_scan.at` が無いか 3 時間超なら走査、以後 3 時間おき。`test_profile::is_active()` のときは起動しない (手動「今すぐ走査」は動く)。二重実行は `AtomicBool`。
- 既定ルール (新規作成時のみ): `git-parents` (parents = ホーム・suggest) と `session-cwd` (suggest)。
- `session-cwd` は ailog の `session` テーブル (`cwd` / `COALESCE(started_at, ended_at)` ms / `is_sidechain = 0` / `user_msg_count > 0`) を query-only で読む。DB が無ければそのルールだけ error。
- レーンの BLOCKER 1 = 既存テスト `ailog/tests/rule_check_tests.rs` の実 DB 読み取り smoke が「本番不触」条件に見えた件 → 既存テストは境界外として親が裁定 (候補 A)。

**テスト機 (2026-09-05 夜):** プロファイル `ldirs` (`~/.mycmux-ldirs`) に本番の `launch-roots.txt` / MRU を写し、`launch-dirs.json` に §5.2 のルール 4 本 (session-cwd 候補・git-parents / session-mentions / folder-root 自動) を仕込んで `scripts/test-profile.ps1 -Name ldirs -CloneAiLog` で起動。宮崎さんの目視 GO → Phase 3。
