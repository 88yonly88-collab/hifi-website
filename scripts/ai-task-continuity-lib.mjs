import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { atomicWriteJson, ensureRegularFile, readJson, safeId, resolveRepoPath } from './ai-e2e-lib.mjs';
import { approvalContentHash } from './ai-approval-lib.mjs';
import { acquireReviewRequestFileLock, releaseReviewRequestFileLock } from './ai-runtime-evidence-lib.mjs';

const require = createRequire(import.meta.url);

export const TASK_CONTINUITY_SCHEMA_VERSION = 1;
export const TASK_CONTINUITY_PLAN_KIND = 'task_continuity_plan';
export const TASK_CONTINUITY_STATE_KIND = 'task_continuity_state';
export const RECEIPT_KINDS = Object.freeze(['worker_inbox_receipt','worker_start_receipt','worker_result_receipt']);
export const EVIDENCE_KINDS = Object.freeze(['completion','test','review','parentcheck','dotcheck']);
export const TERMINAL_STATES = Object.freeze(['DONE','FAILED','CANCELED']);
export const STOP_STATES = Object.freeze(['WAITING_APPROVAL','BLOCKED_CAPABILITY','BLOCKED_BUDGET','BLOCKED_DEPENDENCY','UNKNOWN','FAILED','CANCELED']);
export const CASE_BINDING_APPROVAL_KIND = 'case_binding';
export const TRANSITIONS = Object.freeze({
  PLANNED: ['READY','WAITING_APPROVAL','BLOCKED_DEPENDENCY','BLOCKED_BUDGET','BLOCKED_CAPABILITY','CANCELED'],
  READY: ['SUBMITTED','WAITING_APPROVAL','BLOCKED_DEPENDENCY','BLOCKED_BUDGET','BLOCKED_CAPABILITY','CANCELED'],
  SUBMITTED: ['RECEIVED','UNKNOWN','FAILED','CANCELED'],
  RECEIVED: ['RUNNING','UNKNOWN','FAILED','CANCELED'],
  RUNNING: ['RESULT_READY','UNKNOWN','FAILED','CANCELED'],
  RESULT_READY: ['VERIFYING','FAILED'],
  VERIFYING: ['DONE','FAILED'],
  DONE: [],
  WAITING_APPROVAL: ['READY','CANCELED'],
  BLOCKED_CAPABILITY: ['READY','CANCELED'],
  BLOCKED_BUDGET: ['READY','CANCELED'],
  BLOCKED_DEPENDENCY: ['READY','CANCELED'],
  UNKNOWN: ['READY','FAILED','CANCELED'],
  FAILED: [],
  CANCELED: [],
});

const ACTIVE_RECOVERABLE_STATES = new Set(['SUBMITTED','RECEIVED','RUNNING','RESULT_READY','VERIFYING','UNKNOWN']);
const ACTUAL_EVIDENCE_KIND_MAP = Object.freeze({
  completion: ['native_completion_record','completion_record','completion_result'],
  test: ['test_result','test_record'],
  review: ['review_result','review_record'],
  parentcheck: ['parentcheck_result','parentcheck_record'],
  dotcheck: ['dotcheck_result','dotcheck_record'],
});

