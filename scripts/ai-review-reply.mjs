/** reviewer専用: 保存済み依頼へ6項目ヘッダーを自動付与して安全に返信する。 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { aiCmd, IDENTIFIER_PATTERN, resolveLane, runAgmsgScript } from './ai-workflow-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const contextDir = join(root, '.ai', 'context');
const taskFile = join(root, '.ai', 'current-task.json');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? '') : '';
}

const send = process.argv.includes('--yes');
const retry = process.argv.includes('--retry');
const requestedId = argValue('--request-id');
const message = argValue('--message').trim();
if (requestedId && !IDENTIFIER_PATTERN.test(requestedId)) {
  console.error('✗ --request-id の文字種が不正、または128文字を超えています。');
  process.exit(2);
}
if (!message) {
  console.error('✗ --message にレビュー本文を指定してください。');
  process.exit(1);
}
if (retry && !send) {
  console.error('✗ --retry は明示送信のため --yes が必須です。');
  process.exit(1);
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
  console.error('✗ reviewerレーンを解決できないため返信しません:');
  for (const error of lane.errors) console.error(`  - ${error}`);
  process.exit(2);
}

const requestFile = requestedId
  ? join(contextDir, 'reviewer-requests', `${requestedId}.json`)
  : join(contextDir, 'reviewer-current-request.json');
if (!existsSync(requestFile)) {
  console.error(`✗ 保存済みレビュー依頼がありません。先に ${aiCmd('review-inbox', '', { root })} を実行してください。`);
  process.exit(1);
}
let request;
try {
  request = JSON.parse(readFileSync(requestFile, 'utf8'));
} catch (error) {
  console.error(`✗ reviewer requestを読めません: ${error.message}`);
  process.exit(2);
}
if (request.status === 'selection-required') {
  console.error(`✗ 複数Request-IDがあります。--request-idで1件を明示してください: ${(request.requestIds || []).join(', ')}`);
  process.exit(1);
}
const stateMatches =
  request.requestId && IDENTIFIER_PATTERN.test(request.requestId) &&
  (!requestedId || request.requestId === requestedId) &&
  request.team === lane.team && request.from === lane.to && request.to === lane.from &&
  request.project === String(task.project ?? '') && request.repo === String(task.repo ?? '') &&
  request.branch === String(task.branch ?? '') && request.task === String(task.task ?? '');
if (!stateMatches) {
  console.error('✗ 保存済み依頼とcurrent-task/team/from/toが一致しません。返信しません。');
  process.exit(2);
}

const replyStateFile = join(contextDir, `reviewer-reply-${request.requestId}.json`);
if (!requestedId && existsSync(replyStateFile)) {
  console.error('✗ この依頼には既存reply stateがあります。古いcurrentへの誤返信を防ぐため --request-id が必須です。');
  process.exit(1);
}

const body = `Project: ${request.project}\nRepo: ${request.repo}\nBranch: ${request.branch}\nTask: ${request.task}\nTeam: ${request.team}\nRequest-ID: ${request.requestId}\n\n${message}`;
console.log('=== ai:review-reply ===');
console.log(`  mode=${send ? 'SEND' : 'dry-run'} ${lane.team}/${lane.from} → ${lane.to}`);
console.log(body);
if (!send) {
  console.log(`→ 送信: ${aiCmd('review-reply', '--message "..." --yes', { root })}`);
  process.exit(0);
}

let previousReply = null;
if (existsSync(replyStateFile)) {
  try {
    previousReply = JSON.parse(readFileSync(replyStateFile, 'utf8'));
    if (!previousReply || previousReply.requestId !== request.requestId) {
      throw new Error('Request-IDが一致しません');
    }
  } catch (error) {
    console.error(`✗ 既存reply stateを読めません: ${error.message}`);
    process.exit(2);
  }
}
const sharedStateRoot = String(process.env.REVIEW_REQUEST_ANSWER_STATE_DIR || '').trim()
  || join(homedir(), 'projects', '.agent-work', '.review-request-answer-watch');
const sharedStateFile = join(sharedStateRoot, `${request.requestId}.json`);
let sharedReply = null;
if (existsSync(sharedStateFile)) {
  try {
    const info = lstatSync(sharedStateFile);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('regular fileではありません');
    sharedReply = JSON.parse(readFileSync(sharedStateFile, 'utf8'));
    if (!sharedReply || sharedReply.requestId !== request.requestId) {
      throw new Error('Request-IDが一致しません');
    }
  } catch (error) {
    console.error(`✗ 共有済みreply stateを安全に読めません: ${error.message}`);
    process.exit(2);
  }
}
if (retry && !previousReply) {
  console.error('✗ retry対象のreply stateがありません。通常送信してください。');
  process.exit(1);
}
const answeredState = [previousReply, sharedReply]
  .find((state) => state && ['sent', 'send-attempted'].includes(state.status));
if (answeredState && !retry) {
  console.log(`SKIP_ALREADY_ANSWERED Request-ID=${request.requestId} status=${answeredState.status}`);
  process.exit(0);
}
if (previousReply && retry) {
  const historyDir = join(contextDir, 'reviewer-reply-history');
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(
    join(historyDir, `${request.requestId}-${randomUUID()}-retry.json`),
    `${JSON.stringify({ ...previousReply, archivedAt: new Date().toISOString(), archiveReason: 'explicit-retry' }, null, 2)}\n`,
    'utf8',
  );
}
try {
  const attemptedAt = new Date().toISOString();
  writeFileSync(
    replyStateFile,
    `${JSON.stringify({ requestId: request.requestId, status: 'send-attempted', team: lane.team, from: lane.from, to: lane.to, body, sendAttemptedAt: attemptedAt }, null, 2)}\n`,
    'utf8',
  );
  runAgmsgScript('send.sh', [lane.team, lane.from, lane.to, body], { cwd: root });
  writeFileSync(
    replyStateFile,
    `${JSON.stringify({ requestId: request.requestId, status: 'sent', team: lane.team, from: lane.from, to: lane.to, body, sendAttemptedAt: attemptedAt, sentAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  console.log('✓ reviewer返信を送信しました。');
} catch (error) {
  console.error(`✗ send.sh に失敗しました: ${error.message}`);
  console.error('  送信成否不明のため自動再送しません。reply stateを確認してください。');
  process.exit(2);
}
