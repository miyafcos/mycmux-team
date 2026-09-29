# 壁紙の出所台帳 (WALLPAPER_SOURCES)

配布対象は Warp themes 由来の **11枚**。アプリにはサムネイルのみ同梱し、原本は選択時にダウンロードする。
出所は https://github.com/warpdotdev/themes (Apache-2.0)。
ライセンス全文は `src/assets/warp-themes/LICENSE` に保持する。JPEG から WebP に再エンコードしている。
採用範囲は 2026-09-13 の公開アプリ方針による。写真のクレジットは下表に保持する。

2026-09-13 に権利の判断が付かないため48枚の配布と同梱をやめた
(macOS 12・Windows 18・Catppuccin 12・Warp の作品連動 6)。

## マスタ表 (11枚)

列構造とマーカーは `scripts/wallpapers/refresh.py` の読み取り契約を維持する。
配布ファイルの寸法・バイト数・sha256 の正本は `wallpaper-manifest.json`。

<!-- LEDGER-TABLE-BEGIN -->

| # | ファイル | id | label | 現寸法 | 現バイト | KB/MP | 原本URL | 原本寸法 | ライセンス・再配布可否 | 判定 |
|---:|---|---|---|---|---:|---:|---|---|---|---|
| 1 | src/assets/warp-themes/dark_city_bg.webp | dark_city | Dark City | 2278x1556 | 361836 | 99.7 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/dark_city_bg.jpg | 2278x1556 | Apache-2.0 (warpdotdev/themes)。写真のクレジット先は下表 | 再取得可 |
| 2 | src/assets/warp-themes/jellyfish_bg.webp | jellyfish | Jellyfish | 2048x1536 | 409998 | 127.3 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/jellyfish_bg.jpg | 2048x1536 | Apache-2.0 (warpdotdev/themes)。写真のクレジット先は下表 | 再取得可 |
| 3 | src/assets/warp-themes/koi_bg.webp | koi | Koi | 2048x1536 | 248140 | 77.0 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/koi_bg.jpg | 2048x1536 | Apache-2.0 (warpdotdev/themes)。写真のクレジット先は下表 | 再取得可 |
| 4 | src/assets/warp-themes/leafy_bg.webp | leafy | Leafy | 2048x1536 | 349572 | 108.5 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/leafy_bg.jpg | 2048x1536 | Apache-2.0 (warpdotdev/themes)。写真のクレジット先は下表 | 再取得可 |
| 5 | src/assets/warp-themes/marble_bg.webp | marble | Marble | 2356x1538 | 167844 | 45.2 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/marble_bg.jpg | 2356x1538 | Apache-2.0 (warpdotdev/themes)。写真のクレジット先は下表 | 再取得可 |
| 6 | src/assets/warp-themes/pink_city_bg.webp | pink_city | Pink City | 2356x1538 | 102572 | 27.6 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/pink_city_bg.jpg | 2356x1538 | Apache-2.0 (warpdotdev/themes)。写真のクレジット先は下表 | 再取得可 |
| 7 | src/assets/warp-themes/red_rock_bg.webp | red_rock | Red Rock | 2048x1536 | 504430 | 156.6 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/red_rock_bg.jpg | 2048x1536 | Apache-2.0 (warpdotdev/themes)。写真のクレジット先は下表 | 再取得可 |
| 8 | src/assets/warp-themes/snowy_bg.webp | snowy | Snowy | 2356x1538 | 413870 | 111.5 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/snowy_bg.jpg | 2356x1538 | Apache-2.0 (warpdotdev/themes)。写真のクレジット先は下表 | 再取得可 |
| 9 | src/assets/warp-themes/thanksgiving_bg.webp | thanksgiving | Thanksgiving | 2048x1536 | 791714 | 245.8 | https://raw.githubusercontent.com/warpdotdev/themes/main/special_edition/thanksgiving_bg.jpg | 2048x1536 | Apache-2.0 (warpdotdev/themes)。季節企画配布・第三者IPの写り込みなし | 再取得可 |
| 10 | src/assets/warp-themes/winter_bg.webp | winter | Winter | 4549x3252 | 2505820 | 165.4 | https://raw.githubusercontent.com/warpdotdev/themes/main/special_edition/winter_bg.jpg | 4549x3252 | Apache-2.0 (warpdotdev/themes)。季節企画配布・第三者IPの写り込みなし | 再取得可 |
| 11 | src/assets/warp-themes/pride_bg.webp | pride | Pride | 3072x2304 | 73406 | 10.1 | https://raw.githubusercontent.com/warpdotdev/themes/main/special_edition/pride_bg.jpg | 3072x2304 | Apache-2.0 (warpdotdev/themes)。生成グラデーションで第三者IPの写り込みなし | 再取得可 |

<!-- LEDGER-TABLE-END -->

## 写真のクレジット (Warp YAML の credit 行)

| ファイル | クレジット先 |
|---|---|
| `dark_city_bg.webp` | https://unsplash.com/photos/0eKCOZ11gfk |
| `jellyfish_bg.webp` | https://unsplash.com/photos/gGX1fJkmw3k |
| `koi_bg.webp` | https://unsplash.com/photos/tQk3y00flv4 |
| `leafy_bg.webp` | https://unsplash.com/photos/W5XTTLpk1-I |
| `marble_bg.webp` | https://unsplash.com/photos/tqu0IOMaiU8 |
| `pink_city_bg.webp` | https://unsplash.com/photos/OrwkD-iWgqg |
| `red_rock_bg.webp` | https://unsplash.com/photos/2i-JP4tVAp8 |
| `snowy_bg.webp` | https://unsplash.com/photos/d3pTF3r_hwY |
| `thanksgiving_bg.webp` | https://unsplash.com/photos/ZwPuquZBnyM |
| `winter_bg.webp` | https://unsplash.com/photos/TD8CbG9-sMk |

pride は Warp の生成グラデーションで、credit 行はない。
