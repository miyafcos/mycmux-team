# 壁紙のオンデマンド配信

配布対象の壁紙11枚を、**選んだときにダウンロードする**方式にした設計の正本。

- フロント: `src/lib/themeBackgrounds.ts` (プリセット表・サムネイル import) /
  `src/lib/wallpaperCache.ts` (キャッシュ状態・DL・純関数) /
  `src/components/theme/ThemeBackgroundPanel.tsx` (ピッカー) /
  `src/components/layout/AppShell.tsx` (描画・裏DL)
- バックエンド: `src-tauri/src/commands/wallpapers.rs`
- 生成スクリプト: `scripts/wallpapers/`
- 契約テスト: `tests/test_wallpaper_pack_contract.py` / `tests/unit/wallpaperOnDemand.test.ts` /
  `wallpapers.rs` 内の `#[cfg(test)]`

## なぜ

原本11枚の一括同梱を避け、必要な壁紙だけ取得する。
利用者が選んだ壁紙だけを取得すれば、初回インストールの転送量を抑えられる。

## 原則

**同梱するのはサムネイルだけ。実体は使うときに落とす。**

1. **既定の背景は単色** (`DEFAULT_THEME_BACKGROUND.mode = "solid"`)。
   新規インストール直後は1枚も落ちていない
2. **サムネイル (長辺320px・11枚で約64KiB) は同梱する**。
   これが無いとオフラインでピッカーが真っ白になり、DL前に何の壁紙か分からない
3. **実体は `<MYCMUX_RUNTIME_DIR>/wallpapers/`** (既定 `~/.mycmux/wallpapers/`)。
   ランタイムディレクトリ配下なのでテストプロファイルと自動的に分離される
4. **sha256 が一致したものだけ採用する**。不一致・サイズ違いは保存せず失敗扱い
5. **配布対象11枚の原本をリポジトリに保持する**。
   `src/assets/**` の11枚は配布パックを作る原本として残す

## 落とし穴 (壁紙を足す・差し替えるとき)

**原本を1枚でも足したら、下の3つを同じ操作の中で全部やる。** どれか1つでも欠けると、
ピッカーに出ない (サムネ欠け)・押すと必ず失敗する (マニフェスト欠け)・
404 になる (パック未公開) のいずれかになる。

```
python scripts/wallpapers/make_thumbnails.py     # サムネイル生成 (--check で照合)
python scripts/wallpapers/build_manifest.py      # マニフェスト生成 (--check で照合)
powershell -File scripts/wallpapers/publish_pack.ps1 -Execute   # 公開ミラーへ配布 (要承認)
```

`scripts/wallpapers/sources.json` が id → 原本パスの唯一の対応表で、
`THEME_BACKGROUND_PRESETS` と1対1であることを `tests/test_wallpaper_pack_contract.py` が機械照合する。

## 配信元

`https://github.com/miyafcos/mycmux-team/releases/download/<packTag>/<id>.webp`

**URLはマニフェストに焼き込まない**。アプリが `packTag` + ファイル名から組み立てる
(`resolve_download_url`)。配信元を差し替えるときは `sources.json` の `packTag` を
`wallpapers-v2` のように上げてマニフェストを作り直せばよく、11行を書き換える必要はない。

配布ファイル名は原本名ではなく `<id>.webp`。id は既に一意でURL安全で、
別ディレクトリに同名ファイルが置かれても衝突しないため。

## 既存ユーザーの扱い

**残る11枚の保存済み選択は維持する。** 旧ビルドで壁紙を選んでいたインストールは、
`data.json` に `mode: "preset"` とその id を持ったまま起動する。この状態では:

- 表示は**単色にフォールバック**する (`isWallpaperPaintable` が false)。
  実体が無いのに半透明パネルだけ効くと、何も無い上に薄いパネルが浮くことになるため、
  合成 (`mediaActive`) も単色として扱う
- 裏で1回だけDLを試みる。成功したらそのまま元の壁紙に戻る
- **失敗しても設定は変えない**。無限リトライもしない (オフラインのマシンが回り続けるため)。
  外観設定に理由と「再試行」を出す

削除された48枚の保存済み id は正規化時に既定の `dark_city` へ戻す。
表示モードと調整値は保持する。旧キャッシュは現行 manifest の列挙対象外となり、
読込・キャッシュ消去処理の妨げにならず、そのまま残る。

## 失敗を無言にしない

このリポジトリでは過去に「AI案の無言失敗」で指摘を受けている。壁紙DLの失敗は3か所に出る:

| 場所 | 出るもの |
|---|---|
| カード右上のバッジ | 灰色の下矢印 (未DL) → `NN%` (DL中) → 警告アイコン (失敗) |
| グリッド直下 | 失敗した壁紙名・理由の全数列挙 + 「再試行」 |
| 選択中の壁紙が未DLのとき | グリッド上部に状態と「今すぐ取得」 |

失敗したときは**選択を変えない**。押した壁紙に切り替わったのに単色、という状態を作らない。
