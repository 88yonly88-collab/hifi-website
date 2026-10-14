/** reviewer起動前ガード: 最新Request-IDをreviewer stateへ同期してから査読を許可する。 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IDENTIFIER_PATTERN,
  repoKey,
  resolveLane,
  runAgmsgScript,
  workflowProfile,
} from './ai-workflow-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const taskFile = join(root, '.ai', 'current-task.json');
const requestFile = join(root, '.ai', 'context', 'review-request.json');
const reviewerFile = join(root, '.ai', 'context', 'reviewer-current-request.json');
const inboxHelper = join(root, 'scripts', 'ai-review-inbox.mjs');

if (process.argv.length > 2) {
  console.error(`REVIEW_START_GUARD_FAILED: 不明な引数です: ${process.argv.slice(2).join(' ')}`);
  process.exit(2);
}

function oneLine(value, limit = 2000) {
  return String(value || '').replace(/[\u0000-\u0020\u007f]+/g, ' ').trim().slice(0, limit);
}

function regularNonSymlink(path) {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function readJson(path, label) {
  if (!regularNonSymlink(path)) throw new Error(`${label} is not a regular non-symlink file`);
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} cannot be parsed: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} root is not an object`);
  }
  return value;
}

function expectedRequest(task, lane) {
  const request = readJson(requestFile, 'review-request.json');
  const expected = {
    project: String(task.project ?? ''),
    repo: String(task.repo ?? ''),
    branch: String(task.branch ?? ''),
    task: String(task.task ?? ''),
    team: String(task.team ?? ''),
    from: lane.implementer,
    to: lane.reviewer,
  };
  if (request.status !== 'sent') throw new Error(`review-request status is ${String(request.status || 'missing')}, expected sent`);
  if (!IDENTIFIER_PATTERN.test(String(request.requestId || ''))) throw new Error('review-request Request-ID is invalid');
  for (const [key, value] of Object.entries(expected)) {
    if (!value || request[key] !== value) throw new Error(`review-request ${key} does not match current-task.json`);
  }
  return request;
}

function reviewerMatches(current, expected) {
  if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
  for (const key of ['requestId', 'project', 'repo', 'branch', 'task', 'team', 'from', 'to']) {
    if (current[key] !== expected[key]) return false;
  }
  return typeof current.body === 'string' && current.body.includes(`Request-ID: ${expected.requestId}`);
}

let task;
let requestId = 'unknown';
let bridgeTeam = '';
let notifyFrom = 'review-start-guard';

function notifyParent(reason) {
  if (!bridgeTeam || !IDENTIFIER_PATTERN.test(bridgeTeam)) {
    throw new Error('cc-bridge team cannot be derived safely');
  }
  const body = [
    'REVIEW_START_BLOCKED',
    `repo=${String(task?.repo || repoKey(root))}`,
    `Request-ID=${requestId}`,
    `reason=${oneLine(reason, 800)}`,
    '査読は開始していません。reviewer stateの取り込みを直してから再実行してください。',
  ].join(' ');
  runAgmsgScript('send.sh', [bridgeTeam, notifyFrom, 'claude-code', body], { cwd: root });
}

function failClosed(reason) {
  console.error(`REVIEW_START_GUARD_FAILED: ${reason}`);
  // 親通知が必要なのは、送信済みRequest-IDの自動取込・再照合に失敗した場合。
  // task/profile/status自体が不正でRequest-IDを確定できない段階では、原因表示だけで止める。
  if (requestId === 'unknown') process.exit(2);
  try {
    notifyParent(reason);
    console.error(`REVIEW_START_PARENT_NOTIFIED: team=${bridgeTeam} to=claude-code Request-ID=${requestId}`);
  } catch (error) {
    console.error(`REVIEW_START_PARENT_NOTIFY_FAILED: ${error.message}`);
  }
  process.exit(2);
}

try {
  task = readJson(taskFile, 'current-task.json');
  if (workflowProfile(task) !== 'gpt56-claude-v1') throw new Error('workflowProfile is not gpt56-claude-v1');
  const lane = resolveLane(task, root, 'reviewer');
  if (lane.errors.length > 0) throw new Error(`reviewer lane cannot be resolved: ${lane.errors.join('; ')}`);
  const repo = repoKey(task.repo).toLowerCase();
  bridgeTeam = `${repo}-cc-bridge`;
  notifyFrom = lane.reviewer || notifyFrom;
  if (!IDENTIFIER_PATTERN.test(repo) || !IDENTIFIER_PATTERN.test(notifyFrom)) {
    throw new Error('repo or reviewer identifier is invalid');
  }
  const expected = expectedRequest(task, lane);
  requestId = expected.requestId;

  let current = null;
  if (regularNonSymlink(reviewerFile)) {
    try {
      current = readJson(reviewerFile, 'reviewer-current-request.json');
    } catch {
      current = null;
    }
  }
  if (reviewerMatches(current, expected)) {
    console.log(`REVIEW_START_GUARD_OK: Request-ID=${requestId}`);
    process.exit(0);
  }

  if (!regularNonSymlink(inboxHelper)) throw new Error('ai-review-inbox.mjs is not a regular non-symlink file');
  let output;
  try {
    output = execFileSync(process.execPath, [inboxHelper, '--request-id', requestId], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = oneLine(error?.stderr || error?.stdout || error?.message || error);
    throw new Error(`automatic inbox import failed: ${detail || 'no diagnostic'}`);
  }
  if (output.trim()) console.log(output.trim());
  current = readJson(reviewerFile, 'reviewer-current-request.json');
  if (!reviewerMatches(current, expected)) {
    throw new Error('automatic inbox import completed but reviewer-current-request.json still does not match');
  }
  console.log(`REVIEW_START_GUARD_SYNCED: Request-ID=${requestId}`);
} catch (error) {
  failClosed(error.message);
}
