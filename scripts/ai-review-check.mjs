/**
 * agmsg Manager - review-check（profileのreviewerからのレビュー返信取得）
 *
 * 目的:
 *   profileのreviewerからの返信を、agmsg inbox を手動確認せずに取得する。
 *   別リポジトリ・別ブランチ・別タスクの返信は採用しない。
 *
 * 処理:
 *   1. .ai/current-task.json を読む
 *   2. 公式 inbox.sh に team/to を明示し、implementer のレーンだけ取得する
 *   3. 公式 history.sh で同じレーンの既読分も読み、未読分とmerge（重複排除）する
 *   4. 返信元reviewer / 宛先 / team / Request-ID / Project / Repo / Branch / Task を厳密照合する
 *   5. 一致 → .ai/context/review-result.md に保存（一致が1件以上ある時だけ上書き）
 *   6. 不一致 → .ai/logs/agmsg-review-ignored.log に追記
 *   7. ターミナルには一致件数・無視件数・保存先だけ表示
 *
 * 既読分もmergeする理由（2026-08-02に2度再発した証跡消失の恒久対策）:
 *   inbox.sh は読んだ瞬間に read_at を打つ。wait-reply.sh は内部で inbox.sh を呼ぶため、
 *   レーンが「wait-reply.sh で返信を待つ → 後から review-check」の順で動くと、
 *   review-check の時点で未読は0件になり、DBに本文が残っているのに証跡を作れない。
 *   history.sh は read_at を打たず既読も返すので、これをmergeすれば回収できる。
 *   照合は緩めない。history.sh は宛先を絞らないため to の一致検査をむしろ追加している。
 *
 * 使い方:
 *   node scripts/ai-review-check.mjs
 *   wait-reply.sh ... | node scripts/ai-review-check.mjs --stdin
 *   node scripts/ai-review-check.mjs --recover --request-id <ID>   （下記）
 *
 * --recover:
 *   タスク完了処理で current-task.json の branch を master へ揃えた後などに、
 *   保存済みrequestと現taskのProject/Repo/Branch/Taskが食い違って証跡を取れなくなる状態を
 *   救う明示モード。保存済みrequestのRequest-IDを --request-id で名指しさせ、
 *   agmsgレーン（team/from/to）の一致は従来どおり必須のまま、
 *   「現taskとの一致」だけを免除する。messageの照合条件は一切変えない。
 *
 * ※ 今回は返信取得のみ。自動修正ループ / 自動 commit / 自動 push は未実装。
 */
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';
import {
  aiCmd,
  agentId,
  appendSecureLog,
  ensureSafeDirectory,
  extractMessageFields,
  IDENTIFIER_PATTERN,
  parseHistoryLine,
  parseInboxLine,
  resolveLane,
  runAgmsgScript,
  workflowProfile,
} from './ai-workflow-lib.mjs';
import {
  CODE_REVIEW_LENSES,
  CMGB_NATIVE_FOCUSED_CONTRACT,
  FUNCTIONAL_DEFECT_REVIEW_POLICY,
  NATIVE_REVIEW_CHAIN_VERSION,
  cmgbFocusedBatchKey,
  inferReviewVerdictHint,
  loadReviewRounds,
  loadReviewRequest,
  parseReviewReplyVerdict,
  recordCodeReviewRound,
  retryReviewEscalationNotification,
  reviewerRuntimeEvidence,
  reviewerRuntimeModel,
  reviewLensesForTask,
  verifyNativePrimaryReceipt,
} from './ai-review-rounds-lib.mjs';
import {
  atomicWriteJson,
  ensureSafeFile as ensureSafeQueueFile,
  loadValidatedQueueResult,
  NATIVE_QUEUE_REVIEWER_EFFORT,
  NATIVE_QUEUE_REVIEWER_MODEL,
  nativeFocusedTargetsForRequest,
  parseFocusedRecheckDecisions,
  queueResultReplyBody,
  validateQueueWorktreeSnapshot,
  withQueueAcceptanceClaim,
} from './ai-review-queue-lib.mjs';
import { RUNTIME_EVIDENCE_MARKER_KEY, withReviewRequestLock } from './ai-runtime-evidence-lib.mjs';

// 2026-09-28 (T1-T5 stage 4B): the explicit deepseek-native-cli-v1 chain re-verifies its primary
// reviewer from a real Codex JSONL receipt inside the queue acceptance claim. The verifier stays an
// optional import so the legacy and direct-API paths keep working where review-evidence is not
// distributed; a native chain without it fails closed instead of falling back.
let optionalReviewEvidence = null;
try { optionalReviewEvidence = await import('./review-evidence.mjs'); } catch { optionalReviewEvidence = null; }
// 受理の入口であることを確定させる(OPEN-ITEMS §10, 2026-10-15)。提出側が設定した保存元の差し替え指定を
// ここで無効化し、Sol 一次確認の保存元の錨を実行ユーザーのホーム由来の固定ルートだけにする
// (封印の実体は scripts/review-evidence.mjs の sealSubmitterSessionHome)。
// テストはこの入口を通らず検証関数を直接呼ぶため、この封印の影響を受けない。
if (optionalReviewEvidence && typeof optionalReviewEvidence.sealSubmitterSessionHome === 'function') {
  optionalReviewEvidence.sealSubmitterSessionHome();
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const taskFile = join(root, '.ai', 'current-task.json');
const contextDir = join(root, '.ai', 'context');
const logDir = join(root, '.ai', 'logs');
const resultFile = join(contextDir, 'review-result.md');
const ignoredLog = join(logDir, 'agmsg-review-ignored.log');
const requestStateFile = join(contextDir, 'review-request.json');
const MAX_STDIN_BYTES = 1024 * 1024;
const VERDICT_HOLD_EXIT_CODE = 4;

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || '') : '';
}
const stdinMode = args.includes('--stdin');
const stdinPreflight = args.includes('--stdin-preflight');
const noHistory = args.includes('--no-history');
const recoverMode = args.includes('--recover');
const printLenses = args.includes('--print-lenses');
const verdictArg = option('--verdict');
const note = option('--note');
const historyLimitArg = option('--history-limit');
const requestIdArg = option('--request-id');
const valueOptions = new Set(['--verdict', '--note', '--history-limit', '--request-id', '--native-primary-evidence', '--native-session-root']);
const knownFlags = new Set(['--stdin', '--stdin-preflight', '--no-history', '--recover', '--print-lenses']);
const duplicateArgs = [...valueOptions, ...knownFlags]
  .filter((name) => args.filter((arg) => arg === name).length > 1);
