# エージェント設計の共通目録 v1

読者は pocket のサーバと iPhone の実装者。読み手は mycmux の Rust だけ。pocket はここに書く JSON を配り、Claude・Codex の設定や会話記録を解析しない。UTF-8・camelCase。場所は読んだホームの `.mycmux/agent_design/`。

## catalog.json

１ファイル＝最後に読み直した１作業フォルダの４面と、許可された文書の詳細。API の目録と同じオブジェクト。PC の `cache.json` は `{schemaVersion:1,contexts:Catalog[]}` の最大８フォルダの履歴で、巨大な場合は古いフォルダから32 MiB以内へ減らす。８フォルダ・32 MiBへの削減時はホーム（workFolderとhomeが同じcontext）を残し、ホーム以外の最も古いフォルダから削る。iPhone は履歴を必要としないので公開用の `catalog.json` を別に書く。各ファイルは同じディレクトリの一時ファイルを同期してから原子的に置き換える。２ファイル間の同時性は前提にせず、配信は catalog.json を正本とする。

| 項目 | 型・意味 |
|---|---|
| schemaVersion | integer、1 |
| generatedAt | string、ISO 8601、時差つき |
| generator | string、`mycmux/<版>` |
| home / workFolder | string、読んだホーム／作業フォルダのフルパス |
| cwd | string、PC API 互換の workFolder と同じ値 |
| refreshMs | number、読み直し時間、整数ミリ秒（JSONの往復で端数誤差を持ち込まない） |
| services | Service[]、claude / codex / hermes の３つ |
| layers | `{id:1..7,role:string,itemIds:string[]}[]`、上から表示するなら7→1 |
| items / links | Item[] / Link[]、共通の項目とつながり |
| readingFlows | `{service:string,steps:FlowStep[]}[]`、Claude/Codex 各12段、Hermes は空 |
| compareRows | CompareRow[]、下記の14行、各３サービスのセル |
| documents | `Record<itemId,Document>`、許可された文書だけ。無い本文は取得できないと表示 |
| findings | Finding[]、未閉鎖の点検。本文・鍵の値を含めない |
| closedCount / closedRevision | integer、このフォルダで閉じた件数／読んだ closed.json の版 |
| warnings | string[]、取得失敗などの識別子。未知の識別子も取得失敗と表示 |

`Service={id,displayName,root,state,version:string|null,settings:Field[],stats:Record<string,integer|null>,hooks:Hook[],session:Session,context:Context}`。state は present / absent / unknown。Field は `{key:string,value:string}`。stats は PC の数えた値をそのまま使い、null は「不明」、0 は実測の無し。主なキーは skillsOwn/skillsCodex/skillsAgents/skillsSystem/skillsSynced、rules/rulesAlways/rulesConditional/rulesAlwaysChars、memoryIndexChars/memoryIndexLines/memoryFiles、plugins/pluginsEnabled、mcp/mcpUser/mcpProject/mcpCommented、hookEvents/hookHandlers、scheduledJobs/scheduledEnabled、references/scripts/rulesBytes/allow/allowLocal。

`Item={id,service,layer:1..7,displayName,path:string|null,kind,status,size:Size,readTiming,evidence,modifiedAt:integer|null,fields:Field[],conditions:string[],documentAllowed:boolean,active:boolean}`。Size は `{chars,lines,bytes:integer|null}`、modifiedAt は Unix epoch ミリ秒。kind は runtime/settings/settingsLocal/instruction/override/shadowedInstruction/rule/memoryIndex/memoryDirectory/skill/skillListing/plugins/agent/command/mcp/hooks/scheduled/reference/script/privateCount 等。表示語に変換できない kind/field は「未対応」。readTiming は always / conditional / onDemand / event / schedule / outside / private。evidence は measured / product / declaration / estimated / unknown。conditions は paths の宣言で、実際に読まれた回数ではない。

`Link={id,from,to,sourceService,targetService,relation,evidence,line:integer|null,targetPath:string|null,exists:boolean|null}`。relation は executes/references/readsSource/shadows/declaredCall/generates。Hook は `{event,matcher,script,source,line:integer|null}`。script は引数を含まないファイル名か unsupported。

