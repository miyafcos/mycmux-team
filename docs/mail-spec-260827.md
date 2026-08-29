# 未返信メール監視「メール」— 仕様書 (正本)

- 版: **v4 (2026-08-27)**。**この文書がこの機能の唯一の正本**
- 改訂の履歴: v2 = v1 (穴140件) を一から書き直し / v3 = v2 レビュー (NO-GO・must-fix 9項目) を反映し規範付録 A〜E を新設 / **v4 = Oracle GPT-5.6 Sol Pro の再レビュー (NO-GO・残ブロッカー4件) を反映**。最大の修正は、状態を会話単位から**未解消候補単位**へ改めたこと (§6.1) — 会話単位のままだと、別の枝の「ありがとうございました」1通で古い依頼が件数から消える欠陥があった
- 経緯資料: v1 `mail-monitor-design-260826.md` / 穴の全数台帳 `mail-req-holes-260826.md` (140件) / v2 レビュー `mail-spec-v2-review.md` / v3 再レビュー (Oracle) `~/.oracle/sessions/mail-v3-oracle-final/artifacts/transcript.md`。矛盾したら本書が優先
- 決定の理由: `docs/adr/0004`〜`0007` / 用語: リポジトリルート `CONTEXT.md`
- 状態: **Phase 0a (契約の正本化・文書作業) は着手可。判定エンジン・永続化・処置 CLI の実装はまだ入らない** (Oracle 裁定)。実装の着手条件 = 0a 完了 + ダッシュボード大型アップデート完了 + 宮崎さんの着手指示

---

## 1. 何を解決するか

宮崎さんは数十案件を一人で並行し、返信の要否は Gmail の受信箱を開いて記憶と突き合わせないと分からない。受信箱はメルマガと通知で埋まり、「返したか」はスレッドを開くまで判別できない。結果、返信漏れは**思い出したときにしか**発見されない。

本機能は「**こちらが返す番のメール**」だけを機械判定で抽出し、mycmux を見ているだけで気づける状態を作る。そのうえで、返信の下書きを Gmail に用意するところまでを引き受け、Gmail を開くのは送信の瞬間だけにする。

**やらないこと**: メールの送信。返信内容の最終判断。Gmail の代替。

---

## 2. 体験の一本道

| 段 | 宮崎さんの動作 | システムの応答 | 満たせなければ失敗 |
|---|---|---|---|
| 1 気づく | mycmux を見ている (Gmail は開いていない) | TitleBar に未返信件数。至急は色 | 見に行く操作ゼロ・通知の割り込みゼロ |
| 2 選ぶ | 件数をクリック → 行をクリック | 一覧 → 行展開で相手・用件・本文・経緯 | Gmail を開かずに「何の件か」が分かる |
| 3 頼む | 「どう返す?」に一言書く (省略可) →「下書き作成」 | 裏で単発 Claude が起草 → Gmail の下書きへ投入 | 待っている間も他の作業ができる |
| 4 送る | 都合のいいときに Gmail を開く | 該当スレッドに下書きが入っている | 整え直しなしで送れる文面である |
| 5 消える | 送信する / 同僚が返す / 返信不要を押す / Gmail で片づける | 次の走査 (15分以内) で件数が減る | 消えるべきものが残らない・残すべきものが消えない |

---

## 3. スコープ

**対象**: Gmail (複数アカウント)。返信義務の抽出・表示・消し込み・返信下書きの用意。

**対象外 (作らないと決めたもの)**:

| 項目 | 理由 |
|---|---|
| Slack・チャットの未返信 | Slack は未読バッジが既にある。機械判定が困難。従来どおりチャット (unreplied-sweep) が担当 |
| 返信枝ごとの**個別表示・個別処置** | 判定は枝単位で行うが (§5.2)、表示と処置は論理会話に1件へまとめる |
| Gmail の誤スレッド結合の補正 | Gmail の結合を正として許容する。誤結合による見逃しは手動処置で対応 |
| メーリングリスト単位の返信義務判定 | 自動メール分類で除外し、必要なものだけ allow_domains で戻す |
| 複数組織の内部ドメイン管理 | 単一組織 (エデュ・プラニング) 前提 |
| 社内メンバーが個人アドレスから出した返信の検出 | 検出しない。誤検知として残るため手動で消す |
| 自由な Gmail 検索構文の設定項目 | 走査条件を壊せるため持たせない |
| **既存下書きの置換・手動編集の検知** | 既存下書きがある会話には手を触れず、Gmail へのリンクを出すだけ (§7.2) |
| 送信・既読・ラベル・アーカイブ・削除の代行 | Gmail への書き込みは「要求された下書きの作成」だけ (ADR 0005) |

---

## 4. 全体構成

```
Gmail (複数アカウント)
   |  読み取り (Gmail adapter・付録C)   ^ 下書き作成のみ
   v                                    |
[判定エンジン (Python・単発実行)] -------+
   |  合成: 走査事実 x 設定 x ユーザー処置
   v
mail-snapshot.json (表示用の確定結果・付録A)
   |
   +--> mycmux TitleBar (件数) / 一覧パネル / 設定画面
   +--> チャットの「メール」即答 (unreplied-sweep skill)

処置と設定の書き込みは判定エンジンの CLI 経由のみ (付録B)。UI が JSON を直接書かない
下書き起草は起草 supervisor が担当し、判定エンジンとは別プロセス (§7)
```

- 判定エンジンは**常駐しない**。mycmux が15分ごとに短命プロセスとして起動する
- Gmail への読み書きは**単一の adapter を通す** (付録C)。呼び出し側は Gmail API の差異を知らない
- 永続ファイルへの書き手は判定エンジンだけ (単一 writer)。UI・起草 supervisor は CLI 経由で依頼する

---

## 5. 未返信の判定

### 5.1 区分と同一性

