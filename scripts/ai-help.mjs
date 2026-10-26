/**
 * agmsg Manager - ai:help（いま何をすればいいかを教えるナビゲーション）
 *
 * 目的:
 *   非エンジニアでも「いつ・どのコマンドを打てばいいか」が分かるように、
 *   セットアップ状態の点検（✔/✖）と、1日の作業の流れを1画面で表示する。
 *
 * 使い方:
 *   npm run ai:help      （package.json のある repo）
 *   bash scripts/ai help （standalone: package.json が無い repo）
 *
 * 特徴:
 *   - 読み取り専用。何も変更しない。
 *   - セットアップに不足があれば、次に何をすべきかを具体的に案内する。
 *   - spec-leader の handoff（AGENTS.md / acceptance_checklist.md）の配置も点検する。
 */
import { readFileSync, existsSync, readdirSync, accessSync, constants } from 'fs';
import { join } from 'path';
import { aiCmd, agentId, agmsgScriptsDir } from './ai-workflow-lib.mjs';
import { loadApproval } from './ai-approval-lib.mjs';

const root = process.cwd();
const taskFile = join(root, '.ai', 'current-task.json');

/** ファイル不在と JSON 破損を区別して読む。 */
function readJsonFile(p) {
  if (!existsSync(p)) return { exists: false, broken: false, data: null };
  try {
    return { exists: true, broken: false, data: JSON.parse(readFileSync(p, 'utf8')) };
  } catch {
    return { exists: true, broken: true, data: null };
  }
}

