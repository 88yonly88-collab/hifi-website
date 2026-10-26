#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  atomicWriteJson,
  currentGitIdentity,
  gitFullOutput,
  validatePorcelainZ,
  isGitIntegrityError,
  declarationPathFor,
  ensureRegularFile,
  parseDeclaration,
  readJson,
  replaceDeclarationFields,
  resolveRepoPath,
  safeId,
  TEST_RUN_PRODUCER,
  TEST_RUN_REFERENCE_REQUIRED_ERROR,
  validateCompletion,
} from './ai-e2e-lib.mjs';
import { actualRepoName, loadApproval, taskCompletedSignal } from './ai-approval-lib.mjs';
import {
  GATED_CLOSURE_KIND,
  RETROSPECTIVE_CLOSURE_KIND,
  WARNED_FORWARD_CLOSURE_KIND,
  declarationFileName,
  evidencePathList,
  resolveDeclarationPath,
  sha256File,
  validateRetrospectiveInput,
} from './ai-retrospective-lib.mjs';
import {
  browserReviewApplicable,
  branchFreshness,
  cmgbFocusedCompletionBlockers,
  externalIndexBelongsToTask,
  retryReviewEscalationNotification,
  reviewProcessSummary,
} from './ai-review-rounds-lib.mjs';
import { assessCompletionReferenceReport } from './ai-completion-reference-lib.mjs';
import {
  copyCompletionEvidenceBundle,
  writeCompletionVerificationCopies,
} from './ai-completion-evidence-copy-lib.mjs';
import { aiCmd } from './ai-workflow-lib.mjs';
import { assertCompletionAllowed, cmgbIntakeCriterionPresent, reviewCycleRegistryExists } from './ai-review-cycle-lib.mjs';
// R3(2026-09-19) F3-1: この変更で足した review-evidence.mjs が ai-dev-tool にまだ無い時期に
// 発注した他 repo のレーンでも、`ai:complete` の読み込み自体は壊さない。静的な import だと
// helper の配布が途中のレーンで ERR_MODULE_NOT_FOUND になり、完了そのものが起動できなくなる。
// 外部レビュー証跡を使わないレーンはこの判定に到達しないため、欠けているときだけ明示の
// エラーを返す遅延読み込みにする(勝手に「未確認」で通さない)。
let externalReviewSettled;
try {
  ({ externalReviewSettled } = await import('./review-evidence.mjs'));
} catch (error) {
  externalReviewSettled = () => {
    throw new Error(
      'REVIEW_EVIDENCE_HELPER_UNAVAILABLE: scripts/review-evidence.mjs を読み込めません。'
      + 'ai-dev-tool の配布helperを揃えてから完了してください '
      + `(${error?.message ?? error})`,
    );
  };
}

const root = process.cwd();
const taskPath = join(root, '.ai', 'current-task.json');
const apply = process.argv.includes('--apply');
// 後追い完了(retrospective close): 正規ゲートを構造的な理由で通せない滞留タスク専用の別区分。
// 通常経路とは出力・検証JSON・完了履歴のすべてで機械判別できるようにする。
const retrospective = process.argv.includes('--retrospective');
// Global Rules v2の「完了ゲート不通過は警告として記録して前進」を明示的に適用する経路。
// 身元・重複検査は常にfail-closed。参照ナレッジは検査不能なら警告、未記入なら期限方針に従う。
const forceWithWarning = process.argv.includes('--force-with-warning');
const allowUncommittedRequested = process.argv.includes('--allow-uncommitted');

function fail(errors) {
  const list = Array.isArray(errors) ? errors : [errors];
  for (const error of list) console.error(`COMPLETION_GATE_REJECTED: ${error}`);
  process.exit(2);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return '';
  return String(process.argv[index + 1] || '').trim();
}

for (const name of ['--apply', '--retrospective', '--force-with-warning', '--allow-uncommitted', '--user-confirmed', '--input', '--evidence', '--instruction', '--delivery-record']) {
  if (process.argv.filter((arg) => arg === name).length > 1) fail(`${name} を重複して指定できません`);
}

// 設置レビュー（deploy_targets 台帳）の完了ゲート。2026-10-17 親の裁定（選択肢1）。
// 台帳を書いた指示書がある案件は、install-review-check.mjs --ledger が合格（不良0・未確認0）するまで
// 完了にしない。台帳の無い指示書・他リポジトリの案件・instruction_status: done は止めない。
// 安い検査なので、承認・E2E・レビューの各関所より先に判定して早く止める。
const installReviewInstruction = argValue('--instruction');
let installReviewGate = null;
{
  let installReviewTask = null;
  let installReviewDeclaration = '';
  try {
    if (existsSync(taskPath)) installReviewTask = readJson(taskPath);
  } catch {
    installReviewTask = null;
  }
  // 実際に閉じる宣言を優先する。後追い完了は --declaration で宣言を選べるため、
  // current-task から選ぶと「検査した案件」と「閉じる案件」がずれる（2026-10-17 レビュー指摘）。
  const installReviewDeclarationArg = argValue('--declaration');
  try {
    const candidate = installReviewDeclarationArg
      ? resolveDeclarationPath(installReviewDeclarationArg)
      : declarationPathFor(root, installReviewTask, '', { validateTaskRepo: false });
    if (existsSync(candidate)) installReviewDeclaration = readFileSync(candidate, 'utf8');
  } catch {
    installReviewDeclaration = '';
  }
  const { installReviewCompletionBlockers } = await import('./install-review-complete-lib.mjs');
  installReviewGate = await installReviewCompletionBlockers({
    root,
    instruction: installReviewInstruction,
    declaration: installReviewDeclaration,
    task: installReviewTask,
  });
  for (const line of installReviewGate.inactive) console.log(`INSTALL_REVIEW_COMPLETE_GATE_INACTIVE: ${line}`);
  for (const line of installReviewGate.checked) console.log(`INSTALL_REVIEW_COMPLETE_GATE_OK: ${line}`);
  for (const line of installReviewGate.skipped) console.log(`INSTALL_REVIEW_COMPLETE_GATE_SKIP: ${line}`);
  for (const line of installReviewGate.warnings) console.log(`INSTALL_REVIEW_COMPLETE_GATE_WARN: ${line}`);
  if (installReviewGate.blockers.length > 0) {
    fail(['設置レビューの完了ゲートで止めました（不良または未確認）', ...installReviewGate.blockers]);
  }
}

// 完了の定義（設置と検証の4点）の機械判定を完了ゲートへ接続する（2026-10-18）。
// 背景: 「作ったのに本番に反映されていない」が3〜5回繰り返された原因は、完了の定義に
// 設置と検証が無かったこと。rules/delivery-installed.md の記録（docs/deliverables/<ID>.json）を
// 完了時に必ず判定する。
// 既定は「設置ゲートが実際に効いている案件」で拒否する（2026-10-18 既定ON化）。
// 対象は installReviewGate.active（このリポジトリ内に設置先を持つ台帳つき指示書）だけ。
// 台帳なし・deploy_required:false・設置先が全部リポジトリ外・instruction_status: done は
// 設置ゲートと同じく止めない（誤差し戻しを避ける）。
// DELIVERY_REQUIRED=1 は台帳の有無に関わらず常に拒否、0/false/off は警告のみ。
// 後追い完了(retrospective)にも同じ判定を掛けるため、経路分岐より前で実行する。
const DELIVERY_MODE = String(process.env.DELIVERY_REQUIRED || '').trim().toLowerCase();
const DELIVERY_FORCED = ['1', 'true', 'yes'].includes(DELIVERY_MODE);
const DELIVERY_DISABLED = ['0', 'false', 'no', 'off'].includes(DELIVERY_MODE);
const DELIVERY_ACTIVE = Boolean(
  installReviewGate && Array.isArray(installReviewGate.active) && installReviewGate.active.length > 0,
);
const DELIVERY_STRICT = !DELIVERY_DISABLED && (DELIVERY_FORCED || DELIVERY_ACTIVE);