function fail(message) {
  throw new Error(`TASK_CONTINUITY_ERROR: ${message}`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Text(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertNonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
  return value;
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function validateInstructionRef(ref, label) {
  assertObject(ref, label);
  assertNonEmpty(ref.path, `${label}.path`);
  assertNonEmpty(ref.sha256, `${label}.sha256`);
  if (!/^[a-f0-9]{64}$/i.test(ref.sha256)) fail(`${label}.sha256 must be a sha256 hex digest`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertPathInsideRealRoot(rootReal, targetAbs, label) {
  const rel = relative(rootReal, targetAbs);
  if (rel === '') return;
  if (rel.startsWith('..') || isAbsolute(rel)) fail(`${label} escapes root`);
  let current = rootReal;
  for (const part of rel.split(sep)) {
    if (!part || part === '.') continue;
    current = join(current, part);
    if (existsSync(current)) {
      const real = realpathSync(current);
      if (!isInside(rootReal, real)) fail(`${label} ancestor symlink escape`);
    }
  }
  if (existsSync(targetAbs)) {
    const real = realpathSync(targetAbs);
    if (!isInside(rootReal, real)) fail(`${label} symlink escape`);
  }
}

function safeRepoPath(root, rel, label) {
  const rootReal = realpathSync(root);
  const abs = resolveRepoPath(rootReal, rel, label);
  assertPathInsideRealRoot(rootReal, abs, label);
  return abs;
}

function safeCasePath(caseDir, rel, label) {
  const caseReal = realpathSync(caseDir);
  const abs = resolve(caseReal, rel);
  if (!isInside(caseReal, abs)) fail(`${label} escapes case`);
  assertPathInsideRealRoot(caseReal, abs, label);
  return abs;
}

export function casePaths(caseDir) {
  return {
    state: safeCasePath(caseDir, 'state.json', 'state'),
    plan: safeCasePath(caseDir, 'plan.json', 'plan'),
    outbox: join(caseDir, 'outbox'),
    inbox: join(caseDir, 'inbox'),
    receipts: join(caseDir, 'receipts'),
    evidence: join(caseDir, 'evidence'),
    artifacts: join(caseDir, 'artifacts'),
  };
}

export function resolveCaseDir(root, caseRelative) {
  const repoReal = realpathSync(root);
  assertNonEmpty(caseRelative, 'case');
  if (!caseRelative.startsWith('.ai/requests/')) fail('case path is unsafe or must be under .ai/requests/');
  if (caseRelative.split('/').includes('..') || isAbsolute(caseRelative)) fail('case path is unsafe');
  const absolute = resolve(repoReal, caseRelative);
  if (!isInside(repoReal, absolute)) fail('case escapes repo');
  if (existsSync(absolute)) {
    assertPathInsideRealRoot(repoReal, absolute, 'case');
    const real = realpathSync(absolute);
    if (!isInside(repoReal, real)) fail('case symlink escape');
  }
  return absolute;
}

export function planHashOfPlan(plan) {
  return sha256Text(canonicalJson(plan));
}

// Stable approval-derived plan hash. Binding-only approvalRef fields (kind, sha256) are excluded so
// plan identity survives case-binding approvalRef updates while task/command/scope identity is intact.
export function planApprovalHash(plan) {
  const copy = { ...plan, approvalRef: { path: plan.approvalRef?.path } };
  return sha256Text(canonicalJson(copy));
}

export function planCommandHash(plan) {
  return sha256Text(canonicalJson(plan.tasks.map((task) => ({
    id: task.id,
    instructionVersion: task.instructionVersion || plan.instructionVersion,
    command: task.command ? { argv: task.command.argv, workerSha256: task.command.workerSha256 } : null,
  }))));
}

export function planScopeHash(plan) {
  return sha256Text(canonicalJson({
    taskId: plan.taskId,
    taskFingerprint: plan.taskFingerprint,
    instructionVersion: plan.instructionVersion,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      candidateSha: task.candidateSha || null,
      deps: task.deps,
    })),
  }));
}

export function computeCommandHash(command) {
  return sha256Text(canonicalJson({
    execPath: command.execPath,
    workerRel: command.workerRel,
    args: command.args,
    workerSha256: command.workerSha256,
  }));
}

export function readPlan(caseDir) {
  const plan = readJson(casePaths(caseDir).plan);
  return validatePlan(plan);
}

export function validatePlan(plan) {
  assertObject(plan, 'plan');
  if (plan.schemaVersion !== TASK_CONTINUITY_SCHEMA_VERSION) fail('plan schemaVersion mismatch');
  if (plan.kind !== TASK_CONTINUITY_PLAN_KIND) fail('plan kind mismatch');
  safeId(plan.caseId, 'caseId');
  safeId(plan.taskId, 'taskId');
  assertNonEmpty(plan.taskFingerprint, 'taskFingerprint');
  assertNonEmpty(plan.instructionVersion, 'instructionVersion');
  if (!plan.approvalRef || typeof plan.approvalRef.path !== 'string') fail('plan approvalRef missing');
  if (plan.instructionRef !== undefined) validateInstructionRef(plan.instructionRef, 'plan.instructionRef');
  if (plan.releaseAuthority !== undefined) {
    assertObject(plan.releaseAuthority, 'releaseAuthority');
    assertNonEmpty(plan.releaseAuthority.issuer, 'releaseAuthority.issuer');
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) fail('plan tasks required');
  const ids = new Set();
  for (const task of plan.tasks) {
    assertObject(task, 'task');
    safeId(task.id, 'task.id');
    if (ids.has(task.id)) fail(`duplicate task ${task.id}`);
    ids.add(task.id);
    if (!Array.isArray(task.deps)) fail(`task ${task.id} deps must be array`);
    if (typeof task.candidateSha !== 'string' || !/^[a-f0-9]{40}$/i.test(task.candidateSha)) fail(`task ${task.id} candidateSha invalid`);
    if (task.instructionRef !== undefined) validateInstructionRef(task.instructionRef, `task ${task.id} instructionRef`);
    const effectiveInstructionVersion = task.instructionVersion || plan.instructionVersion;
    if (effectiveInstructionVersion === 'v1.1' && !(task.instructionRef || plan.instructionRef)) {
      fail(`task ${task.id} instructionRef required for v1.1`);
    }
    if (task.command !== undefined) {
      if (!task.command || !Array.isArray(task.command.argv) || task.command.argv.length < 2) fail(`task ${task.id} command argv required`);
      for (const arg of task.command.argv) if (typeof arg !== 'string' || !arg) fail(`task ${task.id} command argv invalid`);
      if (typeof task.command.workerSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(task.command.workerSha256)) fail(`task ${task.id} workerSha256 invalid`);
    }
  }
  for (const task of plan.tasks) {
    for (const dep of task.deps) if (!ids.has(dep)) fail(`task ${task.id} unknown dependency ${dep}`);
  }
  return plan;
}

export function loadState(caseDir) {
  const state = readJson(casePaths(caseDir).state);
  assertObject(state, 'state');
  if (state.schemaVersion !== TASK_CONTINUITY_SCHEMA_VERSION) fail('state schemaVersion mismatch');
  if (state.kind !== TASK_CONTINUITY_STATE_KIND) fail('state kind mismatch');
  return state;
}

function assertStateTasksMatchPlan(state, plan) {
  const planIds = new Set(plan.tasks.map((task) => task.id));
  for (const id of Object.keys(state.tasks)) {
    if (!planIds.has(id)) fail(`state has unknown task ${id}`);
  }
  for (const planTask of plan.tasks) {
    const task = state.tasks[planTask.id];
    if (!task) fail(`state missing plan task ${planTask.id}`);
    if (canonicalJson(task.deps) !== canonicalJson(planTask.deps)) fail(`state task ${planTask.id} deps mismatch`);
    const expectedInstructionVersion = planTask.instructionVersion || plan.instructionVersion;
    if (task.instructionVersion !== expectedInstructionVersion) fail(`state task ${planTask.id} instructionVersion mismatch`);
    const expectedInstructionRef = planTask.instructionRef || plan.instructionRef || null;
    if (canonicalJson(task.instructionRef || null) !== canonicalJson(expectedInstructionRef)) fail(`state task ${planTask.id} instructionRef mismatch`);
    const expectedUnits = Number(planTask.reservedUnits || 0);
    if (Number(task.reservedUnits || 0) !== expectedUnits) fail(`state task ${planTask.id} reservedUnits mismatch`);
    const expectedCandidate = planTask.candidateSha || null;
    if ((task.candidateSha || null) !== expectedCandidate) fail(`state task ${planTask.id} candidateSha mismatch`);
    const expectedCommand = planTask.command ? clone(planTask.command) : null;
    if (canonicalJson(task.command) !== canonicalJson(expectedCommand)) fail(`state task ${planTask.id} command mismatch`);
  }
}

function assertStateMatchesPlan(state, plan) {
  if (state.planHash !== planHashOfPlan(plan)) fail('state planHash mismatch');
  if (state.caseId !== plan.caseId) fail('state caseId mismatch');
  if (state.taskId !== plan.taskId) fail('state taskId mismatch');
  if (state.taskFingerprint !== plan.taskFingerprint) fail('state taskFingerprint mismatch');
  if (canonicalJson(state.stops || []) !== canonicalJson(plan.stops || [])) fail('state stops mismatch');
  assertStateTasksMatchPlan(state, plan);
}

export function saveState(caseDir, state, expectedValue) {
  atomicWriteJson(casePaths(caseDir).state, state, { expectedValue, label: 'state.json' });
}

export function withCaseLock(caseDir, fn) {
  const lockPath = join(caseDir, 'state.lock');
  const token = acquireReviewRequestFileLock(lockPath);
  try {
    return fn();
  } finally {
    releaseReviewRequestFileLock(lockPath, token);
  }
}

export function validateApproval({ root, plan, now = Date.now() }) {
  const ref = plan.approvalRef;
  assertObject(ref, 'approvalRef');
  assertNonEmpty(ref.path, 'approvalRef.path');
  assertNonEmpty(ref.sha256, 'approvalRef.sha256');
  if (ref.kind === CASE_BINDING_APPROVAL_KIND) {
    const { validateCaseBindingApproval } = require('./ai-task-case-binding.mjs');
    return validateCaseBindingApproval({ root, plan, now });
  }
  const absolute = safeRepoPath(root, ref.path, 'approval path');
  ensureRegularFile(absolute, 'approval');
  const actual = sha256File(absolute);
  if (actual !== ref.sha256) fail('approval sha256 mismatch');
  const doc = readJson(absolute);
  if (doc.status !== 'approved') fail('approval not approved');
  if (doc.taskId !== plan.taskId) fail('approval taskId mismatch');
  if (doc.taskFingerprint !== plan.taskFingerprint) fail('approval taskFingerprint mismatch');
  if (doc.instructionVersion !== undefined && doc.instructionVersion !== plan.instructionVersion) fail('approval instructionVersion mismatch');
  if (doc.expiresAt && Date.parse(doc.expiresAt) <= now) fail('approval expired');
  if (!doc.planHash || doc.planHash !== planApprovalHash(plan)) fail('approval planHash mismatch');
  if (!doc.commandHash || doc.commandHash !== planCommandHash(plan)) fail('approval commandHash mismatch');
  if (!doc.scopeHash || doc.scopeHash !== planScopeHash(plan)) fail('approval scopeHash mismatch');
  return { path: ref.path, sha256: actual, doc };
}

function currentTaskReviewerId(root, plan) {
  const currentTaskPath = safeRepoPath(root, '.ai/current-task.json', 'current-task.json');
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

function stopCovers(stop, taskId) {
  return stop && stop.scope && (stop.scope.all === true || (Array.isArray(stop.scope.taskIds) && stop.scope.taskIds.includes(taskId)));
}

function stopReleaseMatches({ root, state, stop, release, plan, now }) {
  if (!release || release.stopId !== stop.id) return false;
  if (!release.scopeHash) return false;
  const expectedScopeHash = sha256Text(canonicalJson(stop.scope));
  if (release.scopeHash !== expectedScopeHash) return false;
  if (!release.releaseRef || typeof release.releaseRef.path !== 'string' || typeof release.releaseRef.sha256 !== 'string') return false;
  const absolute = safeRepoPath(root, release.releaseRef.path, 'stop release');
  ensureRegularFile(absolute, 'stop release');
  if (sha256File(absolute) !== release.releaseRef.sha256) return false;
  const doc = readJson(absolute);
  if (doc.stopId !== stop.id || doc.released !== true || doc.scopeHash !== expectedScopeHash) return false;
  if (doc.caseId !== state.caseId) return false;
  if (doc.taskId !== state.taskId) return false;
  if (doc.taskFingerprint !== state.taskFingerprint) return false;
  if (doc.instructionVersion !== state.instructionVersion) return false;
  if (!plan || !plan.releaseAuthority || typeof plan.releaseAuthority.issuer !== 'string' || !plan.releaseAuthority.issuer.trim()) return false;
  if (typeof doc.authority !== 'string' || doc.authority !== plan.releaseAuthority.issuer) return false;
  if (doc.expiresAt && Date.parse(doc.expiresAt) <= now) return false;
  if (doc.approvalSha256 !== plan.approvalRef.sha256) return false;
  return true;
}

export function stopBlocking({ root, state, taskId, plan = null, now = Date.now() }) {
  for (const stop of state.stops || []) {
    if (!stopCovers(stop, taskId)) continue;
    const release = (state.stopReleases || []).find((item) => stopReleaseMatches({ root, state, stop, release: item, plan, now }));
    if (!release) return stop;
  }
  return null;
}

export function budgetAvailable(state, plan, task) {
  const units = Number(task.reservedUnits || 0);
  if (units === 0) return true;
  if (!plan.budget) return false;
  const spent = Number(state.counters?.spentUnits || 0);
  const reservations = state.budgetReservations || {};
  const reserved = Object.values(reservations).reduce((sum, value) => sum + Number(value || 0), 0);
  const ownReservation = Number(reservations[task.id] || 0);
  const additional = units - ownReservation;
  if (additional < 0) return false;
  return spent + reserved + additional <= Number(plan.budget.limit);
}

function hasOwnerLock(task) {
  return !!task.leaseOwner;
}

export function validateCommand({ root, caseDir, plan, task }) {
  const command = task.command;
  assertObject(command, 'command');
  const [execPath, workerRel, ...args] = command.argv;
  if (execPath !== process.execPath) fail('command must use pinned process.execPath');
  assertNonEmpty(workerRel, 'worker relative path');
  const workerAbs = safeCasePath(caseDir, workerRel, 'worker script');
  ensureRegularFile(workerAbs, 'worker script');
  const realWorker = realpathSync(workerAbs);
  if (!isInside(realpathSync(caseDir), realWorker)) fail('worker realpath escape');
  const workerSha256 = sha256File(realWorker);
  if (command.workerSha256 !== workerSha256) fail('worker sha256 mismatch');
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length > 512 || arg.includes('\r') || arg.includes('\n') || arg.includes('\0')) fail('unsafe command argument');
    if (arg.includes('..')) fail('unsafe command argument path');
    if (arg.includes('http://') || arg.includes('https://')) fail('network argument not allowed');
  }
  return { execPath, workerAbs: realWorker, workerRel, args, workerSha256 };
}

export function writeWorkerReceipt({ caseDir, messageId, kind, payload }) {
  if (!RECEIPT_KINDS.includes(kind)) fail('invalid receipt kind');
  safeId(messageId, 'messageId');
  const dir = safeCasePath(caseDir, join('receipts', messageId), 'receipt dir');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = kind.replace('worker_', '').replace('_receipt', '');
  const file = safeCasePath(caseDir, join('receipts', messageId, `${name}.json`), 'receipt file');
  if (existsSync(file)) fail('receipt already exists');
  const doc = { ...(payload || {}) };
  doc.schemaVersion = TASK_CONTINUITY_SCHEMA_VERSION;
  doc.kind = kind;
  doc.writtenAt = new Date().toISOString();
  doc.processId = process.pid;
  doc.execPath = process.execPath;
  doc.argv = process.argv.slice();
  atomicWriteJson(file, doc);
  return { path: file, sha256: sha256File(file) };
}

export function writeWorkerInboxReceipt(opts) {
  return writeWorkerReceipt({ ...opts, kind: 'worker_inbox_receipt' });
}

export function writeWorkerStartReceipt(opts) {
  return writeWorkerReceipt({ ...opts, kind: 'worker_start_receipt' });
}

export function writeWorkerResultReceipt(opts) {
  return writeWorkerReceipt({ ...opts, kind: 'worker_result_receipt' });
}

export function validateReceipt(receipt, expected) {
  assertObject(receipt, 'receipt');
  if (receipt.schemaVersion !== TASK_CONTINUITY_SCHEMA_VERSION) fail('receipt schemaVersion mismatch');
  if (receipt.kind !== expected.kind) fail('receipt kind mismatch');
  if (receipt.resultSha !== undefined && (typeof receipt.resultSha !== 'string' || !/^[a-f0-9]{40}$/i.test(receipt.resultSha))) fail('receipt resultSha must be pinned commit hash');
  for (const field of ['caseId','taskId','messageId','payloadHash','executionNonce','instructionVersion','owner','generation','attempt']) {
    if (expected[field] !== undefined && receipt[field] !== expected[field]) fail(`receipt ${field} mismatch`);
  }
  if (expected.resultSha !== undefined && receipt.resultSha !== expected.resultSha) fail('receipt resultSha mismatch');
  if (expected.baseSha !== undefined && receipt.baseSha !== expected.baseSha) fail('receipt baseSha mismatch');
  if (expected.artifactRefSha256 !== undefined && receipt.artifactRef?.sha256 !== expected.artifactRefSha256) fail('receipt artifactRef sha256 mismatch');
  if (expected.inputRefSha256 !== undefined && receipt.inputRef?.sha256 !== expected.inputRefSha256) fail('receipt inputRef sha256 mismatch');
  if (expected.processId !== undefined && receipt.processId !== expected.processId) fail('receipt processId mismatch');
  return receipt;
}

function validateArtifactRef(caseDir, ref, label) {
  assertObject(ref, label);
  assertNonEmpty(ref.path, `${label}.path`);
  assertNonEmpty(ref.sha256, `${label}.sha256`);
  const absolute = safeCasePath(caseDir, ref.path, label);
  ensureRegularFile(absolute, label);
  if (sha256File(absolute) !== ref.sha256) fail(`${label} sha256 mismatch`);
  return absolute;
}

function validateBindingFields(doc, binding, label) {
  for (const [field, value] of Object.entries(binding)) {
    if (doc[field] !== value) fail(`${label} ${field} mismatch`);
  }
}

function gitShaLike(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
}

function validateCaseNativeCompletionVerification({ root, doc, binding, ref }) {
  assertObject(doc, 'case native completion verification');
  if (doc.kind !== 'case_native_completion_record') fail('case native completion kind mismatch');
  if (doc.schemaVersion !== TASK_CONTINUITY_SCHEMA_VERSION) fail('case native completion schemaVersion mismatch');
  if (doc.closureKind !== 'case_scoped_native') fail('case native completion closureKind mismatch');
  if (doc.status !== 'passed' || doc.applied !== true) fail('case native completion not passed/applied');
  validateBindingFields(doc, binding, 'case native completion');
  const safeContinuityTaskId = safeId(binding.continuityTaskId, 'continuityTaskId');
  const expectedCompletionPath = `.ai/requests/${binding.caseId}/evidence/case-native-completion-${safeContinuityTaskId}.json`;
  if (ref.path !== expectedCompletionPath) fail('case native completion path mismatch');
  const caseDir = resolveCaseDir(root, `.ai/requests/${binding.caseId}`);
  const plan = readPlan(caseDir);
  if (plan.caseId !== binding.caseId) fail('case native completion plan caseId mismatch');
  if (plan.taskId !== binding.taskId) fail('case native completion plan taskId mismatch');
  if (plan.taskFingerprint !== binding.taskFingerprint) fail('case native completion plan taskFingerprint mismatch');
  const approval = validateApproval({ root, plan });
  if (approval.sha256 !== binding.approvalSha256) fail('case native completion approvalSha256 mismatch');
  if (plan.approvalRef?.kind !== CASE_BINDING_APPROVAL_KIND) fail('case native completion requires case binding approval');
  if (binding.owner !== approval.doc.owner) fail('case native completion owner mismatch with case binding approval');
  if (doc.owner !== approval.doc.owner) fail('case native completion record owner mismatch with case binding approval');
  const state = loadState(caseDir);
  const collectedTask = state.tasks[binding.continuityTaskId];
  if (!collectedTask) fail('case native completion collected task missing');
  revalidateCollectedResult({ root, caseDir, state, task: collectedTask });
  const source = approval.sourceApproval;
  assertObject(source, 'case native completion source approval');
  assertObject(doc.sourceApproval, 'case native completion sourceApproval');
  const authoritativeSourcePath = approval.doc.sourceApproval?.path;
  assertNonEmpty(authoritativeSourcePath, 'case native completion authoritative source path');
  if (doc.sourceApproval.path !== authoritativeSourcePath) fail('case native completion sourceApproval path mismatch');
  if (doc.sourceApproval.sha256 !== source.sha256File) fail('case native completion sourceApproval sha256 mismatch');
  if (doc.sourceApproval.contentHash !== source.contentHash) fail('case native completion sourceApproval contentHash mismatch');
  if (doc.sourceApproval.recordHash !== source.recordHash) fail('case native completion sourceApproval recordHash mismatch');
  const assignedReviewer = currentTaskReviewerId(root, plan);
  if (doc.reviewer !== assignedReviewer) fail('case native completion reviewer mismatch');
  const planTask = plan.tasks.find((task) => task.id === binding.continuityTaskId);
  if (!planTask) fail('case native completion plan task missing');
  if ((planTask.candidateSha || null) !== binding.candidateSha) fail('case native completion candidateSha mismatch');
  if (!planTask.command || planTask.command.workerSha256 !== doc.workerSha256) fail('case native completion workerSha256 mismatch');
  const instructionRef = planTask.instructionRef || plan.instructionRef || null;
  if (canonicalJson(doc.instructionRef || null) !== canonicalJson(instructionRef)) fail('case native completion instructionRef mismatch');
  if (instructionRef) {
    const instructionAbs = safeRepoPath(root, instructionRef.path, 'case native completion instruction');
    ensureRegularFile(instructionAbs, 'case native completion instruction');
    if (sha256File(instructionAbs) !== instructionRef.sha256) fail('case native completion instruction sha256 mismatch');
  }
  assertObject(doc.reviewRaw, 'case native completion reviewRaw');
  assertObject(doc.reviewRequest, 'case native completion reviewRequest');
  let reviewEvidenceModule;
  try {
    reviewEvidenceModule = require('./ai-task-case-review-evidence.mjs');
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' || /Cannot find module/.test(String(error?.message || ''))) {
      fail('case review evidence helper is not installed for this case-native validation');
    }
    throw error;
  }
  if (!reviewEvidenceModule || typeof reviewEvidenceModule.validateCaseReviewRawEvidence !== 'function') {
    fail('case review evidence helper export missing');
  }
  const review = reviewEvidenceModule.validateCaseReviewRawEvidence({
    root,
    binding,
    reviewRawRef: doc.reviewRaw,
    requestRef: doc.reviewRequest,
    expectedReviewer: assignedReviewer,
  });
  if (review.provider !== doc.reviewRaw.provider) fail('case native completion review provider mismatch');
  if (review.model !== doc.reviewRaw.model) fail('case native completion review model mismatch');
  if (review.effort !== doc.reviewRaw.effort) fail('case native completion review effort mismatch');
  if (review.originalBodyHash !== doc.reviewRaw.originalBodyHash) fail('case native completion review originalBodyHash mismatch');
  if (doc.reviewVerdict !== 'passed') fail('case native completion review verdict mismatch');
  if (doc.independent !== true) fail('case native completion independent required');
  if (!doc.reviewer || doc.reviewer === binding.owner) fail('case native completion reviewer invalid');
}

