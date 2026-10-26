<!--
このファイルの本文（下の「---」以降）を、導入先リポジトリの
AGENTS.md / CLAUDE.md にそのまま貼り付けて使ってください。

目的: Claude Code（および他の AI エージェント）がprofileで役割を解決し、実装者・親は
ai-dev-tool の各コマンドを使い、reviewerはread-only境界を守る運用を定着させる。

claude-start.md がセッション冒頭に貼る使い捨ての起動プロンプトなのに対し、
このファイルは AGENTS.md / CLAUDE.md に常設してプロジェクトの恒久ルールにするためのもの。
-->

---

## AI 開発支援ツール 運用ルール（ai-dev-tool）

役割と権限の正本は `~/projects/knowledge/rules/ai-harness-roles.md` です。最初に
`.ai/current-task.json` の `workflowProfile`、`implementer`、`reviewer` を現在のidentityと照合し、役割を
決めてください。ツール名やpromptファイル名から役割を推測しません。

- implementerは対象workspaceの編集、既存依存によるテスト、明確な修正を担当します。
- reviewerは実装者と別セッションで、閲覧と指摘だけを行います。編集、修正、コマンド・テスト実行、
  commit、pushは行わず、最終回答の返信はtrusted Stop hookに任せます。

このリポジトリには AI 開発支援コマンド（`npm run ai:*`）が導入されています。以下のコマンド実行手順は
implementerまたは親監督向けであり、reviewerへコマンド実行を要求しません。

### 基本方針

- ユーザーを AI 間の中継係にしない。
- ユーザーに `agmsg` を手打ちさせない。
- ユーザーにターミナルログや `git diff` のコピペを求めない。
- 必要な情報は、リポジトリ内の `.ai/`、git、ログ、npm script から自分で確認する。
- ユーザーに求めるのは、**仕様判断・高コスト API 実行・本番反映・大量生成・危険操作の許可**だけにする。

### 利用者への説明（必須・2026-10-14 恒久ルール）

利用者（発注者）は**非エンジニアだが基礎知識はある**（自分でAIにコードを書かせて開発する人）。
ファイル・ブランチ・テスト・ビルド・GitHub・レーン・AIエージェント・費用は理解している。
報告・説明・進捗・提案・確認依頼は、次を守る。

- **専門用語を並べない。** 使うときは**その場で一言の意味**を添える（例:「宣言（レーンの作業票）」）。
- **何がどうなるかを書く。** 「`review_status` を passed に更新」ではなく「レビューの**合格印**を記録した」。
- **判断に不要な内部の話を書かない。** 調べた経過・仕組みの内部・ログの細部は、判断に必要な場合だけ短く書く。
- **数値・ID・ハッシュを本文の主役にしない。** 必要なときは「何を意味するか」とセットで書く。
- **結論を先に、理由を後に。** 「完了」と「確認済み」を区別し、未確認は「未確認」と明記する。
- 出す直前に**自己点検**する（専門用語が残っていないか／何をしたか・何が変わるか・何が危ないか／結論が先頭か）。

正本: `~/projects/knowledge/rules/explain-for-vibe-coder.md`（言い換えの例つき）と
`~/projects/knowledge/rules/plain-language-reports.md`。入口や起動プロンプトは正本を参照し、正本と食い違う場合は正本に従う。

### 利用者にコピーしてもらう文（必須・2026-10-14 恒久ルール）

利用者に「これをコピーして貼ってください」と渡す文は、**フェンス付きコードブロック1つ**にまとめる。
DSH（この開発環境の画面）ではコードブロックにコピーボタンが出るため、利用者は1クリックで全体をコピーできる。
複数に分ける・地の文に埋める・途中に説明を挟むと、どこからどこまでコピーすればよいか分からなくなる。

- **1つの用事＝1つのブロック。** 複数のコードブロックに分けない。
- ブロックの**直前に「何のためにコピーするか」を1行**で書く。
- **ブロックの中に説明・注釈・装飾・箇条書き記号を入れない**（そのまま貼って使える状態にする）。
- **言語タグを付ける**（日本語文は `text`、コマンドは `bash`、JSON は `json`）。
- **ブロックの中で省略しない**（「…」「以下同様」を使わない）。
- コピー以外の選択肢があるときは、**先に選ばせてから**その1つをブロックにする。
- 説明は**ブロックの外**に書く（コピー対象はブロックの中だけ）。
- 出す直前に自己点検する（1ブロックか／直前に目的の1行があるか／中に注釈・装飾・省略がないか）。

