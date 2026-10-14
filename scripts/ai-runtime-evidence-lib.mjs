#!/usr/bin/env node
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_EVIDENCE_SCHEMA_VERSION = 1;
export const RUNTIME_EVIDENCE_SOURCES = Object.freeze(['launch_argv', 'provider_observed']);
const MODEL_PATTERN = /^[a-z0-9.-]{1,80}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PANE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/u;

function fail(message) {
  throw new Error(`RUNTIME_EVIDENCE_ERROR: ${message}`);
}

function oneLine(value, max = 300) {
  return String(value ?? '').replace(/[\r\n\t]+/gu, ' ').slice(0, max);
}

function assertTrustedEffort(expectedEffort, label = 'expected effort') {
  if (typeof expectedEffort !== 'string' || !expectedEffort.trim()) {
    fail(`${label} must be a non-empty string`);
  }
  return expectedEffort;
}

function assertLaunchEffortMatches(launchEffort, expectedEffort, label = 'pane launch evidence effort') {
  assertTrustedEffort(expectedEffort);
  if (typeof launchEffort !== 'string' || !launchEffort.trim()) {
    fail(`${label} is missing`);
  }
  if (launchEffort !== expectedEffort) {
    fail(`${label} mismatch`);
  }
}

export function sha256Value(value) {
  return createHash('sha256').update(Buffer.from(String(value ?? ''), 'utf8')).digest('hex');
}