/** 公式agmsg scriptsの存在だけを確認する。inboxを実行して既読化しない。 */
function hasAgmsgScripts() {
  try {
    const scriptsDir = agmsgScriptsDir();
    for (const script of ['team.sh', 'send.sh', 'inbox.sh', 'whoami.sh']) {
      accessSync(join(scriptsDir, script), constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function handoffSearchDirs() {
  const dirs = [''];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('handoff_')) dirs.push(entry.name);
    }
  } catch {
    // 読めない場合は固定候補のみで探す
  }
  dirs.push('handoff', 'docs');
  return dirs;
}

function findHandoffFile(fileName) {
  for (const dir of handoffSearchDirs()) {
    const p = join(root, dir, fileName);
    if (existsSync(p)) return p;
  }
  return null;
}

/** handoff フォルダ（handoff_* または handoff/）のうち AGENTS.md を含むものを返す。 */
function findHandoffAgentsDir() {
  for (const dir of handoffSearchDirs()) {
    if (!dir || dir === 'docs') continue;
    if (existsSync(join(root, dir, 'AGENTS.md'))) return dir;
  }
  return null;
}

const taskInfo = readJsonFile(taskFile);
const task = taskInfo.data;
const hasTask = taskInfo.exists && !taskInfo.broken;
const hasTeam = Boolean(task?.team && String(task.team).trim());
const profile = String(task?.workflowProfile || '').trim() || 'legacy-claude-codex-v1';
const implementerId = agentId(task?.implementer);
const reviewerId = agentId(task?.reviewer);
const hasImplementer = profile === 'legacy-claude-codex-v1' || Boolean(implementerId);
const hasReviewer = Boolean(reviewerId);
const hasTaskText = Boolean(task?.task && String(task.task).trim());
const hasTaskId = Boolean(task?.taskId && String(task.taskId).trim());
const hasTaskFingerprint = Boolean(task?.taskFingerprint && String(task.taskFingerprint).trim());
const hasAgmsg = hasAgmsgScripts();
const approvalResult = hasTask
  ? loadApproval(root, task)
  : { errors: ['current-task.jsonを先に設定してください'], approval: null };
const hasApprovedPicture = approvalResult.errors.length === 0;
const declarationErrors = approvalResult.errors.filter((error) => /active作業宣言/.test(error));
const approvalContentErrors = approvalResult.errors.filter((error) => !/active作業宣言/.test(error));
const agentsMdPath = existsSync(join(root, 'AGENTS.md')) ? join(root, 'AGENTS.md') : null;
const checklistPath = findHandoffFile('acceptance_checklist.md');
const decisionsLogPath = findHandoffFile('decisions_log.md');

const mark = (ok) => (ok ? '✔' : '✖');

console.log('==========================================');
console.log('  ai:help — いま何をすればいい？');
console.log('==========================================');
console.log('');
console.log('【セットアップ点検】');
console.log(`  ${mark(hasTask)} .ai/current-task.json ${hasTask
  ? 'あり'
  : taskInfo.broken
    ? '壊れています（JSONとして修復してください）'
    : 'なし（インストーラーを実行してください）'}`);
console.log(`  ${mark(hasTaskText)} 今日のタスク（task） ${hasTaskText ? `「${task.task}」` : '未記入'}`);
console.log(`  ${mark(hasTaskId)} タスクID（taskId） ${hasTaskId ? `「${task.taskId}」` : '未記入'}`);
console.log(`  ${mark(hasTaskFingerprint)} 重複防止ID（taskFingerprint） ${hasTaskFingerprint ? '記入済み' : '未記入'}`);
console.log(`  ${mark(hasTeam)} レビュー用チーム（team） ${hasTeam ? `「${task.team}」` : '未記入'}`);
console.log(`  ✔ workflow profile 「${profile}」`);
console.log(`  ${mark(hasImplementer)} 実装担当（implementer） ${implementerId || (profile === 'legacy-claude-codex-v1' ? 'legacy推定' : '未記入')}`);
console.log(`  ${mark(hasReviewer)} レビュー担当（reviewer） ${reviewerId || '未記入'}`);
console.log(`  ${mark(hasApprovedPicture)} 承認済み完成図（approval.json） ${hasApprovedPicture
  ? `承認済み revision ${approvalResult.approval.revision}`
  : `未完了（${approvalResult.errors[0]}）`}`);
console.log(`  ${mark(hasAgmsg)} agmsg公式scripts ${hasAgmsg ? '利用可能' : '見つかりません（レビュー連携が使えません）'}`);
console.log('');
// handoff フォルダがあるのに、直下の AGENTS.md から参照されていない場合を検知する
const handoffAgentsDir = findHandoffAgentsDir();
const rootAgentsRaw = agentsMdPath ? (readFileSync(agentsMdPath, 'utf8') || '') : '';
const agentsLinked = Boolean(
  handoffAgentsDir && agentsMdPath && rootAgentsRaw.includes(handoffAgentsDir)
);

console.log('【設計書との連携（spec-leader handoff）】');
console.log(`  ${mark(Boolean(agentsMdPath))} AGENTS.md（リポジトリ直下） ${agentsMdPath ? 'あり' : 'なし'}`);
console.log(`  ${mark(Boolean(handoffAgentsDir))} handoff フォルダ ${handoffAgentsDir ? `→ ${handoffAgentsDir}/` : 'なし'}`);
console.log(`  ${mark(Boolean(checklistPath))} acceptance_checklist.md（合格基準） ${checklistPath ? `→ ${checklistPath}` : 'なし'}`);
console.log(`  ${mark(Boolean(decisionsLogPath))} decisions_log.md（判断ログ） ${decisionsLogPath ? `→ ${decisionsLogPath}` : 'なし'}`);
if (handoffAgentsDir) {
  console.log(`  ${mark(agentsLinked)} 直下の AGENTS.md から ${handoffAgentsDir}/AGENTS.md への参照 ${agentsLinked ? 'あり' : 'なし'}`);
}

if (!checklistPath) {
  console.log('  ※ spec-leader で設計書を作った場合は、spec/exports/handoff_プロジェクト名/ を');
  console.log('    フォルダごとこのリポジトリの直下にコピーすると、相談・レビューに合格基準が自動で付きます。');
}

console.log('');
console.log('【1日の流れ（この順番でコマンドを打つだけ）】');
console.log('');
console.log(`  ① 完成図を確認するとき  : ${aiCmd('approval', 'status')}`);
console.log('       → ユーザー承認・未解決事項0件・task/branch/fingerprint一致を検査する。');
console.log(`  ② 作業を始めるとき     : ${aiCmd('start')}`);
console.log('       → 前回の続き・今の状態が .ai/context/start.md にまとまる。');
console.log('         これを Claude Code に貼って（または読ませて）作業開始。');
console.log(`  ③ テストを実行するとき  : ${aiCmd('test', '[テストコマンド]')}`);
console.log('       → 実行件数・失敗・skip・生ログを数え、完了ゲート用の結果を保存する。');
console.log('         表示された「実行結果」のパスを、証跡JSONの testRun に書く。');
console.log(`     その他のコマンド      : ${aiCmd('run', '<コマンド>')}`);
console.log('       → 結果が自動でログ保存される。AIへのコピペが不要になる。');
console.log(`  ④ AIに相談したいとき    : ${aiCmd('pack')}`);
console.log('       → 状況が .ai/context/ask-agent.md に1ファイルでまとまる。');
console.log('         これを ChatGPT に1回貼るだけ。往復コピペが不要になる。');
console.log(`  ⑤ レビューしてほしいとき: ${aiCmd('review-flow', '--yes')}`);
console.log('       → コードレビューは全サイズ3往復。仕様→利用者操作→端の条件を固定担当で確認し、未確認を問題なしにしない。');
console.log(`         返信確定: ${aiCmd('review-check', '--verdict auto')} （必要時のみ ok|findings で上書き）`);
console.log(`         永続キューへ登録（現時点は明示指定のみ・第2段稼働後に既定化）: AI_REVIEW_MODE=queue ${aiCmd('review-send', '--yes')}`);
console.log(`         永続キューから回収: ${aiCmd('review-wait', '<Request-ID>')} → ${aiCmd('review-check')}`);
console.log(`         2回目をキューで受領した後は、通常の ${aiCmd('review-flow', '--yes')} へ戻すと3回目へ自動で切り替わる。`);
console.log(`         ※第1段には処理役がまだ無い。AI_REVIEW_MODE=queue ${aiCmd('review-flow', '--yes')} は上の個別手順だけを案内する。`);
console.log('         終了後はnon_webをnot_applicable、Webはbrowser preflight後に最大3往復記録する。');
console.log(`         Web確認: ${aiCmd('review-flow', '--browser-url <URL>')}`);
console.log(`         画面の機械検品だけを再実行: ${aiCmd('visual-qc', '--url <URL>')}`);
console.log('           ※単独実行の結果は往復記録へ反映しない。記録付き再検査は review-flow --visual-qc-recheck。');
console.log(`         証跡作成: ${aiCmd('e2e', `record --input <raw.json> --output .ai/e2e/${task?.taskId || '<taskId>'}-browser-round1.json`)}`);
console.log(`         結果記録: ${aiCmd('review-flow', `--browser-verdict ok|error --browser-evidence .ai/e2e/${task?.taskId || '<taskId>'}-browser-round1.json --note "結果"`)}`);
console.log(`  ⑥ Web UIを確認するとき  : ${aiCmd('e2e', 'preflight --url <URL>')}`);
console.log('       → 実ブラウザを起動できない環境はblocked証跡を残して停止する。');
console.log(`  ⑦ 完了ゲートを通すとき  : ${aiCmd('complete')}`);
console.log('       → review/E2E証跡/task/branchが揃った時だけ完了可能と判定する。');
console.log(`  ⑧ 作業を終えるとき      : ${aiCmd('close')}`);
console.log('       → 今日のまとめと「次回の開始メモ」が自動で残る。');
console.log('');
console.log('【困ったとき】');
console.log('  ・配布更新を未確定で残さない → node /home/dev/projects/ai-dev-tool/bin/install.mjs --update --commit');
console.log('       → 今回更新した配布物だけをcommitする。他の作業は含めず、pushもしない。');
console.log(`  ・出力が思ったものと違う → .ai/requests/output-fix.md に記入して ${aiCmd('output-fix-pack')}`);
console.log(`  ・新しい機能を足したい   → .ai/requests/feature.md に記入して ${aiCmd('feature-pack')}`);
console.log(`  ・レビュー返信を再確認   → ${aiCmd('review-check', '--verdict auto')}`);
console.log('       → 未読が既読化済みでも既読履歴から回収する（wait-reply.shは受信時に既読化するため）。');
console.log(`  ・レビュー合否が保留     → ${aiCmd('review-check', '--verdict ok|findings')}`);
console.log('       → 保全した本文を確認して合否を指定する。またはreviewerにVerdict行付きで返信し直してもらう。');
console.log(`  ・完了後に証跡を回収     → ${aiCmd('review-check', '--recover --request-id <ID> --verdict auto|ok|findings')}`);
console.log('       → 現taskとの差分だけを免除する。本文にVerdict行が無い旧返信では ok|findings を指定する。');
console.log('         agmsgレーンとmessage照合6項目は必須のまま。差分は review-result.md に記録される。');
console.log(`  ・reviewerとして依頼受信 → ${aiCmd('review-inbox')}`);
console.log(`  ・reviewerとして返信     → ${aiCmd('review-reply', '--message "レビュー結果" --yes')}`);
console.log(`  ・reviewer返信state解除   → ${aiCmd('review-reply-reset', '--request-id <ID> --yes')}`);
console.log(`  ・送信状態を明示reset    → ${aiCmd('review-reset', '--yes')}`);
console.log(`  ・完了ゲートを通せない滞留 → ${aiCmd('complete', '--retrospective --input <JSON> --user-confirmed')}`);
console.log('       → 後追い完了。作業より後にハーネスを入れた等で承認・証跡を作れない場合だけ。');
console.log('         通常ゲートを通せる時は拒否される。裏付け（実ファイル/commit）の実在検査あり。');
console.log(`  ・検証不備を警告記録して前進 → ${aiCmd('complete', '--force-with-warning --apply')}`);
console.log('       → 身元・重複検査は維持し、承認/E2E/完了検証の不備を記録して完了する。');
console.log('         通常ゲートを通せる時は拒否される。');
console.log(`  ・未コミットの例外許可   → ${aiCmd('complete', '--allow-uncommitted "<理由>"')}`);
console.log('       → 実装ファイルを未コミットのまま確認するときだけ。理由と対象一覧を完了記録へ残す。');
console.log(`  ・成果物の4点記録を必須化 → DELIVERY_REQUIRED=1 ${aiCmd('complete')}（記録は --delivery-record <JSON>）`);
console.log('       → 既定は記録なしを警告のみ。必須時は built/installed/verify_cmd/verify_output の記録が無いと完了できない（exit 1）。');
console.log('         正本: rules/delivery-installed.md');
console.log(`  ・特に難しい問題を相談   → ${aiCmd('consult')}（GPT-5.5 Proに自動相談。--yes 付きで従量課金）`);
// ai:docs-task はknowledge等の一部リポジトリだけに存在するため、案内も存在するときだけ出す
if (readJsonFile(join(root, 'package.json')).data?.scripts?.['ai:docs-task']) {
  console.log(`  ・docs/rulesだけの小粒作業 → ${aiCmd('docs-task', 'start …／finish')}（直接親の軽量完了経路。滞留宣言は start --adopt）`);
}
console.log('');

const todos = [];
if (taskInfo.broken) todos.push('.ai/current-task.json が壊れています。JSONとして修復してください');
if (!hasTaskText) todos.push('.ai/current-task.json の "task" に今日やることを1行で記入する');
if (!hasTaskId) todos.push('.ai/current-task.json の "taskId" に作業宣言と同じ一意IDを記入する');
if (!hasTaskFingerprint) todos.push('.ai/current-task.json の "taskFingerprint" に作業宣言と同じ重複防止IDを記入する');
if (!hasTeam) todos.push('.ai/current-task.json の "team" に agmsg のチーム名を記入する');
if (!hasImplementer) todos.push('.ai/current-task.json の "implementer.id" に実装担当のteamメンバーIDを記入する');
if (!hasReviewer) todos.push('.ai/current-task.json の "reviewer.id" にレビュー担当のteamメンバーIDを記入する');
if (declarationErrors.length > 0) {
  todos.push('dispatcherまたは作業開始コマンドで、current-taskと同じrepo / branch / taskId / taskFingerprintのactive作業宣言を作成・復旧する');
}
if (!hasApprovedPicture && approvalContentErrors.length > 0) {
  if (handoffAgentsDir) {
    todos.push(`${aiCmd('approval', `import-spec --handoff ${handoffAgentsDir}`)} でspec-leader成果物をdraftへ取り込む`);
  } else {
    todos.push(`vision / completionCriteria / nonGoals / assumptions / openQuestions / concerns を持つ簡易JSONを作り、${aiCmd('approval', 'create --input <JSON>')} でdraftを保存する`);
  }
  todos.push(`draftの内容をユーザーが明示承認し、未解決事項0件になった後だけ ${aiCmd('approval', 'approve --user-confirmed --by <承認者>')} を実行する`);
}
if (handoffAgentsDir && !agentsLinked) {
  todos.push(
    `AGENTS.md（無ければ新規作成）に次の1行を追記する: 実装前に ${handoffAgentsDir}/AGENTS.md を必ず読み、そのルールに従うこと。`
  );
}

if (todos.length > 0) {
  console.log('【次にやること（セットアップの不足）】');
  todos.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  console.log('');
} else {
  console.log('✔ セットアップは完了しています。② の ai:start から始めてください。');
  console.log('');
}
