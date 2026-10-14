/** reviewer専用: reviewer自身のレーンだけからレビュー依頼を受信・保存する。 */
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  appendSecureLog,
  ensureSafeDirectory,
  extractMessageFields,
  IDENTIFIER_PATTERN,
  parseHistoryLine,
  parseInboxLine,
  resolveLane,
  runAgmsgScript,
} from './ai-workflow-lib.mjs';
import { atomicWriteJson } from './ai-e2e-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const taskFile = join(root, '.ai', 'current-task.json');
const contextDir = join(root, '.ai', 'context');
const requestsDir = join(contextDir, 'reviewer-requests');
const currentFile = join(contextDir, 'reviewer-current-request.json');
const logDir = join(root, '.ai', 'logs');
const ignoredLog = join(logDir, 'agmsg-reviewer-ignored.log');
// 既読履歴を遡る件数。ai-review-checkの既定と揃える。
const HISTORY_LIMIT = 500;

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || '') : '';
}
const valueOptions = new Set(['--request-id', '--history-limit']);
const unknownArgs = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (!valueOptions.has(arg)) {
    unknownArgs.push(arg);
  } else if (!args[index + 1] || args[index + 1].startsWith('--')) {
    unknownArgs.push(arg);
  } else {
    index += 1;
  }
}
if (unknownArgs.length > 0) {
  console.error(`✗ 不明または不正なoptionです: ${unknownArgs.join(' ')}`);
  console.error('  使用可能: --request-id <ID> / --history-limit <件数>');
  process.exit(2);
}
const requestedId = option('--request-id');
if (requestedId && !IDENTIFIER_PATTERN.test(requestedId)) {
  console.error('✗ --request-id の文字種が不正、または128文字を超えています。');
  process.exit(2);
}
const historyLimitArg = option('--history-limit');
const MAX_HISTORY_LIMIT = 5000;
let historyLimit = HISTORY_LIMIT;
if (historyLimitArg) {
  if (!/^[1-9][0-9]*$/.test(historyLimitArg) || Number(historyLimitArg) > MAX_HISTORY_LIMIT) {
    console.error(`✗ --history-limit は 1〜${MAX_HISTORY_LIMIT} の整数で指定してください。`);
    process.exit(2);
  }
  historyLimit = Number(historyLimitArg);
}

if (!existsSync(taskFile)) {
  console.error('✗ .ai/current-task.json がありません。');
  process.exit(2);
}
let task;
try {
  task = JSON.parse(readFileSync(taskFile, 'utf8'));
} catch (error) {
  console.error(`✗ current-task.json を読めません: ${error.message}`);
  process.exit(2);
}

const lane = resolveLane(task, root, 'reviewer');
if (lane.errors.length > 0) {
  console.error('✗ reviewerレーンを解決できないため受信しません:');
  for (const error of lane.errors) console.error(`  - ${error}`);
  process.exit(2);
}

let output;
try {
  output = runAgmsgScript('inbox.sh', [lane.team, lane.inbox], { cwd: root });
} catch (error) {
  console.error(`✗ inbox.sh に失敗しました: ${error.message}`);
  process.exit(2);
}

function requestMatches(from, to, fields) {
  return (
    from === lane.to &&
    to === lane.inbox &&
    fields.project === String(task.project ?? '') &&
    fields.repo === String(task.repo ?? '') &&
    fields.branch === String(task.branch ?? '') &&
    fields.task === String(task.task ?? '') &&
    fields.team === lane.team &&
    Boolean(fields.requestId && IDENTIFIER_PATTERN.test(fields.requestId))
  );
}

const matched = [];
const ignored = [];
for (const line of output.split('\n')) {
  const parsed = parseInboxLine(line);
  if (!parsed) continue;
  const fields = extractMessageFields(parsed.body);
  // inbox.shはSQLでto_agentを絞るので宛先は自レーン確定。
  const ok = requestMatches(parsed.from, lane.inbox, fields);
  (ok ? matched : ignored).push({ ...parsed, fields });
}

