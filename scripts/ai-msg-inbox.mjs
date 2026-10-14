/** 自分の team/to レーンだけを取得し、current-task と一致する本文だけ表示する。 */
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  aiCmd,
  extractMessageFields,
  parseInboxLine,
  repoKey,
  resolveLane,
  runAgmsgScript,
  GPT56_CLAUDE_PROFILE,
  workflowProfile,
} from './ai-workflow-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const taskFile = join(root, '.ai', 'current-task.json');
const logDir = join(root, '.ai', 'logs');
const roleArgIndex = process.argv.indexOf('--as');
const requestedRole = roleArgIndex >= 0 ? process.argv[roleArgIndex + 1] : '';

// --- current-task.json 読み込み ---
if (!existsSync(taskFile)) {
  console.error('✗ .ai/current-task.json が見つかりません。先に Step 1 を実行してください。');
  process.exit(2);
}
let task;
try {
  task = JSON.parse(readFileSync(taskFile, 'utf8'));
} catch (e) {
  console.error(`✗ .ai/current-task.json の読み込みに失敗しました: ${e.message}`);
  process.exit(2);
}

const profile = workflowProfile(task);
if (!requestedRole && profile === GPT56_CLAUDE_PROFILE) {
  console.error('✗ gpt56-claude-v1ではrole指定が必須です。受信箱は読んでいません。');
  console.error(`  implementer: ${aiCmd('msg-inbox', '--as implementer', { root })}`);
  console.error(`  reviewer   : ${aiCmd('msg-inbox', '--as reviewer', { root })}（レビュー依頼は ai:review-inbox を推奨）`);
  process.exit(2);
}
const role = requestedRole || 'implementer'; // legacyだけ後方互換の既定role
if (!['implementer', 'reviewer'].includes(role)) {
  console.error('✗ --as は implementer または reviewer を指定してください。受信箱は読んでいません。');
  process.exit(2);
}
const roleSuffix = role === 'implementer' ? '' : `-${role}`;
const filteredLog = join(logDir, `agmsg-inbox${roleSuffix}-filtered.log`);
const ignoredLog = join(logDir, `agmsg-inbox${roleSuffix}-ignored.log`);

const wantTask = (task.task || '').trim();
const skipTask = wantTask === '';

// --- 公式scriptsでteam/toを明示して、自分のレーンだけ取得 ---
const lane = resolveLane(task, root, role);
if (lane.errors.length > 0) {
  console.error('✗ agmsgレーンを一意に解決できないため、受信箱を読みません:');
  for (const error of lane.errors) console.error(`  - ${error}`);
  process.exit(2);
}

let inboxOut = '';
try {
  inboxOut = runAgmsgScript('inbox.sh', [lane.team, lane.inbox], { cwd: root });
} catch (e) {
  console.error(`✗ inbox.sh の実行に失敗しました: ${e.message}`);
  process.exit(2);
}

// --- 解析・分類 ---
const matched = [];
const ignored = [];
for (const line of inboxOut.split('\n')) {
  const parsed = parseInboxLine(line);
  if (!parsed) continue;
  const f = extractMessageFields(parsed.body);

  // Project / Repo / Branch が欠けているメッセージは採用しない
  const hasCore = f.project && f.repo && f.branch;

  const ok =
    hasCore &&
    f.project === task.project &&
    repoKey(f.repo) === repoKey(task.repo) &&
    f.branch === task.branch &&
    (skipTask || f.task === wantTask);

  (ok ? matched : ignored).push({ ...parsed, fields: f });
}

// --- ログ保存 ---
mkdirSync(logDir, { recursive: true });
const runAt = new Date().toISOString();
function writeLog(file, entries) {
  if (entries.length === 0) return;
  const lines = entries.map(
    (e) => `[${runAt}] from=${e.from} ts=${e.ts} | ${e.body}`
  );
  appendFileSync(file, `# run ${runAt}\n${lines.join('\n')}\n`, 'utf8');
}
writeLog(filteredLog, matched);
writeLog(ignoredLog, ignored);

// --- 表示 ---
console.log('=== agmsg inbox (filtered) ===');
console.log(`  role=${role} lane=${lane.team}/${lane.inbox}`);
console.log(`  project=${task.project} repo=${task.repo} branch=${task.branch}` +
  (skipTask ? ' task=(任意)' : ` task=${wantTask}`));
console.log('');

if (matched.length === 0) {
  console.log('一致するメッセージはありません。');
} else {
  console.log(`${matched.length} 件の一致メッセージ:`);
  console.log('');
  for (const e of matched) {
    console.log(`  [${e.ts}] ${e.from}`);
    for (const part of e.body.split('\\n')) console.log(`    ${part}`);
    console.log('');
  }
  console.log(`→ ${filteredLog} に保存しました。`);
}

console.log('');
console.log(`無視したメッセージ: ${ignored.length} 件（別repo/別branch/別task または項目欠落）`);
if (ignored.length > 0) {
  console.log(`→ ${ignoredLog} に保存しました（通常表示には出していません）。`);
}
