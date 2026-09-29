# エージェント連携

設定 → AI の「Claude Code スキル」の直後に、Claude Code・Codex・Grok の hook の状態を表示する。

| 状態 | 意味 |
| --- | --- |
| 入っています | 必要なイベントの自分の group が各 1 個あり、呼び先と helper が現在のもの。Codex は信頼の照合も通っている |
| 外しています | このエージェントの連携を外す設定を保存している |
| 使えません | 設定ファイルを読み取れない |
| 直す必要があります | 重複、欠け、呼び先の違い、Codex の未許可、または読み取れない設定形式がある |

「入れる」「直す」は選択したエージェントの設定だけを更新する。「外す」は確認を 1 回挟み、自分の group だけを外す。helper ファイルは削除しない。自分以外の handler が 1 個でも混ざった group は残す。

状態は `~/.mycmux/agent-hooks-state.json` に保存する。`version: 2` と `providers.<claude|codex|grok>.enabled` を持つ。旧形式の `enabled` は 3 エージェント共通として読み、設定画面で変更すると v2 に移す。起動時の処理もエージェントごとの値を守り、外した hook を入れ直さない。状態ファイルの形式が壊れている場合は処理を失敗として返し、全員を有効に戻さない。

Grok は `toml_edit` で配列テーブルを構造解析する。各 handler が `mycmux_managed = true` または対象エージェント用の mycmux hook の呼び先なら、自分の group とする。自分の group を原文の範囲で除いて 1 組を足すため、別の表とキーは再整形しない。旧コメントが消えた設定にも対応する。inline table や点つきキーなど、対応していない hooks の形は書き換えない。設定の読み取りから置換までの間に別の編集を検知した場合も置換しない。

Codex は最初の自分の group と同じ位置で置き換える。信頼の鍵に group 番号が含まれるため、末尾へ移さない。重複の削除や無効化によって後続 group の番号が変わる場合は Codex 側の再許可が必要になることがある。mycmux は Codex の許可を代行しない。「直す」の後も未許可と出る場合は Codex 側で許可し、「再確認」を押す。

## API

画面は Tauri の `agent_hooks_status` と `agent_hooks_set({provider, enabled})` を使う。返り値は同じ状態スナップショットで、状態の照会そのものはファイルも実行中の hook モードも変更しない。

```json
{
  "version": 2,
  "providers": [
    {"provider": "claude", "enabled": true, "state": "installed"},
    {"provider": "codex", "enabled": true, "state": "needs-repair", "reason": "untrusted"},
    {"provider": "grok", "enabled": false, "state": "disabled"}
  ]
}
```

`reason` は `duplicate`・`missing`・`helper-path`・`untrusted`・`unknown-shape`。同時に複数該当するときは形式、重複、欠け、呼び先、信頼の順で表示する。観測用 reconciler の `HookMode` とは区別し、導入状態が `installed` のときだけ `HookMode::Installed` に対応する。

socket の `agent.hooks.status` は Rust が直接答える読み取り専用コマンドである。入切を変える socket コマンドは公開しない。CLI の `hooks-status` は `system.version` の `agent.hooks.status` 能力を確認してから照会し、未対応の実行ファイルには照会を送らない。

```powershell
python scripts/mycmux_agent_cli.py hooks-status
```

実物を更新する前の確認手順と今回の fixture 差分は委譲の DONE.md に記録する。試験は一時ディレクトリに設定と helper を置き、稼働中アプリの socket を使わない。
