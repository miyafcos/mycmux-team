# 壁紙の出所台帳 (WALLPAPER_SOURCES)

mycmux に同梱している壁紙 **59枚** の出所・ライセンス・再取得可否の台帳。
作成日: 2026-08-20 (第1段=調査) / 更新: 2026-08-20 (第2段=実際の差し替え・**59枚中57枚を上書き済み**)
対象コミット: `master`

> **第1段と第2段の違い**: 第1段は調査だけで画像に触っていない。第2段で実際に再取得・上書きした。
> 何をどう差し替えたか / 何をスキップしたか / 何が見つからなかったかは **§6** が正本。
> 下の §1〜§5 は第1段の記述を第2段の実測で更新したもの。

- カタログ定義: `src/lib/themeBackgrounds.ts` (`THEME_BACKGROUND_PRESETS`, 59プリセット)
- 突合結果: **カタログにあってファイルが無い = 0件 / ファイルがあってカタログに無い = 0件** (「カタログ未参照」に該当するファイルは無い)
- 再エンコード用スクリプト: `scripts/wallpapers/refresh.py` (本ファイルの下記マスタ表を入力として読む)

この台帳は **調査結果の記録** であって、再配布の可否を保証するものではない。
`要判断` の 47枚 は差し替え前に持ち主 (宮崎さん) の判断が要る。

---

## 1. サマリ

| 判定 | 枚数 | 内訳 |
|---|---:|---|
| 再取得可 | 11 | warp-themes のうち第三者IPの写り込みが無い11枚 (Apache-2.0 の明示的な再配布許諾あり) |
| 要判断 | 47 | macOS 12 / Windows 17 / Catppuccin 12 / warp-themes 6 |
| 再取得不可 (据え置き) | 1 | `windows-wallpapers/win11_default_dark.webp` (原本未特定) |
| **合計** | **59** | |

上の判定はライセンス上の可否であって、第2段の差し替え実績とは別軸 (実績は §6)。

合計容量: 差し替え前 13,295,874 バイト (12.68 MiB) → **差し替え後 33,487,672 バイト (31.94 MiB)**。
第1段時点では 59枚中37枚が 60KB/MP 未満まで圧縮されていた。第2段でその大半を解消した。

## 2. 出所グループと調査で分かったこと

### S1. macOS 純正壁紙 (12枚) — Apple の公式配布は **存在しない**

- Apple は macOS 標準壁紙の公式ダウンロードページを **持たない**。OS 同梱 (`/System/Library/Desktop Pictures`, `/System/Library/Wallpapers`) のみ。apple.com 上に配布ページが無いことを検索で確認した (2026-08-20)。
- 実在を確認できた入手先は非公式アーカイブ2つだけ:
  - `https://512pixels.net/projects/default-mac-wallpapers-in-5k/` (Stephen Hackett 氏。macOS 各バージョンの既定壁紙を 6K で公開。**ライセンス表記は一切なし**)
  - `https://github.com/foxt/macOS-Wallpapers` (**LICENSE ファイルなし**。README に "All images are (c) Apple Inc." と明記)
- どちらも Apple から再配布許諾を得た形跡が無い。したがって **12枚すべて `要判断`**。
- 12枚とも原本を実際にダウンロードして、現行ファイルと同一画像であることを16×16縮小の平均絶対差 (0.198〜0.688、閾値12) で確認済み。
- **第2段で12枚すべて差し替え済み**。512pixels の 6K 原本 (6016px) と foxt の 5K 原本 (5120x2880) はどちらも長辺 3840 を上回るので、12枚とも 3840 相当まで解像度が上がった。宮崎さんの「Mac のやつも上げろ」はこの12枚で満たしている。

### S2. Windows 11 純正壁紙 (17枚) — Microsoft の公式配布も **存在しない**。ただしローカルに実体あり

- Microsoft も Windows 11 標準壁紙の単体配布をしていない。ただし **この PC (Windows 11 Home 26200) の `C:\Windows\Web\Wallpaper\` に原本が 3840×2400 で存在する**。ネットワーク不要で再取得できる点が S1 と違う。
- 17枚すべてが OS 同梱ファイルと一致することを確認 (平均絶対差 0.210〜0.736)。
- **第2段で17枚すべて差し替え済み**。OS 同梱の原本が 3840x2400 なので、17枚とも 2560x1600 → 3840x2400 に解像度が上がった (原本が 3841px の3枚だけ 3840x2399。§6.3)。
- ライセンスは Windows の EULA に従う。**OS 同梱の壁紙をアプリに再同梱する許諾は与えられていない**ため 17枚すべて `要判断`。
- **命名のずれを発見 (この便では直さない)**: `themeui.dll` の文字列リソースを引くと、Windows 側のテーマ名は ThemeA=**Glow** / ThemeB=**Captured Motion** / ThemeC=**Sunrise** / ThemeD=**Flow**。つまり mycmux の `win11_bloom_01..04` は実際には **Glow**、`win11_spectrum_01..04` は実際には **Sunrise**。`motion` と `flow` だけ正しい。

### S3. Windows 11 と称しているが実体不明のもの (1枚)

- `win11_default_dark.webp` (2560×2048) は **Windows 11 の壁紙ではない**。内容は暗背景に虹色のフローフィールド (curly lines) 曲線を敷いたベクター調のアート。2560×2048 (5:4) という Windows 壁紙にない縦横比。
- 第1段はこの PC の `C:\Windows\Web\Wallpaper\` の18ファイルとしか比較していなかった。**第2段で捜索範囲を756件まで広げたが、一致は0件**。内訳と最小距離は §6.4 に全数記載。
- **原本 URL: 未特定 / ライセンス: 不明 / 判定: 再取得不可 (据え置き)。第2段でも差し替えていない**。同一と断定できる根拠が取れないので、憶測の URL は書かない。

### S4. Catppuccin (12枚) — 公式リポジトリは **存在しない**

- `github.com/catppuccin/wallpapers` は **404**。GitHub API で確認済み (2026-08-20)。Catppuccin 公式 org に壁紙リポジトリは無い。
- 実際の出所は **`https://github.com/orangci/walls-catppuccin-mocha`** (master ブランチ)。12枚すべてが同リポジトリのファイルと一致することを確認した (平均絶対差 0.19〜1.28)。`catppuccin_cabin.webp` だけ `cabin.png` ではなく **`cabin-3.png`** が原本。
- **このリポジトリには LICENSE が無い**。README の原文:
  - "These wallpapers are sourced from many, many, many sources on the internet. I did not make any of these, although I have *edited* several of them a little bit"
  - "Zero credit belongs to me in that regard, I'm simply the collector."
  - "If you are the artist of one of these wallpapers, please contact me, I will happily take the wallpaper down or add credit in this README."