function validateNativeCompletionVerification({ root, doc, binding, ref }) {
  assertObject(doc, 'native completion verification');
  const expectedPath = `.ai/context/completion-verification-${binding.taskId}.json`;
  if (ref.path !== expectedPath) fail('completion actual evidence must be canonical ai-complete verification');
  if (doc.schemaVersion !== TASK_CONTINUITY_SCHEMA_VERSION) fail('native completion schemaVersion mismatch');
  if (doc.closureKind !== 'gated') fail('native completion must be gated');
  if (doc.status !== 'passed') fail('native completion not passed');
  if (doc.applied !== true) fail('native completion not applied');
  if (doc.taskId !== binding.taskId) fail('native completion taskId mismatch');
  if (doc.taskFingerprint !== binding.taskFingerprint) fail('native completion taskFingerprint mismatch');
  if (!gitShaLike(binding.resultSha) || doc.gitHead !== binding.resultSha) fail('native completion gitHead mismatch');
  if (!doc.approval || typeof doc.approval !== 'string') fail('native completion original approval path required');
  const canonicalApprovalAbs = safeRepoPath(root, '.ai/approval.json', 'native completion original approval');
  ensureRegularFile(canonicalApprovalAbs, 'native completion original approval');
  const nativeApprovalAbs = safeRepoPath(root, doc.approval, 'native completion approval path');
  ensureRegularFile(nativeApprovalAbs, 'native completion approval path');
  if (realpathSync(nativeApprovalAbs) !== realpathSync(canonicalApprovalAbs)) fail('native completion approval path is not canonical .ai/approval.json');
  const originalApproval = readJson(canonicalApprovalAbs);
  if (originalApproval.status !== 'approved') fail('native completion original approval not approved');
  if (originalApproval.taskId !== binding.taskId) fail('native completion original approval taskId mismatch');
  if (originalApproval.taskFingerprint !== binding.taskFingerprint) fail('native completion original approval taskFingerprint mismatch');
  const recomputedApprovalContentHash = approvalContentHash(originalApproval);
  if (!doc.approvalContentHash || typeof doc.approvalContentHash !== 'string') fail('native completion approvalContentHash required');
  if (doc.approvalContentHash !== recomputedApprovalContentHash) fail('native completion approvalContentHash mismatch');
  if (originalApproval.documentHash !== recomputedApprovalContentHash) fail('native completion documentHash mismatch');
  if (!doc.evidence || typeof doc.evidence !== 'string') fail('native completion evidence ref required');
  const evidenceAbs = safeRepoPath(root, doc.evidence, 'native completion evidence');
  ensureRegularFile(evidenceAbs, 'native completion evidence');
}

