#!/usr/bin/env node
import { existsSync, mkdirSync, rmdirSync, rmSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { atomicWriteJson, ensureRegularFile, readJson, resolveRepoPath, safeId } from './ai-e2e-lib.mjs';
import { CASE_BINDING_APPROVAL_KIND, loadState, planHashOfPlan, readPlan, revalidateCollectedResult, resolveCaseDir, sha256File, validateApproval, validateEvidenceManifest, withCaseLock } from './ai-task-continuity-lib.mjs';
import { validateCaseReviewRawEvidence } from './ai-task-case-review-evidence.mjs';

function fail(message) { throw new Error(`TASK_CASE_COMPLETION_ERROR: ${message}`); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
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
      return { ok: true, completionPath: completionRel, completionSha256: sha256File(completionAbs), manifestPath: manifestRel, manifestSha256: sha256File(manifestAbs) };
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
if (process.argv[1]?.endsWith('ai-task-case-completion.mjs')) {
  try { process.stdout.write(`${JSON.stringify(main(), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}