- **自分** = `own_addresses` (全監視アカウント共通の本人アドレス集合。alias を含む)
- **社内** = `internal_domains` に属し、かつ `external_addresses` に無いアドレス
- **社外** = それ以外
- **有効な発話** = 実送信済みで、下書きでなく、配送失敗通知でなく、自動メールでないメッセージ
  - 自動メールの判定根拠は `Auto-Submitted` / `Precedence` / `List-*` / no-reply パターン。**分類できないものは自動メールとして除外しない** (未返信側に倒す)
  - **自動転送ラッパーの From は発話者判定に使わない**。元の発話者を確実に復元できないコピーは、既存の未返信を解消しない
- **論理会話** = Gmail のスレッド。複数アカウントに同じ会話が現れた場合は1つに名寄せする
  - 名寄せに使えるのは、受信メッセージ自身の RFC `Message-ID` / `In-Reply-To` / `References` **ヘッダだけ**。本文・添付・転送引用部の ID は使わない
  - RFC `Message-ID` が欠損しているメッセージは、監視アカウント別の独立した会話として扱う。From・件名・時刻による推測統合は禁止
  - **件名の一致は名寄せに使わない**
- **基準メッセージID** は RFC `Message-ID` を指す。Gmail の `message.id` / `thread.id` はアカウント内の参照用として別フィールドに持つ
- 発話の前後関係は Gmail の `internalDate` で決める (`Date` ヘッダは使わない)。同値のときは RFC `Message-ID` の辞書順、それも同値なら (accountId, Gmail message.id) の辞書順で順序を確定する

### 5.2 論理式

**候補**: 会話の中の有効な社外発話のうち、**その To または Cc に自分が含まれる**もの。

**解消**: 候補より後に、次をすべて満たす有効な発話があること。

1. 候補の差出人 (有効な `Reply-To` があればそのアドレス) を To または Cc に含む
2. `In-Reply-To` または `References` で候補の RFC `Message-ID` を継承している (同一返信枝)
3. 自分から出ている (返信済み)、または社内他者から出ている (社内対応済み)

**判定**: 解消されていない候補が **1件でも残れば、その論理会話は未返信**。表示は会話につき1件。ただし**状態は候補ごとに持ち**、表示に使う候補の選び方は §6.1 に従う (会話単位で状態を潰すと古い枝が隠れるため)。

**社内依頼**: 社外が参加していない発話も候補になる。From が社内他者で、To に自分が明示され、そのメッセージの参加者に社外がいないものを候補とする。**グループアドレスだけが To の場合は直宛とみなさない**。解消条件は上と同じ (その差出人を宛先に含む自分または社内他者の有効な発話)。判定は会話の全履歴でなく**候補メッセージ時点の From/To/Cc** で行う。

**優先度**: VIP 送信者 → 至急語を含む → 経過日数が閾値超過 → その他。経過の起点は基準メッセージの `internalDate`。

### 5.3 後段: 会話終端の判定

決定的判定が未返信とした件のうち、「ありがとうございました」「承知しました」のように返信を必要としないものを LLM が判別する (ADR 0007)。結果は `terminalAssessment` として**独立に保持**し、決定的判定の結果を書き換えない。

- 会話終端と判定されたものは通常の件数から外し、一覧の別節に弱表示で残す
- 判定は**未解消候補ごと**に行い、`candidateKey` 単位でキャッシュする (走査ごとに再実行しない)。会話単位では判定しない
- LLM が使えない・応答が不正・判定が不確実なときは**未返信のまま**にする
- `terminalAssessment` を無効化すれば、純粋な機械判定の件数に戻る

### 5.4 宛先の証拠に使ってはいけないもの

`Delivered-To` と `X-Forwarded-To` は転送されたコピー全てに付くため、**自分が宛先である証拠にならない** (2026-08-26 実測)。宛先の判定に使うのは **To と Cc だけ**。この結果、自分が BCC でしか受け取っていない依頼は検出できない (仕様上の限界)。

### 5.5 前提と限界

社内ルール「先方への返信時は edu.math を BCC する」により、同僚の返信が監視アカウントに届き同じ会話に紐づく (2026-08-26 実測確認)。**この BCC の網羅性が判定精度の上限**である。

本機能は意味を理解せず、**機械条件による候補抽出**を行う。次は原理的に扱えないため、手動の消し込みで対応する: 同僚が BCC を忘れた返信 / 同僚が個人アドレスから出した返信 / 電話・Slack・対面での対応 / 社内の「確認します」のような中間返信 (これは解消として扱う)。

---

## 6. 状態と件数

### 6.1 状態は「未解消候補ごと」に持ち、会話の表示は導出する

**状態を会話単位だけで持ってはならない。** 会話単位で持つと、別の枝に届いた「ありがとうございました」を終端と判定しただけで、同じ会話に残る古い依頼まで件数から消える (返信不要・差出人の永久無視でも同じ事故が起きる)。§5.2 で「1枝でも未解消なら残す」と決めた以上、状態も候補ごとに持つ。

**未解消候補ごと**に持つもの:

| フィールド | 値 |
|---|---|
| `candidateKey` | 候補メッセージの識別子 (付録A の `messageKey`) |
| `sender` | 候補の差出人アドレス |
| `terminalAssessment` | unknown / terminal / not-terminal (§5.3) |
| `acknowledgement` | none / acknowledged (この候補に対する「返信不要」) |
| `denied` | この候補の差出人が永久無視の対象か (導出) |
| `priority` | urgent / normal (§5.2 の優先度) |

**会話ごと**に持つもの:

| フィールド | 値 |
|---|---|
| `unresolvedCandidates[]` | 上記の配列 |
| `snoozeUntil` | 会話単位の「後で」(候補単位では持たない) |
| `reachability` | ok / archived / trashed / unverifiable (§6.3) |
| `draftState` | none / creating / drafted / stale / failed (§7) |
| `ageClass` | normal / long-pending (60日超) |
| `anchorMessageKey` | **表示に使う候補** = 通常表示すべき候補のうち `internalDate` が最新のもの。1件も無ければ、全候補のうち最新 |
| `displayState` / `counted` | 下記から導出 |

**通常表示すべき候補** = `terminalAssessment≠terminal` かつ `acknowledgement=none` かつ `denied=false` の未解消候補。