`Session={file:string|null,startedAt?:string|null,linesRead,bytesConsumed:integer,stoppedAt,listing:Listing,startupHooks:Field[],startupChars:integer|null,sections:{kind,chars:integer}[]}`。startedAtは見本に選んだ会話の開始日時（時差つきISO 8601）。Codexはcwd一致のsession_metaのtimestamp、無ければファイル名のローカル日時。Claudeは先頭行の本文前ヘッダのtimestamp、取れなければファイルの作成日時。一番新しい開始日時を選び、同点・開始日時が取れないときだけ更新日時で決める。本文へ入って日時を探さない。開始日時を取れない場合はnull、古い目録で項目が無い場合も時刻は「不明」と表示する。任意項目の追加なので末尾の互換性の決まりに従いschemaVersionは1のまま。stoppedAt は firstAssistant/firstRequest/worldState/lineLimit/byteLimit/eof/unsupported/unavailable。会話の本文はない。`Listing={count,chars:integer|null,entries:ListedSkill[],groups:{kind,count,chars}[],pluginCounts,disabledCounts:Record<string,integer>,disabledChars:integer|null}`。ListedSkill は `{name,chars:integer,kind,plugin:string|null,path:string|null,usageRecorded:boolean|null}`。group.kind は own/user/builtin/system/synced/command/plugin/unknown。

`Context={instructions,memory,listing,startup,product,total:integer|null,knownTotal:integer}`。product は製品が足す節で合計と別。total が null なら knownTotal を「確認できた分」と表示する。null を0として合計しない。Hermes は本文を持たず存在と数だけ。

`FlowStep={id,stage:0..6,timing,chars:integer|null,evidence,itemIds:string[],hookScripts:string[]}`。順に settings/instructions/memory/listing/startup/request/tools/conditional/skillBody/references/response/end。stage の表示語は起動／会話の始め／依頼のたび／道具のたび／必要なとき／応答のたび／会話の終わり。chars の無い conditional/onDemand は量が不明、outside は文脈の外。本文は documents[itemId] にあるものだけ使う。

`CompareRow={id,tag,cells:{service,state,itemIds:string[],values:Record<string,integer|null>,fields:Field[]}[]}`。行順は globalInstructions/folderInstructions/rules/settings/permissions/memory/ownSkills/skillListing/plugins/agents/mcp/hooks/scheduled/references。タグは sameRole/differentForm/differentCount/claudeOnly/damaged。values のキーは上記statsと chars/count/listed。itemIds で文書・置き場所・つながりへ移る。

`Document={id,body:string|null,fields:Field[],size:Size,status}`。許可された instruction/rule/reference/agent/command 等のみ、１文書最大2 MiB。記憶の本文、秘密のファイル、設定全文は含めない。`Finding={id,kind,service,layer,severity,count:integer,chars:integer|null,evidence:Evidence[],unknowns:string[],proposal,itemIds:string[],names:string[]}`。`Evidence={path:string|null,line:integer|null,record:string|null,rule,fields:Field[]}`。severity は repair/decide/watch、kind は disabledPlugins/unusedListing/implicitHidden/shadowedAgents/memoryLimit/duplicate/brokenTarget。unknowns は既知の識別子を説明に変換し、未知なら「未確認」とする。直す案は説明だけで変更しない。

## closed.json と同時更新

`{schemaVersion:1,revision:integer,closed:Closure[]}`。Closure は `{id:string,workFolder:string,reason:string,closedAt:string,closedFrom:"pc"|"iphone"}`。closedAt は時差つき ISO 8601。理由は空白だけを認めず最大1,000字。PC の旧 cwd/date は読み込みのみ互換。新規書き込みは上の名前を使う。

id は種類と対象に基づく固定値。集約の implicitHidden 等は「サービスの当該フォルダの集合」が対象で、`codex:implicitHidden` 等。duplicate はサービス＋名前、brokenTarget はサービス＋入口の固定 id。論理キーは `(id,workFolder)`。Windows のフォルダ比較はスラッシュを揃え大文字小文字を無視し、Mac は区別する。読み直し時刻や件数を id に含めない。

すべての書き手は次の同じ手順を守る。楽観的な版確認だけでは置き換え直前の競合を防げないため、OS のファイルロックも必須。

1. 先に読み、観測した revision を保持する。
2. 同じディレクトリの常設 `closed.lock` に排他ファイルロックを取る。Windows は byte 0 を含む LockFileEx、Mac は flock。mycmux は Rust File::lock を使う。ロックファイルは消したり置き換えたりしない。
3. ロック中に closed.json を読み直す。観測した版と違えば最新を基に重ねる。最新の全件を保ち、同じ論理キーだけ置き換える。revision を1増やす。
4. 同じディレクトリの一時ファイルへ全件を UTF-8 で書き、flush/fsync 後に原子的に置き換える。ロックを解放する。壊れたJSON・未知の版は上書きせずエラーにする。

