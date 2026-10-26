// 2026-09-28 (T1-T5 stage 4C): the official producer for one deepseek-native-cli-v1 primary-review
// receipt (`native-cli-session-v1`). It is a producer only. It re-reads the registered official
// queue request, the official current task/approval and the request-owned review-scope-v1, selects
// one real completed reviewer turn from the trusted Codex session store, proves that exact turn
// received the recomputed pinned prompt and produced the final answer plus usage, then writes the
// minimal receipt with the existing safe atomic file primitives and immediately re-verifies it
// through nativeSessionEvidence. It never hand-writes a receipt, never mutates queue
// state/result/lease or `.ai/current-task.json`, and never launches or pays a reviewer. The
// direct-API 150000-byte inline request ceiling does not apply here: the frozen request and scope
// are referenced by hash and re-read from disk instead of being inlined.
import fs from 'node:fs';
import path from 'node:path';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {
  sha,
  regular,
  bindNativeTurn,
  boundImplementerSessionIds,
  nativeSessionEvidence,
  trustedCodexSessionRoot,
  resolveTrustedSessionRoot,
  nativeImplementerSessionRoot,
  CMGB_NATIVE_REVIEW_IDENTITY,
  NATIVE_REVIEW_EVIDENCE,
  NATIVE_REVIEWER_ROLES,
  NATIVE_IMPLEMENTER_CHAIN,
} from './review-evidence.mjs';
import {
  queueEntryPath,
  readQueueJson,
  ensureSafeDirectory,
  calculateQueueInputHash,
  nativeReviewPinFromRequest,
  REVIEW_QUEUE_STATES,
} from './ai-review-queue-lib.mjs';

export const NATIVE_RECEIPT_SCHEMA_VERSION = 1;
export const NATIVE_RECEIPT_DIR = '.ai/primary-review';
export const NATIVE_RECEIPT_FILE = 'receipt.json';
export const NATIVE_RECEIPT_MANIFEST_FILE = 'reviewed-manifest.json';
const REVIEWER_ROLE = NATIVE_REVIEWER_ROLES[0];
const LENS_TAGS = {spec: 'Round lens: User specification', user_path: 'Round lens: User/CLI path', edge: 'Round lens: Edge cases'};
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_SESSION_BYTES = 512 * 1024 * 1024;

function receiptFail(code, detail) {
  throw new Error(detail ? `${code}: ${detail}` : code);
}
const norm = value => String(value === undefined || value === null ? '' : value).replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase();