**通常件数に数える条件**: 走査が `complete` かつ `reachability=ok` かつ `ageClass=normal` かつ `snoozeUntil` が未到来でない かつ **通常表示すべき候補が1件以上ある**。

**会話終端・長期未処理・確認不能はそれぞれ別件数・別節**として表示する。TitleBar・一覧・チャットの即答は必ず同じ定義を使う。表示は会話につき1カード (候補ごとにカードを分けない)。展開時は、通常表示すべき候補が複数あればその全件を時系列で示す。

処置が重なった場合の優先順位: **永久無視 > 後で > 返信不要**。除外は理由 (`excludedReason`) と根拠規則を必ず持つ。

`displayState` の導出表 (上から順に最初に一致したもの):

| 順 | 条件 | displayState |
|---|---|---|
| 1 | `reachability=unverifiable` | 確認不能 |
| 2 | `reachability` が archived / trashed | 非表示 (件数外) |
| 3 | 通常表示すべき候補が0件かつ、候補がすべて `denied` | 無視中 |
| 4 | 通常表示すべき候補が0件かつ、`acknowledged` の候補がある | 返信不要にした |
| 5 | 通常表示すべき候補が0件かつ、`terminal` の候補がある | 会話終端 |
| 6 | `snoozeUntil` が未到来 | 後で |
| 7 | `ageClass=long-pending` | 長期未処理 |
| 8 | 上記以外 | 未返信 |

`counted=true` となるのは 8 のときだけ。

### 6.2 消える条件・戻る条件

| きっかけ | 挙動 |
|---|---|
| 自分が返信した / 社内の誰かが先方に返信した | 次の走査で自動的に消える (中身は問わない) |
| Gmail でアーカイブ・ゴミ箱へ移した | §6.3 の確認を経て消える |
| 「返信不要」を押した | その時点の基準メッセージを記録し、即座に消える |
| 「後で」を押した | 期限まで伏せる。復帰は Asia/Tokyo の 09:00 |
| 「この差出人を永久無視」 | 以後その差出人を出さない (確認画面つき) |

- **返信不要**の後、基準より後に未返信の条件を満たす新しいメッセージが来たら再び現れる
- **後で**の期間中でも、至急条件・VIP を満たす新着が来たら即座に復帰する
- 返信済みになった時点で失効するのは `acknowledged` と `snoozed` **だけ**。`denied` (永久無視) は明示的に解除するまで残る
- **VIP に登録した差出人には永久無視を適用しない**。フィルタ順は `VIP > 永久無視 > allow_domains > 自動一括メール分類`。この例外は確認画面に明示する
- **すべての処置に取り消しを用意する** (処置一覧からの解除を含む)
- 「返信不要」は1種類だけとし、電話で済ませた・BCC 忘れで見えないといった理由による消し込みも同じボタンで行う (理由の入力は求めない)

### 6.3 受信箱から消えたときの扱い

**受信箱の一覧に出てこないことだけを根拠に状態を変えない。** 持ち越し中の会話は、既知の accountId と Gmail threadId で個別に取得して確かめる。

| 確認結果 | 扱い |
|---|---|
| 取得でき、全コピーで `INBOX` ラベルが外れている | `reachability=archived` → 通常件数から外す |
| 取得でき、`TRASH` にある | `reachability=trashed` → 通常件数から外す |
| 404・認証失敗・部分走査 | **状態を変えない** (受信箱外の証拠にしない) |
| 全観測元に対する**完全走査**で3回連続して取得不能 | `reachability=unverifiable` → 別枠に表示。部分・失敗走査は連続回数に数えない |

既読・ミュート・その他のラベル変更は判定に影響させない。

**複数アカウントに同じ会話がある場合の集約** (上から順に最初に一致したもの):

| 順 | 条件 | reachability |
|---|---|---|
| 1 | 有効なコピーのいずれかが `INBOX` にある | ok |
| 2 | 取得できないコピーが1つでも残る | **直前の値を維持** (archived / trashed を確定しない) |
| 3 | 全コピーを取得でき、すべて `TRASH` | trashed |
| 4 | 全コピーを取得でき、すべて `INBOX` の外 (TRASH 混在を含む) | archived |
| 5 | 全コピーが3回連続で取得不能 | unverifiable |

### 6.4 処置と走査の競合

- `mail-config.json` と `mail-actions.json` は単調増加する `revision` を持つ。snapshot は合成に使った両方の revision を記録する
- 処置 CLI は、処置を永続化したうえで snapshot を再合成してから成功を返す
- 走査は結果を公開する直前に revision を再確認する。**完了済みの処置を古い snapshot が覆ってはならない**

---

## 7. 返信下書き

### 7.1 流れ

行を展開 →「どう返す?」に一言添える (省略可) →「下書き作成」→ mycmux が起草 supervisor を起動 → 単発の Claude ジョブが本文を書く → Gmail の該当スレッドに下書きを作成 → 行のバッジが「下書き済」に変わる。

**mycmux 側にプレビューは作らない**。中身の確認は Gmail を開いた瞬間 (=送る瞬間) に1回で済ませる。自動で Gmail を開くこともしない。

### 7.2 要求の同一性と失敗の扱い

下書き要求は `requestId` / 論理会話ID / 基準 RFC Message-ID / 対象 accountId・threadId / 方向指示を持つ。

| 状況 | 挙動 |
|---|---|
| 同一会話・同一基準・同一方向指示の要求が再送された | 再実行せず、既存の状態と下書き ID を返す |
| 別の方向指示で作り直したい | 既存下書きがある限り作成しない (下記) |
| 起草中に新着が来た | 投入直前に基準メッセージを再取得し、変わっていたら**投入を中止**して「新着のため再作成が必要」 |
| 下書き作成後・送信前に新着が来た | 走査ごとに基準を比較し、ずれていたら `draftState=stale`「新着あり・下書き要確認」 |
| **対象会話に既に下書きがある (手動・過去分を問わない)** | **作成も置換もしない**。「既存下書きあり」と Gmail へのリンクを表示する。編集・削除は Gmail 側で行い、下書きが無くなったことを走査で確認してから再度作成できる |
| Gmail 側で下書きが消えた | 走査時に存在を確認し、`draftState=none` に戻す |
| 送信済みなのに下書きが残っている | 「不要な下書きが残っています」と表示する (自動削除はしない) |

