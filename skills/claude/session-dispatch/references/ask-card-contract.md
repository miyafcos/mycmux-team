# ask カード契約 (判断カード) — 正本

子セッションが**走行中に**人間の判断を求めるための唯一の経路。2026-08-02 Oracle 設計ゲート裁定に基づく。
検証データの正本 = `~/.claude/ops/ask_validation.json` (機械検証は ops_common.py の入場ゲートが実施 — この文書と食い違ったら ask_validation.json が勝つ)。

## いつ ask を出すか (blocking 判定)

**ask を出してよいのは、その判断が無いと作業が実質前に進めない (blocking) かつ、判断の種類が次のホワイトリストに入るときだけ:**

| decision_class | 意味 |
|---|---|
| `external_commit` | 外部 (クライアント・先方・公開) へのコミットを伴う |
| `requirement_conflict` | spec 内・spec と実物の要件が衝突している |
| `scope_change` | 依頼範囲の変更・拡大縮小が必要 |
| `irreversible` | 非可逆または修正コストが高い (作り直し級) |
| `owner_judgment` | 宮崎さんだけが持つ業務判断 (好み・顧客関係・優先度) |
| `permission_safety` | 権限・安全・保護対象に触れる |

**上記に入らない可逆な判断は ask を出さない**: 推奨案を自分で選んで続行し、DONE.md の「未解決・要判断」に
「仮定: <選んだ案> (理由)」として残す。後で覆っても直せるものは止まる理由にならない。

## カードの形式 (入場ゲートで機械検証される)

**日本語を Bash 引数で渡さない** (cp932 で破損する — 2026-08-03 実害)。カード本文は **Write ツールで UTF-8 JSON ファイル**に書き、`--card-file` で渡す:

まず `<dispatch-dir>/card.json` を Write ツールで作成:
```json
{
  "title": "<slug>: <論点を一言>",
  "question": "<聞きたいこと1文・120字以内>",
  "detail": "<背景・3行以内>",
  "options": [
    {"label": "<選択肢A・20字以内>", "recommended": true},
    {"label": "<選択肢B>", "recommended": false}
  ],
  "recommendation_reason": "<推奨の理由1行>",
  "blocking_reason": "<なぜ止まるのか1行>",
  "decision_class": "<上表のいずれか>"
}
```

次に Bash で投入 (引数は ASCII のみ):
```
python ~/.claude/ops/ops_common.py enqueue --kind ask \
  --source "dispatch:<slug>" --dispatch-slug <slug> \
  --session-id "$MYCMUX_PANE_SESSION_ID" \
  --card-file "<dispatch-dir>/card.json"
```

日本語を含む破損データは入場ゲートが `encoding_corruption` で拒否する。

- **question は1文**。読んだだけで選べる問いにする
- **options は2〜4個・各20字以内・そのまま子に打ち込める文言** (回答はこの label が composer に届く)
- **recommended はちょうど1つ** + 理由必須
- **背景 (detail) は3行以内で自己完結**。「上記」「ログを見て」「ファイルを参照」等は入場ゲートが拒否する —
  カードだけで答えられない質問は契約違反
- **1カード = 1判断**。複数論点を詰めない
- **1セッション1 pending**。前の質問が生きている間に新しい論点が出たら `--supersede` で置き換える
  (回答が来たら会話が続くので、追加質問は続きの会話でなく新カード)
- 可逆だが確認したい場合は `--default-if-unanswered "<案>"` と `--expires-at <ISO>` を付けてよい
  (期限まで回答が無ければ既定案で続行してよい、の宣言)

## 出した後の子の振る舞い

1. enqueue が exit 0 なら**そのまま待機** (プロンプトで止まる)。ポーリングや催促はしない
2. 回答は composer に直接届く (answer-ask 経由)。届いたら通常の指示として続行
3. enqueue が exit 2 (検証拒否) の場合: 理由コードを読み、**カードを直して再投入するか、可逆と判断して続行**する。
   人間に生ログを読ませる形に逃げない
4. 黙って止まるのは契約違反 (silent blocker)。判断が要るなら ask、要らないなら続行、の二択

## 母艦・人間側の振る舞い

- カードは母艦の各ターン開始時に自動注入される (`ask-inject.py`)。管制盤は副系
- 回答は **`answer-ask <id> --text "<回答>"` 1コマンド** (送信→再開観測→resolved まで自動・idempotent)。
  手動で send+done を分けない。**回答に日本語を含むときは Write でファイルに書いて `--text-file <path>`**
  (--note も同様に `--note-file` あり)
- カード単体で答えられない低品質カードは**宮崎さんに出さず**、子へ契約違反を差し戻す
  (send で「ask-card-contract 違反: <理由>。カードを直して再投入せよ」)
- 却下は `dismiss <id> --reason <child_should_decide|insufficient_info|bad_options|duplicate|not_blocking|already_resolved>`。
  理由分類は契約改善の入力になる
