/**
 * agmsg Manager - review-flow（サイズ別コードレビュー → ブラウザレビュー最大3往復）
 *
 * 自動修正、長時間poll、commit、pushは行わない。各レビュー結果は
 * 明示されたverdict、または返信本文のVerdict行で確定する。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { aiCmd } from './ai-workflow-lib.mjs';
import { readJson } from './ai-e2e-lib.mjs';
import {
  MAX_REVIEW_ROUNDS,
  MAX_VISUAL_QC_ATTEMPTS,
  branchFreshness,
  browserReviewApplicable,
  codeReviewClosed,
  codeReviewMaxRounds,
  deepseekReviewChainEligible,
  inferReviewVerdictHint,
  loadReviewRequest,
  loadReviewRounds,
  markBrowserNotApplicable,
  markBrowserPreflight,
  retryReviewEscalationNotification,
  recordBrowserReviewRound,
  recordCodeReviewRound,
  recordVisualQcAttempt,
  visualQcClosed,
  webAppTraceWarning,
} from './ai-review-rounds-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const contextDir = join(root, '.ai', 'context');
const taskFile = join(root, '.ai', 'current-task.json');
const resultFile = join(contextDir, 'review-result.md');
const args = process.argv.slice(2);
const apply = args.includes('--yes');
const reviewMode = String(process.env.AI_REVIEW_MODE || 'pane').trim();
const VISUAL_QC_TIMEOUT_MS = 210_000;
const VISUAL_QC_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || '') : '';
}

const verdict = option('--verdict');
const note = option('--note');
const browserUrl = option('--browser-url');
const browserVerdict = option('--browser-verdict');
const browserEvidence = option('--browser-evidence');
const visualQcFixComplete = args.includes('--visual-qc-fix-complete');
const visualQcRecheck = args.includes('--visual-qc-recheck');
const valueOptions = new Set(['--verdict', '--note', '--browser-url', '--browser-verdict', '--browser-evidence']);
const knownFlags = new Set(['--yes', '--visual-qc-fix-complete', '--visual-qc-recheck']);
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
if (unknownArgs.length) {
  console.error(`✗ 不明または値が無いoptionです: ${unknownArgs.join(' ')}`);
  process.exit(2);
}
if (!['pane', 'queue'].includes(reviewMode)) {
  console.error('✗ AI_REVIEW_MODE は pane または queue を指定してください。');
  process.exit(2);
}
if (verdict && !['ok', 'findings', 'auto'].includes(verdict)) {
  console.error('✗ --verdict は ok、findings、auto のいずれかを指定してください。');
  process.exit(2);
}
if (browserVerdict && !['ok', 'error'].includes(browserVerdict)) {
  console.error('✗ --browser-verdict は ok または error を指定してください。');
  process.exit(2);
}
if (browserVerdict && !browserEvidence) {
  console.error('✗ --browser-verdict には --browser-evidence <repo内path> が必要です。');
  process.exit(2);
}

function run(script, scriptArgs = []) {
  const result = spawnSync('node', [join(__dirname, script), ...scriptArgs], { cwd: root, stdio: 'inherit' });
  return result.status ?? 1;
}

function runCaptured(script, scriptArgs = []) {
  const result = spawnSync('node', [join(__dirname, script), ...scriptArgs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: VISUAL_QC_MAX_BUFFER_BYTES,
    timeout: script === 'visual-qc-check.mjs' ? VISUAL_QC_TIMEOUT_MS : undefined,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function hr(title) {
  console.log('');
  console.log(`==================== ${title} ====================`);
}

function printVerdictHoldGuidance() {
  console.error(`  本文を確認して合否を確定: ${aiCmd('review-flow', '--yes --verdict ok|findings', { root })}`);
  console.error('  または reviewer に「Verdict: ok」か「Verdict: findings」を付けて返信し直してもらってください。');
}

function loadTask() {
  try {
    return JSON.parse(readFileSync(taskFile, 'utf8'));
  } catch (error) {
    console.error(`✗ .ai/current-task.json の読み込みに失敗しました: ${error.message}`);
    process.exit(2);
  }
}

function readRequest(task) {
  try {
    const loaded = loadReviewRequest(root, task);
    if (loaded.staleDiscarded) {
      console.log(
        'REVIEW_PROCESS_WARNING: 前タスク（または旧形式）のreview-request.jsonを履歴へ退避しました。新しい依頼を作ります',
      );
    }
    return loaded.request;
  } catch (error) {
    console.error(`✗ review-request.json の読み込みに失敗しました: ${error.message}`);
    process.exit(2);
  }
}

function requestRecordedInState(state, requestId) {
  if (!requestId) return false;
  return Boolean(
    state?.codeReview?.rounds?.some((round) => round.requestId === requestId)
    || state?.codeReview?.focusedRecheck?.result?.requestId === requestId
  );
}

function reviewStepLabel(state) {
  const focusedRecheckPending = state?.codeReview?.focusedRecheck?.status === 'pending';
  const round = focusedRecheckPending
    ? codeReviewMaxRounds(state)
    : state.codeReview.rounds.length + 1;
  return `round ${round}${focusedRecheckPending ? ' 限定再確認' : ''}`;
}

function autoVerdictHint() {
  if (!existsSync(resultFile)) return 'findings';
  return inferReviewVerdictHint(readFileSync(resultFile, 'utf8'));
}

function reviewResultText() {
  return existsSync(resultFile) ? readFileSync(resultFile, 'utf8') : '';
}

function showState(state) {
  const size = state.codeReview.sizeClass || state.codeReview.sizingStatus || 'legacy';
  const maxRounds = codeReviewMaxRounds(state);
  console.log(`  code review   : ${state.codeReview.rounds.length}/${maxRounds ?? '未確定'} (${state.codeReview.outcome}, ${size})`);
  console.log(
    `  visual QC     : ${state.visualQc.attempts.length}/${MAX_VISUAL_QC_ATTEMPTS} ` +
      `(事前警告${state.visualQc.preliminaryChecks.length}回, ${state.visualQc.outcome})`,
  );
  console.log(`  browser review: ${state.browserReview.rounds.length}/${MAX_REVIEW_ROUNDS} (${state.browserReview.outcome})`);
}

// 外部レビュー(deepseek-opus-v1)経路では、コードレビュー3往復は review-rounds.json ではなく
// .ai/external-reviews/index.json に記録される。ブラウザ段階の開始ゲートが codeReviewClosed(state)
// だけを見ると、外部経路の web_ui レーンがブラウザ往復・visual QC へ進めない(2026-10-02 R2 U4)。
// 開始を許すのは、完了ゲートの externalReviewSummary が実際に受理するレーンだけにする。
// index があるだけで開くと、externalReviewSummary が拒否するレーン(実装者が DeepSeek Flash high
// でない・native 宣言)がブラウザ段階へ進み、完了時は集計が throw して「unavailable」のまま
// 記録される(2026-10-02 R3 E3-1)。判定は rounds-lib の deepseekReviewChainEligible に一本化し、
// externalReviewSurfaceAccepted の web_ui 条件と同じにする。non_web はこの関数の対象外。
function externalCodeReviewStarted(task) {
  if (!browserReviewApplicable(task)) return false;
  if (!deepseekReviewChainEligible(task)) return false;
  const indexFile = join(root, '.ai', 'external-reviews', 'index.json');
  if (!existsSync(indexFile)) return false;
  try {
    const index = readJson(indexFile);
    return index?.taskId === task?.taskId && index?.taskFingerprint === task?.taskFingerprint;
  } catch {
    return false;
  }
}

function runBrowserStage(task, state) {
  if (!codeReviewClosed(state) && !externalCodeReviewStarted(task)) return false;
  let visualQcRan = false;

  if (!browserReviewApplicable(task)) {
    if (state.browserReview.outcome !== 'not_applicable') state = markBrowserNotApplicable(root, task);
    console.log('✓ surfaceKindがweb_uiではないため、ブラウザレビューは not_applicable です。');
    const traceWarning = webAppTraceWarning(root, task);
    if (traceWarning) console.log(`REVIEW_PROCESS_WARNING: ${traceWarning}`);
    showState(state);
    return true;
  }

  if (['passed_clean', 'passed_max_rounds'].includes(state.browserReview.outcome)) {
    console.log(`✓ ブラウザレビュー段階は終了済みです（${state.browserReview.outcome}）。`);
    showState(state);
    return true;
  }

  if (visualQcFixComplete && state.visualQc.outcome !== 'repair_required') {
    console.error('✗ --visual-qc-fix-complete は初回visual QCで指摘が出た後だけ指定できます。');
    process.exit(2);
  }

  if (visualQcRecheck) {
    if (!['skipped_warning', 'unavailable_warning'].includes(state.visualQc.outcome)) {
      console.error('✗ --visual-qc-recheck は未検査または実行不能の警告後だけ指定できます。');
      process.exit(2);
    }
    if (state.browserReview.rounds.length > 0 || ['passed_clean', 'passed_max_rounds'].includes(state.browserReview.outcome)) {
      console.error('✗ ブラウザレビュー開始後はvisual QCを再検査できません。');
      process.exit(2);
    }
    if (browserVerdict) {
      console.error('✗ --visual-qc-recheck と --browser-verdict は同時に指定できません。');
      process.exit(2);
    }
  }

  if (browserVerdict && !visualQcClosed(state)) {
    console.error('✗ --browser-verdict はvisual QC完了後に指定してください。先に --browser-url だけでvisual QCを実行します。');
    process.exit(2);
  }

  if (!visualQcClosed(state) || visualQcRecheck) {
    if (!browserUrl) {
      console.log('コードレビューは終了しました。visual QCとブラウザ可否を判定するには次を実行してください:');
      const retryFlag = visualQcFixComplete
        ? ' --visual-qc-fix-complete'
        : visualQcRecheck
          ? ' --visual-qc-recheck'
          : '';
      console.log(`  ${aiCmd('review-flow', `--browser-url <URL>${retryFlag}`, { root })}`);
      showState(state);
      return true;
    }
    if (state.visualQc.outcome === 'repair_required' && !visualQcFixComplete) {
      console.log('VISUAL_QC_REPAIR_REQUIRED: 指摘を1周だけ自己修正し、完了を明示して再検査してください:');
      console.log(`  ${aiCmd('review-flow', `--browser-url ${browserUrl} --visual-qc-fix-complete`, { root })}`);
      showState(state);
      return true;
    }
    const attemptNumber = state.visualQc.attempts.length + 1;
    const runNumber = state.visualQc.preliminaryChecks.length + state.visualQc.attempts.length + 1;
    hr(`visual QC（run ${runNumber} / quality attempt ${attemptNumber}/${MAX_VISUAL_QC_ATTEMPTS}）`);
    const report = join(root, '.ai', 'e2e', `${task.taskId}-visual-qc-run${runNumber}.json`);
    const check = runCaptured('visual-qc-check.mjs', ['--url', browserUrl, '--output', report]);
    visualQcRan = true;
    let body = null;
    try {
      body = readJson(report);
    } catch {
      // 起動自体に失敗した場合はreport無しのunavailableとして状態へ残す。
    }
    let status = 'unavailable';
    let reason = '';
    let findingCount = 0;
    let recordedReport = '';
    if (check.status === 0 && ['clean', 'skipped'].includes(body?.status)) {
      status = body.status;
      findingCount = Number(body.findingCount || 0);
      recordedReport = report;
      reason = body.warnings?.join('; ') || '';
    } else if (check.status === 1 && body?.status === 'findings') {
      status = 'findings';
      findingCount = Number(body.findingCount || 0);
      recordedReport = report;
      reason = body.warnings?.join('; ') || '';
    } else if (check.status === 2 && body?.status === 'unavailable') {
      status = 'unavailable';
      findingCount = Number(body.findingCount || 0);
      recordedReport = report;
      reason = body.warnings?.join('; ') || 'visual QCを実行できませんでした';
    } else {
      reason = check.error?.code === 'ETIMEDOUT'
        ? `visual-qc-checkが${VISUAL_QC_TIMEOUT_MS}msの上限を超えました`
        : `visual-qc-checkの出力契約が不正です（status=${check.status ?? 'spawn-error'}, report=${body?.status || 'missing'}）`;
    }
    try {
      state = recordVisualQcAttempt(root, task, {
        status,
        report: recordedReport,
        findingCount,
        url: browserUrl,
        reason,
        repairCompleted: visualQcFixComplete,
        warningRetry: visualQcRecheck,
      }).state;
    } catch (error) {
      console.error(`✗ visual QC結果を記録できません: ${error.message}`);
      process.exit(2);
    }
    if (state.visualQc.outcome === 'repair_required') {
      console.log('VISUAL_QC_REPAIR_REQUIRED: 指摘を1周だけ自己修正し、完了を明示して再検査してください:');
      console.log(`  ${aiCmd('review-flow', `--browser-url ${browserUrl} --visual-qc-fix-complete`, { root })}`);
      showState(state);
      return true;
    }
    if (state.visualQc.outcome === 'passed_clean') {
      console.log('✓ visual QCは指摘なしで完了しました。');
    } else {
      console.log(`REVIEW_PROCESS_WARNING: visual QCは警告付きで終了しました: ${state.visualQc.closedReason}`);
      if (['skipped_warning', 'unavailable_warning'].includes(state.visualQc.outcome)) {
        console.log('  原因を直した後はブラウザレビュー開始前に明示再検査できます:');
        console.log(`  ${aiCmd('review-flow', `--browser-url ${browserUrl} --visual-qc-recheck`, { root })}`);
      }
    }
  }

  if (state.browserReview.outcome === 'skipped_blocked' && !visualQcRan) {
    console.log('✓ ブラウザレビュー段階は実行不能の警告付きで終了済みです。');
    showState(state);
    return true;
  }

  if (state.browserReview.preflight !== 'passed') {
    if (!browserUrl) {
      console.log('コードレビューは終了しました。ブラウザ可否を判定するには次を実行してください:');
      console.log(`  ${aiCmd('review-flow', '--browser-url <URL>', { root })}`);
      showState(state);
      return true;
    }
    hr('browser preflight（既存 ai:e2e 経路）');
    const evidence = join(root, '.ai', 'e2e', `${task.taskId}-browser-preflight.json`);
    const preflight = runCaptured('ai-e2e.mjs', ['preflight', '--url', browserUrl, '--output', evidence]);
    if (preflight.status === 3) {
      let reason = 'ブラウザpreflightがblocked';
      try {
        reason = readJson(evidence).blocker?.reason || reason;
      } catch {
        // ai:e2eのstderrを正本にし、状態には一般理由を残す。
      }
      state = markBrowserPreflight(root, task, { status: 'blocked', evidence, reason, url: browserUrl });
      console.log(`REVIEW_PROCESS_WARNING: ${reason}`);
      showState(state);
      return true;
    }
    if (preflight.status !== 0) {
      console.error('✗ ブラウザpreflightの実行に失敗しました。');
      process.exit(2);
    }
    state = markBrowserPreflight(root, task, { status: 'passed', evidence, url: browserUrl });
  }

  if (browserVerdict) {
    try {
      state = recordBrowserReviewRound(root, task, {
        verdict: browserVerdict,
        evidence: browserEvidence,
        note,
      }).state;
    } catch (error) {
      console.error(`✗ ブラウザレビュー往復を記録できません: ${error.message}`);
      process.exit(2);
    }
    console.log(`✓ ブラウザレビュー round ${state.browserReview.rounds.length} を ${browserVerdict} で記録しました。`);
  } else {
    console.log('✓ ブラウザpreflightに成功しました。実ブラウザ確認後に明示verdictと証跡を記録してください:');
    const nextRound = state.browserReview.rounds.length + 1;
    const roundEvidence = `.ai/e2e/${task.taskId}-browser-round${nextRound}.json`;
    console.log(`  証跡作成: ${aiCmd('e2e', `record --input <raw.json> --output ${roundEvidence}`, { root })}`);
    console.log(`  結果記録: ${aiCmd('review-flow', `--browser-verdict ok|error --browser-evidence ${roundEvidence} --note "結果"`, { root })}`);
  }
  showState(state);
  return true;
}

console.log('=== ai:review-flow ===');
console.log(`  mode : ${apply ? 'SEND/CHECK (--yes)' : 'dry-run（送信しません）'}`);
const freshness = branchFreshness(root, { phase: 'review' });
if (freshness.isFresh === false && freshness.warning) {
  console.log(`BRANCH_FRESHNESS_WARNING: ${freshness.warning}`);
}

const task = loadTask();
const initialRequest = readRequest(task);
const savedModeMismatch = Boolean(initialRequest?.mode && initialRequest.mode !== reviewMode);
const savedModeWasReset = initialRequest?.status === 'reset';
if (savedModeMismatch && reviewMode !== 'queue' && initialRequest?.status !== 'accepted' && !savedModeWasReset) {
  console.error(`✗ 保存済みのレビュー方式は${initialRequest.mode}ですが、現在のAI_REVIEW_MODEは${reviewMode}です。`);
  console.error(`  AI_REVIEW_MODE=${initialRequest.mode} に合わせて再実行するか、ai:review-reset -- --yes で状態を解除してください。`);
  process.exit(2);
}
if (reviewMode === 'pane') {
  hr('1. ai:msg-status');
  const statusCode = run('ai-msg-status.mjs');
  if (statusCode !== 0) {
    console.error('✗ ai:msg-status が一致しませんでした。review-flow を中止します。');
    process.exit(1);
  }
} else {
  hr('1. queue識別情報');
  console.log('  queue方式はcurrent-task.jsonの識別情報を使い、対話用agmsg登録を点検しません。');
}

let loaded;
try {
  loaded = loadReviewRounds(root, task);
} catch (error) {
  console.error(`✗ review-rounds.json を準備できません: ${error.message}`);
  process.exit(2);
}
let state = loaded.state;
if (savedModeMismatch && reviewMode !== 'queue') {
  if (!savedModeWasReset && !requestRecordedInState(state, initialRequest?.requestId)) {
    console.error(`✗ 保存済みのレビュー方式は${initialRequest.mode}ですが、現在のAI_REVIEW_MODEは${reviewMode}です。`);
    console.error(`  AI_REVIEW_MODE=${initialRequest.mode} に合わせて再実行するか、ai:review-reset -- --yes で状態を解除してください。`);
    process.exit(2);
  }
  console.log(savedModeWasReset
    ? `REVIEW_MODE_TRANSITION: ${initialRequest.mode}の依頼はreset済みのため、${reviewMode}で新しい依頼へ進みます。`
    : `REVIEW_MODE_TRANSITION: ${initialRequest.mode}で受領済みのroundを確認したため、${reviewMode}で次のroundへ進みます。`);
}
if (apply) {
  const retriedEscalation = retryReviewEscalationNotification(root, task);
  state = retriedEscalation.state;
  if (retriedEscalation.attempted && !retriedEscalation.sent) {
    console.log(`REVIEW_PROCESS_WARNING: 親へのレビュー指摘通知を送れませんでした: ${retriedEscalation.error}`);
  }
} else if (
  state.codeReview.parentEscalation
  && state.codeReview.parentEscalation.notification?.status !== 'sent'
) {
  console.log('REVIEW_PROCESS_WARNING: 親へのレビュー指摘通知が未送信です。--yesで再送します。');
}
if (loaded.staleReset) console.log('  前タスクのreview-rounds.jsonを検出したため、現taskIdで初期化しました。');
showState(state);

if (reviewMode === 'queue' && !codeReviewClosed(state)) {
  // queue第1段のflowは送受信せず個別コマンドを案内するだけなので、paneの
  // 保存状態が残っていても誤ったqueue待機へ誘導せず、新規登録を案内する。
  const queuedRequest = savedModeMismatch ? null : initialRequest;
  console.log('REVIEW_QUEUE_FLOW_GUIDANCE: 第1段ではreview-flowから待機せず、次の個別コマンドで進めます。');
  if (verdict) console.log('  queue方式の判定はresult.jsonの機械値を使うため、--verdictは使用しません。');
  if (queuedRequest && ['sent', 'send-attempted'].includes(queuedRequest.status)) {
    console.log(`  1. ${aiCmd('review-wait', queuedRequest.requestId, { root })}`);
    console.log(`  2. ${aiCmd('review-check', '', { root })}`);
  } else {
    const sendFlags = savedModeMismatch || queuedRequest?.status === 'accepted' || state.codeReview.rounds.length > 0
      ? '--yes --force-new'
      : '--yes';
    console.log(`  1. AI_REVIEW_MODE=queue ${aiCmd('review-send', sendFlags, { root })}`);
    console.log('  2. 登録時に表示されたRequest-IDで ' + aiCmd('review-wait', '<Request-ID>', { root }));
    console.log(`  3. ${aiCmd('review-check', '', { root })}`);
  }
  process.exit(0);
}

let request = initialRequest;
if (request?.status === 'accepted' && !requestRecordedInState(state, request.requestId)) {
  if (!['ok', 'findings'].includes(verdict)) {
    console.error('✗ 受領済みの旧返信を往復状態へ復元するには --verdict ok|findings が必要です。');
    console.error('  本文を読み取れないまま findings として記録はしません。');
    process.exit(2);
  }
  try {
    state = recordCodeReviewRound(root, task, request, {
      verdict,
      verdictWasExplicit: true,
      verdictSource: 'explicit',
      note,
      autoVerdictHint: autoVerdictHint(),
      findingSummary: reviewResultText(),
      acceptedAt: request.acceptedAt || new Date().toISOString(),
    }).state;
    console.log(`  accepted済みRequest-IDをround ${state.codeReview.rounds.length}へ復元しました。`);
  } catch (error) {
    console.error(`✗ accepted済みrequestを往復状態へ反映できません: ${error.message}`);
    process.exit(2);
  }
}

if (runBrowserStage(task, state)) process.exit(0);

const currentCodeReviewMaxRounds = codeReviewMaxRounds(state);
const focusedRecheckPending = state.codeReview.focusedRecheck?.status === 'pending';
if (
  (
    Number.isInteger(currentCodeReviewMaxRounds)
    && state.codeReview.rounds.length >= currentCodeReviewMaxRounds
    && !focusedRecheckPending
  )
  || codeReviewClosed(state)
) {
  console.log('✓ コードレビューは終了済みです。次はブラウザレビューへ進みます。');
  process.exit(0);
}

request = readRequest(task);
if (request && ['sent', 'send-attempted'].includes(request.status)) {
  if (!apply) {
    console.log(`  ${reviewStepLabel(state)} は返信待ちです。送信せず終了します。`);
    console.log(`  取得: ${aiCmd('review-check', `--verdict ${verdict || 'auto'}`, { root })}`);
    process.exit(0);
  }
  hr(`2. ai:review-check（${reviewStepLabel(state)}）`);
  const checkArgs = ['--verdict', verdict || 'auto'];
  if (note) checkArgs.push('--note', note);
  const checkCode = run('ai-review-check.mjs', checkArgs);
  if (checkCode !== 0) {
    if (checkCode === 4) {
      console.error('✗ レビュー返信は届きましたが合否を読み取れないため、本文を保全して記録を保留しました。');
      printVerdictHoldGuidance();
    } else {
      console.error('✗ レビュー返信を取得できませんでした。依頼は再送していません。');
    }
    process.exit(checkCode === 1 ? 1 : checkCode === 4 ? 4 : 2);
  }
  state = loadReviewRounds(root, task).state;
  showState(state);
  if (runBrowserStage(task, state)) process.exit(0);
  console.log(`  指摘対応後、${aiCmd('review-flow', '--yes', { root })} で次の往復を開始してください。`);
  process.exit(0);
}

if (!apply) {
  hr(`2. ai:review-send（${reviewStepLabel(state)} dry-run）`);
  if (request?.status === 'accepted') {
    console.log('  前roundは受領済みです。次roundの実送信時に新しいRequest-IDを作成します。');
    console.log(`  ${aiCmd('review-flow', '--yes', { root })}`);
    process.exit(0);
  }
  const sendCode = run('ai-review-send.mjs');
  process.exit(sendCode === 0 ? 0 : 2);
}

hr(`2. ai:review-send（${reviewStepLabel(state)}）`);
// ai-review-send owns reservation and the common dispatch authorization. A draft
// has no ticket, and an accepted prior request must never lend its ticket to the
// next step. This orchestrator performs no delivery; the sender must succeed
// through its ticket gate before review-check can run.
const sendArgs = ['--yes'];
if (request?.status === 'accepted' || state.codeReview.rounds.length > 0) sendArgs.push('--force-new');
const sendCode = run('ai-review-send.mjs', sendArgs);
if (sendCode !== 0) {
  console.error('✗ レビュー依頼の送信に失敗しました。review-check は実行しません。');
  process.exit(2);
}

hr(`3. ai:review-check（${reviewStepLabel(state)}、1回のみ）`);
const checkArgs = ['--verdict', verdict || 'auto'];
if (note) checkArgs.push('--note', note);
const checkCode = run('ai-review-check.mjs', checkArgs);
if (checkCode !== 0) {
  if (checkCode === 4) {
    console.error('✗ レビュー返信は届きましたが合否を読み取れないため、本文を保全して記録を保留しました。');
    printVerdictHoldGuidance();
  } else {
    console.error('✗ レビュー返信をまだ取得できません。送信自体は完了しているため再送しません。');
    console.error(`  後で ${aiCmd('review-check', `--verdict ${verdict || 'auto'}`, { root })} を実行してください。`);
  }
  process.exit(checkCode === 1 ? 1 : checkCode === 4 ? 4 : 2);
}

state = loadReviewRounds(root, task).state;
showState(state);
if (runBrowserStage(task, state)) process.exit(0);
console.log(`✓ round ${state.codeReview.rounds.length} を記録しました。指摘対応後に次の往復へ進んでください。`);