function validateActualEvidenceRef({ root, kind, ref, binding }) {
  assertObject(ref, `${kind} actualEvidence ref`);
  assertNonEmpty(ref.path, `${kind} actualEvidence.path`);
  assertNonEmpty(ref.sha256, `${kind} actualEvidence.sha256`);
  if (ref.kind !== undefined) assertNonEmpty(ref.kind, `${kind} actualEvidence.kind`);
  const refAbs = safeRepoPath(root, ref.path, `${kind} actual evidence`);
  ensureRegularFile(refAbs, `${kind} actual evidence`);
  if (sha256File(refAbs) !== ref.sha256) fail(`${kind} actual evidence sha256 mismatch`);
  const doc = readJson(refAbs);
  if (kind === 'completion') {
    if (doc.kind === 'case_native_completion_record' || ref.kind === 'case_native_completion_record') {
      validateCaseNativeCompletionVerification({ root, doc, binding, ref });
      return;
    }
    validateNativeCompletionVerification({ root, doc, binding, ref });
    return;
  }
  const allowed = ACTUAL_EVIDENCE_KIND_MAP[kind];
  if (!allowed.includes(doc.kind)) fail(`${kind} actual evidence kind mismatch`);
  validateBindingFields(doc, binding, `${kind} actual evidence`);
  if (kind === 'test') {
    if (doc.passed !== true || doc.exitCode !== 0) fail('test actual evidence failed');
    if (!doc.counts || doc.counts.total <= 0 || doc.counts.fail !== 0 || doc.counts.skipped !== 0) fail('test actual evidence counts invalid');
  } else if (kind === 'review') {
    if (doc.verdict !== 'passed' || doc.independent !== true) fail('review actual evidence not passed/independent');
    assertNonEmpty(doc.reviewer, 'review actual evidence reviewer');
    assertObject(doc.providerReceiptRef, 'review actual evidence providerReceiptRef');
    assertNonEmpty(doc.providerReceiptRef.path, 'review actual evidence providerReceiptRef.path');
    assertNonEmpty(doc.providerReceiptRef.sha256, 'review actual evidence providerReceiptRef.sha256');
    const providerAbs = safeRepoPath(root, doc.providerReceiptRef.path, 'review provider receipt');
    ensureRegularFile(providerAbs, 'review provider receipt');
    if (sha256File(providerAbs) !== doc.providerReceiptRef.sha256) fail('review provider receipt sha256 mismatch');
    const provider = readJson(providerAbs);
    validateBindingFields(provider, binding, 'review provider receipt');
    if (!provider.provider || typeof provider.provider !== 'string') fail('review provider receipt provider required');
    if (provider.verdict !== 'passed' || provider.independent !== true) fail('review provider receipt not passed/independent');
  } else {
    if (doc.status !== 'passed') fail(`${kind} actual evidence not passed`);
    assertNonEmpty(doc.checkedBy, `${kind} actual evidence checkedBy`);
    assertNonEmpty(doc.checkedAt, `${kind} actual evidence checkedAt`);
  }
}

