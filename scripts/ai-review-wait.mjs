import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiCmd, IDENTIFIER_PATTERN } from './ai-workflow-lib.mjs';
import {
  atomicWriteJson,
  ensureSafeFile,
  loadValidatedQueueResult,
  queueResultReplyBody,
} from './ai-review-queue-lib.mjs';
import { loadReviewRequest } from './ai-review-rounds-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const contextDir = join(root, '.ai', 'context');
const taskFile = join(root, '.ai', 'current-task.json');
const MAX_TIMEOUT_SECONDS = 86_400;
const MAX_INTERVAL_SECONDS = 3_600;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const args = process.argv.slice(2);
const valueOptions = new Set(['--request-id', '--timeout-seconds', '--interval-seconds']);
const positional = [];
const unknown = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (valueOptions.has(arg)) {
    if (!args[index + 1] || args[index + 1].startsWith('--')) unknown.push(arg);
    else index += 1;
  } else if (arg.startsWith('--')) {
    unknown.push(arg);
  } else {
    positional.push(arg);
  }
}
if (unknown.length || positional.length > 1) {
  console.error(`✗ 不明または不正な引数です: ${[...unknown, ...positional.slice(1)].join(' ')}`);
  process.exit(2);
}
const requestId = option('--request-id', positional[0] || '');
const timeoutSecondsText = option('--timeout-seconds', '1800');
const intervalSecondsText = option('--interval-seconds', '30');
if (!IDENTIFIER_PATTERN.test(requestId)) {
  console.error('✗ Request-IDを指定してください。');
  try {
    const saved = JSON.parse(readFileSync(join(contextDir, 'review-request.json'), 'utf8'));
    if (IDENTIFIER_PATTERN.test(String(saved.requestId || ''))) {
      console.error(`  保存済みRequest-ID: ${saved.requestId}`);
    } else {
      console.error('  確認先: .ai/context/review-request.json の requestId');
    }
  } catch {
    console.error('  確認先: .ai/context/review-request.json の requestId');
  }
  process.exit(2);
}
for (const [label, value, allowZero, maximum] of [
  ['--timeout-seconds', timeoutSecondsText, true, MAX_TIMEOUT_SECONDS],
  ['--interval-seconds', intervalSecondsText, false, MAX_INTERVAL_SECONDS],
]) {
  const numeric = Number(value);
  if (
    !/^[0-9]+$/u.test(value) ||
    !Number.isSafeInteger(numeric) ||
    (!allowZero && numeric < 1) ||
    numeric > maximum
  ) {
    console.error(`✗ ${label} は${allowZero ? '0' : '1'}〜${maximum}秒の整数で指定してください。`);
    process.exit(2);
  }
}

let task;
try {
  task = JSON.parse(readFileSync(taskFile, 'utf8'));
} catch (error) {
  console.error(`✗ current-task.jsonを読めません: ${error.message}`);
  process.exit(2);
}
let loaded;
try {
  loaded = loadReviewRequest(root, task);
} catch (error) {
  console.error(`✗ review-request.jsonを読めません: ${error.message}`);
  process.exit(2);
}
const request = loaded.request;
if (!request || request.mode !== 'queue' || request.requestId !== requestId) {
  console.error('✗ 保存済みのqueue依頼とRequest-IDが一致しません。');
  process.exit(2);
}
if (request.status === 'reset') {
  console.error(`✗ reset済みの旧Request-IDから結果を再回収しません。${aiCmd('review-send', '--yes', { root })} で新しい依頼を登録してください。`);
  process.exit(2);
}

const deadline = Date.now() + Number(timeoutSecondsText) * 1000;
const intervalMs = Number(intervalSecondsText) * 1000;
let checked;
let pendingWarningShown = false;
while (true) {
  try {
    checked = loadValidatedQueueResult(request);
  } catch (error) {
    console.error(`✗ queue結果を受け入れられません: ${error.message}`);
    if (/inputHash/u.test(error.message)) {
      console.error(`  新しいRequest-IDで再依頼: AI_REVIEW_MODE=queue ${aiCmd('review-send', '--yes --force-new', { root })}`);
    }
    process.exit(2);
  }
  if (checked.ready) break;
  if (checked.state.status === 'pending' && !pendingWarningShown) {
    console.error('REVIEW_QUEUE_WORKER_WARNING: 第2段の作業役が未稼働なら、この依頼は処理されず時間切れになります。');
    pendingWarningShown = true;
  }
  if (Date.now() >= deadline) {
    console.error(`REVIEW_QUEUE_TIMEOUT Request-ID=${requestId} state=${checked.state.status}`);
    process.exit(1);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(intervalMs, Math.max(1, deadline - Date.now())));
}

const replyPath = join(contextDir, `queue-reply-${requestId}.json`);
const body = queueResultReplyBody(request, checked.result);
const imported = {
  schemaVersion: 1,
  requestId,
  status: 'imported',
  mode: 'queue',
  team: request.team,
  from: request.to,
  to: request.from,
  body,
  inputHash: checked.actualInputHash,
  promptVersion: checked.result.promptVersion,
  model: checked.result.model,
  fallbackFrom: String(checked.result.fallbackFrom || ''),
  verdict: checked.result.verdict,
  attempt: checked.result.attempt,
  leaseGeneration: checked.result.leaseGeneration,
  ownerToken: checked.result.ownerToken,
  workerDurationMs: Number.isFinite(checked.result.workerDurationMs) ? checked.result.workerDurationMs : null,
  retry: checked.result.retry,
  failureReason: String(checked.result.failureReason || ''),
  resultPath: checked.resultPath,
  importedAt: new Date().toISOString(),
};
if (existsSync(replyPath)) {
  let previous;
  try {
    ensureSafeFile(replyPath, '回収済みqueue結果');
    previous = JSON.parse(readFileSync(replyPath, 'utf8'));
  } catch (error) {
    console.error(`✗ 既存の回収結果を読めません: ${error.message}`);
    process.exit(2);
  }
  if (
    previous.requestId !== imported.requestId ||
    previous.inputHash !== imported.inputHash ||
    previous.verdict !== imported.verdict ||
    previous.body !== imported.body ||
    previous.promptVersion !== imported.promptVersion ||
    previous.model !== imported.model ||
    String(previous.fallbackFrom || '') !== imported.fallbackFrom ||
    previous.attempt !== imported.attempt ||
    previous.leaseGeneration !== imported.leaseGeneration ||
    previous.ownerToken !== imported.ownerToken ||
    previous.workerDurationMs !== imported.workerDurationMs ||
    previous.retry !== imported.retry ||
    previous.failureReason !== imported.failureReason
  ) {
    const nextRetryAttempt =
      previous.requestId === imported.requestId &&
      previous.inputHash === imported.inputHash &&
      previous.retry === true &&
      Number.isInteger(previous.attempt) &&
      imported.attempt === previous.attempt + 1;
    if (!nextRetryAttempt) {
      console.error('✗ 同じRequest-IDに異なる回収結果があります。上書きしません。');
      process.exit(2);
    }
    atomicWriteJson(replyPath, imported);
    console.log(`REVIEW_QUEUE_RETRY_ADVANCED Request-ID=${requestId} attempt=${imported.attempt}`);
  }
} else {
  atomicWriteJson(replyPath, imported);
}

console.log(`REVIEW_QUEUE_RESULT Request-ID=${requestId}`);
console.log(`state=${checked.state.status}`);
console.log(`saved=${replyPath}`);
console.log(`findings=${checked.result.verdict === 'findings' ? 'yes' : 'no'}`);
console.log(`retry=${checked.result.retry === true ? 'yes' : 'no'}`);