- 成功の定義は **Gmail の下書き ID を取得し、要求記録に保存した時点**
- ジョブには有限の実行期限とキャンセルを設ける。起動時に、生存プロセスのない `creating` を回収する
- 冪等性の判定には方向指示を正規化したハッシュだけを使い、**方向指示の本文はジョブ完了後に破棄し、ログに出さない**。正規化は「前後の空白除去 → 連続空白を1つに → NFKC 正規化」とし、ハッシュは SHA-256
- **方向指示の本文をコマンド引数で渡さない** (プロセス一覧・シェル履歴に残るため)。標準入力か、利用者だけが読める一時ファイルで渡し、引数にはその参照とハッシュだけを置く
- Claude や検査器が使えなくても、**走査・表示・消し込みは動き続ける** (下書き作成だけを止める)

### 7.3 宛先・送信元・スレッド化

**メールのヘッダは判定エンジンが決め、LLM の出力は本文だけ**とする。

- 宛先 = 基準メッセージに有効な `Reply-To` があればそれ、なければ From。**不正な `Reply-To` は黙って From に落とさず、下書き作成を失敗させる**
- Cc = 基準メッセージの Cc から自分のアドレスを除いたもの。**新しい宛先を自動で足さない。BCC を引き継がない**
- BCC = 送信元 alias の設定が `addCompanyBcc=true` のときだけ `company_bcc_address` を付ける。**推測しない** — alias ごとに明示設定する (付録A-2)。個人アカウントの alias は既定で false
- 送信元は ①その会話での自分の直近の送信元 ②なければ受信時の宛先 alias ③なければアカウントの既定。使えない alias しか無ければ失敗させる
- 下書きを作るのは基準メッセージを受信したアカウント。**複数該当する場合は自動で選ばず、その候補からユーザーに選ばせる**
- 件名は元の会話を返信形式で継承する。threadId と返信ヘッダ (`In-Reply-To` / `References`) は**投入直前に再検証**する
- 宛先に日本語の表示名を入れない (文字化けするため、アドレスのみ)

### 7.4 文面の品質

機械検査 (`check_mail.py`) の通過は**必要条件にすぎない**。加えて:

- 事実・金額・納期・約束・添付・法的表現を**創作しない**
- **回答期日は、会話または方向指示に明示されている場合だけ書く**。明示が無く、かつ期日の提示が必要な場合は、期日を作らずに「追加情報が必要」として失敗させる
- 起草に渡す入力は、当該論理会話の有効な全発話と方向指示に限る。**本文が欠けている・モデルの上限を超える場合は、黙って切り詰めず失敗させる**
- 文体は `client-mail-standards.md` に従う (付録Eで正本パスと版を固定する)

---

## 8. データと保存

### 8.1 3つのファイル

| ファイル | 中身 | 書く主体 |
|---|---|---|
| `mail-snapshot.json` | 走査事実と確定した表示状態 | 判定エンジンのみ |
| `mail-config.json` | 設定の正本 | CLI 経由 |
| `mail-actions.json` | ユーザーの処置 | CLI 経由 |

フィールド定義・列挙値・不変条件は**付録A**。3ファイルとも `schemaVersion` と `revision` を持ち、対応しない版では走らせない。書き込みは「読み手が途中状態を見ない」「失敗したら直前の正常版を残す」ことを満たす方法で行う。

### 8.2 保存場所と機密

- すべて **`%LOCALAPPDATA%` 配下**に置き、**クラウド同期の対象外**とする (現行の `.claude/` 配下は Google Drive バックアップ対象のため移設する)
- **本文は snapshot に入れず、会話ごとの別ファイルに分ける**。snapshot は参照だけを持つ
- 認証情報を snapshot に含めない。本文を診断ログやフロントエンドのコンソールに出さない

### 8.3 保持と本文の寿命

- 一度未返信として拾った会話は、**返信されるか消し込まれるまで台帳に残す** (走査窓の21日を過ぎても消えない)
- 60日を超えたものは `ageClass=long-pending` とし、通常の件数と分けて表示する。**黙って削除しない**
- 60日を超えた会話は保存した本文を破棄し、`bodyAvailability=expired` にする。**これは判定・分類・件数を変えない**
- 本文が必要になったとき (行の展開・処置の取り消し・下書き作成) は、既知の accountId / threadId から**再取得**する。再取得した本文は表示と起草にだけ使い、永続保存せず処理の終了時に破棄する
- 再取得が終わるまでは「本文取得待ち」を表示する。**取得できない・一部欠けている状態では下書き作成を禁止する**。本文が無いことを会話の解消として扱わない
- 走査窓の外に出た会話は §6.3 の手順で個別に確認する

---

## 9. 更新・障害・多重起動

- 定期走査は **15分固定** (設定で変更できない)。加えて mycmux 起動時・PC 復帰時・一覧を開いたとき・手動更新で走る
- **すべてのトリガーは単一のキューとロックに合流する**。同時に発火した要求は1本にまとめる
- 起動時はまず既存の結果を表示し、最終成功から15分以上経っていれば走査する。UI の起動を走査の完了で待たせない
- ロックを持つプロセスの生存を確認し、放置されたロックは期限で回収する
- 走査結果は `complete` / `partial` / `failed` を持つ。**ページング未完了・取得上限到達・アカウント取得失敗・持ち越し未検証が1件でもあれば `partial`** とし、成功率の分子に数えない
- `partial` のときは通常の件数と同じ見た目で出さず、「前回完全走査 N件・一部未取得」と表示し、欠落アカウントと評価できなかった件数を併記する。算出できない場合は 0 ではなく「算出不能」と出す
- **走査に失敗しても件数を 0 にしない**
- 認証エラーと権限不足だけは再試行せず、固定の異常として再連携を促す。一時的な障害・回数制限・CLI 不在は間隔を空けて再試行する
- 最終成功から60分を過ぎたら「情報が古い」と表示する。PC のスリープ中は経過に数えない
- 監視を無効にしている状態は、0件とは区別して「監視停止中」と表示する
- 現在の障害は、**関係する全アカウントが同じ走査で正常完了し結果が `complete` になったときだけ**解消する

