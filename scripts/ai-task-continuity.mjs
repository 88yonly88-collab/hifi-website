#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptTask,
  collectTask,
  dispatchTask,
  initCase,
  loadState,
  readPlan,
  reconcileCase,
  resolveCaseDir,
  saveState,
  sha256File,
  statusCase,
  validateApproval,
  verifyTask,
  withCaseLock,
} from './ai-task-continuity-lib.mjs';
import { ensureRegularFile, resolveRepoPath } from './ai-e2e-lib.mjs';
import { applyProgressInput, scanProgressDeadline } from './ai-task-progress-lib.mjs';
import { verifyProviderEvidence } from './review-evidence.mjs';
import { acquireReviewRequestFileLock, releaseReviewRequestFileLock } from './ai-runtime-evidence-lib.mjs';

function fail(message) {
  throw new Error(`TASK_CONTINUITY_CLI_ERROR: ${message}`);
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function repoRoot(args) {
  const root = flag(args, '--repo') || process.cwd();
  return resolve(root);
}

function caseDir(args) {
  const root = repoRoot(args);
  const relative = flag(args, '--case');
  if (!relative) fail('--case is required');
  return resolveCaseDir(root, relative);
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const WATCH_VALUE_FLAGS = new Set(['--repo', '--case', '--owner', '--interval-ms', '--duration-ms', '--max-ticks', '--task', '--manifest']);

function watchPositiveSafeInteger(value, label) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    fail(`watch: ${label} must be a positive safe integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail(`watch: ${label} must be a positive safe integer`);
  }
  return number;
}

function parseWatchOptions(args) {
  const values = new Map();
  let noStart = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      fail(`watch: unexpected argument ${token}`);
    }
    if (token === '--no-start') {
      if (noStart) fail('watch: duplicate option --no-start');
      noStart = true;
      continue;
    }
    if (!WATCH_VALUE_FLAGS.has(token)) {
      fail(`watch: unknown option ${token}`);
    }
    if (index + 1 >= args.length) fail(`watch: missing value for ${token}`);
    const value = args[index + 1];
    index += 1;
    if (values.has(token)) fail(`watch: duplicate option ${token}`);
    values.set(token, value);
  }
  return { values, noStart };
}

function assertCurrentTaskBinding({ root, plan, state, owner = null }) {
  const currentTaskPath = resolve(root, '.ai', 'current-task.json');
  if (!existsSync(currentTaskPath)) return null;
  const currentTask = JSON.parse(readFileSync(currentTaskPath, 'utf8'));
  if (currentTask.taskId && plan.taskId && currentTask.taskId !== plan.taskId) fail('current-task.json taskId mismatch with continuity plan');
  if (currentTask.taskFingerprint && plan.taskFingerprint && currentTask.taskFingerprint !== plan.taskFingerprint) fail('current-task.json taskFingerprint mismatch with continuity plan');
  const boundOwner = currentTask.continuity?.owner || currentTask.owner || null;
  if (boundOwner && plan.owner && boundOwner !== plan.owner) fail('current-task.json owner mismatch with continuity plan');
  if (boundOwner && state.owner && boundOwner !== state.owner) fail('current-task.json owner mismatch with continuity state');
  if (owner && boundOwner && owner !== boundOwner) fail('current-task.json owner mismatch with requested owner');
  return currentTask;
}

function readReviewReservation({ root, attemptId, index }) {
  const candidates = [
    { path: '.ai/context/deepseek-review-budget.json', ledger: 'canonical' },
    { path: '.ai/deepseek-review-budget.json', ledger: 'legacy' },
  ];
  const matches = [];
  for (const candidate of candidates) {
    const absolute = resolveRepoPath(root, candidate.path, 'review budget ledger');
    if (!existsSync(absolute)) continue;
    ensureRegularFile(absolute, 'review budget ledger');
    let rows;
    try {
      rows = JSON.parse(readFileSync(absolute, 'utf8'));
    } catch (error) {
      fail(`review chunk ${index} budget ledger ${candidate.path} is not valid JSON: ${error.message}`);
    }
    if (!Array.isArray(rows)) fail(`review chunk ${index} budget ledger ${candidate.path} is not an array`);
    for (const row of rows) {
      if (row && typeof row === 'object' && row.attempt === attemptId) matches.push({ ...candidate, row });
    }
  }
  if (matches.length !== 1) {
    fail(`review chunk ${index} attempt ${attemptId} must match exactly one authoritative budget ledger row (found ${matches.length})`);
  }
  const { row, ledger, path } = matches[0];
  if (row.state !== 'reserved') fail(`review chunk ${index} attempt ${attemptId} reservation state is not reserved`);
  if (!Number.isSafeInteger(row.reservedYen) || row.reservedYen <= 0) fail(`review chunk ${index} attempt ${attemptId} reservedYen invalid`);
  if (typeof row.at !== 'string' || !row.at) fail(`review chunk ${index} attempt ${attemptId} reservation timestamp missing`);
  return { attemptId, reservedYen: row.reservedYen, state: row.state, ledger, ledgerPath: path, at: row.at };
}

function validateReviewChunkAttempt({ root, entry, caseId, taskId, taskFingerprint, planHash, index, manifestHash, expectedBinding, total }) {
  const receiptRef = entry?.receiptRef || entry?.attemptRef || null;
  if (!receiptRef || typeof receiptRef !== 'object' || typeof receiptRef.path !== 'string' || typeof receiptRef.sha256 !== 'string') {
    fail(`review chunk ${index} missing receiptRef/attemptRef`);
  }
  const absolute = resolveRepoPath(root, receiptRef.path, 'review chunk receipt');
  ensureRegularFile(absolute, 'review chunk receipt');
  const actual = sha256File(absolute);
  if (actual !== receiptRef.sha256) fail(`review chunk ${index} receipt sha256 mismatch`);
  const receipt = JSON.parse(readFileSync(absolute, 'utf8'));
  if (receipt.caseId !== undefined && receipt.caseId !== caseId) fail(`review chunk ${index} receipt caseId mismatch`);
  if (receipt.taskId !== taskId) fail(`review chunk ${index} receipt taskId mismatch`);
  if (receipt.taskFingerprint !== taskFingerprint) fail(`review chunk ${index} receipt taskFingerprint mismatch`);
  if (receipt.planHash !== undefined && receipt.planHash !== planHash) fail(`review chunk ${index} receipt planHash mismatch`);
  if (receipt.manifestHash !== manifestHash) fail(`review chunk ${index} receipt manifestHash mismatch`);
  if (receipt.round !== undefined && receipt.round !== expectedBinding?.round) fail(`review chunk ${index} receipt round mismatch`);
  if (receipt.lens !== undefined && receipt.lens !== expectedBinding?.lens) fail(`review chunk ${index} receipt lens mismatch`);
  if (receipt.approvalHash !== expectedBinding?.approvalHash) fail(`review chunk ${index} receipt approvalHash mismatch`);
  if (receipt.reviewBaseCommit !== expectedBinding?.reviewBaseCommit) fail(`review chunk ${index} receipt reviewBaseCommit mismatch`);
  if (receipt.reviewHeadCommit !== expectedBinding?.reviewHeadCommit) fail(`review chunk ${index} receipt reviewHeadCommit mismatch`);
  const attemptId = typeof receipt.attempt === 'string' && receipt.attempt.trim()
    ? receipt.attempt
    : (typeof receipt.attemptId === 'string' && receipt.attemptId.trim() ? receipt.attemptId : absolute.split('/').slice(-2, -1)[0]);
  if (!attemptId) fail(`review chunk ${index} receipt attempt id missing`);
  const base = absolute.split('/').slice(0, -1).join('/');
  const verified = verifyProviderEvidence(root, base, receipt, 'deepseek', { current: true });
  if (verified.manifestHash !== manifestHash) fail(`review chunk ${index} verified manifestHash mismatch`);
  if (verified.manifest?.planHash !== planHash) fail(`review chunk ${index} verified manifest planHash mismatch`);
  if (verified.manifest?.index !== index) fail(`review chunk ${index} verified manifest index mismatch`);
  if (verified.manifest?.total !== total) fail(`review chunk ${index} verified manifest total mismatch`);
  if (typeof receipt.prompt !== 'string' || !receipt.prompt.trim()) fail(`review chunk ${index} receipt prompt ref missing`);
  const promptPath = resolve(base, receipt.prompt);
  ensureRegularFile(promptPath, 'review chunk prompt');
  const promptText = readFileSync(promptPath, 'utf8');
  const expectedBindingLine = `Review binding: ${JSON.stringify(expectedBinding)}`;
  const actualBindingLine = promptText.split('\n').find((line) => line.startsWith('Review binding: '));
  if (actualBindingLine !== expectedBindingLine) fail(`review chunk ${index} prompt Review binding mismatch`);
  if (verified.result.verdict !== entry.verdict) fail(`review chunk ${index} verdict differs from receipt result`);
  if (JSON.stringify(verified.result.findings) !== JSON.stringify(entry.findings)) fail(`review chunk ${index} findings differ from receipt result`);
  if (JSON.stringify(verified.result.unverified) !== JSON.stringify(entry.unverified)) fail(`review chunk ${index} unverified differ from receipt result`);
  const reservation = readReviewReservation({ root, attemptId, index });
  return { receiptRef: { path: receiptRef.path, sha256: actual }, attemptId, reservation, result: verified.result };
}

function instructionRefFor(plan, task) {
  const ref = task?.instructionRef || plan?.instructionRef;
  if (!ref) return null;
  if (typeof ref !== 'object' || typeof ref.path !== 'string' || typeof ref.sha256 !== 'string') {
    fail('instructionRef must be an object with path and sha256');
  }
  return ref;
}

function checkInstructionSource({ root, plan, task }) {
  const ref = instructionRefFor(plan, task);
  if (!ref) return null;
  const absolute = resolveRepoPath(root, ref.path, 'instruction source');
  ensureRegularFile(absolute, 'instruction source');
  const actual = sha256File(absolute);
  if (actual !== ref.sha256) {
    fail(`instruction source changed: ${ref.path} expected=${ref.sha256} actual=${actual}`);
  }
  return { path: ref.path, sha256: actual };
}

function blockInstruction({ caseDir, taskId, error, owner = null }) {
  const next = withCaseLock(caseDir, () => {
    const previous = loadState(caseDir);
    const copy = JSON.parse(JSON.stringify(previous));
    const blocked = copy.tasks[taskId];
    blocked.blockedReason = `instruction source invalidation: ${error.message}`;
    blocked.nextOwner = owner || blocked.owner || copy.owner || 'parent';
    blocked.nextAction = 'reload-instruction-source-and-reauthorize';
    blocked.nextDueAt = new Date(Date.now() + 3600_000).toISOString();
    copy.updatedAt = new Date().toISOString();
    saveState(caseDir, copy, previous);
    return copy;
  });
  return { taskId, blockedReason: next.tasks[taskId].blockedReason };
}

function instructionGuard({ root, caseDir, taskId }) {
  const plan = readPlan(caseDir);
  const state = loadState(caseDir);
  const task = state.tasks[taskId];
  if (!task) fail('task not found');
  const ref = instructionRefFor(plan, task);
  if (ref) {
    try {
      checkInstructionSource({ root, plan, task });
    } catch (error) {
      return blockInstruction({ caseDir, taskId, error, owner: task.owner || state.owner });
    }
  }
  for (const depId of task.deps || []) {
    const dep = state.tasks[depId];
    if (!dep) continue;
    const depRef = instructionRefFor(plan, dep);
    if (!depRef) continue;
    try {
      checkInstructionSource({ root, plan, task: dep });
    } catch (error) {
      return blockInstruction({ caseDir, taskId, error, owner: task.owner || state.owner });
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (command === 'init') {
    const state = initCase({ root: repoRoot(args), caseDir: caseDir(args) });
    writeJson({ ok: true, state: state.state, planHash: state.planHash });
    return;
  }
  if (command === 'entry') {
    const root = repoRoot(args);
    const dir = caseDir(args);
    const plan = readPlan(dir);
    const state = loadState(dir);
    statusCase({ caseDir: dir });
    const approval = validateApproval({ root, plan });
    assertCurrentTaskBinding({ root, plan, state, owner: plan.owner || state.owner || null });
    if (plan.owner && state.owner && plan.owner !== state.owner) fail('plan/state owner mismatch');
    for (const entryTask of Object.values(state.tasks)) {
      const entryRef = instructionRefFor(plan, entryTask);
      if (entryRef) checkInstructionSource({ root, plan, task: entryTask });
    }
    writeJson({
      ok: true,
      connected: true,
      caseId: plan.caseId,
      taskId: plan.taskId,
      taskFingerprint: plan.taskFingerprint,
      approvalSha256: approval.sha256,
      counters: state.counters,
      stops: state.stops,
      tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [id, {
        state: task.state,
        owner: task.owner,
        leaseOwner: task.leaseOwner,
        dispatchCount: task.dispatchCount,
        generation: task.generation,
        resultSha: task.resultSha,
        blockedReason: task.blockedReason,
      }])),
    });
    return;
  }
  if (command === 'tick') {
    const root = repoRoot(args);
    const dir = caseDir(args);
    const owner = flag(args, '--owner') || process.env.USER || 'parent';
    const taskId = flag(args, '--task') || null;
    const manifest = flag(args, '--manifest') || null;
    const noStart = args.includes('--no-start');
    const tickPlan = readPlan(dir);
    const tickState = loadState(dir);
    assertCurrentTaskBinding({ root, plan: tickPlan, state: tickState, owner });
    statusCase({ caseDir: dir });
    const collected = [];
    const before = loadState(dir);
    const activeIds = taskId
      ? [taskId]
      : Object.values(before.tasks).filter((task) => ['SUBMITTED', 'RECEIVED', 'RUNNING', 'UNKNOWN'].includes(task.state)).map((task) => task.id);
    for (const id of activeIds) {
      const blocked = instructionGuard({ root, caseDir: dir, taskId: id });
      if (blocked) {
        collected.push({ taskId: id, blocked });
        continue;
      }
      try {
        const result = collectTask({ root, caseDir: dir, taskId: id });
        collected.push({ taskId: id, state: result.state });
      } catch (error) {
        collected.push({ taskId: id, error: error.message });
      }
    }
    const accepted = [];
    if (taskId && manifest) {
      const blocked = instructionGuard({ root, caseDir: dir, taskId });
      if (blocked) {
        accepted.push({ taskId, blocked });
      } else {
        const current = loadState(dir).tasks[taskId];
        if (current && ['RESULT_READY', 'VERIFYING'].includes(current.state)) {
          try {
            verifyTask({ root, caseDir: dir, taskId, manifestPath: manifest });
            acceptTask({ root, caseDir: dir, taskId, manifestPath: manifest });
            accepted.push({ taskId, state: 'DONE' });
          } catch (error) {
            accepted.push({ taskId, error: error.message });
          }
        }
      }
    }
    const state = reconcileCase({ root, caseDir: dir, owner });
    const started = [];
    if (!noStart) {
      for (const task of Object.values(state.tasks)) {
        if (task.state !== 'READY') continue;
        const blocked = instructionGuard({ root, caseDir: dir, taskId: task.id });
        if (blocked) {
          started.push({ taskId: task.id, blocked });
          continue;
        }
        try {
          const result = dispatchTask({ root, caseDir: dir, taskId: task.id, owner });
          started.push({ taskId: task.id, pid: result.pid, messageId: result.messageId });
        } catch (error) {
          started.push({ taskId: task.id, error: error.message });
        }
      }
    }
    const progress = [];
    for (const item of [...collected, ...accepted, ...started]) {
      if (!item || !item.taskId || item.error || item.blocked) continue;
      try {
        const updated = withCaseLock(dir, () => {
          const previous = loadState(dir);
          const task = previous.tasks[item.taskId];
          if (!task) return previous;
          const artifact = task.resultRef && task.resultSha
            ? { ref: task.resultRef, sha256: task.resultSha, at: new Date().toISOString() }
            : null;
          const next = applyProgressInput({
            root,
            state: previous,
            taskId: item.taskId,
            patch: { currentStage: task.state, lastArtifact: artifact },
          });
          saveState(dir, next, previous);
          return next;
        });
        progress.push({ taskId: item.taskId, progress: updated.tasks[item.taskId]?.progress || null });
      } catch (error) {
        progress.push({ taskId: item.taskId, error: error.message });
      }
    }
    writeJson({ ok: true, collected, accepted, started, progress });
    return;
  }
  if (command === 'collect') {
    const taskId = flag(args, '--task');
    if (!taskId) fail('--task is required');
    const root = repoRoot(args);
    const dir = caseDir(args);
    const blocked = instructionGuard({ root, caseDir: dir, taskId });
    if (blocked) {
      writeJson({ ok: false, blocked });
      return;
    }
    writeJson(collectTask({ root, caseDir: dir, taskId }));
    return;
  }
  if (command === 'verify') {
    const taskId = flag(args, '--task');
    const manifest = flag(args, '--manifest');
    if (!taskId || !manifest) fail('--task and --manifest are required');
    const root = repoRoot(args);
    const dir = caseDir(args);
    const blocked = instructionGuard({ root, caseDir: dir, taskId });
    if (blocked) {
      writeJson({ ok: false, blocked });
      return;
    }
    writeJson(verifyTask({ root, caseDir: dir, taskId, manifestPath: manifest }));
    return;
  }
  if (command === 'accept') {
    const taskId = flag(args, '--task');
    const manifest = flag(args, '--manifest');
    if (!taskId || !manifest) fail('--task and --manifest are required');
    const root = repoRoot(args);
    const dir = caseDir(args);
    const blocked = instructionGuard({ root, caseDir: dir, taskId });
    if (blocked) {
      writeJson({ ok: false, blocked });
      return;
    }
    writeJson(acceptTask({ root, caseDir: dir, taskId, manifestPath: manifest }));
    return;
  }
  if (command === 'reconcile') {
    const root = repoRoot(args);
    const dir = caseDir(args);
    const owner = flag(args, '--owner') || process.env.USER || 'parent';
    const state = reconcileCase({ root, caseDir: dir, owner });
    const started = [];
    if (!args.includes('--no-start')) {
      for (const task of Object.values(state.tasks)) {
        if (task.state !== 'READY') continue;
        const blocked = instructionGuard({ root, caseDir: dir, taskId: task.id });
        if (blocked) {
          started.push({ taskId: task.id, blocked });
          continue;
        }
        try {
          const result = dispatchTask({ root, caseDir: dir, taskId: task.id, owner });
          started.push({ taskId: task.id, ...result });
        } catch (error) {
          started.push({ taskId: task.id, error: error.message });
        }
      }
    }
    writeJson({ ok: true, started });
    return;
  }
  if (command === 'watch') {
    const { values, noStart } = parseWatchOptions(args);
    const repoValue = values.get('--repo');
    const root = resolve(repoValue || process.cwd());
    const caseRelative = values.get('--case');
    if (!caseRelative) fail('watch: --case is required');
    const dir = resolveCaseDir(root, caseRelative);
    const owner = values.get('--owner') || process.env.USER || 'parent';
    const intervalMs = watchPositiveSafeInteger(values.get('--interval-ms'), '--interval-ms');
    const durationMs = watchPositiveSafeInteger(values.get('--duration-ms'), '--duration-ms');
    const maxTicks = watchPositiveSafeInteger(values.get('--max-ticks'), '--max-ticks');
    const rawTask = values.get('--task');
    const rawManifest = values.get('--manifest');
    if (rawTask !== undefined && !rawTask) fail('watch: --task must be non-empty');
    if (rawManifest !== undefined && !rawManifest) fail('watch: --manifest must be non-empty');
    if ((rawTask !== undefined) !== (rawManifest !== undefined)) {
      fail('watch: --task and --manifest must be provided together');
    }
    const taskId = rawTask === undefined ? null : rawTask;
    const manifest = rawManifest === undefined ? null : rawManifest;
    const lockPath = join(dir, 'watch.lock');
    let lockToken = null;
    let cancelReason = null;
    let wakeSleep = null;
    let signalsInstalled = false;
    let activeTick = null;
    const wakeIfSleeping = () => {
      if (!wakeSleep) return;
      const wake = wakeSleep;
      wake();
    };
    const abortActiveTick = (reason) => {
      if (!activeTick) return;
      activeTick.abort(reason);
    };
    const cancelWatch = (reason) => {
      if (!cancelReason) cancelReason = reason;
      wakeIfSleeping();
      abortActiveTick(cancelReason);
    };
    const onSigint = () => {
      process.exitCode = 130;
      cancelWatch('SIGINT');
    };
    const onSigterm = () => {
      process.exitCode = 143;
      cancelWatch('SIGTERM');
    };
    try {
      lockToken = acquireReviewRequestFileLock(lockPath, { timeoutMs: 100 });
      process.on('SIGINT', onSigint);
      process.on('SIGTERM', onSigterm);
      signalsInstalled = true;
      const startedAt = Date.now();
      const deadline = startedAt + durationMs;
      const tickArgs = ['tick', '--repo', root, '--case', caseRelative, '--owner', owner];
      if (taskId !== null) tickArgs.push('--task', taskId, '--manifest', manifest);
      if (noStart) tickArgs.push('--no-start');
      const cliPath = fileURLToPath(import.meta.url);
      const runTick = ({ deadline: tickDeadline }) => new Promise((resolveTick) => {
        const child = spawn(process.execPath, [cliPath, ...tickArgs], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let abortedReason = null;
        let timer = null;
        let escalateTimer = null;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (escalateTimer) clearTimeout(escalateTimer);
          if (activeTick && activeTick.child === child) activeTick = null;
          resolveTick(value);
        };
        const abort = (reason) => {
          if (settled) return;
          if (child.exitCode !== null || child.signalCode !== null) return;
          abortedReason = reason || abortedReason || 'cancelled';
          child.kill('SIGTERM');
          escalateTimer = setTimeout(() => {
            if (!settled && child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL');
            }
          }, 250);
          escalateTimer.unref?.();
        };
        child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        child.on('error', (error) => finish({ error, stdout, stderr }));
        child.on('close', (code, signal) => {
          if (settled) return;
          if (abortedReason) {
            finish({ aborted: true, reason: abortedReason, code, signal, stdout, stderr });
          } else if (code === 0) {
            finish({ stdout, stderr, code, signal });
          } else {
            finish({ error: new Error(`tick exited code=${code} signal=${signal}`), stdout, stderr, code, signal });
          }
        });
        activeTick = { child, abort };
        const remaining = tickDeadline - Date.now();
        if (remaining <= 0) {
          abort('duration');
        } else {
          timer = setTimeout(() => abort('duration'), remaining);
        }
      });
      let tickCount = 0;
      while (!cancelReason && tickCount < maxTicks && Date.now() < deadline) {
        tickCount += 1;
        const tick = await runTick({ deadline });
        if (tick.aborted) break;
        if (tick.error) {
          const detail = tick.stderr || tick.error?.message || String(tick.error);
          fail(`watch tick ${tickCount} failed: ${String(detail).trim()}`);
        }
        let tickResult;
        try {
          tickResult = JSON.parse(tick.stdout);
        } catch (error) {
          fail(`watch tick ${tickCount} parse failed: ${error.message}`);
        }
        process.stdout.write(`${JSON.stringify({
          ok: true,
          watch: true,
          tick: tickCount,
          maxTicks,
          elapsedMs: Date.now() - startedAt,
          result: tickResult,
        })}\n`);
        if (cancelReason) break;
        if (tickCount >= maxTicks) break;
        const now = Date.now();
        if (now >= deadline) break;
        const sleepMs = Math.min(intervalMs, deadline - now);
        if (sleepMs <= 0) break;
        await new Promise((resolveSleep) => {
          let settled = false;
          const timer = setTimeout(() => {
            settled = true;
            wakeSleep = null;
            resolveSleep();
          }, sleepMs);
          wakeSleep = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            wakeSleep = null;
            resolveSleep();
          };
          if (cancelReason) wakeSleep();
        });
      }
      process.stdout.write(`${JSON.stringify({
        ok: true,
        watch: true,
        ticks: tickCount,
        maxTicks,
        intervalMs,
        durationMs,
        elapsedMs: Date.now() - startedAt,
        cancelled: cancelReason || null,
      })}\n`);
    } finally {
      if (signalsInstalled) {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
      }
      if (lockToken !== null) {
        releaseReviewRequestFileLock(lockPath, lockToken);
      }
    }
    return;
  }
  if (command === 'review-chunks') {
    const root = repoRoot(args);
    const dir = caseDir(args);
    const purpose = flag(args, '--purpose');
    const round = Number(flag(args, '--round') || '1');
    const resultsPath = flag(args, '--results');
    if (!purpose || !resultsPath) fail('--purpose and --results are required');
    const reviewPlanProducer = await import('./deepseek-primary-review.mjs');
    const result = withCaseLock(dir, () => {
      const state = loadState(dir);
      const reviewPlan = reviewPlanProducer.planReviewChunks(root, round);
      if (!reviewPlan || typeof reviewPlan.planHash !== 'string') fail('review plan missing planHash');
      if (reviewPlan.task?.taskId !== state.taskId || reviewPlan.task?.taskFingerprint !== state.taskFingerprint) {
        fail('review plan task/fingerprint does not match continuity state');
      }
      const resultsAbsolute = resolveRepoPath(root, resultsPath, 'review chunk results');
      ensureRegularFile(resultsAbsolute, 'review chunk results');
      const results = JSON.parse(readFileSync(resultsAbsolute, 'utf8'));
      const merged = reviewPlanProducer.mergeChunkResults(results, reviewPlan);
      if (merged.rejected.length) {
        fail(`review chunk results rejected: ${merged.rejected.map((item) => `${item.index}:${item.reason}`).join('; ')}`);
      }
      const existing = state.reviewPurposes?.[purpose] || null;
      if (existing && existing.planHash !== reviewPlan.planHash) {
        fail(`unknown history: review purpose ${purpose} has planHash ${existing.planHash}, new plan ${reviewPlan.planHash}`);
      }
      if (existing && (!Array.isArray(existing.consumed) || !existing.chunks || typeof existing.chunks !== 'object')) {
        fail(`review purpose ${purpose} has unresolved prior history; refusing to adopt unknown ledger shape`);
      }
      const previousChunks = existing?.chunks || {};
      const previousRetired = existing?.retiredChunks || {};
      if (existing?.retiredChunks !== undefined && (typeof existing.retiredChunks !== 'object' || Array.isArray(existing.retiredChunks))) {
        fail(`review purpose ${purpose} has invalid retired chunk history`);
      }
      const retiredChunks = { ...(previousRetired || {}) };
      const attemptIds = new Set([
        ...Object.values(previousChunks).map((item) => item.attemptId).filter(Boolean),
        ...Object.values(retiredChunks).map((item) => item.attemptId).filter(Boolean),
      ]);
      const currentChunks = {};
      for (const [key, item] of Object.entries(previousChunks)) {
        if (!item || typeof item !== 'object' || !item.reservation || !Number.isSafeInteger(item.reservation.reservedYen) || item.reservation.reservedYen <= 0 || item.reservation.state !== 'reserved') {
          fail(`review purpose ${purpose} chunk ${key} has unresolved reservation history; refusing unknown ledger shape`);
        }
        const index = Number(key);
        const part = reviewPlan.parts[index];
        try {
          if (!Number.isInteger(index) || !item.result || !part || part.over) throw new Error(`plan part ${key} is not reviewable`);
          const attempt = validateReviewChunkAttempt({
            root,
            entry: item.result,
            caseId: state.caseId,
            taskId: state.taskId,
            taskFingerprint: state.taskFingerprint,
            planHash: reviewPlan.planHash,
            index,
            manifestHash: part.manifestHash,
            expectedBinding: part.binding,
            total: reviewPlan.total,
          });
          if (attempt.attemptId !== item.attemptId) throw new Error(`attempt id changed from ${item.attemptId} to ${attempt.attemptId}`);
          if (item.planHash !== reviewPlan.planHash || item.manifestHash !== part.manifestHash) throw new Error('plan/manifest binding changed');
          currentChunks[index] = item;
        } catch (error) {
          const retiredKey = `${index}:${item.attemptId || key}`;
          retiredChunks[retiredKey] = {
            ...item,
            retiredAt: new Date().toISOString(),
            retiredReason: `stale retained chunk: ${error.message}`,
          };
        }
      }
      const importedChunks = { ...currentChunks };
      const acceptedIndexes = [];
      const acceptedEntries = [];
      for (const entry of results) {
        const index = entry?.index;
        if (!Number.isInteger(index) || index < 0 || index >= reviewPlan.total) continue;
        const part = reviewPlan.parts[index];
        if (!part || part.over) continue;
        if (entry.planHash !== reviewPlan.planHash || entry.manifestHash !== part.manifestHash) continue;
        const attempt = validateReviewChunkAttempt({ root, entry, caseId: state.caseId, taskId: state.taskId, taskFingerprint: state.taskFingerprint, planHash: reviewPlan.planHash, index, manifestHash: part.manifestHash, expectedBinding: part.binding, total: reviewPlan.total });
        if (importedChunks[index]?.attemptId === attempt.attemptId) {
          const prior = importedChunks[index];
          if (prior.manifestHash !== part.manifestHash) {
            fail(`review chunk attempt ${attempt.attemptId} is already bound to another manifest`);
          }
          if (prior.reservation.reservedYen !== attempt.reservation.reservedYen || prior.reservation.state !== attempt.reservation.state) {
            fail(`review chunk attempt ${attempt.attemptId} reservation changed`);
          }
          continue;
        }
        if (attemptIds.has(attempt.attemptId)) {
          const alreadyRetired = Object.values(retiredChunks).some((item) => item.attemptId === attempt.attemptId);
          if (alreadyRetired) continue;
          fail(`review chunk attempt ${attempt.attemptId} is already bound to another result`);
        }
        if (importedChunks[index]) {
          fail(`review chunk index ${index} already has current attempt ${importedChunks[index].attemptId}`);
        }
        importedChunks[index] = {
          index,
          planHash: reviewPlan.planHash,
          manifestHash: part.manifestHash,
          receiptRef: attempt.receiptRef,
          attemptId: attempt.attemptId,
          reservation: attempt.reservation,
          result: entry,
          importedAt: new Date().toISOString(),
        };
        attemptIds.add(attempt.attemptId);
        acceptedIndexes.push(index);
        acceptedEntries.push(entry);
      }
      const historyEntries = Object.keys(importedChunks)
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => importedChunks[key].result);
      const unionMerged = reviewPlanProducer.mergeChunkResults(historyEntries, reviewPlan);
      if (unionMerged.rejected.length) {
        fail(`review chunk history rejected: ${unionMerged.rejected.map((item) => `${item.index}:${item.reason}`).join('; ')}`);
      }
      const consumed = Object.keys(importedChunks).map(Number).sort((a, b) => a - b);
      const pending = unionMerged.missingChunks.slice().sort((a, b) => a - b);
      const complete = unionMerged.complete === true && unionMerged.unverified.length === 0 && pending.length === 0;
      const reservedYen = [...Object.values(importedChunks), ...Object.values(retiredChunks)]
        .reduce((sum, item) => sum + Number(item.reservation?.reservedYen || 0), 0);
      const nextState = JSON.parse(JSON.stringify(state));
      nextState.reviewPurposes = nextState.reviewPurposes || {};
      if (existing?.planHistory !== undefined && !Array.isArray(existing.planHistory)) {
        fail(`review purpose ${purpose} has invalid plan history`);
      }
      const planHistory = Array.isArray(existing?.planHistory) ? existing.planHistory : [];
      const nextLedger = {
        ...(existing || {}),
        purposeId: purpose,
        planHash: reviewPlan.planHash,
        total: reviewPlan.total,
        consumed,
        chunks: importedChunks,
        retiredChunks,
        pending,
        completed: complete,
        reviewVerdict: unionMerged.verdict,
        reviewAttemptCount: consumed.length,
        retiredAttemptCount: Object.keys(retiredChunks).length,
        reservedYen,
        planHistory: planHistory.some((item) => item.planHash === reviewPlan.planHash)
          ? planHistory
          : [...planHistory, { planHash: reviewPlan.planHash, total: reviewPlan.total, at: new Date().toISOString() }],
        updatedAt: new Date().toISOString(),
      };
      nextState.reviewPurposes[purpose] = nextLedger;
      nextState.updatedAt = new Date().toISOString();
      saveState(dir, nextState, state);
      return {
        ok: true,
        purpose,
        planHash: reviewPlan.planHash,
        total: reviewPlan.total,
        acceptedIndexes,
        pending,
        complete,
        consumed,
        reviewVerdict: unionMerged.verdict,
        reviewAttemptCount: consumed.length,
        retiredAttemptCount: Object.keys(retiredChunks).length,
        reservedYen,
        counters: nextState.counters,
        budgetReservations: nextState.budgetReservations,
      };
    });
    writeJson(result);
    return;
  }
  if (command === 'status') {
    writeJson(statusCase({ caseDir: caseDir(args) }));
    return;
  }
  if (command === 'progress') {
    const root = repoRoot(args);
    const dir = caseDir(args);
    const taskId = flag(args, '--task');
    if (!taskId) fail('--task is required');
    const setRaw = flag(args, '--set');
    if (setRaw) {
      const patch = JSON.parse(setRaw);
      const state = withCaseLock(dir, () => {
        const previous = loadState(dir);
        const next = applyProgressInput({ root, state: previous, taskId, patch });
        saveState(dir, next, previous);
        return next;
      });
      writeJson({ ok: true, taskId, progress: state.tasks[taskId].progress });
      return;
    }
    if (args.includes('--scan-deadline')) {
      const state = withCaseLock(dir, () => {
        const previous = loadState(dir);
        const next = scanProgressDeadline({ state: previous, taskId, now: new Date().toISOString() });
        if (next !== previous) saveState(dir, next, previous);
        return next;
      });
      writeJson({ ok: true, taskId, progress: state.tasks[taskId].progress, scanned: true });
      return;
    }
    const state = loadState(dir);
    writeJson({ taskId, progress: state.tasks[taskId]?.progress || null });
    return;
  }
  fail(`unknown command: ${command || '(none)'}`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exit(2);
});
