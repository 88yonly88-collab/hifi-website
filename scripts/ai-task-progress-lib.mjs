import { resolveRepoPath, ensureRegularFile, readJson } from './ai-e2e-lib.mjs';
import { sha256File } from './ai-task-continuity-lib.mjs';

export const PROGRESS_SCHEMA_VERSION = 1;
export const PROGRESS_KIND = 'task_progress';

const FORBIDDEN_PROGRESS_KEYS = new Set([
  'approval', 'budget', 'state', 'counters', 'plan', 'stops', 'permissions',
  'leaseOwner', 'leaseUntil', 'fencingToken', 'generation', 'attempt', 'owner',
]);

function fail(message) {
  throw new Error(`TASK_PROGRESS_ERROR: ${message}`);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function assertNonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
  return value;
}

function assertIsoDate(value, label) {
  assertNonEmpty(value, label);
  if (!Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO date-time`);
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateNextCheck(nextCheck, label) {
  assertObject(nextCheck, label);
  assertNonEmpty(nextCheck.owner, `${label}.owner`);
  assertNonEmpty(nextCheck.action, `${label}.action`);
  assertIsoDate(nextCheck.dueAt, `${label}.dueAt`);
}

function validateOverrunPatch(overrun) {
  assertObject(overrun, 'overrun');
  if (!Number.isInteger(overrun.version) || overrun.version < 1) fail('overrun.version must be positive integer');
  assertIsoDate(overrun.originalDueAt, 'overrun.originalDueAt');
  if (overrun.currentDueAt !== undefined) assertIsoDate(overrun.currentDueAt, 'overrun.currentDueAt');
  if (overrun.at !== undefined) assertIsoDate(overrun.at, 'overrun.at');
  if (overrun.reason !== undefined) assertNonEmpty(overrun.reason, 'overrun.reason');
  if (overrun.action !== undefined) assertNonEmpty(overrun.action, 'overrun.action');
  if (overrun.nextCheck !== undefined && overrun.nextCheck !== null) validateNextCheck(overrun.nextCheck, 'overrun.nextCheck');
}

function validateDeadlinePatch(deadline) {
  assertObject(deadline, 'deadline');
  if (!Number.isInteger(deadline.version) || deadline.version < 1) fail('deadline.version must be positive integer');
  assertIsoDate(deadline.originalDueAt, 'deadline.originalDueAt');
  if (deadline.currentDueAt !== undefined) assertIsoDate(deadline.currentDueAt, 'deadline.currentDueAt');
}

function validateRemainingStages(stages, context) {
  if (!Array.isArray(stages)) fail('remainingStages must be array');
  const ids = new Set();
  for (const stage of stages) {
    assertObject(stage, 'remainingStage');
    assertNonEmpty(stage.id, 'remainingStage.id');
    if (ids.has(stage.id)) fail(`duplicate remaining stage ${stage.id}`);
    ids.add(stage.id);
    assertNonEmpty(stage.owner, 'remainingStage.owner');
    assertNonEmpty(stage.condition, 'remainingStage.condition');
    assertNonEmpty(stage.state, 'remainingStage.state');
    if (!Array.isArray(stage.deps)) fail('remainingStage.deps must be array');
    for (const dep of stage.deps) assertNonEmpty(dep, 'remainingStage.dep');
    if (context.taskId && stage.taskId !== undefined && stage.taskId !== context.taskId) fail(`remaining stage ${stage.id} taskId mismatch`);
    if (context.taskFingerprint && stage.taskFingerprint !== undefined && stage.taskFingerprint !== context.taskFingerprint) fail(`remaining stage ${stage.id} taskFingerprint mismatch`);
  }
  const map = new Map(stages.map((stage) => [stage.id, stage]));
  for (const stage of stages) {
    for (const dep of stage.deps) {
      if (!map.has(dep)) fail(`remaining stage ${stage.id} unknown dependency ${dep}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) fail(`remaining stage dependency cycle at ${id}`);
    visiting.add(id);
    for (const dep of map.get(id).deps) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of map.keys()) visit(id);
}