Windows の読み手は置き換えを妨げない共有モード（FILE_SHARE_READ / FILE_SHARE_WRITE / FILE_SHARE_DELETE）で開き、読み終えたらすぐ閉じる。mycmux の書き手は一時的な共有違反やスキャナによる置き換え拒否だけを短時間、最大8回再試行し、成功しなければエラーにする。途中のファイルへ上書きして原子性を崩さない。

サーバは閉鎖後、catalog の findings を同じ論理キーで除外し、closedCount と closedRevision を最新記録から反映して配信する。catalog の再生成を待たなくてよい。mycmux もキャッシュ表示で閉鎖記録を再確認する。iPhone から渡すのは指摘id・この目録のworkFolder・理由だけとし、時刻と closedFrom=iphone はサーバが付ける。新規idは配信した目録の指摘から選ぶ。

## pocket の読み込みと版

ファイル無しは「PC の目録がまだありません」、JSONが壊れているときは最後の有効な目録があれば古い値と明示して保持する。generatedAt から５分を超えたら「古い目録」と時刻を出す。この時間は表示の目安で、サーバが独自の読み手を実行する理由にしない。未知の schemaVersion は「未対応の目録の版」として４面の解釈と閉鎖更新を止める。

読み込みは１回開いて全体を解析し、schemaVersion・ヘッダ・３サービス・７層・14行を確かめる。home/workFolder は PC の場所の表示用で、iPhone のパスとして開かない。サーバは共有済みの固定ディレクトリだけ読み、要求に含まれる任意パスを開かない。鍵の値・MCPの設定値・会話本文を追加しない。

既存項目の型・意味・必須項目・idの決め方・閉鎖ロック手順を互換性なく変える場合は schemaVersion を上げる。任意項目の追加は同じ版で可。未知の任意キーを無視し、未知のタグは「未対応」、null は「不明」。この段で pocket のサーバや iPhone は実装しない。

## v04 の表示に用いる任意情報

`Catalog.closedEntries?:Closure[]` は現在の作業場所で閉じた指摘の理由・日時。旧目録では欠落を受け入れ、理由を未取得として扱う。閉じる操作の排他・版照合・保存形式は従来と同じ。公開目録への理由は他の文字列と同様に鍵を伏せる。

PC の読取専用スキル目録には `places?:{service,path,chars,lines,bytes,modifiedAt}[]`、`listedIn?:{claude,codex:boolean|null}`、`usageRecords?:{sampledAt,claude:Usage,codex:Usage}` を追加する。Usage は `{status:"available"|"unavailable"|"failed",count:integer|null,lastAt:integer|null,source:string,days?:integer}`。Claude の skillUsage は呼び出し数、Codex の usage_codex.json は更新時刻が直近90日の会話数（同一会話・同一スキルを重複計上しない）。CodexのlastAtは会話の最終時刻で、呼び出した正確な日時ではない。本文読取・実行・成功の回数には使わない。集計の欠落・失敗はnull、取得済みで該当記録がないときだけ0。互換のusageCount合計は画面の集計・並び順には使わない。listedInのnullは採用した一覧が未取得。これらは読取専用APIの任意拡張で、schemaVersionは1を維持する。

初期段のinstruction itemIdsは採用中かつalwaysの項目。条件つきのルールやshadowedInstructionは初期量に加えず、それぞれの段から本文へ移る。画面では初期記録の字数と現在ファイルのバイト数を別の量として表示する。


## v04の履歴と書き出し

目録の読み直し後、B1のmetadata-onlyの写しを非同期で保存する。作業フォルダ別の最大60時点と全体20MiBの既存上限を維持する。履歴応答は各写しのID・保存日時・元の目録日時・項目数・サービス別の取得状態と数を返す。二時点比較は同一作業フォルダの古いIDから新しいIDだけを受け付ける。本文は写しに保存しない。Gitの履歴は最新30件を読取専用で取得し、除外・未登録・取得失敗を変更なしと区別する。本文差は両側の全文に段Cの伏せ字を適用してから行へ分ける。履歴にreveal APIは無い。

B2の設計書はサービス・層・添付文書・見出しを明示して選ぶ。本文は既定で選ばず、記憶・会話本文・鍵の値は常に除外する。本文の個別再確認は段Cのon-open境界を使い、本文そのものではなく可否・理由・見出しの情報を返す。previewとsaveは選んだ現行ファイルを読み直して伏せ字にし、HTMLのfingerprintを照合する。名前の一覧とOS利用者名・メール・電話の検査を保存前に再実施し、該当や読み取り失敗で保存を止める。既存ファイルの上書きはしない。一時表示した値はこの経路へ渡さない。未計測の字数・行数は設計書の欄から省き、ファイル量はKBで表示する。
