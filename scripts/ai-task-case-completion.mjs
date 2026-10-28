#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, ensureRegularFile, readJson, resolveRepoPath, safeId } from './ai-e2e-lib.mjs';
import { CASE_BINDING_APPROVAL_KIND, loadState, planHashOfPlan, readPlan, revalidateCollectedResult, resolveCaseDir, sha256File, validateApproval, validateEvidenceManifest, withCaseLock } from './ai-task-continuity-lib.mjs';
import { validateCaseReviewRawEvidence } from './ai-task-case-review-evidence.mjs';

function fail(message) { throw new Error(`TASK_CASE_COMPLETION_ERROR: ${message}`); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// --- 完了の経路でも関所を見る(W4b) -----------------------------------------
// 本番反映しないレーンは deploy-gate.sh を通らないので、これまで関所に見られなかった。
// ここでは関所そのもの(scripts/review-evidence-gate.mjs)を呼ぶだけで、新しい台帳・新しい判定器は作らない。
// 止めるかどうかも関所の契約をそのまま使う: 関所は report_only では判定が「止める」でも必ず終了状態 0 で、
// enforce のときだけ止める(1)/未確認(2)で 0 以外になる。つまり 0 以外のときだけ完了を止める。
const REVIEW_EVIDENCE_GATE_COMPLETION_PREFIX = 'REVIEW_EVIDENCE_GATE_COMPLETION';
const REVIEW_EVIDENCE_GATE_SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
function reviewEvidenceGateScriptPath() { return resolve(REVIEW_EVIDENCE_GATE_SCRIPTS_DIR, 'review-evidence-gate.mjs'); }
function reviewEvidenceGateConfigPath() {
  return process.env.REVIEW_EVIDENCE_GATE_CONFIG
    || resolve(REVIEW_EVIDENCE_GATE_SCRIPTS_DIR, '..', 'config', 'review-evidence-gate.json');
}
function readJsonIfPossible(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
// 設定(config/review-evidence-gate.json)の repos から、この repo の取り込み先の先端(baseRef)を引く。
// 見つけ方は関所の resolveRepo と同じ(絶対パスの一致を先に、次にディレクトリ名の一致)。
function reviewEvidenceGateBaseRef(root) {
  const config = readJsonIfPossible(reviewEvidenceGateConfigPath());
  const repos = Array.isArray(config?.repos) ? config.repos : [];
  const target = resolve(root);
  const directory = basename(target);
  const candidatesOf = (repo) => [repo?.name, ...(Array.isArray(repo?.paths) ? repo.paths : [])]
    .filter((value) => typeof value === 'string' && value);
  for (const repo of repos) {
    for (const candidate of candidatesOf(repo)) {
      if (isAbsolute(candidate) && (resolve(candidate) === target || candidate === target)) return repo.baseRef || null;
    }
  }
  for (const repo of repos) {
    for (const candidate of candidatesOf(repo)) {
      if (!isAbsolute(candidate) && candidate === directory) return repo.baseRef || null;
    }
  }
  return null;
}
function oneLineText(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
// 関所は --json でも、enforce の印(REVIEW_EVIDENCE_GATE_ENFORCE_MARKER=...)や
// ディレクトリ名の一致(REVIEW_EVIDENCE_GATE_REPO_MATCH=...)を JSON の前に 1 行出す。
// 先頭から JSON.parse せず、JSON の始まりの行(単独の "{")から最後までを読む。
function parseGateJson(stdout) {
  const lines = String(stdout ?? '').split('\n');
  const start = lines.findIndex((line) => line.trim() === '{');
  if (start < 0) return null;
  try { return JSON.parse(lines.slice(start).join('\n')); } catch { return null; }
}
// 関所の判定を 1 行にまとめる(出力に残す根拠)。判定が読めないときは available=0 として残す。
export function evaluateCompletionReviewEvidenceGate(root, options = {}) {
  const spawn = typeof options.spawn === 'function' ? options.spawn : spawnSync;
  const repoRoot = resolve(root);
  const baseRef = reviewEvidenceGateBaseRef(repoRoot) || 'HEAD';
  const range = `${baseRef}..HEAD`;
  const args = [reviewEvidenceGateScriptPath(), 'check', '--repo', repoRoot, '--range', range, '--json'];
  let result;
  try {
    result = spawn(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
  } catch (error) {
    result = { status: null, stdout: '', stderr: '', error };
  }
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  const payload = parseGateJson(stdout);
  const available = payload !== null && typeof payload === 'object';
  const status = typeof result?.status === 'number' ? result.status : null;
  const judgment = available ? String(payload.judgment || 'unknown') : 'unavailable';
  const mode = available ? String(payload.mode || 'unknown') : 'unknown';
  // 関所の契約のまま: 0 以外の終了状態のときだけ止める(report_only では関所が必ず 0 で終わる)。
  const blocked = available && status !== null && status !== 0;
  const counts = available && payload.counts && typeof payload.counts === 'object' ? payload.counts : {};
  const problems = available && Array.isArray(payload.units)
    ? payload.units.flatMap((unit) => (Array.isArray(unit?.detail?.problems) ? unit.detail.problems : []))
    : [];
  // 区分の数え方は関所の本文と同じ(snake_case の区分名)。
  const countPass = (counts.pass ?? 0) + (counts.exempt_user_quote ?? 0) + (counts.parent_decision ?? 0);
  const countStop = (counts.missing_record ?? 0) + (counts.missing_rounds ?? 0) + (counts.findings_verdict ?? 0)
    + (counts.outcome_unclosed ?? 0) + (counts.tail_unreviewed ?? 0);
  const countUnverified = (counts.unbound_record ?? 0) + (counts.unverified_record ?? 0);
  // 対象なし・読めないときの units は commit を持たない入れ物なので、commit のある単位だけを対象数にする。
  const unitCount = available && Array.isArray(payload.units)
    ? payload.units.filter((unit) => unit && unit.commit).length
    : 0;
  const parts = [
    `${REVIEW_EVIDENCE_GATE_COMPLETION_PREFIX}=${judgment}`,
    `mode=${mode}`,
    `range=${range}`,
    `repo=${available ? (payload.repo || '(不明)') : '(読めない)'}`,
    `targets=${unitCount}`,
    `pass=${countPass}`,
    `stop=${countStop}`,
    `unverified=${countUnverified}`,
    `exit_would_be=${available ? (payload.exitWouldBe ?? '') : ''}`,
    `blocked=${blocked ? 1 : 0}`,
  ];
  if (!available) {
    parts.push(`available=0`);
    parts.push(`reason=${oneLineText(result?.error?.message || stderr || '関所の出力を読めない')}`);
  } else if (problems.length > 0) {
    parts.push(`reason=${oneLineText(problems.join(' / '))}`);
  }
  return {
    available,
    judgment,
    mode,
    range,
    blocked,
    exitStatus: status,
    exitWouldBe: available ? payload.exitWouldBe ?? null : null,
    counts,
    problems,
    line: parts.join(' '),
  };
}
// --- 登録漏れの監査(新しいレーンが関所の対象になっているか) -----------------
// 関所の設定 repos は静的な列挙なので、新しく作ったレーンは誰かが登録するまで「設定に無い repo です」=
// 未確認のままになる。完了の経路で監査を 1 行だけ残す。mode: report_only の思想に合わせて止めはしない
// (止めるかどうかは関所の契約に任せ、ここは見落としに気づくための報告だけを行う)。
const REVIEW_EVIDENCE_REGISTRY_AUDIT_PREFIX = 'REVIEW_EVIDENCE_REGISTRY_AUDIT';
function reviewEvidenceRegistryAuditScriptPath() {
  return resolve(REVIEW_EVIDENCE_GATE_SCRIPTS_DIR, 'review-evidence-registry-audit.mjs');
}
export function evaluateCompletionRegistryAudit(options = {}) {
  const spawn = typeof options.spawn === 'function' ? options.spawn : spawnSync;
  const args = [reviewEvidenceRegistryAuditScriptPath()];
  let result;
  try {
    result = spawn(process.execPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000 });
  } catch (error) {
    result = { status: null, stdout: '', stderr: '', error };
  }
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  const exitStatus = typeof result?.status === 'number' ? result.status : null;
  const line = stdout.split('\n').find((item) => item.startsWith(`${REVIEW_EVIDENCE_REGISTRY_AUDIT_PREFIX}=`)) || null;
  if (line) return { available: true, line, exitStatus };
  return {
    available: false,
    line: `${REVIEW_EVIDENCE_REGISTRY_AUDIT_PREFIX}=unavailable reason=${oneLineText(result?.error?.message || stderr || '監査の出力を読めない')}`,
    exitStatus,
  };
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) fail(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`missing value for ${arg}`);
    out[key] = value;
    i += 1;
  }
  return out;
}
function required(args, key) { const value = args[key]; if (typeof value !== 'string' || !value.trim()) fail(`--${key} is required`); return value; }
function repoRelative(root, requested, label) {
  const abs = resolveRepoPath(root, requested, label);
  ensureRegularFile(abs, label);
  return { abs, rel: relative(root, abs).split(sep).join('/') };
}
function currentTaskReviewerId(root, plan) {
  const currentTaskPath = resolveRepoPath(root, '.ai/current-task.json', 'current-task.json');
  ensureRegularFile(currentTaskPath, 'current-task.json');
  const currentTask = readJson(currentTaskPath);
  if (currentTask.taskId !== plan.taskId) fail('current-task.json taskId mismatch');
  if (currentTask.taskFingerprint !== plan.taskFingerprint) fail('current-task.json taskFingerprint mismatch');
  if (plan.repo !== undefined && currentTask.repo !== undefined && currentTask.repo !== plan.repo) fail('current-task.json repo mismatch');
  if (plan.branch !== undefined && currentTask.branch !== undefined && currentTask.branch !== plan.branch) fail('current-task.json branch mismatch');
  const reviewerId = currentTask.reviewer?.id;
  if (typeof reviewerId !== 'string' || !reviewerId.trim()) fail('current-task.json reviewer.id required');
  return reviewerId;
}
export function produce(args) {
  const root = resolve(required(args, 'repo'));
  const caseRelative = required(args, 'case');
  const taskId = required(args, 'task-id');
  const caseDir = resolveCaseDir(root, caseRelative);
  return withCaseLock(caseDir, () => {
    const plan = readPlan(caseDir);
    const state = loadState(caseDir);
    if (state.planHash !== planHashOfPlan(plan)) fail('state planHash mismatch');
    if (state.caseId !== plan.caseId) fail('state caseId mismatch');
    if (state.taskId !== plan.taskId) fail('state taskId mismatch');
    if (state.taskFingerprint !== plan.taskFingerprint) fail('state taskFingerprint mismatch');
    const task = state.tasks[taskId];
    if (!task) fail('task not found in state');
    if (!['RESULT_READY', 'VERIFYING'].includes(task.state)) fail('task is not RESULT_READY');
    const planTask = plan.tasks.find((item) => item.id === taskId);
    if (!planTask) fail('task not found in plan');
    if (!task.resultSha || !task.inputRef || !task.artifactRef) fail('task result/input/artifact missing');
    const approval = validateApproval({ root, plan });
    if (plan.approvalRef?.kind !== CASE_BINDING_APPROVAL_KIND || !approval.sourceApproval) fail('case binding approval required');
    if (task.leaseOwner !== approval.doc.owner) fail('task owner must match case binding approval owner');
    revalidateCollectedResult({ root, caseDir, state, task });
    const assignedReviewer = currentTaskReviewerId(root, plan);
    const candidateSha = task.candidateSha || planTask.candidateSha;
    const binding = {
      caseId: plan.caseId,
      taskId: plan.taskId,
      continuityTaskId: task.id,
      taskFingerprint: plan.taskFingerprint,
      candidateSha,
      approvalSha256: approval.sha256,
      resultSha: task.resultSha,
      inputSha256: task.inputRef.sha256,
      artifactSha256: task.artifactRef.sha256,
      messageId: task.messageId,
      executionNonce: task.executionNonce,
      generation: task.generation,
      attempt: task.attempt,
      owner: task.leaseOwner,
    };
    const reviewRaw = repoRelative(root, required(args, 'review-raw'), 'review raw');
    const reviewRequest = repoRelative(root, required(args, 'review-request'), 'review request');
    const review = validateCaseReviewRawEvidence({
      root,
      binding,
      reviewRawRef: { path: reviewRaw.rel, sha256: sha256File(reviewRaw.abs) },
      requestRef: { path: reviewRequest.rel, sha256: sha256File(reviewRequest.abs) },
      expectedReviewer: assignedReviewer,
    });
    const evidenceArgs = {
      test: repoRelative(root, required(args, 'test'), 'test evidence'),
      review: repoRelative(root, required(args, 'review'), 'review evidence'),
      parentcheck: repoRelative(root, required(args, 'parentcheck'), 'parentcheck evidence'),
      dotcheck: repoRelative(root, required(args, 'dotcheck'), 'dotcheck evidence'),
    };
    const evidenceDir = resolveRepoPath(root, `.ai/requests/${plan.caseId}/evidence`, 'case evidence dir');
    let createdEvidenceDir = false;
    if (!existsSync(evidenceDir)) {
      mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
      createdEvidenceDir = true;
    }
    const safeTaskId = safeId(task.id, 'continuityTaskId');
    const completionRel = `.ai/requests/${plan.caseId}/evidence/case-native-completion-${safeTaskId}.json`;
    const completionAbs = resolveRepoPath(root, completionRel, 'case native completion');
    const instructionRef = planTask.instructionRef || plan.instructionRef || null;
    const completionDoc = {
      schemaVersion: 1,
      kind: 'case_native_completion_record',
      ...binding,
      closureKind: 'case_scoped_native',
      status: 'passed',
      applied: true,
      workerSha256: planTask.command?.workerSha256 || null,
      instructionRef: instructionRef ? { ...instructionRef } : null,
      sourceApproval: {
        path: approval.doc.sourceApproval.path,
        sha256: approval.sourceApproval.sha256File,
        contentHash: approval.sourceApproval.contentHash,
        recordHash: approval.sourceApproval.recordHash,
      },
      reviewRaw: {
        path: review.rawPath,
        sha256: review.rawSha256,
        provider: review.provider,
        model: review.model,
        effort: review.effort,
        originalBodyHash: review.originalBodyHash,
      },
      reviewRequest: { path: review.requestPath, sha256: review.requestSha256 },
      reviewer: review.reviewer,
      independent: true,
      reviewVerdict: 'passed',
      producer: 'ai-task-case-completion@1',
    };
    const created = [];
    const writeOrReuse = (abs, doc) => {
      if (existsSync(abs)) {
        if (canonicalJson(readJson(abs)) !== canonicalJson(doc)) fail(`${relative(root, abs)} already exists with different inputs`);
        return false;
      }
      atomicWriteJson(abs, doc);
      created.push(abs);
      return true;
    };
    try {
      // 完了を確定する前に、この repo の取り込み先..HEAD を関所に見せる(本番反映しないレーンを素通りさせない)。
      // report_only では関所が 0 で終わるので blocked にならず、判定と根拠だけを出力に残す。
      const reviewEvidenceGate = evaluateCompletionReviewEvidenceGate(root);
      if (reviewEvidenceGate.blocked) {
        fail(`review evidence gate blocked completion: ${reviewEvidenceGate.line}`);
      }
      // 関所の判定の近くで、設定に未登録のレーンが無いかも 1 行だけ残す(止めはしない)。
      const registryAudit = evaluateCompletionRegistryAudit();
      writeOrReuse(completionAbs, completionDoc);
      const completionSha = sha256File(completionAbs);
      const completionEvidenceRel = `.ai/requests/${plan.caseId}/evidence/completion-${safeTaskId}.json`;
      const completionEvidenceAbs = resolveRepoPath(root, completionEvidenceRel, 'completion evidence');
      const completionEvidenceDoc = {
        schemaVersion: 1,
        kind: 'completion_evidence',
        ...binding,
        passed: true,
        gated: true,
        applied: true,
        completedDeclaration: { native: true, nativeCompletionRef: { path: completionRel, sha256: completionSha, kind: 'case_native_completion_record' } },
        actualEvidence: [{ path: completionRel, sha256: completionSha, kind: 'case_native_completion_record' }],
      };
      writeOrReuse(completionEvidenceAbs, completionEvidenceDoc);
      const manifestRel = `.ai/requests/${plan.caseId}/evidence/case-native-completion-manifest-${safeTaskId}.json`;
      const manifestAbs = resolveRepoPath(root, manifestRel, 'case native completion manifest');
      const manifest = { schemaVersion: 1, kind: 'evidence_manifest', ...binding };
      manifest.completion = { path: completionEvidenceRel, sha256: sha256File(completionEvidenceAbs) };
      manifest.test = { path: evidenceArgs.test.rel, sha256: sha256File(evidenceArgs.test.abs) };
      manifest.review = { path: evidenceArgs.review.rel, sha256: sha256File(evidenceArgs.review.abs) };
      manifest.parentcheck = { path: evidenceArgs.parentcheck.rel, sha256: sha256File(evidenceArgs.parentcheck.abs) };
      manifest.dotcheck = { path: evidenceArgs.dotcheck.rel, sha256: sha256File(evidenceArgs.dotcheck.abs) };
      validateEvidenceManifest({ root, manifest, task, plan, approval });
      writeOrReuse(manifestAbs, manifest);
      return {
        ok: true,
        completionPath: completionRel,
        completionSha256: sha256File(completionAbs),
        manifestPath: manifestRel,
        manifestSha256: sha256File(manifestAbs),
        reviewEvidenceGate: {
          judgment: reviewEvidenceGate.judgment,
          mode: reviewEvidenceGate.mode,
          range: reviewEvidenceGate.range,
          blocked: reviewEvidenceGate.blocked,
          line: reviewEvidenceGate.line,
        },
        registryAudit: {
          available: registryAudit.available,
          exitStatus: registryAudit.exitStatus,
          line: registryAudit.line,
        },
      };
    } catch (error) {
      for (const file of created.reverse()) rmSync(file, { force: true });
      if (createdEvidenceDir) {
        try { rmdirSync(evidenceDir); } catch { /* ignore non-empty or already removed */ }
      }
      throw error;
    }
  });
}
function main() { return produce(parseArgs(process.argv.slice(2))); }
// 完了の出力(JSON + 関所の判定 1 行 + 登録漏れの監査 1 行)。関所の 1 行は最後のままにする。
// 監査の行が無いときは出さない(古い呼び出し側の出力を変えない)。
export function completionStdout(result) {
  const lines = [JSON.stringify(result, null, 2)];
  if (typeof result?.registryAudit?.line === 'string') lines.push(result.registryAudit.line);
  if (typeof result?.reviewEvidenceGate?.line === 'string') lines.push(result.reviewEvidenceGate.line);
  return `${lines.join('\n')}\n`;
}
if (process.argv[1]?.endsWith('ai-task-case-completion.mjs')) {
  try { process.stdout.write(completionStdout(main())); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}