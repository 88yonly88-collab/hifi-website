/**
 * agmsg Manager - review-send（profileで指定した独立reviewerへのレビュー依頼）
 *
 * 目的:
 *   profileで指定したreviewerへの依頼を、毎回 agmsg を手打ちせず送れるようにする。
 *
 * 使い方:
 *   node scripts/ai-review-send.mjs           dry-run（依頼文を生成・保存・表示するだけ。送信しない）
 *   node scripts/ai-review-send.mjs --yes      ガードを全て満たす場合のみ agmsg で送信する
 *
 * 処理:
 *   1. .ai/current-task.json を読む
 *   2. 現在の git repo / branch を取得
 *   3. current-task.json の repo / branch と一致するか確認
 *   4. 不一致なら送信中止
 *   5. team が空なら送信中止
 *   6. reviewer が空なら送信中止
 *   7. 基準枝との分岐点からHEADまでの保存済み差分と未保存差分を解決
 *   8. 同じ対象範囲の git diff --stat
 *   9. 同じ対象範囲の git diff（.env 等の秘密を除外・上限文字数で切詰）
 *   10. profileのreviewer宛のレビュー依頼文を生成
 *   11. .ai/context/review-request.md に保存
 *   12. --yes時は親レーン・cc-bridge登録・同名重複・reviewer控え保存先を点検
 *   13. --yes かつ全ガード通過時のみ agmsg で送信
 *
 * ※ 今回は review-send のみ。review-check / 自動修正ループは未実装。
 */
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { homedir } from 'os';
import { join, basename, dirname, resolve, isAbsolute } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createHash, randomUUID } from 'crypto';
import {
  aiCmd,
  agmsgScriptsDir,
  agentId,
  gitOutput,
  IDENTIFIER_PATTERN,
  parseTeamRegistrations,
  repoKey,
  resolveLane,
  runAgmsgScript,
  workflowProfile,
} from './ai-workflow-lib.mjs';
import { actualRepoName } from './ai-e2e-lib.mjs';
import { loadApproval } from './ai-approval-lib.mjs';
import {
  buildVerificationSection,
  codeReviewClosed,
  cmgbFocusedProofSourceGuidance,
  cmgbFocusedTargets,
  cmgbFocusedTargetsHash,
  cmgbNativeFocusedIdentity,
  loadReviewRequest,
  loadReviewRounds,
  resolveReviewDiffScope,
  taskIdentity,
} from './ai-review-rounds-lib.mjs';
import { RUNTIME_EVIDENCE_MARKER_KEY, withReviewRequestLock } from './ai-runtime-evidence-lib.mjs';
import {
  NATIVE_QUEUE_REVIEWER_EFFORT,
  NATIVE_QUEUE_REVIEWER_MODEL,
  NATIVE_REVIEW_CHAIN_VERSION,
  REVIEW_QUEUE_PROMPT_VERSION,
  assertNativePinCoversManifest,
  atomicWriteFile,
  atomicWriteJson,
  buildNativeReviewPin,
  calculateQueueInputHash,
  captureConsistentQueueSnapshot,
  conservativeQueueReissueMetadata,
  decodeReviewBytes,
  listQueueChangedPaths,
  literalGitPathspecs,
  markQueueRequestReset,
  nativePinClassifiedPaths,
  queueEntryPath,
  queueReissueMetadata,
  queueReissueCostPolicy,
  queueRequestId,
  readQueueJson,
  redactReviewText,
  registerQueueEntry,
  resolveQueueCostLimits,
  sha256,
  sha256File,
} from './ai-review-queue-lib.mjs';

function exitWithError(message, code = 2) {
  try {
    writeSync(2, `${message}\n`);
  } catch {
    console.error(message);
  }
  process.exit(code);
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const taskFile = join(root, '.ai', 'current-task.json');
const contextDir = join(root, '.ai', 'context');
const requestFile = join(contextDir, 'review-request.md');
const requestStateFile = join(contextDir, 'review-request.json');

const MAX_DIFF_CHARS = 12000;
const MAX_CHECKLIST_CHARS = 6000;
const MAX_CHANGED_FILES = 200;
const MAX_CHANGED_FILES_CHARS = 12000;
const MAX_QUEUE_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_FOCUSED_TARGETS = 200;
const send = process.argv.includes('--yes');
const forceNew = process.argv.includes('--force-new');
function fixedOption(name) {
  const indices = process.argv.flatMap((value,index) => value === name ? [index] : []);
  if (!indices.length) return '';
  const value = process.argv[indices[0]+1];
  if (indices.length !== 1 || !value || value.startsWith('--')) exitWithError(`${name} requires exactly one value`);
  return value;
}
const fixedPinPath = fixedOption('--fixed-prepared-pin');
const fixedPinHash = fixedOption('--fixed-prepared-pin-sha256');
const fixedPreflight = process.argv.includes('--fixed-prepared-preflight');
if (fixedPinPath || fixedPinHash || fixedPreflight) {
  if (!fixedPinPath || !/^[a-f0-9]{64}$/.test(fixedPinHash) || forceNew || (fixedPreflight && send) || (!fixedPreflight && !send)) {
    exitWithError('FIXED_PREPARED_OPTIONS: supply pin + SHA256 and exactly one of preflight/--yes; force-new is forbidden');
  }
}

const primaryReviewed = process.argv.includes('--primary-reviewed');
const primaryEvidenceIndex = process.argv.indexOf('--primary-evidence');
const primaryEvidencePath = primaryEvidenceIndex >= 0 ? process.argv[primaryEvidenceIndex + 1] : '';
if (primaryReviewed) exitWithError('自己申告の --primary-reviewed は使用できません。実API結果に結び付く --primary-evidence <receipt.json> を指定してください。');
if (primaryEvidenceIndex >= 0 && (!primaryEvidencePath || primaryEvidencePath.startsWith('--'))) exitWithError('--primary-evidence にはファイルが必要です');
const nativeScopeIndex = process.argv.indexOf('--native-scope');
const nativeScopePath = nativeScopeIndex >= 0 ? process.argv[nativeScopeIndex + 1] : '';
if (nativeScopeIndex >= 0 && (!nativeScopePath || nativeScopePath.startsWith('--'))) exitWithError('--native-scope にはファイルが必要です');
const nativeScopeHashIndex = process.argv.indexOf('--native-scope-hash');
const nativeScopeHash = nativeScopeHashIndex >= 0 ? process.argv[nativeScopeHashIndex + 1] : '';
if (nativeScopeHashIndex >= 0 && (!nativeScopeHash || nativeScopeHash.startsWith('--'))) exitWithError('--native-scope-hash にはハッシュが必要です');
function nativeOptionValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) exitWithError(`${name} には値が必要です`);
    values.push(value.replaceAll('\\', '/'));
  }
  return values;
}
const nativeDeclaredReviewedPaths = nativeOptionValues('--native-reviewed-path');
const nativeIgnoredPathspecs = nativeOptionValues('--native-ignored-pathspec');
const reviewMode = String(process.env.AI_REVIEW_MODE || 'pane').trim();

if (fixedPinPath && reviewMode !== 'pane') exitWithError('FIXED_PREPARED_PANE_ONLY');

if (!['pane', 'queue'].includes(reviewMode)) {
  console.error('✗ AI_REVIEW_MODE は pane または queue を指定してください。');
  process.exit(2);
}

// 費用枠が揃わない依頼は、登録してから worker に止められると pending + 30分待機になり、
// 画面上は「レビュー待ち」に見えたまま進まない。登録前にここで止め、不足内容を1画面で出す。
function reportQueueCostBlock(cost) {
  console.error(`✗ queue登録を中止しました: ${cost.summary}`);
  console.error(cost.code === 'over_approved_limit'
    ? '  （承認された額を超える依頼は送りません。金額の判断は人に戻します）'
    : '  （このまま登録すると30分待機のまま進まないため、この場で止めています）');
  for (const line of cost.lines) console.error(line);
  console.error(cost.code === 'over_approved_limit'
    ? '  上の対応を行ったうえで、同じ内容のまま再実行してください:'
    : '  承認をcommitしてから、同じ内容のまま再実行してください（--force-newは付けない）:');
  console.error(`    AI_REVIEW_MODE=queue ${aiCmd('review-send', '--yes', { root })}`);
  if (cost.code === 'approval_missing') {
    console.error('  承認の範囲内で今回だけ枠を明示する場合（台帳の承認は別途必要です）:');
    console.error('    AI_REVIEW_MODE=queue AI_REVIEW_MAX_COST_YEN=<円> AI_REVIEW_TASK_MAX_COST_YEN=<円> \\');
    console.error(`      ${aiCmd('review-send', '--yes', { root })}`);
  }
}

function git(args) {
  try {
    return gitOutput(args, { cwd: root });
  } catch {
    return null;
  }
}

// queue入力になるgit出力は生バイトで受け取り、UTF-8として読めるものだけを通す。
// 文字列へ潰してから判定すると、文字化けで置換文字になった秘密・個人情報を
// 伏せ字規則が取り逃がす。ここで止めれば、後段の検知は「読めた内容」だけを見ればよい。
function gitRequired(args, label) {
  let raw;
  try {
    raw = gitOutput(args, { cwd: root, encoding: 'buffer' });
  } catch (error) {
    const reason = String(error?.message || error || '不明なエラー').split('\n')[0];
    throw new Error(`${label}を取得できないためqueue登録を中止します: ${reason}`);
  }
  return decodeReviewBytes(raw, label);
}

function queueGitOrExit(args, label) {
  try {
    return gitRequired(args, label);
  } catch (error) {
    console.error(`✗ queue登録に失敗しました: ${error.message}`);
    process.exit(2);
  }
}

const REVIEW_REQUEST_CAS_KEYS = ['requestId', 'status', 'round', 'contentHash', 'reviewHeadCommit'];
const REVIEW_REQUEST_IMMUTABLE_KEYS = ['round', 'lens', 'recheck'];
const REVIEW_REQUEST_PATCH_KEYS = new Set([
  'status',
  'sendAttemptedAt',
  'sentAt',
  'queuedAt',
  'inputHash',
  'promptVersion',
  'reviewerModel',
  'reviewerEffort',
  'reviewerSandbox',
  'queueEntry',
  'mode',
  'createdAt',
  'workflowProfile',
  'team',
  'from',
  'to',
  'project',
  'repo',
  'branch',
  'task',
  'taskId',
  'taskFingerprint',
  'reviewBaseRef',
  'reviewBaseCommit',
  'reviewBaseSource',
  'reviewCommittedRangeEmpty',
  'contentHash',
  'primaryReview',
  'reviewChainVersion',
  'nativeReview',
  'nativeScopeFile',
  'nativeFocusedTargets',
  'nativeFocusedTargetsHash',
  'reissueOf',
  'reapprovalRequired',
]);

function captureReviewRequestPreimage(state) {
  if (!state) return { kind: 'absent' };
  const values = {};
  for (const key of REVIEW_REQUEST_CAS_KEYS) {
    values[key] = Object.prototype.hasOwnProperty.call(state, key) ? state[key] : undefined;
  }
  return { kind: 'present', values };
}

function reviewRequestPreimageMatches(current, expected) {
  if (expected.kind === 'absent') return current.kind === 'absent';
  if (current.kind !== 'present') return false;
  for (const key of REVIEW_REQUEST_CAS_KEYS) {
    const expectedValue = expected.values[key];
    const actualValue = Object.prototype.hasOwnProperty.call(current.state, key)
      ? current.state[key]
      : undefined;
    if (!Object.is(actualValue, expectedValue)) return false;
  }
  return true;
}

function sameReviewRequestImmutableFields(currentState, nextState) {
  for (const key of REVIEW_REQUEST_IMMUTABLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(currentState, key)) return false;
    if (!Object.prototype.hasOwnProperty.call(nextState, key)) return false;
    if (!Object.is(currentState[key], nextState[key])) return false;
  }
  return true;
}

function readCurrentReviewRequestState() {
  if (!existsSync(requestStateFile)) return { kind: 'absent' };
  const info = lstatSync(requestStateFile);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('review-request.jsonが通常ファイルまたはsymlinkでないためstate CASを中止します');
  }
  let raw;
  try {
    raw = readFileSync(requestStateFile, 'utf8');
  } catch (error) {
    throw new Error(`review-request.jsonを読めません: ${error.message}`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    throw new Error(`review-request.jsonが壊れたJSONのためstate CASを中止します: ${error.message}`);
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('review-request.jsonがobjectではありません');
  }
  return { kind: 'present', state };
}

function assertReviewRequestHeadUnchanged(expectedHead) {
  const actualHead = (git(['rev-parse', '--verify', '--quiet', 'HEAD']) || '').trim() || null;
  if (actualHead !== expectedHead) {
    throw new Error(`Git HEADが計画から変わったためstate CASを中止します（計画=${expectedHead || 'なし'} / 実=${actualHead || 'なし'}）`);
  }
}

function sleepForVerification(ms) {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitArray, 0, 0, Math.max(0, Math.min(5000, ms)));
}

function queueBundleIdentityMatches({ entryDir, parent, expected }) {
  if (!entryDir || !existsSync(entryDir)) return { ok: false, reason: 'queue entryが存在しません' };
  let entryStat;
  try {
    entryStat = lstatSync(entryDir);
  } catch (error) {
    return { ok: false, reason: `queue entryを確認できません: ${error.message}` };
  }
  if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
    return { ok: false, reason: 'queue entryが安全な通常ディレクトリではありません' };
  }
  if (existsSync(join(entryDir, 'reset.json'))) {
    return { ok: false, reason: 'queue entryにreset.jsonがあります' };
  }
  let queuedRequest;
  try {
    queuedRequest = readQueueJson(join(entryDir, 'request.json'), 'request.json');
  } catch (error) {
    return { ok: false, reason: `queue request.jsonを読めません: ${error.message}` };
  }
  const same = (a, b) => Object.is(a, b);
  if (!queuedRequest || typeof queuedRequest !== 'object' || Array.isArray(queuedRequest)) {
    return { ok: false, reason: 'queue request.jsonがobjectではありません' };
  }
  if (
    !same(queuedRequest.schemaVersion, 1) ||
    !same(queuedRequest[RUNTIME_EVIDENCE_MARKER_KEY], 1) ||
    !same(queuedRequest.promptVersion, REVIEW_QUEUE_PROMPT_VERSION) ||
    !same(queuedRequest.requestId, expected.requestId) ||
    !same(queuedRequest.taskId, expected.taskId) ||
    !same(queuedRequest.taskFingerprint, expected.taskFingerprint) ||
    !same(queuedRequest.head, expected.head) ||
    !same(queuedRequest.round, expected.round) ||
    !same(queuedRequest.lens, expected.lens) ||
    !same(queuedRequest.recheck, expected.recheck) ||
    !same(queuedRequest.reviewer?.configuredId, expected.target) ||
    !same(queuedRequest.reviewer?.model, expected.model) ||
    !same(queuedRequest.reviewer?.effort, expected.effort) ||
    !same(queuedRequest.inputHash, parent.inputHash)
  ) {
    return { ok: false, reason: 'queue request.jsonの同一性が親stateと一致しません' };
  }
  let recomputed;
  try {
    recomputed = calculateQueueInputHash(entryDir, queuedRequest.promptVersion, queuedRequest);
  } catch (error) {
    return { ok: false, reason: `queue inputHashを再計算できません: ${error.message}` };
  }
  if (!same(recomputed, queuedRequest.inputHash) || !same(recomputed, parent.inputHash)) {
    return { ok: false, reason: 'queue inputHashの再計算結果が一致しません' };
  }
  if (expected.body !== null && expected.body !== undefined) {
    let markdown;
    try {
      const mdPath = join(entryDir, 'request.md');
      const mdStat = lstatSync(mdPath);
      if (!mdStat.isFile() || mdStat.isSymbolicLink()) {
        return { ok: false, reason: 'queue request.mdが安全な通常ファイルではありません' };
      }
      markdown = readFileSync(mdPath);
    } catch (error) {
      return { ok: false, reason: `queue request.mdを読めません: ${error.message}` };
    }
    const expectedMarkdown = Buffer.from(redactReviewText(expected.body));
    if (!markdown.equals(expectedMarkdown)) {
      return { ok: false, reason: 'queue request.mdが期待するredacted本文と一致しません' };
    }
  }
  return { ok: true, reason: 'ok' };
}