- つまり収集者自身が著作権を持たないと明言しており、原著作者は各画像とも不明。個別のクレジットも無い。**12枚すべて `要判断`**。
- 参考: MIT ライセンスの Catppuccin 壁紙リポジトリ `https://github.com/zhichaoh/catppuccin-wallpapers` は実在するが、**この12枚は1枚も含まれていない**。第1段はファイル名で照合していたが、第2段で**両リポジトリの全575枚と画素照合**して裏を取った (§6.3)。
- **第2段で12枚すべて差し替え済み**。ただし原本自体が 1920px 級のものが多く、解像度が上がったのは `3d-model` `black-hole` (どちらも 3840x2160) と `blue-landscape` (2912x1632) の3枚だけ。残り9枚は解像度据え置きで、圧縮の掛け過ぎだけを解消した。

### S5. Warp themes — 再配布許諾あり (11枚 `再取得可`)

- 出所は **`https://github.com/warpdotdev/themes`** (Apache-2.0)。`src/assets/warp-themes/LICENSE` に置かれている Apache 2.0 全文はこのリポジトリのもの (著作権者行は `[yyyy] [name of copyright owner]` のままの雛形)。
- 17枚すべてが `special_edition/` または `warp_bundled/` の同名 JPEG と **寸法まで完全一致**することを確認 (平均絶対差 0.07〜0.74)。現行の webp はこの JPEG からの再エンコードで間違いない。
- **第1段の「写真素材の一次著作者はリポジトリ内に記載されていない」は誤り。第2段で訂正する**。README の1件だけでなく、`special_edition/*.yaml` と `warp_bundled/*.yaml` の `credit:` 行に**13枚分の一次クレジットが個別に書かれていた** (12枚 Unsplash / 1枚 Alphacoders)。全数は §6.5。
- ただしリポジトリ全体の Apache-2.0 が「Warp が持つ権利の範囲での許諾」であって写真の原著作者の権利まで及ぶ保証はない、という点は変わらない。クレジット先を辿れば一次著作者を確認できる、という手がかりが増えただけ。
- **第2段で17枚中16枚を差し替え済み** (`winter_bg` のみ据え置き。理由は §6.2)。`asteroid_city_wallpaper` だけはクレジット先の Alphacoders 版のほうが高解像度だったため原本を乗り換えた (1920x1080 → 3517x1978)。Unsplash 原本11枚はボット検査に阻まれて取得できず未着手 (§6.3)。

### S6. Warp themes のうち第三者 IP がからむもの (6枚 `要判断`)

Apache-2.0 の対象ではあるが、**著作権ライセンスでは処理できない商標・作品タイトルの問題**があるため分離した。

| ファイル | 引っかかる点 |
|---|---|
| `warp.webp` | 画面中央に **Warp の企業ロゴとワードマークが写り込んでいる**。商標は Apache-2.0 (§6 で商標許諾を明示的に除外) の対象外 |
| `asteroid_city_wallpaper.webp` | 映画『Asteroid City』(2023, Focus Features / Wes Anderson) のプロモ連動。画像自体にロゴは無いが作品名連動 |
| `barbie_bg.webp` | 映画『Barbie』(2023, Warner Bros. / Mattel) のプロモ連動。画像はピンクの大理石調テクスチャでロゴは無い |
| `oppenheimer_bg.webp` | 映画『Oppenheimer』(2023, Universal) のプロモ連動。画像は放射状の爆発表現でロゴは無い |
| `lumon.webp` | ドラマ『Severance』(Apple TV+) の架空企業 Lumon Industries 連動。画像は暗いティールのグラデーションのみ |
| `grafbase_bg.webp` | Grafbase 社とのコラボ配布。画像は暗緑のビネットのみでロゴは無い |

---

## 3. マスタ表 (59枚・1行1枚)

`scripts/wallpapers/refresh.py` はこの表をパースする。列の順序と区切りを変えるとスクリプトが読めなくなる。

- **原本URL**: `http(s)://` はネット取得、`C:\...` はこの PC のローカルファイル、`未特定` は不明。
- **原本寸法**: 実際にダウンロード / 実ファイルを開いて計測した値。`-` は原本が特定できていないもの。
- KB/MP = バイト数 ÷ 1024 ÷ メガピクセル。数値が小さいほど圧縮が強い。

<!-- LEDGER-TABLE-BEGIN -->