if (duplicateArgs.length) {
  console.error(`✗ 同じoptionを重複して指定できません: ${duplicateArgs.join(' ')}`);
  process.exit(2);
}
const unknownArgs = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (valueOptions.has(arg)) {
    if (!args[index + 1] || args[index + 1].startsWith('--')) unknownArgs.push(arg);
    else index += 1;
  } else if (!knownFlags.has(arg)) {
    unknownArgs.push(arg);
  }
}
const preflightConflict =
  stdinPreflight &&
  (stdinMode || noHistory || recoverMode || verdictArg || note || historyLimitArg || requestIdArg);
const printLensesConflict = printLenses && args.length !== 1;
if (unknownArgs.length || preflightConflict || printLensesConflict) {
  console.error(`✗ 不明または不正なoptionです: ${unknownArgs.join(' ') || args.join(' ')}`);
  console.error(
    '  使用可能: --stdin / --stdin-preflight / --verdict ok|findings|auto / --note <1行>' +
      ' / --no-history / --history-limit <件数> / --recover --request-id <ID> / --print-lenses' +
      ' / --native-primary-evidence <receipt.json> / --native-session-root <dir>',
  );
  process.exit(2);
}
if (printLenses) {
  // 出し方は task ごとの実担当にする。DeepSeek以外や web_ui の既存レーンは2往復目が
  // Astra のままなので、taskに関係ない固定表示だと担当を誤って伝える(F1-7 / M-1)。
  let lenses = CODE_REVIEW_LENSES;
  let lensTask = null;
  try {
    lensTask = JSON.parse(readFileSync(taskFile, 'utf8'));
  } catch {
    lensTask = null;
  }
  if (lensTask) {
    try {
      // R2 F2-8: task から決め直さず、保存済みの往復記録があるレーンはその方式を表示する。
      // (旧方式で始まったレーンを、task がDeepSeek対象という理由で新方式と誤って伝えない)
      const savedLensState = loadReviewRounds(root, lensTask, { persist: false }).state;
      lenses = reviewLensesForTask(lensTask, savedLensState, { root });
    } catch (error) {
      console.error(`✗ このレーンのレビュー担当を確定できないため表示しません: ${error.message}`);
      process.exit(2);
    }
  }
  for (const lens of lenses) {
    console.log(`${lens.round}\t${lens.key}\t${lens.primaryReviewer || '(なし)'}\t${lens.reviewer}`);
  }
  process.exit(0);
}
if (verdictArg && !['ok', 'findings', 'auto'].includes(verdictArg)) {
  console.error('✗ --verdict は ok、findings、auto のいずれかを指定してください。');
  process.exit(2);
}
let paneVerdict = verdictArg === 'auto' ? '' : verdictArg;
let paneVerdictSource = ['ok', 'findings'].includes(verdictArg) ? 'explicit' : '';

function safeDiagnostic(value, max = 160) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/gu, '?').slice(0, max);
}

// 既読履歴の走査窓。history.shは「team内でこのagentが関係するmessageの新しい順N件」を返す。
// 窓を超えた分は黙って落とさず、飽和したら警告として表示する。
const DEFAULT_HISTORY_LIMIT = 500;
const MAX_HISTORY_LIMIT = 5000;
let historyLimit = DEFAULT_HISTORY_LIMIT;
if (historyLimitArg) {
  if (!/^[1-9][0-9]*$/.test(historyLimitArg) || Number(historyLimitArg) > MAX_HISTORY_LIMIT) {
    console.error(`✗ --history-limit は 1〜${MAX_HISTORY_LIMIT} の整数で指定してください。`);
    process.exit(2);
  }
  historyLimit = Number(historyLimitArg);
}
if (recoverMode && !requestIdArg) {
  console.error('✗ --recover には --request-id <ID> が必須です（回収対象を人が名指しする運用にします）。');
  process.exit(2);
}
if (requestIdArg && !recoverMode) {
  console.error('✗ --request-id は --recover と一緒にだけ使えます。');
  process.exit(2);
}
if (requestIdArg && !IDENTIFIER_PATTERN.test(requestIdArg)) {
  console.error('✗ --request-id の文字種・長さが不正です。');
  process.exit(2);
}