function verifySameIntentQueueCompletion(expected) {
  let parent = null;
  try {
    return withReviewRequestLock(root, () => {
      const current = readCurrentReviewRequestState();
      if (current.kind !== 'present') {
        return { ok: false, reason: 'parent stateが不在です', state: null };
      }
      parent = current.state;
      const same = (a, b) => Object.is(a, b);
      if (
        !same(parent.requestId, expected.requestId) ||
        !same(parent.contentHash, expected.contentHash) ||
        !same(parent.taskId, expected.taskId) ||
        !same(parent.taskFingerprint, expected.taskFingerprint) ||
        !same(parent.reviewHeadCommit, expected.head) ||
        !same(parent.mode, 'queue') ||
        !same(parent.status, 'sent') ||
        !same(parent[RUNTIME_EVIDENCE_MARKER_KEY], 1) ||
        !same(parent.round, expected.round) ||
        !same(parent.lens, expected.lens) ||
        !same(parent.recheck, expected.recheck) ||
        !same(parent.promptVersion, REVIEW_QUEUE_PROMPT_VERSION) ||
        !same(parent.reviewerModel, expected.model) ||
        !same(parent.reviewerEffort, expected.effort)
      ) {
        return { ok: false, reason: 'parent stateの同一性または送信完了条件が一致しません', state: parent };
      }
      if (!same(parent.queueEntry, expected.entryDir)) {
        return { ok: false, reason: 'parent queueEntryがconfigured queueEntryPathと一致しません', state: parent };
      }
      assertReviewRequestHeadUnchanged(expected.head);
      return { ...queueBundleIdentityMatches({ entryDir: expected.entryDir, parent, expected }), state: parent };
    });
  } catch (error) {
    return { ok: false, reason: `queue勝者の確認中にエラー: ${error.message}`, state: parent };
  }
}

function waitForSameIntentQueueCompletion(expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() <= deadline) {
    let current;
    try {
      current = withReviewRequestLock(root, () => {
        const read = readCurrentReviewRequestState();
        return read.kind === 'present' ? read.state : null;
      });
    } catch (error) {
      return { ok: false, reason: `parent stateを確認できません: ${error.message}` };
    }
    if (current) {
      const same = (a, b) => Object.is(a, b);
      const identityMatches = same(current.requestId, expected.requestId)
        && same(current.contentHash, expected.contentHash)
        && same(current.taskId, expected.taskId)
        && same(current.taskFingerprint, expected.taskFingerprint)
        && same(current.reviewHeadCommit, expected.head)
        && same(current.mode, 'queue')
        && same(current.round, expected.round)
        && same(current.lens, expected.lens)
        && same(current.recheck, expected.recheck)
        && same(current.reviewerEffort, expected.effort);
      if (!identityMatches) {
        return { ok: false, reason: '別identityのstateへ変化したため成功扱いにしません' };
      }
      if (current.status === 'sent') {
        return verifySameIntentQueueCompletion(expected);
      }
      if (current.status !== 'prepared' && current.status !== 'send-attempted') {
        return { ok: false, reason: `勝者stateのstatusが成功条件を満たしません: ${current.status}` };
      }
      last = current.status;
    }
    sleepForVerification(100);
  }
  return { ok: false, reason: last ? `勝者stateが${last}のまま送信完了しませんでした` : 'parent stateを確認できませんでした' };
}