| # | ファイル | id | label | 現寸法 | 現バイト | KB/MP | 原本URL | 原本寸法 | ライセンス・再配布可否 | 判定 |
|---:|---|---|---|---|---:|---:|---|---|---|---|
| 1 | src/assets/macos-wallpapers/monterey_dark.webp | macos_monterey | macOS Monterey | 3840x3840 | 126190 | 8.4 | https://media.512pixels.net/downloads/macos-wallpapers-6k/12-Monterey-Dark.jpg | 6016x6016 | Apple Inc. 著作物。Apple 公式配布なし。512pixels.net は非公式アーカイブでライセンス表記なし | 要判断 |
| 2 | src/assets/macos-wallpapers/ventura_dark.webp | macos_ventura | macOS Ventura | 3840x3840 | 182204 | 12.1 | https://media.512pixels.net/downloads/macos-wallpapers-6k/13-Ventura-Dark.jpg | 6016x6016 | Apple Inc. 著作物。Apple 公式配布なし。512pixels.net は非公式アーカイブでライセンス表記なし | 要判断 |
| 3 | src/assets/macos-wallpapers/big_sur_night.webp | macos_big_sur | macOS Big Sur | 3840x3840 | 1118298 | 74.1 | https://media.512pixels.net/downloads/macos-wallpapers-6k/11-Big-Sur-Color-Night-6k.jpg | 6016x6016 | Apple Inc. 著作物。Apple 公式配布なし。512pixels.net は非公式アーカイブでライセンス表記なし | 要判断 |
| 4 | src/assets/macos-wallpapers/mojave_night.webp | macos_mojave | macOS Mojave | 3840x2160 | 577876 | 68.0 | https://media.512pixels.net/downloads/macos-wallpapers-6k/10-14-Night-6k.jpg | 6016x3384 | Apple Inc. 著作物。Apple 公式配布なし。512pixels.net は非公式アーカイブでライセンス表記なし | 要判断 |
| 5 | src/assets/macos-wallpapers/sonoma_dark.webp | macos_sonoma | macOS Sonoma | 3840x3840 | 178584 | 11.8 | https://media.512pixels.net/downloads/macos-wallpapers-6k/14-Sonoma-Dark.jpg | 6016x6016 | Apple Inc. 著作物。Apple 公式配布なし。512pixels.net は非公式アーカイブでライセンス表記なし | 要判断 |
| 6 | src/assets/macos-wallpapers/high_sierra.webp | macos_high_sierra | macOS High Sierra | 3840x2160 | 2556254 | 301.0 | https://media.512pixels.net/downloads/macos-wallpapers-6k/10-13-6k.jpg | 6016x3384 | Apple Inc. 著作物。Apple 公式配布なし。512pixels.net は非公式アーカイブでライセンス表記なし | 要判断 |
| 7 | src/assets/macos-wallpapers/sierra.webp | macos_sierra | macOS Sierra | 3840x2160 | 2142436 | 252.2 | https://media.512pixels.net/downloads/macos-wallpapers-6k/10-12-6k.jpg | 6016x3384 | Apple Inc. 著作物。Apple 公式配布なし。512pixels.net は非公式アーカイブでライセンス表記なし | 要判断 |
| 8 | src/assets/macos-wallpapers/el_capitan.webp | macos_el_capitan | macOS El Capitan | 3840x2400 | 2225042 | 235.8 | https://media.512pixels.net/downloads/macos-wallpapers-6k/10-11-6k.jpg | 6016x3760 | Apple Inc. 著作物。Apple 公式配布なし。512pixels.net は非公式アーカイブでライセンス表記なし | 要判断 |
| 9 | src/assets/macos-wallpapers/yosemite.webp | macos_yosemite | macOS Yosemite | 3840x2160 | 1616092 | 190.3 | https://media.512pixels.net/downloads/macos-wallpapers-6k/10-10-6k.jpg | 6016x3384 | Apple Inc. 著作物。Apple 公式配布なし。512pixels.net は非公式アーカイブでライセンス表記なし | 要判断 |
| 10 | src/assets/macos-wallpapers/antelope_canyon.webp | antelope_canyon | Antelope Canyon | 3840x2160 | 1301412 | 153.2 | https://raw.githubusercontent.com/foxt/macOS-Wallpapers/master/Antelope%20Canyon.jpg | 5120x2880 | Apple Inc. 著作物 (macOS Desktop Pictures)。当該リポジトリは LICENSE なし・README に "(c) Apple Inc." と明記 | 要判断 |
| 11 | src/assets/macos-wallpapers/earth_and_moon.webp | earth_and_moon | Earth & Moon | 3840x2160 | 186874 | 22.0 | https://raw.githubusercontent.com/foxt/macOS-Wallpapers/master/Earth%20and%20Moon.jpg | 5120x2880 | Apple Inc. 著作物 (macOS Desktop Pictures)。当該リポジトリは LICENSE なし・README に "(c) Apple Inc." と明記 | 要判断 |
| 12 | src/assets/macos-wallpapers/milky_way.webp | milky_way | Milky Way | 3840x2160 | 501740 | 59.1 | https://raw.githubusercontent.com/foxt/macOS-Wallpapers/master/Milky%20Way.jpg | 5120x2880 | Apple Inc. 著作物 (macOS Desktop Pictures)。当該リポジトリは LICENSE なし・README に "(c) Apple Inc." と明記 | 要判断 |
| 13 | src/assets/windows-wallpapers/win11_default_dark.webp | win11_default_dark | Win11 Dark | 2560x2048 | 735648 | 137.0 | 未特定 | - | 不明 (Windows 11 同梱壁紙18枚すべてと不一致。出所を特定できなかった) | 再取得不可 (据え置き) |
| 14 | src/assets/windows-wallpapers/win11_default_bloom.webp | win11_default_bloom | Win11 Bloom | 3840x2400 | 291630 | 30.9 | C:\Windows\Web\Wallpaper\Windows\img0.jpg | 3840x2400 | Microsoft Corp. 著作物 (Windows 同梱)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 15 | src/assets/windows-wallpapers/win11_bloom_01.webp | win11_bloom_01 | Win11 Bloom 1 | 3840x2400 | 114006 | 12.1 | C:\Windows\Web\Wallpaper\ThemeA\img20.jpg | 3840x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Glow)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 16 | src/assets/windows-wallpapers/win11_bloom_02.webp | win11_bloom_02 | Win11 Bloom 2 | 3840x2400 | 136468 | 14.5 | C:\Windows\Web\Wallpaper\ThemeA\img21.jpg | 3840x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Glow)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 17 | src/assets/windows-wallpapers/win11_bloom_03.webp | win11_bloom_03 | Win11 Bloom 3 | 3840x2400 | 143144 | 15.2 | C:\Windows\Web\Wallpaper\ThemeA\img22.jpg | 3840x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Glow)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 18 | src/assets/windows-wallpapers/win11_bloom_04.webp | win11_bloom_04 | Win11 Bloom 4 | 3840x2400 | 140960 | 14.9 | C:\Windows\Web\Wallpaper\ThemeA\img23.jpg | 3840x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Glow)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 19 | src/assets/windows-wallpapers/win11_motion_01.webp | win11_motion_01 | Win11 Motion 1 | 3840x2401 | 600828 | 63.6 | C:\Windows\Web\Wallpaper\ThemeB\img24.jpg | 3840x2401 | Microsoft Corp. 著作物 (Windows 同梱テーマ Captured Motion)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 20 | src/assets/windows-wallpapers/win11_motion_02.webp | win11_motion_02 | Win11 Motion 2 | 3840x2400 | 668610 | 70.8 | C:\Windows\Web\Wallpaper\ThemeB\img25.jpg | 3840x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Captured Motion)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 21 | src/assets/windows-wallpapers/win11_motion_03.webp | win11_motion_03 | Win11 Motion 3 | 3840x2399 | 529514 | 56.1 | C:\Windows\Web\Wallpaper\ThemeB\img26.jpg | 3841x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Captured Motion)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 22 | src/assets/windows-wallpapers/win11_motion_04.webp | win11_motion_04 | Win11 Motion 4 | 3840x2400 | 408368 | 43.3 | C:\Windows\Web\Wallpaper\ThemeB\img27.jpg | 3840x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Captured Motion)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 23 | src/assets/windows-wallpapers/win11_spectrum_01.webp | win11_spectrum_01 | Win11 Spectrum 1 | 3840x2400 | 713676 | 75.6 | C:\Windows\Web\Wallpaper\ThemeC\img28.jpg | 3840x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Sunrise)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 24 | src/assets/windows-wallpapers/win11_spectrum_02.webp | win11_spectrum_02 | Win11 Spectrum 2 | 3840x2400 | 1136222 | 120.4 | C:\Windows\Web\Wallpaper\ThemeC\img29.jpg | 3840x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Sunrise)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 25 | src/assets/windows-wallpapers/win11_spectrum_03.webp | win11_spectrum_03 | Win11 Spectrum 3 | 3840x2400 | 444936 | 47.1 | C:\Windows\Web\Wallpaper\ThemeC\img30.jpg | 3840x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Sunrise)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 26 | src/assets/windows-wallpapers/win11_spectrum_04.webp | win11_spectrum_04 | Win11 Spectrum 4 | 3840x2400 | 606796 | 64.3 | C:\Windows\Web\Wallpaper\ThemeC\img31.jpg | 3840x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Sunrise)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 27 | src/assets/windows-wallpapers/win11_flow_01.webp | win11_flow_01 | Win11 Flow 1 | 3840x2399 | 164268 | 17.4 | C:\Windows\Web\Wallpaper\ThemeD\img32.jpg | 3841x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Flow)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 28 | src/assets/windows-wallpapers/win11_flow_02.webp | win11_flow_02 | Win11 Flow 2 | 3840x2399 | 131532 | 13.9 | C:\Windows\Web\Wallpaper\ThemeD\img33.jpg | 3841x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Flow)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 29 | src/assets/windows-wallpapers/win11_flow_03.webp | win11_flow_03 | Win11 Flow 3 | 3840x2400 | 124994 | 13.2 | C:\Windows\Web\Wallpaper\ThemeD\img34.jpg | 3840x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Flow)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 30 | src/assets/windows-wallpapers/win11_flow_04.webp | win11_flow_04 | Win11 Flow 4 | 3840x2400 | 124270 | 13.2 | C:\Windows\Web\Wallpaper\ThemeD\img35.jpg | 3840x2400 | Microsoft Corp. 著作物 (Windows 同梱テーマ Flow)。公式単体配布なし。Windows EULA に再配布許諾なし | 要判断 |
| 31 | src/assets/catppuccin-wallpapers/catppuccin_3d_model.webp | catppuccin_3d_model | 3D Model | 3840x2160 | 115426 | 13.6 | https://raw.githubusercontent.com/orangci/walls-catppuccin-mocha/master/3d-model.jpg | 3840x2160 | LICENSE なし。収集者が著作権を持たないと README で明言。原著作者不明 | 要判断 |
| 32 | src/assets/catppuccin-wallpapers/catppuccin_abandoned_station.webp | catppuccin_abandoned_station | Abandoned Station | 2339x1654 | 1262984 | 318.8 | https://raw.githubusercontent.com/orangci/walls-catppuccin-mocha/master/abandoned-trainstation.jpg | 2339x1654 | LICENSE なし。収集者が著作権を持たないと README で明言。原著作者不明 | 要判断 |
| 33 | src/assets/catppuccin-wallpapers/catppuccin_abstract_swirls.webp | catppuccin_abstract_swirls | Abstract Swirls | 2560x1440 | 408794 | 108.3 | https://raw.githubusercontent.com/orangci/walls-catppuccin-mocha/master/abstract-swirls.jpg | 2560x1440 | LICENSE なし。収集者が著作権を持たないと README で明言。原著作者不明 | 要判断 |
| 34 | src/assets/catppuccin-wallpapers/catppuccin_aesthetic.webp | catppuccin_aesthetic | Aesthetic | 1920x1080 | 224982 | 106.0 | https://raw.githubusercontent.com/orangci/walls-catppuccin-mocha/master/aesthetic.jpg | 1920x1080 | LICENSE なし。収集者が著作権を持たないと README で明言。原著作者不明 | 要判断 |
| 35 | src/assets/catppuccin-wallpapers/catppuccin_artificial_valley.webp | catppuccin_artificial_valley | Artificial Valley | 1920x1030 | 256606 | 126.7 | https://raw.githubusercontent.com/orangci/walls-catppuccin-mocha/master/artificial-valley.jpg | 1920x1030 | LICENSE なし。収集者が著作権を持たないと README で明言。原著作者不明 | 要判断 |
| 36 | src/assets/catppuccin-wallpapers/catppuccin_atlantis.webp | catppuccin_atlantis | Atlantis | 1920x967 | 318682 | 167.6 | https://raw.githubusercontent.com/orangci/walls-catppuccin-mocha/master/atlantis.jpg | 1920x967 | LICENSE なし。収集者が著作権を持たないと README で明言。原著作者不明 | 要判断 |
| 37 | src/assets/catppuccin-wallpapers/catppuccin_black_hole.webp | catppuccin_black_hole | Black Hole | 3840x2160 | 183396 | 21.6 | https://raw.githubusercontent.com/orangci/walls-catppuccin-mocha/master/black-hole.png | 3840x2160 | LICENSE なし。収集者が著作権を持たないと README で明言。原著作者不明 | 要判断 |
| 38 | src/assets/catppuccin-wallpapers/catppuccin_blue_landscape.webp | catppuccin_blue_landscape | Blue Landscape | 2912x1632 | 952728 | 195.8 | https://raw.githubusercontent.com/orangci/walls-catppuccin-mocha/master/blue-landscape.png | 2912x1632 | LICENSE なし。収集者が著作権を持たないと README で明言。原著作者不明 | 要判断 |
| 39 | src/assets/catppuccin-wallpapers/catppuccin_bluehour.webp | catppuccin_bluehour | Blue Hour | 1920x1080 | 274814 | 129.4 | https://raw.githubusercontent.com/orangci/walls-catppuccin-mocha/master/bluehour.jpg | 1920x1080 | LICENSE なし。収集者が著作権を持たないと README で明言。原著作者不明 | 要判断 |
| 40 | src/assets/catppuccin-wallpapers/catppuccin_blueprint.webp | catppuccin_blueprint | Blueprint | 1920x1170 | 410478 | 178.4 | https://raw.githubusercontent.com/orangci/walls-catppuccin-mocha/master/blueprint.png | 1920x1170 | LICENSE なし。収集者が著作権を持たないと README で明言。原著作者不明 | 要判断 |
| 41 | src/assets/catppuccin-wallpapers/catppuccin_bsod.webp | catppuccin_bsod | BSOD | 1920x1080 | 44044 | 20.7 | https://raw.githubusercontent.com/orangci/walls-catppuccin-mocha/master/bsod.png | 1920x1080 | LICENSE なし。収集者が著作権を持たないと README で明言。原著作者不明 | 要判断 |
| 42 | src/assets/catppuccin-wallpapers/catppuccin_cabin.webp | catppuccin_cabin | Cabin | 1920x1080 | 153990 | 72.5 | https://raw.githubusercontent.com/orangci/walls-catppuccin-mocha/master/cabin-3.png | 1920x1080 | LICENSE なし。収集者が著作権を持たないと README で明言。原著作者不明。原本は cabin.png ではなく cabin-3.png | 要判断 |
| 43 | src/assets/warp-themes/dark_city_bg.webp | dark_city | Dark City | 2278x1556 | 361836 | 99.7 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/dark_city_bg.jpg | 2278x1556 | Apache-2.0 (warpdotdev/themes)。写真素材の一次著作者はリポジトリ内に記載なし | 再取得可 |
| 44 | src/assets/warp-themes/jellyfish_bg.webp | jellyfish | Jellyfish | 2048x1536 | 409998 | 127.3 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/jellyfish_bg.jpg | 2048x1536 | Apache-2.0 (warpdotdev/themes)。写真素材の一次著作者はリポジトリ内に記載なし | 再取得可 |
| 45 | src/assets/warp-themes/koi_bg.webp | koi | Koi | 2048x1536 | 248140 | 77.0 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/koi_bg.jpg | 2048x1536 | Apache-2.0 (warpdotdev/themes)。写真素材の一次著作者はリポジトリ内に記載なし | 再取得可 |
| 46 | src/assets/warp-themes/leafy_bg.webp | leafy | Leafy | 2048x1536 | 349572 | 108.5 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/leafy_bg.jpg | 2048x1536 | Apache-2.0 (warpdotdev/themes)。写真素材の一次著作者はリポジトリ内に記載なし | 再取得可 |
| 47 | src/assets/warp-themes/marble_bg.webp | marble | Marble | 2356x1538 | 167844 | 45.2 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/marble_bg.jpg | 2356x1538 | Apache-2.0 (warpdotdev/themes)。写真素材の一次著作者はリポジトリ内に記載なし | 再取得可 |
| 48 | src/assets/warp-themes/pink_city_bg.webp | pink_city | Pink City | 2356x1538 | 102572 | 27.6 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/pink_city_bg.jpg | 2356x1538 | Apache-2.0 (warpdotdev/themes)。写真素材の一次著作者はリポジトリ内に記載なし | 再取得可 |
| 49 | src/assets/warp-themes/red_rock_bg.webp | red_rock | Red Rock | 2048x1536 | 504430 | 156.6 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/red_rock_bg.jpg | 2048x1536 | Apache-2.0 (warpdotdev/themes)。写真素材の一次著作者はリポジトリ内に記載なし | 再取得可 |
| 50 | src/assets/warp-themes/snowy_bg.webp | snowy | Snowy | 2356x1538 | 413870 | 111.5 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/snowy_bg.jpg | 2356x1538 | Apache-2.0 (warpdotdev/themes)。写真素材の一次著作者はリポジトリ内に記載なし | 再取得可 |
| 51 | src/assets/warp-themes/thanksgiving_bg.webp | thanksgiving | Thanksgiving | 2048x1536 | 791714 | 245.8 | https://raw.githubusercontent.com/warpdotdev/themes/main/special_edition/thanksgiving_bg.jpg | 2048x1536 | Apache-2.0 (warpdotdev/themes)。季節企画配布・第三者IPの写り込みなし | 再取得可 |
| 52 | src/assets/warp-themes/winter_bg.webp | winter | Winter | 4549x3252 | 2505820 | 165.4 | https://raw.githubusercontent.com/warpdotdev/themes/main/special_edition/winter_bg.jpg | 4549x3252 | Apache-2.0 (warpdotdev/themes)。季節企画配布・第三者IPの写り込みなし | 再取得可 |
| 53 | src/assets/warp-themes/pride_bg.webp | pride | Pride | 3072x2304 | 73406 | 10.1 | https://raw.githubusercontent.com/warpdotdev/themes/main/special_edition/pride_bg.jpg | 3072x2304 | Apache-2.0 (warpdotdev/themes)。生成グラデーションで第三者IPの写り込みなし | 再取得可 |
| 54 | src/assets/warp-themes/warp.webp | warp | Warp | 3840x2160 | 50482 | 5.9 | https://raw.githubusercontent.com/warpdotdev/themes/main/warp_bundled/warp.jpg | 3840x2160 | Apache-2.0 だが Warp のロゴ・ワードマークが写り込む。商標は Apache-2.0 §6 で許諾対象外 | 要判断 |
| 55 | src/assets/warp-themes/asteroid_city_wallpaper.webp | asteroid_city | Asteroid City | 3517x1978 | 2317936 | 325.4 | https://images7.alphacoders.com/130/1308697.jpeg | 3517x1978 | Apache-2.0 だが映画『Asteroid City』(Focus Features) 連動のプロモ素材。作品名・原作権利の扱いが不明 | 要判断 |
| 56 | src/assets/warp-themes/barbie_bg.webp | barbie | Barbie | 4097x2732 | 198866 | 17.4 | https://raw.githubusercontent.com/warpdotdev/themes/main/special_edition/barbie_bg.jpg | 4097x2732 | Apache-2.0 だが映画『Barbie』(Warner Bros./Mattel) 連動のプロモ素材。作品名・原作権利の扱いが不明 | 要判断 |
| 57 | src/assets/warp-themes/oppenheimer_bg.webp | oppenheimer | Oppenheimer | 4096x3254 | 419646 | 30.7 | https://raw.githubusercontent.com/warpdotdev/themes/main/special_edition/oppenheimer_bg.jpg | 4096x3254 | Apache-2.0 だが映画『Oppenheimer』(Universal) 連動のプロモ素材。作品名・原作権利の扱いが不明 | 要判断 |
| 58 | src/assets/warp-themes/lumon.webp | lumon | Lumon | 2560x1440 | 15238 | 4.0 | https://raw.githubusercontent.com/warpdotdev/themes/main/special_edition/lumon.jpg | 2560x1440 | Apache-2.0 だがドラマ『Severance』(Apple TV+) の Lumon Industries 連動。作品名の扱いが不明 | 要判断 |
| 59 | src/assets/warp-themes/grafbase_bg.webp | grafbase | Grafbase | 2400x1260 | 20506 | 6.6 | https://raw.githubusercontent.com/warpdotdev/themes/main/special_edition/grafbase_bg.jpg | 2400x1260 | Apache-2.0 だが Grafbase 社とのコラボ配布。社名の扱いが不明 | 要判断 |