---

## 10. 画面

### 10.1 TitleBar (常時)

- 通常件数のみ。至急があるときだけ数字の色を変える。**通知・トースト・アニメーションは使わない**
- 0件でもアイコンは薄く残す (監視停止と 0件を区別するため)
- アイコンは既存アイコンセットに合わせ、**白色系・色なし・枠線のみ**。絵文字・カラー字形は使わない
- ホバーで上位3件の相手名を出す。クリックで一覧を開く

### 10.2 一覧

- 行 = 相手の表示名 (主) + ドメイン (従) + 件名 + 経過 + 状態バッジ
- 行をクリックすると展開し、基準メッセージの本文・往復状況・添付の有無・操作ボタン (返信不要 / 後で / 下書き作成) と「どう返す?」の入力欄を出す
- **節を分ける**: 通常 / 会話終端 / 長期未処理 / 確認不能。件数はそれぞれ独立に出す
- 全経緯は専用画面かチャットで読む (パネルに全文を並べない)
- 絞り込み検索は**相手名・アドレス・件名**を対象とする (本文は対象外。本文を探すのはチャットの仕事)
- Gmail へのリンクは、対象アカウントとスレッドを一意に開く

### 10.3 通知パネル

走査の失敗・認証切れ・情報が古い状態だけを扱う。**未返信メールそのものは入れない**。現在の障害と履歴を分ける。

### 10.4 日本語の扱い

- 画面の文言はすべて日本語 (至急 / 未返信 / 後で / 返信不要にした / 無視中 / 会話終端 / 長期未処理 / 確認不能)
- 日付は曜日つき (「8/27(水) 15:30」)、経過は「4日前から」
- 相手は差出人の日本語表示名を主表示にする

---

## 11. 設定

正本は判定エンジンが読む `mail-config.json` ひとつ。設定画面はその編集フロントに徹し、読み書きは CLI を通す (付録B)。

| 変数 | 型 | 既定 | 位置 |
|---|---|---|---|
| `schemaVersion` / `revision` | int | — | 非表示 |
| `enabled` | bool | true | 基本 |
| `accounts[]` | object[] | fcos 1件 | 基本 (付録A に要素定義) |
| `own_addresses` | string[] | 自動検出+手動追加 | 基本。全アカウント共通の本人判定集合 |
| `urgent_after_days` | number | 3 | 基本 (0.5〜14) |
| `vip_senders` | string[] | [] | 基本 |
| `internal_domains` | string[] | ["example.co.jp"] | 詳細 |
| `external_addresses` | string[] | [] | 詳細。社内ドメインだが社外扱い |
| `company_bcc_address` | string | edu.math の完全アドレス | 詳細。会社アカウントからの下書きにのみ付与 |
| `urgent_keywords` | string[] | ["至急","急ぎ","大至急"] | 詳細 |
| `allow_domains` | string[] | [] | 詳細。一括メール判定の免除 |
| `deny_senders` | string[] | [] | 詳細。永久無視と同一実体 |
| `snooze_presets` | 構造体[] | 明日 / 3日後 / 来週月曜 | 詳細 |
| 状態表示 | — | — | 基本。最終成功 / 次回予定 / アカウント別の鮮度と認証状態 / 直近のエラー (読み取り専用) |
| 操作 | — | — | 基本。今すぐ更新 / 接続テスト / 設定検証 / Google と連携 |

**実装定数 (設定に出さない)**: 定期走査15分・走査窓21日・1走査の取得上限。取得上限は診断情報として表示するが利用者設定にはしない。

- 判定に影響する設定を保存したら全件を再評価し、完了まで「再計算中」と表示する
- Google 連携は設定画面の先頭に置き、アカウントの追加・選択・無効化・再認証・削除を個別に操作できるようにする
- **読み取り権限と下書き作成権限は別の状態として検証・表示**する。下書き権限が未確認のアカウントでは下書き作成の操作を無効にする

---

## 12. 安全境界

- **Gmail への書き込みは、要求された下書きの作成だけ** (ADR 0005)
- **受信メールの本文は信頼しない引用データとして扱う**。本文中の指示をツールへの指示・規範の変更・外部送信の命令として解釈しない
- 起草ジョブに許すのは「渡された会話・規範・検査器の読み取り」と「指定された下書きの投入」のみ。**メール送信・他のメールの検索・一般的なシェル操作を禁止**する
- メールのヘッダ (宛先・送信元・件名・スレッド化) は判定エンジンが決め、LLM は本文だけを生成する
- 起草に使ったモデル・規範・プロンプトの版を記録する。監査に残すのは本文を含まないメタデータに限る

---

## 13. 実装計画

各段階は、そこで止めても単独で運用できる状態で終わること。二重の正本を作らないこと。

