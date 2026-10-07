# 合成のエージェントホーム

prepare_home.py は標準ライブラリだけで Claude だけ・Codex だけ・両方・空の 4 種を生成する。実在する名前・住所・資格情報は含めない。文書内のメールは sample@example.test。

`python tests/fixtures/agent_home/prepare_home.py <出力先>` で 4 種を作る。`--variant both` などを付けると指定の 1 種を出力先へ直接作る。Rust の試験は一時ディレクトリでこれを実行し、実物の読み手を通す。Hermes だけの状態は空のホームから試験内で作る。

CANARY_SECRET_7F3A は env・MCP・hooks の引数・鍵のファイル・記憶本文・default.rules に入っている。CANARY_BODY_9C1D は始めの attachment / 指示の後の会話本文にある。目録・API・キャッシュに混ざらないことに加え、ファイルを開いた一覧と会話を止めた位置を確かめる。catalog.ts は React の操作確認用の合成目録。