export function createStateFromPlan(plan) {
  const now = new Date().toISOString();
  const tasks = {};
  for (const task of plan.tasks) {
    tasks[task.id] = {
      id: task.id,
      title: task.title || task.id,
      owner: task.owner || plan.owner || null,
      deps: [...task.deps],
      instructionVersion: task.instructionVersion || plan.instructionVersion,
      instructionRef: task.instructionRef || plan.instructionRef || null,
      approvalRef: task.approvalRef || plan.approvalRef,
      budgetId: task.budgetId || plan.budget?.id || null,
      reservedUnits: Number(task.reservedUnits || 0),
      candidateSha: task.candidateSha || null,
      command: task.command ? clone(task.command) : null,
      state: 'PLANNED',
      attempt: 0,
      generation: 0,
      dispatchCount: 0,
      leaseOwner: null,
      leaseUntil: null,
      fencingToken: 0,
      processId: null,
      outboxRef: null,
      inboxRef: null,
      executionRef: null,
      resultRef: null,
      resultSha: null,
      baseSha: null,
      artifactRef: null,
      inputRef: null,
      blockedReason: null,
      nextOwner: null,
      nextAction: null,
      nextDueAt: null,
      createdAt: now,
      updatedAt: now,
      progress: null,
    };
  }
  return {
    schemaVersion: TASK_CONTINUITY_SCHEMA_VERSION,
    kind: TASK_CONTINUITY_STATE_KIND,
    caseId: plan.caseId,
    taskId: plan.taskId,
    taskFingerprint: plan.taskFingerprint,
    instructionVersion: plan.instructionVersion,
    planHash: planHashOfPlan(plan),
    state: 'PLANNED',
    owner: plan.owner || null,
    generation: 0,
    attempt: 0,
    tasks,
    outbox: {},
    inbox: {},
    counters: {},
    budgetReservations: {},
    stops: plan.stops || [],
    stopReleases: plan.stopReleases || [],
    createdAt: now,
    updatedAt: now,
  };
}

export function initCase({ root, caseDir }) {
  const plan = readPlan(caseDir);
  validateApproval({ root, plan });
  const statePath = casePaths(caseDir).state;
  if (existsSync(statePath)) fail('state already exists');
  const state = createStateFromPlan(plan);
  atomicWriteJson(statePath, state);
  return state;
}

