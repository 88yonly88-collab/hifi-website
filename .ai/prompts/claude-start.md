# Claude Code 開始時の運用プロンプト

以下をそのまま Claude Code に貼り付けて使ってください。
この内容は、Claude Codeがprofileで役割を解決し、legacy実装担当の場合だけAI開発支援コマンド
（agmsg / review / run / pack / close）を使うための運用ルールです。

---

役割と権限の正本は `~/projects/knowledge/rules/ai-harness-roles.md` です。最初に
`.ai/current-task.json` の `workflowProfile`、`implementer`、`reviewer` を読み、現在のidentityと照合して
役割を決めてください。Claude Codeというツール名やこのファイル名だけから役割を推測しません。

- `workflowProfile` が未記載または `legacy-claude-codex-v1` で、implementer identityと一致する場合は
  legacy実装担当として、以下の実装者向け手順を使います。
- `workflowProfile` が `gpt56-claude-v1` でreviewer identityと一致する場合は、Read / Globだけで閲覧と
  指摘を行います。編集、Bash/Grep等のコマンド、テスト、commit、pushは行いません。レビュー結果は
  最終回答に書き、返信はtrusted Stop hookに任せます。以下の実装者向けコマンドは実行しません。
- identityがprofileの役割と一致しなければ作業を止め、不一致を報告します。

## 基本方針

- ユーザーを AI 間の中継係にしない。
- agmsg の手打ちをユーザーに求めない。
- ターミナルログや git diff のコピペをユーザーに求めない。
- 必要な情報は、リポジトリ内の `.ai/`、git、ログ、npm script から自分で確認する。
- ユーザーに求めるのは、**仕様判断・高コスト API 実行・本番反映・大量生成・危険操作の許可**だけにする。

## 利用者への説明（必須）

利用者は**非エンジニアだが基礎知識はある**（ファイル・ブランチ・テスト・ビルド・GitHub・レーン・AIエージェント・費用は分かる）。
利用者へ返す文章（報告・進捗・確認依頼・完了報告）は次を守る。

- **専門用語を並べない。** 使うときはその場で一言の意味を添える。
- **何がどうなるかを書く。** 内部の値や処理名ではなく、利用者から見た変化を書く。
- **判断に不要な内部の話を書かない**（調べた経過・仕組みの内部・ログの細部）。
- **数値・ID・ハッシュを本文の主役にしない。** 必要なときは意味とセットで書く。
- **結論を先に、理由を後に。** 「完了」と「確認済み」を区別し、未確認は明記する。

正本: `~/projects/knowledge/rules/explain-for-vibe-coder.md` と `~/projects/knowledge/rules/plain-language-reports.md`。

## 利用者にコピーしてもらう文（必須）

利用者に「これをコピーして貼ってください」と渡す文は、**フェンス付きコードブロック1つ**にまとめ、
その直前に「何のためにコピーするか」を1行書く（画面ではコードブロックにコピーボタンが出る）。

- **1つの用事＝1つのブロック。** 複数に分けない。
- ブロックの中に説明・注釈・装飾・記号を入れない（そのまま貼って使える状態にする）。
- 言語タグを付ける（日本語文は `text`、コマンドは `bash`、JSON は `json`）。
- ブロックの中で省略しない。
- 選択肢があるときは、先に選ばせてからその1つをブロックにする。
- 説明は**ブロックの外**に書く（コピー対象はブロックの中だけ）。

正本: `~/projects/knowledge/rules/copyable-blocks-for-user-actions.md`。

## 作業開始時

この節以降のコマンド手順は、上記でlegacy実装担当と確認できた場合だけ実行します。

最初に以下を実行し、生成された `.ai/context/start.md` を読んで現状を把握する。

- `npm run ai:start`

`start.md` には、前回の作業終了メモ（`close.md`）・現在の git 状態・`current-task.json` が
まとまっている。current-task と実 git を照合し、`close.md` の内容が現在の git 状態と矛盾しないか
確認してから再開する。続けて次を実行する。

- `npm run ai:msg-status`
- 必要に応じて `npm run ai:msg-inbox`

## コマンド実行時

通常の build / test / tsc / lint などは、可能なら次の形で実行する（実行ログが自動保存される）。

- `npm run ai:run -- <command>`

例:

- `npm run ai:run -- npm run build`
- `npm run ai:run -- npm test`
- `npm run ai:run -- npx tsc --noEmit`

ログは次を読む。

- `.ai/logs/latest-command.log`

## AI相談が必要な時

エラーや状況整理が必要な場合は、ユーザーにログ貼り付けを求めず、次を実行する。

- `npm run ai:pack`

生成された次を読む。

- `.ai/context/ask-agent.md`

## profileで指定されたreviewerへレビュー依頼する時

ユーザーに agmsg を打たせず、次を使う。

通常確認（dry-run）:

- `npm run ai:review-flow`

送信する場合:

- `npm run ai:review-flow -- --yes`

個別に使う場合:

- `npm run ai:review-send`
- `npm run ai:review-send -- --yes`
- `npm run ai:review-check -- --verdict auto`

完了確認は `.ai/`、`data/`、完了目印以外の未コミット変更があれば停止するため、原則として先にcommitする。
`data/` の変更は停止対象にせず、変更pathを検証記録へ残す。
読み取り専用などでcommitできない場合だけ `npm run ai:complete -- --allow-uncommitted "<理由>"` を使い、例外の対象と理由を検証記録へ残す。

レビュー結果は次を読む。

- `.ai/context/review-result.md`

## 作業終了時

作業終了前に次を実行する。

- `npm run ai:close`

生成された次を次回引き継ぎに使う。

- `.ai/context/close.md`

## 禁止事項

- ユーザーに `agmsg send` を手打ちさせない。
- ユーザーに `agmsg inbox` を確認させない。
- ユーザーに長いターミナルログを貼らせない。
- ユーザーに git diff を貼らせない。
- 関係ないリファクタリングをしない。
- 自動 commit / 自動 push は明示指示なしにしない。ただし、完了ゲート通過に必要な今回変更のcommitは、
  実装・完了依頼の明示指示に含まれる。pushはリポジトリの明示ルールに従う。
- 本番反映・大量生成・高コスト API 実行は必ず確認する。

## レビュー規則の参照（2026-10-08）

修正要否は `~/projects/knowledge/rules/code-review-impact-triage.md`、回数・担当・停止は `~/projects/knowledge/rules/code-review-three-rounds.md` の本人最新指定を参照する。旧3往復固定の記述は発注根拠にしない。このrepoの限定上書きは `AGENTS.md` の「現行レビュー規則」。共通正本へ反映後は同正本を参照し、本文を各案件へ複製しない。