正本: `~/projects/knowledge/rules/copyable-blocks-for-user-actions.md`（良い例・悪い例・自己点検の項目つき）。

### 共有ナレッジベース（~/projects/knowledge）との連携

`~/projects/knowledge/`（このマシン共通の教訓・事故記録）が存在する場合:

- 状態管理・永続化・長時間ジョブ・外部API・本番確認が絡む実装の前に、`knowledge/lessons/` の
  関連する教訓を読み、それに反する実装をしない。
- 作業終了時（`ai:close` 後）や障害解決後に、他プロジェクトでも使える教訓が生まれていたら、
  `knowledge/rules/knowledge-workflow.md` の手順に従ってナレッジ追加をユーザーへ提案する。

### 設計書（spec-leader handoff）との連携

このリポジトリに spec-leader が生成した handoff フォルダ（`handoff_プロジェクト名/`。
旧形式では直下・`handoff/`・`docs/` にファイル直置き）がある場合:

- `acceptance_checklist.md` … これを**唯一の完了基準**とする。全項目を満たすまで「完成」と言わない。
  自己申告の「動きました」を完了にしない。
- `decisions_log.md` … 設計書に書かれていない判断が必要になったら、勝手に決めて進めず
  ここに記録してから進める。
- `spec_core.json` … データの正本・エラー分類・完了条件の構造化データ。実装前に読む。
- `ai:pack` は acceptance_checklist.md と decisions_log.md を、`ai:review-send` は acceptance_checklist.md を
  自動で同梱する。それ以外（spec_core.json など）は必要に応じて自分でファイルを読む。

### 使用するコマンド

`.ai/current-task.json` の `workflowProfile` が無い既存タスクは
`legacy-claude-codex-v1` として扱う。`gpt56-claude-v1` ではCodex / GPT-5.6 Luna(xhigh)が実装し(2026-08-18〜。旧Sol)、
Claude Code / Opusが独立レビューする。既存userdataをprofile移行のために自動上書きしない。

- `npm run ai:help` … セットアップ点検と「いつ何を打つか」の案内（迷ったらまずこれ）
- `npm run ai:start` … 作業開始時の現状把握パック（前回 close.md / git 状態 / current-task）を生成
- `npm run ai:approval -- status` … ユーザー承認済み完成図と未解決事項0件を検証
- `npm run ai:msg-status` … 現在タスク（Project / Repo / Branch / Task）と実 git の突合
- `npm run ai:msg-inbox -- --as implementer` … implementer自身のレーンだけ表示
- `npm run ai:msg-inbox -- --as reviewer` … 親がreviewerレーンを診断する場合だけ明示指定
- `npm run ai:review-send` … reviewer へレビュー依頼（dry-run）
- `npm run ai:review-send -- --yes` … レビュー依頼を実送信
- `npm run ai:review-check -- --verdict auto` … reviewer 返信本文の `Verdict:` 行を確認して取得・保存
- `npm run ai:review-inbox` … 親がreviewer専用request stateを準備
- `npm run ai:review-reply -- --message "..." --yes` … trusted Stop hookが6項目ヘッダー付き返信に使用
- `npm run ai:review-reply-reset -- --request-id <ID> --yes` … 親がreviewer返信stateを履歴退避してreset
- `npm run ai:review-reset -- --yes` … 送信済み依頼を明示resetし、次回新Request-IDを生成可能にする
- `npm run ai:review-flow` … status → send → check をまとめて実行（dry-run）
- `npm run ai:run -- <command>` … 任意コマンドを実行しログ保存
- `npm run ai:e2e -- preflight --url <URL>` … Web UI作業開始時に実ブラウザ起動可否を確認
- `npm run ai:e2e -- record --input <JSON>` … 実ブラウザの操作・画面・reload・console/network・画像証跡を共通形式へ保存
- `npm run ai:e2e -- verify` … 現在task/branchの合格証跡を再検証
- `npm run ai:complete` … review/E2E/宣言を検査（`--apply`時だけdone/100%と履歴移動）
  - `.ai/`、`data/`、完了目印以外に未コミット変更があれば停止する。原則は先にcommitする。
    `data/` の変更は停止対象にせず、変更pathを検証記録へ残す。
  - 読み取り専用などでcommitできない場合だけ `--allow-uncommitted "<理由>"` を付け、対象・理由または状態確認不能の内容を検証記録へ残す。