export function dispatchTask({ root, caseDir, taskId, owner, now = Date.now() }) {
  return withCaseLock(caseDir, () => {
    const plan = readPlan(caseDir);
    const previous = loadState(caseDir);
    assertStateMatchesPlan(previous, plan);
    const state = clone(previous);
    const planTask = plan.tasks.find((t) => t.id === taskId);
    if (!planTask) fail('task not found in plan');
    const task = state.tasks[taskId];
    if (!task) fail('task not found in state');
    if (task.dispatchCount >= 1) fail('dispatch max once');
    if (task.state !== 'READY') fail('task is not READY');
    for (const dep of task.deps) if (state.tasks[dep].state !== 'DONE') fail(`dependency ${dep} not DONE`);
    const stop = stopBlocking({ root, state, taskId, plan, now });
    if (stop) fail(`stop ${stop.id} blocks task`);
    const approval = validateApproval({ root, plan, now });
    if (plan.approvalRef.kind === CASE_BINDING_APPROVAL_KIND && owner !== approval.doc.owner) fail('dispatch owner must match case binding owner');
    if (!planTask.command) fail('task has no approved command');
    const command = validateCommand({ root, caseDir, plan, task: planTask });
    const commandHash = computeCommandHash(command);
    const units = Number(task.reservedUnits || 0);
    if (units > 0) {
      if (!plan.budget) fail('budget unavailable');
      const spent = Number(state.counters?.spentUnits || 0);
      const reserved = Object.values(state.budgetReservations || {}).reduce((sum, value) => sum + Number(value || 0), 0);
      if (spent + reserved + units > Number(plan.budget.limit)) fail('budget unavailable');
      state.budgetReservations[taskId] = units;
    }
    if (hasOwnerLock(task) && task.leaseOwner !== owner) fail('task owned by another owner');
    const messageId = safeId(`msg-${taskId}-${randomUUID()}`, 'messageId');
    const executionNonce = randomUUID();
    const attempt = Number(task.attempt || 0) + 1;
    const generation = Number(state.generation || 0) + 1;
    const payload = {
      schemaVersion: TASK_CONTINUITY_SCHEMA_VERSION,
      kind: 'task_dispatch',
      caseId: state.caseId,
      taskId,
      messageId,
      payloadHash: '',
      instructionVersion: task.instructionVersion,
      owner,
      generation,
      attempt,
      executionNonce,
      planHash: state.planHash,
      approvalSha256: approval.sha256,
      candidateSha: task.candidateSha,
      commandHash,
    };
    payload.payloadHash = sha256Text(canonicalJson(payload));
    const outboxDir = safeCasePath(caseDir, 'outbox', 'outbox dir');
    mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
    const outboxPath = safeCasePath(caseDir, join('outbox', `${messageId}.json`), 'outbox file');
    atomicWriteJson(outboxPath, payload);
    task.messageId = messageId;
    task.payloadHash = payload.payloadHash;
    task.executionNonce = executionNonce;
    task.attempt = attempt;
    task.generation = generation;
    task.state = 'SUBMITTED';
    task.submittedAt = new Date(now).toISOString();
    task.dispatchCount = Number(task.dispatchCount || 0) + 1;
    task.leaseOwner = owner;
    task.leaseUntil = new Date(now + 90000).toISOString();
    task.fencingToken = Number(task.fencingToken || 0) + 1;
    task.outboxMessageId = messageId;
    task.commandHash = commandHash;
    state.generation = generation;
    state.updatedAt = new Date(now).toISOString();
    const persistedState = clone(state);
    saveState(caseDir, state, previous);
    try {
      const child = spawn(command.execPath, [command.workerAbs, caseDir, messageId, executionNonce, taskId, ...command.args], {
        cwd: caseDir,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          TASK_CASE_ID: state.caseId,
          TASK_TASK_ID: taskId,
          TASK_MESSAGE_ID: messageId,
          TASK_EXECUTION_NONCE: executionNonce,
          TASK_PAYLOAD_HASH: payload.payloadHash,
          TASK_INSTRUCTION_VERSION: task.instructionVersion,
          TASK_OWNER: owner,
          TASK_GENERATION: String(generation),
          TASK_ATTEMPT: String(attempt),
        },
      });
      child.unref();
      const updated = clone(persistedState);
      updated.tasks[taskId].processId = child.pid;
      updated.updatedAt = new Date(now).toISOString();
      saveState(caseDir, updated, persistedState);
      return { messageId, executionNonce, pid: child.pid, commandHash };
    } catch (error) {
      const current = clone(persistedState);
      current.tasks[taskId].state = 'UNKNOWN';
      current.tasks[taskId].blockedReason = `spawn failed: ${error.message}`;
      current.updatedAt = new Date().toISOString();
      saveState(caseDir, current, persistedState);
      throw error;
    }
  });
}

