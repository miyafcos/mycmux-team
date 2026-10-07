# エージェント設計・段 A

剣と盾の入口から、概要・読み方・比べる・点検を開く。スキルは概要の「道具と手順」から既存の SkillsView を読むだけで開く。起動・修正・書き出しはここには置かない。

Claude Code と Codex の読み手をサービスごとに分け、Hermes は名前・置き場所・有無・数だけ扱う。各項目に層、フルパス、大きさ、読まれる時期、根拠、更新日時を持たせる。設定は許可した項目だけ返し、知らない項目は数と「未対応」を返す。鍵のファイルは開かず、環境変数と Claude の MCP は数だけ返す。hooks の引数は返さない。記憶の本文と default.rules は表示しない。

会話記録は行数・バイト数を制限して先頭から読む。Claude は最初の assistant または上限、Codex は最初の依頼または world_state の本文の前、あるいは上限で止める。目録に入るのは説明の字数・名前・節の字数だけで、記録の本文は保存しない。Codex は cwd が一致し、ファイルの更新日時が最新の session_meta を選ぶ。欠測は null のまま扱い、確認できた分と合計を区別する。paths の一致は宣言の照合であり、実際に読まれた回数ではない。

利用者側への書き込みは ~/.mycmux/agent_design/ の cache.json、catalog.json、closed.json、locations.json と、同時更新用の closed.lock だけ。cache は作業フォルダ別に最大 8 件、catalog は最後の 1 作業フォルダの 4 面を持つ。closed は安定した id・理由・閉じた日時・作業フォルダ・pc/iphone を保存し、両方の書き手がロック中に最新を読み直して重ねる。ファイルの型と配信の決まりは agent-design-catalog-v1.md を参照する。links.json の任意の宣言は { "links": [{ "id", "event", "via", "script", "writePath", "targetService" }] } の形。宣言が無ければ生成元のつながりは出さない。個人のパスや設定を製品に含めない。

既存のスキルの配置読み手・安全な文書表示・プレビューはソースを再利用する。既存の会話走査、キャッシュ更新、起動、書き出しは呼ばない。埋め込み用の API は agent_design_skills / agent_design_skill_read。

合成ホームは tests/fixtures/agent_home/prepare_home.py で 4 種を生成する。Rust は読み手、会話の停止位置、秘密の目印、条件、定期ジョブ、点検、閉じた理由、キャッシュの範囲を検査する。Vitest は入口・4 面・キーボード・読み取り専用の埋め込み・閉じる操作・未対応の表示を検査する。
