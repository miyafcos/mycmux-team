---
name: sample-report
description: 表示確認用の見本 (架空の作業報告)
---

# 作業報告 — 見本の文書 (表示確認用)

読者＝開発担当／語り手＝弊社／相手＝社内の確認者。
作成 2026-09-17。本体は同じフォルダの `report_20260917.html` (生成は `build.py`)。

## 1. 結論

**表示の崩れは 0 件**でした。これは**「重要」**な確認です。*斜体*と~~取り消し線~~、[外部リンク](https://example.com/docs)、自動リンク https://example.com/path も確認します。長いパス `C:\Users\example\AppData\Local\Temp\work\0f3c2a9e-1111-4222-8333-944455556666\scratchpad\verify_facts.py` も折り返します。

> [!NOTE]
> 注記のブロックです。GitHub と同じ書き方 (`> [!NOTE]`) で色つきの枠になります。

> 普通の引用です。
> 2 行目も同じ引用に入ります。

## 2. 数えた値と出どころ

| 資料の記述 | 値 | 出どころ・数え方 |
|---|---:|---|
| 毎回読む決まり | 6 ファイル・12,386 字 | `docs/rules.md` 5,882 B + `rules/` のうち見出しに `paths:` が無い 5 本 19,806 B |
| フック | 20 件 | `settings.json` の `hooks` を event ごとに数えた (Notification 2 / PermissionRequest 1 / PostToolUse 3 / PreToolUse 4) |
| スキル | 58 本 | `skills/*/README.md` |

| 検査 | 結果 |
|---|---|
| `svg_studio.py lint` (図 3 枚・静的 10 + 実レンダ 4 項目) | PASS (FAIL 0 / WARN 0)。3 枚とも 1 回目の生成で合格。その後に文言と分岐を直し、直すたびに再検査して PASS |
| `validate_html.py --profile doc` | 規約違反なし |
| 表示 (Playwright・Chrome) | 1280px と 390px で横はみ出し 0 (初版の 390px では表が 5px はみ出したので、狭い画面の余白と表の 1 列目の幅を直した) |

| # | 見つけたこと | 根拠 | 状態 |
|---|---|---|---|
| 1 | 定期実行が 9/15 02:00 から一時停止のまま (`enabled: false`)。止めた理由は記録に残っていない | `config/cron.json` | 未対応 (意図して止めたかの確認が要る) |
| 2 | 索引 2 行が古かった | `git branch --merged master` | **直した** |

## 3. 手順

1. テスト機を立てる
2. 画面を撮る
   - 幅 340px
   - 幅 1280px
3. 結果を台帳に書く

- [x] 表の描画
- [x] 太字・コード
- [ ] 数式 (未対応)

```powershell
python scripts/run_windows_tests.py   # Rust テスト
npx vitest run
```

---

### 3.1 補足

脚注つきの文です[^1]。見出し 3 の下の段落です。

#### 3.1.1 さらに細かい見出し

本文の最後の段落です。

## 4. 崩れやすい書き方

範囲の書き方 9/15~9/17 と 1~2 件は取り消し線になりません。~~ここは取り消し線~~です。
URL の直後に日本語が続く場合 https://example.com/docsを参照 もリンクが日本語を飲み込みません。
数式 $x^2 + y_1$ はそのまま表示します。

<details>
<summary>折りたたみ</summary>

中身の段落です。<br>改行つき。

</details>

<script>alert("x")</script>
<img src="x" onerror="alert(1)">
[危ないリンク](javascript:alert(1))

![相対パスの画像](images/sample.png)
[同じフォルダの文書](other.md) と [見出しへ](#1-結論)

[^1]: 脚注の本文です。