- `npm run ai:pack` … 作業状況を AI 相談用 Markdown にまとめる
- `npm run ai:consult -- --yes` … 相談パックを OpenAI API（gpt-5.6-sol / reasoning effort: high、入力$5・出力$30 / 100万トークン）へ送信し高精度な助言を得る。
  **従量課金が発生するため、実行前に必ずユーザーの許可を得ること。1回あたりの概算コストは実行時の相談パックの
  サイズで変わるため、必ず dry-run（`--yes` なし）の表示で確認してから `--yes` を付けること。**
  回答は `.ai/context/consult-result.md` に保存され、実測コストもそこに記録される。
- `npm run ai:close` … 作業終了メモ・次回開始プロンプトを生成

### 作業開始時

原則として `npm run ai:start` から始める。

実装前に `.ai/approval.json` が現在の task ID / branch / fingerprint と一致し、
`status=approved` かつ未解決事項0件であることが必須です。spec-leader成果物は
`npm run ai:approval -- import-spec --handoff <handoff_dir>`、小作業は同一schemaの入力を
`npm run ai:approval -- create --input <json>` でdraft化し、ユーザーの明示承認後だけ
`npm run ai:approval -- approve --user-confirmed --by <承認者>` を実行します。実装中に新しい
仕様判断が生じたら `npm run ai:approval -- reopen --reason <未解決事項>` で即停止し壁打ちへ戻ります。
spec-leader draftの未解決事項や確認手順を解決した場合は、変更fieldだけをJSONへ書き、
`npm run ai:approval -- update --input <json>` でspec出典を保った新revisionとhashを生成してから再承認します。
完成図が変わらない単純継続では再承認は不要です。

新しい完成図入力には、打ち合わせで合意した原文と出所を
`"userAgreementQuotes": [{"quote":"原文をそのまま貼る","source":"日時・場所"}]` として必ず含めます。
合意が存在しない保守作業だけは、`quote` を `NONE`、`source` を合意不在の具体的な理由にします。
各 `nonGoals` には `（agreementCheck: 矛盾なし(引用index=0を確認)）` または
`（agreementCheck: 例外として合意済み(引用index=0)）` を明記します。
各引用は `completionCriteria` のいずれかから `（引用index=0）` のように参照します。
既存のspec-leader成果物にこれらが無い場合は、`import-spec --handoff <handoff_dir> --input <合意入力.json>`
で引用、全nonGoalsの確認宣言、引用indexを含む完了条件を取り込み時に補います。

1. `npm run ai:start` を実行し、生成された `.ai/context/start.md` を読んで現状を把握する。
   `start.md` には前回の作業終了メモ（`close.md`）・現在の git 状態・`current-task.json` が
   まとまっている。`current-task.json` と実 git を照合し、`close.md` が現在の git 状態と
   矛盾しないか確認してから再開する。
2. 続けて `npm run ai:msg-status` を実行し、**Project / Repo / Branch / Task** を確認する。
3. 必要ならroleを明示し、implementerは `npm run ai:msg-inbox -- --as implementer` で自分のレーンだけ
   確認する。reviewerのrequest state準備と返信送信は親およびtrusted Stop hookが担当する。
4. `.ai/prompts/claude-start.md` がある場合は読む。

> 補足: 古い導入先などで `ai:start` が未導入（`package.json` に `ai:start` が無い）の場合は、
> 従来どおり `npm run ai:msg-status` から始めてよい。

### コマンド実行時

build / test / tsc / lint などは、可能な限り次の形で実行する（実行ログが自動保存される）。

```bash
npm run ai:run -- <command>
```

例:

```bash
npm run ai:run -- npm run build
npm run ai:run -- npm test
npm run ai:run -- npx tsc --noEmit
```

ログは `.ai/logs/latest-command.log` を読む。ユーザーに出力の貼り付けを求めない。

### AI 相談が必要な時

エラーや状況整理が必要な場合は、ユーザーにログ貼り付けを求めず、次を実行する。