export function collectTask({ root, caseDir, taskId, now = Date.now() }) {
  return withCaseLock(caseDir, () => {
    const plan = readPlan(caseDir);
    const previous = loadState(caseDir);
    assertStateMatchesPlan(previous, plan);
    const state = clone(previous);
    const task = state.tasks[taskId];
    if (!task) fail('task not found');
    if (!['SUBMITTED','RECEIVED','RUNNING','UNKNOWN'].includes(task.state)) return { state: task.state };
    const processIdPinned = task.processId !== null && task.processId !== undefined;
    const messageId = task.messageId;
    if (!messageId) fail('task has no messageId');
    const planTask = plan.tasks.find((item) => item.id === taskId);
    if (!planTask) fail('task not found in plan');
    const receiptDir = safeCasePath(caseDir, join('receipts', messageId), 'receipt dir');
    const expected = {
      kind: 'worker_inbox_receipt',
      caseId: state.caseId,
      taskId,
      messageId,
      payloadHash: task.payloadHash,
      executionNonce: task.executionNonce,
      instructionVersion: task.instructionVersion,
      owner: task.leaseOwner,
      generation: task.generation,
      attempt: task.attempt,
      ...(processIdPinned ? { processId: task.processId } : {}),
    };
    const inboxPath = safeCasePath(caseDir, join('receipts', messageId, 'inbox.json'), 'inbox receipt');
    let inbox = null;
    if (existsSync(inboxPath)) {
      const hash = sha256File(inboxPath);
      if (task.inboxSha && task.inboxSha !== hash) fail('inbox receipt rewritten');
      task.inboxSha = hash;
      inbox = readJson(inboxPath);
      validateReceipt(inbox, expected);
      task.inboxRef = `.ai/requests/${state.caseId}/receipts/${messageId}/inbox.json`;
      task.receivedAt = inbox.writtenAt;
      if (task.state === 'SUBMITTED' || task.state === 'UNKNOWN') task.state = 'RECEIVED';
    }
    const startPath = safeCasePath(caseDir, join('receipts', messageId, 'start.json'), 'start receipt');
    let start = null;
    if (existsSync(startPath)) {
      if (!inbox) fail('start receipt without inbox receipt');
      const hash = sha256File(startPath);
      if (task.startSha && task.startSha !== hash) fail('start receipt rewritten');
      task.startSha = hash;
      start = readJson(startPath);
      validateReceipt(start, { ...expected, kind: 'worker_start_receipt' });
      if (!start.processIdentity || typeof start.processIdentity !== 'object') fail('start receipt process identity object required');
      const startPid = Number(start.processIdentity.pid);
      if (!Number.isInteger(startPid) || startPid <= 0) fail('start processIdentity pid invalid');
      if (processIdPinned) {
        if (startPid !== Number(task.processId)) fail('start processIdentity pid mismatch');
      } else {
        if (Number(start.processId) !== startPid) fail('start receipt processId mismatch');
        task.processId = startPid;
        expected.processId = startPid;
      }
      const approved = validateCommand({ root, caseDir, plan, task: planTask });
      const expectedArgv = [approved.execPath, approved.workerAbs, caseDir, messageId, task.executionNonce, taskId, ...approved.args];
      if (start.execPath !== approved.execPath) fail('start execPath mismatch');
      if (canonicalJson(start.argv) !== canonicalJson(expectedArgv)) fail('start argv mismatch');
      if (!start.artifactRef) fail('start artifact required');
      validateArtifactRef(caseDir, start.artifactRef, 'start artifact');
      task.startArtifactRef = start.artifactRef;
      task.executionRef = `.ai/requests/${state.caseId}/receipts/${messageId}/start.json`;
      task.startedAt = start.startedAt || start.writtenAt;
      task.processIdentity = start.processIdentity;
      if (task.state === 'RECEIVED') task.state = 'RUNNING';
    }
    const resultPath = safeCasePath(caseDir, join('receipts', messageId, 'result.json'), 'result receipt');
    let result = null;
    if (existsSync(resultPath)) {
      if (!inbox || !start) fail('result receipt without verified inbox/start');
      const hash = sha256File(resultPath);
      if (task.resultReceiptSha && task.resultReceiptSha !== hash) fail('result receipt rewritten');
      task.resultReceiptSha = hash;
      result = readJson(resultPath);
      if (typeof result.resultSha !== 'string' || !/^[a-f0-9]{40}$/i.test(result.resultSha)) fail('resultSha must be pinned commit hash');
      validateReceipt(result, { ...expected, kind: 'worker_result_receipt' });
      if (!result.inputRef || !result.artifactRef) fail('result must include inputRef and artifactRef');
      validateArtifactRef(caseDir, result.inputRef, 'result input');
      validateArtifactRef(caseDir, result.artifactRef, 'result artifact');
      if (task.startArtifactRef && canonicalJson(result.artifactRef) !== canonicalJson(task.startArtifactRef)) fail('result artifactRef mismatch with start artifact');
      task.resultRef = `.ai/requests/${state.caseId}/receipts/${messageId}/result.json`;
      task.resultSha = result.resultSha;
      task.baseSha = result.baseSha || null;
      task.artifactRef = result.artifactRef;
      task.inputRef = result.inputRef;
      task.resultAt = result.completedAt || result.writtenAt;
      task.state = 'RESULT_READY';
    }
    if (!inbox && !start && !result && task.state === 'SUBMITTED') {
      task.state = 'UNKNOWN';
      task.blockedReason = 'missing inbox receipt; active process must not be relaunched';
      task.nextCheckAt = new Date(now + 60000).toISOString();
    }
    state.updatedAt = new Date(now).toISOString();
    saveState(caseDir, state, previous);
    return { state: task.state };
  });
}

export function revalidateCollectedResult({ root, caseDir, state, task }) {
  if (!task.resultRef) fail('task resultRef missing');
  const resultAbs = safeRepoPath(root, task.resultRef, 'result receipt');
  ensureRegularFile(resultAbs, 'result receipt');
  const hash = sha256File(resultAbs);
  if (task.resultReceiptSha && task.resultReceiptSha !== hash) fail('result receipt changed');
  const result = readJson(resultAbs);
  const expected = {
    kind: 'worker_result_receipt',
    caseId: state.caseId,
    taskId: task.id,
    messageId: task.messageId,
    payloadHash: task.payloadHash,
    executionNonce: task.executionNonce,
    instructionVersion: task.instructionVersion,
    owner: task.leaseOwner,
    generation: task.generation,
    attempt: task.attempt,
    processId: task.processId,
  };
  validateReceipt(result, expected);
  if (!result.inputRef || !result.artifactRef) fail('result must include inputRef and artifactRef');
  validateArtifactRef(caseDir, result.inputRef, 'result input');
  validateArtifactRef(caseDir, result.artifactRef, 'result artifact');
  if (result.resultSha !== task.resultSha) fail('resultSha changed');
  if (result.inputRef.sha256 !== task.inputRef?.sha256) fail('result inputRef changed');
  if (result.artifactRef.sha256 !== task.artifactRef?.sha256) fail('result artifactRef changed');
  validateArtifactRef(caseDir, task.inputRef, 'task input');
  validateArtifactRef(caseDir, task.artifactRef, 'task artifact');
  return result;
}

function validateEvidenceManifestInternal({ root, manifest, task, plan, approval }) {
  assertObject(manifest, 'manifest');
  if (manifest.schemaVersion !== TASK_CONTINUITY_SCHEMA_VERSION) fail('manifest schemaVersion mismatch');
  if (manifest.kind !== 'evidence_manifest') fail('manifest kind mismatch');
  const candidateSha = task.candidateSha || manifest.candidateSha;
  if (!candidateSha) fail('candidateSha required');
  if (manifest.candidateSha !== candidateSha) fail('manifest candidateSha mismatch');
  if (manifest.approvalSha256 !== approval.sha256) fail('manifest approval mismatch');
  if (!task.resultSha || manifest.resultSha !== task.resultSha) fail('manifest resultSha mismatch');
  if (!task.inputRef?.sha256 || manifest.inputSha256 !== task.inputRef.sha256) fail('manifest input hash mismatch');
  if (!task.artifactRef?.sha256 || manifest.artifactSha256 !== task.artifactRef.sha256) fail('manifest artifact hash mismatch');
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
  validateBindingFields(manifest, binding, 'manifest');
  if (!gitShaLike(candidateSha)) fail('candidateSha must be pinned commit hash');
  if (!gitShaLike(task.resultSha)) fail('resultSha must be pinned commit hash');
  for (const kind of EVIDENCE_KINDS) {
    const entry = manifest[kind];
    assertObject(entry, `${kind} entry`);
    const absolute = safeRepoPath(root, entry.path, `${kind} evidence`);
    ensureRegularFile(absolute, `${kind} evidence`);
    if (sha256File(absolute) !== entry.sha256) fail(`${kind} evidence sha256 mismatch`);
    const doc = readJson(absolute);
    if (doc.kind !== `${kind}_evidence`) fail(`${kind} kind mismatch`);
    validateBindingFields(doc, binding, `${kind} evidence`);
    if (!Array.isArray(doc.actualEvidence) || doc.actualEvidence.length === 0) fail(`${kind} actualEvidence required`);
    for (const ref of doc.actualEvidence) {
      validateActualEvidenceRef({ root, kind, ref, binding });
    }
    if (kind === 'completion') {
      if (doc.passed !== true || doc.gated !== true || doc.applied !== true) fail('completion evidence requires passed/gated/applied true');
      assertObject(doc.completedDeclaration, 'completion completedDeclaration');
      if (doc.completedDeclaration.native !== true) fail('completion must declare native');
      const nativeRef = doc.completedDeclaration.nativeCompletionRef || doc.nativeCompletionRef;
      assertObject(nativeRef, 'completion nativeCompletionRef');
      const nativeMatches = (doc.actualEvidence || []).some((item) => item.path === nativeRef.path && item.sha256 === nativeRef.sha256);
      if (!nativeMatches) fail('completion nativeCompletionRef must match actual evidence');
      const caseNativeRef = (doc.actualEvidence || []).find((item) => item.kind === 'case_native_completion_record' || String(item.path || '').includes('case-native-completion-'));
      if (caseNativeRef) {
        const expectedCompletionEvidencePath = `.ai/requests/${binding.caseId}/evidence/completion-${safeId(binding.continuityTaskId, 'continuityTaskId')}.json`;
        if (entry.path !== expectedCompletionEvidencePath) fail('completion evidence path mismatch');
      }
    } else if (kind === 'test') {
      if (doc.passed !== true || doc.exitCode !== 0) fail('test evidence failed');
      if (!doc.counts || doc.counts.total <= 0 || doc.counts.fail !== 0 || doc.counts.skipped !== 0) fail('test evidence counts invalid');
    } else if (kind === 'review') {
      if (doc.verdict !== 'passed' || doc.independent !== true) fail('review evidence not passed/independent');
      assertNonEmpty(doc.reviewer, 'review reviewer');
    } else {
      if (doc.status !== 'passed') fail(`${kind} not passed`);
      assertNonEmpty(doc.checkedBy, `${kind}.checkedBy`);
      assertNonEmpty(doc.checkedAt, `${kind}.checkedAt`);
    }
  }
  return manifest;
}