| 段階 | 内容 | 完了の判定 |
|---|---|---|
| **0a 契約の正本化 (文書)** | 付録A〜Eを実データで確定する: 正常/Message-ID欠損/deny/undo/revision競合/partial の6例を**完全な JSON** で書き、そこから型と条件付き必須を逆算 + fixture manifest の作成 + 依存の実値 (entrypoint・対応版・解決方法) の記入 | 付録だけを渡した独立実装2系統が、追加の質問なしに互換の JSON と同じ状態遷移を作れる / 全 fixture の期待値が一意に決まる |
| 0b 判定の土台 (実装) | 付録A〜Dの契約を実装 + 論理式 + 規範 fixture のテスト + 処置 CLI と状態遷移の破壊試験 | 付録Dの fixture 全件が期待値と一致 / CLI 契約テストが通る / 処置が再走査と再起動を越えて保たれる |
| 1a 気づく | TitleBar + 一覧パネル + 15分スケジューラ | 件数一致 / 通常・会話終端・長期未処理・確認不能・partial・停止中を区別表示 / §14 の測定で成功率と鮮度を満たす |
| 1b ダッシュボード統合 | AttentionCards への統合 (**大型アップデート完了後**) | 本文は展開時のみ取得 / パネルとの役割分担の確定 |
| 2 消し込み | 返信不要 / 後で / 永久無視 + 取り消し | 即座に減った件数が再走査後も一致 / 基準より後の新着で再出現 / 期限で復帰 / 処置と走査の競合で処置が消えない |
| 2.5 下書き | 起草 supervisor・冪等性・鮮度検証・既存下書き回避・宛先と送信元 | 付録Dの起草 fixture 全件が期待どおり / 二重下書きが出ない / 異常終了と再起動から復旧する |
| 3 移管 | 設定画面 + SessionStart hook 撤去 | 全経路が同一ロック / 14日間 二重走査・無更新・設定不整合なし |

**体験の一本道との対応**: 段1=1a / 段2=1a・1b / 段3=2.5 / 段4=2.5 / 段5=0 (自動) と 2 (手動)。

移行期に SessionStart hook と mycmux の両方から起動する間は、**同一の実行ファイル・設定・ロック・出力先**を使う。異なる版の同時起動を禁止する。

---

## 14. 受け入れ基準

| 指標 | 目標 | 測り方 |
|---|---|---|
| 走査成功率 | 95% 以上 | PC 稼働時間を対象とする連続7日。分母=期限が到来した定期走査、分子=`complete` の走査。partial・failed・未実行は分子に入れない |
| 表示の最大鮮度 | 60分以内 | 同期間の最終成功時刻からの経過の最大値 |
| 件数の一致 | 差異 0 | TitleBar・一覧・チャット即答の3経路を同じ snapshot 世代で比較 |
| 誤検知 (返信済み・他者対応済みなのに出る) | 実測して記録し段階ごとに減らす | 7日間の実運用で全数記録 |
| 見逃し (返すべきなのに出ない) | 0 を目標 | 同上 |
| **会話終端判定による取りこぼし** | **0** | LLM が終端と判定して下げた件のうち、実際には返信が必要だったものを全数記録 |
| 下書きの修正率 | 実測して記録 | Gmail 上で本文を手直しした割合 |
| 重複起動 | 0 | ロック取得の失敗ログを計数 |

「認知できる」「負荷が許容範囲」のような測れない基準は使わない。

---

## 15. 決定の記録

| ADR | 決定 |
|---|---|
| 0004 | 下書きは全自動で作らず、要求されたときだけ起草する |
| 0005 | Gmail への書き込みは、要求された下書きの作成だけ |
| 0006 | 起草は mycmux が起動する単発のヘッドレス Claude ジョブで行う |
| 0007 | 会話終端の判定にだけ LLM を使う (決定的判定の後段・下げる方向のみ) |

---

# 付録A. データ契約

ファイルは4つ。いずれも `schemaVersion` (整数) と `revision` (単調増加の整数) を持ち、未知の `schemaVersion` では起動せず設定エラーを表示する。

| ファイル | 役割 | 書く主体 |
|---|---|---|
| `mail-snapshot.json` | 走査事実と確定した表示状態 | 判定エンジン |
| `mail-config.json` | 設定の正本 (**利用者が決める値だけ**) | CLI |
| `mail-actions.json` | ユーザーの処置 (追記のみ) | CLI |
| `mail-runtime.json` | 実行時の観測状態と進行中ジョブ | 判定エンジン / 起草 supervisor |

`mail-runtime.json` に置くもの (設定ではないので config に混ぜない): アカウント別の認証状態と観測 alias / 下書き要求の台帳 (`requestId` / `conversationId` / `candidateKey` / `directionHash` / `jobState` / `pid` / `startedAt` / `deadline` / `gmailDraftId`) / 会話終端判定のキャッシュ (`messageKey` / 判定 / classifier 版 / prompt 版 / 評価時刻)。

## A-0. メッセージと会話の識別子

RFC `Message-ID` は欠損しうる (§5.1) ため、識別子は判別可能な形にする。

```
messageKey =
  { "kind": "rfc",   "messageId": "<...>" }
  | { "kind": "gmail", "accountId": "...", "gmailMessageId": "..." }
```

- RFC `Message-ID` があるメッセージは必ず `kind:"rfc"`。無いものだけ `kind:"gmail"`
- `kind:"gmail"` のメッセージは**アカウントを越えて名寄せしない**。自動解消もしない (常に手動処置待ちとして残す)
- `conversationId` は**判定エンジンが採番する不変の識別子** (UUID)。内容から導出しない (構成メッセージの変化で ID が変わるのを防ぐため)
- 対応付けは `memberMessageKeys[]` で行う。別アカウントのコピーが後から見つかって2つの会話を統合するときは、**新しい ID を採らず、古い方の `conversationId` を残す** (作成が早い方)。統合された側の ID は `mergedFrom[]` に記録し、処置はどちらの ID で記録されていても `memberMessageKeys` を通じて再適用する


## A-1. mail-snapshot.json

| フィールド | 型 | 必須 | 備考 |
|---|---|---|---|
| `schemaVersion` / `revision` | int | ○ | |
| `generatedAt` | ISO8601 | ○ | |
| `scanResult` | enum(complete/partial/failed) | ○ | §9 |
| `partialReasons[]` | enum[] | partial時○ | paging-incomplete / cap-reached / account-error / carryover-unverified |
| `configRevision` / `actionsRevision` | int | ○ | 合成に使った版 |
| `accounts[]` | object[] | ○ | accountId / lastSuccessAt / lastAttemptAt / **readAuthState** / **draftAuthState** / lastError (§11 の権限分離に合わせ認証状態を1つに潰さない) |
| `counts` | object | ○ | normal / terminal / longPending / unverifiable / urgent。算出不能は null (0 にしない) |
| `lastComplete` | object | ○ | 直前の**完全走査**の `generatedAt` と `counts`。partial のとき「前回完全走査 N件」を出す根拠 (§9)。一度も complete していなければ null |
| `conversations[]` | object[] | ○ | 下記 |