function validateEstimate(estimate, patch) {
  assertObject(estimate, 'estimate');
  if (estimate.kind === 'unknown' || estimate.unknown === true) {
    const nextCheck = estimate.nextCheck || patch.uncertainty?.nextCheck;
    validateNextCheck(nextCheck, 'estimate.nextCheck');
    return;
  }
  if (estimate.kind !== undefined && estimate.kind !== 'known') fail('estimate.kind must be known or unknown');
  for (const category of ['optimism', 'standard', 'delayed']) {
    const item = estimate[category];
    assertObject(item, `estimate.${category}`);
    for (const key of ['workMs', 'modelMs', 'waitMs']) {
      if (!Number.isFinite(item[key]) || item[key] < 0) fail(`estimate.${category}.${key} must be non-negative number`);
    }
    assertIsoDate(item.basisAt, `estimate.${category}.basisAt`);
    assertNonEmpty(item.basis, `estimate.${category}.basis`);
    if (item.waitBounded === false) fail(`estimate.${category} unbounded wait requires unknown estimate`);
  }
}

function ensureConcreteNextCheck(progress, task, now) {
  const estimate = progress.estimate || null;
  const unknown = !estimate || estimate.kind === 'unknown' || estimate.unknown === true;
  if (!unknown) return;
  const existing = progress.uncertainty?.nextCheck || (estimate && estimate.nextCheck) || null;
  if (existing) {
    validateNextCheck(existing, 'progress.nextCheck');
    return;
  }
  const owner = task.owner || task.taskOwner || task.assignee;
  if (!owner) fail('unknown progress requires concrete nextCheck.owner');
  const action = progress.currentStage ? `continue-${progress.currentStage}` : 'state-check-and-reestimate';
  const dueAt = new Date(Date.parse(now) + 60 * 60 * 1000).toISOString();
  progress.uncertainty = { ...(progress.uncertainty || {}), nextCheck: { owner, action, dueAt } };
}

export function validateProgressPatch(patch, context = {}) {
  assertObject(patch, 'progress patch');
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_PROGRESS_KEYS.has(key)) fail(`progress cannot mutate ${key}`);
  }
  if (patch.schemaVersion !== undefined && patch.schemaVersion !== PROGRESS_SCHEMA_VERSION) fail('schemaVersion mismatch');
  if (patch.currentStage !== undefined) assertNonEmpty(patch.currentStage, 'currentStage');
  if (patch.lastArtifact !== undefined && patch.lastArtifact !== null) {
    assertObject(patch.lastArtifact, 'lastArtifact');
    assertNonEmpty(patch.lastArtifact.ref, 'lastArtifact.ref');
    assertNonEmpty(patch.lastArtifact.sha256, 'lastArtifact.sha256');
    assertIsoDate(patch.lastArtifact.at, 'lastArtifact.at');
  }
  if (patch.remainingStages !== undefined) validateRemainingStages(patch.remainingStages, context);
  if (patch.decisionRefs !== undefined) {
    if (!Array.isArray(patch.decisionRefs)) fail('decisionRefs must be array');
    for (const ref of patch.decisionRefs) {
      assertObject(ref, 'decisionRef');
      assertNonEmpty(ref.id, 'decisionRef.id');
      assertNonEmpty(ref.path, 'decisionRef.path');
      assertNonEmpty(ref.sha256, 'decisionRef.sha256');
    }
  }
  if (patch.uncertainty !== undefined) {
    assertObject(patch.uncertainty, 'uncertainty');
    if (patch.uncertainty.nextCheck !== undefined && patch.uncertainty.nextCheck !== null) {
      validateNextCheck(patch.uncertainty.nextCheck, 'uncertainty.nextCheck');
    }
  }
  if (patch.estimate !== undefined) validateEstimate(patch.estimate, patch);
  if (patch.overrun !== undefined) validateOverrunPatch(patch.overrun);
  if (patch.deadline !== undefined) validateDeadlinePatch(patch.deadline);
  return true;
}