export function sha256File(path) {
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

export const RUNTIME_EVIDENCE_MARKER_KEY = 'runtimeEvidenceSchemaVersion';

function safeRelativeEvidencePath(mode, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
    fail('runtime evidence path must be a safe relative path');
  }
  const prefix = mode === 'pane' ? '.ai/context/runtime-model-evidence/' : 'runtime-model-evidence/';
  if (!relativePath.startsWith(prefix)) fail(`runtime evidence path must be under ${prefix}`);
  return relativePath;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function paneAgentScriptPath() {
  return join(SCRIPT_DIR, 'agent-pane.sh');
}

function readAgentPaneGet(paneId) {
  let raw;
  try {
    raw = execFileSync(paneAgentScriptPath(), ['get', paneId], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    fail(`agent-pane.sh get failed for ${paneId}: ${oneLine(error?.stderr || error?.message || error, 300)}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    fail(`agent-pane.sh get returned invalid JSON: ${error.message}`);
  }
  const pane = data?.result?.pane ?? data?.result?.agent ?? data?.pane;
  if (!pane || typeof pane !== 'object' || Array.isArray(pane)) {
    fail('agent-pane.sh get response missing pane object');
  }
  return pane;
}

function assertSessionIdentity(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  if (value.backend !== 'orca') fail(`${label}.backend must be orca`);
  if (value.field !== 'incarnationId') fail(`${label}.field must be incarnationId`);
  if (typeof value.value !== 'string' || !value.value.trim()) fail(`${label}.value must be a non-empty string`);
  return value;
}

function sessionIdentityKey(value) {
  const session = assertSessionIdentity(value, 'sessionIdentity');
  return `${session.backend}|${session.field}|${session.value}`;
}

function sameSessionIdentity(left, right) {
  return sessionIdentityKey(left) === sessionIdentityKey(right);
}

function realPathOrFail(path, label) {
  try {
    return realpathSync(path);
  } catch (error) {
    fail(`${label} is not a real path: ${oneLine(path, 300)}`);
  }
}

function assertPaneLaunchDoc(doc, { repoReal, paneId, expectedModel }) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('pane launch evidence must be an object');
  if (doc.schemaVersion !== RUNTIME_EVIDENCE_SCHEMA_VERSION) fail('pane launch evidence schema version mismatch');
  if (doc.kind !== 'pane_launch') fail('pane launch evidence kind mismatch');
  if (doc.runtimeEvidenceSchemaVersion !== RUNTIME_EVIDENCE_SCHEMA_VERSION) fail('pane launch evidence runtime schema version mismatch');
  if (doc.actualRuntimeModelSource !== 'launch_argv') fail('pane launch evidence source must be launch_argv');
  if (doc.actualRuntimeModel !== expectedModel) fail('pane launch evidence model mismatch');
  if (doc.argvModel !== doc.actualRuntimeModel) fail('pane launch evidence argv/model mismatch');
  if (doc.paneId !== paneId) fail('pane launch evidence pane id mismatch');
  if (doc.repoRealpath !== repoReal) fail('pane launch evidence repo realpath mismatch');
  if (typeof doc.paneCwd !== 'string' || !doc.paneCwd) fail('pane launch evidence pane cwd is missing');
  if (typeof doc.agentKind !== 'string' || !doc.agentKind) fail('pane launch evidence agent kind is missing');
  if (doc.launchStatus !== 'started' && doc.launchStatus !== 'completed') fail('pane launch evidence launch status is invalid');
  assertSessionIdentity(doc.sessionIdentity, 'pane launch evidence sessionIdentity');
  return doc;
}

export function verifyPaneRuntimeEvidence({ repoRoot, requestId, round, contentHash, reviewHeadCommit, evidencePath, evidenceSha256, expectedPaneId, expectedRuntimeModel, expectedEffort }) {
  const repoReal = realpathSync(repoRoot);
  safeRelativeEvidencePath('pane', evidencePath);
  const bindingFullPath = join(repoReal, evidencePath);
  ensureSafeDirectory(dirname(bindingFullPath));
  assertRegularNonSymlink(bindingFullPath, 'pane request binding');
  if (sha256File(bindingFullPath) !== evidenceSha256) fail('pane request binding sha256 mismatch');
  const binding = readJsonRegular(bindingFullPath, 'pane request binding', { maxBytes: 64 * 1024 });
  if (binding.schemaVersion !== RUNTIME_EVIDENCE_SCHEMA_VERSION) fail('pane request binding schema version mismatch');
  if (binding.kind !== 'pane_request_binding') fail('pane request binding kind mismatch');
  if (binding.runtimeEvidenceSchemaVersion !== RUNTIME_EVIDENCE_SCHEMA_VERSION) fail('pane request binding runtime schema version mismatch');
  if (binding.requestId !== requestId) fail('pane request binding request id mismatch');
  if (binding.round !== round) fail('pane request binding round mismatch');
  if (binding.contentHash !== contentHash) fail('pane request binding contentHash mismatch');
  if (binding.reviewHeadCommit !== reviewHeadCommit) fail('pane request binding reviewHeadCommit mismatch');
  if (binding.paneId !== expectedPaneId) fail('pane request binding pane id mismatch');
  if (binding.repoRealpath !== repoReal) fail('pane request binding repo realpath mismatch');
  if (binding.actualRuntimeModel !== expectedRuntimeModel) fail('pane request binding model mismatch');
  if (binding.actualRuntimeModelSource !== 'launch_argv') fail('pane request binding source must be launch_argv');
  assertSessionIdentity(binding.sessionIdentity, 'pane request binding sessionIdentity');
  safeRelativeEvidencePath('pane', binding.launchEvidencePath);
  const launchFullPath = join(repoReal, binding.launchEvidencePath);
  ensureSafeDirectory(dirname(launchFullPath));
  assertRegularNonSymlink(launchFullPath, 'pane launch evidence');
  if (sha256File(launchFullPath) !== binding.launchEvidenceSha256) fail('pane launch evidence sha256 mismatch');
  const launch = readJsonRegular(launchFullPath, 'pane launch evidence', { maxBytes: 64 * 1024 });
  assertPaneLaunchDoc(launch, { repoReal, paneId: expectedPaneId, expectedModel: expectedRuntimeModel });
  if (!sameSessionIdentity(binding.sessionIdentity, launch.sessionIdentity)) fail('pane request binding session identity mismatch');
  if (binding.paneCwd !== launch.paneCwd) fail('pane request binding pane cwd mismatch');
  if (binding.agentKind !== launch.agentKind) fail('pane request binding agent kind mismatch');
  assertLaunchEffortMatches(launch.effort, expectedEffort);
  return {
    binding,
    launch,
    sessionIdentity: binding.sessionIdentity,
    bindingPath: evidencePath,
    bindingSha256: evidenceSha256,
    launchPath: binding.launchEvidencePath,
    launchSha256: binding.launchEvidenceSha256,
  };
}

export function verifyQueueRuntimeEvidence({ entryDir, requestId, round, inputHash, attempt, leaseGeneration, ownerToken, evidencePath, evidenceSha256, actualRuntimeModel, actualRuntimeModelSource, expectedEffort = undefined }) {
  const entryReal = realpathSync(entryDir);
  safeRelativeEvidencePath('queue', evidencePath);
  const fullPath = join(entryReal, evidencePath);
  ensureSafeDirectory(dirname(fullPath));
  assertRegularNonSymlink(fullPath, 'queue runtime evidence');
  if (sha256File(fullPath) !== evidenceSha256) fail('queue runtime evidence sha256 mismatch');
  const doc = readJsonRegular(fullPath, 'queue runtime evidence', { maxBytes: 64 * 1024 });
  if (doc.schemaVersion !== RUNTIME_EVIDENCE_SCHEMA_VERSION) fail('queue runtime evidence schema version mismatch');
  if (doc.kind !== 'queue_launch') fail('queue runtime evidence kind mismatch');
  if (actualRuntimeModelSource !== 'launch_argv') fail('queue runtime evidence caller source must be launch_argv');
  if (doc.actualRuntimeModelSource !== actualRuntimeModelSource) fail('queue runtime evidence source mismatch');
  if (doc.actualRuntimeModelSource !== 'launch_argv') fail('queue runtime evidence source must be launch_argv');
  if (doc.actualRuntimeModel !== actualRuntimeModel) fail('queue runtime evidence model mismatch');
  if (doc.argvModel !== doc.actualRuntimeModel) fail('queue runtime evidence argv/model mismatch');
  if (doc.requestId !== requestId) fail('queue runtime evidence request id mismatch');
  if (doc.round !== round) fail('queue runtime evidence round mismatch');
  if (doc.inputHash !== inputHash) fail('queue runtime evidence inputHash mismatch');
  if (doc.attempt !== attempt) fail('queue runtime evidence attempt mismatch');
  if (doc.leaseGeneration !== leaseGeneration) fail('queue runtime evidence lease generation mismatch');
  if (doc.ownerToken !== ownerToken) fail('queue runtime evidence owner token mismatch');
  if (doc.queueEntryRealpath !== entryReal) fail('queue runtime evidence queue entry realpath mismatch');
  if (doc.launchStatus !== 'completed') fail('queue runtime evidence launch status mismatch');
  if (expectedEffort !== undefined && String(doc.effort || '') !== String(expectedEffort)) fail('queue runtime evidence effort mismatch');
  return doc;
}

function fallbackLockDirPath(lockPath) {
  return `${lockPath}.lock`;
}

function fallbackLockOwnerPath(lockPath) {
  return join(fallbackLockDirPath(lockPath), 'owner-token');
}

export function acquireReviewRequestFileLock(lockPath, { timeoutMs = 10_000 } = {}) {
  const fallbackDir = fallbackLockDirPath(lockPath);
  const ownerPath = fallbackLockOwnerPath(lockPath);
  const token = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let created = false;
    try {
      mkdirSync(fallbackDir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') fail(`review-request lock acquisition failed: ${error.message}`);
      let info;
      try {
        info = lstatSync(fallbackDir);
      } catch (statError) {
        if (statError?.code !== 'ENOENT') fail(`review-request lock stat failed: ${statError.message}`);
      }
      if (info && (!info.isDirectory() || info.isSymbolicLink())) {
        fail('review-request fallback lock is not a safe directory');
      }
    }
    if (created) {
      try {
        const fd = openSync(
          ownerPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
          0o600,
        );
        try {
          writeFileSync(fd, token);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return token;
      } catch (error) {
        try {
          rmdirSync(fallbackDir);
        } catch {
          // best-effort cleanup; if the directory is not empty, leave it fail-closed.
        }
        fail(`review-request lock acquisition failed: ${error.message}`);
      }
    }
    if (Date.now() >= deadline) {
      fail('review-request lock acquisition timed out; existing fallback lock was not reclaimed (manual recovery required if owner is gone)');
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

export function releaseReviewRequestFileLock(lockPath, token) {
  const fallbackDir = fallbackLockDirPath(lockPath);
  const ownerPath = fallbackLockOwnerPath(lockPath);
  let dirInfo;
  try {
    dirInfo = lstatSync(fallbackDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    fail(`review-request lock release failed: ${error.message}`);
  }
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
    fail('review-request fallback lock is not a safe directory');
  }
  let current = null;
  try {
    const fd = openSync(ownerPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    try {
      const buffer = Buffer.allocUnsafe(4096);
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      current = buffer.subarray(0, count).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    fail(`review-request lock release failed: ${error.message}`);
  }
  if (current !== token) return;
  try {
    unlinkSync(ownerPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') fail(`review-request lock release failed: ${error.message}`);
  }
  try {
    rmdirSync(fallbackDir);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') {
      fail(`review-request lock release failed: ${error.message}`);
    }
  }
}

export function withReviewRequestLock(repoRoot, fn) {
  const repoReal = realpathSync(repoRoot);
  const contextDir = join(repoReal, '.ai', 'context');
  ensureSafeDirectory(contextDir, { create: true });
  const lockPath = join(contextDir, '.review-request.lock');
  const token = acquireReviewRequestFileLock(lockPath);
  try {
    if (process.platform === 'win32') {
      return fn();
    }
    let lockInfo;
    try {
      lockInfo = lstatSync(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') fail(`review-request lock stat failed: ${error.message}`);
    }
    if (lockInfo && (!lockInfo.isFile() || lockInfo.isSymbolicLink())) {
      fail('review-request lock is not a regular non-symlink file');
    }
    const fd = openSync(
      lockPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      fchmodSync(fd, 0o600);
      try {
        execFileSync('flock', ['-w', '10', '3'], { stdio: ['ignore', 'ignore', 'inherit', fd] });
      } catch (error) {
        if (error?.code === 'ENOENT') return fn();
        fail(`review-request lock acquisition failed: ${error.message}`);
      }
      return fn();
    } finally {
      closeSync(fd);
    }
  } finally {
    releaseReviewRequestFileLock(lockPath, token);
  }
}


function ensureSafeDirectory(path, { create = false, mode = 0o700 } = {}) {
  const chain = [];
  let current = resolve(path);
  while (true) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const directory of chain.reverse()) {
    let info;
    try {
      info = lstatSync(directory);
    } catch (error) {
      if (error?.code !== 'ENOENT') fail(`directory stat failed: ${directory}`);
      if (!create) fail(`directory missing: ${directory}`);
      mkdirSync(directory, { mode });
      info = lstatSync(directory);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`not a safe directory: ${directory}`);
  }
}

function assertRegularNonSymlink(path, label) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} is not a regular non-symlink file`);
  return info;
}

function readJsonRegular(path, label, { maxBytes = null } = {}) {
  const info = assertRegularNonSymlink(path, label);
  if (Number.isFinite(maxBytes) && info.size > maxBytes) fail(`${label} exceeds ${maxBytes} bytes`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function writeNewEvidenceFile(baseDir, fileName, doc) {
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    fail('evidence file name is invalid');
  }
  ensureSafeDirectory(baseDir, { create: true });
  const target = join(baseDir, fileName);
  if (existsSync(target)) fail(`evidence already exists: ${fileName}`);
  const fd = openSync(
    target,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { path: target, sha256: sha256File(target) };
}

export function recordPaneLaunch({
  repoRoot,
  paneId,
  actualRuntimeModel,
  argvModel,
  effort,
  launchStatus = 'started',
  launchNonce = '',
}) {
  if (!PANE_ID_PATTERN.test(String(paneId || ''))) fail('pane id is invalid');
  const repoReal = realpathSync(repoRoot);
  const model = String(actualRuntimeModel || '');
  const argv = String(argvModel || '');
  if (!MODEL_PATTERN.test(model) || !MODEL_PATTERN.test(argv) || model !== argv) {
    fail('pane runtime model must be a canonical argv model');
  }
  if (!['started', 'completed'].includes(launchStatus)) fail('invalid launch status');
  const nonce = oneLine(launchNonce, 128);
  if (!nonce) fail('pane launch nonce is required');
  const pane = readAgentPaneGet(String(paneId));
  const normalizedPaneId = String(pane.pane_id || pane.id || '');
  if (normalizedPaneId !== String(paneId)) fail('agent-pane.sh get pane id mismatch');
  const incarnationId = String(pane.incarnationId || '');
  if (!incarnationId.trim()) fail('agent-pane.sh get missing Orca incarnationId');
  const sessionIdentity = assertSessionIdentity({ backend: 'orca', field: 'incarnationId', value: incarnationId }, 'agent-pane.sh get sessionIdentity');
  const worktreePath = String(pane.worktreePath || '');
  if (!worktreePath) fail('agent-pane.sh get missing worktreePath');
  const paneCwd = String(pane.cwd || worktreePath);
  const normalizedCwd = realPathOrFail(paneCwd, 'pane cwd');
  const normalizedWorktree = realPathOrFail(worktreePath, 'pane worktreePath');
  if (normalizedCwd !== normalizedWorktree) fail('agent-pane.sh get cwd/worktreePath mismatch');
  if (normalizedCwd !== repoReal) fail('agent-pane.sh get cwd/repoRoot mismatch');
  const agentIdentity = String(pane.agentIdentity || '');
  const normalizedAgent = String(pane.agent || '');
  if (!agentIdentity) fail('agent-pane.sh get missing agentIdentity');
  if (agentIdentity !== normalizedAgent) fail('agent-pane.sh get agentIdentity/agent mismatch');
  const fileName = `pane-${sha256Value(`${paneId}|${sessionIdentity.value}|${nonce}`)}.json`;
  const baseDir = join(repoReal, '.ai', 'context', 'runtime-model-evidence');
  const doc = {
    schemaVersion: RUNTIME_EVIDENCE_SCHEMA_VERSION,
    kind: 'pane_launch',
    runtimeEvidenceSchemaVersion: RUNTIME_EVIDENCE_SCHEMA_VERSION,
    paneId: String(paneId),
    repoRealpath: repoReal,
    paneCwd: normalizedCwd,
    agentKind: agentIdentity,
    sessionIdentity,
    launchNonce: nonce,
    actualRuntimeModel: model,
    actualRuntimeModelSource: 'launch_argv',
    argvModel: argv,
    effort: oneLine(effort, 80),
    launchStatus,
    createdAt: new Date().toISOString(),
    [RUNTIME_EVIDENCE_MARKER_KEY]: 1,
  };
  const written = writeNewEvidenceFile(baseDir, fileName, doc);
  return {
    relativePath: `.ai/context/runtime-model-evidence/${fileName}`,
    sha256: written.sha256,
    paneId: String(paneId),
    sessionIdentity,
    launchNonce: nonce,
  };
}

export function createQueueRuntimeEvidence({
  entryDir,
  requestId,
  round,
  inputHash,
  attempt,
  leaseGeneration,
  ownerToken,
  queueEntryRealpath,
  actualRuntimeModel,
  argvModel,
  effort,
  launchStatus = 'completed',
}) {
  if (!IDENTIFIER_PATTERN.test(String(requestId || ''))) fail('request id is invalid');
  if (!Number.isInteger(attempt) || attempt < 1 || !Number.isInteger(leaseGeneration) || leaseGeneration < 1) {
    fail('queue attempt or lease generation is invalid');
  }
  if (!Number.isInteger(round)) fail('queue round is invalid');
  const entryReal = realpathSync(entryDir);
  const model = String(actualRuntimeModel || '');
  const argv = String(argvModel || '');
  if (!MODEL_PATTERN.test(model) || !MODEL_PATTERN.test(argv) || model !== argv) {
    fail('queue runtime model must be a canonical argv model');
  }
  if (!['started', 'completed'].includes(launchStatus)) fail('invalid launch status');
  const fileName = `${attempt}-${leaseGeneration}.json`;
  const baseDir = join(entryReal, 'runtime-model-evidence');
  const doc = {
    schemaVersion: RUNTIME_EVIDENCE_SCHEMA_VERSION,
    kind: 'queue_launch',
    actualRuntimeModel: model,
    actualRuntimeModelSource: 'launch_argv',
    argvModel: argv,
    effort: oneLine(effort, 80),
    launchStatus,
    createdAt: new Date().toISOString(),
    launchNonce: randomUUID(),
    requestId,
    round,
    inputHash: String(inputHash || ''),
    attempt,
    leaseGeneration,
    ownerToken: String(ownerToken || ''),
    queueEntryRealpath: String(queueEntryRealpath || entryReal),
  };
  const written = writeNewEvidenceFile(baseDir, fileName, doc);
  return { relativePath: `runtime-model-evidence/${fileName}`, sha256: written.sha256 };
}

export function bindPaneRequest({ repoRoot, requestId, paneId, round, contentHash, reviewHeadCommit, launchEvidencePath, launchEvidenceSha256 }) {
  if (!IDENTIFIER_PATTERN.test(String(requestId || ''))) fail('request id is invalid');
  if (!PANE_ID_PATTERN.test(String(paneId || ''))) fail('pane id is invalid');
  if (!Number.isInteger(round) || round < 1) fail('round is invalid');
  if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(contentHash)) fail('contentHash is invalid');
  if (typeof reviewHeadCommit !== 'string' || !/^[a-f0-9]{7,64}$/iu.test(reviewHeadCommit)) fail('reviewHeadCommit is invalid');
  safeRelativeEvidencePath('pane', launchEvidencePath);
  if (typeof launchEvidenceSha256 !== 'string' || !SHA256_PATTERN.test(launchEvidenceSha256)) fail('launch evidence sha256 is invalid');
  const repoReal = realpathSync(repoRoot);
  const contextDir = join(repoReal, '.ai', 'context');
  const statePath = join(contextDir, 'review-request.json');
  return withReviewRequestLock(repoReal, () => {
    const state = readJsonRegular(statePath, 'review-request.json');
    if (state?.requestId !== requestId) fail('request id does not match parent state');
    if (state?.status !== 'sent') fail('parent state is not sent');
    if (state?.round !== round) fail('parent state round mismatch');
    if (state?.contentHash !== contentHash) fail('parent state contentHash mismatch');
    if (state?.reviewHeadCommit !== reviewHeadCommit) fail('parent state reviewHeadCommit mismatch');
    if (state?.[RUNTIME_EVIDENCE_MARKER_KEY] !== 1) fail('parent state runtimeEvidenceSchemaVersion must be numeric 1; legacy markerless state rejected');
    const launchFullPath = join(repoReal, launchEvidencePath);
    ensureSafeDirectory(dirname(launchFullPath));
    assertRegularNonSymlink(launchFullPath, 'pane launch evidence');
    if (sha256File(launchFullPath) !== launchEvidenceSha256) fail('pane launch evidence sha256 mismatch');
    const launch = readJsonRegular(launchFullPath, 'pane launch evidence', { maxBytes: 64 * 1024 });
    if (launch.schemaVersion !== RUNTIME_EVIDENCE_SCHEMA_VERSION) fail('pane launch evidence schema version mismatch');
    if (launch.kind !== 'pane_launch') fail('pane launch evidence kind mismatch');
    if (launch.runtimeEvidenceSchemaVersion !== RUNTIME_EVIDENCE_SCHEMA_VERSION) fail('pane launch evidence runtime schema version mismatch');
    if (launch.actualRuntimeModelSource !== 'launch_argv') fail('pane launch evidence source must be launch_argv');
    if (launch.actualRuntimeModel !== launch.argvModel) fail('pane launch evidence argv/model mismatch');
    if (launch.paneId !== String(paneId)) fail('pane launch evidence pane id mismatch');
    if (launch.repoRealpath !== repoReal) fail('pane launch evidence repo realpath mismatch');
    if (launch.launchStatus !== 'started' && launch.launchStatus !== 'completed') fail('pane launch evidence launch status is invalid');
    assertSessionIdentity(launch.sessionIdentity, 'pane launch evidence sessionIdentity');
    if (typeof launch.paneCwd !== 'string' || !launch.paneCwd) fail('pane launch evidence pane cwd is missing');
    if (typeof launch.agentKind !== 'string' || !launch.agentKind) fail('pane launch evidence agent kind is missing');
    assertTrustedEffort(state?.reviewerEffort, 'parent state reviewerEffort');
    assertLaunchEffortMatches(launch.effort, state.reviewerEffort);
    const livePane = readAgentPaneGet(String(paneId));
    const livePaneId = String(livePane.pane_id || livePane.id || '');
    if (livePaneId !== String(paneId)) fail('agent-pane.sh get pane id mismatch');
    const liveIncarnationId = String(livePane.incarnationId || '');
    if (!liveIncarnationId.trim()) fail('agent-pane.sh get missing Orca incarnationId');
    const liveSessionIdentity = assertSessionIdentity({ backend: 'orca', field: 'incarnationId', value: liveIncarnationId }, 'agent-pane.sh get sessionIdentity');
    if (!sameSessionIdentity(liveSessionIdentity, launch.sessionIdentity)) fail('agent-pane.sh get incarnationId mismatch');
    const liveWorktreePath = String(livePane.worktreePath || '');
    if (!liveWorktreePath) fail('agent-pane.sh get missing worktreePath');
    const liveCwd = String(livePane.cwd || liveWorktreePath);
    const launchCwdReal = realPathOrFail(launch.paneCwd, 'pane launch evidence paneCwd');
    if (realPathOrFail(liveCwd, 'agent-pane.sh get cwd') !== launchCwdReal) fail('agent-pane.sh get cwd mismatch');
    if (realPathOrFail(liveWorktreePath, 'agent-pane.sh get worktreePath') !== launchCwdReal) fail('agent-pane.sh get worktreePath mismatch');
    const liveAgentIdentity = String(livePane.agentIdentity || '');
    if (!liveAgentIdentity) fail('agent-pane.sh get missing agentIdentity');
    if (liveAgentIdentity !== launch.agentKind) fail('agent-pane.sh get agentIdentity mismatch');
    const liveNormalizedStatus = String(livePane.status || livePane.agent_status || '').toLowerCase();
    if (['done', 'failed', 'cancelled'].includes(liveNormalizedStatus)) fail(`agent-pane.sh get reports terminal status ${liveNormalizedStatus}`);
    if (livePane.connected !== true) fail('agent-pane.sh get connected is not true');
    if (livePane.orphaned !== false) fail('agent-pane.sh get orphaned is not false');
    if (livePane.writable !== true) fail('agent-pane.sh get writable is not true');
    const bindingFileName = `pane-request-binding-${sha256Value(`${requestId}|${String(paneId)}|${launchEvidenceSha256}`)}.json`;
    const bindingRelative = `.ai/context/runtime-model-evidence/${bindingFileName}`;
    const bindingFullPath = join(repoReal, bindingRelative);
    const bindingDoc = {
      schemaVersion: RUNTIME_EVIDENCE_SCHEMA_VERSION,
      kind: 'pane_request_binding',
      runtimeEvidenceSchemaVersion: RUNTIME_EVIDENCE_SCHEMA_VERSION,
      requestId,
      round,
      contentHash,
      reviewHeadCommit,
      paneId: String(paneId),
      repoRealpath: repoReal,
      sessionIdentity: launch.sessionIdentity,
      launchEvidencePath,
      launchEvidenceSha256,
      actualRuntimeModel: launch.actualRuntimeModel,
      actualRuntimeModelSource: 'launch_argv',
      paneCwd: launch.paneCwd,
      agentKind: launch.agentKind,
      boundAt: new Date().toISOString(),
      [RUNTIME_EVIDENCE_MARKER_KEY]: 1,
    };
    const runtimeBindingFields = [
      'actualRuntimeModel',
      'actualRuntimeModelSource',
      'actualRuntimeModelEvidencePath',
      'actualRuntimeModelEvidenceSha256',
      'actualRuntimeModelPaneId',
      'actualRuntimeModelSessionIdentity',
      'replyExecutionKind',
    ];
    const presentRuntimeFields = runtimeBindingFields.filter((key) => Object.hasOwn(state, key));
    let bindingSha256;
    ensureSafeDirectory(dirname(bindingFullPath));
    if (presentRuntimeFields.length === 0) {
      if (existsSync(bindingFullPath)) {
        assertRegularNonSymlink(bindingFullPath, 'pane request binding');
        bindingSha256 = sha256File(bindingFullPath);
        const existingBinding = readJsonRegular(bindingFullPath, 'pane request binding', { maxBytes: 64 * 1024 });
        if (existingBinding.schemaVersion !== RUNTIME_EVIDENCE_SCHEMA_VERSION) fail('existing pane request binding schema version mismatch');
        if (existingBinding.kind !== 'pane_request_binding') fail('existing pane request binding kind mismatch');
        if (existingBinding.runtimeEvidenceSchemaVersion !== RUNTIME_EVIDENCE_SCHEMA_VERSION) fail('existing pane request binding runtime schema version mismatch');
        if (existingBinding.requestId !== requestId || existingBinding.round !== round || existingBinding.contentHash !== contentHash || existingBinding.reviewHeadCommit !== reviewHeadCommit) fail('existing pane request binding request mismatch');
        if (existingBinding.paneId !== String(paneId)) fail('existing pane request binding pane mismatch');
        if (existingBinding.repoRealpath !== repoReal) fail('existing pane request binding repo realpath mismatch');
        if (existingBinding.launchEvidencePath !== launchEvidencePath || existingBinding.launchEvidenceSha256 !== launchEvidenceSha256) fail('existing pane request binding launch mismatch');
        if (existingBinding.actualRuntimeModel !== launch.actualRuntimeModel || existingBinding.actualRuntimeModelSource !== 'launch_argv') fail('existing pane request binding model mismatch');
        if (!sameSessionIdentity(existingBinding.sessionIdentity, launch.sessionIdentity)) fail('existing pane request binding session mismatch');
        if (existingBinding.paneCwd !== launch.paneCwd) fail('existing pane request binding pane cwd mismatch');
        if (existingBinding.agentKind !== launch.agentKind) fail('existing pane request binding agent kind mismatch');
      } else {
        const written = writeNewEvidenceFile(join(repoReal, '.ai', 'context', 'runtime-model-evidence'), bindingFileName, bindingDoc);
        bindingSha256 = written.sha256;
        if (bindingSha256 !== sha256File(bindingFullPath)) fail('pane request binding write verification failed');
      }
    } else if (presentRuntimeFields.length !== runtimeBindingFields.length) {
      fail('parent state has partial pane runtime binding fields');
    } else {
      if (state.actualRuntimeModelEvidencePath !== bindingRelative) fail('request already has a different pane request binding');
      assertRegularNonSymlink(bindingFullPath, 'pane request binding');
      bindingSha256 = sha256File(bindingFullPath);
      if (state.actualRuntimeModelEvidenceSha256 !== bindingSha256) fail('existing pane request binding sha256 mismatch');
      const existingBinding = readJsonRegular(bindingFullPath, 'pane request binding', { maxBytes: 64 * 1024 });
      if (existingBinding.schemaVersion !== RUNTIME_EVIDENCE_SCHEMA_VERSION) fail('existing pane request binding schema version mismatch');
      if (existingBinding.kind !== 'pane_request_binding') fail('existing pane request binding kind mismatch');
      if (existingBinding.runtimeEvidenceSchemaVersion !== RUNTIME_EVIDENCE_SCHEMA_VERSION) fail('existing pane request binding runtime schema version mismatch');
      if (existingBinding.requestId !== requestId || existingBinding.round !== round || existingBinding.contentHash !== contentHash || existingBinding.reviewHeadCommit !== reviewHeadCommit) fail('existing pane request binding request mismatch');
      if (existingBinding.paneId !== String(paneId)) fail('existing pane request binding pane mismatch');
      if (existingBinding.repoRealpath !== repoReal) fail('existing pane request binding repo realpath mismatch');
      if (existingBinding.launchEvidencePath !== launchEvidencePath || existingBinding.launchEvidenceSha256 !== launchEvidenceSha256) fail('existing pane request binding launch mismatch');
      if (existingBinding.actualRuntimeModel !== launch.actualRuntimeModel || existingBinding.actualRuntimeModelSource !== 'launch_argv') fail('existing pane request binding model mismatch');
      if (!sameSessionIdentity(existingBinding.sessionIdentity, launch.sessionIdentity)) fail('existing pane request binding session mismatch');
      if (existingBinding.paneCwd !== launch.paneCwd) fail('existing pane request binding pane cwd mismatch');
      if (existingBinding.agentKind !== launch.agentKind) fail('existing pane request binding agent kind mismatch');
      if (state.actualRuntimeModel !== launch.actualRuntimeModel) fail('parent runtime model mismatch');
      if (state.actualRuntimeModelSource !== 'launch_argv') fail('parent runtime model source mismatch');
      if (state.actualRuntimeModelPaneId !== String(paneId)) fail('parent runtime pane id mismatch');
      if (state.replyExecutionKind !== 'pane') fail('parent reply execution kind mismatch');
      if (!sameSessionIdentity(state.actualRuntimeModelSessionIdentity, launch.sessionIdentity)) fail('parent runtime session identity mismatch');
      return {
        relativePath: bindingRelative,
        sha256: bindingSha256,
        launchEvidencePath,
        launchEvidenceSha256,
        sessionIdentity: launch.sessionIdentity,
      };
    }
    const next = {
      ...state,
      actualRuntimeModel: launch.actualRuntimeModel,
      actualRuntimeModelSource: 'launch_argv',
      actualRuntimeModelEvidencePath: bindingRelative,
      actualRuntimeModelEvidenceSha256: bindingSha256,
      actualRuntimeModelPaneId: String(paneId),
      actualRuntimeModelSessionIdentity: launch.sessionIdentity,
      replyExecutionKind: 'pane',
      [RUNTIME_EVIDENCE_MARKER_KEY]: 1,
    };
    const sameSession = state.actualRuntimeModelSessionIdentity
      && typeof state.actualRuntimeModelSessionIdentity === 'object'
      && sameSessionIdentity(state.actualRuntimeModelSessionIdentity, launch.sessionIdentity);
    if (
      state.actualRuntimeModel === next.actualRuntimeModel
      && state.actualRuntimeModelSource === next.actualRuntimeModelSource
      && state.actualRuntimeModelEvidencePath === next.actualRuntimeModelEvidencePath
      && state.actualRuntimeModelEvidenceSha256 === next.actualRuntimeModelEvidenceSha256
      && state.actualRuntimeModelPaneId === next.actualRuntimeModelPaneId
      && state.replyExecutionKind === next.replyExecutionKind
      && sameSession
    ) {
      return {
        relativePath: bindingRelative,
        sha256: bindingSha256,
        launchEvidencePath,
        launchEvidenceSha256,
        sessionIdentity: launch.sessionIdentity,
      };
    }
    const temporary = join(contextDir, `.review-request.${process.pid}.${randomUUID()}.tmp`);
    const fd = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, statePath);
    return {
      relativePath: bindingRelative,
      sha256: bindingSha256,
      launchEvidencePath,
      launchEvidenceSha256,
      sessionIdentity: launch.sessionIdentity,
    };
  });
}

function parseFlag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (command === 'record-pane-launch') {
    const repoRoot = parseFlag(args, '--repo');
    const paneId = parseFlag(args, '--pane');
    const model = parseFlag(args, '--model');
    const effort = parseFlag(args, '--effort');
    const launchStatus = parseFlag(args, '--launch-status') || 'started';
    const launchNonce = parseFlag(args, '--nonce');
    if (!repoRoot || !paneId || !model || !effort || !launchNonce) {
      fail('record-pane-launch requires --repo --pane --model --effort --nonce');
    }
    const written = recordPaneLaunch({
      repoRoot,
      paneId,
      actualRuntimeModel: model,
      argvModel: model,
      effort,
      launchStatus,
      launchNonce,
    });
    process.stdout.write(`${JSON.stringify(written)}\n`);
    return;
  }
  if (command === 'bind-pane-request') {
    const repoRoot = parseFlag(args, '--repo');
    const requestId = parseFlag(args, '--request-id');
    const paneId = parseFlag(args, '--pane');
    const roundRaw = parseFlag(args, '--round');
    const round = Number.parseInt(roundRaw, 10);
    const contentHash = parseFlag(args, '--content-hash');
    const reviewHeadCommit = parseFlag(args, '--review-head-commit');
    const launchEvidencePath = parseFlag(args, '--launch-evidence-path');
    const launchEvidenceSha256 = parseFlag(args, '--launch-evidence-sha256');
    if (!repoRoot || !requestId || !paneId || !roundRaw || !contentHash || !reviewHeadCommit || !launchEvidencePath || !launchEvidenceSha256) {
      fail('bind-pane-request requires --repo --request-id --pane --round --content-hash --review-head-commit --launch-evidence-path --launch-evidence-sha256');
    }
    const written = bindPaneRequest({
      repoRoot,
      requestId,
      paneId,
      round,
      contentHash,
      reviewHeadCommit,
      launchEvidencePath,
      launchEvidenceSha256,
    });
    process.stdout.write(`${JSON.stringify(written)}\n`);
    return;
  }
  fail(`unknown command: ${command || '(none)'}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${oneLine(error?.stack || error?.message || error, 1000)}\n`);
    process.exit(2);
  });
}