`conversations[]` の要素:

| フィールド | 型 | 必須 | 備考 |
|---|---|---|---|
| `conversationId` | string | ○ | 論理会話ID。名寄せ規則が変わっても再対応できるよう、構成メッセージの RFC Message-ID 一覧を併せて持つ |
| `memberMessageIds[]` | string[] | ○ | 構成メッセージの RFC Message-ID |
| `accountRefs[]` | object[] | ○ | accountId + gmailThreadId |
| `anchorMessageId` | string | ○ | 基準メッセージの RFC Message-ID |
| `anchorGmailMessageId` | string | ○ | アカウント内参照 |
| `deterministicVerdict` | enum(pending/resolved) | ○ | §5.2 |
| `actionState` | enum(none/snoozed/acknowledged/denied) | ○ | |
| `excludedReason` / `excludedRuleId` | string | denied時○ | |
| `terminalAssessment` | enum(unknown/terminal/not-terminal) | ○ | §5.3 |
| `reachability` | enum(ok/archived/trashed/unverifiable) | ○ | §6.3 |
| `unverifiableStreak` | int | ○ | complete 走査での連続取得不能回数 |
| `draftState` | enum(none/creating/drafted/stale/failed) | ○ | |
| `draftRef` | object | drafted時○ | accountId / gmailDraftId / requestId / anchorMessageId / createdAt |
| `ageClass` | enum(normal/long-pending) | ○ | |
| `bodyAvailability` | enum(stored/expired/fetching/unavailable) | ○ | §8.3 |
| `bodyRef` | string | stored時○ | 本文ファイルへの参照 |
| `displayState` / `counted` | enum / bool | ○ | 導出値 |
| `who` / `domain` / `subject` / `anchorAt` / `priority` / `priorityReason` / `hasAttachment` | — | ○ | 表示用 |

**不変条件**: `counted=true` ⇔ §6.1 の条件をすべて満たす。`scanResult≠complete` のとき `counted` は集計に使わない。`draftState=drafted` なら `draftRef` が存在する。`reachability=unverifiable` なら `unverifiableStreak≥3`。

## A-2. mail-config.json

§11 の変数に加え、`accounts[]` の要素は次を持つ: `accountId` (不変) / `primaryAddress` / `authSubjectId` (gws が返す不変の認証主体ID) / `authProfileId` / `enabled` / `sendAliases[]` / `defaultSendAlias`。`sendAliases[]` の各要素は `address` / `canSend` / **`addCompanyBcc`** (既定 false・§7.3) を持つ。

観測状態 (`observedRecipientAliases[]` / `readAuthState` / `draftAuthState`) は設定ではないので `mail-runtime.json` に置く。

## A-3. mail-actions.json (要素)

| フィールド | 必須 | 備考 |
|---|---|---|
| `actionId` | ○ | UUID |
| `type` | ○ | acknowledge / snooze / deny / undo |
| `createdAt` | ○ | |
| `conversationId` | undo 以外 ○ | |
| `candidateKey` | acknowledge ○ | 対象の未解消候補 (§6.1) |
| `until` | snooze ○ | Asia/Tokyo の日付。復帰は当日 09:00 |
| `sender` | deny ○ | 正規化済みアドレス (表示名除去+ドメイン小文字化まで) |
| `targetActionId` | undo ○ | 取り消す対象 |

- 追記のみ。取り消しは `undo` レコードで表現し、元レコードを消さない
- **永久無視の正本はこの actions**。`mail-config.json` の `deny_senders` は設定画面に見せるための導出表示であり、二重に保存しない
- acknowledge は返信済みになった時点で失効する。deny は `undo` があるまで有効

---

# 付録B. CLI 契約

すべて標準出力に JSON 1件を返す。終了コード: 0=成功 / 2=引数不正 / 3=設定エラー (schemaVersion 不一致等) / 4=認証・権限 / 5=一時障害 / 6=ロック取得失敗 / 7=競合 (revision 不一致)。

| コマンド | 引数 | 返す内容 |
|---|---|---|
| `scan` | `--reason <startup/periodic/resume/manual/open>` | scanResult / counts / partialReasons / 所要時間 |
| `config get` | `[--key]` | 設定値 + revision |
| `config set` | `--key --value --expect-revision` | 新 revision。revision 不一致は 7 |
| `config validate` | — | 検証結果の一覧 |
| `acknowledge` | `--conversation --anchor --expect-revision` | 再合成後の counts |
| `snooze` | `--conversation --anchor --until` | 同上 |
| `deny` | `--sender` | 同上 + 影響件数 |
| `undo` | `--action-id` | 同上 |
| `draft request` | `--conversation --anchor --account --direction` | requestId / 受理か既存返却か |
| `draft result` | `--request-id` | draftState / gmailDraftId / 失敗段階 |
| `health` | — | 依存の版と可用性 (付録E) |

処置系は、永続化 → snapshot 再合成 → 成功応答の順で行う (§6.4)。

**共通の応答形式**: 成功は `{ok:true, command, revisions:{config,actions,snapshot}, result:{...}, elapsedMs}`。失敗は `{ok:false, command, errorCode, message, retryable, revisions:{...}}`。`errorCode` は終了コードと1対1 (`bad-args` / `config-error` / `auth` / `transient` / `lock` / `conflict`)。

- `--expect-revision` は**処置系すべて** (acknowledge / snooze / deny / undo / config set) に必須とし、対象は **actions の revision** (config set のみ config の revision)。不一致は 7
- 冪等な再送は `ok:true` のまま `result.status` に `created` / `already-exists` を入れて区別する
- **定期走査どうしの重複は正常**として `result.status="coalesced"` で `ok:true` を返す。終了コード6は**異版プロセスの同時起動など異常な競合のときだけ**
- 各コマンドの既定タイムアウト: `scan` 300秒 / 処置系 30秒 / `draft request` 受理まで30秒 (起草そのものは非同期) / `health` 10秒
- `config set` で `accounts[]` のような構造体を更新するときは、要素の追加・更新・削除を `--account-id` と組で指定し、配列まるごとの置換を許さない
- 本文の再取得と行展開のために `body fetch --conversation --candidate` を用意する (§8.3)