// --- 既読化済みの依頼の回収 ---
// inbox.shは読んだ瞬間にread_atを打つ。reviewerはagmsgの手順で先に受信箱を開くことがあり
// (codexのStop hookも独自SQLで既読化する)、その後この受信を実行すると未読0件になって
// 依頼が見えない。実装者側の証跡消失(ai-review-check)とちょうど対称の事故。
//
// ただしreviewer側は「保存済みRequest-IDと突き合わせる」のではなく「依頼を発見する」側なので、
// 未読と単純にmergeすると同じbranch/taskの過去ラウンドの依頼まで surface して
// selection-required で止まり、今動いている正常系を壊す。
// そこで未読で1件も一致しなかった時だけ履歴を見る(--request-idで名指しされた時は、
// その依頼が未読に無ければ探す)。さらに返信済み(reviewer-reply-<ID>.json)は対応済みなので除外する。
let historyWarning = '';
let historySaturated = false;
let historyUnparsedCount = 0;
let historyIgnoredCount = 0;
let excludedRepliedCount = 0;
const recoveredIds = new Set();
// 返信が「送信できた」依頼だけを対応済みとみなす。
// ai-review-reply.mjs は send.sh を呼ぶ*前*に status='send-attempted' で
// state fileを書き、成功してから 'sent' へ更新する。存在チェックだけで除外すると、
// 送信に失敗した依頼まで対応済み扱いになり二度と回収できない。
// 判定できない時は除外しない(依頼を見せる方向へ倒す)。二重返信は
// ai-review-reply.mjs 側が state file の存在で止めるので、ここで防ぐ必要はない。
function alreadyReplied(requestId) {
  if (!IDENTIFIER_PATTERN.test(String(requestId || ''))) return false;
  const replyStateFile = join(contextDir, `reviewer-reply-${requestId}.json`);
  if (!existsSync(replyStateFile)) return false;
  try {
    return JSON.parse(readFileSync(replyStateFile, 'utf8')).status === 'sent';
  } catch {
    return false;
  }
}
// --request-id を名指しされた時は、未読に別の依頼があっても指定分は履歴まで探す。
// 「未読が1件あるだけで名指しの依頼を一度も探さない」状態を避ける。
const needHistory = requestedId
  ? !matched.some((entry) => entry.fields.requestId === requestedId)
  : matched.length === 0;
if (needHistory) {
  if (!IDENTIFIER_PATTERN.test(lane.team) || !IDENTIFIER_PATTERN.test(lane.inbox)) {
    historyWarning = 'team/宛先の文字種が不正なため既読履歴を読みませんでした';
  } else {
    try {
      // 1件多く要求し、上限ちょうどで「窓の外にもある」と誤警告しないようにする。
      const historyOut = runAgmsgScript('history.sh', [lane.team, lane.inbox, String(historyLimit + 1)], {
        cwd: root,
      });
      // history.shが本文以外に出す既知の通知行。これ以外のparse失敗は取りこぼしなので数える。
      const NOTICES = ['No message history.', 'No messages (DB not initialized)'];
      const seen = new Set();
      let historyRows = 0;
      for (const line of historyOut.split('\n')) {
        const parsed = parseHistoryLine(line);
        if (!parsed) {
          const text = line.trim();
          if (text && !NOTICES.includes(text)) historyUnparsedCount += 1;
          continue;
        }
        historyRows += 1;
        const fields = extractMessageFields(parsed.body);
        if (!requestMatches(parsed.from, parsed.to, fields)) {
          // 履歴には自分の返信も他タスクの往復も混ざるのが正常。件数だけ数える。
          historyIgnoredCount += 1;
          continue;
        }
        if (alreadyReplied(fields.requestId)) {
          excludedRepliedCount += 1;
          continue;
        }
        const key = [parsed.ts, parsed.from, parsed.body].join('\u001f');
        if (seen.has(key)) continue;
        seen.add(key);
        matched.push({ ...parsed, fields });
        recoveredIds.add(fields.requestId);
      }
      // 窓を使い切っていたら、それより古い依頼が窓外にある可能性を必ず表に出す。
      historySaturated = historyRows + historyUnparsedCount > historyLimit;
    } catch (error) {
      historyWarning =
        error?.code === 'ENOBUFS'
          ? `history.sh の出力が読み取り上限を超えました（--history-limit ${historyLimit} を小さくして再実行してください）: ${error.message}`
          : `history.sh の実行に失敗しました: ${error.message}`;
    }
  }
}