// The receipt's inline reviewed manifest, built only from the already verified request-owned scope:
// exactly the kind=reviewed entries, path-sorted, in the {files:[{path,after}]} shape verifyManifest
// accepts. A protected/forward_frozen path never enters this bundle, so a receipt can never claim a
// frozen or protected file was reviewed.
export function reviewedManifestBundle(scope) {
  if (!scope || !Array.isArray(scope.entries)) receiptFail('NATIVE_RECEIPT_SCOPE_INVALID', 'the verified scope has no entries');
  const files = scope.entries
    .filter(entry => entry.kind === 'reviewed')
    .map(entry => ({path: entry.path, after: entry.sha}))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (!files.length) receiptFail('NATIVE_RECEIPT_REVIEWED_EMPTY', 'the verified scope has no reviewed entries');
  return {schemaVersion: NATIVE_RECEIPT_SCHEMA_VERSION, files};
}
export function serializeReviewedManifest(bundle) {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
export function reviewedManifestHash(scope) {
  return sha(serializeReviewedManifest(reviewedManifestBundle(scope)));
}

// 2026-09-29 (CMGB native focused CALLER): a CMGB focused recheck request pins the official CORE
// target list and its canonical hash at the request top level. The producer re-reads those pins from
// the registered request (never from the receipt) and proves that the real reviewer turn received the
// pinned hash line and every pinned original text. Any other request - including a non-CMGB focused
// recheck that legitimately has no such list - is left exactly as before.
// The task/repo/fingerprint itself lives in review-evidence.mjs so the focused gate and the trusted
// reviewer-root gate can never drift apart.
const CMGB_NATIVE_FOCUSED_IDENTITY = Object.freeze({...CMGB_NATIVE_REVIEW_IDENTITY, surfaceKind: 'web_ui'});
const NATIVE_FOCUSED_TARGET_LIMIT = 200;

function cmgbNativeFocusedTask(task) {
  return Object.entries(CMGB_NATIVE_FOCUSED_IDENTITY)
    .every(([field, expected]) => String(task && task[field] ? task[field] : '').trim() === expected);
}

function nativeFocusedRequestPins(request, task) {
  const rawList = request ? request.nativeFocusedTargets : undefined;
  const rawHash = request ? request.nativeFocusedTargetsHash : undefined;
  const hasList = rawList !== undefined && rawList !== null;
  const hasHash = rawHash !== undefined && rawHash !== null && String(rawHash) !== '';
  const focusedRequest = String(request && request.reviewChainVersion ? request.reviewChainVersion : '').trim() === NATIVE_IMPLEMENTER_CHAIN
    && Boolean(request) && request.recheck === 1
    && cmgbNativeFocusedTask(task);
  if (!hasList && !hasHash) {
    if (focusedRequest) receiptFail('NATIVE_RECEIPT_FOCUSED_TARGETS_REQUIRED', 'a CMGB native focused recheck request must pin nativeFocusedTargets and nativeFocusedTargetsHash');
    return null;
  }
  if (!focusedRequest) receiptFail('NATIVE_RECEIPT_FOCUSED_TARGETS_UNEXPECTED', 'focused target pins are only accepted on a CMGB native focused recheck request');
  if (!hasList || !hasHash) receiptFail('NATIVE_RECEIPT_FOCUSED_TARGETS_INCOMPLETE', 'both nativeFocusedTargets and nativeFocusedTargetsHash are required');
  const hash = String(rawHash);
  if (!/^[a-f0-9]{64}$/u.test(hash)) receiptFail('NATIVE_RECEIPT_FOCUSED_HASH_INVALID', hash.slice(0, 120));
  if (!Array.isArray(rawList)) receiptFail('NATIVE_RECEIPT_FOCUSED_TARGETS_INVALID', 'nativeFocusedTargets must be an array');
  if (rawList.length > NATIVE_FOCUSED_TARGET_LIMIT) receiptFail('NATIVE_RECEIPT_FOCUSED_TARGET_LIMIT', String(rawList.length));
  const seen = new Set();
  const targets = rawList.map((target, index) => {
    const key = String(target && target.key ? target.key : '');
    if (!/^[a-f0-9]{64}$/u.test(key)) receiptFail('NATIVE_RECEIPT_FOCUSED_TARGET_KEY', 'index=' + index);
    if (seen.has(key)) receiptFail('NATIVE_RECEIPT_FOCUSED_TARGET_DUPLICATE', key.slice(0, 120));
    seen.add(key);
    const originalText = target && typeof target.originalText === 'string' ? target.originalText : '';
    if (!originalText.trim()) receiptFail('NATIVE_RECEIPT_FOCUSED_TARGET_TEXT', key.slice(0, 120));
    return {key, originalText};
  });
  return {hash, targets, keys: targets.map((target) => target.key)};
}

// The exact 11-field binding line the reviewer turn must have received. It is recomputed from the
// official task/request/verified scope, never read from the request body or the receipt, and it uses
// the same field order nativeSessionEvidence rebuilds, so the producer cannot weaken it.
export function expectedReviewBinding({task, request, scope, manifestHash}) {
  return JSON.stringify({
    taskId: task.taskId,
    taskFingerprint: task.taskFingerprint,
    round: scope.round,
    lens: String(request.lens || ''),
    reviewBaseCommit: scope.base,
    reviewHeadCommit: scope.head,
    approvalHash: scope.approvalHash,
    manifestHash,
    changedScopeHash: scope.scopeHash,
    requestId: request.requestId,
    inputHash: request.inputHash,
  });
}

// Resolve the official queue request by its opaque Request-ID. The entry is only accepted from the
// official review queue root, the chain marker and pin are re-validated, and the request-owned
// inputHash is recomputed from the real request.md/diff.patch/manifest.json bytes.
export function resolveNativeQueueRequest(requestId, {entryDir = ''} = {}) {
  const id = String(requestId || '').trim();
  if (!id) receiptFail('NATIVE_RECEIPT_REQUEST_ID_MISSING', 'the official Request-ID is required');
  let dir;
  try { dir = queueEntryPath(id); }
  catch (error) { receiptFail('NATIVE_RECEIPT_REQUEST_ID_INVALID', String(error && error.message)); }
  if (entryDir) {
    let want;
    let actual;
    try { want = fs.realpathSync(entryDir); } catch { receiptFail('NATIVE_RECEIPT_ENTRY_UNREADABLE', String(entryDir).slice(0, 64)); }
    try { actual = fs.realpathSync(dir); } catch { receiptFail('NATIVE_RECEIPT_REQUEST_MISSING', id); }
    if (want !== actual) receiptFail('NATIVE_RECEIPT_ENTRY_MISMATCH', 'the caller entry directory is not the official queue entry');
  }
  if (!fs.existsSync(dir)) receiptFail('NATIVE_RECEIPT_REQUEST_MISSING', id);
  const requestPath = path.join(dir, 'request.json');
  const statePath = path.join(dir, 'state.json');
  if (!fs.existsSync(requestPath)) receiptFail('NATIVE_RECEIPT_REQUEST_MISSING', id);
  if (!fs.existsSync(statePath)) receiptFail('NATIVE_RECEIPT_STATE_MISSING', id);
  const request = readQueueJson(requestPath, 'request.json', {maxBytes: MAX_JSON_BYTES});
  if (request.requestId !== id) receiptFail('NATIVE_RECEIPT_REQUEST_ID_MISMATCH', String(request.requestId));
  if (String(request.reviewChainVersion || '').trim() !== NATIVE_IMPLEMENTER_CHAIN) {
    receiptFail('NATIVE_RECEIPT_CHAIN_MISMATCH', `the official request is not bound to ${NATIVE_IMPLEMENTER_CHAIN}`);
  }
  const bound = nativeReviewPinFromRequest(request);
  if (!bound) receiptFail('NATIVE_RECEIPT_PIN_REQUIRED', 'the native request must carry its nativeReview pin');
  const state = readQueueJson(statePath, 'state.json', {maxBytes: MAX_JSON_BYTES});
  if (state.requestId !== id) receiptFail('NATIVE_RECEIPT_STATE_MISMATCH', String(state.requestId));
  if (!REVIEW_QUEUE_STATES.has(state.status)) receiptFail('NATIVE_RECEIPT_STATE_INVALID', String(state.status));
  if (state.status === 'reset' || fs.existsSync(path.join(dir, 'reset.json'))) {
    receiptFail('NATIVE_RECEIPT_STATE_RESET', 'a reset request cannot produce primary-review evidence');
  }
  const inputHash = calculateQueueInputHash(dir, request.promptVersion, request);
  if (String(request.inputHash || '') !== inputHash) {
    receiptFail('NATIVE_RECEIPT_INPUT_HASH_MISMATCH', 'the registered request inputHash is not the queue-owned value');
  }
  return {requestId: id, entryDir: dir, request, state, pin: bound.pin, scopeRel: bound.scopeFile, inputHash};
}

function requireScopeVerifier() {
  let verifyReviewScopeAtRoot;
  try { ({verifyReviewScopeAtRoot} = createRequire(import.meta.url)('./review-scope.mjs')); }
  catch { receiptFail('NATIVE_RECEIPT_SCOPE_DEPENDENCY_MISSING', 'review-scope.mjs is required for the deepseek-native-cli-v1 chain'); }
  if (typeof verifyReviewScopeAtRoot !== 'function') receiptFail('NATIVE_RECEIPT_SCOPE_DEPENDENCY_MISSING', 'review-scope.mjs did not export verifyReviewScopeAtRoot');
  return verifyReviewScopeAtRoot;
}

// The reviewer session file must be a real regular file under the trusted session store and its name
// must carry the session id, so a renamed copy cannot stand in for it. The trusted root is a caller
// input resolved by the producer; it is never read from the receipt.
function requireSessionFile(sessionFile, sessionRoot, sessionId) {
  const file = String(sessionFile || '');
  if (!file || !path.isAbsolute(file) || file.split(/[\\/]/u).includes('..')) {
    receiptFail('NATIVE_RECEIPT_SESSION_FILE_INVALID', 'the reviewer session file must be an absolute path without traversal');
  }
  let real;
  try { real = fs.realpathSync(file); } catch { receiptFail('NATIVE_RECEIPT_SESSION_UNREADABLE', file.slice(0, 64)); }
  let rootReal;
  try { rootReal = fs.realpathSync(sessionRoot); } catch { receiptFail('NATIVE_SESSION_ROOT_UNREADABLE', 'sessionRoot'); }
  if (!(real === rootReal || real.startsWith(rootReal + path.sep))) {
    receiptFail('NATIVE_SESSION_OUTSIDE_ROOT', 'the reviewer session file must live under the trusted session root');
  }
  const info = fs.lstatSync(real);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SESSION_BYTES) receiptFail('NATIVE_RECEIPT_SESSION_UNSAFE', 'bytes=' + info.size);
  if (typeof sessionId !== 'string' || !sessionId || !path.basename(real).toLowerCase().includes(sessionId.toLowerCase())) {
    receiptFail('NATIVE_SESSION_FILENAME_MISMATCH', 'the session file name must carry the session id');
  }
  return real;
}
function readSessionLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean);
}
function parseFinalAnswer(finalText) {
  let answer;
  try { answer = JSON.parse(String(finalText || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { receiptFail('NATIVE_RECEIPT_FINAL_INVALID', 'the reviewer final answer is not JSON'); }
  if (!answer || !['pass', 'findings'].includes(answer.verdict) || !Array.isArray(answer.findings) || !Array.isArray(answer.unverified) || (answer.verdict === 'pass') !== (answer.findings.length === 0)) {
    receiptFail('NATIVE_RECEIPT_FINAL_INVALID', 'the reviewer final answer is not the verdict/findings/unverified contract');
  }
  return answer;
}
function deriveReceiptRel(out) {
  if (!out) return '';
  const rel = String(out).trim().replace(/\\/g, '/');
  if (!rel || path.isAbsolute(rel) || /^[A-Za-z]:/u.test(rel) || !/^\.ai\/[^/]+\/.+\.json$/u.test(rel)) {
    receiptFail('NATIVE_RECEIPT_OUT_INVALID', 'the receipt output path must be a repo-relative .ai/<dir>/<file>.json path');
  }
  return rel;
}
function resolvedInsideRoot(rootAbs, rel) {
  const abs = path.resolve(rootAbs, rel);
  if (!(abs === rootAbs || abs.startsWith(rootAbs + path.sep))) receiptFail('NATIVE_RECEIPT_PATH_ESCAPE', rel);
  return abs;
}

// True when any directory entry exists at the path (a regular file, a directory, or a symlink —
// including a dangling one). lstatSync is deliberate: existsSync returns false for a dangling symlink
// and would let it be treated as absent.
function pathEntryExists(abs) {
  try { fs.lstatSync(abs); return true; }
  catch (error) { if (error && error.code === 'ENOENT') return false; throw error; }
}
// Create one artifact that must not already exist. The open is O_CREAT|O_EXCL|O_NOFOLLOW: the kernel
// refuses it when the final component already exists as a file, directory, symlink or (on Windows) a
// reparse point, so there is no check-then-rename window and preexisting evidence is never
// overwritten. The parent chain is validated/created by the shared safe helper, which also refuses a
// symlinked directory. A failed open whose path now exists is reported as ALREADY_EXISTS on every
// platform (Windows can surface ERROR_ACCESS_DENIED for a directory rather than EEXIST).
function createOnlyFile(abs, content) {
  ensureSafeDirectory(path.dirname(abs), {create: true});
  let fd;
  try {
    fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  } catch (error) {
    if ((error && error.code === 'EEXIST') || pathEntryExists(abs)) {
      receiptFail('NATIVE_RECEIPT_ALREADY_EXISTS', 'refusing to overwrite an existing receipt or reviewed manifest; a re-review must use a new Request-ID');
    }
    throw error;
  }
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const info = fs.lstatSync(abs);
  if (!info.isFile() || info.isSymbolicLink()) receiptFail('NATIVE_RECEIPT_ARTIFACT_UNSAFE', 'the created artifact is not a regular file');
}

// Build the receipt from the official inputs without writing anything. Every pin is re-derived from
// disk and the reviewer turn is recomputed from the real JSONL, so a caller cannot hand it an
// arbitrary final answer, a receipt-supplied session root, or a self-claimed reviewed set.
export function buildNativeReviewReceipt({root, requestId, sessionFile, sessionId, turnId, sessionRoot = '', home = '', cmgbReviewerRoot = '', entryDir = '', out = ''} = {}) {
  const rootAbs = path.resolve(String(root || '.'));
  const queue = resolveNativeQueueRequest(requestId, {entryDir});
  const {request, pin} = queue;
  if (pin.round !== request.round || String(pin.lens) !== String(request.lens || '')) {
    receiptFail('NATIVE_RECEIPT_PIN_REQUEST_MISMATCH', 'the native pin is not the request round/lens');
  }
  if (pin.taskId !== request.taskId || pin.taskFingerprint !== request.taskFingerprint) {
    receiptFail('NATIVE_RECEIPT_PIN_REQUEST_MISMATCH', 'the native pin is not the request task');
  }
  if (pin.reviewHeadCommit !== request.head) receiptFail('NATIVE_RECEIPT_PIN_REQUEST_MISMATCH', 'the native pin is not the request head');
  const taskPath = path.join(rootAbs, '.ai', 'current-task.json');
  if (!fs.existsSync(taskPath)) receiptFail('NATIVE_RECEIPT_TASK_MISSING', '.ai/current-task.json');
  const task = JSON.parse(regular(taskPath).toString('utf8'));
  if (String(task.reviewChainVersion || '').trim() !== NATIVE_IMPLEMENTER_CHAIN) {
    receiptFail('NATIVE_RECEIPT_TASK_CHAIN_MISMATCH', `the official task is not bound to ${NATIVE_IMPLEMENTER_CHAIN}`);
  }
  if (task.taskId !== request.taskId || task.taskFingerprint !== request.taskFingerprint) {
    receiptFail('NATIVE_RECEIPT_TASK_MISMATCH', 'the official task is not the request task');
  }
  const focusedPins = nativeFocusedRequestPins(request, task);
  // The reviewer store is the trusted C store, or - for the one CMGB recovery task - the fixed G
  // store. The implementer set is always re-verified from the legacy C store, so moving the reviewer
  // store can never move, widen or re-point the verified implementer sessions.
  const trustedRoot = resolveTrustedSessionRoot(trustedCodexSessionRoot(home || undefined), sessionRoot, {task, cmgbReviewerRoot});
  const implementerRoot = nativeImplementerSessionRoot(task, trustedRoot, {home, cmgbReviewerRoot});
  // Acceptance-time implementer-set proof and reviewer/implementer distinctness, from the trusted
  // implementer root only; a self-edited task cannot add a reviewer-as-implementer arrangement.
  const implementerIds = boundImplementerSessionIds(task, {sessionRoot: implementerRoot, expectedCwd: rootAbs});
  // Request-owned review-scope-v1, re-verified against the live worktree and the official .ai anchors.
  const verifyReviewScopeAtRoot = requireScopeVerifier();
  const scopeAbs = resolvedInsideRoot(rootAbs, queue.scopeRel);
  const scope = verifyReviewScopeAtRoot(rootAbs, scopeAbs, {
    ignoredPathspecs: pin.ignoredPathspecs.slice(),
    expectedScopeHash: pin.scopeHash,
    reviewedManifestPaths: pin.reviewedPaths.slice(),
    current: true,
  });
  if (scope.taskId !== task.taskId || scope.taskFingerprint !== task.taskFingerprint || scope.round !== pin.round) {
    receiptFail('NATIVE_RECEIPT_SCOPE_TASK_MISMATCH', 'the verified scope is not bound to this official task/round');
  }
  if (scope.base !== pin.reviewBaseCommit || scope.head !== pin.reviewHeadCommit || scope.approvalHash !== pin.approvalHash) {
    receiptFail('NATIVE_RECEIPT_SCOPE_BINDING_MISMATCH', 'the verified scope is not bound to the request base/head/approval');
  }
  const bundle = reviewedManifestBundle(scope);
  const manifestPaths = bundle.files.map(file => file.path);
  if (JSON.stringify(pin.reviewedPaths.slice().sort()) !== JSON.stringify(manifestPaths)) {
    receiptFail('NATIVE_RECEIPT_REVIEWED_PIN_MISMATCH', 'the request-owned reviewed list is not the verified scope reviewed set');
  }
  const manifestHash = sha(serializeReviewedManifest(bundle));
  const binding = expectedReviewBinding({task, request, scope, manifestHash});
  // The real reviewer turn, from the trusted session store only.
  const realSession = requireSessionFile(sessionFile, trustedRoot, sessionId);
  const turn = bindNativeTurn(readSessionLines(realSession), {turnId, expectedCwd: rootAbs, expectedSessionId: sessionId});
  if (implementerIds.some(id => norm(id) === norm(sessionId))) {
    receiptFail('NATIVE_RECEIPT_SAME_SESSION', 'the reviewer session equals a bound implementer session');
  }
  if (!LENS_TAGS[pin.lens]) receiptFail('NATIVE_RECEIPT_LENS_INVALID', String(pin.lens));
  if (!turn.promptText.includes(LENS_TAGS[pin.lens])) receiptFail('NATIVE_RECEIPT_LENS_MISSING', 'the reviewer turn did not receive the pinned lens');
  if (!turn.promptText.includes('Review binding: ' + binding)) {
    receiptFail('NATIVE_RECEIPT_BINDING_MISSING', 'the reviewer turn did not receive the exact 11-field Review binding line; the official send-side must emit it');
  }
  if (focusedPins) {
    if (!turn.promptText.includes('Native-Focused-Targets-SHA256: ' + focusedPins.hash)) {
      receiptFail('NATIVE_RECEIPT_FOCUSED_HASH_MISSING', 'the reviewer turn did not receive the pinned Native-Focused-Targets-SHA256 line');
    }
    for (const target of focusedPins.targets) {
      if (!turn.promptText.includes(target.originalText)) {
        receiptFail('NATIVE_RECEIPT_FOCUSED_TARGET_MISSING', 'the reviewer turn did not receive a pinned focused target original text');
      }
    }
  }
  const answer = parseFinalAnswer(turn.finalText);
  const receiptRel = deriveReceiptRel(out) || `${NATIVE_RECEIPT_DIR}/${queue.requestId}/${NATIVE_RECEIPT_FILE}`;
  const manifestRel = `${receiptRel.slice(0, receiptRel.lastIndexOf('/'))}/${NATIVE_RECEIPT_MANIFEST_FILE}`;
  resolvedInsideRoot(rootAbs, receiptRel);
  resolvedInsideRoot(rootAbs, manifestRel);
  const receipt = {
    type: NATIVE_REVIEW_EVIDENCE,
    schemaVersion: NATIVE_RECEIPT_SCHEMA_VERSION,
    taskId: task.taskId,
    taskFingerprint: task.taskFingerprint,
    round: pin.round,
    lens: pin.lens,
    reviewerRole: REVIEWER_ROLE,
    sessionFile: realSession,
    sessionId: String(sessionId),
    turnId: String(turnId),
    model: turn.model,
    effort: turn.effort,
    cwd: turn.cwd,
    sandbox: turn.sandbox,
    promptSha256: turn.promptSha256,
    promptLength: turn.promptLength,
    finalSha256: turn.finalSha256,
    finalLength: turn.finalLength,
    usage: {inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens, totalTokens: turn.usage.totalTokens},
    manifest: manifestRel,
    manifestHash,
    reviewBaseCommit: scope.base,
    reviewHeadCommit: scope.head,
    approvalHash: scope.approvalHash,
    changedScopeHash: scope.scopeHash,
    requestId: request.requestId,
    inputHash: request.inputHash,
    verdict: answer.verdict,
  };
  return {
    root: rootAbs,
    request,
    requestId: queue.requestId,
    focused: focusedPins,
    entryDir: queue.entryDir,
    task,
    pin,
    scope,
    scopeAbs,
    home: typeof home === 'string' ? home : '',
    cmgbReviewerRoot: typeof cmgbReviewerRoot === 'string' ? cmgbReviewerRoot : '',
    sessionRoot: trustedRoot,
    implementerSessionRoot: implementerRoot,
    sessionFile: realSession,
    turn,
    binding,
    answer,
    manifestRel,
    receiptRel,
    manifestBytes: serializeReviewedManifest(bundle),
    receipt,
  };
}

// Write the built receipt create-only, then immediately re-verify it with nativeSessionEvidence. A
// preexisting receipt or reviewed manifest is a hard failure: a duplicate --write or a retry must
// never clobber bytes a later acceptance may already have recorded. The manifest is created before
// the receipt so no receipt is ever visible without its manifest. If the second artifact cannot be
// created, or the post-write verifier fails, only the artifacts this invocation exclusively created
// are removed; a file that was already present is never overwritten or removed.
export function writeNativeReviewReceipt(bundle, {verify = true} = {}) {
  const rootAbs = path.resolve(String(bundle.root || '.'));
  const receiptAbs = resolvedInsideRoot(rootAbs, bundle.receiptRel);
  const manifestAbs = resolvedInsideRoot(rootAbs, bundle.manifestRel);
  if (receiptAbs === manifestAbs) receiptFail('NATIVE_RECEIPT_OUT_INVALID', 'the receipt and reviewed manifest paths must differ');
  const created = [];
  const rollbackCreated = () => {
    for (const file of created.splice(0).reverse()) {
      try { fs.rmSync(file, {force: true}); } catch { /* best effort cleanup of this invocation only */ }
    }
  };
  try {
    createOnlyFile(manifestAbs, bundle.manifestBytes);
    created.push(manifestAbs);
    createOnlyFile(receiptAbs, `${JSON.stringify(bundle.receipt, null, 2)}\n`);
    created.push(receiptAbs);
  } catch (error) {
    rollbackCreated();
    throw error;
  }
  if (!verify) return {receiptPath: receiptAbs, manifestPath: manifestAbs, evidence: null};
  try {
    const evidence = nativeSessionEvidence(rootAbs, receiptAbs, {
      task: bundle.task,
      round: bundle.pin.round,
      lens: bundle.pin.lens,
      role: REVIEWER_ROLE,
      sessionRoot: bundle.sessionRoot,
      home: bundle.home || '',
      cmgbReviewerRoot: bundle.cmgbReviewerRoot || '',
      current: true,
      expectedScopeHash: bundle.pin.scopeHash,
      scopeFile: bundle.scopeAbs,
      reviewedManifestPaths: bundle.pin.reviewedPaths.slice(),
      ignoredPathspecs: bundle.pin.ignoredPathspecs.slice(),
      expectedRequestId: bundle.requestId,
      expectedInputHash: bundle.request.inputHash,
      ...(bundle.focused
        ? {expectedFocusedTargetsHash: bundle.focused.hash, expectedFocusedTargets: bundle.focused.targets}
        : {}),
    });
    return {receiptPath: receiptAbs, manifestPath: manifestAbs, evidence};
  } catch (error) {
    rollbackCreated();
    throw error;
  }
}

// The single entry point: build always, write only when `write` is true. Dry-run writes nothing.
export function produceNativeReviewReceipt(options = {}) {
  const bundle = buildNativeReviewReceipt(options);
  if (options.write !== true) {
    return {written: false, receipt: bundle.receipt, receiptRel: bundle.receiptRel, manifestRel: bundle.manifestRel, requestId: bundle.requestId, scopeHash: bundle.scope.scopeHash, manifestHash: bundle.receipt.manifestHash, sessionRoot: bundle.sessionRoot, implementerSessionRoot: bundle.implementerSessionRoot, evidence: null};
  }
  const written = writeNativeReviewReceipt(bundle);
  return {written: true, receipt: bundle.receipt, receiptPath: written.receiptPath, manifestPath: written.manifestPath, requestId: bundle.requestId, scopeHash: bundle.scope.scopeHash, manifestHash: bundle.receipt.manifestHash, sessionRoot: bundle.sessionRoot, implementerSessionRoot: bundle.implementerSessionRoot, evidence: written.evidence};
}

function usage() {
  return [
    'usage: node templates/scripts/ai-review-native-receipt.mjs --request-id <id> --session-file <abs.jsonl> --session-id <id> --turn-id <id> [--root <dir>] [--session-root <dir>] [--out <.ai/.../receipt.json>] [--write]',
    '',
    'Default is dry-run: it validates and prints the receipt it would write, and writes nothing.',
    '--write persists receipt.json + reviewed-manifest.json under .ai/ and then re-verifies them with nativeSessionEvidence.',
    'A duplicate --write for the same Request-ID fails closed and never overwrites existing receipt/manifest bytes.',
    'The trusted session root is derived from the running official home (~/.codex/sessions); --session-root must resolve inside it, or be the fixed CMGB reviewer store for the CMGB recovery task.',
  ].join('\n');
}
function parseArgs(argv) {
  const flags = {write: false, help: false};
  const valued = new Set(['--request-id', '--session-file', '--session-id', '--turn-id', '--root', '--session-root', '--out']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--write') { flags.write = true; continue; }
    if (token === '--help' || token === '-h') { flags.help = true; continue; }
    if (!valued.has(token)) throw new Error(`unknown argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    flags[token.slice(2).replace(/-([a-z])/gu, (_match, char) => char.toUpperCase())] = value;
    index += 1;
  }
  return flags;
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) {
      console.log(usage());
      process.exit(0);
    }
    const result = produceNativeReviewReceipt({
      root: flags.root || process.cwd(),
      requestId: flags.requestId,
      sessionFile: flags.sessionFile,
      sessionId: flags.sessionId,
      turnId: flags.turnId,
      sessionRoot: flags.sessionRoot,
      out: flags.out,
      write: flags.write === true,
    });
    console.log(JSON.stringify({
      written: result.written,
      requestId: result.requestId,
      status: result.evidence ? result.evidence.status : 'dry-run',
      verdict: result.receipt.verdict,
      round: result.receipt.round,
      lens: result.receipt.lens,
      reviewerSessionRoot: result.sessionRoot,
      implementerSessionRoot: result.implementerSessionRoot,
      model: result.receipt.model,
      effort: result.receipt.effort,
      changedScopeHash: result.receipt.changedScopeHash,
      manifestHash: result.receipt.manifestHash,
      promptSha256: result.receipt.promptSha256,
      finalSha256: result.receipt.finalSha256,
      usage: result.receipt.usage,
      receipt: result.written ? result.receiptPath : result.receiptRel,
    }, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