function deliveryGateScopeNote() {
  if (DELIVERY_DISABLED) return 'DELIVERY_REQUIRED=0 のため警告のみ';
  if (DELIVERY_FORCED) return 'DELIVERY_REQUIRED=1 のため台帳の有無に関わらず拒否';
  if (DELIVERY_ACTIVE) return `設置台帳が有効なため既定で拒否（${installReviewGate.active.join(', ')}）`;
  return '設置台帳が無い/設置不要/リポジトリ外/done のため、記録なしは警告のみ（誤差し戻しを避ける）';
}

function deliveryCheckerCandidates() {
  const knowledgeRoot = process.env.KNOWLEDGE_ROOT || join(homedir(), 'projects', 'knowledge');
  return [
    join(root, 'scripts', 'check-delivery-record.mjs'),
    join(knowledgeRoot, 'scripts', 'check-delivery-record.mjs'),
  ];
}

function deliveryTaskId() {
  try {
    if (!existsSync(taskPath)) return '';
    return String(readJson(taskPath)?.taskId || '').trim();
  } catch {
    return '';
  }
}

// 記録は「この作業のもの」だけを合格に数える。別タスクの古い記録が残っていても通さない。
function deliveryRecordMatchesTask(recordPath, taskId) {
  if (!taskId) return true;
  const base = basename(recordPath).replace(/\.json$/iu, '');
  const rawBase = base.toLowerCase();
  const rawTask = taskId.toLowerCase();
  if (rawBase === rawTask || rawBase.includes(rawTask) || rawTask.includes(rawBase)) return true;
  const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/gu, '');
  const a = normalize(base);
  const b = normalize(taskId);
  return Boolean(a && b) && (a === b || a.includes(b) || b.includes(a));
}