function readStdinLimited() {
  const chunks = [];
  let total = 0;
  while (true) {
    const remainingProbe = Math.min(64 * 1024, MAX_STDIN_BYTES - total + 1);
    const buffer = Buffer.allocUnsafe(remainingProbe);
    const bytesRead = readSync(0, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > MAX_STDIN_BYTES) {
      throw new Error(`stdinが上限 ${MAX_STDIN_BYTES} bytesを超えました`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function savePrivateCapture(prefix, extension, input) {
  const captureFile = join(logDir, `${prefix}-${Date.now()}-${randomUUID()}.${extension}`);
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    (fsConstants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = openSync(captureFile, flags, 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, input, 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return captureFile;
}

function saveRawStdinCapture(input) {
  return savePrivateCapture('review-check-stdin', 'raw', input);
}

function saveVerdictHoldCapture(entries, request, error) {
  const replies = entries.map((entry) => ({
    ts: entry.ts,
    from: entry.from,
    to: entry.to,
    source: entry.source,
    body: entry.body.split('\\n').join('\n'),
  }));
  const captureKey = createHash('sha256')
    .update(JSON.stringify({
      requestId: request.requestId,
      bodies: replies.map((reply) => reply.body).sort(),
    }))
    .digest('hex');
  const captureFile = join(logDir, `review-check-verdict-hold-${captureKey}.json`);
  const tempFile = join(logDir, `.review-check-verdict-hold-${process.pid}-${randomUUID()}.tmp`);
  const content = `${JSON.stringify({
    schemaVersion: 1,
    status: 'verdict-unreadable',
    captureKey,
    capturePolicy: 'first_observation_preserved',
    capturePolicyNote: '同じRequest-IDと返信本文の再観測はこの初回記録へ集約します',
    capturedAt: new Date().toISOString(),
    requestId: request.requestId,
    error,
    replies,
  }, null, 2)}\n`;
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    (fsConstants.O_NOFOLLOW || 0);
  let fd;
  let writeError = null;
  try {
    fd = openSync(tempFile, flags, 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    writeError = error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error) {
        if (!writeError) writeError = error;
      }
    }
  }
  if (writeError) {
    try {
      unlinkSync(tempFile);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') writeError.cleanupError = cleanupError.message;
    }
    throw writeError;
  }

  try {
    linkSync(tempFile, captureFile);
    return captureFile;
  } catch (publishError) {
    if (publishError?.code !== 'EEXIST') throw publishError;
  } finally {
    try {
      unlinkSync(tempFile);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') throw cleanupError;
    }
  }

  let existingFd;
  try {
    existingFd = openSync(captureFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = fstatSync(existingFd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error('既存の保留証跡が0600の通常ファイルではありません');
    }
    const existing = JSON.parse(readFileSync(existingFd, 'utf8'));
    if (existing?.captureKey !== captureKey || existing?.requestId !== request.requestId) {
      throw new Error('既存の保留証跡の内容が一致しません');
    }
    return captureFile;
  } finally {
    if (existingFd !== undefined) closeSync(existingFd);
  }
}

function printVerdictHoldGuidance(request) {
  const verdictOptions = recoverMode
    ? `--recover --request-id ${request.requestId} --verdict ok|findings`
    : '--verdict ok|findings';
  console.error(`  本文を確認して合否を確定: ${aiCmd('review-check', verdictOptions, { root })}`);
  console.error('  または reviewer に「Verdict: ok」か「Verdict: findings」を付け、findingsには指摘ごとの「Finding-Kind:」を付けて返信し直してもらってください。');
}

if (stdinPreflight) {
  try {
    ensureSafeDirectory(logDir, { create: true });
    console.log(`✓ stdin capture preflight: ${logDir}`);
    process.exit(0);
  } catch (error) {
    console.error(`✗ stdin capture preflightに失敗しました: ${error.message}`);
    process.exit(2);
  }
}

let stdinInput = '';
let stdinCaptureFile = '';
if (stdinMode) {
  try {
    // 保存先を入力前に検証し、読み取り直後にraw内容を退避する。
    ensureSafeDirectory(logDir, { create: true });
    stdinInput = readStdinLimited();
    stdinCaptureFile = saveRawStdinCapture(stdinInput);
    console.log(`  stdin raw capture: ${stdinCaptureFile}`);
  } catch (error) {
    console.error(`✗ stdin captureに失敗しました: ${error.message}`);
    process.exit(2);
  }
}

// --- 1. current-task.json ---
if (!existsSync(taskFile)) {
  console.error('✗ 作業票（.ai/current-task.json）がありません。先に作業の登録（インストーラーまたは init-task）を実行してください。');
  process.exit(2);
}
let task;
try {
  task = JSON.parse(readFileSync(taskFile, 'utf8'));
} catch (e) {
  console.error(`✗ .ai/current-task.json の読み込みに失敗しました: ${e.message}`);
  process.exit(2);
}

let loadedRequest;
try {
  loadedRequest = loadReviewRequest(root, task);
} catch (error) {
  console.error(`✗ review-request.json の読み込みに失敗しました: ${error.message}`);
  process.exit(2);
}
if (loadedRequest.staleDiscarded) {
  console.error('✗ 前タスク（または旧形式）のreview requestは受領せず、履歴へ退避しました。');
  console.error(`  復旧: ${aiCmd('review-flow', '', { root })} で新しい依頼を作成してください。`);
  process.exit(2);
}
const request = loadedRequest.request;
if (!request) {
  console.error('✗ review-request.json がありません。先に ai:review-send で依頼を作成してください。');
  process.exit(2);
}
if (request.status === 'accepted') {
  console.error('✗ review requestは受領済み（status=accepted）です。');
  console.error(`  追加返信を確認する場合は、先に ${aiCmd('review-reset', '--yes', { root })} で明示resetしてください。`);
  process.exit(2);
}
if (!['sent', 'send-attempted'].includes(request.status)) {
  console.error(`✗ review request は未送信です（status=${request.status || '不明'}）。受信箱を読みません。`);
  process.exit(2);
}
const queueMode = request.mode === 'queue';
if (queueMode && ((verdictArg && verdictArg !== 'auto') || stdinMode || noHistory || recoverMode || historyLimitArg)) {
  console.error('✗ queue結果では --verdict / stdin / history / recover 指定を使えません。result.jsonの機械値を正本にします。');
  process.exit(2);
}
if (!queueMode && !verdictArg) {
  console.error('REVIEW_CHECK_REJECTED: --verdict ok|findings|auto を指定してください（返信本文のVerdict行を読む場合はauto）');
  process.exit(2);
}
// 2026-09-28 (T1-T5 stage 4B): the explicit deepseek-native-cli-v1 chain accepts its per-round
// primary review only from a receipt re-verified under the queue acceptance claim. The receipt is
// supplied through this documented official flag and is never a hand-written .ai/queue artifact.
const nativePrimaryEvidenceArg = option('--native-primary-evidence');
const nativeSessionRootArg = option('--native-session-root');
const nativeChainMode = String(request.reviewChainVersion || '').trim() === NATIVE_REVIEW_CHAIN_VERSION;
let nativePrimaryEvidencePath = '';
let nativeTrustedSessionRoot = '';
if (!nativeChainMode && (nativePrimaryEvidenceArg || nativeSessionRootArg)) {
  console.error('✗ --native-primary-evidence / --native-session-root は deepseek-native-cli-v1 の依頼だけで指定できます。');
  process.exit(2);
}
if (nativeChainMode) {
  if (!queueMode) {
    console.error('✗ deepseek-native-cli-v1 は公式queue経路でのみ受領します（mode=paneは受理しません）。');
    process.exit(2);
  }
  if (!optionalReviewEvidence) {
    console.error('✗ review-evidence.mjs が無いため、native一次レビューの実証跡を再検証できません。');
    process.exit(2);
  }
  if (!nativePrimaryEvidenceArg) {
    console.error('✗ native一次レビューの実証跡が未指定です。--native-primary-evidence <receipt.json> を指定してください。');
    process.exit(2);
  }
  nativePrimaryEvidencePath = isAbsolute(nativePrimaryEvidenceArg)
    ? nativePrimaryEvidenceArg
    : join(root, nativePrimaryEvidenceArg);
  if (!existsSync(nativePrimaryEvidencePath)) {
    console.error(`✗ native一次レビューの実証跡が見つかりません: ${nativePrimaryEvidenceArg}`);
    process.exit(2);
  }
  try {
    nativeTrustedSessionRoot = optionalReviewEvidence.resolveTrustedSessionRoot(
      optionalReviewEvidence.trustedCodexSessionRoot(homedir()),
      nativeSessionRootArg || undefined,
      {task},
    );
  } catch (error) {
    console.error(`✗ 信頼済みCodexセッションルートを確定できません: ${error.message}`);
    process.exit(2);
  }
}
let reviewRoundsState;
try {
  reviewRoundsState = loadReviewRounds(root, task, { persist: false }).state;
} catch (error) {
  console.error(`✗ review-rounds.json の読み込みに失敗しました: ${error.message}`);
  process.exit(2);
}
const usesFunctionalDefectPolicy = reviewRoundsState.codeReview.policy
  === FUNCTIONAL_DEFECT_REVIEW_POLICY;

// --- 2. laneと保存済みrequestを照合してからinbox実行 ---
const lane = queueMode
  ? {
      profile: workflowProfile(task),
      team: String(task.team || '').trim(),
      from: agentId(task.implementer),
      to: agentId(task.reviewer),
      inbox: agentId(task.implementer),
      errors: [],
    }
  : resolveLane(task, root, 'implementer');
// レーン一致（どの受信箱を読むか）とtask一致（依頼当時と同じ作業か）を分けて判定する。
// レーン一致は常に必須。task一致だけが --recover の免除対象になる。
const laneMatches =
  request.team === lane.team &&
  request.from === lane.from &&
  request.to === lane.to;
const taskDrift = [];
for (const [label, saved, current] of [
  ['Project', request.project, String(task.project ?? '')],
  ['Repo', request.repo, String(task.repo ?? '')],
  ['Branch', request.branch, String(task.branch ?? '')],
  ['Task', request.task, String(task.task ?? '')],
]) {
  if (saved !== current) taskDrift.push(`${label}: 依頼時='${saved}' / 現在='${current}'`);
}
const requestIdValid = Boolean(request.requestId) && IDENTIFIER_PATTERN.test(request.requestId);
const recoverIdMatches = !recoverMode || requestIdArg === request.requestId;
const gateOk =
  lane.errors.length === 0 &&
  laneMatches &&
  requestIdValid &&
  recoverIdMatches &&
  (recoverMode || taskDrift.length === 0);
if (!gateOk) {
  console.error(`✗ review request / current-task${queueMode ? '' : ' / agmsgレーン'}を厳密照合できないため、受領しません。`);
  for (const error of lane.errors) console.error(`  - ${error}`);
  if (!laneMatches) console.error('  - 保存済みrequestと現在のteam/from/toが不一致です');
  if (!requestIdValid) console.error('  - Request-IDが無いか文字種・長さが不正です');
  if (!recoverIdMatches) {
    console.error('  - --request-id が保存済みrequestのRequest-IDと一致しません');
  }
  if (!recoverMode && laneMatches && taskDrift.length > 0) {
    console.error('  - 保存済みrequestと現在のProject/Repo/Branch/Taskが不一致です:');
    for (const line of taskDrift) console.error(`      ${line}`);
    console.error(
      '    タスク完了でbranchを揃えた後などにこの返信を回収するなら、Request-IDを名指しして' +
        ` ${aiCmd('review-check', `--recover --request-id ${request.requestId}`, { root })}`,
    );
  }
  process.exit(2);
}

let inboxOut = '';
let queueChecked = null;
let queueImported = null;
function assertQueueImportMatches(checked) {
  if (
    !checked.ready ||
    queueImported.requestId !== request.requestId ||
    queueImported.inputHash !== checked.actualInputHash ||
    queueImported.verdict !== checked.result.verdict ||
    queueImported.body !== queueResultReplyBody(request, checked.result) ||
    queueImported.promptVersion !== checked.result.promptVersion ||
    queueImported.model !== checked.result.model ||
    String(queueImported.fallbackFrom || '') !== String(checked.result.fallbackFrom || '') ||
    queueImported.attempt !== checked.result.attempt ||
    queueImported.leaseGeneration !== checked.result.leaseGeneration ||
    queueImported.ownerToken !== checked.result.ownerToken ||
    queueImported.workerDurationMs !== checked.result.workerDurationMs ||
    queueImported.retry !== checked.result.retry ||
    queueImported.failureReason !== String(checked.result.failureReason || '')
  ) {
    throw new Error('回収済みqueue結果と固定済み入力・result.jsonが一致しません');
  }
}
// 2026-09-28 (T1-T5 stage 4B): the native chain additionally requires the real Opus reviewer result
// and its token/cost evidence. The existing queue checks already bind result.model to the requested
// reviewer model, so a bare `opus` alias can never pass here; the usage object is a separate
// companion requirement of the official queue worker (see the interface note in the report).
function assertNativeQueueResult(checked) {
  if (!nativeChainMode) return;
  const model = String(checked?.result?.model || '');
  if (model !== NATIVE_QUEUE_REVIEWER_MODEL) {
    throw new Error(`native連鎖のqueue結果modelが一致しません（expected=${NATIVE_QUEUE_REVIEWER_MODEL} actual=${model || '(なし)'}）`);
  }
  if (String(checked?.result?.fallbackFrom || '') !== '') {
    throw new Error('native連鎖はqueue結果のfallbackを受理しません');
  }
  const effort = String(checked?.result?.effort ?? checked?.queuedRequest?.reviewer?.effort ?? '');
  if (effort !== NATIVE_QUEUE_REVIEWER_EFFORT) {
    throw new Error(`native連鎖のqueue結果effortが一致しません（expected=${NATIVE_QUEUE_REVIEWER_EFFORT} actual=${effort || '(なし)'}）`);
  }
  const usage = checked?.result?.usage ?? checked?.result?.actual?.usage ?? null;
  if (
    !usage ||
    !Number.isFinite(usage.inputTokens) ||
    !Number.isFinite(usage.outputTokens) ||
    !Number.isFinite(usage.totalTokens)
  ) {
    throw new Error('native連鎖のqueue結果にtoken使用量の証跡(usage.inputTokens/outputTokens/totalTokens)がありません');
  }
  if (!Number.isFinite(checked?.result?.workerDurationMs) || checked.result.workerDurationMs < 0) {
    throw new Error('native連鎖のqueue結果に作業時間の証跡がありません');
  }
}

function cmgbFocusedTokenHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function cmgbFocusedFileHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// CMGB native focused の受理値は、claim内で検証済みの公式queue state/result実bytes・検証済み一次
// receipt・依頼の固定target一覧だけから組み立てる。bindingの作り方をCOREのcmgbFocusedBatchKey入力と
// 同じ順・同じ出所に揃え、batchKeyが一致しない限りCOREが受理しないようにする。
function buildCmgbFocusedRecheckResolution({request, task, checked, verified}) {
  const pinned = nativeFocusedTargetsForRequest(request);
  if (!pinned) throw new Error('CMGB_FOCUSED_TARGETS_MISSING: 依頼にnativeFocusedTargetsがありません');
  const opusByKey = new Map(parseFocusedRecheckDecisions(checked.result.body, pinned.keys).map((item) => [item.key, item]));
  const deepseekByKey = new Map((Array.isArray(verified?.recheckDecisions) ? verified.recheckDecisions : []).map((item) => [String(item.key), item]));
  const binding = {
    taskId: String(task?.taskId || ''),
    taskFingerprint: String(task?.taskFingerprint || ''),
    reviewBaseCommit: String(verified?.reviewBaseCommit ?? request?.reviewBaseCommit ?? '') || null,
    reviewHeadCommit: String(request?.reviewHeadCommit || ''),
    approvalHash: String(verified?.approvalHash || ''),
    scopeHash: String(request?.nativeReview?.scopeHash || ''),
    scopeManifestHash: String(verified?.scopeManifestHash ?? '') || null,
    manifestHash: String(verified?.manifestHash ?? '') || null,
  };
  return {
    contract: CMGB_NATIVE_FOCUSED_CONTRACT,
    requestId: String(request.requestId),
    inputHash: String(request.inputHash),
    round: request.round,
    lens: String(request.lens || ''),
    batchKey: cmgbFocusedBatchKey(binding),
    scopeHash: binding.scopeHash,
    reviewHeadCommit: binding.reviewHeadCommit,
    approvalHash: binding.approvalHash,
    leaseGeneration: checked.state.leaseGeneration,
    ownerTokenSha256: cmgbFocusedTokenHash(checked.state.ownerToken ?? ''),
    queueResultSha256: cmgbFocusedFileHash(checked.resultPath),
    primaryReceiptSha256: String(verified?.evidenceHash || ''),
    primarySessionIdHash: String(verified?.sessionIdHash || ''),
    targets: pinned.keys.map((key) => {
      const deepseek = deepseekByKey.get(key);
      const opus = opusByKey.get(key);
      if (!deepseek || !opus) throw new Error(`CMGB_FOCUSED_DECISION_SET: 対象key ${key} の判定が揃いません`);
      return {
        key,
        deepseek: {decision: deepseek.decision, evidence: deepseek.evidence},
        opus: {decision: opus.decision, evidence: opus.evidence},
      };
    }),
  };
}
if (queueMode) {
  const replyPath = join(contextDir, `queue-reply-${request.requestId}.json`);
  if (!existsSync(replyPath)) {
    console.error(`✗ queue結果が未回収です。先に ${aiCmd('review-wait', request.requestId, { root })} を実行してください。`);
    process.exit(1);
  }
  try {
    ensureSafeQueueFile(replyPath, '回収済みqueue結果');
    queueImported = JSON.parse(readFileSync(replyPath, 'utf8'));
    queueChecked = loadValidatedQueueResult(request);
    assertQueueImportMatches(queueChecked);
  } catch (error) {
    console.error(`✗ queue結果の厳密照合に失敗しました: ${error.message}`);
    if (/inputHash/u.test(error.message)) {
      console.error(`  新しいRequest-IDで再依頼: AI_REVIEW_MODE=queue ${aiCmd('review-send', '--yes --force-new', { root })}`);
    }
    process.exit(2);
  }
  if (queueChecked.result?.retry === true) {
    console.error('✗ queue作業役が再試行を要求したため、レビュー往復とaccepted状態へは進めません。');
    console.error(`  同じRequest-IDの次attemptを作業役が完了した後、${aiCmd('review-wait', request.requestId, { root })} から再開してください。`);
    process.exit(2);
  }
} else if (stdinMode) {
  inboxOut = stdinInput;
} else {
  try {
    inboxOut = runAgmsgScript('inbox.sh', [lane.team, lane.inbox], { cwd: root });
  } catch (e) {
    console.error(`✗ inbox.sh の実行に失敗しました: ${e.message}`);
    process.exit(2);
  }
}

// --- 3. 既読履歴も読む（inbox.shが既読化した後でも回収できるようにする） ---
// history.shはread_atを打たないので、何度実行しても受信箱の状態を壊さない。
const historyEntries = [];
let historyWarning = '';
let historySaturated = false;
let historyUnparsedCount = 0;
if (queueMode) {
  historyWarning = '';
} else if (noHistory) {
  historyWarning = '--no-history 指定のため既読履歴は読んでいません';
} else if (!IDENTIFIER_PATTERN.test(lane.team) || !IDENTIFIER_PATTERN.test(lane.inbox)) {
  historyWarning = 'team/宛先の文字種が不正なため既読履歴を読みませんでした';
} else {
  try {
    // 1件多く要求する。ちょうど上限件数で「窓の外にもある」と誤警告しないため、
    // 「上限+1件返ってきた=本当に外がある」で飽和を判定する。
    const historyOut = runAgmsgScript('history.sh', [lane.team, lane.inbox, String(historyLimit + 1)], {
      cwd: root,
    });
    // history.shが本文以外に出す既知の通知行。これ以外のparse失敗は取りこぼしなので数える。
    const NOTICES = ['No message history.', 'No messages (DB not initialized)'];
    for (const line of historyOut.split('\n')) {
      const parsed = parseHistoryLine(line);
      if (parsed) {
        historyEntries.push(parsed);
        continue;
      }
      const text = line.trim();
      if (text && !NOTICES.includes(text)) historyUnparsedCount += 1;
    }
    // 窓を使い切っていたら、それより古い返信が窓外にある可能性を必ず表に出す。
    historySaturated = historyEntries.length + historyUnparsedCount > historyLimit;
  } catch (error) {
    historyWarning =
      error?.code === 'ENOBUFS'
        ? `history.sh の出力が読み取り上限を超えました（--history-limit ${historyLimit} を小さくして再実行してください）: ${error.message}`
        : `history.sh の実行に失敗しました: ${error.message}`;
  }
}

// --- 4. 解析・分類 ---
// 未読(inbox/stdin)を先に積み、既読履歴をmergeする。同一messageは (ts, from, body) で重複排除する。
const matched = [];
const ignored = [];
let historyIgnoredCount = 0;
const seenKeys = new Set();

function classify(entry, source) {
  // 区切りは制御文字を明示escapeで書く（生のU+001Fはエディタで不可視になり、
  // 消えると ts/from の境界違いが同一キーへ潰れる）。
  const key = [entry.ts, entry.from, entry.body].join('\u001f');
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  const f = extractMessageFields(entry.body);

  const ok =
    entry.from === request.to &&
    entry.to === lane.inbox &&
    f.team === request.team &&
    f.requestId === request.requestId &&
    f.project === request.project &&
    f.repo === request.repo &&
    f.branch === request.branch &&
    f.task === request.task;

  if (ok) {
    matched.push({ ...entry, fields: f, source });
    return;
  }
  // 既読履歴には自分が送ったmessageも他タスクの往復も混ざるのが正常なので、
  // 無視ログ（本来届くはずの返信を取りこぼした記録）へは入れず件数だけ数える。
  if (source === 'history') historyIgnoredCount += 1;
  else ignored.push({ ...entry, fields: f, source });
}

for (const [index, line] of inboxOut.split('\n').entries()) {
  const parsed = parseInboxLine(line);
  if (!parsed) continue;
  // inbox.shはSQLでto_agentを絞るので宛先は自レーン確定。stdinも同じ経路の出力を前提とする。
  classify({ ...parsed, to: lane.inbox, recencyOrder: index }, stdinMode ? 'stdin' : 'inbox');
}
if (queueMode) {
  classify({
    ts: queueImported.importedAt || new Date().toISOString(),
    from: request.to,
    to: lane.inbox,
    body: queueImported.body.replaceAll('\n', '\\n'),
    recencyOrder: 0,
  }, 'queue');
}
for (const [index, entry] of historyEntries.entries()) {
  // history.shは新しい順なので、先頭ほど大きい値に正規化する。
  classify({ ...entry, recencyOrder: historyEntries.length - index }, 'history');
}

let verdictReadError = '';
let selectedVerdictReply = null;
let unreadableVerdictCount = 0;
const explicitVerdict = !queueMode && ['ok', 'findings'].includes(verdictArg);
const explicitFindings = explicitVerdict && verdictArg === 'findings';
const replyNeedsFindingKinds = usesFunctionalDefectPolicy
  && !explicitFindings
  && (queueMode ? queueChecked.result.verdict === 'findings' : verdictArg === 'auto');
if (
  matched.length > 0
  && ((!queueMode && verdictArg === 'auto') || replyNeedsFindingKinds || (usesFunctionalDefectPolicy && explicitVerdict))
) {
  const parsedVerdicts = matched.map((entry, index) => ({
    parsed: parseReviewReplyVerdict(entry.body.split('\\n').join('\n'), request, {
      overrideVerdict: explicitVerdict ? verdictArg : '',
      // 連番Finding-Kindは native連鎖(deepseek-native-cli-v1)のqueue受領だけが受理する。
      allowNumberedFindingKinds: nativeChainMode,
      requireFindingKinds: replyNeedsFindingKinds,
      requireFinalReport: usesFunctionalDefectPolicy,
    }),
    source: entry.source,
    ts: entry.ts,
    recencyOrder: entry.recencyOrder,
    index,
  }));
  const sourceRecency = { stdin: 3, inbox: 3, history: 2 };
  const newestFirst = (a, b) => {
    const aTime = Date.parse(a.ts);
    const bTime = Date.parse(b.ts);
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
    const sourceDifference = (sourceRecency[b.source] || 0) - (sourceRecency[a.source] || 0);
    if (sourceDifference !== 0) return sourceDifference;
    if (a.recencyOrder !== b.recencyOrder) return b.recencyOrder - a.recencyOrder;
    return b.index - a.index;
  };
  const readable = parsedVerdicts.filter((entry) => entry.parsed.verdict).sort(newestFirst);
  const unreadable = parsedVerdicts.filter((entry) => entry.parsed.error).sort(newestFirst);
  unreadableVerdictCount = unreadable.length;
  if (readable.length === 0) {
    const newestUnreadable = unreadable[0];
    verdictReadError = newestUnreadable
      ? `${safeDiagnostic(newestUnreadable.ts)} (${newestUnreadable.source}): ${newestUnreadable.parsed.error}`
      : '一致返信に Verdict: 行がありません';
  } else {
    [selectedVerdictReply] = readable;
    if (!queueMode && verdictArg === 'auto') {
      paneVerdict = selectedVerdictReply.parsed.verdict;
      paneVerdictSource = 'message_verdict';
    }
  }
}

if (verdictReadError) {
  let holdCaptureFile = '';
  let holdCaptureError = '';
  try {
    ensureSafeDirectory(logDir, { create: true });
    holdCaptureFile = saveVerdictHoldCapture(matched, request, verdictReadError);
  } catch (error) {
    holdCaptureError = error.message;
  }
  console.log('=== ai:review-check ===');
  console.log(`  lane     : ${lane.team}/${lane.from} (reviewer=${lane.to})`);
  console.log(`  Request-ID: ${request.requestId}`);
  console.log(`  一致返信 : ${matched.length} 件`);
  console.log('  verdict-source: unreadable');
  console.log('  保存先   : （合否を読み取れないため更新していません）');
  if (holdCaptureFile) console.log(`  保留証跡 : ${holdCaptureFile}`);
  if (holdCaptureError) console.error(`REVIEW_HOLD_CAPTURE_FAILED: ${holdCaptureError}`);
  console.error(`REVIEW_PROCESS_WARNING: 返信本文から合否を読み取れないため、記録を保留しました: ${verdictReadError}`);
  printVerdictHoldGuidance(request);
  process.exit(VERDICT_HOLD_EXIT_CODE);
}

// --- 5-6. 保存 ---
mkdirSync(contextDir, { recursive: true });
const runAt = new Date().toISOString();
const SOURCE_LABEL = {
  inbox: '未読受信箱',
  stdin: 'wait-reply出力(stdin)',
  history: '既読履歴から回収',
  queue: '永続queueから回収',
};
const recoveredFromHistory = matched.filter((e) => e.source === 'history').length;

if (matched.length > 0) {
  // 改行を復元して読みやすい Markdown にする
  const sections = matched.map((e) => {
    const restored = e.body.split('\\n').join('\n');
    return `## [${e.ts}] from ${e.from}（${SOURCE_LABEL[e.source] || e.source}）\n\n${restored}`;
  });
  const md =
    `# レビュー返信（review-check）\n\n` +
    `- 取得日時: ${runAt}\n` +
    `- Request-ID: ${request.requestId}\n` +
    `- 対象: team=${request.team} / from=${request.to} / project=${request.project}` +
    ` / repo=${request.repo} / branch=${request.branch} / task=${request.task}` +
    `\n- 一致件数: ${matched.length}（うち既読履歴から回収: ${recoveredFromHistory}）\n` +
    `- 合否の決定元: ${queueMode ? 'queue_result' : paneVerdictSource}\n` +
    (selectedVerdictReply
      ? `- 合否採用返信: ${selectedVerdictReply.ts}（${SOURCE_LABEL[selectedVerdictReply.source] || selectedVerdictReply.source}）\n` +
        `- 合否を読めず除外した一致返信: ${unreadableVerdictCount}件\n`
      : '') +
    (recoverMode
      ? `- 回収モード: --recover（現current-task.jsonとの差分は下記。message照合条件は通常時と同一）\n` +
        taskDrift.map((line) => `  - ${line}\n`).join('')
      : '') +
    `\n---\n\n` +
    sections.join('\n\n---\n\n') +
    '\n';
  writeFileSync(resultFile, md, 'utf8');
  const restoredBodies = matched.map((entry) => entry.body.split('\\n').join('\n')).join('\n');
  const autoVerdictHint = inferReviewVerdictHint(restoredBodies);
  const paneRuntimeEvidence = queueMode ? null : reviewerRuntimeEvidence(root, request.requestId);
  const roundOptions = {
    verdict: queueMode ? queueChecked.result.verdict : paneVerdict,
    verdictWasExplicit: queueMode || ['ok', 'findings'].includes(verdictArg),
    verdictSource: queueMode ? 'queue_result' : paneVerdictSource,
    note,
    autoVerdictHint,
    acceptedAt: runAt,
    mode: queueMode ? 'queue' : 'pane',
    workerDurationMs: queueMode ? queueChecked.result.workerDurationMs : null,
    attempt: queueMode ? queueChecked.result.attempt : null,
    failureReason: queueMode ? queueChecked.result.failureReason : '',
    // 2026-09-23: pane経路は cc-send.sh --start-reviewer が記録した実起動の明示IDを写す
    // (無い旧記録では従来どおり空)。queue経路の受理判定は変えない。
    actualReviewer: queueMode
      ? String(request[RUNTIME_EVIDENCE_MARKER_KEY] === 1 ? queueChecked.result.actualRuntimeModel : queueChecked.result.model || '')
      : paneRuntimeEvidence.model,
    actualRuntimeModel: queueMode
      ? String(queueChecked.result.actualRuntimeModel || '')
      : paneRuntimeEvidence.model,
    actualRuntimeModelSource: queueMode
      ? String(queueChecked.result.actualRuntimeModelSource || '')
      : paneRuntimeEvidence.source,
    actualRuntimeModelEvidencePath: queueMode
      ? String(queueChecked.result.actualRuntimeModelEvidencePath || '')
      : paneRuntimeEvidence.evidencePath,
    actualRuntimeModelEvidenceSha256: queueMode
      ? String(queueChecked.result.actualRuntimeModelEvidenceSha256 || '')
      : paneRuntimeEvidence.evidenceSha256,
    actualRuntimeModelPaneId: queueMode ? '' : paneRuntimeEvidence.paneId,
    actualRuntimeModelSessionIdentity: queueMode ? null : paneRuntimeEvidence.sessionIdentity,
    replyExecutionKind: request[RUNTIME_EVIDENCE_MARKER_KEY] === 1 ? (queueMode ? 'queue' : 'pane') : '',
    inputHash: queueMode ? String(queueChecked.result.inputHash || '') : '',
    leaseGeneration: queueMode && Number.isInteger(queueChecked.result.leaseGeneration) ? queueChecked.result.leaseGeneration : null,
    ownerToken: queueMode ? String(queueChecked.result.ownerToken || '') : '',
    fallbackFrom: queueMode ? String(queueChecked.result.fallbackFrom || '') : '',
    findingSummary: restoredBodies,
    findingKinds: selectedVerdictReply?.parsed.findingKinds || [],
    functionalDefectCount: selectedVerdictReply?.parsed.functionalDefectCount ?? null,
    remainingDefects: selectedVerdictReply?.parsed.remainingDefects || '',
    unverified: selectedVerdictReply?.parsed.unverified || [],
    verificationSummary: selectedVerdictReply?.parsed.verificationSummary || '',
  };
  let acceptedRoundRecorded = false;
  let verifiedNativePrimary = null;
  let focusedResolution = null;
  if (queueMode) {
    try {
      // 結果の再検証からaccepted確定まで、作業役と同じclaim lockと世代を保持する。
      queueChecked = withQueueAcceptanceClaim(request, (lockedChecked) => {
        validateQueueWorktreeSnapshot(root, request);
        assertQueueImportMatches(lockedChecked);
        assertNativeQueueResult(lockedChecked);
        if (nativeChainMode) {
          // 実証跡の再検証もclaim保持中に行い、accepted確定前に失敗させる。
          verifiedNativePrimary = verifyNativePrimaryReceipt(root, task, request, {
            receiptPath: nativePrimaryEvidencePath,
            sessionRoot: nativeTrustedSessionRoot,
          });
          // CMGB native focused だけ、依頼の固定target一覧を実sessionで再検証し、DS実turnの
          // recheckDecisions と Opus本文の Recheck-Decision 行を突合してresolutionを組み立てる。
          const focusedPins = nativeFocusedTargetsForRequest(request);
          if (focusedPins) {
            const role = String(optionalReviewEvidence.NATIVE_REVIEWER_ROLES?.[0] || '');
            if (!role) throw new Error('CMGB_FOCUSED_ROLE_MISSING: レビュー役のrole定義がありません');
            const focusedEvidence = optionalReviewEvidence.nativeSessionEvidence(root, nativePrimaryEvidencePath, {
              task,
              round: request.round,
              lens: request.lens,
              role,
              sessionRoot: nativeTrustedSessionRoot,
              current: true,
              expectedScopeHash: String(request.nativeReview.scopeHash),
              scopeFile: join(root, String(request.nativeScopeFile).replaceAll('\\', '/')),
              reviewedManifestPaths: request.nativeReview.reviewedPaths.slice(),
              ignoredPathspecs: request.nativeReview.ignoredPathspecs.slice(),
              expectedRequestId: String(request.requestId),
              expectedInputHash: String(request.inputHash),
              expectedFocusedTargetsHash: focusedPins.hash,
              expectedFocusedTargets: focusedPins.targets,
            });
            verifiedNativePrimary = {...verifiedNativePrimary, recheckDecisions: focusedEvidence.recheckDecisions};
            focusedResolution = buildCmgbFocusedRecheckResolution({
              request,
              task,
              checked: lockedChecked,
              verified: verifiedNativePrimary,
            });
          }
        }
      });
    } catch (error) {
      console.error(`✗ queue結果をacceptedとして確定できません: ${error.message}`);
      process.exit(2);
    }
  }

  try {
    withReviewRequestLock(root, () => {
      ensureSafeQueueFile(requestStateFile, 'review-request.json');
      const current = JSON.parse(readFileSync(requestStateFile, 'utf8'));
      if (current.requestId !== request.requestId || current.status !== 'sent' ||
          current.round !== request.round || current.contentHash !== request.contentHash ||
          current.reviewHeadCommit !== request.reviewHeadCommit) {
        throw new Error('review-request.jsonの現状態が受領対象と一致しません');
      }
      if ((current[RUNTIME_EVIDENCE_MARKER_KEY] === 1) !== (request[RUNTIME_EVIDENCE_MARKER_KEY] === 1)) {
        throw new Error('review-request.jsonのruntimeEvidenceSchemaVersionが受領対象と一致しません');
      }
      if (queueMode) {
        recordCodeReviewRound(root, task, request, {
          ...roundOptions,
          verdict: queueChecked.result.verdict,
          workerDurationMs: queueChecked.result.workerDurationMs,
          attempt: queueChecked.result.attempt,
          failureReason: queueChecked.result.failureReason,
          actualReviewer: String(request[RUNTIME_EVIDENCE_MARKER_KEY] === 1 ? queueChecked.result.actualRuntimeModel : queueChecked.result.model || ''),
          actualRuntimeModel: String(queueChecked.result.actualRuntimeModel || ''),
          actualRuntimeModelSource: String(queueChecked.result.actualRuntimeModelSource || ''),
          actualRuntimeModelEvidencePath: String(queueChecked.result.actualRuntimeModelEvidencePath || ''),
          actualRuntimeModelEvidenceSha256: String(queueChecked.result.actualRuntimeModelEvidenceSha256 || ''),
          actualRuntimeModelPaneId: '',
          actualRuntimeModelSessionIdentity: null,
          replyExecutionKind: request[RUNTIME_EVIDENCE_MARKER_KEY] === 1 ? 'queue' : '',
          inputHash: String(queueChecked.result.inputHash || ''),
          leaseGeneration: Number.isInteger(queueChecked.result.leaseGeneration) ? queueChecked.result.leaseGeneration : null,
          ownerToken: String(queueChecked.result.ownerToken || ''),
          fallbackFrom: String(queueChecked.result.fallbackFrom || ''),
          deferParentNotification: true,
          ...(nativeChainMode
            ? {
                nativePrimaryEvidence: nativePrimaryEvidencePath,
                nativeSessionRoot: nativeTrustedSessionRoot,
                verifiedNativePrimary,
                ...(focusedResolution ? {recheckResolution: focusedResolution} : {}),
              }
            : {}),
        });
      } else {
        recordCodeReviewRound(root, task, request, { ...roundOptions, deferParentNotification: true });
      }
      acceptedRoundRecorded = true;
      atomicWriteJson(requestStateFile, { ...current, status: 'accepted', acceptedAt: runAt });
    });
    const retry = retryReviewEscalationNotification(root, task);
    if (retry.state.codeReview.parentEscalation?.notification?.status === 'failed') {
      console.error(`REVIEW_PROCESS_WARNING: 親へのレビュー指摘通知を送れませんでした: ${retry.state.codeReview.parentEscalation.notification.error}`);
    }
  } catch (error) {
    if (acceptedRoundRecorded) {
      console.error('REVIEW_PROCESS_WARNING: review-rounds.jsonへの記録は完了しましたが、review-request.jsonのaccepted更新に失敗しました。残存状態を確認してください。');
    }
    console.error(`✗ review-request.jsonをacceptedとして確定できません: ${error.message}`);
    process.exit(2);
  }
}

if (queueMode && matched.length > 0) {
  console.log(`REVIEW_QUEUE_ACCEPTED Request-ID=${request.requestId}`);
  console.log('state=accepted');
  console.log(`saved=${resultFile}`);
  console.log(`findings=${queueChecked.result.verdict === 'findings' ? 'yes' : 'no'}`);
  console.log('verdict-source=queue_result');
  console.log(`retry=${queueChecked.result.retry === true ? 'yes' : 'no'}`);
  process.exit(0);
}

// 一致返信は無視ログより重要。ログ追記が安全性検査で失敗しても先に永続化する。
if (ignored.length > 0) {
  const lines = ignored.map(
    (e) => `[${runAt}] from=${e.from} ts=${e.ts} | ${e.body}`
  );
  try {
    ensureSafeDirectory(logDir, { create: true });
    appendSecureLog(ignoredLog, `# run ${runAt}\n${lines.join('\n')}\n`);
  } catch (error) {
    console.error(`✗ 無視ログを安全に追記できません: ${error.message}`);
    process.exit(2);
  }
  console.error('⚠ 照合不一致の返信を無視しました（先頭3件・from 120文字/body 240文字まで）:');
  for (const entry of ignored.slice(0, 3)) {
    const safeFrom = entry.from.replace(/[\u0000-\u001F\u007F]/g, '?').slice(0, 120);
    const safeBody = entry.body.replace(/[\u0000-\u001F\u007F]/g, '?').slice(0, 240);
    console.error(`  - from=${safeFrom} ${safeBody}`);
  }
}

// --- 7. 表示（件数・保存先のみ） ---
console.log('=== ai:review-check ===');
console.log(`  lane     : ${lane.team}/${lane.from} (reviewer=${lane.to})`);
console.log(`  Request-ID: ${request.requestId}`);
console.log(`  対象     : project=${request.project} repo=${request.repo} branch=${request.branch} task=${request.task}`);
console.log(`  一致返信 : ${matched.length} 件（うち既読履歴から回収: ${recoveredFromHistory} 件）`);
console.log(`  無視返信 : ${ignored.length} 件（既読履歴の対象外message ${historyIgnoredCount} 件は無視ログに入れていません）`);
if (stdinCaptureFile) console.log(`  raw保存  : ${stdinCaptureFile}`);
if (recoverMode) {
  console.log('  回収モード: --recover（現current-task.jsonとのProject/Repo/Branch/Task差分を免除）');
  for (const line of taskDrift) console.log(`      ${line}`);
  if (taskDrift.length === 0) console.log('      差分なし（通常実行と同じ照合で回収しました）');
}
if (historyWarning) {
  console.log(`REVIEW_PROCESS_WARNING: ${historyWarning}`);
}
if (historySaturated) {
  console.log(
    `REVIEW_PROCESS_WARNING: 既読履歴を上限 ${historyLimit} 件まで読み切りました。` +
      'これより古い返信は窓の外です。--history-limit で広げて再実行してください。',
  );
}
if (historyUnparsedCount > 0) {
  console.log(
    `REVIEW_PROCESS_WARNING: 既読履歴の ${historyUnparsedCount} 行を解釈できず照合対象から外しました。` +
      'history.shの出力形式が変わった可能性があります（返信を取りこぼしている恐れがあります）。',
  );
}

if (matched.length > 0) {
  console.log(`  保存先   : ${resultFile}`);
  console.log(`  verdict  : ${paneVerdict}${verdictArg === 'auto' ? '（--verdict autoで本文から読取）' : '（--verdictで明示）'}`);
  console.log(`  verdict-source: ${paneVerdictSource}`);
  if (selectedVerdictReply) {
    console.log(`  verdict-reply: ${selectedVerdictReply.ts} (${selectedVerdictReply.source})`);
    console.log(`  verdict-unreadable-ignored: ${unreadableVerdictCount}`);
  }
  const restoredBodies = matched.map((entry) => entry.body.split('\\n').join('\n')).join('\n');
  const autoVerdictHint = inferReviewVerdictHint(restoredBodies);
  console.log(`  参考判定 : ${autoVerdictHint}（確定には使用しません）`);
  if (recoveredFromHistory > 0) {
    console.log(
      '  補足     : 未読が既に消費されていたため既読履歴から回収しました' +
        '（wait-reply.sh は受信時にinbox.shで既読化します。単体で待つ時は --peek を付けてください）。',
    );
  }
} else {
  console.log(`  保存先   : （一致なしのため review-result.md は更新していません）`);
}
if (ignored.length > 0) {
  console.log(`  無視ログ : ${ignoredLog}`);
}
if (matched.length === 0) {
  console.error('✗ 一致返信は0件です。レビュー完了にはしていません。');
  console.error(`  後で ${aiCmd('review-check', '--verdict auto', { root })} を再実行してください。再依頼が必要なら --force-new または ai:review-reset を使ってください。`);
  process.exit(2);
}