---

# 付録C. Gmail adapter 契約

Gmail へのアクセスは単一の adapter を通す。提供する操作:

1. アカウント別の受信箱会話一覧の**全ページ取得** (未完了・上限到達は `partial` を返す)
2. accountId + threadId による**既知会話の取得** (受信箱の外にあっても取得する)
3. send-as alias の一覧
4. 下書きの一覧・取得・作成

取得結果に必須の項目: Gmail の message.id / thread.id / labelIds、RFC `Message-ID` / `References` / `In-Reply-To`、`internalDate`、`From` / `Reply-To` / `To` / `Cc`、自動メール判定用ヘッダ (`Auto-Submitted` / `Precedence` / `List-*`)、下書きかどうか、添付のメタデータ (名前・種類・サイズ)。

エラーは分類して返す: `partial` (ページング未完了・上限到達) / `not-found` (404) / `auth` / `permission` / `transient`。**呼び出し側はこの分類だけを見て §6.3 の判断を行う**。

**操作ごとの入出力**:

| 操作 | 入力 | 出力 |
|---|---|---|
| `listInbox` | accountId | `{messages[], pagesFetched, complete:bool, stoppedBy: "end"/"cap"/"error"}` |
| `getThread` | accountId, threadId | `{messages[], labelIds, found:bool}` または分類済みエラー |
| `getBody` | accountId, gmailMessageId | `{text, source:"plain"/"html-stripped", complete:bool}` — 一部しか取れないときは `complete:false` |
| `listSendAliases` | accountId | `{aliases[]:{address, isDefault, verified}}` |
| `getAuthSubject` | accountId | `{authSubjectId, primaryAddress}` — 設定値との照合に使う |
| `listDrafts` | accountId, threadId | `{drafts[]:{draftId, gmailMessageId}}` |
| `createDraft` | accountId, threadId, ヘッダ一式, 本文 | `{draftId}` または分類済みエラー |

- **アカウントごとの結果を潰さない**。`getThread` は呼び出しごとに accountId を保ち、§6.3 の集約は呼び出し側が行う
- メッセージの正規化出力に必須の項目: Gmail の `message.id` / `thread.id` / `labelIds`、RFC `Message-ID` / `References` / `In-Reply-To`、`internalDate`、`From` / `Reply-To` / `To` / `Cc`、自動メール判定用ヘッダ、下書きかどうか、添付のメタデータ、**アドレス解析に失敗したヘッダの一覧** (`malformedHeaders[]`)
- `getAuthSubject` の結果が設定の `authSubjectId` / `primaryAddress` / `authProfileId` と一致しない場合、**そのアカウントを停止**し設定画面に再連携を促す

---

# 付録D. 規範 fixture

実メールから作った匿名 fixture を正本として保持し、期待結果を固定する。Phase 0 の完了条件は「全件一致」。

**fixture の形式** — 分類名の列挙ではなく、機械実行できる manifest とする。

```
tests/fixtures/mail/
  manifest.json          # fixtureId → 入力・設定・期待値 の対応表
  <fixtureId>/
    input/               # adapter の応答を再現する JSON (アカウント別)
    config.json          # その fixture で使う設定
    actions.json         # 事前の処置 (あれば)
    expected.json        # 期待する snapshot の抜粋
```

`expected.json` に必ず書くもの: 各会話の `displayState` / `counted` / `anchorMessageKey` / `unresolvedCandidates[]` の `candidateKey` と各状態 / `counts` の全区分。**期待値が一意に決まらない fixture は採用しない**。

**判定 (Phase 0)**: 通常の一対一返信 / Cc に自分が残った同僚の返信 (2026-08-26 実測の誤検知2件を含む) / 返信枝が分かれ片方だけ解決 / 純社内の依頼 / グループアドレス宛 / 自分の別 alias からの返信 / 社内ドメインの社外扱い人物 / メーリングリスト / 自動転送ラッパー / RFC Message-ID 欠損 / 同一件名の別会話 / 複数アカウントに現れた同一会話 / 片方のアカウントだけに新着 / アーカイブ / ゴミ箱 / 404 / 取得上限到達 / partial 走査 / 走査中の処置。

**判定 (Phase 0・追加)**: 1つの会話に未解消候補が複数あり**一部だけ**が終端・返信不要・差出人無視になっている (新規P1 の再発防止) / 複数アカウントで INBOX と TRASH と 404 が混在 / 古い走査結果が新しい処置を上書きしようとする / 取り消し後の再合成 / 直前の完全走査の件数を保持したまま partial を表示。

**起草 (Phase 2.5)**: 起草中の新着 / 起草後の新着 / 既存下書きあり / Reply-To あり / 不正な Reply-To / 送信元 alias が使えない / 複数アカウント該当 / 期日が明示されていない依頼 / 本文が期限切れで再取得が必要 / ジョブの異常終了と再起動 / **Gmail の下書き作成に成功した直後に応答を失う** (再送時に二重作成しないこと)。

---

# 付録E. 依存

| 依存 | 正本・版の決め方 | 欠けたときの動作 |
|---|---|---|
| 判定エンジン | 単一の実行入口を定め、mycmux はそれだけを起動する | 監視が止まる (明示表示) |
| gws CLI | 検証済みの版を preflight で確認 | 監視が止まる (明示表示) |
| Python | 同上 | 同上 |
| Claude 実行環境 | 同上 | **監視は継続し、下書き作成だけを止める** |
| `client-mail-standards.md` | 正本パスと版 (ハッシュ) を固定 | 下書き作成だけを止める |
| `check_mail.py` | 正本パスと版 (ハッシュ)・入出力契約を固定 | 下書き作成だけを止める |

`health` コマンドがこの表の可用性と版を返し、設定画面に表示する。