export function validateDecisionRefFiles(root, refs, context = {}) {
  for (const ref of refs || []) {
    const absolute = resolveRepoPath(root, ref.path, 'decisionRef');
    ensureRegularFile(absolute, 'decisionRef');
    if (sha256File(absolute) !== ref.sha256) fail(`decisionRef ${ref.id} hash mismatch`);
    const doc = readJson(absolute);
    assertObject(doc, 'decisionRef document');
    const docId = doc.id || doc.decisionId || doc.decisionID;
    if (!docId) fail(`decisionRef ${ref.id} document id missing`);
    if (docId !== ref.id) fail(`decisionRef ${ref.id} document id mismatch`);
    if (context.taskId !== undefined) {
      if (doc.taskId === undefined) fail(`decisionRef ${ref.id} document taskId missing`);
      if (doc.taskId !== context.taskId) fail(`decisionRef ${ref.id} document taskId mismatch`);
    }
    if (context.taskFingerprint !== undefined && doc.taskFingerprint !== undefined && doc.taskFingerprint !== context.taskFingerprint) {
      fail(`decisionRef ${ref.id} document taskFingerprint mismatch`);
    }
  }
  return true;
}

export function applyProgressInput({ root, state, taskId, patch }) {
  assertObject(state, 'state');
  const task = state.tasks[taskId];
  if (!task) fail('task not found');
  validateProgressPatch(patch, { taskId, taskFingerprint: state.taskFingerprint });
  const now = new Date().toISOString();
  const nextState = clone(state);
  const nextTask = nextState.tasks[taskId];
  const current = nextTask.progress || {
    schemaVersion: PROGRESS_SCHEMA_VERSION,
    kind: PROGRESS_KIND,
    currentStage: null,
    lastArtifact: null,
    remainingStages: [],
    decisionRefs: [],
    uncertainty: { nextCheck: null },
    estimate: null,
    overrun: { version: 0, originalDueAt: null, currentDueAt: null, events: [] },
    updatedAt: null,
  };
  const next = { ...current };
  if (patch.currentStage !== undefined) next.currentStage = patch.currentStage;
  if (patch.lastArtifact !== undefined) next.lastArtifact = patch.lastArtifact ? clone(patch.lastArtifact) : null;
  if (patch.remainingStages !== undefined) next.remainingStages = clone(patch.remainingStages);
  if (patch.uncertainty !== undefined) next.uncertainty = clone(patch.uncertainty);
  if (patch.estimate !== undefined) next.estimate = clone(patch.estimate);
  if (patch.decisionRefs !== undefined) {
    const refs = [...(current.decisionRefs || [])];
    for (const ref of patch.decisionRefs) {
      const existing = refs.find((item) => item.id === ref.id);
      if (existing) {
        if (existing.path !== ref.path || existing.sha256 !== ref.sha256) fail(`decision ID ${ref.id} contradicts existing ref`);
        continue;
      }
      refs.push(clone(ref));
    }
    if (root) validateDecisionRefFiles(root, refs, { taskId, taskFingerprint: state.taskFingerprint });
    next.decisionRefs = refs;
  }
  if (patch.overrun !== undefined) {
    const overrun = { ...(current.overrun || { version: 0, originalDueAt: null, currentDueAt: null, events: [] }) };
    if (!overrun.originalDueAt && patch.overrun.originalDueAt) overrun.originalDueAt = patch.overrun.originalDueAt;
    if (overrun.originalDueAt && patch.overrun.originalDueAt && overrun.originalDueAt !== patch.overrun.originalDueAt) {
      fail('overrun.originalDueAt cannot change once set');
    }
    if (patch.overrun.currentDueAt) overrun.currentDueAt = patch.overrun.currentDueAt;
    const events = Array.isArray(overrun.events) ? [...overrun.events] : [];
    if (events.some((event) => event.version === patch.overrun.version)) fail('overrun already recorded for this version');
    events.push({
      version: patch.overrun.version,
      at: patch.overrun.at || now,
      reason: patch.overrun.reason || 'overrun',
      action: patch.overrun.action || 'state-check-and-reestimate',
      nextCheck: patch.overrun.nextCheck || null,
    });
    overrun.version = Math.max(Number(overrun.version || 0), patch.overrun.version);
    overrun.events = events;
    next.overrun = overrun;
  }
  if (patch.deadline !== undefined) {
    const overrun = { ...(next.overrun || current.overrun || { version: 0, originalDueAt: null, currentDueAt: null, events: [] }) };
    if (overrun.originalDueAt && overrun.originalDueAt !== patch.deadline.originalDueAt) {
      fail('deadline.originalDueAt cannot change once set');
    }
    overrun.originalDueAt = patch.deadline.originalDueAt;
    if (patch.deadline.currentDueAt !== undefined) overrun.currentDueAt = patch.deadline.currentDueAt;
    overrun.version = Math.max(Number(overrun.version || 0), patch.deadline.version);
    overrun.events = Array.isArray(overrun.events) ? overrun.events : [];
    next.overrun = overrun;
  }
  if (task.state === 'WAITING_APPROVAL' && patch.estimate && patch.estimate.kind !== 'unknown' && patch.estimate.unknown !== true) {
    for (const category of ['optimism', 'standard', 'delayed']) {
      const item = patch.estimate[category];
      if (item && item.waitMs === 0) fail('unbounded approval wait cannot be represented with waitMs:0; use unknown estimate and nextCheck');
    }
  }
  ensureConcreteNextCheck(next, nextTask, now);
  next.updatedAt = now;
  nextTask.progress = next;
  nextState.updatedAt = now;
  return nextState;
}