function judgeDeliveryRecord(recordPath, checker) {
  const judged = spawnSync(process.execPath, [checker, recordPath], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  if (judged.error) return { status: 2, output: `実行できません: ${judged.error.message}` };
  return { status: judged.status, output: `${judged.stdout || ''}${judged.stderr || ''}`.trim() };
}

function rejectDeliveryGate(reason) {
  console.error(`DELIVERY_GATE_REJECTED: ${reason}`);
  console.error('完了の定義（built／installed／verify_cmd／verify_output の4点）を記録してから再実行してください。');
  console.error('正本: ~/projects/knowledge/rules/delivery-installed.md');
  process.exit(1);
}

function enforceDeliveryRecordGate() {
  console.log(`DELIVERY_GATE_SCOPE: ${deliveryGateScopeNote()}`);
  const taskId = deliveryTaskId();
  const taskLabel = taskId || '(taskId不明)';
  const explicit = argValue('--delivery-record') || String(process.env.DELIVERY_RECORD || '').trim();
  const checker = deliveryCheckerCandidates().find((candidate) => existsSync(candidate)) || '';
  if (!checker) {
    const reason = 'DELIVERY_CHECK_UNAVAILABLE: scripts/check-delivery-record.mjs が見つかりません';
    if (DELIVERY_STRICT) rejectDeliveryGate(reason);
    console.log(`DELIVERY_RECORD_WARNING: ${reason}（判定できないため未確認として扱う）`);
    return;
  }

  let records = [];
  if (explicit) {
    records = [resolve(root, explicit)];
  } else {
    const deliverablesDir = join(root, 'docs', 'deliverables');
    try {
      if (existsSync(deliverablesDir)) {
        records = readdirSync(deliverablesDir)
          .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
          .sort()
          .map((name) => join(deliverablesDir, name));
      }
    } catch (error) {
      if (DELIVERY_STRICT) rejectDeliveryGate(`docs/deliverables を読めません（${error.message}）`);
      console.log(`DELIVERY_RECORD_WARNING: docs/deliverables を読めません（${error.message}）`);
      return;
    }
  }

  if (records.length === 0) {
    const hint = `成果物記録がありません（${join(root, 'docs', 'deliverables', '<ID>.json')}）。taskId=${taskLabel}`;
    if (DELIVERY_STRICT) rejectDeliveryGate(hint);
    console.log(`DELIVERY_RECORD_WARNING: ${hint}`);
    console.log('DELIVERY_RECORD_NOTE: 既定は「設置台帳が有効な案件」で拒否します。台帳なし・設置不要・リポジトリ外・done は警告のみ。DELIVERY_REQUIRED=1 で常に拒否、=0 で警告のみ。');
    return;
  }

  const judged = records.map((recordPath) => ({ recordPath, ...judgeDeliveryRecord(recordPath, checker) }));
  const passing = judged.filter((item) => item.status === 0);
  const matched = passing.filter((item) => deliveryRecordMatchesTask(item.recordPath, taskId));

  if (matched.length > 0) {
    console.log(`DELIVERY_RECORD_OK: ${matched[0].recordPath}`);
    console.log(`DELIVERY_RECORD_MATCHED_TASK: ${taskLabel}`);
    return;
  }

  for (const item of judged) {
    const label = item.status === 0 ? 'OK' : `NG(exit ${item.status})`;
    console.log(`DELIVERY_RECORD_CANDIDATE: ${label} ${item.recordPath}`);
    if (item.status !== 0) {
      for (const line of item.output.split('\n')) {
        if (line.trim()) console.log(`  ${line}`);
      }
    }
  }
  const reason = passing.length > 0
    ? `この作業(taskId=${taskLabel})の記録がありません（合格した記録は別タスクのもの: ${passing.map((item) => basename(item.recordPath)).join(', ')}）`
    : `合格した成果物記録がありません（判定した記録: ${judged.map((item) => basename(item.recordPath)).join(', ')}）`;
  if (DELIVERY_STRICT) rejectDeliveryGate(reason);
  console.log(`DELIVERY_RECORD_WARNING: ${reason}`);
  console.log('DELIVERY_RECORD_NOTE: 既定は「設置台帳が有効な案件」で拒否します。台帳なし・設置不要・リポジトリ外・done は警告のみ。DELIVERY_REQUIRED=1 で常に拒否、=0 で警告のみ。');
}

enforceDeliveryRecordGate();

function isCompletionStatePath(path) {
  return path === '.ai'
    || path.startsWith('.ai/')
    || path === '.worktree-gc-release'
    || path.startsWith('.worktree-gc-release.pending.');
}

function isExemptedDataPath(path) {
  return path === 'data' || path.startsWith('data/');
}

function completionRootPath(repoRelativePath, repoPrefix) {
  const normalizedPrefix = String(repoPrefix || '').replace(/^\/+|\/+$/gu, '');
  if (!normalizedPrefix) return repoRelativePath;
  const prefix = `${normalizedPrefix}/`;
  if (repoRelativePath.startsWith(prefix)) return repoRelativePath.slice(prefix.length);
  const ascent = normalizedPrefix.split('/').filter(Boolean).map(() => '..').join('/');
  return `${ascent}/${repoRelativePath}`;
}

function uncommittedImplementationFiles() {
  let repoPrefix;
  try {
    repoPrefix = execFileSync('git', ['-C', root, 'rev-parse', '--show-prefix'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024,
    }).trim();
  } catch (error) {
    if (error?.code === 'EPERM' && error?.status === 0 && typeof error?.stdout === 'string') {
      repoPrefix = error.stdout.trim();
    } else if (isGitIntegrityError(error)) {
      throw error;
    } else {
      const detail = String(error?.stderr || error?.message || 'unknown_error')
        .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
      throw new Error(`git rev-parse --show-prefixを実行できません${detail ? `: ${detail}` : ''}`);
    }
  }
  let porcelain;
  try {
    porcelain = validatePorcelainZ(gitFullOutput(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  } catch (error) {
    // 一部sandboxはgitが正常終了して完全なstdoutを返した後の後片付けだけをEPERMにする。
    // status=0と文字列stdoutの両方が揃う場合に限り、実行結果を回収する。
    if (error?.code === 'EPERM' && error?.status === 0 && typeof error?.stdout === 'string') {
      porcelain = validatePorcelainZ(error.stdout);
    } else if (String(error?.message || '').includes('GIT_OUTPUT_TOO_LARGE') || error?.code === 'ENOBUFS' || /maxBuffer|stdout maxBuffer length exceeded/iu.test(String(error?.message || ''))) {
      const overflow = new Error('git statusの出力が読み取り上限を超えました。変更を小分けにしてcommitしてから再実行してください');
      overflow.code = 'UNCOMMITTED_STATUS_TOO_LARGE';
      throw overflow;
    } else if (isGitIntegrityError(error)) {
      throw error;
    } else {
      const detail = String(error?.stderr || error?.message || 'unknown_error')
        .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
      throw new Error(`git status --porcelainを実行できません${detail ? `: ${detail}` : ''}`);
    }
  }

  const records = String(porcelain || '').split('\0');
  const files = [];
  const exemptedDataFiles = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('git status --porcelainの出力形式を解釈できません');
    }
    const status = record.slice(0, 2);
    const paths = [completionRootPath(record.slice(3), repoPrefix)];
    if (/[RC]/u.test(status)) {
      const previousPath = records[index + 1];
      if (!previousPath) throw new Error('git status --porcelainのrename/copy元が欠けています');
      paths.push(completionRootPath(previousPath, repoPrefix));
      index += 1;
    }
    for (const path of paths) {
      if (isCompletionStatePath(path)) continue;
      if (isExemptedDataPath(path)) exemptedDataFiles.push(path);
      else files.push(path);
    }
  }
  return {
    files: [...new Set(files)].sort((left, right) => left.localeCompare(right, 'en')),
    exemptedDataFiles: [...new Set(exemptedDataFiles)].sort((left, right) => left.localeCompare(right, 'en')),
  };
}

function uncommittedFileSummary(files, limit = 20) {
  const shown = files.slice(0, limit).map(displayUncommittedPath).join(', ');
  const rest = files.length - Math.min(files.length, limit);
  return rest > 0 ? `${shown}（ほか${rest}件、合計${files.length}件）` : shown;
}

function gitMetadataValue(args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

// 制御文字は画面表示用の置換文字(U+FFFD)へ潰す。
// 生の U+FFFD をソースへ書くと、この helper 自身が差分に入ったレーンで
// queue レビューの個人情報検知が「解釈できない文字」と誤認して登録できなくなるため、
// 見た目が同じでもエスケープ表記のまま保つ。
function displayUncommittedPath(path) {
  return String(path).replace(/[\u0000-\u001f\u007f]+/gu, '\uFFFD');
}

function boundedDiagnostic(value, limit = 1000) {
  const normalized = String(value || 'unknown_error')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function recordedUncommittedFileState(files, limit = 200) {
  const sanitized = files.map(displayUncommittedPath);
  return {
    files: sanitized.slice(0, limit),
    ...(sanitized.length > limit
      ? { remainingFileCount: sanitized.length - limit, totalFileCount: sanitized.length }
      : {}),
  };
}

function recordedExemptedDataFileState(files, limit = 200) {
  const sanitized = files.map(displayUncommittedPath);
  return {
    exemptedDataFiles: sanitized.slice(0, limit),
    ...(sanitized.length > limit
      ? {
          exemptedDataRemainingFileCount: sanitized.length - limit,
          exemptedDataTotalFileCount: sanitized.length,
        }
      : {}),
  };
}

function containsSecretLikeValue(value) {
  if (/(?:\bsk-|\bghp_|\bgho_|\bgithub_pat_|\bxox[baprs]-)\S+/iu.test(value)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{8,}\b/u.test(value)
    || /\bBearer\s+\S+/iu.test(value)
    || /-----BEGIN\b/iu.test(value)) return true;
  const longCandidates = value.match(/[A-Za-z0-9+/=_-]{32,}/gu) || [];
  return longCandidates.some((candidate) => /[A-Z]/u.test(candidate)
    && /[a-z]/u.test(candidate)
    && /[0-9]/u.test(candidate));
}

function allowUncommittedReason() {
  const reason = argValue('--allow-uncommitted')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!reason) {
    fail('--allow-uncommitted には理由を続けて指定してください');
  }
  if (containsSecretLikeValue(reason)) {
    fail('--allow-uncommitted の理由に秘密情報らしい文字列を含めないでください');
  }
  if (reason.startsWith('--')) {
    fail('--allow-uncommitted の理由がフラグに見えます。理由を引用符で囲み、フラグの直後へ指定してください');
  }
  if (reason.length > 500) fail('--allow-uncommitted の理由は500文字以内で指定してください');
  return reason;
}

function readCurrentTask() {
  if (!existsSync(taskPath)) return null;
  try {
    return readJson(taskPath);
  } catch {
    return null;
  }
}

function retroFail(errors) {
  const list = Array.isArray(errors) ? errors : [errors];
  for (const error of list) console.error(`RETROSPECTIVE_CLOSE_REJECTED: ${error}`);
  process.exit(2);
}

function completionWarningSummary(warnings) {
  return warnings
    .map((warning) => String(warning).replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join('; ');
}

function releaseMarkerFailureReason(error) {
  return String(error?.code || error?.message || 'unknown_error')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, '_')
    .slice(0, 160);
}

function gitReleaseProbe(args) {
  try {
    return spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/**
 * 通常完了後のlinked worktreeだけに、GCが認識する解放目印を置く。
 * 完了済みHEADがmain/masterまたはupstreamに含まれると証明できない限りfail-closedにする。
 * worktreeの削除は行わず、目印の書き込み失敗も通常完了の成功可否には影響させない。
 */
function markCompletedWorktreeReleased(taskId, createdAt) {
  let warning = '';
  const result = (skipped = '') => ({ skipped, warning });
  const gitEntry = join(root, '.git');
  try {
    const gitEntryStat = lstatSync(gitEntry);
    if (!gitEntryStat.isFile() || gitEntryStat.isSymbolicLink()) return result('not_linked_worktree');
  } catch {
    return result('not_linked_worktree');
  }

  const tracked = gitReleaseProbe(['ls-files', '--error-unmatch', '--', '.worktree-gc-release']);
  if (tracked?.status === 0) return result('marker_path_tracked');
  if (tracked?.status !== 1) return result('marker_write_failed:tracking_check_failed');

  const ignored = gitReleaseProbe(['check-ignore', '--quiet', '--no-index', '--', '.worktree-gc-release']);
  if (ignored?.status !== 0) warning = 'marker_path_not_ignored';

  const attached = gitReleaseProbe(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const attachedBranch = attached?.status === 0 ? String(attached.stdout || '').trim() : '';
  if (['main', 'master'].includes(attachedBranch)) return result('main_branch_checkout');
  const refs = [];
  for (const branch of ['main', 'master']) {
    const found = gitReleaseProbe(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (found?.status === 0) refs.push(`refs/heads/${branch}`);
  }
  if (attached?.status === 0) {
    const upstream = gitReleaseProbe(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    const upstreamRef = upstream?.status === 0 ? String(upstream.stdout || '').trim() : '';
    if (upstreamRef && !/[\r\n]/u.test(upstreamRef)) refs.push(upstreamRef);
  }

  const reflected = refs.some((ref) => gitReleaseProbe(['merge-base', '--is-ancestor', 'HEAD', ref])?.status === 0);
  if (!reflected) return result('unreflected_commits');

  const markerPath = join(root, '.worktree-gc-release');
  const pendingPath = join(root, `.worktree-gc-release.pending.${process.pid}.${Date.now()}`);
  try {
    try {
      const markerStat = lstatSync(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) return result('marker_write_failed:unsafe_existing_path');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const noFollow = constants.O_NOFOLLOW || 0;
    const descriptor = openSync(
      pendingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_CLOEXEC | noFollow,
      0o600,
    );
    try {
      if (!fstatSync(descriptor).isFile()) return result('marker_write_failed:not_regular_file');
      writeFileSync(descriptor, `taskId=${taskId} createdAt=${createdAt}\n`, { encoding: 'utf8' });
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      const markerStat = lstatSync(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) return result('marker_write_failed:unsafe_existing_path');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    renameSync(pendingPath, markerPath);
  } catch (error) {
    return result(`marker_write_failed:${releaseMarkerFailureReason(error)}`);
  }
  return result();
}

function blockedTestRunWarning(task, gitHead) {
  try {
    const taskId = safeId(task?.taskId);
    const path = resolveRepoPath(root, join('.ai', 'e2e', `test-run-${taskId}.json`), 'テスト実行結果');
    if (!existsSync(path)) return '';
    ensureRegularFile(path, 'テスト実行結果');
    const result = readJson(path);
    if (
      result?.producedBy !== TEST_RUN_PRODUCER ||
      result?.status !== 'blocked' ||
      result?.taskId !== taskId ||
      result?.gitHead !== gitHead
    ) {
      return '';
    }
    const executed = Number.isInteger(result?.counts?.total) ? result.counts.total : 0;
    const skipped = Number.isInteger(result?.counts?.skipped) ? result.counts.skipped : 0;
    const reason = String(result?.blocker?.reason || '子プロセスを起動できませんでした').trim();
    return `テストを実行できない環境だったため、この完了はテスト未実行である（実行${executed}件 / skip${skipped}件）。理由: ${reason}`;
  } catch {
    return '';
  }
}

function collectReviewProcess(task) {
  let summary;
  if (!task?.taskId || !task?.taskFingerprint) {
    summary = {
      codeReviewRounds: 0,
      codeReviewOutcome: 'unavailable',
      visualQcOutcome: 'unavailable',
      visualQcAttempts: 0,
      visualQcPreliminaryChecks: 0,
      browserReviewOutcome: 'unavailable',
      browserReviewRounds: 0,
      warnings: ['current-task.jsonとレビュー往復状態を照合できません'],
    };
  } else {
    try {
      if (apply) retryReviewEscalationNotification(root, task);
      const approvalResult = loadApproval(root, task);
      summary = reviewProcessSummary(root, task, {
        approval: approvalResult.errors.length ? null : approvalResult.approval,
      });
    } catch (error) {
      summary = {
        codeReviewRounds: 0,
        codeReviewOutcome: 'unavailable',
        visualQcOutcome: 'unavailable',
        visualQcAttempts: 0,
        visualQcPreliminaryChecks: 0,
        browserReviewOutcome: 'unavailable',
        browserReviewRounds: 0,
        warnings: [`レビュー往復状態を集計できません: ${error.message}`],
      };
    }
  }
  const freshness = branchFreshness(root, { phase: 'completion' });
  if (freshness.isFresh === false && freshness.warning) summary.warnings.unshift(freshness.warning);
  // web_ui の完了ゲート安全弁: ブラウザ往復を「対象外(not_applicable)」のまま完了記録へ
  // 書かない。外部集計経路(externalReviewSummary)の合成漏れや、state側の取り違えを
  // ここで fail-closed に捕捉する。視覚QCは移行済み旧stateの免除があり得るため対象外。
  // surfaceKind の判定は rounds-lib の browserReviewApplicable に一本化する(意味は同じだが、
  // 将来 surface の分岐が増えたときに安全弁だけ取り残されないようにする。2026-10-02 R2 U1)。
  // 2026-10-02 R3 E3-1: external 集計が throw した web_ui レーンは collectReviewProcess の catch で
  // browserReviewOutcome が 'unavailable' のまま残る。not_applicable と同じく、実状態を記録せずに
  // 完了できないよう fail-closed にする(ブラウザ段階を開いても集計側が拒否する穴を塞ぐ)。
  if (browserReviewApplicable(task)
    && ['not_applicable', 'unavailable'].includes(summary.browserReviewOutcome)) {
    const detail = summary.browserReviewOutcome === 'not_applicable'
      ? 'ブラウザレビューが「対象外(not_applicable)」になっています。review-rounds.json の実状態(通過/未実施/待ち)を記録してから完了してください'
      : 'ブラウザレビューが「集計不能(unavailable)」になっています。外部レビュー集計の拒否理由(REVIEW_PROCESS_WARNING)を解消し、実状態を記録してから完了してください';
    fail([
      `web_ui の完了記録で${detail}`,
      ...summary.warnings,
    ]);
  }
  return summary;
}

function printReviewProcessWarnings(reviewProcess) {
  for (const warning of reviewProcess.warnings) console.log(`REVIEW_PROCESS_WARNING: ${warning}`);
}

async function enforceCompletionReferenceReport(task, declaration, declarationText) {
  const result = await assessCompletionReferenceReport({ root, task, declaration, declarationText });
  const record = {
    missing: result.missing,
    unavailable: result.unavailable === true,
    warnings: result.warnings.map((warning) => String(warning)),
  };
  for (const warning of result.warnings) {
    console.error(`KB_COMPLETION_REFERENCE_WARNING: ${warning}`);
  }
  if (result.unavailable) return record;
  if (!result.missing) return record;
  if (result.policy.blockMissing) throw new Error(result.detail);
  console.error(`KB_COMPLETION_REFERENCE_MISSING_WARNING: ${result.detail}`);
  return record;
}

/**
 * 濫用防止ガード。「この作業宣言に対して今から通常の完了ゲートを通せるか」を機械判定する。
 * 戻り値が空配列＝通常ゲートを通せる＝後追い完了は使わせない（面倒だから後追い、を防ぐ）。
 */
function normalGateBlockers(declaration) {
  const blockers = [];
  try {
    const task = readCurrentTask();
    if (!task) return ['.ai/current-task.jsonが無いため通常ゲートを実行できません'];
    const currentTaskId = String(task.taskId || '').trim();
    const declarationTaskId = String(declaration.task_id || '').trim();
    if (!currentTaskId || currentTaskId !== declarationTaskId) {
      blockers.push(
        `current-task.jsonのtaskIdが作業宣言と一致しません（current-task=${currentTaskId || '(missing)'} / 宣言=${declarationTaskId || '(missing)'}）`,
      );
    }
    const approvalResult = loadApproval(root, task);
    blockers.push(...approvalResult.errors.map((error) => `承認ゲート: ${error}`));
    const evidencePath = join(root, '.ai', 'e2e', `${declarationTaskId}.json`);
    if (!existsSync(evidencePath)) {
      blockers.push(`E2E証跡がありません: ${evidencePath}`);
    } else {
      ensureRegularFile(evidencePath, 'E2E証跡');
      blockers.push(...validateCompletion({ root, task, declaration, evidence: readJson(evidencePath) }).errors);
    }
  } catch (error) {
    blockers.push(error.message);
  }
  return blockers;
}

async function runRetrospectiveClose() {
  // ①ユーザーの明示確認フラグ。事前承認(approval.json)の代わりではなく、後追いの結果確認。
  if (!process.argv.includes('--user-confirmed')) {
    retroFail([
      '後追い完了にはユーザーの明示確認フラグ --user-confirmed が必要です',
      'これは「事前に承認した完成図」ではなく「作業後にユーザーが結果を確認した」記録として保存されます',
    ]);
  }
  // ②入力JSON（理由コード・自由記述・裏付け・ユーザー確認）
  const inputArg = argValue('--input');
  if (!inputArg) retroFail('--input <後追い完了の入力JSON> が必要です');
  let inputPath = '';
  try {
    inputPath = resolveRepoPath(root, inputArg, '後追い完了の入力JSON');
    if (!existsSync(inputPath)) throw new Error(`後追い完了の入力JSONがありません: ${inputPath}`);
    ensureRegularFile(inputPath, '後追い完了の入力JSON');
  } catch (error) {
    retroFail(error.message);
  }
  let input;
  try {
    input = readJson(inputPath);
  } catch (error) {
    retroFail(`後追い完了の入力JSONを読めません: ${error.message}`);
  }

  // ③対象の作業宣言。--declaration 省略時だけcurrent-task.jsonから解決する
  //   （記録同士の不一致で滞留した宣言も閉じられるよう、current-task.jsonとの一致は必須にしない）。
  const declarationArg = argValue('--declaration');
  let declarationPath = '';
  let declarationAutoResolved = false;
  try {
    if (declarationArg) {
      declarationPath = resolveDeclarationPath(declarationArg);
    } else {
      const task = readCurrentTask();
      if (!task) throw new Error('.ai/current-task.jsonが無いため --declaration <作業宣言パス> を明示してください');
      // 救済対象はcurrent-taskのrepo欠落・古さだけ。宣言自体が旧repo名なら自動探索せず、別repo宣言も閉じない。
      declarationPath = resolveDeclarationPath(declarationPathFor(root, task, task.branch, { validateTaskRepo: false }));
      declarationAutoResolved = true;
    }
  } catch (error) {
    retroFail(error.message);
  }
  if (declarationAutoResolved) console.log(`RETROSPECTIVE_DECLARATION_SELECTED: ${declarationPath}`);
  const declarationText = readFileSync(declarationPath, 'utf8');
  const declaration = parseDeclaration(declarationText);

  // ④宣言の身元検査。別リポジトリ・命名規約外の宣言を閉じさせない。
  const expectedName = declarationFileName(declaration);
  if (!expectedName || basename(declarationPath) !== expectedName) {
    retroFail(
      `作業宣言のrepo/branchとファイル名が一致しません（期待=${expectedName || '(repo/branch欠落)'} / 実際=${basename(declarationPath)}）`,
    );
  }
  let repo = '';
  try {
    repo = actualRepoName(root);
  } catch (error) {
    retroFail(error.message);
  }
  if (!repo) retroFail('実git repoを取得できません');
  if (String(declaration.repo || '').trim() !== repo) {
    retroFail(
      `この作業宣言は別リポジトリのものです（宣言=${declaration.repo || '(missing)'} / 実行中=${repo}）。対象リポジトリで実行してください`,
    );
  }
  if (!['running', 'waiting', 'blocked', 'needs_parent'].includes(String(declaration.status || '').trim())) {
    retroFail(`後追い完了の対象は未終了の作業宣言だけです（status=${declaration.status || '(missing)'}）`);
  }
  let taskId = '';
  try {
    taskId = safeId(declaration.task_id, '作業宣言のtask_id');
  } catch (error) {
    retroFail(error.message);
  }
  const taskFingerprint = String(declaration.task_fingerprint || '').trim();
  if (!taskFingerprint) retroFail('作業宣言のtask_fingerprintが空です');
  if (taskCompletedSignal(root, taskId)) retroFail(`このタスク(${taskId})は既に完了済みです`);
  const currentTask = readCurrentTask();
  let completionReference;
  try {
    completionReference = await enforceCompletionReferenceReport(
      { ...(currentTask || {}), taskId },
      declaration,
      declarationText,
    );
  } catch (error) {
    retroFail(`参照ナレッジ検査: ${error.message}`);
  }

  // ⑤濫用防止: 通常ゲートを通せる状態なら後追い完了を拒否する。
  const blockers = normalGateBlockers(declaration);
  if (blockers.length === 0) {
    retroFail([
      '通常の完了ゲートを通せる状態です。後追い完了は使えません',
      '承認済み完成図とE2E証跡が揃っているため、通常の完了ゲート(--apply)で閉じてください',
    ]);
  }
  if (blockers.every((blocker) => blocker.includes(TEST_RUN_REFERENCE_REQUIRED_ERROR))) {
    retroFail([
      'テスト実行結果を作っていないことだけを理由に、後追い完了は使えません',
      '先にai:testを実行し、表示された「実行結果」のパスをE2E証跡のtestRunへ指定してください',
    ]);
  }

  // ⑥入力検証（裏付けの実在確認を含む）。1件でも欠ければfail-closed。
  const validated = validateRetrospectiveInput({ root, input, declaration });
  if (validated.errors.length) retroFail(validated.errors);

  const git = currentGitIdentity(root);
  const reviewProcess = collectReviewProcess(currentTask);
  const verificationPath = join(root, '.ai', 'context', `completion-verification-${taskId}.json`);
  const verification = {
    schemaVersion: 1,
    // 通常完了(gated)と機械的に判別するための正本field。
    closureKind: RETROSPECTIVE_CLOSURE_KIND,
    taskId,
    taskFingerprint,
    repo,
    branch: String(declaration.branch || '').trim(),
    gitBranchAtClose: git.branch,
    gitHead: git.gitHead,
    gitStatusHash: git.gitStatusHash,
    worktreeHash: git.worktreeHash,
    verifiedAt: new Date().toISOString(),
    declaration: declarationPath,
    // 後追い完了は機械検証可能なE2E証跡を持たない。宣言の記載をそのまま残し、
    // 「機械検証していない」ことを明示する（通常完了のevidenceと混同させない）。
    evidence: null,
    machineVerifiedE2e: false,
    declaredE2eEvidence: String(declaration.e2e_evidence || ''),
    reviewStatus: String(declaration.review_status || ''),
    e2eStatus: String(declaration.e2e_status || ''),
    approval: null,
    approvalContentHash: null,
    currentTaskId: currentTask ? String(currentTask.taskId || '').trim() : null,
    completionReference,
    // なぜ通常ゲートを通せないのかの機械収集結果（人手の主張だけに依存させない）。
    normalGateBlockers: blockers,
    retrospective: {
      ...validated.record,
      inputPath,
      inputSha256: sha256File(inputPath),
    },
    reviewProcess,
    status: 'retrospective_closed',
    applied: false,
  };
  atomicWriteJson(verificationPath, verification);
  printReviewProcessWarnings(reviewProcess);

  if (!apply) {
    console.log(`RETROSPECTIVE_CLOSE_ACCEPTED: ${verificationPath}`);
    console.log('完了履歴へ移すには --apply を付けて再実行してください。');
    process.exit(0);
  }

  const now = new Date().toISOString();
  // 作業宣言のタイムスタンプはknowledge側validate-declaration.shのTS_RE(秒精度・TZ付き)に
  // 合わせる。ミリ秒付きISOは不備として弾かれるため、宣言へ書く値だけ秒精度にする。
  const declarationNow = now.replace(/\.\d{3}Z$/, 'Z');
  const completedDir = join(dirname(declarationPath), 'completed');
  const completedPath = join(completedDir, `${taskId}.md`);
  mkdirSync(completedDir, { recursive: true });
  const completedDirStat = lstatSync(completedDir);
  if (!completedDirStat.isDirectory() || completedDirStat.isSymbolicLink()) {
    retroFail('completedはsymlinkではない実ディレクトリが必要です');
  }
  try {
    lstatSync(completedPath);
    retroFail(`完了履歴が既に存在します: ${completedPath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const updated = replaceDeclarationFields(declarationText, {
    status: 'done',
    // 通常完了(phase: completed)と読み分けられるようにする。
    phase: 'completed_retrospective',
    progress: '100',
    updated_at: declarationNow,
    closure_kind: RETROSPECTIVE_CLOSURE_KIND,
    retrospective_reason_code: validated.record.reasonCode,
    retrospective_user_confirmed_by: validated.record.userConfirmation.confirmedBy,
    retrospective_user_confirmed_at: validated.record.userConfirmation.confirmedAt,
    retrospective_evidence: evidencePathList(validated.record),
    completion_verification: verificationPath,
  });
  const temp = `${declarationPath}.${process.pid}.tmp`;
  writeFileSync(temp, updated, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  renameSync(temp, declarationPath);
  renameSync(declarationPath, completedPath);
  // 通常完了と同じく、current-task.jsonへは一切書き込まない。
  atomicWriteJson(verificationPath, {
    ...verification,
    applied: true,
    appliedAt: now,
    completedDeclaration: completedPath,
  });
  console.log(`RETROSPECTIVE_CLOSE_APPLIED: ${completedPath}`);
  console.log('この完了は closureKind=retrospective です。通常ゲート通過(gated)とは区別して扱ってください。');
  // 後追い完了は当時のHerdrペインが既に無い前提のため、cc-closeは呼ばない
  // （無関係な稼働中ペインを巻き込まないための安全側）。
  console.log('HERDR_CLEANUP: skipped(retrospective)');
  process.exit(0);
}

if (retrospective && forceWithWarning) {
  fail('--retrospective と --force-with-warning は同時に指定できません');
}

if (retrospective && allowUncommittedRequested) {
  fail('--retrospective と --allow-uncommitted は同時に指定できません');
}

if (retrospective) {
  await runRetrospectiveClose();
  fail('内部エラー: 後追い完了経路が終了しませんでした');
}

if (!existsSync(taskPath)) fail('.ai/current-task.jsonがありません');
let task;
try {
  task = readJson(taskPath);
} catch (error) {
  fail(`current-task.jsonを読めません: ${error.message}`);
}
try {
  task.taskId = safeId(task.taskId);
} catch (error) {
  fail(error.message);
}
const completionWarnings = [];
const approvalResult = loadApproval(root, task);
if (approvalResult.errors.length) {
  const approvalErrors = approvalResult.errors.map((error) => `承認ゲート: ${error}`);
  if (!forceWithWarning) fail(approvalErrors);
  completionWarnings.push(...approvalErrors);
}

const branch = String(task.branch || '').trim();
let declarationPath;
try {
  declarationPath = declarationPathFor(root, task, branch);
} catch (error) {
  fail(error.message);
}
if (!existsSync(declarationPath)) fail(`active作業宣言がありません: ${declarationPath}`);
const declarationStat = lstatSync(declarationPath);
if (!declarationStat.isFile() || declarationStat.isSymbolicLink()) fail('作業宣言はsymlinkではないregular fileが必要です');
const declarationText = readFileSync(declarationPath, 'utf8');
const declaration = parseDeclaration(declarationText);
let declarationTaskId;
try {
  declarationTaskId = safeId(declaration.task_id, '作業宣言のtask_id');
} catch (error) {
  fail(error.message);
}
if (declarationTaskId !== task.taskId) {
  fail(`taskIdが作業宣言と一致しません（current-task=${task.taskId} / 宣言=${declarationTaskId}）`);
}
if (taskCompletedSignal(root, task.taskId)) fail(`このタスク(${task.taskId})は既に完了済みです`);
const requestedUncommittedReason = allowUncommittedRequested ? allowUncommittedReason() : '';
let uncommittedFiles = [];
let exemptedDataFiles = [];
let uncommittedInspectionError = '';
try {
  ({ files: uncommittedFiles, exemptedDataFiles } = uncommittedImplementationFiles());
} catch (error) {
  if (error?.code === 'UNCOMMITTED_STATUS_TOO_LARGE' || isGitIntegrityError(error)) fail(error.message);
  uncommittedInspectionError = boundedDiagnostic(error?.message || error || 'unknown_error');
  if (!allowUncommittedRequested) {
    fail([
      uncommittedInspectionError,
      '状態を確認できないまま進める場合は --allow-uncommitted "<理由>" を指定してください',
    ]);
  }
}
if (uncommittedFiles.length > 0 && !allowUncommittedRequested) {
  fail([
    `実装ファイルが未コミットです: ${uncommittedFileSummary(uncommittedFiles)}`,
    'まず今回の変更だけをcommitしてから、完了確認を再実行してください',
    `commitできない場合だけ例外指定で再実行: ${aiCmd('complete', '--allow-uncommitted "<理由>"', { root })}`,
    'EROFS（Read-only file system）でcommit不能なエージェントは、親へcommit代行を依頼してください',
  ]);
}
const uncommittedAllowed = allowUncommittedRequested
  && (uncommittedFiles.length > 0 || Boolean(uncommittedInspectionError));
const uncommittedReason = uncommittedAllowed ? requestedUncommittedReason : '';
const uncommittedChanges = {
  detected: uncommittedInspectionError ? null : uncommittedFiles.length > 0,
  allowed: uncommittedAllowed,
  ...recordedUncommittedFileState(uncommittedFiles),
  ...(exemptedDataFiles.length ? recordedExemptedDataFileState(exemptedDataFiles) : {}),
  ...(uncommittedInspectionError ? { inspectionError: uncommittedInspectionError } : {}),
  ...(uncommittedInspectionError ? { skippedIdentityChecks: ['gitStatusHash', 'worktreeHash'] } : {}),
  ...(uncommittedAllowed ? { reason: uncommittedReason } : {}),
};
let completionReference;
try {
  completionReference = await enforceCompletionReferenceReport(task, declaration, declarationText);
} catch (error) {
  fail(`参照ナレッジ検査: ${error.message}`);
}

if (forceWithWarning) {
  const existingCompletedDir = join(dirname(declarationPath), 'completed');
  if (existsSync(existingCompletedDir)) {
    const completedDirStat = lstatSync(existingCompletedDir);
    if (!completedDirStat.isDirectory() || completedDirStat.isSymbolicLink()) {
      fail('completedはsymlinkではない実ディレクトリが必要です');
    }
    const existingCompletedPath = join(existingCompletedDir, `${task.taskId}.md`);
    try {
      lstatSync(existingCompletedPath);
      fail(`完了履歴が既に存在します: ${existingCompletedPath}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

let evidencePath = null;
try {
  const requestedEvidence = process.argv.includes('--evidence')
    ? process.argv[process.argv.indexOf('--evidence') + 1]
    : join(root, '.ai', 'e2e', `${task.taskId}.json`);
  if (!requestedEvidence) fail('--evidenceにはパスが必要です');
  evidencePath = resolveRepoPath(root, requestedEvidence, 'E2E証跡');
} catch (error) {
  if (isGitIntegrityError(error) || !forceWithWarning) fail(error.message);
  completionWarnings.push(`E2E証跡: ${error.message}`);
}
let evidence = {};
let evidenceReadable = false;
if (evidencePath) {
  if (!existsSync(evidencePath)) {
    const error = `E2E証跡がありません: ${evidencePath}`;
    if (!forceWithWarning) fail(error);
    completionWarnings.push(error);
  } else {
    try {
      ensureRegularFile(evidencePath, 'E2E証跡');
      evidence = readJson(evidencePath);
      evidenceReadable = true;
    } catch (error) {
      if (!forceWithWarning) fail(`E2E証跡を読めません: ${error.message}`);
      completionWarnings.push(`E2E証跡を読めません: ${error.message}`);
    }
  }
}

let result;
let completionValidationPassed = false;
try {
  // git statusそのものを取得できない場合、同じ情報を使うE2Eの作業ツリー照合も
  // 「不一致」とは断定できない。理由付き例外のときだけ2つのhash照合を省略し、
  // 省略した項目はuncommittedChangesへ明記する。branch/HEADは読める限り実値を維持する。
  let gitIdentity;
  if (uncommittedInspectionError) {
    const branch = gitMetadataValue(['rev-parse', '--abbrev-ref', 'HEAD']);
    const gitHead = gitMetadataValue(['rev-parse', 'HEAD']);
    if (!branch || !gitHead) {
      fail('git statusの例外指定中も、現在のbranchとHEADを実測できなければ完了できません');
    }
    gitIdentity = { branch, gitHead, gitStatusHash: null, worktreeHash: null };
  }
  result = validateCompletion({ root, task, declaration, evidence, gitIdentity });
  completionValidationPassed = result.errors.length === 0;
} catch (error) {
  if (isGitIntegrityError(error) || !forceWithWarning) fail(error.message);
  completionWarnings.push(`完了検証を実行できません: ${error.message}`);
  result = { errors: [], git: { branch: '', gitHead: '', gitStatusHash: '', worktreeHash: '' } };
}
if (result.errors.length) {
  if (!forceWithWarning) fail(result.errors);
  completionWarnings.push(...result.errors.map((error) => `完了検証: ${error}`));
}
if (forceWithWarning && !completionValidationPassed) {
  const warning = blockedTestRunWarning(task, result.git.gitHead || currentGitIdentity(root).gitHead);
  if (warning) completionWarnings.push(warning);
}
if (forceWithWarning && completionWarnings.length === 0) {
  fail('通常の完了ゲートを通せる状態です。--force-with-warningは使わず、通常の完了ゲートで閉じてください');
}

const reviewProcess = collectReviewProcess(task);
// CMGB native focused の最終拒否。通常完了・--force-with-warning の双方で、
// 同batch全対象閉鎖・重要unknown0・両者実証跡が揃うまで完了させない。
const cmgbFocusedBlockers = cmgbFocusedCompletionBlockers(root, task);
if (cmgbFocusedBlockers.length > 0) {
  fail([
    'CMGB native focused の閉鎖条件を満たしていません',
    ...cmgbFocusedBlockers,
  ]);
}
let controllerCompletionProvenance = null;
if (reviewProcess?.codeReviewOutcome || reviewCycleRegistryExists(root) || cmgbIntakeCriterionPresent(root, task)) {
  try {
    controllerCompletionProvenance = assertCompletionAllowed(root, task, { declaration });
    if (controllerCompletionProvenance?.migration) {
      console.log(`REVIEW_CYCLE_MIGRATION_COMPLETION: ${controllerCompletionProvenance.migration}（根拠: ${controllerCompletionProvenance.basis}）`);
    }
  } catch (error) { if (error.message === 'REVIEW_CYCLE_PRACTICAL_PASS_REQUIRED') fail(['コードレビューの controller practical final が未確認です']); else throw error; }
}
const externalReviewIndex = join(root, '.ai', 'external-reviews', 'index.json');
// 外部経路の受理状態は review-evidence.mjs の externalReviewSettled を唯一の判定元にする。
// passed_with_unverified は通常経路と同じく「未確認事項を記録して完了」であり、止めない(R1 F1-2)。
// 別タスクと断定できる index だけを対象外にし、壊れた/識別欄の無い/旧 fingerprint の index は
// 自分の証跡として検査する(fail-closed。R3 E3-R2)。判定は reviewProcessSummary と同一関数。
const ownExternalReviewIndex = existsSync(externalReviewIndex)
  && externalIndexBelongsToTask(externalReviewIndex, task);
if (ownExternalReviewIndex && !externalReviewSettled(reviewProcess.codeReviewOutcome)) {
  fail(['外部レビュー証跡が現物と一致しません。完了・配布を保留します', ...reviewProcess.warnings]);
}
if (ownExternalReviewIndex && reviewProcess.codeReviewOutcome === 'passed_with_unverified') {
  console.log('EXTERNAL_REVIEW_UNVERIFIED: 外部レビューの未確認事項を記録して完了します（内容は warnings と reviewProcess に残ります）');
}

const verification = {
  schemaVersion: 1,
  // 通常ゲート通過。後追い完了(retrospective)と機械的に区別するために必ず入れる。
  closureKind: forceWithWarning ? WARNED_FORWARD_CLOSURE_KIND : GATED_CLOSURE_KIND,
  taskId: task.taskId,
  taskFingerprint: task.taskFingerprint,
  repo: String(task.repo || '').trim(),
  branch: result.git.branch,
  gitHead: result.git.gitHead,
  gitStatusHash: uncommittedInspectionError ? evidence?.gitStatusHash ?? null : result.git.gitStatusHash,
  worktreeHash: uncommittedInspectionError ? evidence?.worktreeHash ?? null : result.git.worktreeHash,
  verifiedAt: new Date().toISOString(),
  declaration: declarationPath,
  ...(forceWithWarning
    ? {
        evidence: evidenceReadable ? evidencePath : null,
        machineVerifiedE2e: evidenceReadable && completionValidationPassed,
        completionValidationPassed,
        completionWarnings,
      }
    : { evidence: evidencePath }),
  reviewStatus: declaration.review_status,
  e2eStatus: forceWithWarning ? String(declaration.e2e_status || '') : 'passed',
  approval: approvalResult.errors.length ? null : approvalResult.path,
  approvalContentHash: approvalResult.errors.length ? null : approvalResult.contentHash,
  uncommittedChanges,
  completionReference,
  reviewProcess,
  ...(controllerCompletionProvenance?.kind === 'cmgb-intake-only-terminal-provenance' ? { controllerCompletionProvenance } : {}),
  ...(controllerCompletionProvenance?.migration ? { reviewCycleCompletionProvenance: controllerCompletionProvenance } : {}),
  status: forceWithWarning ? 'passed_with_warnings' : 'passed',
  applied: false,
};
const verificationPath = join(root, '.ai', 'context', `completion-verification-${task.taskId}.json`);
atomicWriteJson(verificationPath, verification);
printReviewProcessWarnings(reviewProcess);
if (uncommittedInspectionError) {
  console.log(`COMPLETION_UNCOMMITTED_INSPECTION_UNAVAILABLE: ${uncommittedInspectionError}`);
}
if (uncommittedAllowed) {
  console.log(`COMPLETION_UNCOMMITTED_ALLOWED: ${uncommittedChanges.reason}`);
}

if (!apply) {
  if (forceWithWarning) {
    for (const warning of completionWarnings) console.log(`COMPLETION_WARNING: ${warning}`);
    console.log(`COMPLETION_GATE_PASSED_WITH_WARNINGS: ${verificationPath}`);
  } else {
    console.log(`COMPLETION_GATE_PASSED: ${verificationPath}`);
  }
  console.log('完了履歴へ移すには --apply を付けて再実行してください。');
  process.exit(0);
}

const now = new Date().toISOString();
const completedDir = join(dirname(declarationPath), 'completed');
const completedPath = join(completedDir, `${task.taskId}.md`);
mkdirSync(completedDir, { recursive: true });
const completedDirStat = lstatSync(completedDir);
if (!completedDirStat.isDirectory() || completedDirStat.isSymbolicLink()) fail('completedはsymlinkではない実ディレクトリが必要です');
try {
  lstatSync(completedPath);
  fail(`完了履歴が既に存在します: ${completedPath}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
let durableEvidencePath = verification.evidence || null;
let durableVerificationPath = verificationPath;
let preparedVerification = verification;
try {
  const copiedEvidence = copyCompletionEvidenceBundle({
    root,
    evidencePath: evidenceReadable ? evidencePath : null,
  });
  if (copiedEvidence.durableEvidencePath) durableEvidencePath = copiedEvidence.durableEvidencePath;
  preparedVerification = {
    ...verification,
    evidence: durableEvidencePath,
  };
  ({ durableVerificationPath } = writeCompletionVerificationCopies({
    root,
    verificationPath,
    value: preparedVerification,
  }));
} catch (error) {
  fail(`証跡を本体checkoutへ複製できません: ${error.message}`);
}
const updated = replaceDeclarationFields(declarationText, {
  status: 'done',
  phase: forceWithWarning ? 'completed_with_warnings' : 'completed',
  progress: '100',
  updated_at: forceWithWarning ? now.replace(/\.\d{3}Z$/, 'Z') : now,
  ...(uncommittedInspectionError
    ? {
        completion_identity_checks_skipped: uncommittedChanges.skippedIdentityChecks.join(','),
        completion_identity_reason: JSON.stringify(uncommittedReason),
      }
    : {}),
  ...(forceWithWarning
    ? {
        closure_kind: WARNED_FORWARD_CLOSURE_KIND,
        completion_warnings: completionWarningSummary(completionWarnings),
        ...(durableEvidencePath ? { e2e_evidence: durableEvidencePath } : {}),
      }
    : {
        e2e_status: 'passed',
        e2e_evidence: durableEvidencePath,
      }),
  completion_verification: durableVerificationPath,
});
const temp = `${declarationPath}.${process.pid}.tmp`;
writeFileSync(temp, updated, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
renameSync(temp, declarationPath);
renameSync(declarationPath, completedPath);
// 完了シグナルはこのapplied:true証跡とcompleted/履歴が正本。current-task.jsonには書き込まない。
// 解放目印はこの証跡の保存後だけ作るため、完了前のE2E証跡との照合には影響させない。
try {
  writeCompletionVerificationCopies({
    root,
    verificationPath,
    value: {
      ...preparedVerification,
      applied: true,
      appliedAt: now,
      completedDeclaration: completedPath,
    },
  });
} catch (error) {
  // 完了記録だけが先に残らないよう、宣言と検証JSONを適用前へ戻す。
  try {
    renameSync(completedPath, declarationPath);
    const rollback = `${declarationPath}.${process.pid}.rollback.tmp`;
    writeFileSync(rollback, declarationText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(rollback, declarationPath);
    writeCompletionVerificationCopies({ root, verificationPath, value: preparedVerification });
  } catch (rollbackError) {
    fail(`完了検証JSONの複製に失敗し、宣言の復元にも失敗しました: ${error.message}; 復元: ${rollbackError.message}`);
  }
  fail(`完了検証JSONを本体checkoutへ複製できません: ${error.message}`);
}
if (durableVerificationPath !== verificationPath) {
  console.log(`COMPLETION_EVIDENCE_PRESERVED: ${durableVerificationPath}`);
}
if (forceWithWarning) {
  for (const warning of completionWarnings) console.log(`COMPLETION_WARNING: ${warning}`);
} else {
  const release = markCompletedWorktreeReleased(task.taskId, now);
  if (release.warning) console.log(`WORKTREE_RELEASE_WARNING: ${release.warning}`);
  if (release.skipped) console.log(`WORKTREE_RELEASE_SKIPPED: ${release.skipped}`);
  console.log(`COMPLETION_APPLIED: ${completedPath}`);
}

// Herdrペイン片付け(best-effort)。cc-close.shの成否はai:completeの成功可否を変えない。
if (process.env.AI_COMPLETE_SKIP_HERDR_CLEANUP) {
  console.log('HERDR_CLEANUP: skipped(env)');
} else {
  const projectsRoot = process.env.PROJECTS_ROOT || join(homedir(), 'projects');
  const ccClose = join(projectsRoot, 'knowledge', 'scripts', 'cc-close.sh');
  const repo = String(task.repo || '').trim();
  if (!repo) {
    console.log('HERDR_CLEANUP: skipped(repo unavailable)');
  } else if (!existsSync(ccClose)) {
    console.log('HERDR_CLEANUP: skipped(cc-close not found)');
  } else {
    const closeResult = spawnSync('bash', [ccClose, repo], { encoding: 'utf8', timeout: 90_000 });
    const closeStdoutLines = String(closeResult.stdout || '').trim().split('\n').filter(Boolean);
    if (closeResult.status === 0) {
      const summary = closeStdoutLines.slice(-1)[0] || 'ok';
      console.log(`HERDR_CLEANUP: ${summary}`);
    } else if (closeResult.status === 2 && closeStdoutLines.includes('NO_MATCH')) {
      // 対象ペイン0件(herdr-cleanup-policy.pyのNO_MATCH)は片付け失敗ではなく「閉じるものがない」成功系。
      console.log('HERDR_CLEANUP: no panes(片付け対象なし)');
    } else {
      const code = closeResult.status === null ? (closeResult.signal || 'timeout') : closeResult.status;
      console.log(`HERDR_CLEANUP: incomplete(exit=${code}) — 手動: bash ~/projects/knowledge/scripts/cc-close.sh ${repo}`);
    }
  }
}
if (forceWithWarning) console.log(`COMPLETION_APPLIED_WITH_WARNINGS: ${completedPath}`);