function writeExclusiveTempFile(path, content) {
  const fd = openSync(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function archiveReviewRequestStateWithinLock(state, reason) {
  if (!state?.requestId || !IDENTIFIER_PATTERN.test(state.requestId)) {
    throw new Error('既存Request-IDが無いか文字種・長さが不正です');
  }
  if (!/^[a-z0-9-]{1,80}$/u.test(String(reason || ''))) {
    throw new Error('archiveReasonが不正です');
  }
  const historyDir = join(contextDir, 'review-request-history');
  mkdirSync(historyDir, { recursive: true, mode: 0o700 });
  const historyStat = lstatSync(historyDir);
  if (!historyStat.isDirectory() || historyStat.isSymbolicLink()) {
    throw new Error('review-request-historyが安全なdirectoryではありません');
  }
  const archiveBase = `${state.requestId}-${randomUUID()}-${reason}`;
  const jsonPath = join(historyDir, `${archiveBase}.json`);
  const jsonInfo = lstatSync(requestStateFile);
  if (!jsonInfo.isFile() || jsonInfo.isSymbolicLink()) {
    throw new Error('review-request.jsonが通常ファイルまたはsymlinkでないためarchiveを中止します');
  }
  const jsonBody = readFileSync(requestStateFile);
  writeFileSync(jsonPath, jsonBody, { flag: 'wx', mode: 0o600 });
  if (!readFileSync(jsonPath).equals(jsonBody)) {
    throw new Error('archive JSONの照合に失敗しました');
  }
  let markdownBody = null;
  if (existsSync(requestFile)) {
    const mdInfo = lstatSync(requestFile);
    if (!mdInfo.isFile() || mdInfo.isSymbolicLink()) {
      throw new Error('review-request.mdが通常ファイルではありません');
    }
    markdownBody = readFileSync(requestFile);
    const mdPath = join(historyDir, `${archiveBase}.md`);
    writeFileSync(mdPath, markdownBody, { flag: 'wx', mode: 0o600 });
    if (!readFileSync(mdPath).equals(markdownBody)) {
      throw new Error('archive Markdownの照合に失敗しました');
    }
  }
  return { archiveBase, markdownBody };
}

function publishNewReviewRequestCas({ expectedPreimage, body, nextState, archiveReason }) {
  return withReviewRequestLock(root, () => {
    const current = readCurrentReviewRequestState();
    if (!reviewRequestPreimageMatches(current, expectedPreimage)) {
      throw new Error('review-request.jsonのpreimageが読取時から変わったため公開を中止します');
    }
    assertReviewRequestHeadUnchanged(nextState.reviewHeadCommit);
    let oldMarkdownBody = null;
    if (current.kind === 'present') {
      oldMarkdownBody = archiveReviewRequestStateWithinLock(current.state, archiveReason).markdownBody;
    } else if (existsSync(requestFile)) {
      throw new Error('stateが不在なのにreview-request.mdが存在するため公開を中止します');
    }
    const tempMd = join(contextDir, `.review-request.md.${process.pid}.${randomUUID()}.tmp`);
    const tempState = join(contextDir, `.review-request.json.${process.pid}.${randomUUID()}.tmp`);
    let markdownReplaced = false;
    try {
      writeExclusiveTempFile(tempMd, body);
      writeExclusiveTempFile(tempState, `${JSON.stringify(nextState, null, 2)}\n`);
      renameSync(tempMd, requestFile);
      markdownReplaced = true;
      renameSync(tempState, requestStateFile);
    } catch (error) {
      try {
        if (existsSync(tempMd)) unlinkSync(tempMd);
      } catch {}
      try {
        if (existsSync(tempState)) unlinkSync(tempState);
      } catch {}
      if (markdownReplaced) {
        try {
          if (oldMarkdownBody !== null) {
            writeFileSync(requestFile, oldMarkdownBody, 'utf8');
          } else if (existsSync(requestFile)) {
            unlinkSync(requestFile);
          }
        } catch (restoreError) {
          throw new Error(
            `新規request公開に失敗し、旧Markdownの復旧にも失敗しました: ${error.message}; ${restoreError.message}`,
          );
        }
      }
      throw new Error(`新規request公開に失敗しました: ${error.message}`);
    }
  });
}

function allowedReviewRequestStatusTransition(from, to) {
  if (from === to) return from === 'prepared';
  if (from === 'prepared' && (to === 'send-attempted' || to === 'sent')) return true;
  if (from === 'send-attempted' && to === 'sent') return true;
  return false;
}

function mergeReviewRequestState(currentState, patch) {
  if (!Object.prototype.hasOwnProperty.call(patch, 'status')) {
    throw new Error('state patchにstatusがありません');
  }
  const merged = { ...currentState };
  for (const [key, value] of Object.entries(patch)) {
    if (REVIEW_REQUEST_IMMUTABLE_KEYS.includes(key)) continue;
    if (REVIEW_REQUEST_PATCH_KEYS.has(key)) merged[key] = value;
  }
  merged.status = patch.status;
  return merged;
}

function updateExistingReviewRequestStateCas({ expectedPreimage, patch, verifyWithinLock = null }) {
  return withReviewRequestLock(root, () => {
    const current = readCurrentReviewRequestState();
    if (current.kind !== 'present') {
      throw new Error('review-request.jsonが不在のためstate更新を中止します');
    }
    if (!reviewRequestPreimageMatches(current, expectedPreimage)) {
      throw new Error('review-request.jsonのpreimageが読取時から変わったためstate更新を中止します');
    }
    if (verifyWithinLock) verifyWithinLock();
    if (!allowedReviewRequestStatusTransition(current.state.status, patch.status)) {
      throw new Error(`review stateのstatus遷移が許可されていません: ${current.state.status} -> ${patch.status}`);
    }
    if (
      Object.prototype.hasOwnProperty.call(patch, 'reviewHeadCommit') &&
      patch.reviewHeadCommit !== current.state.reviewHeadCommit
    ) {
      throw new Error('reviewHeadCommitが変わったためstate更新を中止します');
    }
    for (const key of REVIEW_REQUEST_IMMUTABLE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      if (!Object.prototype.hasOwnProperty.call(current.state, key)) {
        throw new Error(`${key}が既存stateに無いためstate更新を中止します`);
      }
      if (!Object.is(current.state[key], patch[key])) {
        throw new Error(`${key}は同IDのCASでは変更できません（既存=${JSON.stringify(current.state[key])} / 要求=${JSON.stringify(patch[key])}）`);
      }
    }
    const merged = mergeReviewRequestState(current.state, patch);
    atomicWriteJson(requestStateFile, merged);
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function agentWorkDir() {
  // 承認ゲートの作業宣言と同じ解決規則にする。
  // 外部から渡された場所は、明示許可がある場合だけ両方で使う。
  if (process.env.AGENT_WORK_DIR && process.env.AI_DEV_TOOL_ALLOW_AGENT_WORK_DIR === '1') {
    return process.env.AGENT_WORK_DIR;
  }
  return join(homedir(), 'projects', '.agent-work');
}

function projectsRoot() {
  return process.env.PROJECTS_ROOT || join(homedir(), 'projects');
}

function markerState(path, staleSeconds) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return '親レーンの印が通常ファイルではありません';
    const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;
    if (ageSeconds < -60) return '親レーンの印が未来日時です';
    if (ageSeconds > staleSeconds) return '親レーンの印が古く、受け取り先の生存を確認できません';
    return '';
  } catch (error) {
    if (error?.code === 'ENOENT') return '親レーンの印がありません';
    return `親レーンの印を安全に確認できません: ${error.message}`;
  }
}

function reviewerRequestWritable() {
  const aiDir = join(root, '.ai');
  const target = join(contextDir, 'reviewer-current-request.json');
  let probe;
  let fd;
  try {
    const aiStat = lstatSync(aiDir);
    if (!aiStat.isDirectory() || aiStat.isSymbolicLink()) {
      throw new Error(`${aiDir}は通常のディレクトリではありません`);
    }
    if (!existsSync(contextDir)) mkdirSync(contextDir, { mode: 0o700 });
    const contextStat = lstatSync(contextDir);
    if (!contextStat.isDirectory() || contextStat.isSymbolicLink()) {
      throw new Error(`${contextDir}は通常のディレクトリではありません`);
    }
    for (const name of readdirSync(contextDir)) {
      const staleProbeMatch = name.match(/^\.reviewer-current-request\.preflight\.(\d+)\.[0-9a-f-]+$/u);
      if (!staleProbeMatch) continue;
      let processAlive = true;
      try {
        process.kill(Number(staleProbeMatch[1]), 0);
      } catch (error) {
        if (error?.code === 'ESRCH') processAlive = false;
      }
      if (!processAlive) unlinkSync(join(contextDir, name));
    }
    let targetExists = false;
    try {
      lstatSync(target);
      targetExists = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (targetExists) {
      const targetStat = lstatSync(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        throw new Error(`${target}は通常ファイルではありません`);
      }
      fd = openSync(target, fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0));
      closeSync(fd);
      fd = undefined;
    }
    probe = join(contextDir, `.reviewer-current-request.preflight.${process.pid}.${randomUUID()}`);
    fd = openSync(
      probe,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    if (!fstatSync(fd).isFile()) throw new Error('確認用ファイルが通常ファイルではありません');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    unlinkSync(probe);
    return '';
  } catch (error) {
    return error.message;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    if (probe && existsSync(probe)) {
      try { unlinkSync(probe); } catch {}
    }
  }
}

function deliveryPreflight(taskValue, laneValue) {
  const repoLabel = String(taskValue.repo || '').trim();
  const failures = [];
  if (!IDENTIFIER_PATTERN.test(repoLabel)) {
    failures.push({
      message: 'current-task.jsonのrepo名を親レーンの確認に使えません。依頼はまだ送っていません。',
      fix: aiCmd('start', '', { root }),
    });
    return failures;
  }

  const configuredStaleSeconds = String(process.env.HERDR_PARENT_STALE_SECONDS || '604800');
  const staleSeconds = Number(configuredStaleSeconds);
  const logicalRoot = projectsRoot();
  const logicalRepoPath = join(logicalRoot, repoLabel);
  const normalizedRepoLabel = repoLabel.toLowerCase();
  const parentTeam = `${normalizedRepoLabel}-cc-bridge`;
  const parentMarker = join(agentWorkDir(), '.parent-panes', repoLabel);
  const parentStart = join(logicalRoot, 'knowledge', 'scripts', 'parent-start.sh');
  const parentProblem = Number.isInteger(staleSeconds) && staleSeconds > 0
    ? markerState(parentMarker, staleSeconds)
    : `親レーンの生存確認時間が不正です: ${configuredStaleSeconds}`;
  if (parentProblem) {
    failures.push({
      message: `${repoLabel}の${parentProblem}（確認先: ${parentMarker}）。依頼はまだ送っていません。`,
      fix: `bash ${shellQuote(parentStart)} ${shellQuote(repoLabel)}`,
      fallback: '親レーンを起動できない場合は、その失敗をユーザーへ通知してください。',
    });
  }

  const identitiesScript = join(agmsgScriptsDir(), 'identities.sh');
  if (!existsSync(identitiesScript)) {
    failures.push({
      message: 'agmsgの登録確認コマンドがありません。先にagmsgを導入または修復してください。依頼はまだ送っていません。',
      fix: `test -x ${shellQuote(identitiesScript)}`,
    });
  } else {
    try {
      // Parent identity name is stable across the official Claude -> Codex/Orca migration.
      // Cross-check team/name/path/type through official registration scripts only.
      const parentRegistrations = parseTeamRegistrations(runAgmsgScript('team.sh', [parentTeam], { cwd: root }));
      if (parentRegistrations.invalid || parentRegistrations.team !== parentTeam) {
        throw new Error(`${parentTeam}の登録一覧の形式が不正です`);
      }
      const parents = parentRegistrations.registrations.filter(entry => entry.agent === 'claude-code');
      if (parents.length !== 1) throw new Error(`${parentTeam}の正式親claude-codeを一意に確認できません`);
      const parent = parents[0];
      // knowledgeの親だけは、repo名の大文字小文字が実フォルダ名と違っても同じ親として扱う。
      const parentPathMatches = parent.projectPath === logicalRepoPath
        || (normalizedRepoLabel === 'knowledge' && parent.projectPath.toLowerCase() === logicalRepoPath.toLowerCase());
      if (!parentPathMatches || parent.types.some(kind => !['claude-code', 'codex'].includes(kind))) {
        throw new Error(`${parentTeam}の正式親のrepo path/typeが一致しません`);
      }
      let registered = false;
      for (const kind of parent.types) {
        // 照合済みの正式親の登録pathで問い合わせる(knowledgeの大文字小文字救済を実登録まで通すため)。
        const identities = runAgmsgScript('identities.sh', [parent.projectPath, kind], { cwd: root });
        const identityRows = String(identities).split(/\r?\n/).filter(Boolean).map(line => line.split('\t'));
        // 無関係なteamの行の不正は対象repoの登録判定へ巻き込まない。対象teamの行だけ形式を検査する。
        const relevantRows = identityRows.filter(([team]) => team === parentTeam);
        if (relevantRows.some(fields => fields.length !== 2 || fields.some(field => !IDENTIFIER_PATTERN.test(field)))) {
          throw new Error(`${parentTeam}の登録応答形式が不正です`);
        }
        if (relevantRows.some(([, agent]) => agent === 'claude-code')) registered = true;
      }
      if (!registered) {
        failures.push({
          message: `親への報告用チーム${parentTeam}に、このリポジトリを受け取る正式親が登録されていません。依頼はまだ送っていません。`,
          fix: `bash ${shellQuote(parentStart)} ${shellQuote(repoLabel)}`,
        });
      }
    } catch (error) {
      failures.push({
        message: `親への報告先を確認できません: ${error.message}。依頼はまだ送っていません。`,
        fix: `bash ${shellQuote(join(agmsgScriptsDir(), 'team.sh'))} ${shellQuote(parentTeam)}`,
      });
    }
  }

  for (const [team, watchedAgents, logicalParent] of [
    [laneValue.team, new Set([laneValue.implementer, laneValue.reviewer]), false],
    [parentTeam, new Set(['claude-code']), true],
  ]) {
    try {
      const parsed = parseTeamRegistrations(runAgmsgScript('team.sh', [team], { cwd: root }));
      if (parsed.invalid || parsed.team !== team) throw new Error('登録一覧の形式が不正です');
      const registrationCounts = new Map();
      for (const entry of parsed.registrations) {
        registrationCounts.set(entry.agent, (registrationCounts.get(entry.agent) || 0) + 1);
      }
      const duplicated = parsed.registrations
        .filter((entry) => watchedAgents.has(entry.agent) && (
          entry.additionalRegistrations > 0 || registrationCounts.get(entry.agent) > 1
        ))
        .map((entry) => entry.agent)
        .filter((entry, index, all) => all.indexOf(entry) === index);
      // knowledgeはrepo専任親と横断親の両方が受け取る既存契約なので、親teamのclaude-codeだけ重複を許す。
      // review lane側のimplementer/reviewer重複はknowledgeでも従来どおり拒否する。
      if (duplicated.length > 0 && !(logicalParent && normalizedRepoLabel === 'knowledge')) {
        const fixes = duplicated.map((duplicateAgent) => {
          if (logicalParent) return `bash ${shellQuote(parentStart)} ${shellQuote(repoLabel)}`;
          const kind = logicalParent
            ? 'claude-code'
            : duplicateAgent === laneValue.implementer
              ? String(taskValue.implementer?.kind || 'codex')
              : String(taskValue.reviewer?.kind || 'claude-code');
          const registrationPath = logicalParent ? logicalRepoPath : root;
          return `bash ${shellQuote(join(agmsgScriptsDir(), 'leave.sh'))} ${shellQuote(team)} ${shellQuote(duplicateAgent)} && bash ${shellQuote(join(agmsgScriptsDir(), 'join.sh'))} ${shellQuote(team)} ${shellQuote(duplicateAgent)} ${shellQuote(kind)} ${shellQuote(registrationPath)}`;
        });
        failures.push({
          message: `チーム${team}で同じ名前の登録が重複しています（${duplicated.join(', ')}）。依頼はまだ送っていません。`,
          fix: fixes.join(' && '),
        });
      }
    } catch (error) {
      failures.push({
        message: `チーム${team}の重複登録を確認できません: ${error.message}。依頼はまだ送っていません。`,
        fix: `bash ${shellQuote(join(agmsgScriptsDir(), 'team.sh'))} ${shellQuote(team)}`,
      });
    }
  }

  const requestProblem = reviewerRequestWritable();
  if (requestProblem) {
    failures.push({
      message: `レビュー依頼の控えを書き込めません（${requestProblem}）。依頼はまだ送っていません。`,
      fix: `chmod u+rwx ${shellQuote(contextDir)} && test ! -L ${shellQuote(join(contextDir, 'reviewer-current-request.json'))}`,
    });
  }
  return failures;
}

// --- 1. current-task.json ---
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
// --- 2. 現在の git repo / branch ---
// repo名はai-e2e-lib.mjsの共通解決を使う（worktreeでもフォルダ名でなく元repo名）。
let actualRepo = '';
let repoResolutionError = '';
try {
  actualRepo = actualRepoName(root);
} catch (error) {
  repoResolutionError = String(error?.message || error || '実git repo名を取得できません');
}
const actualBranch = (
  git(['symbolic-ref', '--short', 'HEAD']) ||
  git(['rev-parse', '--abbrev-ref', 'HEAD']) ||
  ''
).trim();

// --- 3-6. ガード判定 ---
const repoMatches = Boolean(task.repo) && repoKey(task.repo) === repoKey(actualRepo);
const branchMatches = Boolean(task.branch) && task.branch === actualBranch;
const hasTeam = Boolean(task.team && String(task.team).trim());
const hasImplementer = Boolean(agentId(task.implementer));
const hasReviewer = Boolean(agentId(task.reviewer));

const guardErrors = [];
if (repoResolutionError) guardErrors.push(repoResolutionError);
else if (!repoMatches) guardErrors.push(`repo 不一致（設定='${task.repo ?? ''}' / 実='${actualRepo}'）`);
if (!branchMatches) guardErrors.push(`branch 不一致（設定='${task.branch ?? ''}' / 実='${actualBranch}'）`);
if (!hasTeam) guardErrors.push('team が空（current-task.json の team を設定してください）');
if (reviewMode === 'queue' && !hasImplementer) guardErrors.push('implementer が空（current-task.json の implementer を設定してください）');
if (!hasReviewer) guardErrors.push('reviewer が空（current-task.json の reviewer を設定してください）');

const lane = reviewMode === 'queue'
  ? {
      profile: workflowProfile(task),
      team: String(task.team || '').trim(),
      from: agentId(task.implementer),
      to: agentId(task.reviewer),
      inbox: agentId(task.implementer),
      errors: [],
    }
  : hasTeam && hasReviewer
    ? resolveLane(task, root, 'implementer')
    : { profile: workflowProfile(task), team: String(task.team || '').trim(), from: '', to: '', errors: [] };
guardErrors.push(...lane.errors);

const headerValues = {
  Project: String(task.project ?? ''),
  Repo: String(task.repo ?? ''),
  Branch: String(task.branch ?? ''),
  Task: String(task.task ?? ''),
  Team: String(task.team ?? ''),
  'Task-ID': String(task.taskId ?? ''),
  'Task-Fingerprint': String(task.taskFingerprint ?? ''),
};
for (const [name, value] of Object.entries(headerValues)) {
  if (/[\r\n]|\\n/.test(value)) {
    guardErrors.push(`${name}ヘッダーにCR/LFまたはリテラル\\nは使用できません`);
  }
  if (value.includes('\t')) {
    guardErrors.push(`${name}ヘッダーにtabは使用できません`);
  }
  if (value !== value.trim()) {
    guardErrors.push(`${name}ヘッダーの先頭・末尾に空白は使用できません`);
  }
}

let normalizedTaskIdentity;
try {
  normalizedTaskIdentity = taskIdentity(task);
} catch (error) {
  guardErrors.push(error.message);
}

if (guardErrors.length > 0) {
  console.error('✗ review-sendのpreflightに失敗しました。request/stateは変更しません:');
  for (const error of guardErrors) console.error(`  - ${error}`);
  process.exit(1);
}
if (forceNew && !send) {
  console.error('✗ --force-new は実送信を伴うため --yes が必須です。');
  console.error(`  使用例: ${aiCmd('review-send', '--yes --force-new', { root })}`);
  process.exit(1);
}
if (primaryReviewed && !send) {
  exitWithError('✗ --primary-reviewed は実送信するDeepSeek実装者の記録なので --yes が必須です。');
}

let reviewLensHelper = null;
let reviewPlan = null;
let reviewSizeWarningShown = false;
function showReviewSizeWarning(plan) {
  if (reviewSizeWarningShown || !plan?.measurementWarning) return;
  reviewSizeWarningShown = true;
  console.error(`REVIEW_PROCESS_WARNING: ${plan.measurementWarning}`);
}
function reviewPlanFromRoundsState(roundsModule, state, measurementWarning = '') {
  const completedRounds = state?.codeReview?.rounds?.length || 0;
  const maxRounds = typeof roundsModule.codeReviewMaxRounds === 'function'
    ? roundsModule.codeReviewMaxRounds(state)
    : Number(state?.codeReview?.maxRounds) || 3;
  const closed = typeof roundsModule.codeReviewClosed === 'function'
    ? roundsModule.codeReviewClosed(state)
    : Number.isInteger(maxRounds) && completedRounds >= maxRounds;
  return {
    status: closed ? 'closed' : 'ready',
    lens: null,
    round: completedRounds + 1,
    maxRounds,
    measurementWarning: measurementWarning
      || String(state?.codeReview?.sizeEvidence?.measurementWarning || '').trim(),
    notificationStatus: state?.codeReview?.parentEscalation?.notification?.status || null,
  };
}
async function reviewPlanWithoutLensHelper() {
  let roundsModule;
  try {
    roundsModule = await import('./ai-review-rounds-lib.mjs');
  } catch (error) {
    return {
      status: 'ready',
      lens: null,
      round: null,
      maxRounds: 3,
      measurementWarning: `レビュー観点helperと変更サイズ固定処理を利用できないため、安全側のlargeとして送信を続けます: ${error.message}`,
    };
  }
  if (typeof roundsModule.freezeReviewSizeAtFirstSend === 'function') {
    const frozen = roundsModule.freezeReviewSizeAtFirstSend(root, task);
    return reviewPlanFromRoundsState(roundsModule, frozen.state);
  }

  const measurementWarning = 'レビュー観点helperと変更サイズ固定処理を利用できないため、安全側のlargeとして送信を続けます';
  if (
    typeof roundsModule.loadReviewRounds === 'function'
    && typeof roundsModule.saveReviewRounds === 'function'
  ) {
    const state = roundsModule.loadReviewRounds(root, task, { persist: false }).state;
    if (state?.codeReview?.rounds?.length === 0 && state.codeReview.sizingStatus !== 'frozen') {
      state.codeReview.sizeClass = 'large';
      state.codeReview.sizingStatus = 'frozen';
      state.codeReview.policy = String(
        roundsModule.FUNCTIONAL_DEFECT_REVIEW_POLICY || 'functional_defects_v1',
      );
      state.codeReview.maxRounds = Number(roundsModule.MAX_CODE_REVIEW_ROUNDS) || 3;
      state.codeReview.sizeEvidence = {
        measuredAt: new Date().toISOString(),
        measurementStatus: 'unavailable',
        measurementWarning,
        diffScope: 'measurement unavailable (conservative large)',
        unbornHead: null,
        lineCount: null,
        fileCount: null,
        changedFiles: [],
        sharedCanonicalFiles: [],
        sharedCanonicalPatterns: [],
        sharedCanonicalConfigSource: null,
        excludedSecretFileCount: 0,
        excludedToolStateFileCount: 0,
        hasUnmeasuredContent: true,
      };
      roundsModule.saveReviewRounds(root, state);
    }
    return reviewPlanFromRoundsState(roundsModule, state, measurementWarning);
  }
  return { status: 'ready', lens: null, round: null, maxRounds: 3, measurementWarning };
}
async function exitIfReviewPlanClosed(plan) {
  if (plan?.status !== 'closed') return;
  if (fixedPinPath) exitWithError('FIXED_PREPARED_REVIEW_CLOSED');
  if (send) {
    const roundsModule = await import('./ai-review-rounds-lib.mjs');
    const retried = roundsModule.retryReviewEscalationNotification(root, task);
    if (retried.attempted && !retried.sent) {
      console.error(`REVIEW_PROCESS_WARNING: 親へのレビュー指摘通知を送れませんでした: ${retried.error}`);
    }
  } else if (plan.notificationStatus && plan.notificationStatus !== 'sent') {
    console.log('REVIEW_PROCESS_WARNING: 親へのレビュー指摘通知が未送信です。--yesで再送します。');
  }
  console.log(`CODE_REVIEW_ALREADY_CLOSED: コードレビューは${plan.maxRounds}往復の範囲で終了済みです。追加依頼は送りません。`);
  process.exit(0);
}
try {
  reviewLensHelper = await import('./ai-review-lens-lib.mjs');
  reviewPlan = typeof reviewLensHelper.focusedReviewPlan === 'function'
    ? await reviewLensHelper.focusedReviewPlan(root, task)
    : null;
} catch {
  // 固定担当を選べない状態では、別担当の総合レビューへ黙って置き換えない。
}
showReviewSizeWarning(reviewPlan);
await exitIfReviewPlanClosed(reviewPlan);
if (reviewPlan?.status === 'error') {
  const planError = String(reviewPlan.error || '');
  // 変更量の測定失敗と、レビュー連鎖の前提(helper/起動基準)不成立は原因が違うため、
  // 断定文を出し分ける(M-3)。
  exitWithError(/REVIEW_CHAIN_/u.test(planError)
    ? '✗ レビュー連鎖の前提(配布helper/起動基準)が揃わないため、依頼を送りません'
      + `: ${planError}\n  旧担当方式へは自動で戻しません。配布物を更新してから再実行してください。`
    : `✗ レビュー開始時の変更量を確定できないため、依頼を送りません: ${planError}`);
}
if (!reviewPlan?.lens) {
  exitWithError(
    '✗ 固定されたレビュー担当と観点を確定できないため、依頼を送りません。配布物を更新してから再実行してください。\n'
    + `  直すコマンド: cd ${shellQuote(root)} && node ${shellQuote(join(homedir(), 'projects', 'ai-dev-tool', 'bin', 'install.mjs'))} --update`,
  );
}
if (reviewMode === 'pane' && reviewPlan.lens.reviewer === 'astra') {
  exitWithError(
    '✗ PANE_REVIEWER_RUNTIME_MISMATCH: R2はGPT-6 Astra固定ですが、pane方式はcurrent-task.jsonの固定reviewerへ送るため、別モデルの起動を保証できません。' +
    ` AI_REVIEW_MODE=queue ${aiCmd('review-send', send ? '--yes --force-new' : '', { root })} で` +
    ' --model gpt-6-astra --config model_reasoning_effort="high" --sandbox read-only を機械で固定してください。',
  );
}

if ((send || fixedPreflight) && reviewMode === 'pane') {
  const deliveryFailures = deliveryPreflight(task, lane);
  if (deliveryFailures.length > 0) {
    for (const failure of deliveryFailures) {
      console.error(`送出前点検: ${failure.message}`);
      console.error(`直すコマンド: ${failure.fix}`);
      if (failure.fallback) console.error(`直らない場合: ${failure.fallback}`);
    }
    console.error('V2_DELIVERY_PREFLIGHT_FAILED: 不足を直してから再実行してください（agmsgは未送信）');
    process.exit(2);
  }
  console.log('DELIVERY_PREFLIGHT_OK: 親レーン・受け取り先・重複・依頼控えの保存先を確認しました');
}

const approvalResult = loadApproval(root, task);
if (approvalResult.errors.length) {
  console.error('✗ 承認済み完成図の検証に失敗しました。レビュー依頼を作成・送信しません:');
  for (const error of approvalResult.errors) console.error(`  - ${error}`);
  process.exit(2);
}
if (fixedPinPath) {
  try { await sendFixedPrepared(); }
  catch (error) { exitWithError(`FIXED_PREPARED_REFUSED: ${error.message}`); }
  process.exit(0);
}

if (send) {
  try {
    reviewPlan = reviewLensHelper && typeof reviewLensHelper.focusedReviewPlan === 'function'
      ? await reviewLensHelper.focusedReviewPlan(root, task, { freezeSize: true })
      : await reviewPlanWithoutLensHelper();
  } catch (error) {
    reviewPlan = {
      status: 'error',
      error: String(error?.message || error || 'レビュー開始時の変更量を確認できません'),
      lens: null,
      round: null,
      maxRounds: null,
    };
  }
  showReviewSizeWarning(reviewPlan);
  await exitIfReviewPlanClosed(reviewPlan);
  if (reviewPlan?.status === 'error') {
    exitWithError(`✗ round 1送信時の変更量を確定できないため、依頼を送りません: ${reviewPlan.error}`);
  }
}

// 2026-09-29 (CMGB native focused CALLER): 限定再確認の対象一覧は公式CORE descriptorをそのまま固定し、
// request.md・review-request.json・queue request top-levelの3か所へ同じ値と正規hashを置く。対象0件でも
// [] とhashを明示し、判定プロトコルを整合させる。上限超過は依頼票・queue登録より前にここで拒否する。
let focusedTargets = null;
let focusedTargetsHash = '';
if (
  reviewPlan?.recheck === 1
  && reviewPlan?.reviewChainVersion === NATIVE_REVIEW_CHAIN_VERSION
  && cmgbNativeFocusedIdentity(task)
) {
  let focusedState;
  try {
    focusedState = loadReviewRounds(root, task, { persist: false }).state;
  } catch (error) {
    exitWithError(`✗ 限定再確認の対象一覧を確定できないため、依頼を送りません: ${error.message}`);
  }
  const targets = cmgbFocusedTargets(focusedState, reviewPlan.lens.key);
  if (!Array.isArray(targets)) {
    exitWithError('✗ NATIVE_FOCUSED_TARGETS_UNAVAILABLE: 限定再確認の対象一覧を取得できません。');
  }
  if (targets.length > MAX_FOCUSED_TARGETS) {
    exitWithError(`✗ NATIVE_FOCUSED_TARGETS_TOO_LARGE: 限定再確認の対象が上限${MAX_FOCUSED_TARGETS}件を超えています（${targets.length}件）。指摘への対応を分割してから再実行してください。`);
  }
  const targetsHash = cmgbFocusedTargetsHash(targets);
  if (!/^[a-f0-9]{64}$/.test(targetsHash)) {
    exitWithError('✗ NATIVE_FOCUSED_TARGETS_HASH: 限定再確認の対象一覧hashを確定できません。');
  }
  focusedTargets = targets;
  focusedTargetsHash = targetsHash;
}
const primaryReviewRequired = reviewPlan?.lens?.primaryReviewer === 'deepseek';
// 明示宣言されたnative連鎖だけがrequest-owned scopeを持ち、direct-APIの--primary-evidenceを使わない。
// 未宣言の旧chain(旧direct-API・旧Opus/Astra/Opus)は今まで通りに動く。
const nativeChain = reviewPlan?.reviewChainVersion === NATIVE_REVIEW_CHAIN_VERSION;
if (primaryReviewed && !primaryReviewRequired) {
  exitWithError('✗ DEEPSEEK_PRIMARY_REVIEW_NOT_APPLICABLE: このレーンは既存のレビュー経路を継続します。--primary-reviewed を外してください。');
}
if (send && primaryReviewRequired && !primaryEvidencePath && !nativeChain) {
  exitWithError(
    '✗ DEEPSEEK_PRIMARY_REVIEW_REQUIRED: DeepSeek実装者による同じ対象版の一次確認記録がありません。' +
    ` node scripts/deepseek-primary-review.mjs ${reviewPlan.round} で確認後、承認済み予算を --execute --budget .ai/context/deepseek-review-authorization.json で指定してください。生成receiptを ${aiCmd('review-send', '--yes --primary-evidence <receipt.json>', { root })} へ渡してください。`,
  );
}
let primaryReview = primaryReviewRequired
  ? {
      status: nativeChain ? 'native-pending' : primaryReviewed ? 'completed' : 'not-recorded',
      reviewerId: String(task.implementer?.id || '').trim(),
      model: String(task.implementer?.model || '').trim(),
      effort: String(task.implementer?.effort || '').trim(),
      round: Number.isInteger(reviewPlan?.round) ? reviewPlan.round : null,
      lens: reviewPlan?.lens?.key || null,
      reviewChainVersion: reviewPlan?.reviewChainVersion || null,
      ...(primaryReviewed ? { recordedAt: new Date().toISOString() } : {}),
    }
  : { status: 'not-applicable' };
if (primaryEvidencePath && !nativeChain) {
  if (!primaryReviewRequired) exitWithError('このレーンは新しいレビュー方式ではありません。旧方式の記録は置換しません。');
  try {
    const {primaryEvidence} = await import('./review-evidence.mjs');
    primaryReview = primaryEvidence(root, primaryEvidencePath, {task,round:reviewPlan.round,lens:reviewPlan.lens.key});
  } catch (error) { exitWithError(`DEEPSEEK_PRIMARY_EVIDENCE_REJECTED: ${error.message}`); }
}
const approvalBody = readFileSync(approvalResult.path, 'utf8').trim();

// --- 7-9. git 情報（秘密除外・切詰） ---
let reviewDiffScope;
try {
  reviewDiffScope = resolveReviewDiffScope(root, { task });
  if (primaryReviewRequired && !nativeChain && send && (primaryReview.reviewBaseCommit !== reviewDiffScope.baseCommit || primaryReview.reviewHeadCommit !== reviewDiffScope.headCommit)) throw new Error('DeepSeek証跡のレビュー基点/HEADが依頼と一致しません');
} catch (error) {
  exitWithError(`✗ レビュー対象の基点を判別できないため、依頼を作成・送信しません: ${error.message}`);
}
// deepseek-native-cli-v1 は、公式send requestがレビュー範囲そのものを固定する経路。scopeは受領receipt
// からではなく、信頼済みの送信者が --native-scope/--native-scope-hash で宣言し、ここで実worktreeに対して
// 再検証してからpinへ固定する。pinは合成せず、検証済みscopeの分類とhashだけを写す。
let nativeReview = null;
let nativeManifestPaths = null;
let nativeInlinePaths = null;
let nativeScopeFile = null;
if (nativeChain) {
  if (reviewMode !== 'queue') {
    exitWithError('✗ NATIVE_QUEUE_MODE_REQUIRED: deepseek-native-cli-v1 は公式queue経路でのみ送信できます。AI_REVIEW_MODE=queue を指定してください。');
  }
  if (!nativeScopePath) {
    exitWithError('✗ NATIVE_SCOPE_REQUIRED: 公式scopeファイルが必要です（--native-scope <scope.json> --native-scope-hash <scopeHash>）。');
  }
  if (!/^[a-f0-9]{64}$/.test(nativeScopeHash)) {
    exitWithError('✗ NATIVE_SCOPE_HASH_REQUIRED: --native-scope-hash に64桁のscopeHashが必要です。');
  }
  const scopeRel = nativeScopePath.replaceAll('\\', '/');
  if (scopeRel.startsWith('/') || /^[A-Za-z]:/.test(scopeRel) || scopeRel.split('/').includes('..')) {
    exitWithError('✗ NATIVE_SCOPE_PATH: --native-scope はリポジトリ内の相対pathで指定してください。');
  }
  const implementerSessionsHash = String(task?.implementerSessions?.hash || '');
  if (!/^[a-f0-9]{64}$/.test(implementerSessionsHash)) {
    exitWithError('✗ NATIVE_IMPLEMENTER_SESSIONS_REQUIRED: task.implementerSessions.hash（検証済み実装セッション束のhash）が必要です。');
  }
  const verifierPath = join(root, 'scripts', 'review-scope.mjs');
  if (!existsSync(verifierPath)) {
    exitWithError('✗ NATIVE_SCOPE_VERIFIER_UNAVAILABLE: scripts/review-scope.mjs が無いためnative依頼を作れません。配布物を更新してください。');
  }
  let nativeScopeManifest;
  try {
    const { verifyReviewScopeAtRoot } = await import(pathToFileURL(verifierPath).href);
    nativeScopeManifest = verifyReviewScopeAtRoot(root, join(root, scopeRel), {
      ignoredPathspecs: nativeIgnoredPathspecs,
      expectedScopeHash: nativeScopeHash,
      reviewedManifestPaths: nativeDeclaredReviewedPaths,
      current: true,
    });
  } catch (error) {
    exitWithError(`✗ NATIVE_SCOPE_REJECTED: ${String(error?.message || error)}`);
  }
  try {
    nativeReview = buildNativeReviewPin({
      scope: nativeScopeManifest,
      declaredReviewedPaths: nativeDeclaredReviewedPaths,
      ignoredPathspecs: nativeIgnoredPathspecs,
      implementerSessionsHash,
      round: reviewPlan.round,
      lens: reviewPlan.lens.key,
      taskId: normalizedTaskIdentity.taskId,
      taskFingerprint: normalizedTaskIdentity.taskFingerprint,
      reviewBaseCommit: reviewDiffScope.baseCommit,
      reviewHeadCommit: reviewDiffScope.headCommit,
    });
  } catch (error) {
    exitWithError(`✗ NATIVE_PIN_INVALID: ${String(error?.message || error)}`);
  }
  nativeManifestPaths = nativePinClassifiedPaths(nativeReview);
  nativeInlinePaths = nativeReview.reviewedPaths.slice();
  nativeScopeFile = scopeRel;
  // 上限は実際にprompt/diffへinlineするreview対象(kind=reviewed)だけに掛ける。protected/forward_frozenは
  // 件数が多くてもpin・scope・queue manifestでhash検証されたままinlineしないので、ここでは数えない。
  if (nativeInlinePaths.length > MAX_CHANGED_FILES) {
    exitWithError(`✗ NATIVE_SCOPE_TOO_LARGE: review対象(kind=reviewed)が上限${MAX_CHANGED_FILES}件を超えています。変更を分割してください。`);
  }
}
const secretExcludes = [
  ':(exclude).env',
  ':(exclude).env.*',
  ':(exclude)**/.env',
  ':(exclude)**/.env.*',
  ':(exclude)*.env',
  ':(exclude).app-access-password.tmp',
  ':(exclude)*.pem',
  ':(exclude)*.key',
  ':(exclude)*.p12',
  ':(exclude)*.pfx',
  ':(exclude)*.token',
  ':(exclude)credentials.json',
  ':(exclude)**/credentials.json',
  ':(exclude).npmrc',
  ':(exclude)**/.npmrc',
  ':(exclude).git-credentials',
  ':(exclude)**/.git-credentials',
  ':(exclude)id_rsa',
  ':(exclude)**/id_rsa',
  ':(exclude)id_ed25519*',
  ':(exclude)**/id_ed25519*',
  ':(exclude).netrc',
  ':(exclude)**/.netrc',
];
let queuePreviewPaths = null;
let queuePreviewSnapshot = null;
const queueCapturePaths = nativeManifestPaths;
if (reviewMode === 'queue') {
  try {
      queuePreviewPaths = queueCapturePaths || safeChangedPaths();
    queuePreviewSnapshot = captureQueueManifest(queuePreviewPaths);
  } catch (error) {
    console.error(`✗ queue登録に失敗しました: ${error.message}`);
    process.exit(2);
  }
}
const literalPathspec = (path) => `:(literal)${path}`;
// native連鎖では、review対象(kind=reviewed)だけをpromptへ載せ、protected/forward_frozenは
// pinで検証済みのままinlineしない。旧chainは従来どおり全pathを載せる。
const promptScopePaths = nativeInlinePaths || queuePreviewPaths;
const previewPathArgs = reviewMode === 'queue'
  ? ['--', ...promptScopePaths.map(literalPathspec)]
  : ['--', '.', ...secretExcludes];
const queueHasSafePaths = reviewMode === 'queue' && queuePreviewPaths.length > 0;
const diffBaseArgs = reviewDiffScope.baseCommit ? [reviewDiffScope.baseCommit] : [];
const scopedStatus = reviewDiffScope.baseCommit
  ? [
      reviewMode === 'queue'
        ? (queueHasSafePaths
            ? queueGitOrExit(
                ['diff', '--name-status', '--no-renames', ...diffBaseArgs, ...previewPathArgs],
                'レビュー対象の変更ファイル一覧',
              )
            : '')
        : git(['diff', '--name-status', '--no-renames', ...diffBaseArgs, ...previewPathArgs]) || '',
      reviewMode === 'queue'
        ? (queueHasSafePaths
            ? queueGitOrExit(
                ['ls-files', '--others', '--exclude-standard', ...previewPathArgs],
                'レビュー対象の未追跡ファイル一覧',
              ).split('\n').filter(Boolean).map((path) => `??\t${path}`).join('\n')
            : '')
        : (git(['ls-files', '--others', '--exclude-standard', ...previewPathArgs]) || '')
            .split('\n').filter(Boolean).map((path) => `??\t${path}`).join('\n'),
    ].filter(Boolean).join('\n')
  : reviewMode === 'queue'
    ? (queueHasSafePaths ? queueGitOrExit(['status', '--short', '--untracked-files=all', ...previewPathArgs], 'git status') : '')
    : git(['status', '--short', '--untracked-files=all', ...previewPathArgs]) || '';
const statusShort = scopedStatus.trim();
const diffStat = (reviewMode === 'queue'
  ? (queueHasSafePaths ? queueGitOrExit(['diff', '--stat', ...diffBaseArgs, ...previewPathArgs], 'git diff --stat') : '')
  : git(['diff', '--stat', ...diffBaseArgs, ...previewPathArgs]) || '').trim();
let diff = reviewMode === 'queue'
  ? (queueHasSafePaths ? queueGitOrExit(['diff', '--no-color', ...diffBaseArgs, ...previewPathArgs], 'git diff') : '')
  : git(['diff', '--no-color', ...diffBaseArgs, ...previewPathArgs]) || '';
const headAfterDiff = (git(['rev-parse', '--verify', '--quiet', 'HEAD']) || '').trim() || null;
if (headAfterDiff !== reviewDiffScope.headCommit) {
  console.error('✗ レビュー差分の取得中にHEADが変わったため、依頼を作成・送信しません。もう一度実行してください。');
  process.exit(2);
}
diff = redactReviewText(diff);
let diffTruncated = false;
if (diff.length > MAX_DIFF_CHARS) {
  diff = diff.slice(0, MAX_DIFF_CHARS);
  // サロゲートペアの中間で切らない
  if (/[\uD800-\uDBFF]$/.test(diff)) diff = diff.slice(0, -1);
  diffTruncated = true;
}

const statusLines = statusShort ? statusShort.split('\n') : [];
const shownChangedFiles = [];
let shownChangedFilesChars = 0;
for (const line of statusLines) {
  if (shownChangedFiles.length >= MAX_CHANGED_FILES) break;
  const rendered = `- ${line.trim()}`;
  const addedChars = rendered.length + (shownChangedFiles.length > 0 ? 1 : 0);
  if (shownChangedFilesChars + addedChars > MAX_CHANGED_FILES_CHARS) break;
  shownChangedFiles.push(rendered);
  shownChangedFilesChars += addedChars;
}
const changedFilesTruncated = shownChangedFiles.length < statusLines.length;
const changedFiles = statusLines.length > 0
  ? [
      ...shownChangedFiles,
      ...(changedFilesTruncated
        ? [`- … 変更ファイル一覧を切り詰めました（表示 ${shownChangedFiles.length} / 総件数 ${statusLines.length}）`]
        : []),
    ].join('\n')
  : '- （レビュー対象の変更なし）';

const reviewScopeSection = reviewDiffScope.unbornHead
  ? '- 基点: 空のリポジトリ（まだHEADはありません）\n- 対象: 現在のindex・作業ツリー・未追跡ファイル'
  : [
      `- 基準枝: ${reviewDiffScope.baseRef}`,
      `- 基点: ${reviewDiffScope.baseCommit}`,
      `- HEAD: ${reviewDiffScope.headCommit}`,
      `- 保存済み範囲: ${reviewDiffScope.baseCommit}..${reviewDiffScope.headCommit}`,
      '- 未保存の変更: 上記の保存済み範囲と同じ差分へ合成',
      ...(reviewDiffScope.committedRangeEmpty
        ? ['- 警告: 基点とHEADが同じため保存済み範囲は空です。未保存の変更が無ければレビュー対象も空です。']
        : []),
    ].join('\n');

// --- 10. レビュー依頼文を生成 ---
const approvedChecklist = approvalResult.approval.source.type === 'spec-leader'
  ? approvalResult.approval.source.files.find((file) => basename(file.path) === 'acceptance_checklist.md')
  : null;
const checklistPath = approvedChecklist ? join(root, approvedChecklist.path) : null;
let checklistBody = '';
if (checklistPath) {
  try {
    // 同梱判定は trim 後の内容基準（空ファイルは同梱しない）
    checklistBody = readFileSync(checklistPath, 'utf8').trim();
  } catch {
    checklistBody = '';
  }
}
let checklistTruncated = false;
if (checklistBody.length > MAX_CHECKLIST_CHARS) {
  checklistBody = checklistBody.slice(0, MAX_CHECKLIST_CHARS);
  // サロゲートペアの中間で切らない
  if (/[\uD800-\uDBFF]$/.test(checklistBody)) checklistBody = checklistBody.slice(0, -1);
  checklistTruncated = true;
}

const reviewPoints = [
  ...(checklistBody
    ? ['受け入れチェックリスト（上記セクション）の項目が実際に満たされているか（最優先）']
    : []),
  'バグや仕様漏れ',
  '既存機能への影響',
  '型',
  'import / export',
  'ファイルパス',
  'エッジケース',
  '不要変更',
  '過剰実装',
  '追加で必要なテスト観点',
  'テストの削除・skip・弱体化がないか',
  '期待値ハードコード、`|| true`、握りつぶし例外がないか',
  '動作を隠すモック、依頼範囲外の変更がないか',
  'テストが通ることではなく、正しい理由で通るか',
  '6時間タスクとして広がりすぎていないか',
];
let renderedReviewPoints = reviewPoints.map((point) => `- ${point}`).join('\n');
const reviewLens = reviewPlan?.lens || null;
if (reviewLensHelper) renderedReviewPoints = reviewLensHelper.reviewPointsBody(reviewPoints, reviewLens);
const laneReviewRuntime = reviewLens?.runtime || (
  reviewLens?.reviewer === 'astra'
    ? { model: 'gpt-6-astra', effort: 'high', sandbox: 'read-only' }
    : { model: reviewLens?.reviewer || String(task.reviewer?.model || task.reviewer || '').trim(), effort: 'high', sandbox: 'read-only' }
);
// native連鎖のqueue reviewerは、旧連鎖の 'opus' aliasを絶対に漏らさず実モデルIDを要求する。
// requestMarkdown・queue request・state・表示プロンプトが同じ値を見るよう、ここで一度だけ確定する。
// laneが別の実モデルを明示している場合(例: Astra)は、支払い前にfail closedで止める。
if (nativeChain && !['', 'opus', NATIVE_QUEUE_REVIEWER_MODEL].includes(String(laneReviewRuntime.model || '').trim())) {
  exitWithError(`✗ NATIVE_REVIEWER_RUNTIME_UNAVAILABLE: 公式laneのreviewer modelがnative連鎖の ${NATIVE_QUEUE_REVIEWER_MODEL} と両立しません（lane=${String(laneReviewRuntime.model || '(未設定)')}）。旧方式へは自動で戻しません。`);
}
const reviewRuntime = nativeChain
  ? { ...laneReviewRuntime, model: NATIVE_QUEUE_REVIEWER_MODEL, effort: NATIVE_QUEUE_REVIEWER_EFFORT }
  : { ...laneReviewRuntime, model: laneReviewRuntime.model === 'opus' ? NATIVE_QUEUE_REVIEWER_MODEL : laneReviewRuntime.model };
const reviewCommonRules = Array.isArray(reviewPlan?.commonRules) && reviewPlan.commonRules.length > 0
  ? reviewPlan.commonRules.map((rule) => `- ${rule}`).join('\n')
  : [
      '指摘対象は不具合のみ。好み、命名、整形、任意のリファクタ、仕様外の改善は指摘しない。',
      '指摘には「発生条件」「期待と実際の違い」「該当箇所」「根拠」を付ける。',
      '推測だけで不具合と断定しない。疑いは可能な範囲で自分で検証し、確認できなければ未確認事項として区別する。',
      '過去に確認済みの内容は、変更や新しい根拠がなければ繰り返さない。ただし担当観点以外でも、実際に見つけた不具合は報告する。',
      'レビューは対象の変更と、影響が及ぶ関連処理に絞る。',
    ].map((rule) => `- ${rule}`).join('\n');
const reviewHandoff = String(reviewPlan?.handoff || '').trim() || [
  '- 前回の指摘: なし（1往復目）',
  '- 対応状況: 新規確認',
  '- 検証結果: まだありません',
  '- 未確認事項: なし',
].join('\n');
const recipientRole = reviewLens?.reviewer === 'astra'
  ? 'Codex / GPT-6 Astra independent read-only reviewer'
  : lane.profile === 'gpt56-claude-v1'
    ? 'Claude Code / Opus independent reviewer'
    : 'Codex reviewer (legacy)';

const checklistSection = checklistBody
  ? `
## 受け入れチェックリスト（spec-leader handoff / レビュー基準）
${reviewMode === 'queue' ? 'request.mdへ固定した内容を正本とします。' : `出典: ${checklistPath}`}

${checklistBody}
${checklistTruncated ? `\n※ 長いため先頭 ${MAX_CHECKLIST_CHARS} 文字で切り詰めています。${reviewMode === 'queue' ? 'この固定範囲だけを確認してください。' : `全体は ${checklistPath} を確認してください。`}` : ''}
`
  : '';

// 「実行した検証」欄は機械が集めた実測結果で埋める（雛形文のまま送らせない）。
const fullVerificationSection = buildVerificationSection(root, task, {
  currentHead: (git(['rev-parse', '--verify', '--quiet', 'HEAD']) || '').trim(),
  testCommandHint: aiCmd('test', '', { root }),
});
const verificationSection = reviewMode === 'queue'
  ? (fullVerificationSection.includes('実測結果がまだありません')
      ? '- ⚠ request.md作成時点で固定できる実測結果はありません。'
      : fullVerificationSection
        .split('\n- 実装者による追記')[0]
        .split('\n')
        .filter((line) => !/^- テスト:|^  - 証跡:/u.test(line))
        .join('\n'))
  : fullVerificationSection;

// 取得経路そのものが壊れたときの検索記録。knowledge側 scripts/kb-retrieval-log-lib.mjs と同じ項目名・
// 同じ既定パス・同じ上書き変数(KB_RETRIEVAL_LOG)で1行だけ追記する。
// ライブラリをimportしないのは、そのライブラリごと読めない環境こそ記録が必要だからである
// (読めない場所へのimportを記録処理の前提にすると、失敗時に記録も消える)。
// 既定の保存先は knowledge 側 DEFAULT_RETRIEVAL_LOG と同じ値を書き写す。ホーム位置から組み立てると、
// HOME が異なる環境で書き込み先が割れ、1つの台帳として数えられなくなる。
const KB_RETRIEVAL_DEFAULT_LOG = '/home/dev/projects/.agent-work/.kb-retrieval.jsonl';
const KB_RETRIEVAL_STAGE_PATTERN = /^[a-z][a-z0-9_:-]{0,63}$/u;

function kbLogOneLine(value, limit) {
  return String(value ?? '').replace(/[\r\n\t]+/gu, ' ').trim().slice(0, limit);
}

function kbLogScrubSecrets(text) {
  return String(text ?? '')
    .replace(/(sk-[A-Za-z0-9_-]{8,})/gu, '[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+/giu, '$1[redacted]');
}

function appendKnowledgeRetrievalError({ stage, repo, taskId, project, query, error, durationMs, model, effort, round }) {
  const file = process.env.KB_RETRIEVAL_LOG || KB_RETRIEVAL_DEFAULT_LOG;
  const safeStage = KB_RETRIEVAL_STAGE_PATTERN.test(stage) ? stage : 'review:unknown';
  const record = {
    ts: new Date().toISOString(),
    stage: safeStage,
    repo: kbLogOneLine(repo, 128),
    task_id: kbLogOneLine(taskId, 256),
    query: kbLogScrubSecrets(kbLogOneLine(query, 1000)),
    status: 'error',
    candidates: [],
    delivered: [],
    excluded: [],
    error: kbLogScrubSecrets(kbLogOneLine(error, 500)) || '不明なエラー',
  };
  if (Number.isFinite(durationMs)) record.duration_ms = Math.round(durationMs);
  if (project) record.project = kbLogOneLine(project, 128);
  if (model) record.model = kbLogOneLine(model, 80);
  if (effort) record.effort = kbLogOneLine(effort, 20);
  if (round !== undefined && round !== null) record.round = Number(round);
  mkdirSync(dirname(file), { recursive: true });
  // 強制終了で末尾に改行の無い不完全な行が残っていても、次の記録を同じ行へ連結しない。
  let prefix = '';
  try {
    const stat = statSync(file);
    if (stat.size > 0) {
      const tailFd = openSync(file, 'r');
      try {
        const tail = Buffer.alloc(1);
        readSync(tailFd, tail, 0, 1, stat.size - 1);
        if (tail[0] !== 0x0a) prefix = '\n';
      } finally {
        closeSync(tailFd);
      }
    }
  } catch { /* 未作成なら何もしない */ }
  const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT, 0o600);
  try {
    writeSync(fd, `${prefix}${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
  return file;
}

// --- 関連ナレッジ(MMM)の機械付与 ---
// 往復の観点(spec / user_path / edge)に合う事例を、実際にレビュー担当が読む依頼文へ入れる。
// 既定は無効(config/kb-review-context.json enabled=false)。無効時は依頼文を1文字も変えない。
// 有効時に取得へ失敗した場合は、その旨を節に残す(黙って空にしない)。
let reviewKnowledgeSection = '';
{
  const knowledgeStartedAt = Date.now();
  const knowledgeRoot = process.env.KB_ROOT || join(homedir(), 'projects', 'knowledge');
  const helperPath = join(knowledgeRoot, 'scripts', 'kb-review-context.mjs');
  const wantsReviewKnowledge = process.env.KB_REVIEW_CONTEXT === '1'
    || (process.env.KB_REVIEW_CONTEXT !== '0' && (() => {
      try { return JSON.parse(readFileSync(join(knowledgeRoot, 'config', 'kb-review-context.json'), 'utf8')).enabled === true; } catch { return false; }
    })());
  if (wantsReviewKnowledge && reviewLens?.key) {
    try {
      const stat = lstatSync(helperPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`symlinkではないregular fileが必要です: ${helperPath}`);
      const helper = await import(pathToFileURL(helperPath).href);
      const result = await helper.reviewKnowledgeSectionFor({
        lensKey: reviewLens.key,
        project: String(task.repo || task.project || ''),
        taskId: String(task.taskId || ''),
        repo: String(task.repo || ''),
        round: reviewPlan?.round ?? null,
        model: reviewRuntime.model || '',
        effort: reviewRuntime.effort || '',
        root: knowledgeRoot,
      });
      if (result.enabled) reviewKnowledgeSection = `${result.section}\n\n`;
    } catch (error) {
      // 本文は固定文だけにする。取得経路のパス・エラー本文・ホスト名を入れると、同じ変更でも
      // 環境によって Content-Hash が変わり、再送判定と受入照合が壊れる。詳細は stderr へ出す。
      reviewKnowledgeSection = '## 関連ナレッジ（機械付与・MMM）\n- 取得できませんでした（該当なしではありません。取得経路の問題です。詳細は送信側の stderr REVIEW_KNOWLEDGE_WARNING を確認してください）\n\n';
      // 種別(code)が本文の先頭に既に入っている実装もあるため、重ねて前置しない。
      const rawDetail = String(error?.message || error);
      const detail = error?.code && !rawDetail.startsWith(`${error.code}:`) ? `${error.code}: ${rawDetail}` : rawDetail;
      console.error(`REVIEW_KNOWLEDGE_WARNING: 関連ナレッジを付与できませんでした: ${detail}`);
      // 「検索したが該当なし」と「そもそも取得できなかった」を後から区別できるよう、失敗も記録へ残す。
      // 記録は knowledge 側 helper が書く構造なので、その helper を読めない失敗では誰も書かない。
      try {
        appendKnowledgeRetrievalError({
          stage: `review:${reviewLens.key}`,
          repo: String(task.repo || ''),
          taskId: String(task.taskId || ''),
          project: String(task.repo || task.project || ''),
          query: `lens=${reviewLens.key} tags=(未取得: 取得経路の失敗)`,
          error: detail,
          durationMs: Date.now() - knowledgeStartedAt,
          model: reviewRuntime.model || '',
          effort: reviewRuntime.effort || '',
          round: reviewPlan?.round ?? null,
        });
      } catch (logError) {
        // 記録先の権限・容量は選別結果そのものではない。本文や終了コードへ出さず stderr だけで通知する。
        console.error(`KB_RETRIEVAL_LOG_WARNING: 検索記録を残せませんでした: ${String(logError?.message || logError)}`);
      }
    }
  }
}

const queueBundleGuidance = reviewMode === 'queue'
  ? '作業役は同じqueue entry内の request.md / diff.patch / manifest.json だけを確認し、元のリポジトリや記載された外部pathを参照しないでください。'
  : '';

const nativeFocusedHeaderLine = Array.isArray(focusedTargets)
  ? `\nNative-Focused-Targets-SHA256: ${focusedTargetsHash}`
  : '';
const nativeFocusedSection = Array.isArray(focusedTargets)
  ? `## 限定再確認の対象（CMGB native focused / 依頼時に機械固定）
Native-Focused-Targets-SHA256: ${focusedTargetsHash}
対象key数: ${focusedTargets.length}

下記の対象keyと原文全文は依頼時に固定したものです。keyを省略・追加・言い換えず、各keyへ1行ずつ
\`Recheck-Decision: <64桁のkey> | <resolved|nonblocking|open> | <具体的な根拠>\` を返してください。
- resolved: 同一scope/HEAD/approvalの現版で実際に確認した証拠を根拠に書いてください。
- nonblocking: 残る事実ではあるが、合格条件（承認済み完成図のcompletionCriteria）と対象成果物に対して阻害しないと両者が独立に判断した場合だけ選び、根拠へ \`criterion=<completionCriteria の index 又は none>; reach=<成果物への到達/非到達>; evidence=<現版の具体的証拠>\` を必ず含めてください。
- 今回新たに生じた重要unknown、固定一覧に無い新しい未確認事項、原文が変わった項目は open として扱い、その原文（新しい未確認事項）をそのまま残してください。合格扱いにしないでください。

${cmgbFocusedProofSourceGuidance()}

DeepSeek側の判定と一致しないkey、重要unknownが残るkey、criterion/reach/evidence を欠くnonblockingは open として扱われ、この往復は閉じません。

${focusedTargets.map((target, index) => `### 対象 ${index + 1}/${focusedTargets.length} key=${target.key}（round=${target.round ?? ''} lens=${target.lens ?? ''} source=${target.source ?? ''} kind=${target.kind ?? ''}）
${String(target.originalText ?? '')}`).join('\n\n')}
`
  : '';
const nativeFocusedReplyFormat = Array.isArray(focusedTargets)
  ? `\n各対象keyへ1行ずつ、次の形式で判定と根拠を返してください（全${focusedTargets.length} key。keyの過不足・重複・空の根拠は拒否されます。nonblocking は criterion=<index又はnone>; reach=<到達/非到達>; evidence=<現版証拠> を含めてください）:\nRecheck-Decision: <64桁のkey> | <resolved|nonblocking|open> | <具体的な根拠>\nkeyは上の一覧から文字単位でコピーした64桁の英数字16進のみとし、回答前に全${focusedTargets.length}件・64桁・重複無しを自己点検してください。新keyの生成・末尾への追加・省略は拒否されます。証拠が足りない場合は正しいkeyでopenとしてください。\n「自分はテストを再実行していない」「実作品の品質は今回の合格条件外」「このreview自身のreceiptは後工程」等の方法説明や非阻害の限界は、該当keyの Recheck-Decision evidence と ## 検証結果 に記録し、同義の新規未確認として ## 未確認事項 へ重複記載しないでください。既定原文を未確認欄へ再掲する場合も source と原文を文字単位で保持し、要約・言い換えた新項目にしないでください。\n一方、本当に新しく見つかった必須条件へ届く不具合・重要unknown・証拠不足は隠さず ## 未確認事項 へ具体的に書き、関連keyをopenにし、新規なら新規として報告してください。末尾を見かけ上「なし」にするための省略はできません。P2/P3・範囲外は根拠と到達性を記して非阻害として残してください（品質条件は弱めません）。この出力契約はCMGB native focused限定です。`
  : '';

const bodyWithoutRequestId = `Project: ${task.project ?? ''}
Repo: ${task.repo ?? ''}
Branch: ${task.branch ?? ''}
Task: ${task.task ?? ''}
Team: ${lane.team}
Request-ID: __REQUEST_ID__
Content-Hash: __CONTENT_HASH__
Workflow-Profile: ${lane.profile}
From: ${lane.from}
To: ${lane.to}
Recipient role: ${recipientRole}
Review-Model: ${reviewRuntime.model || '(未設定)'}
Review-Effort: ${reviewRuntime.effort || '(未設定)'}
Review-Sandbox: ${reviewRuntime.sandbox || '(未設定)'}
Review-Recheck: ${reviewPlan?.recheck === 1 ? 'focused-1' : 'none'}
Review-Chain: ${reviewPlan?.reviewChainVersion || '(未設定)'}${nativeFocusedHeaderLine}
Primary-Review-Status: ${primaryReview.status}
Primary-Review-Model: ${primaryReview.model || '(対象外)'}
Primary-Review-Effort: ${primaryReview.effort || '(対象外)'}

## 承認済み完成図（実装者とレビュアーの共通正本）
${reviewMode === 'queue' ? 'request.mdへ埋め込んだ下記内容を正本とします。' : `出典: ${approvalResult.path}`}
contentHash: ${approvalResult.contentHash}

\`\`\`json
${approvalBody}
\`\`\`

# レビュー依頼: ${task.task ?? '(タスク未設定)'}

${queueBundleGuidance}

## 今日のゴール
${task.task ? `「${task.task}」を完了する。` : '（current-task.json の task が未設定です。ゴールを記入してください）'}

## 対象範囲
${reviewScopeSection}

## 変更内容
${statusShort
  ? `レビュー対象に ${statusShort.split('\n').length} 件の変更があります。下記の diff を参照してください。`
  : '（基点から現在までにレビュー対象の変更はありません）'}

## 変更ファイル
${changedFiles}

${reviewMode === 'queue'
  ? '未追跡内容も秘密を除いて diff.patch と manifest.json に固定済みです。元の作業場所は確認しないでください。'
  : '未追跡ファイルは `git diff` に含まれません。reviewerは上記一覧に列挙された各pathをReadし、\ndiffに現れない新規内容も確認してください（秘密pathは一覧から除外済みです）。'}

## git diff --stat
\`\`\`
${diffStat || '(変更なし)'}
\`\`\`

## git diff要約
\`\`\`diff
${diff.trim() || '(変更なし)'}
\`\`\`
${diffTruncated ? `\n※ diff が長いため先頭 ${MAX_DIFF_CHARS} 文字で切り詰めています。${reviewMode === 'queue' ? '全体は同じqueue entryの diff.patch を確認してください。' : '全体はローカルで確認してください。'}` : ''}

## 実行した検証
${verificationSection}
## 一次確認の記録
${primaryReview.status === 'completed'
  ? `DeepSeek実API証跡を検査し、この依頼と同じ対象版について R${primaryReview.round} ${primaryReview.lens} の一次確認が完了した状態で送信しました。`
  : primaryReview.status === 'not-recorded'
    ? '一次確認はまだ記録されていません。この下書きを送信済みの証拠として扱わないでください。'
    : 'このレーンは段階導入の対象外で、既存の独立レビュー経路を継続します。'}
${checklistSection}
## レビュー共通ルール（機械付与）
${reviewCommonRules}

## 前回からの引き継ぎ（機械生成）
${reviewHandoff}
${nativeFocusedSection}
${reviewKnowledgeSection}## レビュー観点
${renderedReviewPoints}

## 返信フォーマット（必須）
返信メッセージの先頭に、必ず次の6行をこのまま含めてください（ai:review-check が送信元を含め厳密照合します）:

Project: ${task.project ?? ''}
Repo: ${task.repo ?? ''}
Branch: ${task.branch ?? ''}
Task: ${task.task ?? ''}
Team: ${lane.team}
Request-ID: __REQUEST_ID__

6行の直後に、指摘が無ければ「Verdict: ok」、機能の不具合があれば「Verdict: findings」を1行で記載してください。${nativeFocusedReplyFormat}
各指摘には Finding-Kind: spec|user_path|data_loss|regression|irreversible|other のいずれかを1行で付けてください。
other はテスト追加・書き方・整理・命名・将来への備えだけの指摘に使います。
問題は、仕様不一致→利用者経路→データ破損→既存機能の退行→不可逆操作→その他、の順に記載してください。問題がなければ「レビューOK」と明記してください。
末尾に次の3見出しを必ずこの順で付け、各欄に「なし」または実測内容を書いてください。未確認事項が1つでも残る場合は「なし」と書かないでください。

## 残存不具合
## 未確認事項
## 検証結果
`;

// --- 11. Request-ID生成・保存 ---
mkdirSync(contextDir, { recursive: true });
// agmsgの1行入出力は本文末尾の改行を保持しないため、送信前と受信後で同じ値に
// なる形へ正規化する。本文中の改行や空白は保持し、末尾改行の有無だけを無視する。
const comparableBody = bodyWithoutRequestId.replaceAll('\r\n', '\n').replace(/\n+$/, '');
const contentHash = createHash('sha256').update(comparableBody).digest('hex');
let loadedPrevious;
try {
  loadedPrevious = loadReviewRequest(root, task);
} catch (error) {
  console.error(`✗ review-request.json の読み込みに失敗しました: ${error.message}`);
  process.exit(2);
}
if (loadedPrevious.staleDiscarded) {
  console.log('REVIEW_PROCESS_WARNING: 前タスク（または旧形式）のreview requestを履歴へ退避し、新しいRequest-IDを作ります。');
}
const previous = loadedPrevious.request;
const pendingStatuses = new Set(['send-attempted', 'sent']);
if (previous?.requestId && !IDENTIFIER_PATTERN.test(previous.requestId)) {
  console.error('✗ 既存review stateのRequest-ID文字種・長さが不正です。stateを更新しません。');
  process.exit(2);
}

let queueReissue = null;
const resetQueueReissue = reviewMode === 'queue' && previous?.status === 'reset' && Boolean(previous.requestId);
if (reviewMode === 'queue' && (forceNew || resetQueueReissue) && previous?.requestId) {
  try {
    const previousEntry = queueEntryPath(previous.requestId);
    let previousQueueStatus = null;
    if (existsSync(previousEntry)) {
      const previousQueueState = readQueueJson(join(previousEntry, 'state.json'), '再依頼元のstate.json');
      previousQueueStatus = String(previousQueueState.status || '');
    }
    queueReissue = resetQueueReissue
      ? {
          reissueOf: previous.requestId,
          ...queueReissueCostPolicy(previousQueueStatus),
        }
      : queueReissueMetadata({
          previousRequestId: previous.requestId,
          previousContentHash: previous.contentHash,
          currentContentHash: contentHash,
          status: previousQueueStatus,
        });
  } catch (error) {
    if (resetQueueReissue) {
      queueReissue = conservativeQueueReissueMetadata(previous.requestId);
      console.error(`REVIEW_PROCESS_WARNING: resetした旧queue依頼の状態を確認できないため、費用再承認を必須にして再送を続けます: ${error.message}`);
    } else {
      console.error(`✗ queue再依頼元を安全に確認できないため--force-newを中止します: ${error.message}`);
      process.exit(2);
    }
  }
}

// 送信済み/送信試行済みの依頼は、check失敗後の再実行でも絶対に二重送信しない。
if (previous && pendingStatuses.has(previous.status) && !forceNew) {
  if (send && reviewMode === 'queue' && previous.status === 'sent' && previous[RUNTIME_EVIDENCE_MARKER_KEY] === 1) {
    const expectedRound = Number.isInteger(reviewPlan?.round) ? reviewPlan.round : null;
    const expectedLens = reviewPlan?.lens?.key || null;
    const expectedRecheck = reviewPlan?.recheck === 1 ? 1 : null;
    const expectedModel = reviewRuntime.model || String(task.reviewer?.model || task.reviewer || '').trim();
    const expectedRequestId = queueRequestId({
      taskId: normalizedTaskIdentity.taskId,
      taskFingerprint: normalizedTaskIdentity.taskFingerprint,
      contentHash,
      forceNew: false,
    });
    if (previous.requestId === expectedRequestId) {
      const expectedEntryDir = queueEntryPath(expectedRequestId);
      const verifiedWinner = waitForSameIntentQueueCompletion({
        requestId: expectedRequestId,
        contentHash,
        taskId: normalizedTaskIdentity.taskId,
        taskFingerprint: normalizedTaskIdentity.taskFingerprint,
        head: reviewDiffScope.headCommit,
        round: expectedRound,
        lens: expectedLens,
        recheck: expectedRecheck,
        model: expectedModel,
        effort: reviewRuntime.effort,
        entryDir: expectedEntryDir,
        target: lane.to,
        body: bodyWithoutRequestId
          .replaceAll('__REQUEST_ID__', expectedRequestId)
          .replaceAll('__CONTENT_HASH__', contentHash),
      });
      if (verifiedWinner.ok) {
        console.log('=== ai:review-send ===');
        console.log(`  Request-ID: ${expectedRequestId}`);
        console.log('  status    : sent（同一queue --yesの勝者登録を確認）');
        console.log(`  queue     : ${expectedEntryDir}`);
        process.exit(0);
      }
    }
  }
  console.log('=== ai:review-send ===');
  console.log(`  Request-ID: ${previous.requestId}`);
  console.log(`  status    : ${previous.status}`);
  console.error('  ✗ 既存依頼は送信試行済みです。安全のため自動再送しません。');
  if (!send && existsSync(requestFile)) {
    console.log('----- 送信済みレビュー依頼文 -----');
    console.log(readFileSync(requestFile, 'utf8'));
    console.log('----------------------------------');
  }
  const checkFlags = previous.mode === 'queue' || reviewMode === 'queue' ? '' : '--verdict auto';
  console.error(`  復旧: まず ${aiCmd('review-check', checkFlags, { root })} を再実行してください。`);
  console.error(`  新しいRequest-IDで明示的に再依頼する場合: ${aiCmd('review-send', '--yes --force-new', { root })}`);
  console.error(`  状態だけ解除する場合: ${aiCmd('review-reset', '--yes', { root })}`);
  process.exit(1);
}

if (previous?.status === 'accepted' && !forceNew) {
  console.error('✗ 既存review requestは受領済みです。履歴なしで上書きしません。');
  console.error(`  明示reset: ${aiCmd('review-reset', '--yes', { root })}`);
  console.error(`  即時再依頼: ${aiCmd('review-send', '--yes --force-new', { root })}`);
  process.exit(1);
}



const plannedRound = Number.isInteger(reviewPlan?.round) ? reviewPlan.round : null;
const plannedLens = reviewPlan?.lens?.key || null;
const plannedRecheck = reviewPlan?.recheck === 1 ? 1 : null;
const plannedImmutableReviewRequestFields = {
  round: plannedRound,
  lens: plannedLens,
  recheck: plannedRecheck,
};
const reusePrepared = !forceNew
  && previous?.status === 'prepared'
  && previous?.[RUNTIME_EVIDENCE_MARKER_KEY] === 1
  && previous.contentHash === contentHash
  && sameReviewRequestImmutableFields(previous, plannedImmutableReviewRequestFields);
let requestId = reusePrepared
  ? previous.requestId
  : reviewMode === 'queue'
    ? queueRequestId({
        taskId: normalizedTaskIdentity.taskId,
        taskFingerprint: normalizedTaskIdentity.taskFingerprint,
        contentHash,
        forceNew: forceNew || resetQueueReissue,
      })
    : randomUUID();

if (
  reviewMode === 'queue' &&
  !reusePrepared &&
  previous?.requestId === requestId
) {
  requestId = queueRequestId({
    taskId: normalizedTaskIdentity.taskId,
    taskFingerprint: normalizedTaskIdentity.taskFingerprint,
    contentHash,
    forceNew: true,
  });

  if (requestId === previous.requestId) {
    throw new Error(
      'queueRequestId returned previous request ID after forceNew; refusing to publish',
    );
  }
}
// 費用枠の照合で登録を止めた依頼は status=prepared のまま残る（queueへは登録されていない）。
// その下書きを送り直すときは、依頼内容が変わっていても「どの依頼の再依頼か」と
// 「再承認が要るか」を引き継ぐ。contentHash一致を条件にすると、承認を足す前後に
// HEADや検証欄が動いて内容が変わるだけで再承認の条件が外れ、taskIdだけの承認で
// 有料レビューが通ってしまう。Request-IDは内容が変われば新しくなるので、案内には新IDを出す。
if (reviewMode === 'queue' && previous?.status === 'prepared' && previous.reissueOf) {
  const stickyReapproval = previous.reapprovalRequired === true;
  queueReissue = {
    reissueOf: previous.reissueOf,
    reapprovalRequired: stickyReapproval,
    reapprovalReason: stickyReapproval ? 'reissue-after-result-staged' : null,
  };
}
const body = bodyWithoutRequestId
  .replaceAll('__REQUEST_ID__', requestId)
  .replaceAll('__CONTENT_HASH__', contentHash);

function changedPathList(args, { excludeSecrets = true } = {}) {
  const excludes = excludeSecrets ? secretExcludes : [];
  const value = gitRequired([...args, '-z', '--', '.', ...excludes], '変更ファイル一覧');
  return value.split('\0').filter(Boolean);
}

function safeChangedPaths() {
  // 受入側(validateQueueWorktreeSnapshot)と同じ列挙関数を使う。
  // 片方だけ数え方が変わると、登録時と受入時で一覧が食い違って結果を受け取れなくなる。
  const { paths: safe, excludedSecretCount } = listQueueChangedPaths(root, {
    baseCommit: reviewDiffScope.baseCommit,
    label: '変更ファイル一覧',
  });
  if (excludedSecretCount > 0 && !safeChangedPaths.secretWarningShown) {
    safeChangedPaths.secretWarningShown = true;
    console.error(`REVIEW_QUEUE_REDACTION_WARNING: 秘密・個人情報らしい名前の変更を${excludedSecretCount}件、queue入力から除外しました。`);
  }
  if (safe.length > MAX_CHANGED_FILES) {
    throw new Error(
      `queueへ固定する変更ファイルが上限${MAX_CHANGED_FILES}件を超えています。変更を分割するか、AI_REVIEW_MODE=paneで依頼してください`,
    );
  }
  return safe;
}

function untrackedPatch(paths, { includeIgnored = false } = {}) {
  const untracked = new Set(changedPathList(['ls-files', '--others', '--exclude-standard']));
  if (includeIgnored && paths.length) {
    // 宣言されたnative task出力は、.gitignore配下だと通常の未追跡列挙に出てこない。要求された
    // literal pathだけをignored込みで数え、review対象の出力を黙って落とさない。
    const ignored = gitRequired(
      ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...literalGitPathspecs(paths)],
      '宣言済みignoredファイル一覧',
    );
    for (const rel of ignored.split('\0').filter(Boolean)) untracked.add(rel);
  }
  const sections = [];
  for (const path of paths) {
    if (!untracked.has(path)) continue;
    const absolute = join(root, path);
    const info = lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`未追跡の変更${path}は通常ファイルではありません`);
    }
    if (info.size > MAX_QUEUE_PATCH_BYTES) {
      throw new Error(`未追跡ファイル${path}がqueue差分の上限${MAX_QUEUE_PATCH_BYTES} bytesを超えています`);
    }
    const raw = readFileSync(absolute);
    if (raw.length === 0) {
      sections.push(`diff --git a/${path} b/${path}\nnew file mode 100644\nindex e69de29..e69de29\n`);
      continue;
    }
    if (raw.includes(0)) {
      sections.push(`diff --git a/${path} b/${path}\nnew file mode 100644\nBinary file ${path} omitted; sha256=${sha256(raw)}\n`);
      continue;
    }
    // NULを含まなくてもUTF-8でないことはある(Shift_JIS等)。読めないまま伏せ字判定へ回さない。
    const text = redactReviewText(decodeReviewBytes(raw, `未追跡ファイル${path}`)).replaceAll('\r\n', '\n');
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    sections.push(
      `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` +
        `${lines.map((line) => `+${line}`).join('\n')}\n`,
    );
  }
  return sections.join('\n');
}

function captureQueueManifest(paths = safeChangedPaths()) {
  const currentHead = reviewDiffScope.unbornHead
    ? (git(['rev-parse', '--verify', '--quiet', 'HEAD']) || '').trim() || null
    : (gitRequired(['rev-parse', '--verify', '--quiet', 'HEAD'], 'queue snapshot HEAD') || '').trim() || null;
  if (currentHead !== reviewDiffScope.headCommit) {
    throw new Error('レビュー差分の取得中にHEADが変わりました');
  }
  return {
    headCommit: currentHead,
    files: paths.map((path) => {
      const absolute = join(root, path);
      if (!existsSync(absolute)) return { path, status: 'deleted', size: 0, sha256: null };
      const info = lstatSync(absolute);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path}は通常ファイルではありません`);
      return { path, status: 'present', size: info.size, sha256: sha256File(absolute) };
    }),
  };
}

function buildQueueSnapshot(previewSnapshot, inlinePaths = null) {
  const consistent = captureConsistentQueueSnapshot({
    capture: () => captureQueueManifest(queueCapturePaths || safeChangedPaths()),
    expectedSnapshot: previewSnapshot,
    materialize: (captured) => {
      const manifestPaths = captured.files.map((file) => file.path);
      const paths = inlinePaths || manifestPaths;
      const literalPaths = paths.map(literalPathspec);
      const headExists = Boolean(git(['rev-parse', '--verify', '--quiet', 'HEAD']));
      const trackedPatch = paths.length
        ? redactReviewText(reviewDiffScope.baseCommit
            ? gitRequired(
                ['diff', '--no-color', reviewDiffScope.baseCommit, '--', ...literalPaths],
                'review scope git diff',
              )
            : headExists
            ? gitRequired(['diff', 'HEAD', '--no-color', '--', ...literalPaths], 'git diff')
            : [
                gitRequired(['diff', '--cached', '--no-color', '--', ...literalPaths], 'staged git diff'),
                gitRequired(['diff', '--no-color', '--', ...literalPaths], 'unstaged git diff'),
              ].filter(Boolean).join('\n'))
        : '';
      const patch = `${trackedPatch}${trackedPatch && !trackedPatch.endsWith('\n') ? '\n' : ''}${untrackedPatch(paths, { includeIgnored: Boolean(inlinePaths) })}`;
      if (paths.length > 0 && !patch.trim()) {
        throw new Error('レビュー対象には変更がありますがdiff.patchが空です。空のレビュー依頼は登録しません');
      }
      if (Buffer.byteLength(patch, 'utf8') > MAX_QUEUE_PATCH_BYTES) {
        throw new Error(`queueへ固定する差分が上限${MAX_QUEUE_PATCH_BYTES} bytesを超えています`);
      }
      return { patch, empty: paths.length === 0 };
    },
  });
  return {
    patch: consistent.patch,
    empty: consistent.empty,
    manifest: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      files: consistent.snapshot.files,
    },
  };
}

const { prepareReviewCycleForSend, reviewedDispatchStep } = await import('./ai-review-cycle-lib.mjs');
const dispatchStep = reviewedDispatchStep(reviewPlan, nativeChain);
const queueReservationCost = send && reviewMode === 'queue' ? (() => {
  try {
    return resolveQueueCostLimits({
      env: process.env, taskId: normalizedTaskIdentity.taskId, project: String(task.project ?? ''), repo: String(task.repo ?? ''), requestId, reapprovalRequired: queueReissue?.reapprovalRequired === true,
    });
  } catch {
    // Do not reserve an invalid-cost request. The queue's existing error path
    // below reports the actual validation error and preserves its exit contract.
    return { ok: false };
  }
})() : null;
const reviewCyclePrepared = send && (!queueReservationCost || queueReservationCost.ok) ? prepareReviewCycleForSend(root, {
  ...(reusePrepared ? { ticketId: previous.reviewCycle?.ticketId, ticketHash: previous.reviewCycle?.ticketHash } : {}),
  step: dispatchStep,
  cycle: dispatchStep === 'astra-diagnosis' ? 3 : Number(plannedRound || 1),
  candidateHash: contentHash,
  requestId,
  model: reviewRuntime?.model || 'deepseek-flash',
  effort: reviewRuntime?.effort || 'high',
  taskId: normalizedTaskIdentity.taskId,
}) : null;
const state = {
  requestId,
  reviewCycle: reviewCyclePrepared,
  status: 'prepared',
  mode: reviewMode,
  [RUNTIME_EVIDENCE_MARKER_KEY]: 1,
  ...(reviewRuntime.effort === undefined ? {} : { reviewerEffort: reviewRuntime.effort }),
  createdAt: reusePrepared ? previous.createdAt : new Date().toISOString(),
  workflowProfile: lane.profile,
  team: lane.team,
  from: lane.from,
  to: lane.to,
  project: String(task.project ?? ''),
  repo: String(task.repo ?? ''),
  branch: String(task.branch ?? ''),
  task: String(task.task ?? ''),
  taskId: normalizedTaskIdentity.taskId,
  taskFingerprint: normalizedTaskIdentity.taskFingerprint,
  reviewBaseRef: reviewDiffScope.baseRef,
  reviewBaseCommit: reviewDiffScope.baseCommit,
  reviewHeadCommit: reviewDiffScope.headCommit,
  reviewBaseSource: reviewDiffScope.baseSource,
  reviewCommittedRangeEmpty: reviewDiffScope.committedRangeEmpty,
  round: plannedRound,
  lens: plannedLens,
  recheck: plannedRecheck,
  contentHash,
  primaryReview: {
    ...primaryReview,
    reviewHeadCommit: primaryReview.reviewHeadCommit || reviewDiffScope.headCommit,
    contentHash,
  },
  ...(nativeReview
    ? { reviewChainVersion: NATIVE_REVIEW_CHAIN_VERSION, nativeReview, nativeScopeFile }
    : {}),
  ...(Array.isArray(focusedTargets)
    ? { nativeFocusedTargets: focusedTargets, nativeFocusedTargetsHash: focusedTargetsHash }
    : {}),
  ...(queueReissue
    ? {
        reissueOf: queueReissue.reissueOf,
        reapprovalRequired: queueReissue.reapprovalRequired === true,
      }
    : {}),
};
const expectedPreimage = captureReviewRequestPreimage(previous);
const archiveReason = forceNew
  ? 'force-new'
  : previous?.status === 'reset'
    ? 'superseded-reset'
    : previous?.status === 'prepared'
      ? 'superseded-prepared'
      : 'new-request';
if (reusePrepared) {
  try {
    updateExistingReviewRequestStateCas({
      expectedPreimage,
      patch: state,
    });
  } catch (stateError) {
    const preimageMismatchMessage = String(stateError?.message || '');
    const canRecoverDuplicate = reviewMode === 'queue'
      && send
      && !forceNew
      && (preimageMismatchMessage === 'review-request.jsonのpreimageが読取時から変わったため公開を中止します'
        || preimageMismatchMessage === 'review-request.jsonのpreimageが読取時から変わったためstate更新を中止します');
    let verifiedWinner = { ok: false };
    if (canRecoverDuplicate) {
      const expectedModel = reviewRuntime.model || String(task.reviewer?.model || task.reviewer || '').trim();
      verifiedWinner = waitForSameIntentQueueCompletion({
        requestId: state.requestId,
        contentHash: state.contentHash,
        taskId: state.taskId,
        taskFingerprint: state.taskFingerprint,
        head: state.reviewHeadCommit,
        round: state.round,
        lens: state.lens,
        recheck: state.recheck,
        model: expectedModel,
        effort: reviewRuntime.effort,
        entryDir: queueEntryPath(state.requestId),
        target: lane.to,
        body,
      });
    }
    if (verifiedWinner.ok) {
      console.log('=== ai:review-send ===');
      console.log(`  Request-ID: ${state.requestId}`);
      console.log('  status    : sent（同一queue --yesの勝者登録を確認）');
      console.log(`  queue     : ${queueEntryPath(state.requestId)}`);
      process.exit(0);
    }
    throw stateError;
  }
  if (!existsSync(requestFile)) {
    atomicWriteFile(requestFile, body);
  }
} else {
  try {
    publishNewReviewRequestCas({
      expectedPreimage,
      body,
      nextState: state,
      archiveReason,
    });
  } catch (stateError) {
    const preimageMismatchMessage = String(stateError?.message || '');
    const canRecoverDuplicate = reviewMode === 'queue'
      && send
      && !forceNew
      && (preimageMismatchMessage === 'review-request.jsonのpreimageが読取時から変わったため公開を中止します'
        || preimageMismatchMessage === 'review-request.jsonのpreimageが読取時から変わったためstate更新を中止します');
    let verifiedWinner = { ok: false };
    if (canRecoverDuplicate) {
      const expectedModel = reviewRuntime.model || String(task.reviewer?.model || task.reviewer || '').trim();
      verifiedWinner = waitForSameIntentQueueCompletion({
        requestId: state.requestId,
        contentHash: state.contentHash,
        taskId: state.taskId,
        taskFingerprint: state.taskFingerprint,
        head: state.reviewHeadCommit,
        round: state.round,
        lens: state.lens,
        recheck: state.recheck,
        model: expectedModel,
        effort: reviewRuntime.effort,
        entryDir: queueEntryPath(state.requestId),
        target: lane.to,
        body,
      });
    }
    if (verifiedWinner.ok) {
      console.log('=== ai:review-send ===');
      console.log(`  Request-ID: ${state.requestId}`);
      console.log('  status    : sent（同一queue --yesの勝者登録を確認）');
      console.log(`  queue     : ${queueEntryPath(state.requestId)}`);
      process.exit(0);
    }
    throw stateError;
  }
}

console.log('=== ai:review-send ===');
console.log(`  mode      : ${send ? `${reviewMode.toUpperCase()} (--yes)` : `dry-run/${reviewMode}（送信しません）`}`);
console.log(`  profile   : ${lane.profile}`);
console.log(`  from      : ${lane.from || '(解決不可)'}`);
console.log(`  → 送信先  : ${lane.to || '(解決不可)'}`);
console.log(`  team      : ${lane.team || '(未設定)'}`);
console.log(`  Request-ID: ${requestId}`);
console.log(`  保存先    : ${requestFile}`);
console.log('');

if (!send) {
  console.log(reviewMode === 'queue'
    ? '→ queue保存先の検査と原子的登録は --yes で実行します。'
    : '→ 送出前4点検は --yes で実際に送る直前に実行します（dry-runでは未実行）。');
  console.log('----- レビュー依頼文（プレビュー） -----');
  console.log(body);
  console.log('---------------------------------------');
  console.log('');
  console.log(`→ 送信するには: ${aiCmd('review-send', nativeChain
    ? '--yes --native-scope <scope.json> --native-scope-hash <scopeHash> --native-reviewed-path <path> [--native-ignored-pathspec <spec>]'
    : primaryReviewRequired ? '--yes --primary-evidence <receipt.json>' : '--yes', { root })}`);
  process.exit(0);
}

if (reviewMode === 'queue') {
  try {
    const snapshot = buildQueueSnapshot(queuePreviewSnapshot, nativeInlinePaths);
    if (nativeReview) assertNativePinCoversManifest(nativeReview, snapshot.manifest.files);
    if (snapshot.empty) {
      console.log('REVIEW_QUEUE_EMPTY_WARNING: 変更が無い状態のレビュー依頼を登録します。');
    }
    const round = plannedRound ?? 1;
    const requestedModel = nativeChain
      ? NATIVE_QUEUE_REVIEWER_MODEL
      : (reviewRuntime.model || String(task.reviewer?.model || task.reviewer || '').trim());
    const createdAt = state.createdAt;
    const cost = resolveQueueCostLimits({
      env: process.env,
      taskId: normalizedTaskIdentity.taskId,
      project: state.project,
      repo: state.repo,
      requestId,
      reapprovalRequired: queueReissue?.reapprovalRequired === true,
    });
    if (!cost.ok) {
      reportQueueCostBlock(cost);
      process.exit(2);
    }
    const { maxPerAttempt, maxPerTask } = cost;
    console.log(`  費用枠    : 1回 ${maxPerAttempt}円 / タスク全体 ${maxPerTask}円`
      + `（1回=${cost.source.maxPerAttempt === 'env' ? '環境変数' : '承認台帳'}`
      + ` / 全体=${cost.source.maxPerTask === 'env' ? '環境変数' : '承認台帳'}）`);
    console.log(`  承認台帳  : ${cost.approvalPath}（承認${cost.approvalCount}件中、taskId完全一致1件を採用）`);
    const preparedPreimage = captureReviewRequestPreimage(state);
    withReviewRequestLock(root, () => {
      const current = readCurrentReviewRequestState();
      if (!reviewRequestPreimageMatches(current, preparedPreimage)) {
        throw new Error('queue登録前にreview-request.jsonが他writerに変更されました');
      }
    });
    assertReviewRequestHeadUnchanged(state.reviewHeadCommit);
    const queued = registerQueueEntry({
      request: {
        schemaVersion: 1,
        [RUNTIME_EVIDENCE_MARKER_KEY]: 1,
        requestId,
        reviewCycle: state.reviewCycle || null,
        taskId: normalizedTaskIdentity.taskId,
        taskFingerprint: normalizedTaskIdentity.taskFingerprint,
        project: state.project,
        repo: state.repo,
        branch: state.branch,
        head: state.reviewHeadCommit,
        round,
        lens: plannedLens,
        primaryReview: state.primaryReview,
        ...(nativeReview
          ? {
              reviewChainVersion: NATIVE_REVIEW_CHAIN_VERSION,
              nativeReview,
              nativeScopeFile,
            }
          : {}),
        ...(Array.isArray(focusedTargets)
          ? { nativeFocusedTargets: focusedTargets, nativeFocusedTargetsHash: focusedTargetsHash }
          : {}),
        recheck: plannedRecheck,
        reviewer: {
          model: requestedModel,
          configuredId: lane.to,
          effort: reviewRuntime.effort,
          sandbox: reviewRuntime.sandbox,
          cli: reviewLens?.reviewer === 'astra'
            ? {
                command: 'codex',
                args: ['exec', '--model', 'gpt-6-astra', '--config', 'model_reasoning_effort="high"', '--sandbox', 'read-only'],
              }
            : null,
        },
        createdAt,
        status: 'pending',
        attempt: 0,
        costLimit: {
          currency: 'JPY',
          maxPerAttempt,
          maxPerTask,
          paidExecutionAllowed: false,
          approvalRecordRequired: true,
          zeroMeans: 'paid_execution_forbidden',
          reapprovalRequired: queueReissue?.reapprovalRequired || false,
          reapprovalReason: queueReissue?.reapprovalReason || null,
        },
        ...(queueReissue ? { reissueOf: queueReissue.reissueOf } : {}),
        inputHash: '',
        promptVersion: REVIEW_QUEUE_PROMPT_VERSION,
        requiresMutationEvidence: false,
      },
      requestMarkdown: redactReviewText(body),
      diffPatch: snapshot.patch,
      manifest: snapshot.manifest,
    });
    try {
      updateExistingReviewRequestStateCas({
        expectedPreimage: preparedPreimage,
        patch: {
          status: 'sent',
          inputHash: queued.inputHash,
          promptVersion: REVIEW_QUEUE_PROMPT_VERSION,
          reviewerModel: requestedModel,
          reviewerEffort: reviewRuntime.effort,
          reviewerSandbox: reviewRuntime.sandbox,
          round: plannedRound,
          lens: plannedLens,
          recheck: plannedRecheck,
          queuedAt: new Date().toISOString(),
          queueEntry: queued.entryDir,
        },
      });
    } catch (stateError) {
      const preimageMismatchMessage = String(stateError?.message || '');
      const canRecoverDuplicate = reviewMode === 'queue'
        && send
        && !forceNew
        && (preimageMismatchMessage === 'review-request.jsonのpreimageが読取時から変わったため公開を中止します'
          || preimageMismatchMessage === 'review-request.jsonのpreimageが読取時から変わったためstate更新を中止します');
      let verifiedWinner = { ok: false };
      if (canRecoverDuplicate) {
        verifiedWinner = waitForSameIntentQueueCompletion({
          requestId,
          contentHash,
          taskId: normalizedTaskIdentity.taskId,
          taskFingerprint: normalizedTaskIdentity.taskFingerprint,
          head: state.reviewHeadCommit,
          round: plannedRound,
          lens: plannedLens,
          recheck: plannedRecheck,
          model: requestedModel,
          effort: reviewRuntime.effort,
          entryDir: queued.entryDir,
          target: lane.to,
          body,
        });
      }
      if (verifiedWinner.ok) {
        console.log(`REVIEW_QUEUE_REGISTERED Request-ID=${requestId}`);
        console.log(`  保存先    : ${queued.entryDir}`);
        console.log('  同一queue --yesの勝者登録を確認したため、二重登録せず成功として終了します。');
        process.exit(0);
      }
      console.error(`REVIEW_QUEUE_REGISTERED_BUT_STATE_CAS_FAILED Request-ID=${requestId}`);
      console.error(`  外部登録は完了していますが、state更新に失敗しました: ${stateError.message}`);
      try {
        const resetResult = markQueueRequestReset(requestId, {
          expectedEntry: queued.entryDir,
          guardedReset: ({ entryDir, writeReset }) => withReviewRequestLock(root, () => {
            let parent;
            try {
              parent = readQueueJson(requestStateFile, 'review-request.json', { maxBytes: 1024 * 1024 });
            } catch (error) {
              throw new Error(`parent review-request.jsonを確認できないためresetを保留します: ${error.message}`);
            }
            if (
              parent
              && parent.requestId === requestId
              && parent.status === 'sent'
              && parent.mode === 'queue'
              && typeof parent.queueEntry === 'string'
              && parent.queueEntry
            ) {
              let sameEntry = false;
              try {
                sameEntry = realpathSync(parent.queueEntry) === realpathSync(entryDir);
              } catch (error) {
                throw new Error(`parent queueEntryの実パスを確認できないためresetを保留します: ${error.message}`);
              }
              if (sameEntry) {
                return { marked: false, entryDir, resetAt: null, reason: 'winner' };
              }
            }
            return writeReset();
          }),
        });
        if (resetResult && resetResult.marked === false) {
          console.error(`REVIEW_QUEUE_RESET_SUPPRESSED Request-ID=${requestId}`);
          console.error('  勝者stateが同一queueをsentで保持しているため、reset印は付けません。');
        }
      } catch (resetError) {
        console.error(`REVIEW_QUEUE_RESET_MARK_FAILED Request-ID=${requestId}`);
        console.error(`  reset印を付けられませんでした: ${resetError.message}`);
        console.error(`  queue entry: ${queued.entryDir}`);
      }
      console.error('  自動再送は行いません。Request-IDとqueue登録結果を保全し、手動で照合してください。');
      console.error(`  queue entry: ${queued.entryDir}`);
      process.exit(2);
    }
    console.log(`REVIEW_QUEUE_REGISTERED Request-ID=${requestId}`);
    console.log(`  保存先    : ${queued.entryDir}`);
    console.log(`  待機      : ${aiCmd('review-wait', `${requestId} --timeout-seconds 1800`, { root })}`);
    console.log('  既定では最大1800秒待ちます。--timeout-secondsで変更できます。');
    process.exit(0);
  } catch (error) {
    console.error(`✗ queue登録に失敗しました: ${error.message}`);
    if (/秘密・個人情報/u.test(error.message)) {
      console.error('  表示された対象の秘密・個人情報らしい値を伏せてから再実行してください（値そのものは表示しません）。');
      console.error(`  元の内容を変更せず確認する場合: AI_REVIEW_MODE=pane ${aiCmd('review-send', '--yes', { root })}`);
    } else {
      console.error('  同じ入力なら同じRequest-IDで再実行できます。入力が変わった場合は新しいRequest-IDになります。');
    }
    process.exit(2);
  }
}

// --- 13. 送信（--yes） ---
await sendPaneReviewRequest(state, body, lane);

async function sendPaneReviewRequest(state, body, lane, verifyWithinLock = null) {
  const { consumeDispatchTicket } = await import('./ai-review-cycle-lib.mjs');
  const reviewCycleTicket = state.reviewCycle && typeof state.reviewCycle === 'object' ? state.reviewCycle : null;
  if (!reviewCycleTicket?.ticketId) throw new Error('REVIEW_CYCLE_DISPATCH_TICKET_REQUIRED: ai review-cycle reserve で発行した ticketId が review-request.json にありません');
  consumeDispatchTicket(root, {
    ticketId: reviewCycleTicket.ticketId,
    stage: 'pane',
    step: reviewCycleTicket.step,
    cycle: reviewCycleTicket.cycle,
    candidateHash: reviewCycleTicket.candidateHash || state.candidateHash,
    requestId: reviewCycleTicket.requestId || state.requestId,
    model: reviewCycleTicket.model,
    effort: reviewCycleTicket.effort,
    purposeId: reviewCycleTicket.purposeId,
  });
  const requestId = state.requestId;
let sendAttempted = false;
try {
  const preparedPreimage = captureReviewRequestPreimage(state);
  updateExistingReviewRequestStateCas({
    expectedPreimage: preparedPreimage,
    patch: { status: 'send-attempted', sendAttemptedAt: new Date().toISOString() },
    verifyWithinLock,
  });
  sendAttempted = true;
  const out = runAgmsgScript('send.sh', [lane.team, lane.from, lane.to, body], { cwd: root });
  try {
    updateExistingReviewRequestStateCas({
      expectedPreimage: captureReviewRequestPreimage({ ...state, status: 'send-attempted' }),
      patch: { status: 'sent', sentAt: new Date().toISOString() },
    });
  } catch (stateError) {
    console.error(`REVIEW_SEND_STATE_CAS_FAILED_AFTER_SEND Request-ID=${requestId}`);
    console.error(`  送信は実行されましたが、state更新に失敗しました: ${stateError.message}`);
    console.error('  自動再送は行いません。送信結果とRequest-IDを保全し、手動で照合してください。');
    process.exit(1);
  }
  console.log(out.trim());
  console.log(`✓ ${lane.team} / ${lane.from} → ${lane.to} にレビュー依頼を送信しました。`);
} catch (e) {
  if (sendAttempted) {
    console.error(`✗ agmsg send.sh の実行に失敗しました: ${e.message}`);
    console.error('  送信成否が不明な可能性があるため status=send-attempted を保持し、自動再送しません。');
  } else {
    console.error(`✗ 送信前state更新に失敗しました: ${e.message}`);
    console.error('  agmsgは未送信です。stateを変更していません。');
  }
  if (e.stdout) console.error(e.stdout.toString());
  if (e.stderr) console.error(e.stderr.toString());
  process.exit(1);
}

}


function fixedHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function fixedNeed(ok, reason) { if (!ok) throw new Error(reason); }
function fixedSafeBytes(file) {
  const path = resolve(file);
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const st = lstatSync(parent);
    fixedNeed(st.isDirectory() && !st.isSymbolicLink(), 'FIXED_UNSAFE_PARENT');
    if (parent === dirname(parent)) break;
  }
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    fixedNeed(st.isFile() && st.size <= 3 * 1024 * 1024, 'FIXED_UNSAFE_FILE');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function fixedRepoPath(path) {
  fixedNeed(typeof path === 'string' && path && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') && !path.split('/').some(p => !p || p === '..' || p === '.'), 'FIXED_INVALID_PATH');
  return join(root, path);
}
function fixedCanonicalHelper() {
  let source = join(homedir(), 'projects', 'ai-dev-tool');
  if (process.env.REVIEW_REQUEST_TEST_MODE === '1' && process.env.AI_DEV_TOOL_SOURCE_REPO) source = process.env.AI_DEV_TOOL_SOURCE_REPO;
  const common = cwd => gitOutput(['rev-parse','--path-format=absolute','--git-common-dir'], {cwd}).trim();
  const ownSource = realpathSync(common(root)) === realpathSync(common(source));
  const bytes = gitOutput(['show', ownSource ? 'HEAD:scripts/ai-review-send.mjs' : 'HEAD:templates/scripts/ai-review-send.mjs'], {cwd:ownSource ? root : source, encoding:'buffer'});
  return fixedHash(bytes);
}
function validateFixedPreparedNow(pin) {
  fixedNeed(fixedHash(fixedSafeBytes(fixedPinPath)) === fixedPinHash, 'FIXED_PIN_CHANGED');
  const stateBytes = fixedSafeBytes(requestStateFile);
  const state = JSON.parse(decodeReviewBytes(stateBytes, 'fixed prepared state'));
  fixedNeed(state.status === 'prepared' && state.mode === 'pane' && state[RUNTIME_EVIDENCE_MARKER_KEY] === 1, 'FIXED_STATUS');
  fixedNeed(fixedHash(stateBytes) === pin.stateSHA256, 'FIXED_CAS_PREIMAGE');
  fixedNeed(pin.metadata && pin.files && pin.allowedMaintenance, 'FIXED_PIN_SCHEMA');
  for (const key of ['requestId','mode','runtimeEvidenceSchemaVersion','workflowProfile','project','repo','task','taskId','taskFingerprint','branch','team','from','to','reviewBaseCommit','reviewHeadCommit','round','lens','recheck','contentHash','reviewerEffort']) {
    fixedNeed(JSON.stringify(state[key]) === JSON.stringify(pin.metadata[key]), `FIXED_STATE_${key}`);
  }
  fixedNeed(IDENTIFIER_PATTERN.test(state.requestId) && /^[a-f0-9]{64}$/.test(state.contentHash), 'FIXED_ID_HASH');
  fixedNeed(state.round >= 1 && state.round <= 3 && reviewPlan.round === state.round && reviewPlan.lens.key === state.lens && (reviewPlan.recheck === 1 ? 1 : null) === state.recheck, 'FIXED_ROUND_LENS');
  const liveTask = JSON.parse(decodeReviewBytes(fixedSafeBytes(taskFile), 'fixed live task'));
  const identity = taskIdentity(liveTask);
  const liveRounds = loadReviewRounds(root, liveTask, {persist:false}).state;
  const completedRounds = liveRounds.codeReview?.rounds?.length ?? 0;
  fixedNeed(!codeReviewClosed(liveRounds) && completedRounds < 3, 'FIXED_REVIEW_STOP');
  fixedNeed(state.recheck === 1 || state.round === completedRounds + 1, 'FIXED_REVIEW_ROUND_CHANGED');

  const liveLane = resolveLane(liveTask, root, 'implementer');
  fixedNeed(!liveLane.errors.length, 'FIXED_LANE_RESOLVER');
  const liveApproval = loadApproval(root, liveTask);
  fixedNeed(!liveApproval.errors.length, 'FIXED_APPROVAL');
  const scope = resolveReviewDiffScope(root, {task:liveTask});
  fixedNeed(scope.headCommit === state.reviewHeadCommit && scope.baseCommit === state.reviewBaseCommit && !scope.unbornHead, 'FIXED_HEAD_BASE');
  fixedNeed((git(['symbolic-ref','--short','HEAD']) || '').trim() === state.branch && liveTask.branch === state.branch, 'FIXED_BRANCH');
  fixedNeed(identity.taskId === state.taskId && identity.taskFingerprint === state.taskFingerprint, 'FIXED_TASK_IDENTITY');
  for (const key of ['project','repo','task']) fixedNeed(String(liveTask[key] ?? '') === state[key], `FIXED_TASK_${key}`);
  for (const key of ['team','from','to']) fixedNeed(liveLane[key] === state[key], `FIXED_LANE_${key}`);
  fixedNeed(liveLane.profile === state.workflowProfile, 'FIXED_PROFILE');
  const runtime = reviewPlan.lens.runtime || {model:reviewPlan.lens.reviewer || String(liveTask.reviewer?.model || liveTask.reviewer || '').trim(), effort:'high',sandbox:'read-only'};
  const bodyBytes = fixedSafeBytes(requestFile);
  const body = decodeReviewBytes(bodyBytes, 'fixed prepared body');
  fixedNeed(fixedHash(bodyBytes) === pin.bodySHA256, 'FIXED_BODY_BYTES');
  for (const [header,key] of Object.entries({'Project':'project','Repo':'repo','Branch':'branch','Task':'task','Team':'team','Request-ID':'requestId','Content-Hash':'contentHash','Workflow-Profile':'workflowProfile','From':'from','To':'to'})) {
    fixedNeed(body.split('\n').includes(`${header}: ${state[key]}`), `FIXED_HEADER_${key}`);
  }
  for (const [header,value] of Object.entries({'Review-Model':runtime.model,'Review-Effort':runtime.effort,'Review-Sandbox':runtime.sandbox})) fixedNeed(body.split('\n').includes(`${header}: ${value}`), `FIXED_RUNTIME_${header}`);
  fixedNeed(runtime.effort === state.reviewerEffort && runtime.sandbox === 'read-only', 'FIXED_RUNTIME');
  const comparable = body.replaceAll(state.requestId,'__REQUEST_ID__').replaceAll(state.contentHash,'__CONTENT_HASH__').replaceAll('\r\n','\n').replace(/\n+$/,'');
  fixedNeed(fixedHash(comparable) === state.contentHash, 'FIXED_CONTENT_HASH');
  const section = body.split('## 変更ファイル\n')[1]?.split('\n\n')[0];
  fixedNeed(section !== undefined, 'FIXED_PATH_SECTION');
  const reviewedPaths = [...section.matchAll(/^- (?:\S+)\t(.+)$/gm)].map(match=>match[1]);
  const pinnedPaths = Object.keys(pin.files);
  fixedNeed(reviewedPaths.length === pinnedPaths.length && [...new Set(reviewedPaths)].sort().join('\0') === pinnedPaths.sort().join('\0'), 'FIXED_PATH_COVERAGE');
  fixedNeed(pinnedPaths.includes('.ai/current-task.json') && pinnedPaths.includes('.ai/approval.json'), 'FIXED_TASK_APPROVAL_PIN_REQUIRED');
  for (const [path,hash] of Object.entries(pin.files)) {
    fixedNeed(/^[a-f0-9]{64}$/.test(hash) && fixedHash(fixedSafeBytes(fixedRepoPath(path))) === hash, `FIXED_INPUT_CHANGED:${path}`);
  }
  const maintenancePaths = Object.keys(pin.allowedMaintenance);
  fixedNeed(maintenancePaths.length === 1 && maintenancePaths[0] === 'scripts/ai-review-send.mjs' && /^[a-f0-9]{64}$/.test(pin.allowedMaintenance[maintenancePaths[0]]), 'FIXED_MAINTENANCE_SCOPE');
  const changes = new Set([
    ...gitRequired(['diff','--name-only','--no-renames','-z',scope.baseCommit,'--','.'], 'fixed changed paths').split('\0').filter(Boolean),
    ...gitRequired(['ls-files','--others','--exclude-standard','-z','--','.'], 'fixed untracked paths').split('\0').filter(Boolean),
  ]);
  for (const path of changes) fixedNeed(Object.hasOwn(pin.files,path) || path === maintenancePaths[0], `FIXED_UNREVIEWED_PATH:${path}`);
  // A formally installed sender repair changes its helper hash, never product hashes.
  // Accept only the same maintenance path whose current bytes equal canonical committed source.
  fixedNeed(fixedHash(fixedSafeBytes(fixedRepoPath(maintenancePaths[0]))) === fixedCanonicalHelper(), 'FIXED_MAINTENANCE_NOT_CANONICAL');
  return {state, body, lane:liveLane};
}
async function sendFixedPrepared() {
  fixedNeed(lane.profile === 'gpt56-claude-v1' && reviewPlan.lens.primaryReviewer !== 'deepseek' && reviewPlan.reviewChainVersion !== NATIVE_REVIEW_CHAIN_VERSION && reviewPlan.lens.reviewer !== 'astra', 'FIXED_UNSUPPORTED_CHAIN');
  const bytes = fixedSafeBytes(fixedPinPath);
  fixedNeed(fixedHash(bytes) === fixedPinHash, 'FIXED_PIN_HASH');
  const pin = JSON.parse(decodeReviewBytes(bytes, 'fixed prepared pin'));
  let validated = validateFixedPreparedNow(pin);
  if (fixedPreflight) {
    writeSync(1, `FIXED_PREPARED_PREFLIGHT_OK Request-ID=${validated.state.requestId} contentHash=${validated.state.contentHash}\n`);
    return;
  }
  // Preserve existing round-size freeze and closed/stop behavior after no-write validation.
  reviewPlan = await reviewLensHelper.focusedReviewPlan(root, task, {freezeSize:true});
  await exitIfReviewPlanClosed(reviewPlan);
  fixedNeed(reviewPlan?.status !== 'error' && reviewPlan?.lens, 'FIXED_REVIEW_PLAN');
  validated = validateFixedPreparedNow(pin);
  await sendPaneReviewRequest(validated.state, validated.body, validated.lane, () => { validateFixedPreparedNow(pin); });
}