<!-- LEDGER-TABLE-END -->

---

## 4. 同一性の検証方法 (記録)

「原本URL に書いた画像が本当に現行ファイルの元か」は、目視でなく機械的に確かめた。

1. 候補を実際にダウンロード / ローカルから読み込む
2. 双方を RGB 16×16 に縮小し、画素ごとの平均絶対差 (0〜255) を取る
3. 閾値 12 未満を「同一画像」と判定

結果: 58枚すべてが **0.069〜1.281** に収まった (不一致例との差は歴然で、別画像の場合は 18〜117)。
`win11_default_dark.webp` だけは756件を当たっても最小 28.79 で、どの候補とも一致しなかった (§6.4)。

第2段の上書きも同じ照合を必ず通してから実行した。実際に差し替えた57枚の一致スコアは
**0.069〜1.281**。閾値を超えたものを上書きした例は1枚も無い (`refresh.py` は距離が閾値を超えると
上書きを拒否して FAIL を返す)。

## 5. 再取得したときの容量 (第1段の見積もりと第2段の実績)

原本から「長辺 3840 以下へ縮小 (拡大はしない) → WebP q90 / method=6」で再エンコードした場合の容量。

| シナリオ | 対象 | 合計 |
|---|---|---|
| 差し替え前 | 59枚 | 12.68 MiB |
| A: 原本が特定できた58枚すべてを差し替え (第1段の**見積もり**) | 58枚 + 据え置き1枚 | 30.49 MiB (+17.80 MiB / ×2.4) |
| B: `再取得可` の11枚だけ差し替え (第1段の**見積もり**) | 11枚 + 据え置き48枚 | 14.41 MiB (+1.73 MiB / ×1.14) |
| **実際にやったこと (第2段の実績)** | **57枚 + 据え置き2枚** | **31.94 MiB (+19.26 MiB / ×2.52)** |