```bash
npm run ai:pack
```

生成物 `.ai/context/ask-agent.md` を読む。

### profileで指定したreviewerへのレビュー依頼

レビュー依頼はユーザー経由にせず、次を使う。

```bash
npm run ai:review-flow
```

実送信する場合:

```bash
npm run ai:review-flow -- --yes
```

レビュー結果は `.ai/context/review-result.md` を読む。

agmsg連携は必ず公式scriptsへteam/from/toを明示し、汎用inboxで全受信箱を消費しない。
review requestのRequest-IDと返信元reviewer、team、Project / Repo / Branch / Taskがすべて一致した
返信だけ採用する。recipientが完全一致または一意suffix一致で解決できない場合は送信前に停止する。
送信後にcheckが失敗しても同じrequestを自動再送しない。
roleはimplementer/reviewerを明示する。reviewer自身は受信・返信コマンドを実行せず、親が準備した
request stateをRead / Globで確認し、6項目ヘッダーを含む最終回答へレビュー結果を書く。trusted Stop hookは
回答を `.ai/logs/reviewer-final-t-<Team>-task-<Taskハッシュ>-request-<Request-ID>.md` へ安全に永続化してからのみ返信する。

### 作業終了時

`surfaceKind: web_ui` の作業では、HTTP/API確認を実ブラウザ確認の代用にしない。作業開始時に
`npm run ai:e2e -- preflight --url <対象URL>` を実行し、起動不能なら理由と必要環境を含むblocked証跡を残す。
主要操作、画面反映、保存後reload、console error 0件、failed network 0件、必要な画像・カード・ボタン、
実在するスクリーンショットを `record` と `verify` に通す。task/branchが異なる証跡、古い証跡、
failed/blocked/不完全な証跡では完了扱いにしない。
`surfaceKind: non_web` でも、CLI/API/batch/library/docs等の利用者経路を実行し、現在task/branch/worktree内容、
実行command、exit code 0、結果要約を含む同等E2E証跡を `record` と `verify` に通す。`e2e_status: pending` や
証跡なしのままdone/100へ進めない。

独立レビュー後、作業終了時は次の順で実行する。

`ai:complete` の前に、作業宣言の先頭にある連続した `key: value` 欄へ、次の形式を1行で入れる。
`\n` は実改行ではなく、バックスラッシュと `n` の2文字で書く。

```text
completion_report: 完了報告: <taskId>\n参照ナレッジ: <knowledge相対pathまたは該当なし>
```

cc-bridge履歴は、完了処理より前に同じ報告を送信済みだった場合だけ拾う補助経路であり、通常手順の
記入先にはしない。参照pathの後ろに括弧の注記を付けない（許可するのは `（misfire: 理由）` だけ）。
通常の作業メモに参照行だけを書いても完了報告とは扱わない。

```bash
npm run ai:complete
npm run ai:complete -- --apply
npm run ai:close
```

`ai:complete -- --apply` だけが合格時に作業宣言を100%/doneへ更新し、完了履歴へ移動できる。
surfaceを問わずこの適用証跡が無い場合、`ai:close` と完了報告を行わない。
生成物 `.ai/context/close.md` を次回引き継ぎに使う。

### 禁止事項

- ユーザーに `agmsg send` を手打ちさせない。
- ユーザーに `agmsg inbox` を確認させない。
- ユーザーに長いターミナルログを貼らせない。
- ユーザーに `git diff` を貼らせない。
- 関係ないリファクタリングをしない。
- 明示指示なしに commit / push をしない。ただし、完了ゲート通過に必要な今回変更のcommitは、
  実装・完了依頼の明示指示に含まれる。pushはリポジトリの明示ルールに従う。
- 本番反映・大量生成・高コスト API 実行は、必ずユーザーに確認する。

## レビュー規則の参照（2026-10-08）

修正要否は `~/projects/knowledge/rules/code-review-impact-triage.md`、回数・担当・停止は `~/projects/knowledge/rules/code-review-three-rounds.md` の本人最新指定を参照する。旧3往復固定の記述は発注根拠にしない。このrepoの限定上書きは `AGENTS.md` の「現行レビュー規則」。共通正本へ反映後は同正本を参照し、本文を各案件へ複製しない。