export function validateEvidenceManifest(opts) {
  return validateEvidenceManifestInternal(opts);
}

export function verifyTask({ root, caseDir, taskId, manifestPath, now = Date.now() }) {
  return withCaseLock(caseDir, () => {
    const plan = readPlan(caseDir);
    const previous = loadState(caseDir);
    assertStateMatchesPlan(previous, plan);
    const state = clone(previous);
    const task = state.tasks[taskId];
    if (!task) fail('task not found');
    if (!['RESULT_READY', 'VERIFYING'].includes(task.state)) fail('task is not RESULT_READY');
    const approval = validateApproval({ root, plan, now });
    revalidateCollectedResult({ root, caseDir, state, task });
    const manifestAbsolute = safeRepoPath(root, manifestPath, 'evidence manifest');
    ensureRegularFile(manifestAbsolute, 'evidence manifest');
    const manifest = readJson(manifestAbsolute);
    validateEvidenceManifestInternal({ root, manifest, task, plan, approval });
    task.state = 'VERIFYING';
    task.verification = {
      manifestPath,
      manifestSha256: sha256File(manifestAbsolute),
      approvalSha256: approval.sha256,
      verifiedAt: new Date(now).toISOString(),
    };
    state.updatedAt = new Date(now).toISOString();
    saveState(caseDir, state, previous);
    return { state: task.state, manifest };
  });
}

export function acceptTask({ root, caseDir, taskId, manifestPath, now = Date.now() }) {
  return withCaseLock(caseDir, () => {
    const plan = readPlan(caseDir);
    const previous = loadState(caseDir);
    assertStateMatchesPlan(previous, plan);
    const state = clone(previous);
    const task = state.tasks[taskId];
    if (!task) fail('task not found');
    if (!['RESULT_READY', 'VERIFYING'].includes(task.state)) fail('task is not ready for acceptance');
    const approval = validateApproval({ root, plan, now });
    revalidateCollectedResult({ root, caseDir, state, task });
    const manifestAbsolute = safeRepoPath(root, manifestPath, 'evidence manifest');
    ensureRegularFile(manifestAbsolute, 'evidence manifest');
    const manifestSha256 = sha256File(manifestAbsolute);
    if (task.verification) {
      if (task.verification.manifestSha256 !== manifestSha256) fail('manifest does not match pinned verification');
    }
    const manifest = readJson(manifestAbsolute);
    validateEvidenceManifestInternal({ root, manifest, task, plan, approval });
    task.state = 'DONE';
    task.completedAt = new Date(now).toISOString();
    task.acceptance = {
      manifestPath,
      manifestSha256,
      approvalSha256: approval.sha256,
      acceptedAt: task.completedAt,
    };
    task.nextOwner = null;
    task.nextAction = null;
    task.nextDueAt = null;
    const units = Number(task.reservedUnits || 0);
    if (units > 0) {
      state.counters.spentUnits = Number(state.counters.spentUnits || 0) + units;
      delete state.budgetReservations[taskId];
    }
    state.updatedAt = new Date(now).toISOString();
    saveState(caseDir, state, previous);
    return { state: task.state };
  });
}

export function reconcileCase({ root, caseDir, owner = null, now = Date.now() }) {
  return withCaseLock(caseDir, () => {
    const plan = readPlan(caseDir);
    const previous = loadState(caseDir);
    assertStateMatchesPlan(previous, plan);
    const state = clone(previous);
    let approval = null;
    let approvalError = null;
    try {
      approval = validateApproval({ root, plan, now });
    } catch (error) {
      approvalError = error;
    }
    for (const task of Object.values(state.tasks)) {
      if (TERMINAL_STATES.includes(task.state)) continue;
      if (ACTIVE_RECOVERABLE_STATES.has(task.state)) {
        if (!task.nextOwner) task.nextOwner = owner || task.owner;
        continue;
      }
      const depMissing = task.deps.some((dep) => state.tasks[dep].state !== 'DONE');
      if (depMissing) {
        task.state = 'BLOCKED_DEPENDENCY';
        continue;
      }
      const stop = stopBlocking({ root, state, taskId: task.id, plan, now });
      if (stop) {
        task.state = 'BLOCKED_DEPENDENCY';
        task.blockedReason = `stop ${stop.id}`;
        continue;
      }
      if (approvalError) {
        task.state = 'WAITING_APPROVAL';
        task.blockedReason = approvalError.message;
        continue;
      }
      if (!budgetAvailable(state, plan, task)) {
        task.state = 'BLOCKED_BUDGET';
        continue;
      }
      if (['PLANNED', 'WAITING_APPROVAL', 'BLOCKED_CAPABILITY', 'BLOCKED_BUDGET', 'BLOCKED_DEPENDENCY'].includes(task.state)) {
        task.state = 'READY';
      }
      if (!task.nextOwner) task.nextOwner = owner || task.owner;
    }
    state.updatedAt = new Date(now).toISOString();
    saveState(caseDir, state, previous);
    return state;
  });
}

export function statusCase({ caseDir }) {
  const plan = readPlan(caseDir);
  const state = loadState(caseDir);
  assertStateMatchesPlan(state, plan);
  return {
    caseId: state.caseId,
    taskId: state.taskId,
    taskFingerprint: state.taskFingerprint,
    planHash: state.planHash,
    state: state.state,
    counters: state.counters,
    stops: state.stops,
    stopReleases: state.stopReleases,
    tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [id, {
      state: task.state,
      owner: task.owner,
      attempt: task.attempt,
      generation: task.generation,
      dispatchCount: task.dispatchCount,
      candidateSha: task.candidateSha,
      resultSha: task.resultSha,
      blockedReason: task.blockedReason,
      nextOwner: task.nextOwner,
      nextAction: task.nextAction,
      nextDueAt: task.nextDueAt,
      progress: task.progress || null,
    }])),
  };
}
