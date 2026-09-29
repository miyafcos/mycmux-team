# エージェント標識の出所台帳 (src/assets/agents)

パスに描き起こせないエージェント標識だけをここに置く。SVG で描ける標識は
`src/components/icons/AgentIcons.tsx` にパスのまま持たせるので、この台帳は
「ベクタが公開されていないので画像を同梱した」ものの出所を残すためにある。

| ファイル | 由来 | 取得元 | ライセンス表記 | 加工 |
|---|---|---|---|---|
| `hermes.webp` | Hermes Agent (NousResearch) の公式標識 | `NousResearch/hermes-agent` (MIT) の `website/static/img/logo.png` — 同リポの `web/public/favicon.ico` はこの絵の 48px 縮小版 | MIT (upstream の `LICENSE`) | 白地に合成 → 128x128 へ縮小 → 可逆 WebP (7,378 bytes) |

## hermes.webp の詳細 (2026-09-09)

- 元ファイル: `website/static/img/logo.png` 1772x1799 / sha256 `2eaff911b9da9b1f1fcc81adb02f4992bb9ea6b781f4dd048cd79349927ddb7a`
- 元コミット: `8aa219e` (ローカル clone `%LOCALAPPDATA%/hermes/hermes-agent` で確認)
- 公式 favicon (`web/public/favicon.ico` 48px) と同じ絵であることは輝度相関 0.989 で確認済み
- 同リポの `website/static/img/favicon.svg` は `⚕` の文字を置いただけのプレースホルダで、標識のベクタ版ではない
  (mycmux が 2026-09-08 まで描いていたケリュケイオン風の線画はこれを真似たもので、公式の絵ではなかった)
- 128px を選んだ理由: 実表示は 14〜18px、200% スケールでも 36px 前後なので余裕を見て 128px。可逆 WebP で 7KB
