/** 送信済みreview requestを明示的にresetし、次回新しいRequest-IDを作れるようにする。 */
import { randomUUID } from 'crypto';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { aiCmd, IDENTIFIER_PATTERN } from './ai-workflow-lib.mjs';
import { ensureSafeDirectory, markQueueRequestReset, queueEntryPath } from './ai-review-queue-lib.mjs';
import { loadReviewRequest } from './ai-review-rounds-lib.mjs';
import { RUNTIME_EVIDENCE_MARKER_KEY, withReviewRequestLock } from './ai-runtime-evidence-lib.mjs';
import { noteExternalReset } from './ai-review-cycle-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const contextDir = join(root, '.ai', 'context');
const taskFile = join(root, '.ai', 'current-task.json');
const stateFile = join(contextDir, 'review-request.json');
const requestFile = join(contextDir, 'review-request.md');

if (!process.argv.includes('--yes')) {
  console.error(`✗ resetは明示確認が必要です: ${aiCmd('review-reset', '--yes', { root })}`);
  process.exit(1);
}
let task;
try {
  task = JSON.parse(readFileSync(taskFile, 'utf8'));
} catch (error) {
  console.error(`✗ .ai/current-task.json を読めません: ${error.message}`);
  process.exit(2);
}
let loaded;
try {
  loaded = loadReviewRequest(root, task);
} catch (error) {
  console.error(`✗ review-request.json を読めません: ${error.message}`);
  process.exit(2);
}
if (loaded.staleDiscarded) {
  console.log('✓ 前タスク（または旧形式）のreview requestを履歴へ退避しました。reset対象は残っていません。');
  process.exit(0);
}
const state = loaded.request;
if (state) noteExternalReset(root, { requestId: state.requestId, reason: 'ai-review-reset' });
if (!state) {
  console.error('✗ review-request.json がありません。reset対象なし。');
  process.exit(1);
}
if (!state.requestId || !IDENTIFIER_PATTERN.test(state.requestId)) {
  console.error('✗ Request-IDが無いか文字種・長さが不正なためresetできません。');
  process.exit(2);
}

// 取り消し対象の取り違えを機械で止める。
// 親が「1つ前の往復を片付ける」つもりでresetを打つ間に、レーンが次の往復を送信していることがある。
// その場合、無条件resetは送られたばかりの未返信requestを黙って無効化し、レーンは生きていると
// 誤認したままkickを待ち続ける（2026-08-07 IG8で実際に発生。復旧に再送1往復を要した）。
// 未返信のrequestを消すときだけ、対象IDの明示を必須にする。
const requestIdIndex = process.argv.indexOf('--request-id');
const namedRequestId = requestIdIndex >= 0 ? String(process.argv[requestIdIndex + 1] || '').trim() : '';
const isUnanswered = String(state.status || '').trim() === 'sent';
if (isUnanswered && !namedRequestId) {
  console.error(
    `✗ 未返信のreview requestをresetするには対象IDの明示が必要です: ${aiCmd(
      'review-reset',
      `--yes --request-id ${state.requestId}`,
      { root },
    )}`,
  );
  console.error('  いま保留中のRequest-ID: ' + state.requestId);
  console.error('  返信済み(accepted)のrequestは、これまでどおり --yes だけでresetできます。');
  console.error('  意図した対象と違う場合、レーンが直前に次の往復を送信しています。resetせず状態を確認してください。');
  process.exit(1);
}
if (namedRequestId && namedRequestId !== state.requestId) {
  console.error(`✗ 指定したRequest-ID(${namedRequestId})は保留中のもの(${state.requestId})と一致しません。`);
  console.error('  レーンが新しい往復を送信した可能性があります。resetせず ai:review-check で状態を確認してください。');
  process.exit(1);
}

const now = new Date().toISOString();
const isQueueMode = state.mode === 'queue';
withReviewRequestLock(root, () => {
  const current = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
  if (!current || current.requestId !== state.requestId || current.status !== state.status ||
      current.contentHash !== state.contentHash || current.reviewHeadCommit !== state.reviewHeadCommit) {
    throw new Error('review-request.jsonの現状態がreset対象と一致しません');
  }
  if (isQueueMode) {
    const expectedEntry = state.queueEntry || null;
    if ((current.queueEntry || null) !== expectedEntry) {
      throw new Error('review-request.jsonの現状態がreset対象と一致しません');
    }
    const entryDir = queueEntryPath(state.requestId);
    if (expectedEntry !== null && (typeof expectedEntry !== 'string' || resolve(expectedEntry) !== entryDir)) {
      throw new Error('送信時とreset時のqueue保存先が一致しません。送信時と同じ保存先設定で再実行してください');
    }
    if (!existsSync(entryDir)) {
      throw new Error('reset対象のqueue依頼が現在の保存先にありません。送信時と同じ保存先設定で再実行してください');
    }
    ensureSafeDirectory(entryDir);
  }
  const historyDir = join(contextDir, 'review-request-history');
  mkdirSync(historyDir, { recursive: true, mode: 0o700 });
  const historyStat = lstatSync(historyDir);
  if (!historyStat.isDirectory() || historyStat.isSymbolicLink()) {
    throw new Error('review-request-historyが安全なdirectoryではありません');
  }
  const archiveBase = `${state.requestId}-${randomUUID()}-explicit-reset`;
  const jsonPath = join(historyDir, `${archiveBase}.json`);
  const jsonBody = `${JSON.stringify({ ...current, archivedAt: now, archiveReason: 'explicit-reset' }, null, 2)}\n`;
  writeFileSync(jsonPath, jsonBody, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  if (readFileSync(jsonPath, 'utf8') !== jsonBody) {
    throw new Error('archive JSONの照合に失敗しました');
  }
  if (existsSync(requestFile)) {
    const mdInfo = lstatSync(requestFile);
    if (!mdInfo.isFile() || mdInfo.isSymbolicLink()) {
      throw new Error('review-request.mdが通常ファイルではありません');
    }
    const markdownBody = readFileSync(requestFile);
    const mdPath = join(historyDir, `${archiveBase}.md`);
    writeFileSync(mdPath, markdownBody, { flag: 'wx', mode: 0o600 });
    if (!readFileSync(mdPath).equals(markdownBody)) {
      throw new Error('archive Markdownの照合に失敗しました');
    }
  }
  const temporary = `${stateFile}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const body = `${JSON.stringify({ ...current, status: 'reset', resetAt: now }, null, 2)}\n`;
    writeSync(fd, body);
    closeSync(fd);
    fd = null;
    renameSync(temporary, stateFile);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
});
if (isQueueMode) {
  try {
    markQueueRequestReset(state.requestId, { expectedEntry: state.queueEntry || null });
  } catch (error) {
    console.error(`✗ Request-ID ${state.requestId} のparent resetは完了しましたが、旧queue依頼へreset印を保存できませんでした: ${error.message}`);
    console.error('  親状態はreset済みです。queue側のreset印を確認して手動で整合してください。');
    process.exit(2);
  }
}
console.log(`✓ Request-ID ${state.requestId} をresetしました。`);
console.log('→ 次回 ai:review-send は新しいRequest-IDを発行します。queue方式では旧IDをreissueOfへ記録します。');
