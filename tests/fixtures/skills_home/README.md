# 合成ホームと画面検証

prepare_home.py は新しい一時フォルダだけを対象に、架空のスキル・入口・写し・コマンド・プラグイン・会話一覧・利用記録・鍵に似た偽ファイル・壊れた junction を作る。

Rust の skills テストから呼ぶ。MYCMUX_POCKET_SOURCE を pocket の作業フォルダへ向けると、同じホームの Python collect_skills と build_plan の結果を python-expected.json に作り、Rust と照らす。実物のホームは書き換えない。

ui.html / ui.tsx は Vite で開く写真用の入口。実物の SkillsPanel と、162本の架空の目録を使う。?theme=light でライトに切り替える。本文・置き場所・差分・フォルダ・共有の候補を props の api から供給する。個人のファイルや稼働中サーバを使用しない。