const now = new Date().toISOString();
mkdirSync(requestsDir, { recursive: true });
const statesById = new Map();
const matchCountsById = new Map();
for (const entry of matched) {
  const state = {
    requestId: entry.fields.requestId,
    receivedAt: now,
    team: lane.team,
    from: lane.to,
    to: lane.from,
    project: entry.fields.project,
    repo: entry.fields.repo,
    branch: entry.fields.branch,
    task: entry.fields.task,
    body: entry.body.split('\\n').join('\n'),
  };
  matchCountsById.set(state.requestId, (matchCountsById.get(state.requestId) || 0) + 1);
  statesById.set(state.requestId, state);
  atomicWriteJson(join(requestsDir, `${state.requestId}.json`), state);
}
const states = [...statesById.values()];
if (requestedId && matchCountsById.get(requestedId) === 1) {
  atomicWriteJson(currentFile, statesById.get(requestedId));
} else if (!requestedId && states.length === 1) {
  atomicWriteJson(currentFile, states[0]);
} else if (!requestedId && states.length > 1) {
  atomicWriteJson(currentFile, {
    status: 'selection-required',
    receivedAt: now,
    requestIds: states.map((state) => state.requestId),
  });
}

// 一致依頼は無視ログより重要。ログ追記が安全性検査で失敗しても先に永続化する。
if (ignored.length > 0) {
  const lines = ignored.map((entry) => `[${now}] from=${entry.from} | ${entry.body}`);
  try {
    ensureSafeDirectory(logDir, { create: true });
    appendSecureLog(ignoredLog, `${lines.join('\n')}\n`);
  } catch (error) {
    console.error(`✗ 無視ログを安全に追記できません: ${error.message}`);
    process.exit(2);
  }
}
if (ignored.length > 0) {
  console.error('⚠ 無視した依頼（先頭3件・各240文字まで）:');
  for (const entry of ignored.slice(0, 3)) {
    const safeFrom = entry.from.replace(/[\u0000-\u001F\u007F]/g, '?').slice(0, 120);
    const preview = entry.body.replace(/[\u0000-\u001F\u007F]/g, '?').slice(0, 240);
    console.error(`  - from=${safeFrom} ${preview}`);
  }
}

console.log('=== ai:review-inbox ===');
console.log(`  role=reviewer lane=${lane.team}/${lane.inbox}`);
console.log(`  一致Request-ID: ${states.length}件 / 無視: ${ignored.length}件`);
if (recoveredIds.size > 0) {
  console.log(`  うち既読履歴から回収: ${recoveredIds.size}件（未読が既に消費されていました）`);
  console.log('    受信箱を先に開くとinbox.shが既読化します。開かずに待つなら wait-reply.sh ... --peek を使ってください。');
}
// 「依頼が来ていない」と「除外した結果0件」を見分けられるようにする。
if (excludedRepliedCount > 0) {
  console.log(`  返信済みのため除外: ${excludedRepliedCount}件（再受信するなら ai:review-reply-reset を使ってください）`);
}
if (historyIgnoredCount > 0) {
  console.log(`  既読履歴の対象外message: ${historyIgnoredCount}件（他タスク・自分の返信など。無視ログには入れていません）`);
}
if (historyWarning) console.log(`REVIEW_PROCESS_WARNING: ${historyWarning}`);
if (historySaturated) {
  console.log(
    `REVIEW_PROCESS_WARNING: 既読履歴を上限 ${historyLimit} 件まで読み切りました。`
      + 'これより古い依頼は窓の外です。--history-limit で広げて再実行してください。',
  );
}
if (historyUnparsedCount > 0) {
  console.log(
    `REVIEW_PROCESS_WARNING: 既読履歴の ${historyUnparsedCount} 行を解釈できず照合対象から外しました。`
      + 'history.shの出力形式が変わった可能性があります（依頼を取りこぼしている恐れがあります）。',
  );
}
for (const state of states) console.log(`  Request-ID: ${state.requestId}`);
if (states.length === 0) {
  if (requestedId) {
    console.error(`✗ 指定Request-ID '${requestedId}' は一致依頼にありません。`);
    process.exit(2);
  }
  console.error('✗ 一致するレビュー依頼はありません。');
  process.exit(1);
}
if (requestedId) {
  const selectedCount = matchCountsById.get(requestedId) || 0;
  if (selectedCount === 0) {
    console.error(`✗ 指定Request-ID '${requestedId}' は一致依頼にありません。`);
    process.exit(2);
  }
  if (selectedCount > 1) {
    console.error(`✗ 指定Request-ID '${requestedId}' は一致依頼に${selectedCount}件あり曖昧です。`);
    process.exit(2);
  }
  console.log(`  選択済み: ${requestedId}`);
} else if (states.length > 1) {
  console.error('✗ 複数依頼を保存しました。--request-id <ID> で1件を明示してください。');
  process.exit(2);
}
console.log(`  保存先: ${requestsDir}`);