export function scanProgressDeadline({ state, taskId, now = new Date().toISOString() }) {
  assertObject(state, 'state');
  const task = state.tasks?.[taskId];
  if (!task) fail('task not found');
  if (!task.progress) return state;
  const progress = task.progress;
  const overrun = progress.overrun;
  if (!overrun || !overrun.originalDueAt) return state;
  const due = Date.parse(overrun.originalDueAt);
  const current = Date.parse(now);
  if (!Number.isFinite(due) || !Number.isFinite(current)) fail('invalid deadline time');
  if (current < due) return state;
  const version = Number(overrun.version || 0) || 1;
  const events = Array.isArray(overrun.events) ? overrun.events : [];
  if (events.some((event) => event.version === version)) return state;
  const nextState = clone(state);
  const nextTask = nextState.tasks[taskId];
  const nextProgress = nextTask.progress;
  const nextOverrun = { ...(nextProgress.overrun || {}) };
  const nextEvents = Array.isArray(nextOverrun.events) ? [...nextOverrun.events] : [];
  nextEvents.push({
    version,
    at: now,
    reason: 'deadline_passed',
    action: 'state-check-and-reestimate',
    nextCheck: nextProgress.uncertainty?.nextCheck || null,
  });
  nextOverrun.version = Math.max(Number(nextOverrun.version || 0), version);
  nextOverrun.events = nextEvents;
  nextProgress.overrun = nextOverrun;
  nextProgress.updatedAt = now;
  nextTask.progress = nextProgress;
  nextState.updatedAt = now;
  return nextState;
}

export function summarizeProgress(progress) {
  if (!progress) return { known: false, nextCheck: null, estimate: null };
  const estimate = progress.estimate || null;
  const uncertainty = progress.uncertainty || { nextCheck: null };
  const nextCheck = uncertainty.nextCheck || (estimate && estimate.nextCheck) || null;
  const known = Boolean(
    estimate &&
    estimate.kind !== 'unknown' &&
    estimate.unknown !== true &&
    (estimate.optimism || estimate.standard || estimate.delayed)
  );
  return {
    known,
    currentStage: progress.currentStage || null,
    lastArtifact: progress.lastArtifact || null,
    remainingStages: progress.remainingStages || [],
    decisionRefs: progress.decisionRefs || [],
    uncertainty,
    estimate,
    overrun: progress.overrun || null,
    nextCheck,
  };
}