実績が見積もり A より 1.45 MiB 多いのは、`asteroid_city_wallpaper` の原本を Alphacoders の
高解像度版 (3517x1978) に乗り換えたぶん (466KB → 2.32MB)。逆に `winter_bg` は据え置いたので
そのぶんは増えていない。

伸び幅が大きいのは、差し替え前が極端に圧縮されていた macOS の正方形4枚と Windows 11 の Glow / Flow 系
(いずれも 5〜11 KB/MP)。たとえば `big_sur_night.webp` は 39KB → 1.12MB (×28.6)、
`mojave_night.webp` は 49KB → 578KB (×11.7)。

---

## 6. 第2段 (2026-08-20) — 実際に差し替えた記録

第1段は「どこから取れるか」を調べただけで、画像そのものは1枚も触っていない。
第2段で **59枚中57枚を実際に再取得して上書きした**。

### 6.1 やったこと

- 再エンコード条件: **長辺 3840 上限 (拡大はしない) / WebP quality 90 / method 6**
- 実行コマンド: `python scripts/wallpapers/refresh.py --only <id> ... --allow-review --apply
  --max-edge 3840 --quality 90 --method 6 --backup-dir C:/Users/miyaz/mycmux-wallpaper-backup/20260820`
- **上書き前の元ファイルは全数退避済み**: `C:\Users\miyaz\mycmux-wallpaper-backup\20260820\`
  (57枚。退避先をリポジトリ外に置いたのは、リポジトリに未追跡ファイルを残さないため)
- 退避した57枚は git HEAD のブロブと sha256 が完全一致することを確認済み (不一致 0件)
- 差し替えた57枚はすべて、取得した原本と**差し替え前のファイル**の画素一致を確認してから上書きした。
  一致スコア (16×16 RGB 平均絶対差) は **0.069〜1.281**、閾値は 12。一致しないものは1枚も上書きしていない
- **3840 上限の例外を2枚だけ設けた**: `barbie_bg` (4097x2732) と `oppenheimer_bg` (4096x3254) は
  差し替え前から 3840 を超えていて、上限を当てると解像度が落ちる。原本グリッド上の PSNR を実測すると
  上限あり 47.34 / 44.54 dB に対し原寸維持 48.27 / 45.43 dB と原寸のほうが良く、`oppenheimer_bg` は
  バイト数まで小さい (431,462 → 419,646) ため、**この2枚は `--max-edge 4097` で原寸のまま**再エンコードした。
  同じ理由で 4549px の `winter_bg` は据え置いている (§6.2) ので、判断としては一貫している

### 6.2 差し替えなかった2枚 (全数・区分と理由)

59枚は「差し替えた 57 / スキップ 1 / 見つからなかった 1」で全数が確定している。未処理は無い。

| # | ファイル | 区分 | 理由 |
|---:|---|---|---|
| 13 | `windows-wallpapers/win11_default_dark.webp` | **見つからなかった** | 原本が特定できない。候補を機械照合で全数当たったが一致0件 (§6.4) |
| 52 | `warp-themes/winter_bg.webp` | **スキップ** | 原本は特定済み (一致 0.095) だが、差し替えると画質が下がる。現行 4549x3252 に対し再エンコードは 3840x2745 への縮小になり、原本に対する PSNR が 37.97dB → 34.57dB と実測で悪化する。`barbie` / `oppenheimer` と違い、原寸維持だと 4549px のまま巨大 (2.5MB) なので上限の例外にはせず据え置いた |

### 6.3 第2段で新しく分かったこと

- **Warp の背景写真12枚には Unsplash / Alphacoders の一次クレジットがリポジトリ内に存在した**。
  第1段は README の1件しか拾えておらず「一次著作者は記載されていない」と書いたが、これは誤り。
  `special_edition/*.yaml` と `warp_bundled/*.yaml` の `credit:` 行に個別に書かれている (§6.5)
- そのうち `asteroid_city_wallpaper.webp` だけは **クレジット先の方が高解像度だった**
  (Alphacoders 3517x1978 / Warp リポジトリ 1920x1080)。一致スコア 0.682 を確認のうえ、
  原本URLを Alphacoders 側に差し替えて再エンコードした。**これが今回唯一の「原本を乗り換えた」例**
- 残り11枚の Unsplash 原本は **この PC から取得できなかった**。`unsplash.com` が
  Anubis (`within.website`) のボット検査を返し、ページ・napi・download の全経路が 401 になる。
  CDN 側 (`images.unsplash.com`) は到達できるが、短縮ID から CDN のファイル名を引く経路が
  上記のブロック対象にしか無いため辿れない。**未取得のまま**とし、原本URLは warpdotdev のままにしてある
- なお Warp の背景は Unsplash 原本をトリミングしている疑いが強い (`2278x1556`・`2356x1538` など
  写真として不自然な縦横比)。仮に Unsplash 原本が取れても、そのまま差し替えると**絵の切り取り方が
  変わる**ので、一致照合を通らない可能性が高い
- Catppuccin 12枚は、2つのコレクション (`orangci/walls-catppuccin-mocha` 333枚 /
  `zhichaoh/catppuccin-wallpapers` 242枚) の**全575枚と画素照合**した。12枚すべて、第1段が記録した
  ファイルが最良一致であり、**より高解像度の同一画像はどちらにも存在しなかった**
- Windows の `img26.jpg` / `img32.jpg` / `img33.jpg` は原本が 3841x2400 で、長辺 3840 の上限に
  1px だけ引っかかるため 3840x2399 に縮小されている。上限を 3841 にして無変換で通す案も実測したが、
  PSNR 差は +0.38dB / +0.03dB / -0.02dB とほぼ無いので、仕様どおり 3840 上限を優先した
  (`barbie` / `oppenheimer` を例外にしたのは差が +0.93dB / +0.89dB と桁違いに大きかったため)
- `catppuccin_atlantis.webp` は 1920x**968** から 1920x**967** へ 1px 縮んだ。これは原本
  (`atlantis.jpg`) が 1920x967 であるため。差し替え前のファイルのほうが 1px 多かった

### 6.4 `win11_default_dark.webp` の捜索結果 — 見つからなかった

第1段では「この PC の Windows 壁紙18枚と不一致」までしか調べていなかった。第2段で範囲を広げ、
**合計756件の候補を機械照合した**。閾値12に対し、**最小距離は 28.79 で一致0件**。

| 探索先 | 照合数 | 最小距離 |
|---|---:|---:|
| この PC の `C:\Windows\Web\` 配下 全画像 (Wallpaper / Extended / Spotlight / Screen / touchkeyboard) | 36 | 34.04 |
| wallhaven.cc (abstract・lines・swirl・waves・fluid・curves の6検索 × 2ページ、サムネイル照合) | 128 | 28.79 |
| `orangci/walls-catppuccin-mocha` + `zhichaoh/catppuccin-wallpapers` + `warpdotdev/themes` の全画像 | 592 | 30.05 |
| **合計** | **756** | **28.79** |

つまり **同梱壁紙の出所として判明している全コレクションにも、この PC にも存在しない**。
Web 検索でも同一と断定できる配布元は見つからなかった。**原本URL は引き続き `未特定`、判定は
`再取得不可 (据え置き)`**。憶測の URL は書かない。

### 6.5 Warp 背景写真の一次クレジット (リポジトリ内 `credit:` 行の実データ)

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
| `barbie_bg.webp` | https://unsplash.com/photos/2PN18U8CKi0 |
| `oppenheimer_bg.webp` | https://unsplash.com/photos/d8AgCj2epJc |
| `asteroid_city_wallpaper.webp` | https://wall.alphacoders.com/big.php?i=1308697 (**採用済み**) |

`pride_bg` / `warp` / `lumon` / `grafbase_bg` にはクレジット行が無い (Warp 自製のアート)。

### 6.6 容量

| | 合計バイト | |
|---|---:|---|
| 差し替え前 | 13,295,874 | 12.68 MiB |
| 差し替え後 | 33,487,672 | 31.94 MiB |
| 差分 | +20,191,798 | +19.26 MiB (×2.52) |

**この増分は宮崎さんの判断材料**: アプリ本体が 32〜42MB なので、壁紙だけで同程度を占めることになる。
容量を抑えたい場合の効きどころは大きい順に
`high_sierra` (2.56MB) / `winter_bg` (2.51MB・据え置き) / `asteroid_city_wallpaper` (2.32MB) /
`el_capitan` (2.23MB) / `sierra` (2.14MB)。quality を 90 から下げれば全体が比例して縮む。

### 6.7 全59枚の before / after (全数)

- **一致スコア** = 「取得した原本」と「差し替え前のファイル」の 16×16 RGB 平均絶対差 (閾値12)
- **PSNR** = 原本のグリッド上で測った忠実度。前後で同じ基準なので直接比較できる。高いほど原本に近い

| # | ファイル | 結果 | 前寸法 | 後寸法 | 前バイト | 後バイト | 前KB/MP | 後KB/MP | 前PSNR | 後PSNR | 一致スコア |
|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | monterey_dark.webp | 差し替え | 2560x2560 | 3840x3840 | 35,164 | 126,190 | 5.2 | 8.4 | 42.29 | 42.90 | 0.297 |
| 2 | ventura_dark.webp | 差し替え | 2560x2560 | 3840x3840 | 54,458 | 182,204 | 8.1 | 12.1 | 43.17 | 45.62 | 0.613 |
| 3 | big_sur_night.webp | 差し替え | 2560x2560 | 3840x3840 | 39,072 | 1,118,298 | 5.8 | 74.1 | 32.59 | 33.22 | 0.688 |
| 4 | mojave_night.webp | 差し替え | 2560x1440 | 3840x2160 | 49,326 | 577,876 | 13.1 | 68.0 | 37.04 | 39.48 | 0.490 |
| 5 | sonoma_dark.webp | 差し替え | 2560x2560 | 3840x3840 | 48,212 | 178,584 | 7.2 | 11.8 | 44.80 | 46.32 | 0.198 |
| 6 | high_sierra.webp | 差し替え | 2560x1440 | 3840x2160 | 685,064 | 2,556,254 | 181.5 | 301.0 | 27.84 | 33.87 | 0.517 |
| 7 | sierra.webp | 差し替え | 2560x1440 | 3840x2160 | 588,064 | 2,142,436 | 155.8 | 252.2 | 24.81 | 29.15 | 0.365 |
| 8 | el_capitan.webp | 差し替え | 2560x1600 | 3840x2400 | 493,820 | 2,225,042 | 117.7 | 235.8 | 28.47 | 33.44 | 0.303 |
| 9 | yosemite.webp | 差し替え | 2560x1440 | 3840x2160 | 418,794 | 1,616,092 | 110.9 | 190.3 | 30.41 | 36.82 | 0.208 |
| 10 | antelope_canyon.webp | 差し替え | 2560x1440 | 3840x2160 | 310,964 | 1,301,412 | 82.4 | 153.2 | 32.78 | 37.17 | 0.227 |
| 11 | earth_and_moon.webp | 差し替え | 2560x1440 | 3840x2160 | 62,502 | 186,874 | 16.6 | 22.0 | 41.33 | 45.29 | 0.217 |
| 12 | milky_way.webp | 差し替え | 2560x1440 | 3840x2160 | 183,664 | 501,740 | 48.7 | 59.1 | 37.40 | 42.14 | 0.229 |
| 13 | win11_default_dark.webp | 見つからなかった | 2560x2048 | 2560x2048 | 735,648 | 735,648 | 137.0 | 137.0 | - | - | - |
| 14 | win11_default_bloom.webp | 差し替え | 2560x1600 | 3840x2400 | 110,750 | 291,630 | 26.4 | 30.9 | 39.38 | 44.58 | 0.272 |
| 15 | win11_bloom_01.webp | 差し替え | 2560x1600 | 3840x2400 | 33,946 | 114,006 | 8.1 | 12.1 | 45.55 | 47.96 | 0.238 |
| 16 | win11_bloom_02.webp | 差し替え | 2560x1600 | 3840x2400 | 37,202 | 136,468 | 8.9 | 14.5 | 44.47 | 46.98 | 0.260 |
| 17 | win11_bloom_03.webp | 差し替え | 2560x1600 | 3840x2400 | 36,156 | 143,144 | 8.6 | 15.2 | 45.05 | 47.33 | 0.276 |
| 18 | win11_bloom_04.webp | 差し替え | 2560x1600 | 3840x2400 | 38,002 | 140,960 | 9.1 | 14.9 | 44.67 | 47.06 | 0.210 |
| 19 | win11_motion_01.webp | 差し替え | 2560x1600 | 3840x2401 | 168,384 | 600,828 | 40.1 | 63.6 | 34.18 | 39.26 | 0.639 |
| 20 | win11_motion_02.webp | 差し替え | 2560x1600 | 3840x2400 | 164,880 | 668,610 | 39.3 | 70.8 | 33.90 | 40.24 | 0.736 |
| 21 | win11_motion_03.webp | 差し替え | 2560x1600 | 3840x2399 | 176,046 | 529,514 | 42.0 | 56.1 | 34.72 | 39.73 | 0.258 |
| 22 | win11_motion_04.webp | 差し替え | 2560x1600 | 3840x2400 | 154,032 | 408,368 | 36.7 | 43.3 | 36.92 | 42.34 | 0.368 |
| 23 | win11_spectrum_01.webp | 差し替え | 2560x1600 | 3840x2400 | 117,524 | 713,676 | 28.0 | 75.6 | 37.01 | 42.73 | 0.336 |
| 24 | win11_spectrum_02.webp | 差し替え | 2560x1600 | 3840x2400 | 278,074 | 1,136,222 | 66.3 | 120.4 | 33.42 | 41.53 | 0.302 |
| 25 | win11_spectrum_03.webp | 差し替え | 2560x1600 | 3840x2400 | 93,778 | 444,936 | 22.4 | 47.1 | 39.00 | 43.93 | 0.233 |
| 26 | win11_spectrum_04.webp | 差し替え | 2560x1600 | 3840x2400 | 90,588 | 606,796 | 21.6 | 64.3 | 37.28 | 43.22 | 0.354 |
| 27 | win11_flow_01.webp | 差し替え | 2560x1600 | 3840x2399 | 61,636 | 164,268 | 14.7 | 17.4 | 43.01 | 47.17 | 0.337 |
| 28 | win11_flow_02.webp | 差し替え | 2560x1600 | 3840x2399 | 45,482 | 131,532 | 10.8 | 13.9 | 44.96 | 47.62 | 0.396 |
| 29 | win11_flow_03.webp | 差し替え | 2560x1600 | 3840x2400 | 44,774 | 124,994 | 10.7 | 13.2 | 44.49 | 47.73 | 0.319 |
| 30 | win11_flow_04.webp | 差し替え | 2560x1600 | 3840x2400 | 46,200 | 124,270 | 11.0 | 13.2 | 45.37 | 48.04 | 0.355 |
| 31 | catppuccin_3d_model.webp | 差し替え | 2560x1440 | 3840x2160 | 42,894 | 115,426 | 11.4 | 13.6 | 42.32 | 48.17 | 0.884 |
| 32 | catppuccin_abandoned_station.webp | 差し替え | 2339x1654 | 2339x1654 | 863,664 | 1,262,984 | 218.0 | 318.8 | 33.42 | 36.57 | 0.189 |
| 33 | catppuccin_abstract_swirls.webp | 差し替え | 2560x1440 | 2560x1440 | 267,180 | 408,794 | 70.8 | 108.3 | 37.50 | 40.95 | 0.307 |
| 34 | catppuccin_aesthetic.webp | 差し替え | 1920x1080 | 1920x1080 | 136,292 | 224,982 | 64.2 | 106.0 | 38.96 | 43.65 | 0.280 |
| 35 | catppuccin_artificial_valley.webp | 差し替え | 1920x1030 | 1920x1030 | 162,468 | 256,606 | 80.2 | 126.7 | 38.51 | 42.76 | 0.327 |
| 36 | catppuccin_atlantis.webp | 差し替え | 1920x968 | 1920x967 | 194,872 | 318,682 | 102.4 | 167.6 | 34.12 | 37.40 | 0.233 |
| 37 | catppuccin_black_hole.webp | 差し替え | 2560x1440 | 3840x2160 | 72,368 | 183,396 | 19.2 | 21.6 | 39.54 | 47.51 | 1.174 |
| 38 | catppuccin_blue_landscape.webp | 差し替え | 2560x1434 | 2912x1632 | 437,932 | 952,728 | 116.5 | 195.8 | 31.01 | 36.50 | 0.770 |
| 39 | catppuccin_bluehour.webp | 差し替え | 1920x1080 | 1920x1080 | 176,294 | 274,814 | 83.0 | 129.4 | 37.56 | 40.73 | 0.203 |
| 40 | catppuccin_blueprint.webp | 差し替え | 1920x1170 | 1920x1170 | 242,050 | 410,478 | 105.2 | 178.4 | 33.01 | 38.37 | 1.281 |
| 41 | catppuccin_bsod.webp | 差し替え | 1920x1080 | 1920x1080 | 36,524 | 44,044 | 17.2 | 20.7 | 42.48 | 45.79 | 0.694 |
| 42 | catppuccin_cabin.webp | 差し替え | 1920x1080 | 1920x1080 | 94,368 | 153,990 | 44.4 | 72.5 | 38.21 | 43.12 | 1.059 |
| 43 | dark_city_bg.webp | 差し替え | 2278x1556 | 2278x1556 | 235,160 | 361,836 | 64.8 | 99.7 | 39.53 | 41.42 | 0.486 |
| 44 | jellyfish_bg.webp | 差し替え | 2048x1536 | 2048x1536 | 172,034 | 409,998 | 53.4 | 127.3 | 38.15 | 41.49 | 0.536 |
| 45 | koi_bg.webp | 差し替え | 2048x1536 | 2048x1536 | 117,172 | 248,140 | 36.4 | 77.0 | 39.39 | 42.59 | 0.738 |
| 46 | leafy_bg.webp | 差し替え | 2048x1536 | 2048x1536 | 209,246 | 349,572 | 65.0 | 108.5 | 39.58 | 43.00 | 0.599 |
| 47 | marble_bg.webp | 差し替え | 2356x1538 | 2356x1538 | 90,006 | 167,844 | 24.3 | 45.2 | 43.97 | 46.18 | 0.069 |
| 48 | pink_city_bg.webp | 差し替え | 2356x1538 | 2356x1538 | 36,546 | 102,572 | 9.8 | 27.6 | 42.87 | 45.13 | 0.742 |
| 49 | red_rock_bg.webp | 差し替え | 2048x1536 | 2048x1536 | 272,280 | 504,430 | 84.5 | 156.6 | 37.43 | 40.83 | 0.628 |
| 50 | snowy_bg.webp | 差し替え | 2356x1538 | 2356x1538 | 266,792 | 413,870 | 71.9 | 111.5 | 39.16 | 43.15 | 0.616 |
| 51 | thanksgiving_bg.webp | 差し替え | 2048x1536 | 2048x1536 | 507,892 | 791,714 | 157.7 | 245.8 | 36.92 | 41.21 | 0.503 |
| 52 | winter_bg.webp | スキップ | 4549x3252 | 4549x3252 | 2,505,820 | 2,505,820 | 165.4 | 165.4 | - | - | - |
| 53 | pride_bg.webp | 差し替え | 3072x2304 | 3072x2304 | 36,728 | 73,406 | 5.1 | 10.1 | 46.56 | 49.02 | 0.611 |
| 54 | warp.webp | 差し替え | 3840x2160 | 3840x2160 | 37,302 | 50,482 | 4.4 | 5.9 | 47.74 | 50.36 | 0.578 |
| 55 | asteroid_city_wallpaper.webp | 差し替え | 1920x1080 | 3517x1978 | 281,374 | 2,317,936 | 132.5 | 325.4 | 28.10 | 35.01 | 0.682 |
| 56 | barbie_bg.webp | 差し替え | 4097x2732 | 4097x2732 | 117,554 | 198,866 | 10.3 | 17.4 | 45.77 | 48.27 | 0.443 |
| 57 | oppenheimer_bg.webp | 差し替え | 4096x3254 | 4096x3254 | 256,246 | 419,646 | 18.8 | 30.7 | 42.75 | 45.43 | 0.441 |
| 58 | lumon.webp | 差し替え | 2560x1440 | 2560x1440 | 10,954 | 15,238 | 2.9 | 4.0 | 47.94 | 48.19 | 0.342 |
| 59 | grafbase_bg.webp | 差し替え | 2400x1260 | 2400x1260 | 13,656 | 20,506 | 4.4 | 6.6 | 46.71 | 51.10 | 0.590 |

差し替えた57枚は **全枚で PSNR が上がっている** (最小 +0.25dB `lumon` / 最大 +8.11dB `win11_spectrum_02`)。
解像度が上がったのは33枚、据え置きが23枚、下がったのは `catppuccin_atlantis` の 1px のみ。
