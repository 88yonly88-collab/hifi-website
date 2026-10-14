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
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitOutput, IDENTIFIER_PATTERN } from './ai-workflow-lib.mjs';
import { RUNTIME_EVIDENCE_MARKER_KEY, verifyQueueRuntimeEvidence } from './ai-runtime-evidence-lib.mjs';

export function defaultReviewQueueRootForModule(moduleUrl = import.meta.url) {
  return join(dirname(dirname(fileURLToPath(moduleUrl))), '.ai', 'review-queue');
}

const DEFAULT_REVIEW_QUEUE_ROOT = defaultReviewQueueRootForModule();
let queueOverrideWarningShown = false;

export const REVIEW_QUEUE_SCHEMA_VERSION = 1;
export const REVIEW_QUEUE_PROMPT_VERSION = 'review-queue-v1';
export const MAX_REVIEW_QUEUE_ENTRIES = 1000;
export const MAX_REVIEW_RESULT_BYTES = 256 * 1024;
export const MAX_REVIEW_RESULT_BODY_CHARS = 100000;
export const MAX_REVIEW_SAFETY_SCAN_BYTES = 2 * 1024 * 1024;
// deepseek-native-cli-v1 (explicit web_ui chain only): the official send request pins the
// verified review-scope-v1 for the round. The pin is a plain trusted object. Its integrity comes
// from (a) the queue inputHash, recomputed in loadValidatedQueueResult over request.json which
// contains this nested pin, and (b) re-verifying the pinned scope at acceptance. It deliberately
// carries NO self-hash and does NOT restate the queue inputHash: naming its own contentHash
// "inputHash" would be circular, because calculateQueueInputHash hashes the request that holds
// the pin. This block is pure validation and changes no existing queue behaviour by itself.
export const NATIVE_REVIEW_PIN_SCHEMA_VERSION = 1;
export const NATIVE_REVIEW_CHAIN_VERSION = 'deepseek-native-cli-v1';
export const NATIVE_QUEUE_REVIEWER_MODEL = 'claude-opus-5-5';
export const NATIVE_QUEUE_REVIEWER_EFFORT = 'high';
export const NATIVE_PRIMARY_MODEL = 'deepseek-flash';
export const NATIVE_PRIMARY_EFFORT = 'high';
export const NATIVE_REVIEW_LENS_KEYS = ['spec', 'user_path', 'edge'];
const NATIVE_HASH_RE = /^[a-f0-9]{64}$/;
const NATIVE_COMMIT_RE = /^[a-f0-9]{40,64}$/;
const NATIVE_PIN_KEYS = new Set([
  'schemaVersion', 'reviewChainVersion', 'scopeHash', 'scopeManifestHash',
  'reviewedPaths', 'protectedEntries', 'forwardFrozenEntries', 'ignoredPathspecs',
  'round', 'lens', 'reviewBaseCommit', 'reviewHeadCommit', 'approvalHash',
  'taskId', 'taskFingerprint', 'implementerSessionsHash',
  'reviewerModel', 'reviewerEffort', 'primaryModel', 'primaryEffort',
]);

function nativePinFail(code, detail) {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function nativePinPath(value, code) {
  const rel = String(value || '').replaceAll('\\', '/').trim();
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..') || rel.startsWith('.ai/')) {
    nativePinFail(code, rel);
  }
  if (isSecretPath(rel)) nativePinFail(code, `秘密らしいpath: ${rel}`);
  return rel;
}

function nativePinPathList(value, code) {
  if (!Array.isArray(value)) nativePinFail(code, '配列ではありません');
  const seen = new Set();
  for (const item of value) {
    const rel = nativePinPath(item, code);
    if (seen.has(rel)) nativePinFail(code, `重複: ${rel}`);
    seen.add(rel);
  }
  return [...seen].sort();
}

function nativePinEntryList(value, code) {
  if (!Array.isArray(value)) nativePinFail(code, '配列ではありません');
  const seen = new Set();
  const entries = value.map((entry) => {
    if (!entry || typeof entry !== 'object') nativePinFail(code, 'entry');
    const rel = nativePinPath(entry.path, code);
    if (!['protected', 'forward_frozen'].includes(entry.kind)) nativePinFail(code, `kind=${String(entry.kind)}`);
    const sha = String(entry.sha || '');
    if (!NATIVE_HASH_RE.test(sha)) nativePinFail(code, `${rel} sha`);
    const reason = String(entry.reason || '').trim();
    if (!reason) nativePinFail(code, `${rel} reason`);
    if (seen.has(rel)) nativePinFail(code, `重複: ${rel}`);
    seen.add(rel);
    return { path: rel, kind: entry.kind, sha, reason };
  });
  return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * Validate and canonicalize a deepseek-native-cli-v1 queue pin. Strict: unknown keys (including a
 * nested inputHash/contentHash), non-exact models, non-hash digests, duplicate/secret/out-of-repo
 * paths, and kind overlap are all rejected rather than normalized away. Returns a new sorted object
 * so a later recomputation can compare byte-for-byte.
 */
export function normalizeNativeReviewPin(pin) {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) nativePinFail('NATIVE_PIN_INVALID', 'オブジェクトではありません');
  for (const key of Object.keys(pin)) if (!NATIVE_PIN_KEYS.has(key)) nativePinFail('NATIVE_PIN_UNKNOWN_KEY', key);
  if (pin.schemaVersion !== NATIVE_REVIEW_PIN_SCHEMA_VERSION) nativePinFail('NATIVE_PIN_SCHEMA', String(pin.schemaVersion));
  if (pin.reviewChainVersion !== NATIVE_REVIEW_CHAIN_VERSION) nativePinFail('NATIVE_PIN_CHAIN', String(pin.reviewChainVersion));
  const scopeHash = String(pin.scopeHash || '');
  const scopeManifestHash = String(pin.scopeManifestHash || '');
  if (!NATIVE_HASH_RE.test(scopeHash)) nativePinFail('NATIVE_PIN_SCOPE_HASH', String(pin.scopeHash));
  if (!NATIVE_HASH_RE.test(scopeManifestHash)) nativePinFail('NATIVE_PIN_SCOPE_MANIFEST_HASH', String(pin.scopeManifestHash));
  const reviewBaseCommit = String(pin.reviewBaseCommit || '');
  const reviewHeadCommit = String(pin.reviewHeadCommit || '');
  if (!NATIVE_COMMIT_RE.test(reviewBaseCommit)) nativePinFail('NATIVE_PIN_BASE', reviewBaseCommit);
  if (!NATIVE_COMMIT_RE.test(reviewHeadCommit)) nativePinFail('NATIVE_PIN_HEAD', reviewHeadCommit);
  const approvalHash = String(pin.approvalHash || '');
  if (!NATIVE_HASH_RE.test(approvalHash)) nativePinFail('NATIVE_PIN_APPROVAL', String(pin.approvalHash));
  const reviewedPaths = nativePinPathList(pin.reviewedPaths, 'NATIVE_PIN_REVIEWED_PATHS');
  if (!reviewedPaths.length) nativePinFail('NATIVE_PIN_REVIEWED_EMPTY');
  const protectedEntries = nativePinEntryList(pin.protectedEntries, 'NATIVE_PIN_PROTECTED');
  const forwardFrozenEntries = nativePinEntryList(pin.forwardFrozenEntries, 'NATIVE_PIN_FORWARD_FROZEN');
  const protectedPaths = new Set(protectedEntries.map((entry) => entry.path));
  for (const entry of forwardFrozenEntries) {
    if (protectedPaths.has(entry.path)) nativePinFail('NATIVE_PIN_FORWARD_FROZEN', `protectedと重複: ${entry.path}`);
  }
  const frozen = new Set([...protectedEntries, ...forwardFrozenEntries].map((entry) => entry.path));
  for (const rel of reviewedPaths) if (frozen.has(rel)) nativePinFail('NATIVE_PIN_KIND_OVERLAP', rel);
  if (!Array.isArray(pin.ignoredPathspecs)) nativePinFail('NATIVE_PIN_IGNORED', '配列ではありません');
  const ignoredPathspecs = [...new Set(pin.ignoredPathspecs.map((item) => String(item || '').trim()).filter(Boolean))].sort();
  if (!Number.isInteger(pin.round) || pin.round < 1 || pin.round > 3) nativePinFail('NATIVE_PIN_ROUND', String(pin.round));
  const lens = String(pin.lens || '').trim();
  if (!NATIVE_REVIEW_LENS_KEYS.includes(lens)) nativePinFail('NATIVE_PIN_LENS', lens);
  const taskId = String(pin.taskId || '').trim();
  const taskFingerprint = String(pin.taskFingerprint || '').trim();
  if (!taskId || !taskFingerprint) nativePinFail('NATIVE_PIN_TASK');
  const implementerSessionsHash = String(pin.implementerSessionsHash || '');
  if (!NATIVE_HASH_RE.test(implementerSessionsHash)) nativePinFail('NATIVE_PIN_IMPLEMENTER_HASH', String(pin.implementerSessionsHash));
  if (pin.reviewerModel !== NATIVE_QUEUE_REVIEWER_MODEL) nativePinFail('NATIVE_PIN_REVIEWER_MODEL', String(pin.reviewerModel));
  if (pin.reviewerEffort !== NATIVE_QUEUE_REVIEWER_EFFORT) nativePinFail('NATIVE_PIN_REVIEWER_EFFORT', String(pin.reviewerEffort));
  if (pin.primaryModel !== NATIVE_PRIMARY_MODEL) nativePinFail('NATIVE_PIN_PRIMARY_MODEL', String(pin.primaryModel));
  if (pin.primaryEffort !== NATIVE_PRIMARY_EFFORT) nativePinFail('NATIVE_PIN_PRIMARY_EFFORT', String(pin.primaryEffort));
  return {
    schemaVersion: NATIVE_REVIEW_PIN_SCHEMA_VERSION,
    reviewChainVersion: NATIVE_REVIEW_CHAIN_VERSION,
    scopeHash,
    scopeManifestHash,
    reviewedPaths,
    protectedEntries,
    forwardFrozenEntries,
    ignoredPathspecs,
    round: pin.round,
    lens,
    reviewBaseCommit,
    reviewHeadCommit,
    approvalHash,
    taskId,
    taskFingerprint,
    implementerSessionsHash,
    reviewerModel: NATIVE_QUEUE_REVIEWER_MODEL,
    reviewerEffort: NATIVE_QUEUE_REVIEWER_EFFORT,
    primaryModel: NATIVE_PRIMARY_MODEL,
    primaryEffort: NATIVE_PRIMARY_EFFORT,
  };
}

/** The exact, sorted union a native pin must cover: reviewed + protected + forward_frozen. */
export function nativePinClassifiedPaths(pin) {
  return [...new Set([
    ...pin.reviewedPaths,
    ...pin.protectedEntries.map((entry) => entry.path),
    ...pin.forwardFrozenEntries.map((entry) => entry.path),
  ])].sort();
}

// 2026-09-29 (CMGB native focused CALLER): the focused recheck target list is a top-level field of
// the official queue request (nativeFocusedTargets + nativeFocusedTargetsHash). Because
// requestHashMaterial hashes the whole request except inputHash/createdAt, the list and its hash are
// already covered by the queue inputHash; these helpers only reject a malformed declaration so a
// broken list fails before a reviewer is paid. A request with neither field is a legacy/non-focused
// request and returns null without changing its behaviour.
export const NATIVE_FOCUSED_TARGET_LIMIT = 200;

export function nativeFocusedTargetsForRequest(request) {
  const rawList = request ? request.nativeFocusedTargets : undefined;
  const rawHash = request ? request.nativeFocusedTargetsHash : undefined;
  const hasList = rawList !== undefined && rawList !== null;
  const hasHash = rawHash !== undefined && rawHash !== null && String(rawHash) !== '';
  if (!hasList && !hasHash) return null;
  if (!hasList) nativePinFail('NATIVE_FOCUSED_TARGETS_MISSING', 'nativeFocusedTargetsHashだけがあります');
  if (!hasHash) nativePinFail('NATIVE_FOCUSED_TARGETS_HASH_MISSING', 'nativeFocusedTargetsHashがありません');
  const hash = String(rawHash);
  if (!NATIVE_HASH_RE.test(hash)) nativePinFail('NATIVE_FOCUSED_TARGETS_HASH_INVALID', hash.slice(0, 120));
  if (!Array.isArray(rawList)) nativePinFail('NATIVE_FOCUSED_TARGETS_INVALID', '配列ではありません');
  if (rawList.length > NATIVE_FOCUSED_TARGET_LIMIT) {
    nativePinFail('NATIVE_FOCUSED_TARGETS_LIMIT', `${rawList.length} > ${NATIVE_FOCUSED_TARGET_LIMIT}`);
  }
  const seen = new Set();
  const targets = rawList.map((target, index) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      nativePinFail('NATIVE_FOCUSED_TARGET_INVALID', `index=${index}`);
    }
    const key = String(target.key || '');
    if (!NATIVE_HASH_RE.test(key)) nativePinFail('NATIVE_FOCUSED_TARGET_KEY', `index=${index}`);
    if (seen.has(key)) nativePinFail('NATIVE_FOCUSED_TARGET_DUPLICATE', key.slice(0, 120));
    seen.add(key);
    const originalText = typeof target.originalText === 'string' ? target.originalText : '';
    if (!originalText.trim()) nativePinFail('NATIVE_FOCUSED_TARGET_TEXT', key.slice(0, 120));
    return { key, originalText };
  });
  return { hash, targets, keys: targets.map((target) => target.key) };
}

export const NATIVE_FOCUSED_DECISIONS = ['resolved', 'nonblocking', 'open'];

/**
 * Parse the official Opus focused recheck contract out of one queue result body: exactly one
 * `Recheck-Decision: <64hex> | <resolved|nonblocking|open> | <具体的な根拠>` line per pinned target
 * key, returned in the pinned order. A missing, duplicated, malformed or empty-evidence line fails
 * closed, so the acceptance step can never read a partial decision map and the CORE re-check always
 * sees the complete set it recomputed.
 */
export function parseFocusedRecheckDecisions(body, expectedKeys) {
  const keys = (Array.isArray(expectedKeys) ? expectedKeys : []).map((key) => String(key));
  for (const key of keys) if (!NATIVE_HASH_RE.test(key)) nativePinFail('NATIVE_FOCUSED_EXPECTED_KEY', key.slice(0, 120));
  const found = new Map();
  const text = String(body === undefined || body === null ? '' : body).replace(/\r\n?/gu, '\n');
  for (const line of text.split('\n')) {
    if (!/Recheck-Decision/iu.test(line)) continue;
    const match = line.match(/^\s*(?:[-*+]\s+)?(?:\*\*)?Recheck-Decision(?:\*\*)?\s*:\s*([a-f0-9]{64})\s*\|\s*(resolved|nonblocking|open)\s*\|\s*(.*\S)\s*$/iu);
    if (!match) nativePinFail('NATIVE_FOCUSED_DECISION_LINE', line.trim().slice(0, 120));
    const key = match[1];
    if (found.has(key)) nativePinFail('NATIVE_FOCUSED_DECISION_DUPLICATE', key.slice(0, 120));
    found.set(key, { key, decision: match[2].toLowerCase(), evidence: match[3].trim() });
  }
  if (found.size !== keys.length || keys.some((key) => !found.has(key))) {
    nativePinFail('NATIVE_FOCUSED_DECISION_SET', `expected=${keys.length} actual=${found.size}`);
  }
  return keys.map((key) => found.get(key));
}

/**
 * The exhaustive manifest contract: the manifest that is frozen alongside the pin must name this
 * exact union. Two-way equality, so a silently dropped classified path or a smuggled extra path
 * both fail. This never replaces the authoritative queue path-list snapshot; it only stops a pin
 * that does not cover the manifest the reviewer was handed.
 */
export function assertNativePinCoversManifest(pin, manifestFiles) {
  if (!Array.isArray(manifestFiles)) {
    throw new Error('NATIVE_PIN_MANIFEST_MISMATCH: manifestが配列ではありません');
  }
  const raw = manifestFiles.map((file) => String(file?.path || ''));
  const unique = [...new Set(raw)].sort();
  const classified = nativePinClassifiedPaths(pin);
  // Cardinality first: a duplicated raw entry is rejected before the Set can silently collapse it.
  if (raw.length !== unique.length || JSON.stringify(unique) !== JSON.stringify(classified)) {
    throw new Error(`NATIVE_PIN_MANIFEST_MISMATCH: 分類集合とmanifestが一致しません (manifest=${raw.length} unique=${unique.length} classified=${classified.length})`);
  }
  return true;
}

/**
 * Git `--`-list arguments that name each path literally, so a reviewed task output carrying glob
 * metacharacters (for example `src/app/api/episodes/[episodeId]/route.ts`) is enumerated as itself
 * instead of being read as a character class and silently dropped from the queue diff.
 */
export function literalGitPathspecs(paths) {
  if (!Array.isArray(paths)) throw new Error('literalGitPathspecs: 配列が必要です');
  return paths.map((path) => `:(literal)${String(path)}`);
}

/** Two-way equality between the formal sender's declared list and the scope's own reviewed list. */
function assertDeclaredReviewedMatch(declared, scopeReviewed) {
  const senderList = [...declared].sort();
  const scopeList = [...scopeReviewed].sort();
  if (JSON.stringify(senderList) !== JSON.stringify(scopeList)) {
    nativePinFail('NATIVE_PIN_DECLARED_MISMATCH', `sender=${senderList.length} scope=${scopeList.length}`);
  }
}

/**
 * Build the deepseek-native-cli-v1 pin from an already verified review-scope-v1 manifest.
 *
 * The official sender declares its own reviewed list with `--native-reviewed-path`; that list must
 * equal the scope's `kind=reviewed` list exactly. An empty, duplicated, or drifting declaration is
 * rejected instead of being silently replaced by the scope list, so a task-owned output cannot
 * vanish between the formal request and the verified scope. `scopeHash` binds the classified
 * manifest and `scopeManifestHash` binds the exact scope file bytes (so the later acceptance step
 * can re-hash the request-owned scope file). The pin carries no self-hash: the queue request
 * `inputHash` already covers the whole request that holds this pin, and naming that hash here
 * would be circular.
 */
export function buildNativeReviewPin({
  scope,
  declaredReviewedPaths,
  ignoredPathspecs = [],
  implementerSessionsHash,
  round,
  lens,
  taskId,
  taskFingerprint,
  approvalHash = null,
  reviewBaseCommit,
  reviewHeadCommit,
}) {
  if (!scope || scope.version !== 'review-scope-v1') nativePinFail('NATIVE_PIN_SCOPE_VERSION', String(scope && scope.version));
  if (!Array.isArray(scope.entries)) nativePinFail('NATIVE_PIN_SCOPE_ENTRIES');
  const declared = nativePinPathList(declaredReviewedPaths, 'NATIVE_PIN_DECLARED_PATH');
  if (!declared.length) nativePinFail('NATIVE_PIN_DECLARED_EMPTY');
  const entries = scope.entries.map((entry) => {
    if (!entry || typeof entry !== 'object') nativePinFail('NATIVE_PIN_SCOPE_ENTRIES');
    const kind = String(entry.kind || '');
    if (!['reviewed', 'protected', 'forward_frozen'].includes(kind)) nativePinFail('NATIVE_PIN_SCOPE_KIND', `${String(entry.path || '')} kind=${kind}`);
    return {
      path: nativePinPath(entry.path, 'NATIVE_PIN_SCOPE_PATH'),
      kind,
      sha: String(entry.sha || ''),
      reason: String(entry.reason || ''),
    };
  });
  const reviewedPaths = entries.filter((entry) => entry.kind === 'reviewed').map((entry) => entry.path);
  if (!reviewedPaths.length) nativePinFail('NATIVE_PIN_REVIEWED_EMPTY');
  assertDeclaredReviewedMatch(declared, reviewedPaths);
  if (scope.taskId !== taskId || scope.taskFingerprint !== taskFingerprint) nativePinFail('NATIVE_PIN_TASK', 'scopeと依頼のtaskが一致しません');
  if (approvalHash && scope.approvalHash !== approvalHash) nativePinFail('NATIVE_PIN_APPROVAL', 'scopeと承認hashが一致しません');
  if (scope.base !== reviewBaseCommit) nativePinFail('NATIVE_PIN_BASE', 'scopeと基点が一致しません');
  if (scope.head !== reviewHeadCommit) nativePinFail('NATIVE_PIN_HEAD', 'scopeと対象版が一致しません');
  if (scope.round !== round) nativePinFail('NATIVE_PIN_ROUND', `scope=${String(scope.round)} request=${String(round)}`);
  return normalizeNativeReviewPin({
    schemaVersion: NATIVE_REVIEW_PIN_SCHEMA_VERSION,
    reviewChainVersion: NATIVE_REVIEW_CHAIN_VERSION,
    scopeHash: scope.scopeHash,
    scopeManifestHash: scope.manifestHash,
    reviewedPaths,
    protectedEntries: entries.filter((entry) => entry.kind === 'protected'),
    forwardFrozenEntries: entries.filter((entry) => entry.kind === 'forward_frozen'),
    ignoredPathspecs,
    round,
    lens,
    reviewBaseCommit,
    reviewHeadCommit,
    approvalHash: scope.approvalHash,
    taskId,
    taskFingerprint,
    implementerSessionsHash,
    reviewerModel: NATIVE_QUEUE_REVIEWER_MODEL,
    reviewerEffort: NATIVE_QUEUE_REVIEWER_EFFORT,
    primaryModel: NATIVE_PRIMARY_MODEL,
    primaryEffort: NATIVE_PRIMARY_EFFORT,
  });
}

/**
 * Extract and validate the native pin from a formal queue request. The chain marker is a top-level
 * field on purpose: a deepseek-native-cli-v1 task that omits its pin must not silently register
 * through the legacy path, and a pin without the marker is rejected as an inconsistent request.
 * Returns null for a plain legacy request, so the oldchain path is untouched.
 */
export function nativeReviewPinFromRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) nativePinFail('NATIVE_PIN_REQUEST_INVALID');
  const hasPin = request.nativeReview !== null && request.nativeReview !== undefined;
  if (request.reviewChainVersion !== NATIVE_REVIEW_CHAIN_VERSION) {
    if (hasPin) nativePinFail('NATIVE_PIN_REQUEST_MISMATCH', 'reviewChainVersionが無い依頼にnativeReviewがあります');
    return null;
  }
  if (!hasPin) nativePinFail('NATIVE_PIN_REQUIRED', 'deepseek-native-cli-v1の依頼にはnativeReview pinが必要です');
  const pin = normalizeNativeReviewPin(request.nativeReview);
  const scopeFile = String(request.nativeScopeFile || '');
  if (!scopeFile || scopeFile.includes('\\') || scopeFile.startsWith('/') || scopeFile.split('/').includes('..')) {
    nativePinFail('NATIVE_PIN_SCOPE_FILE', scopeFile);
  }
  return { pin, scopeFile };
}

/**
 * Register-time fail-closed check for the native chain. `manifestFiles` is the already-redacted
 * queue manifest file list; when supplied it must equal the pin's classified union exactly, so a
 * classified path cannot vanish from the frozen snapshot and an extra path cannot be smuggled in.
 */
export function assertNativeRequestPin(request, { manifestFiles = null } = {}) {
  const bound = nativeReviewPinFromRequest(request);
  if (!bound) return null;
  const { pin } = bound;
  // CALLER所有のfocused対象一覧は、宣言があるときに形を厳密に検査する（無い依頼は従来どおり）。
  nativeFocusedTargetsForRequest(request);
  if (pin.round !== request.round) nativePinFail('NATIVE_PIN_REQUEST_MISMATCH', `round request=${String(request.round)} pin=${pin.round}`);
  if (pin.lens !== request.lens) nativePinFail('NATIVE_PIN_REQUEST_MISMATCH', `lens request=${String(request.lens)} pin=${pin.lens}`);
  if (pin.reviewHeadCommit !== request.head) nativePinFail('NATIVE_PIN_REQUEST_MISMATCH', 'head');
  if (pin.taskId !== request.taskId || pin.taskFingerprint !== request.taskFingerprint) nativePinFail('NATIVE_PIN_REQUEST_MISMATCH', 'task');
  if (request.reviewer?.model !== NATIVE_QUEUE_REVIEWER_MODEL) nativePinFail('NATIVE_PIN_REVIEWER_MODEL', String(request.reviewer?.model));
  if (request.reviewer?.effort !== NATIVE_QUEUE_REVIEWER_EFFORT) nativePinFail('NATIVE_PIN_REVIEWER_EFFORT', String(request.reviewer?.effort));
  if (!Array.isArray(manifestFiles) || !manifestFiles.length) {
    nativePinFail('NATIVE_PIN_MANIFEST_MISSING', 'native依頼のqueue manifest(files配列)が必要です');
  }
  assertNativePinCoversManifest(pin, manifestFiles);
  return { pin, scopeFile: bound.scopeFile };
}

export const REVIEW_QUEUE_STATES = new Set([
  'pending',
  'leased',
  'running',
  'result_staged',
  'published',
  'accepted',
]);

export function reviewQueueReviewerKind(model) {
  const normalized = String(model || '').toLowerCase();
  if (normalized.includes('opus') || normalized.includes('claude')) return 'opus';
  if (normalized.includes('codex') || normalized.includes('gpt')) return 'codex';
  throw new Error(`unsupported reviewer model: ${model || 'missing'}`);
}

export function validReviewQueueFallback(expectedModel, actualModel, fallbackFrom) {
  return expectedModel !== 'gpt-6-astra'
    && fallbackFrom === expectedModel
    && reviewQueueReviewerKind(expectedModel) === 'codex'
    && actualModel === 'opus';
}

export function validReviewQueueResultModel(request, actualModel, fallbackFrom) {
  const expectedModel = request?.reviewer?.model;
  if (actualModel === expectedModel && fallbackFrom === undefined) return true;
  if (validReviewQueueFallback(expectedModel, actualModel, fallbackFrom)) return true;
  const runtimeCli = request?.runtime?.cli ?? request?.reviewer?.cli;
  if (runtimeCli || expectedModel !== 'codex' || fallbackFrom !== undefined) return false;
  try {
    return reviewQueueReviewerKind(actualModel) === 'codex';
  } catch {
    return false;
  }
}

export function reviewQueueRoot() {
  if (process.env.AI_REVIEW_QUEUE_DIR) {
    if (process.env.NODE_ENV === 'test' || process.env.AI_DEV_TOOL_ALLOW_QUEUE_DIR_OVERRIDE === '1') {
      if (!isAbsolute(process.env.AI_REVIEW_QUEUE_DIR)) {
        throw new Error('AI_REVIEW_QUEUE_DIRは絶対パスで指定してください');
      }
      return resolve(process.env.AI_REVIEW_QUEUE_DIR);
    }
    if (!queueOverrideWarningShown) {
      queueOverrideWarningShown = true;
      console.error(
        `REVIEW_PROCESS_WARNING: 未許可のAI_REVIEW_QUEUE_DIRを無視しました。上書きする場合はAI_DEV_TOOL_ALLOW_QUEUE_DIR_OVERRIDE=1を指定してください。実効保存先=${resolve(DEFAULT_REVIEW_QUEUE_ROOT)}`,
      );
    }
  }
  return resolve(DEFAULT_REVIEW_QUEUE_ROOT);
}

export function queueEntryPath(requestId) {
  if (!IDENTIFIER_PATTERN.test(String(requestId || ''))) {
    throw new Error('Request-IDの文字種・長さが不正です');
  }
  return join(reviewQueueRoot(), requestId);
}

export function ensureSafeDirectory(path, { create = false, mode = 0o700 } = {}) {
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
      if (error?.code !== 'ENOENT') throw error;
      if (!create) throw new Error(`${path}がありません`);
      try {
        mkdirSync(directory, { mode });
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      info = lstatSync(directory);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${directory}は通常のディレクトリではありません`);
    }
  }
}

export function ensureSafeFile(path, label = basename(path)) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label}は通常ファイルではありません`);
  }
  return info;
}

export function atomicWriteFile(path, content, { mode = 0o600 } = {}) {
  ensureSafeDirectory(dirname(path), { create: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      mode,
    );
    fchmodSync(fd, mode);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function atomicWriteJson(path, value) {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(path) {
  ensureSafeFile(path);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return hash.digest('hex');
}

export function queueRequestId({ taskId, taskFingerprint, contentHash, forceNew = false }) {
  if (forceNew) return randomUUID();
  const digest = sha256(`${taskId}\0${taskFingerprint}\0${contentHash}`);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

export function queueReissueCostPolicy(status) {
  const normalized = status === null || status === undefined ? null : String(status);
  const known = new Set(['pending', 'leased', 'running', 'result_staged', 'published', 'accepted']);
  if (normalized !== null && !known.has(normalized)) {
    throw new Error(`再依頼元のstatusが不正です: ${normalized || 'なし'}`);
  }
  const reapprovalRequired = ['running', 'result_staged', 'published', 'accepted'].includes(normalized);
  return {
    reapprovalRequired,
    reapprovalReason: reapprovalRequired ? 'reissue-after-result-staged' : null,
  };
}

export function conservativeQueueReissueMetadata(previousRequestId) {
  return {
    reissueOf: previousRequestId,
    reapprovalRequired: true,
    reapprovalReason: 'reissue-after-result-staged',
  };
}

export function queueReissueMetadata({ previousRequestId, previousContentHash, currentContentHash, status }) {
  if (!previousRequestId || previousContentHash !== currentContentHash) return null;
  return {
    reissueOf: previousRequestId,
    ...queueReissueCostPolicy(status),
  };
}

// --- queue費用枠の解決（承認台帳は読むだけ。書き込みはしない） ---
//
// queueのレビューは「送る側の費用枠(環境変数)」と「受ける側の承認台帳」の両方が揃って初めて通る。
// 片方だけだと worker が pending + 30分待機にするため、画面上は「レビュー待ち」に見えて永久に進まない。
// そこで登録前に台帳を照合し、通らない依頼はここで止めて不足内容を出す。
//
// ここで見るのは「承認レコードの有無」と「金額が承認・policyの上限以内か」だけで、
// 消費実績（タスク累計・当日合計の残枠）は見ない。残枠は worker が usage記録から判定するため、
// 残枠切れの依頼は登録が通ったあとに worker 側で止まる。送信側で残枠まで判定するには
// worker の内部記録形式に依存することになるので、そちらは worker 側の担当に残している。
// 参照: ~/projects/knowledge/lessons/review-queue-cost-limit-two-places.md
//       ~/projects/knowledge/lessons/approval-truth-in-uncommitted-file-is-invisible-to-lanes.md
export const REVIEW_COST_APPROVAL_MAX_BYTES = 128 * 1024;
export const MAX_REVIEW_COST_YEN = 10000;
const COST_APPROVAL_FILE_ENV = 'AI_REVIEW_COST_APPROVAL_FILE';
// worker(review-queue-worker.mjs)は自分のcheckout位置から台帳を決めるため、送信側も同じ実体を
// 直接指す。KB_ROOT のような環境変数で読み先を動かすと、送信側だけ別の台帳を見て「送信は通るが
// workerが止める」状態を新しく作ってしまう（今回直している30分待機と同じ形）。
const DEFAULT_COST_APPROVAL_PATH = '/home/dev/projects/knowledge/config/review-queue-cost-approval.json';
let costApprovalOverrideWarningShown = false;

export function parseQueueCostYen(value, name, maxYen = MAX_REVIEW_COST_YEN) {
  const text = String(value ?? '0').trim() || '0';
  if (!/^[0-9]+$/u.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > maxYen) {
    throw new Error(`${name}は0〜${maxYen}円の整数で指定してください`);
  }
  return Number(text);
}

/**
 * 承認台帳の実パス。既定は worker が読むのと同じ実体で固定する。
 * 差し替えはテストと移設のための AI_REVIEW_COST_APPROVAL_FILE だけに限る。
 */
export function reviewCostApprovalPath(env = process.env) {
  const override = env[COST_APPROVAL_FILE_ENV];
  if (override) {
    if (env.NODE_ENV === 'test' || env.AI_DEV_TOOL_ALLOW_COST_APPROVAL_FILE === '1') {
      if (!isAbsolute(override)) throw new Error(`${COST_APPROVAL_FILE_ENV}は絶対パスで指定してください`);
      return resolve(override);
    }
    if (!costApprovalOverrideWarningShown) {
      costApprovalOverrideWarningShown = true;
      console.error(
        `REVIEW_PROCESS_WARNING: 未許可の${COST_APPROVAL_FILE_ENV}を無視しました。上書きする場合はAI_DEV_TOOL_ALLOW_COST_APPROVAL_FILE=1を指定してください。`,
      );
    }
  }
  return DEFAULT_COST_APPROVAL_PATH;
}

// maxPerTaskYenCap は既定で従来の一般上限(10,000円)。本件例外へ完全束縛された有効な1件がある
// 経路だけが 20,000円 を渡す。台帳の自己申告だけで上限が上がらないよう、後段の ceilings 突合が本線。
function validCostApprovalEntry(entry, maxPerTaskYenCap = MAX_REVIEW_COST_YEN) {
  return Boolean(
    entry
    && typeof entry.approvedBy === 'string' && entry.approvedBy.trim()
    && Number.isFinite(Date.parse(entry.approvedAt))
    && Number.isInteger(entry.maxPerAttemptYen) && entry.maxPerAttemptYen > 0 && entry.maxPerAttemptYen <= MAX_REVIEW_COST_YEN
    && Number.isInteger(entry.maxPerTaskYen) && entry.maxPerTaskYen > 0 && entry.maxPerTaskYen <= maxPerTaskYenCap,
  );
}

/** review-queue-worker の requestCostDecision と同じ突合。taskIdは完全一致だけを有効にする。 */
export function findQueueCostApproval(approvals, {
  taskId, project, requestId, requireRequestId = false, maxPerTaskYenCap = MAX_REVIEW_COST_YEN,
}) {
  // 改訂(--amend)は旧レコードを残したまま末尾へ追記する。先頭で打ち切ると旧い額を拾うため、
  // 一致する有効な最後の1件(追記順の最新)を選ぶ。作業役も同じ規則を使う。
  let found = null;
  for (const entry of Array.isArray(approvals) ? approvals : []) {
    if (entry && entry.taskId === taskId && entry.project === project
      && (!requireRequestId || entry.requestId === requestId)
      && validCostApprovalEntry(entry, maxPerTaskYenCap)) found = entry;
  }
  return found;
}

/** 取り違えやすい似た名前のtaskIdを拾う（完全一致だけが有効であることを見せるため）。 */
export function similarApprovalTaskIds(approvals, taskId, limit = 5) {
  const target = String(taskId || '');
  const head = target.slice(0, 12);
  if (!head) return [];
  const seen = new Set();
  const hits = [];
  for (const entry of Array.isArray(approvals) ? approvals : []) {
    const candidate = String(entry?.taskId || '');
    if (!candidate || candidate === target || seen.has(candidate)) continue;
    if (candidate.startsWith(head) || target.startsWith(candidate.slice(0, 12))) {
      seen.add(candidate);
      hits.push(candidate);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/**
 * 本件限定の1回/タスク上限(policy.scopedTaskCeilings[])。taskId+repo+project の完全一致でだけ効く。
 * 形・出所が少しでも欠けたら無効(全体policyの上限値と同じ扱いに落とす)ので、改ざんされた
 * レコードが上限を上げることはない。通常は task全体の上限が policy.maxApprovedTaskYen を超えない。
 * 唯一の例外は SCOPED_TASK_CEILING_EXCEPTION へ完全一致で束縛された1件だけで、そこだけ
 * 現行44,000円 / 2,000円 まで許す(1回900円超またはtask7,000円超は就寝前原文への束縛が必須。
 * task20,000円超は、累計上限30,000円を直接示す原文への束縛も必須。全体policy値は不変)。
 */
export function validScopedCostCeiling(entry, policy = null) {
  // 例外のidentityへ束縛された記載は、全体policyが動いた時点で無効にする(fail closed)。
  // 生きたpolicyの(より大きい)上限へ黙って落とすと、束縛した意味が消え、改変で例外が復活する。
  if (entry && typeof entry === 'object' && scopedCeilingExceptionBoundIdentity(entry)
    && !scopedCeilingPolicyUnchanged(policy)) {
    return false;
  }
  // 例外identityの記載が、就寝前原文へ束縛できない1回900円超/task7,000円超を名乗る場合は無効にする。
  // ここで落とさないと、束縛の無い記載が一般上限(1回10,000円)まで通ってしまう(fail closed)。
  if (entry && typeof entry === 'object' && scopedCeilingExceptionBoundIdentity(entry)
    && scopedCeilingPolicyUnchanged(policy)
    && scopedCeilingExceptionNeedsReservation(entry)
    && !scopedCeilingReservationBound(entry)) {
    return false;
  }
  // 例外identityの記載が、累計上限30,000円を直接示す原文へ束縛できない task20,000円超を名乗る
  // 場合は無効にする。有効な本件例外が1件も無ければ、より低い全体policy値で判定する(fail closed)。
  if (entry && typeof entry === 'object' && scopedCeilingExceptionBoundIdentity(entry)
    && scopedCeilingPolicyUnchanged(policy)
    && scopedCeilingExceptionNeedsLatestTotalCap(entry)
    && !scopedCeilingLatestTotalCapBound(entry)) {
    return false;
  }
  // 本件だけの明示的例外に完全一致する1件だけは、全体policyを変えずに上限を差し替える。
  // 束縛が1つでも欠ける/違う/全体policyが動いていれば例外は効かず、従来のpolicy上限で判定する。
  const exception = scopedCeilingException(policy, entry);
  const taskCeiling = exception ? exception.maxPerTaskYen
    : (Number.isInteger(policy?.maxApprovedTaskYen) ? policy.maxApprovedTaskYen
      : (Number.isInteger(policy?.maxPerTaskYen) ? policy.maxPerTaskYen : MAX_REVIEW_COST_YEN));
  const attemptCeiling = exception ? exception.maxPerAttemptYen : MAX_REVIEW_COST_YEN;
  return Boolean(
    entry && typeof entry === 'object'
    && typeof entry.taskId === 'string' && IDENTIFIER_PATTERN.test(entry.taskId)
    && typeof entry.project === 'string' && (entry.project === '' || IDENTIFIER_PATTERN.test(entry.project))
    && typeof entry.repo === 'string' && IDENTIFIER_PATTERN.test(entry.repo)
    && typeof entry.approvedBy === 'string' && entry.approvedBy.trim() !== ''
    && Number.isFinite(Date.parse(entry.approvedAt))
    && typeof entry.recordedBy === 'string' && entry.recordedBy.trim() !== ''
    && typeof entry.source === 'string' && entry.source.trim() !== ''
    && Number.isInteger(entry.maxPerAttemptYen) && entry.maxPerAttemptYen > 0 && entry.maxPerAttemptYen <= attemptCeiling
    && Number.isInteger(entry.maxPerTaskYen) && entry.maxPerTaskYen >= entry.maxPerAttemptYen && entry.maxPerTaskYen <= taskCeiling,
  );
}

/**
 * identity が完全一致して有効な最後の1件(追記順の最新=改訂版)を選ぶ。
 * 改訂(--amend)で旧レコードを残したまま追記するため、先頭ではなく末尾を採る。
 */
export function findScopedCostCeiling(policy, { taskId, project, repo }) {
  const list = Array.isArray(policy?.scopedTaskCeilings) ? policy.scopedTaskCeilings : [];
  let found = null;
  for (const entry of list) {
    if (entry && entry.taskId === taskId && entry.project === project && entry.repo === repo
      && validScopedCostCeiling(entry, policy)) found = entry;
  }
  return found;
}

/**
 * この依頼にだけ効く1回/タスク全体の上限。本件限定の登録が無ければ従来のpolicy値。
 * 送信側(ai-review-send)と作業役(review-queue-worker)が同じ式を使う。
 * scopedEntryInvalid は「identityは一致するが記載が不正」を見せる(欠落・改ざんの名指し用)。
 */
export function resolveEffectiveCostCeilings(policy, { taskId, project, repo }) {
  const list = Array.isArray(policy?.scopedTaskCeilings) ? policy.scopedTaskCeilings : [];
  const sameIdentity = (entry) => Boolean(
    entry && entry.taskId === taskId && entry.project === project && entry.repo === repo,
  );
  const scoped = findScopedCostCeiling(policy, { taskId, project, repo });
  // 例外のidentityで書かれた記載があるのに有効な上限が無い場合は、束縛時のpolicy値までしか許さない。
  // 生きたpolicyが変わっていても、その新しい上限へ例外を復活させない(fail closed)。
  if (!scoped && scopedCeilingExceptionBoundIdentity({ taskId, project, repo }) && list.some(sameIdentity)) {
    return {
      scoped: null,
      scopedEntryInvalid: true,
      maxPerAttemptYen: SCOPED_TASK_CEILING_EXCEPTION.policy.maxPerAttemptYen,
      maxPerTaskYen: SCOPED_TASK_CEILING_EXCEPTION.policy.maxApprovedTaskYen,
    };
  }
  const maxPerAttemptYen = scoped ? scoped.maxPerAttemptYen
    : (Number.isInteger(policy?.maxPerAttemptYen) ? policy.maxPerAttemptYen : undefined);
  const maxPerTaskYen = scoped ? scoped.maxPerTaskYen
    : (Number.isInteger(policy?.maxApprovedTaskYen) ? policy.maxApprovedTaskYen
      : (Number.isInteger(policy?.maxPerTaskYen) ? policy.maxPerTaskYen : undefined));
  return {
    scoped,
    scopedEntryInvalid: !scoped && list.some(sameIdentity),
    maxPerAttemptYen,
    maxPerTaskYen,
  };
}

/**
 * 本件だけの明示的な費用容量例外(2026-09-29 承認)。
 * - 旧15,000円/1回900円の原承認は履歴として保持。就寝前原文は本件の完了と必要な小増を認めるが、
 *   下の1回2,000円 / task全体44,000円は本taskだけの内部管理値(予約容量)であり、ユーザーが
 *   指定したAPI実費額でも課金額でもない(根拠: 実測 USD5.19918 / effectiveYen900 / YEN_PER_USD200 /
 *   num_turns3 の予算停止)。ユーザーの直接指示は累計API実費の上限30,000円で、その実費上限は
 *   各回の有料呼び出しの前に別途必ず検査する。下の44,000円はその検査を緩めるものではなく、
 *   このtaskにだけ用意した有限の内部予約枠である(初回の26,000円はその内側で用意した値)。
 *   現行の44,000円は、予約34,800円へ spec/user_path/edge の3×2,000円=40,800円と、
 *   有限の追加再試行1回2,000円=42,800円を収めるための有限の余裕で、ユーザー指定額ではない。
 * - 全体policy(maxPerAttemptYen=500 / maxPerTaskYen=3000 / maxApprovedTaskYen=5000)はこの例外で
 *   書き換えない。他task・既存承認・日次上限・既存RUNNING予約は不変。
 * - 下の全項目が一致する1件だけ、この task の task全体上限を最大44,000円、1回上限を2,000円まで許す。
 *   1つでも欠ける/違う/全体policyが動いていれば例外は効かず、従来のpolicy上限で判定する(fail closed)。
 * - 原承認出所は保存済み原文の内容hashへ束縛する。台帳側の記載がこの写しであることは
 *   scopedCeilingException が突合するため、依頼票や台帳の自己申告だけでは通らない。
 * - task全体上限は3段階。7,000円以下は従来の2出所で有効(後方互換)。7,000円超20,000円以下の
 *   有限な追加予約容量は3つ目の原承認出所(reservationSource / reservationSourceSha256)まで
 *   完全一致を要求する。20,000円超の有限な追加予約容量は、さらに4つ目の原承認出所
 *   (latestTotalCapSource / latestTotalCapSourceSha256: 累計上限30,000円を直接示す原文)まで
 *   完全一致を要求し、上限は本件例外の 44,000円 まで許す(一般上限の MAX_REVIEW_COST_YEN は
 *   10,000円 のまま増やさない。44,001円は拒否する)。26,000円 / 30,000円 / 36,000円 / 40,000円の既存段は
 *   履歴としてそのまま有効である(新しい束縛を遡って要求しない)。
 * - 1回上限も2段階。900円以下は従来の2出所で有効(後方互換)。900円超の1回上限は、7,000円超と
 *   同じ3つ目の原承認出所まで完全一致を要求し、上限は本件例外の 2,000円 まで(2,001円は拒否)。
 */
export const SCOPED_TASK_CEILING_EXCEPTION = Object.freeze({
  taskId: 'cmgb-t0-t5-local-recovery-20260927',
  repo: 'cmgb-recovery',
  project: '',
  taskFingerprint: 'cmgb-local-recovery-20260927-t0-t5',
  approvalSource: 'user-original/20260928-budget15000-continuation.md',
  approvalSourceSha256: '2ece8cd939d3e90dec0247ec7f8b8804958b8fb26ef43799280025b90ebdfb35',
  perAttemptSource: 'user-original/20260928-scoped-review-cap900-continuation.md',
  perAttemptSourceSha256: '17bc21c4b777cb8963c654a7144e56b1121592e1298482937c809492ee156466',
  reservationSource: 'user-original/20260929-finish-while-asleep.md',
  reservationSourceSha256: '7C967C34BA256D26116C132D9946350B2AC28B19CD60D137102BC0318E514B4C',
  latestTotalCapSource: 'user-original/20260929-latest-total-api-cap-30000.md',
  latestTotalCapSourceSha256: 'BAAF91A8DE73A044FEE5A943A011E7A09008FAAEC939A43B98B57AF7621F70A3',
  maxPerAttemptYen: 2000,
  legacyMaxPerAttemptYen: 900,
  legacyMaxPerTaskYen: 7000,
  reservationMaxPerTaskYen: 20000,
  maxPerTaskYen: 44000,
  policy: Object.freeze({ maxPerAttemptYen: 500, maxPerTaskYen: 3000, maxApprovedTaskYen: 5000 }),
});

/** 例外を書いた時点の全体policy値のままか(1つでも動けば例外は無効)。 */
export function scopedCeilingPolicyUnchanged(policy) {
  const expected = SCOPED_TASK_CEILING_EXCEPTION.policy;
  return Boolean(policy)
    && policy.maxPerAttemptYen === expected.maxPerAttemptYen
    && policy.maxPerTaskYen === expected.maxPerTaskYen
    && policy.maxApprovedTaskYen === expected.maxApprovedTaskYen;
}

/**
 * taskId+repo+project だけで例外のidentityに一致するか(不変policyの確認は別)。
 * 生きたpolicyが変わっていても「この1件は例外として書かれた」ことを見分けるために使う。
 */
export function scopedCeilingExceptionBoundIdentity({ taskId, project, repo } = {}) {
  const exception = SCOPED_TASK_CEILING_EXCEPTION;
  return exception.taskId === taskId && exception.repo === repo && exception.project === project;
}

/**
 * identity(taskId+repo+project)と不変policyだけで決まる例外候補。台帳側の束縛の記載はまだ見ない。
 * 承認CLIが「この1件に例外を使う」と決めるためと、読み手の突合の土台に使う。
 */
export function scopedCeilingExceptionIdentity(policy, { taskId, project, repo } = {}) {
  const exception = SCOPED_TASK_CEILING_EXCEPTION;
  if (!scopedCeilingPolicyUnchanged(policy)) return null;
  return scopedCeilingExceptionBoundIdentity({ taskId, project, repo }) ? exception : null;
}

/**
 * 台帳の1件(entry)が例外の写しとして完全に一致するときだけ例外を返す。
 * fingerprint・原承認出所と内容hash(2件)・金額の上限まで全部一致が要る(部分一致は無効)。
 * 1回900円超またはtask7,000円超(有限な追加予約容量。上限2,000円 / 20,000円)へ上げる場合だけ、
 * 3つ目の原承認出所(reservationSource / reservationSourceSha256)まで完全一致を要求する。
 */
export function scopedCeilingException(policy, entry) {
  const exception = scopedCeilingExceptionIdentity(policy, entry || {});
  if (!exception) return null;
  const bound = Boolean(entry)
    && entry.taskFingerprint === exception.taskFingerprint
    && entry.approvalSource === exception.approvalSource
    && entry.approvalSourceSha256 === exception.approvalSourceSha256
    && entry.perAttemptSource === exception.perAttemptSource
    && entry.perAttemptSourceSha256 === exception.perAttemptSourceSha256
    && Number.isInteger(entry.maxPerAttemptYen) && entry.maxPerAttemptYen <= exception.maxPerAttemptYen
    && Number.isInteger(entry.maxPerTaskYen) && entry.maxPerTaskYen <= exception.maxPerTaskYen;
  if (!bound) return null;
  // 従来tier(1回900円/task7,000円)は上の束縛だけで有効(後方互換)。それを超える有限の追加予約
  // 容量へ上げる場合だけ、3つ目の原承認出所(就寝前原文の source+hash)まで完全一致を要求する。
  // 出所が1つでも欠ける/違えば例外を無効にし、従来のpolicy上限で判定する(fail closed)。
  if (scopedCeilingExceptionNeedsReservation(entry, exception) && !scopedCeilingReservationBound(entry, exception)) {
    return null;
  }
  // task20,000円超の新しい有限な追加予約容量へ上げる場合だけ、4つ目の原承認出所(累計上限30,000円を
  // 直接示す原文の source+hash)まで完全一致を要求する。出所が1つでも欠ける/違えば例外を無効にし、
  // より低い全体policy値で判定する(fail closed)。
  if (scopedCeilingExceptionNeedsLatestTotalCap(entry, exception)
    && !scopedCeilingLatestTotalCapBound(entry, exception)) {
    return null;
  }
  return exception;
}

/** 従来tier(1回900円/task7,000円)を超える記載か(超えるなら就寝前原文への束縛が必須)。 */
export function scopedCeilingExceptionNeedsReservation(entry, exception = SCOPED_TASK_CEILING_EXCEPTION) {
  if (!entry || typeof entry !== 'object' || !exception) return false;
  return (Number.isInteger(entry.maxPerAttemptYen) && entry.maxPerAttemptYen > exception.legacyMaxPerAttemptYen)
    || (Number.isInteger(entry.maxPerTaskYen) && entry.maxPerTaskYen > exception.legacyMaxPerTaskYen);
}

/** 記載が就寝前原文(reservationSource / reservationSourceSha256)へ完全一致しているか。 */
export function scopedCeilingReservationBound(entry, exception = SCOPED_TASK_CEILING_EXCEPTION) {
  return Boolean(entry && exception
    && entry.reservationSource === exception.reservationSource
    && entry.reservationSourceSha256 === exception.reservationSourceSha256);
}

/**
 * task側の上限が、4つ目の原承認出所を要する新しいtier(20,000円超)に入っているか。
 * 20,000円以下は従来の予約容量として、この出所が無くても有効(後方互換)。
 */
export function scopedCeilingExceptionNeedsLatestTotalCap(entry, exception = SCOPED_TASK_CEILING_EXCEPTION) {
  if (!entry || typeof entry !== 'object' || !exception) return false;
  return Number.isInteger(entry.maxPerTaskYen) && entry.maxPerTaskYen > exception.reservationMaxPerTaskYen;
}

/** 記載が累計上限の原文(latestTotalCapSource / latestTotalCapSourceSha256)へ完全一致しているか。 */
export function scopedCeilingLatestTotalCapBound(entry, exception = SCOPED_TASK_CEILING_EXCEPTION) {
  return Boolean(entry && exception
    && entry.latestTotalCapSource === exception.latestTotalCapSource
    && entry.latestTotalCapSourceSha256 === exception.latestTotalCapSourceSha256);
}

function approvalRecordSample({ taskId, project, requestId, maxPerAttemptYen, maxPerTaskYen }) {
  const record = {
    approvedBy: '<承認した親またはユーザーの名前>',
    approvedAt: new Date().toISOString(),
    taskId,
    project,
    ...(requestId ? { requestId } : {}),
    maxPerAttemptYen,
    maxPerTaskYen,
    note: '<何の費用をなぜ承認したか>',
  };
  return JSON.stringify(record, null, 2).split('\n').map((line) => `    ${line}`);
}

/**
 * 環境変数と承認台帳から、queue依頼へ焼き付ける費用枠を決める。
 * - 環境変数が未指定(0)なら、台帳の承認値をそのまま既定にする（0円のまま登録しない）。
 * - 台帳に一致する承認が無ければ ok:false を返す（登録させない）。
 * - 環境変数が承認値やpolicy上限を超える場合も ok:false（自動で切り下げず人へ返す）。
 * - 本件限定の上限(policy.scopedTaskCeilings)が taskId+repo+project 完全一致であれば、
 *   その1件のtaskだけ1回上限を差し替える（全体policyの値は書き換えない）。
 */
export function resolveQueueCostLimits({
  env = process.env,
  taskId,
  project,
  repo,
  requestId,
  reapprovalRequired = false,
  approvalPath = null,
  readJson = null,
} = {}) {
  const path = approvalPath || reviewCostApprovalPath(env);
  // 構文上の絶対上限は本件例外のタスク全体上限(44,000円)。10,000円を超える指定を通してよいかは、
  // 台帳(policy と束縛)を読んだあとに「有効な本件限定の1件」と突合して決める(fail closed)。
  const absoluteCostYen = SCOPED_TASK_CEILING_EXCEPTION.maxPerTaskYen;
  const requestedAttempt = parseQueueCostYen(env.AI_REVIEW_MAX_COST_YEN, 'AI_REVIEW_MAX_COST_YEN', absoluteCostYen);
  const requestedTask = parseQueueCostYen(env.AI_REVIEW_TASK_MAX_COST_YEN, 'AI_REVIEW_TASK_MAX_COST_YEN', absoluteCostYen);

  let ledger;
  try {
    ledger = (readJson || readQueueJson)(path, 'review-queue-cost-approval.json', { maxBytes: REVIEW_COST_APPROVAL_MAX_BYTES });
  } catch (error) {
    return {
      ok: false,
      code: 'approval_file_unreadable',
      approvalPath: path,
      summary: '費用承認台帳を読めませんでした',
      lines: [
        `  台帳      : ${path}`,
        `  読めない理由: ${error.message}`,
        '  この台帳は knowledge 側で管理しています。読み先は環境変数では動きません。',
        '  復旧は次のどちらかです:',
        '    - このパスに台帳を戻す（knowledge のcheckoutが無い・別名になっていないか確認する）',
        `    - 台帳を移設した場合のみ、作業役(review-queue-worker)が読むのと同じ実体を指して`,
        `      AI_DEV_TOOL_ALLOW_COST_APPROVAL_FILE=1 ${COST_APPROVAL_FILE_ENV}=<絶対パス> を付けて再実行する`,
        '    ※ 作業役と違う台帳を指すと、登録は通っても作業役が止めて30分待機に戻ります。',
      ],
    };
  }
  if (ledger?.schemaVersion !== 1 || !ledger.policy || !Array.isArray(ledger.approvals)) {
    return {
      ok: false,
      code: 'approval_file_unreadable',
      approvalPath: path,
      summary: '費用承認台帳の形式が想定と違います',
      lines: [`  台帳      : ${path}`, '  schemaVersion=1 / policy / approvals[] が必要です。'],
    };
  }
  const policy = ledger.policy;
  const approvals = ledger.approvals;
  // 本件例外へ完全束縛された有効な1件があるときだけ、その1件のタスク全体上限(44,000円)まで
  // 構文上限を広げる。identity一致や台帳の自己申告だけでは広げず、無効なら 10,000円 のまま。
  const scopedCeiling = resolveEffectiveCostCeilings(policy, { taskId, project, repo }).scoped;
  const requestCostCap = Math.max(
    MAX_REVIEW_COST_YEN,
    scopedCeiling && Number.isInteger(scopedCeiling.maxPerTaskYen) ? scopedCeiling.maxPerTaskYen : 0,
  );
  if (requestedAttempt > requestCostCap || requestedTask > requestCostCap) {
    // 例外が効かないときは、従来と同じ上限・同じ文言で止める(自動で切り下げない)。
    parseQueueCostYen(env.AI_REVIEW_MAX_COST_YEN, 'AI_REVIEW_MAX_COST_YEN', requestCostCap);
    parseQueueCostYen(env.AI_REVIEW_TASK_MAX_COST_YEN, 'AI_REVIEW_TASK_MAX_COST_YEN', requestCostCap);
  }
  const allowedProjects = Array.isArray(policy.allowedProjects) ? policy.allowedProjects : [];
  if (!allowedProjects.includes(project) && !allowedProjects.includes(repo)) {
    return {
      ok: false,
      code: 'project_not_allowed',
      approvalPath: path,
      summary: 'このprojectは有料レビューの対象に入っていません',
      lines: [
        `  台帳      : ${path}（承認${approvals.length}件）`,
        `  project   : ${project} / repo: ${repo}`,
        `  許可済み  : ${allowedProjects.join(', ') || '(なし)'}`,
        '  追加には人の承認が必要です。親へ戻してください。',
      ],
    };
  }

  const approval = findQueueCostApproval(approvals, {
    taskId,
    project,
    requestId,
    requireRequestId: reapprovalRequired,
    maxPerTaskYenCap: requestCostCap,
  });
  if (!approval) {
    const taskIdMatches = approvals.filter((entry) => entry?.taskId === taskId);
    const sameTaskDifferentProject = taskIdMatches.filter((entry) => entry?.project !== project);
    const similar = similarApprovalTaskIds(approvals, taskId);
    // 再依頼のように同じtaskIdの承認が既にある場合は、その金額をそのまま示す。
    // 例示につられて承認額が上がると、承認の上限を回避したのと同じことになる。
    const priorApproval = taskIdMatches.find((entry) => validCostApprovalEntry(entry, requestCostCap)) || null;
    const defaults = {
      maxPerAttemptYen: requestedAttempt || priorApproval?.maxPerAttemptYen || Math.min(policy.maxPerAttemptYen || 500, MAX_REVIEW_COST_YEN),
      maxPerTaskYen: requestedTask || priorApproval?.maxPerTaskYen || Math.min(policy.maxPerTaskYen || 1000, MAX_REVIEW_COST_YEN),
    };
    const reissueLines = reapprovalRequired
      ? [
          `  再承認が必要: 前の依頼が running/result_staged/published/accepted まで進んでいたため、`,
          `                承認レコードに "requestId": "${requestId}" まで一致することが要ります。`,
          `  taskIdだけ一致する承認: ${taskIdMatches.length}件（再依頼では一致になりません）`,
          '  注意      : --force-new を付けて再実行するとRequest-IDが変わり、足した承認が一致しなくなります。',
        ]
      : [];
    return {
      ok: false,
      code: reapprovalRequired ? 'reapproval_missing' : 'approval_missing',
      approvalPath: path,
      summary: reapprovalRequired
        ? 'この再依頼に一致する費用承認（Request-ID付き）が台帳にありません'
        : 'このtaskIdの費用承認が台帳にありません',
      lines: [
        `  台帳      : ${path}（承認${approvals.length}件 / taskId一致 ${taskIdMatches.length}件）`,
        `  taskId    : ${taskId}`,
        `  project   : ${project}`,
        ...(requestId ? [`  Request-ID: ${requestId}`] : []),
        ...reissueLines,
        ...(sameTaskDifferentProject.length > 0
          ? [`  注意      : 同じtaskIdでprojectが違う承認が${sameTaskDifferentProject.length}件あります（project=${[...new Set(sameTaskDifferentProject.map((entry) => entry.project))].join(', ')}）`]
          : []),
        ...(similar.length > 0
          ? ['  似た名前の承認（完全一致でないため無効）:', ...similar.map((name) => `    - ${name}`)]
          : []),
        '  approvals 配列の末尾へ、この形の承認を1件足してcommitしてください:',
        ...approvalRecordSample({
          taskId,
          project,
          requestId: reapprovalRequired ? requestId : null,
          ...defaults,
        }),
        `  policy上限: 1回 ${policy.maxPerAttemptYen}円 / タスク全体 ${policy.maxPerTaskYen}円 / 日次 ${policy.dailyLimitYen}円`,
      ],
    };
  }

  const maxPerAttempt = requestedAttempt || approval.maxPerAttemptYen;
  const maxPerTask = requestedTask || approval.maxPerTaskYen;
  const source = {
    maxPerAttempt: requestedAttempt ? 'env' : 'approval',
    maxPerTask: requestedTask ? 'env' : 'approval',
  };
  // 0円のまま登録される経路は、承認レコードが見つからない時点（approval_missing）で止めている。
  // ここへ来る時点で承認は validCostApprovalEntry を通っており両金額とも1円以上、環境変数が
  // 未指定なら承認値へ落ちるため、maxPerAttempt / maxPerTask が0になることはない。
  // この依頼にだけ効く上限。本件限定の登録があればその額、無ければ従来のpolicy値。
  // 判定式は作業役(review-queue-worker.requestCostDecision)と共有する。
  const ceilings = resolveEffectiveCostCeilings(policy, { taskId, project, repo });
  const policyAttemptCeiling = ceilings.maxPerAttemptYen;
  const policyTaskCeiling = ceilings.maxPerTaskYen;
  const overApproval = [];
  const overPolicy = [];
  if (maxPerAttempt > approval.maxPerAttemptYen) {
    overApproval.push(`  1回の上限   : 指定 ${maxPerAttempt}円 > 承認 ${approval.maxPerAttemptYen}円`);
  }
  if (maxPerTask > approval.maxPerTaskYen) {
    overApproval.push(`  タスク全体  : 指定 ${maxPerTask}円 > 承認 ${approval.maxPerTaskYen}円`);
  }
  if (Number.isInteger(policyAttemptCeiling) && maxPerAttempt > policyAttemptCeiling) {
    overPolicy.push(`  1回の上限   : 指定 ${maxPerAttempt}円 > policy ${policyAttemptCeiling}円`
      + `${ceilings.scoped ? '(本件限定の承認)' : ''}`);
  }
  if (Number.isInteger(policyTaskCeiling) && maxPerTask > policyTaskCeiling) {
    overPolicy.push(`  タスク全体  : 指定 ${maxPerTask}円 > policy ${policyTaskCeiling}円`
      + `${ceilings.scoped ? '(本件限定の承認)' : ''}`);
  }
  if (overApproval.length > 0 || overPolicy.length > 0) {
    // 承認レコード自身がpolicyを超えている場合、環境変数を外しても同じ額になるので解決しない。
    const approvalOverPolicy =
      (Number.isInteger(policyAttemptCeiling) && approval.maxPerAttemptYen > policyAttemptCeiling)
      || (Number.isInteger(policyTaskCeiling) && approval.maxPerTaskYen > policyTaskCeiling);
    const envUsed = source.maxPerAttempt === 'env' || source.maxPerTask === 'env';
    return {
      ok: false,
      code: 'over_approved_limit',
      approvalPath: path,
      approval,
      summary: approvalOverPolicy
        ? '台帳の承認額がpolicyの上限を超えています'
        : '指定した費用枠が承認済みの上限を超えています',
      lines: [
        `  台帳      : ${path}`,
        `  承認済み  : 1回 ${approval.maxPerAttemptYen}円 / タスク全体 ${approval.maxPerTaskYen}円（approvedBy=${approval.approvedBy}）`,
        ...overApproval,
        ...overPolicy,
        ...(ceilings.scopedEntryInvalid
          ? ['  本件限定上限: policy.scopedTaskCeilings の記載が不正です(必須項目の欠落・改ざん)。全体policyの上限で判定しました']
          : []),
        '  自動では切り下げません。対応は次のとおりです:',
        ...(approvalOverPolicy
          ? [
              '    - policy側の上限を人の承認で引き上げるか、承認額をpolicyの範囲へ是正する',
              '    - 承認額そのものが超えているため、環境変数を外しても解決しません',
            ]
          : [
              ...(envUsed ? ['    - 環境変数を外す（台帳の承認値がそのまま既定になります）'] : []),
              '    - 増額が必要なら、人の承認を得て台帳の該当承認を更新する',
            ]),
      ],
    };
  }
  if (maxPerAttempt > maxPerTask) {
    return {
      ok: false,
      code: 'attempt_over_task',
      approvalPath: path,
      approval,
      summary: 'AI_REVIEW_MAX_COST_YENはタスク全体の上限以下にしてください',
      lines: [`  1回 ${maxPerAttempt}円 > タスク全体 ${maxPerTask}円`],
    };
  }
  return { ok: true, maxPerAttempt, maxPerTask, source, approval, approvalPath: path, approvalCount: approvals.length };
}

export function redactReviewText(value) {
  return String(value || '')
    .replace(/:\/\/[^\s/@:]+(?::[^\s/@]*)?@/gu, '://[REDACTED]@')
    .replace(/-----BEGIN [^-\r\n]*(?:PRIVATE KEY|CERTIFICATE)[\s\S]*?-----END [^-\r\n]*(?:PRIVATE KEY|CERTIFICATE)-----/giu, '[REDACTED_PEM]')
    .replace(/\b(Proxy-Authorization|Authorization)\s*:\s*[^\r\n]*/giu, '$1: [REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED_JWT]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, '[REDACTED_AWS_KEY]')
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/gu, '[REDACTED_GOOGLE_API_KEY]')
    .replace(
      /(["'`]?\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|secret(?:[_-]?key)?|client[_-]?secret|private[_-]?key|cookie|database[_-]?url|connection[_-]?string|aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token)|e[_-]?mail|phone|telephone|mobile|postal[_-]?address|street[_-]?address|home[_-]?address|address)\b["'`]?\s*[:=]\s*)(["'`])([^"'`\r\n]{1,500})\2/giu,
      (_match, prefix, quote) => `${prefix}${quote}[REDACTED]${quote}`,
    )
    .replace(
      /(["'`]?\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|secret(?:[_-]?key)?|client[_-]?secret|private[_-]?key|cookie|database[_-]?url|connection[_-]?string|aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token)|e[_-]?mail|phone|telephone|mobile|postal[_-]?address|street[_-]?address|home[_-]?address|address)\b["'`]?\s*[:=]\s*)(["'`]?)([^\s,;"'`}]{4,})\2/giu,
      (_match, prefix, quote) => `${prefix}${quote}[REDACTED]${quote}`,
    )
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gu, '[REDACTED_TOKEN]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[REDACTED_EMAIL]')
    .replace(/(?<![\w.])\+?[0-9][0-9 ()-]{8,}[0-9](?![\w.])/gu, (match) => {
      if (/^\d{4}-\d{2}-\d{2}\s+\d{2}$/u.test(match)) return match;
      const digits = match.replace(/\D/gu, '').length;
      return digits >= 10 && digits <= 15 ? '[REDACTED_PHONE]' : match;
    });
}

const REVIEW_JSON_INTEGRITY_KEYS = new Set([
  'requestId',
  'reissueOf',
  'taskId',
  'taskFingerprint',
  'inputHash',
  'head',
  'sha256',
  'restoredHash',
  'ownerToken',
  // 2026-09-29 (CMGB native focused CALLER): the focused target hash is an integrity value of the
  // official request. It must survive redactReviewJson/maskReviewedJsonFields exactly, otherwise a
  // mangled digest would fail the acceptance re-computation for a reason unrelated to the code.
  'nativeFocusedTargetsHash',
]);

export function redactReviewJson(value, label = 'JSON') {
  const redactValue = (current, key = '') => {
    if (Array.isArray(current)) return current.map((item) => redactValue(item));
    if (current && typeof current === 'object') {
      return Object.fromEntries(Object.entries(current).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey),
      ]));
    }
    if (typeof current !== 'string') return current;
    if (REVIEW_JSON_INTEGRITY_KEYS.has(key)) return current;
    if (key === 'path') return isSecretPath(current) ? '[REDACTED_PATH]' : current;
    return redactReviewText(current);
  };
  try {
    return redactValue(structuredClone(value));
  } catch (error) {
    throw new Error(`${label}を伏せ字済みJSONへ変換できません: ${error.message}`);
  }
}

function maskReviewedJsonFields(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => maskReviewedJsonFields(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      maskReviewedJsonFields(childValue, childKey),
    ]));
  }
  if (typeof value === 'string' && (REVIEW_JSON_INTEGRITY_KEYS.has(key) || key === 'path')) {
    return '[STRUCTURALLY_CHECKED]';
  }
  return value;
}

/**
 * UTF-8として解釈できないバイトが混じっていないかを、生バイトのまま判定する。
 *
 * 置換文字(U+FFFD)が文字列に現れる経路は2つある。
 *   1. 元の内容にもともと U+FFFD が書いてある(例: 表示用に使う配布helperのソース)
 *   2. UTF-8でないバイト列をUTF-8として読んだため、壊れた部分が U+FFFD へ潰された
 * 伏せ字の判定が信用できなくなるのは2だけで、このとき元の文字列は変形しているので
 * メールアドレスや電話番号を取り逃がしうる。文字列になった後では1と2を区別できないため、
 * バイトが手元にある入口(git出力・未追跡ファイルの読み取り)でこの関数を通す。
 */
export function isLossyUtf8Decode(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return !Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer);
}

export function decodeReviewBytes(bytes, label = '入力') {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (isLossyUtf8Decode(buffer)) {
    throw new Error(`${label}にUTF-8として読めないバイトがあります。伏せ字の判定を保証できないため中止します`);
  }
  return buffer.toString('utf8');
}

export function detectSensitiveReviewText(value, { label = '' } = {}) {
  if (typeof value !== 'string') return { status: 'unknown', reason: 'text以外の形式' };
  // NUL はテキストとして扱えない(伏せ字規則も行単位の判定も成立しない)ので、従来どおり形式不明にする。
  if (value.includes('\u0000')) {
    return { status: 'unknown', reason: '安全に解釈できない文字形式' };
  }
  // U+FFFD は文字化けの痕跡のこともあれば、ソースに書かれた普通の文字のこともある。
  // 以前はこの1文字があるだけで形式不明にしていたため、表示用に U+FFFD を持つ配布helper
  // (ai-complete.mjs の displayUncommittedPath)が差分に入るだけで登録できなくなった。
  // 本当に危険な「UTF-8として読めないバイト」は decodeReviewBytes が入口で止めるので、
  // ここでは登録を止めず、人が気づけるように警告だけ残す。
  const replacementCharWarnings = value.includes('\uFFFD')
    ? [`${label || '入力'}に置換文字(U+FFFD)が含まれます。元が文字化けしていた場合は伏せ字の判定が不完全になりえます`]
    : [];
  if (/\bhf_[0-9A-Za-z]{30,}\b/gu.test(value)) {
    return { status: 'sensitive', reason: '伏せ字規則に無いHugging Face tokenらしい値' };
  }
  let scanValue = value;
  if (['request.json', 'manifest.json', 'mutation-evidence.json'].includes(label)) {
    try {
      scanValue = JSON.stringify(maskReviewedJsonFields(JSON.parse(value)));
    } catch (error) {
      return { status: 'unknown', reason: `${label}をJSONとして安全に解釈できません: ${error.message}` };
    }
  }
  return redactReviewText(scanValue) === scanValue
    ? { status: 'safe', warnings: replacementCharWarnings }
    : { status: 'sensitive', reason: '伏せ字になっていない秘密・個人情報らしい値' };
}

export function validateReviewQueueBundleSafety({
  request,
  requestMarkdown,
  diffPatch,
  manifest,
  mutationEvidence = null,
  detector = detectSensitiveReviewText,
  maxBytes = MAX_REVIEW_SAFETY_SCAN_BYTES,
}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('個人情報検知の読み取り上限が不正です');
  }
  const artifacts = [
    ['request.json', `${JSON.stringify(request, null, 2)}\n`],
    ['request.md', requestMarkdown],
    ['diff.patch', diffPatch],
    ['manifest.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ...(mutationEvidence ? [['mutation-evidence.json', `${JSON.stringify(mutationEvidence, null, 2)}\n`]] : []),
  ];
  const warnings = [];
  for (const [label, value] of artifacts) {
    if (typeof value !== 'string') {
      throw new Error(`${label}は個人情報検知で扱えない形式です`);
    }
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > maxBytes) {
      throw new Error(`${label}が個人情報検知の上限${maxBytes}バイトを超えています`);
    }
    let result;
    try {
      result = detector(value, { label, bytes });
    } catch (error) {
      throw new Error(`${label}の個人情報を検知できないため登録を中止します: ${error.message}`);
    }
    if (!result || result.status === 'unknown') {
      throw new Error(`${label}は個人情報検知で形式不明となり、安全を確認できないため登録を中止します`);
    }
    if (result.status === 'sensitive') {
      throw new Error(`${label}に伏せ字になっていない秘密・個人情報らしい値があります（${result.reason || '形式不明'}）`);
    }
    if (result.status !== 'safe') {
      throw new Error(`${label}の個人情報検知結果が不明な形式です`);
    }
    // safeだが人が見ておきたい事柄(例: 置換文字の混入)は、止めずに呼び出し側へ返す。
    if (Array.isArray(result.warnings)) warnings.push(...result.warnings.map(String));
  }
  return { warnings };
}

export function isSecretPath(path) {
  const normalized = String(path || '').replaceAll('\\', '/').toLowerCase();
  const parts = normalized.split('/');
  const name = parts.at(-1) || '';
  const hasPersonalValue = parts.some((part) => {
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(part)) return true;
    const phoneLike = part.match(/\+?[0-9][0-9 ()-]{8,}[0-9]/gu) || [];
    return phoneLike.some((value) => {
      const digits = value.replace(/\D/gu, '').length;
      const separators = value.match(/[- ()]/gu) || [];
      const namedAsPhone = /(?:^|[._-])(?:phone|tel|telephone|mobile)(?:[._-]|$)/iu.test(part);
      const singleHyphenPhone = /^\+?\d{2,4}-\d{6,8}$/u.test(value);
      return digits >= 10 && digits <= 15 && (
        value.startsWith('+') || separators.length >= 2 || namedAsPhone || singleHyphenPhone
      );
    });
  });
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  const numericStem = /^\d{10,15}$/u.test(stem) ? Number(stem) : null;
  const isCompactDateTime = /^20\d{12}$/u.test(stem);
  const isUnixSeconds = stem.length === 10 && numericStem >= 946684800 && numericStem <= 4102444800;
  const isUnixMilliseconds = stem.length === 13 && numericStem >= 946684800000 && numericStem <= 4102444800000;
  const isBarePhoneName = numericStem !== null && !isCompactDateTime && !isUnixSeconds && !isUnixMilliseconds;
  const hasCredentialValue = parts.some((part) => (
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/iu.test(part) ||
    /\bAIza[0-9A-Za-z_-]{35}\b/iu.test(part) ||
    /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/iu.test(part) ||
    /\bhf_[0-9A-Za-z]{30,}\b/u.test(part)
  ));
  return (
    parts.some((part) => part === '.env' || part.startsWith('.env.')) ||
    name.endsWith('.env') ||
    /^\.?(?:npmrc|netrc|pgpass|git-credentials)$/u.test(name) ||
    parts.some((part) => /(?:^|[._-])(?:credentials?|tokens?|cookies?|secrets?|passwords?|passwds?|api[._-]?keys?|private[._-]?keys?)(?:[._-]|$)/u.test(part)) ||
    parts.some((part) => /^(?:pii|personal(?:ly)?[._-]?(?:data|info(?:rmation)?)|customer[._-]?data|contacts?|address[._-]?book)(?:\.[^.]+)?$/u.test(part)) ||
    hasPersonalValue ||
    hasCredentialValue ||
    isBarePhoneName ||
    /\.(?:pem|key|p12|pfx)$/u.test(name) ||
    /^(?:id_rsa|id_ed25519)/u.test(name)
  );
}

export function acquireQueueLeaseClaimLock(entryDir, workerId) {
  ensureSafeDirectory(entryDir);
  if (!IDENTIFIER_PATTERN.test(String(workerId || ''))) throw new Error('worker IDの文字種・長さが不正です');
  const lockDir = join(entryDir, '.lease-claim');
  if (existsSync(join(entryDir, '.lease-claim-recovery'))) return { acquired: false, token: null };
  try {
    mkdirSync(lockDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') return { acquired: false, token: null };
    throw error;
  }
  const token = randomUUID();
  try {
    const identity = queueClaimProcessIdentity(process.pid);
    atomicWriteJson(join(lockDir, 'owner.json'), {
      schemaVersion: 1,
      workerId,
      token,
      pid: process.pid,
      host: identity.host,
      bootId: identity.bootId,
      processStartTicks: identity.processStartTicks,
      acquiredAt: new Date().toISOString(),
    });
    if (existsSync(join(entryDir, '.lease-claim-recovery'))) {
      rmSync(lockDir, { recursive: true, force: true });
      return { acquired: false, token: null };
    }
    return { acquired: true, token };
  } catch (error) {
    rmSync(lockDir, { recursive: true, force: true });
    throw error;
  }
}

function linuxBootId() {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function linuxProcessStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fieldsAfterComm = stat.slice(close + 2).trim().split(/\s+/u);
    const value = fieldsAfterComm[19];
    return /^\d+$/u.test(String(value || '')) ? value : null;
  } catch {
    return null;
  }
}

export function queueClaimProcessIdentity(pid = process.pid) {
  return {
    host: hostname(),
    bootId: linuxBootId(),
    processStartTicks: linuxProcessStartTicks(pid),
  };
}

function processIsAlive(owner) {
  const pid = owner?.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const currentIdentity = queueClaimProcessIdentity(pid);
  if (!owner.host || owner.host !== currentIdentity.host) return null;
  if (owner.bootId && currentIdentity.bootId && owner.bootId !== currentIdentity.bootId) return false;
  try {
    process.kill(pid, 0);
    if (
      owner.processStartTicks &&
      currentIdentity.processStartTicks &&
      owner.processStartTicks !== currentIdentity.processStartTicks
    ) return false;
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return null;
  }
}

function staleQueueLockReason(owner, minimumAgeMs) {
  const acquiredAt = Date.parse(String(owner?.acquiredAt || ''));
  if (!Number.isFinite(acquiredAt)) return { stale: false, reason: 'lock取得時刻が不正' };
  const ageMs = Date.now() - acquiredAt;
  const alive = processIsAlive(owner);
  if (alive === true) return { stale: false, reason: 'lock所有処理が稼働中' };
  if (alive === null) return { stale: false, reason: 'lock所有処理の生存確認不能' };
  if (ageMs >= 0 && ageMs < minimumAgeMs) {
    return { stale: false, reason: 'lockが復旧可能な経過時間に達していない' };
  }
  return { stale: true, reason: ageMs < 0 ? '未来時刻だが所有処理は停止' : '所有処理が停止し待ち時間経過' };
}

function acquireQueueRecoveryLock(entryDir, minimumAgeMs) {
  const recoveryDir = join(entryDir, '.lease-claim-recovery');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let created = false;
    try {
      mkdirSync(recoveryDir, { mode: 0o700 });
      created = true;
      const token = randomUUID();
      const identity = queueClaimProcessIdentity(process.pid);
      atomicWriteJson(join(recoveryDir, 'owner.json'), {
        schemaVersion: 1,
        workerId: `recovery-${process.pid}`,
        token,
        pid: process.pid,
        host: identity.host,
        bootId: identity.bootId,
        processStartTicks: identity.processStartTicks,
        acquiredAt: new Date().toISOString(),
      });
      return { acquired: true, token, recoveryDir };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        if (created && existsSync(recoveryDir)) rmSync(recoveryDir, { recursive: true, force: true });
        throw error;
      }
      let owner;
      try {
        owner = readQueueJson(join(recoveryDir, 'owner.json'), 'lease claim recovery owner.json');
      } catch {
        const info = statSync(recoveryDir);
        if (Date.now() - info.mtimeMs < minimumAgeMs) {
          return { acquired: false, reason: '復旧用lockの所有情報を準備中' };
        }
        owner = null;
      }
      const decision = owner
        ? staleQueueLockReason(owner, minimumAgeMs)
        : { stale: true, reason: '所有情報なしで待ち時間経過' };
      if (!decision.stale) return { acquired: false, reason: `復旧用${decision.reason}` };
      try {
        renameSync(recoveryDir, join(entryDir, `.lease-claim-recovery-stale-${Date.now()}-${randomUUID()}`));
      } catch (renameError) {
        if (renameError?.code !== 'ENOENT') return { acquired: false, reason: `復旧用lockを監査退避できない: ${renameError.message}` };
      }
    }
  }
  return { acquired: false, reason: '復旧用lockを再取得できない' };
}

export function recoverStaleQueueLeaseClaimLock(entryDir, { minimumAgeMs = 60_000, acceptorOnly = false } = {}) {
  ensureSafeDirectory(entryDir);
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0) throw new Error('claim lockの復旧待ち時間が不正です');
  const lockDir = join(entryDir, '.lease-claim');
  if (!existsSync(lockDir)) return { recovered: false, reason: 'claim lockなし' };
  const recovery = acquireQueueRecoveryLock(entryDir, minimumAgeMs);
  if (!recovery.acquired) return { recovered: false, reason: recovery.reason };
  try {
    if (!existsSync(lockDir)) return { recovered: false, reason: 'claim lockは解放済み' };
    const owner = readQueueJson(join(lockDir, 'owner.json'), 'lease claim owner.json');
    if (acceptorOnly && !String(owner.workerId || '').startsWith('acceptor-')) {
      return { recovered: false, reason: '受領処理以外のclaim lock' };
    }
    const decision = staleQueueLockReason(owner, minimumAgeMs);
    if (!decision.stale) return { recovered: false, reason: `claim ${decision.reason}` };
    const confirmed = readQueueJson(join(lockDir, 'owner.json'), 'lease claim owner.json');
    if (confirmed.token !== owner.token || confirmed.pid !== owner.pid || confirmed.workerId !== owner.workerId) {
      return { recovered: false, reason: 'claim lock所有者が確認中に変化' };
    }
    const auditDir = join(entryDir, `.lease-claim-stale-${Date.now()}-${randomUUID()}`);
    renameSync(lockDir, auditDir);
    return { recovered: true, auditDir, staleOwner: owner };
  } finally {
    try {
      const owner = readQueueJson(join(recovery.recoveryDir, 'owner.json'), 'lease claim recovery owner.json');
      if (owner.token === recovery.token) rmSync(recovery.recoveryDir, { recursive: true, force: false });
    } catch (error) {
      try {
        if (existsSync(recovery.recoveryDir)) rmSync(recovery.recoveryDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error(`REVIEW_PROCESS_WARNING: claim lock復旧用lockの解放を確認できません: ${cleanupError.message}`);
      }
    }
  }
}

export function releaseQueueLeaseClaimLock(entryDir, token) {
  const lockDir = join(entryDir, '.lease-claim');
  ensureSafeDirectory(lockDir);
  const owner = readQueueJson(join(lockDir, 'owner.json'), 'lease claim owner.json');
  if (!token || owner.token !== token) throw new Error('lease claim lockの所有者が一致しません');
  rmSync(lockDir, { recursive: true, force: false });
}

function requestHashMaterial(request) {
  const { inputHash: _inputHash, createdAt: _createdAt, ...immutableRequest } = request || {};
  return Buffer.from(JSON.stringify(immutableRequest));
}

function manifestHashMaterial(manifest) {
  const { generatedAt: _generatedAt, ...immutableManifest } = manifest || {};
  return Buffer.from(JSON.stringify(immutableManifest));
}

function calculateQueueInputHashFromValues({ request, requestMarkdown, diffPatch, manifest, mutationEvidence = null }) {
  const parts = [
    Buffer.from(`${request.promptVersion}\0request.md\0`),
    Buffer.from(requestMarkdown),
    Buffer.from('\0diff.patch\0'),
    Buffer.from(diffPatch),
    Buffer.from('\0manifest.json\0'),
    manifestHashMaterial(manifest),
    Buffer.from('\0request.json-without-inputHash\0'),
    requestHashMaterial(request),
  ];
  if (mutationEvidence) {
    parts.push(Buffer.from('\0mutation-evidence.json\0'), Buffer.from(`${JSON.stringify(mutationEvidence, null, 2)}\n`));
  }
  return sha256(Buffer.concat(parts));
}

export function captureConsistentQueueSnapshot({ capture, materialize, expectedSnapshot = null }) {
  if (typeof capture !== 'function' || typeof materialize !== 'function') {
    throw new Error('queue snapshotの取得処理が不正です');
  }
  const before = capture();
  if (expectedSnapshot !== null && JSON.stringify(before) !== JSON.stringify(expectedSnapshot)) {
    throw new Error('プレビュー後に変更ファイル一覧・size・shaが変わったためqueue登録を中止します');
  }
  const fixedSnapshot = expectedSnapshot === null ? before : expectedSnapshot;
  const materialized = materialize(fixedSnapshot);
  const after = capture();
  if (JSON.stringify(fixedSnapshot) !== JSON.stringify(after)) {
    throw new Error('diff.patchとmanifest.jsonの取得中に変更があり、同じ時点の入力として固定できません');
  }
  return { ...materialized, snapshot: fixedSnapshot };
}

export function calculateQueueInputHash(entryDir, promptVersion = REVIEW_QUEUE_PROMPT_VERSION, request = null) {
  const queuedRequest = request || readQueueJson(join(entryDir, 'request.json'), 'request.json');
  const requestMarkdown = readFileSync(join(entryDir, 'request.md'));
  const diffPatch = readFileSync(join(entryDir, 'diff.patch'));
  const manifest = readQueueJson(join(entryDir, 'manifest.json'), 'manifest.json');
  const parts = [
    Buffer.from(`${promptVersion}\0request.md\0`),
    requestMarkdown,
    Buffer.from('\0diff.patch\0'),
    diffPatch,
    Buffer.from('\0manifest.json\0'),
    manifestHashMaterial(manifest),
    Buffer.from('\0request.json-without-inputHash\0'),
    requestHashMaterial(queuedRequest),
  ];
  const mutationPath = join(entryDir, 'mutation-evidence.json');
  if (existsSync(mutationPath)) {
    ensureSafeFile(mutationPath, 'mutation-evidence.json');
    parts.push(Buffer.from('\0mutation-evidence.json\0'), readFileSync(mutationPath));
  }
  return sha256(Buffer.concat(parts));
}

export function assertQueueCapacity(root, requestId, limit = MAX_REVIEW_QUEUE_ENTRIES) {
  if (existsSync(join(root, requestId))) return;
  const occupied = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && IDENTIFIER_PATTERN.test(entry.name))
    .length;
  if (occupied >= limit) {
    throw new Error(`review queueが上限${limit}件に達しています。accepted済みentryを監査記録つきで整理してから再実行してください`);
  }
}

import { consumeDispatchTicket, assertQueueTicketReuse } from './ai-review-cycle-lib.mjs';
export function registerQueueEntry(options) {
  const root = reviewQueueRoot();
  ensureSafeDirectory(root, { create: true });
  const id = options?.request?.requestId;
  if (!IDENTIFIER_PATTERN.test(String(id || ''))) throw new Error('Request-IDが不正です');
  const lock = join(root, `.registration-${id}.lock`);
  const deadline = Date.now() + 5000;
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return registerQueueEntryLocked(options); }
  finally { rmSync(lock, { recursive: true }); }
}
function registerQueueEntryLocked({
  request,
  requestMarkdown,
  diffPatch,
  manifest,
  mutationEvidence = null,
  sensitiveContentDetector = detectSensitiveReviewText,
  safetyScanMaxBytes = MAX_REVIEW_SAFETY_SCAN_BYTES,
}) {
  const sourceRoot = request?.reviewCycle?.root || request?.repoRoot || manifest?.root || process.cwd();
  if (!request?.reviewCycle?.ticketId) {
    throw new Error('reviewCycle ticket required for queue registration');
  }
  const ticketAction = {
    ticketId: request.reviewCycle.ticketId,
    taskId: request.taskId || request.reviewCycle.taskId,
    stage: 'queue',
    step: request.reviewCycle.step,
    cycle: request.reviewCycle.cycle,
    candidateHash: request.reviewCycle.candidateHash || request.candidateHash,
    requestId: request.reviewCycle.requestId || request.requestId,
    model: request.reviewCycle.model,
    effort: request.reviewCycle.effort,
    purposeId: request.reviewCycle.purposeId,
  };
  if (request.reviewCycle.requestId !== request.requestId) throw new Error('REVIEW_CYCLE_TICKET_REQUESTID_MISMATCH');
  for (const key of ['taskId','purposeId','step','cycle','candidateHash','requestId','model','effort']) {
    if (ticketAction[key] === undefined || ticketAction[key] === '') throw new Error('REVIEW_CYCLE_QUEUE_IDS_REQUIRED');
  }
  const root = reviewQueueRoot();
  ensureSafeDirectory(root, { create: true });
  if (Object.hasOwn(request || {}, 'reissueOf') && !IDENTIFIER_PATTERN.test(String(request.reissueOf || ''))) {
    throw new Error('reissueOfの文字種・長さが不正です');
  }
  const safeRequest = redactReviewJson(request, 'request.json');
  const safeRequestMarkdown = redactReviewText(requestMarkdown);
  const safeDiffPatch = redactReviewText(diffPatch);
  const safeManifest = redactReviewJson(manifest, 'manifest.json');
  const safeMutationEvidence = mutationEvidence
    ? redactReviewJson(mutationEvidence, 'mutation-evidence.json')
    : null;
  const safety = validateReviewQueueBundleSafety({
    request: safeRequest,
    requestMarkdown: safeRequestMarkdown,
    diffPatch: safeDiffPatch,
    manifest: safeManifest,
    mutationEvidence: safeMutationEvidence,
    detector: sensitiveContentDetector,
    maxBytes: safetyScanMaxBytes,
  });
  // 止めるほどではないが人が見ておきたい事柄は、登録を続けたうえで必ず表に出す。
  for (const warning of safety?.warnings ?? []) {
    console.error(`REVIEW_QUEUE_SAFETY_WARNING: ${warning}`);
  }
  // deepseek-native-cli-v1はfail-closed。上位の連鎖マーカーと有効なpin、そしてqueue manifestの
  // 分類和集合が完全一致することを登録時に確認する。pinの無いnative依頼を旧方式として素通りさせない。
  assertNativeRequestPin(safeRequest, { manifestFiles: Array.isArray(safeManifest?.files) ? safeManifest.files : null });
  const finalDir = queueEntryPath(safeRequest.requestId);
  const candidateInputHash = calculateQueueInputHashFromValues({
    request: safeRequest,
    requestMarkdown: safeRequestMarkdown,
    diffPatch: safeDiffPatch,
    manifest: safeManifest,
    mutationEvidence: safeMutationEvidence,
  });
  if (safeRequest.inputHash && safeRequest.inputHash !== candidateInputHash) {
    throw new Error('登録予定のinputHashが一致しません');
  }
  assertQueueCapacity(root, safeRequest.requestId);
  if (existsSync(finalDir)) {
    ensureSafeDirectory(finalDir);
    const resetPath = join(finalDir, 'reset.json');
    if (existsSync(resetPath)) {
      const reset = readQueueJson(resetPath, 'reset.json');
      if (reset.requestId !== safeRequest.requestId || reset.status !== 'reset') {
        throw new Error('既存queueのreset.jsonが不正なため再利用しません');
      }
      throw new Error('同じRequest-IDのqueueはreset済みです。--force-newで新しい依頼を発行してください');
    }
    const previous = readQueueJson(join(finalDir, 'request.json'), 'request.json');
    const actualInputHash = calculateQueueInputHash(finalDir, previous.promptVersion);
    if (previous.inputHash !== actualInputHash || previous.inputHash !== candidateInputHash) {
      throw new Error('同じRequest-IDのqueue内容が異なります。上書きしません');
    }
    assertQueueTicketReuse(sourceRoot, { ...ticketAction, queueInputHash: actualInputHash });
    return { entryDir: finalDir, duplicate: true, inputHash: actualInputHash };
  }

  consumeDispatchTicket(sourceRoot, { ...ticketAction, queueInputHash: candidateInputHash });
  const temporary = join(root, `.tmp-${safeRequest.requestId}-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    atomicWriteFile(join(temporary, 'request.md'), safeRequestMarkdown);
    atomicWriteFile(join(temporary, 'diff.patch'), safeDiffPatch);
    atomicWriteJson(join(temporary, 'manifest.json'), safeManifest);
    if (safeMutationEvidence) atomicWriteJson(join(temporary, 'mutation-evidence.json'), safeMutationEvidence);
    const inputHash = calculateQueueInputHash(temporary, safeRequest.promptVersion, safeRequest);
    if (inputHash !== candidateInputHash) {
      throw new Error('登録直前のinputHashが一致しません');
    }
    const finalizedRequest = { ...safeRequest, inputHash };
    atomicWriteJson(join(temporary, 'request.json'), finalizedRequest);
    atomicWriteJson(join(temporary, 'state.json'), {
      schemaVersion: REVIEW_QUEUE_SCHEMA_VERSION,
      requestId: safeRequest.requestId,
      status: 'pending',
      attempt: 0,
      createdAt: safeRequest.createdAt,
      updatedAt: safeRequest.createdAt,
    });
    renameSync(temporary, finalDir);
    return { entryDir: finalDir, duplicate: false, inputHash };
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    if (existsSync(finalDir)) {
      ensureSafeDirectory(finalDir);
      const previous = readQueueJson(join(finalDir, 'request.json'), 'request.json');
      const actualInputHash = calculateQueueInputHash(finalDir, previous.promptVersion);
      if (previous.inputHash === actualInputHash && actualInputHash === candidateInputHash) {
        assertQueueTicketReuse(sourceRoot, { ...ticketAction, queueInputHash: actualInputHash });
        return { entryDir: finalDir, duplicate: true, inputHash: actualInputHash };
      }
    }
    throw error;
  }
}

export function markQueueRequestReset(requestId, { expectedEntry = null, guardedReset = null } = {}) {
  const entryDir = queueEntryPath(requestId);
  if (expectedEntry !== null && (typeof expectedEntry !== 'string' || resolve(expectedEntry) !== entryDir)) {
    throw new Error('送信時とreset時のqueue保存先が一致しません。送信時と同じ保存先設定で再実行してください');
  }
  if (!existsSync(entryDir)) {
    throw new Error('reset対象のqueue依頼が現在の保存先にありません。送信時と同じ保存先設定で再実行してください');
  }
  ensureSafeDirectory(entryDir);
  const claim = acquireQueueLeaseClaimLock(entryDir, `resetter-${process.pid}`);
  if (!claim.acquired) {
    throw new Error('旧queue依頼を別の作業役が更新中です。しばらく待ってresetを再実行してください');
  }
  try {
    const writeReset = () => {
      const resetAt = new Date().toISOString();
      atomicWriteJson(join(entryDir, 'reset.json'), {
        schemaVersion: REVIEW_QUEUE_SCHEMA_VERSION,
        requestId,
        status: 'reset',
        resetAt,
      });
      return { marked: true, entryDir, resetAt };
    };
    if (guardedReset !== null) {
      if (typeof guardedReset !== 'function') {
        throw new Error('reset guarded callback is not a function');
      }
      const guarded = guardedReset({ requestId, entryDir, writeReset });
      if (guarded && (guarded.marked === true || guarded.marked === false)) return guarded;
    }
    return writeReset();
  } finally {
    releaseQueueLeaseClaimLock(entryDir, claim.token);
  }
}

export function readQueueJson(path, label = basename(path), { maxBytes = null } = {}) {
  const info = ensureSafeFile(path, label);
  if (Number.isFinite(maxBytes) && info.size > maxBytes) throw new Error(`${label}が上限${maxBytes}バイトを超えています`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label}をJSONとして読めません: ${error.message}`);
  }
}

export function requestedQueueCodexRuntime(request) {
  const runtime = request?.runtime?.cli ?? request?.reviewer?.cli;
  if (runtime === undefined || runtime === null) return null;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime) ||
      typeof runtime.command !== 'string' || !runtime.command.trim() ||
      !Array.isArray(runtime.args) || runtime.args.some((arg) => typeof arg !== 'string' || !arg)) {
    throw new Error('REVIEWER_RUNTIME_MISMATCH: reviewer runtime.cli must contain command and string args');
  }
  const command = runtime.command.trim();
  if (command !== 'codex') {
    throw new Error(`REVIEWER_RUNTIME_MISMATCH: unsupported reviewer runtime command ${String(command).slice(0, 120)}`);
  }
  const args = [...runtime.args];
  if (args[0] !== 'exec') {
    throw new Error('REVIEWER_RUNTIME_MISMATCH: reviewer runtime must start with codex exec');
  }
  let model = '';
  let effort = '';
  let sandbox = '';
  const assignUnique = (name, current, value) => {
    if (!value || (current && current !== value)) {
      throw new Error(`REVIEWER_RUNTIME_MISMATCH: reviewer runtime has an invalid ${name}`);
    }
    return value;
  };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-m' || arg === '--model') {
      model = assignUnique('model', model, args[++index]);
    } else if (arg.startsWith('--model=')) {
      model = assignUnique('model', model, arg.slice('--model='.length));
    } else if (arg === '-s' || arg === '--sandbox') {
      sandbox = assignUnique('sandbox', sandbox, args[++index]);
    } else if (arg.startsWith('--sandbox=')) {
      sandbox = assignUnique('sandbox', sandbox, arg.slice('--sandbox='.length));
    } else if (arg === '-c' || arg === '--config') {
      const config = args[++index];
      const match = /^model_reasoning_effort=(?:"([^"]+)"|'([^']+)'|([^'"\s]+))$/u.exec(config || '');
      if (!match) throw new Error('REVIEWER_RUNTIME_MISMATCH: reviewer runtime has an unsupported config');
      effort = assignUnique('effort', effort, match[1] || match[2] || match[3]);
    } else if (arg.startsWith('--config=')) {
      const config = arg.slice('--config='.length);
      const match = /^model_reasoning_effort=(?:"([^"]+)"|'([^']+)'|([^'"\s]+))$/u.exec(config);
      if (!match) throw new Error('REVIEWER_RUNTIME_MISMATCH: reviewer runtime has an unsupported config');
      effort = assignUnique('effort', effort, match[1] || match[2] || match[3]);
    } else {
      throw new Error(`REVIEWER_RUNTIME_MISMATCH: unsupported reviewer runtime argument ${String(arg).slice(0, 120)}`);
    }
  }
  const expectedModel = String(request.reviewer?.model || '').trim();
  const expectedEffort = String(request.reviewer?.effort || '').trim();
  const expectedSandbox = String(request.reviewer?.sandbox || '').trim();
  if (!model || model !== expectedModel || (expectedEffort && effort !== expectedEffort) ||
      sandbox !== 'read-only' || (expectedSandbox && sandbox !== expectedSandbox)) {
    throw new Error(
      `REVIEWER_RUNTIME_MISMATCH: requested model=${String(expectedModel).slice(0, 120)} effort=${String(expectedEffort).slice(0, 40)} sandbox=${String(expectedSandbox).slice(0, 40)}` +
      ` but runtime model=${String(model).slice(0, 120)} effort=${String(effort).slice(0, 40)} sandbox=${String(sandbox).slice(0, 40)}`,
    );
  }
  return { command, args, model, effort };
}

export function expectedQueueRuntimeModelAndEffort(request, actualModel, fallbackFrom) {
  const expectedModel = String(request?.reviewer?.model || '').trim();
  if (!expectedModel) throw new Error('REVIEWER_RUNTIME_MISMATCH: reviewer model is missing');
  const kind = reviewQueueReviewerKind(expectedModel);
  const fallbackValid = fallbackFrom !== undefined && validReviewQueueFallback(expectedModel, actualModel, fallbackFrom);
  const runtime = kind === 'codex' ? requestedQueueCodexRuntime(request) : null;
  if (kind === 'codex' && (!runtime || !runtime.effort)) {
    throw new Error('REVIEWER_RUNTIME_MISMATCH: runtime evidence request requires an explicit Codex effort');
  }
  if (kind === 'opus' || fallbackValid) {
    return { model: 'claude-opus-5-5', effort: 'high' };
  }
  return { model: runtime.model, effort: runtime.effort };
}

// 2026-09-28 (T1-T5 stage 4B): the official deepseek-native-cli-v1 queue worker
// (Knowledge review-queue-worker.mjs validNativeUsage) emits the real Opus reviewer token usage ONLY
// for the native chain. The legacy path never carried `usage`, so loadValidatedQueueResult accepts
// that field for the explicit native chain only and validates it against the worker's exact
// contract. Token counts are reviewer-usage evidence, not an invoice or a cost approval; the
// spending approval stays in the existing queue cost ledger, and nothing here infers usage from
// argv or wall-clock time.
export const NATIVE_QUEUE_USAGE_KEYS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
const NATIVE_QUEUE_USAGE_ALLOWED_KEYS = new Set([...NATIVE_QUEUE_USAGE_KEYS, 'costUsd']);

function nativeQueueUsageMismatches(usage, mismatches) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    mismatches.push('usage');
    return;
  }
  for (const key of Object.keys(usage)) {
    if (!NATIVE_QUEUE_USAGE_ALLOWED_KEYS.has(key)) mismatches.push(`usage.unknownKey:${key}`);
  }
  // Every required key must be present and a nonnegative integer; a missing key is undefined and so
  // fails the same check, naming the exact field that is wrong.
  for (const key of NATIVE_QUEUE_USAGE_KEYS) {
    if (!Number.isInteger(usage[key]) || usage[key] < 0) mismatches.push(`usage.${key}`);
  }
  if (
    Number.isInteger(usage.inputTokens) &&
    Number.isInteger(usage.outputTokens) &&
    Number.isInteger(usage.totalTokens) &&
    usage.totalTokens !== usage.inputTokens + usage.outputTokens
  ) mismatches.push('usage.totalTokens-sum');
  if (Number.isInteger(usage.inputTokens) && Number.isInteger(usage.cacheReadInputTokens) && usage.cacheReadInputTokens > usage.inputTokens) {
    mismatches.push('usage.cacheReadInputTokens>inputTokens');
  }
  if (Number.isInteger(usage.inputTokens) && Number.isInteger(usage.cacheCreationInputTokens) && usage.cacheCreationInputTokens > usage.inputTokens) {
    mismatches.push('usage.cacheCreationInputTokens>inputTokens');
  }
  // 2026-09-28 (T1-T5 stage 4B): the worker's validNativeUsage rejects when the two cache subfields
  // overflow input together, not only individually. Mirror that combined rule (per-field checks are
  // subsumed by it, so keeping both never rejects anything the worker accepts).
  if (
    Number.isInteger(usage.inputTokens) &&
    Number.isInteger(usage.cacheReadInputTokens) &&
    Number.isInteger(usage.cacheCreationInputTokens) &&
    usage.cacheReadInputTokens + usage.cacheCreationInputTokens > usage.inputTokens
  ) mismatches.push('usage.cache-sum>inputTokens');
  if (Object.hasOwn(usage, 'costUsd') && (typeof usage.costUsd !== 'number' || !Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
    mismatches.push('usage.costUsd');
  }
}

export function loadValidatedQueueResult(request) {
  const entryDir = queueEntryPath(request?.requestId);
  ensureSafeDirectory(entryDir);
  const resetPath = join(entryDir, 'reset.json');
  if (existsSync(resetPath)) {
    const reset = readQueueJson(resetPath, 'reset.json');
    if (reset.requestId !== request.requestId || reset.status !== 'reset') {
      throw new Error('queueのreset.jsonが不正なため結果を受け入れません');
    }
    throw new Error('reset済みの旧Request-IDから結果を再回収しません');
  }
  const queuedRequest = readQueueJson(join(entryDir, 'request.json'), 'request.json');
  // deepseek-native-cli-v1 のときだけ worker が実 usage を残す。許可判定をこの1箇所に集約する。
  const nativeChain = queuedRequest.reviewChainVersion === NATIVE_REVIEW_CHAIN_VERSION;
  const state = readQueueJson(join(entryDir, 'state.json'), 'state.json');
  if (!REVIEW_QUEUE_STATES.has(state.status)) throw new Error(`state.jsonのstatusが不正です: ${state.status || 'なし'}`);
  if (!['result_staged', 'published', 'accepted'].includes(state.status)) {
    return { ready: false, entryDir, state, queuedRequest };
  }
  const resultPath = join(entryDir, 'result.json');
  if (!existsSync(resultPath)) {
    return { ready: false, entryDir, state, queuedRequest, resultPending: true };
  }
  const result = readQueueJson(resultPath, 'result.json', { maxBytes: MAX_REVIEW_RESULT_BYTES });
  const actualInputHash = calculateQueueInputHash(entryDir, queuedRequest.promptVersion);
  const expectedModel = queuedRequest?.reviewer?.model;
  let modelValid = false;
  let fallbackValid = false;
  try {
    modelValid = validReviewQueueResultModel(queuedRequest, result.model, result.fallbackFrom);
    fallbackValid = validReviewQueueFallback(expectedModel, result.model, result.fallbackFrom);
  } catch {}
  const mismatches = [];
  if (
    queuedRequest.requestId !== request.requestId ||
    state.requestId !== request.requestId ||
    result.requestId !== request.requestId
  ) mismatches.push('Request-ID');
  if (queuedRequest.inputHash !== actualInputHash || result.inputHash !== actualInputHash) mismatches.push('inputHash');
  if (request.inputHash !== actualInputHash) mismatches.push('local inputHash');
  if (result.promptVersion !== queuedRequest.promptVersion) mismatches.push('promptVersion');
  if (request.promptVersion !== queuedRequest.promptVersion) mismatches.push('local promptVersion');
  if (!modelValid) mismatches.push('model');
  if (result.fallbackFrom !== undefined && !fallbackValid) mismatches.push('fallbackFrom');
  if (request.reviewerModel !== expectedModel) mismatches.push('local reviewerModel');
  if (request.round !== queuedRequest.round) mismatches.push('local round');
  if ((request.lens ?? null) !== (queuedRequest.lens ?? null)) mismatches.push('local lens');
  if ((request.recheck ?? null) !== (queuedRequest.recheck ?? null)) mismatches.push('local recheck');
  if (!['ok', 'findings'].includes(result.verdict)) mismatches.push('verdict');
  if (typeof result.body !== 'string' || !result.body.trim()) mismatches.push('body');
  if (typeof result.body === 'string' && result.body.length > MAX_REVIEW_RESULT_BODY_CHARS) mismatches.push('body.length');
  if (!Number.isInteger(result.attempt) || result.attempt < 1) mismatches.push('attempt');
  if (state.attempt !== result.attempt) mismatches.push('state.attempt');
  if (!Number.isInteger(state.leaseGeneration) || state.leaseGeneration < 1) mismatches.push('state.leaseGeneration');
  if (!Number.isInteger(result.leaseGeneration) || result.leaseGeneration < 1) mismatches.push('leaseGeneration');
  if (state.leaseGeneration !== result.leaseGeneration) mismatches.push('leaseGeneration');
  if (!IDENTIFIER_PATTERN.test(String(state.ownerToken || ''))) mismatches.push('state.ownerToken');
  if (!IDENTIFIER_PATTERN.test(String(result.ownerToken || ''))) mismatches.push('ownerToken');
  if (state.ownerToken !== result.ownerToken) mismatches.push('ownerToken');
  if (!Number.isFinite(result.workerDurationMs) || result.workerDurationMs < 0) mismatches.push('workerDurationMs');
  if (typeof result.retry !== 'boolean') mismatches.push('retry');
  if (result.failureReason !== undefined && typeof result.failureReason !== 'string') mismatches.push('failureReason');
  // 2026-09-23: worker が起動 argv の --model(実起動の明示ID)を残す任意の欄。受理判定に使う
  // 'model'(論理名 'opus')は変えず、旧記録はこの欄が無いまま読めるようにする。
  const allowedKeys = new Set(['requestId', 'inputHash', 'promptVersion', 'model', 'fallbackFrom', 'verdict', 'body', 'attempt', 'leaseGeneration', 'ownerToken', 'workerDurationMs', 'retry', 'failureReason', 'actualRuntimeModel', 'actualRuntimeModelSource', 'actualRuntimeModelEvidencePath', 'actualRuntimeModelEvidenceSha256', 'round', RUNTIME_EVIDENCE_MARKER_KEY]);
  const runtimeEvidenceKeys = ['actualRuntimeModel', 'actualRuntimeModelSource', 'actualRuntimeModelEvidencePath', 'actualRuntimeModelEvidenceSha256', 'round'];
  const presentRuntimeEvidenceKeys = runtimeEvidenceKeys.filter((key) => result[key] !== undefined);
  if (presentRuntimeEvidenceKeys.length !== 0 && presentRuntimeEvidenceKeys.length !== runtimeEvidenceKeys.length) mismatches.push('runtimeEvidence');
  if (result[RUNTIME_EVIDENCE_MARKER_KEY] !== undefined && result[RUNTIME_EVIDENCE_MARKER_KEY] !== 1) mismatches.push('runtimeEvidenceSchemaVersion');
  if (queuedRequest[RUNTIME_EVIDENCE_MARKER_KEY] !== undefined && queuedRequest[RUNTIME_EVIDENCE_MARKER_KEY] !== 1) mismatches.push('requestRuntimeEvidenceSchemaVersion');
  if (request[RUNTIME_EVIDENCE_MARKER_KEY] !== undefined && request[RUNTIME_EVIDENCE_MARKER_KEY] !== 1) mismatches.push('localRuntimeEvidenceSchemaVersion');
  if ((request[RUNTIME_EVIDENCE_MARKER_KEY] === 1) !== (queuedRequest[RUNTIME_EVIDENCE_MARKER_KEY] === 1)) mismatches.push('runtimeEvidenceSchemaVersion');
  if (result.actualRuntimeModel !== undefined && (typeof result.actualRuntimeModel !== 'string' || !/^[a-z0-9.-]{1,80}$/.test(result.actualRuntimeModel))) mismatches.push('actualRuntimeModel');
  if (result.actualRuntimeModelSource !== undefined && result.actualRuntimeModelSource !== 'launch_argv') mismatches.push('actualRuntimeModelSource');
  if (result.actualRuntimeModelEvidencePath !== undefined && (typeof result.actualRuntimeModelEvidencePath !== 'string' || !result.actualRuntimeModelEvidencePath || result.actualRuntimeModelEvidencePath.startsWith('/') || result.actualRuntimeModelEvidencePath.split('/').includes('..'))) mismatches.push('actualRuntimeModelEvidencePath');
  if (result.actualRuntimeModelEvidenceSha256 !== undefined && (typeof result.actualRuntimeModelEvidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.actualRuntimeModelEvidenceSha256))) mismatches.push('actualRuntimeModelEvidenceSha256');
  if (result.round !== undefined && (!Number.isInteger(result.round) || result.round !== queuedRequest.round)) mismatches.push('round');
  const requestRequiresRuntimeEvidence = queuedRequest[RUNTIME_EVIDENCE_MARKER_KEY] === 1;
  if (requestRequiresRuntimeEvidence && result[RUNTIME_EVIDENCE_MARKER_KEY] !== 1) mismatches.push('runtimeEvidenceSchemaVersion');
  if (result[RUNTIME_EVIDENCE_MARKER_KEY] === 1 && !requestRequiresRuntimeEvidence) mismatches.push('runtimeEvidence');
  if (requestRequiresRuntimeEvidence && presentRuntimeEvidenceKeys.length !== runtimeEvidenceKeys.length) mismatches.push('runtimeEvidence');
  if (requestRequiresRuntimeEvidence && (typeof result.actualRuntimeModelEvidencePath !== 'string' || !result.actualRuntimeModelEvidencePath || typeof result.actualRuntimeModelEvidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.actualRuntimeModelEvidenceSha256))) mismatches.push('runtimeEvidence');
  if (result[RUNTIME_EVIDENCE_MARKER_KEY] === 1) {
    try {
      const expectation = expectedQueueRuntimeModelAndEffort(queuedRequest, result.model, result.fallbackFrom);
      if (result.actualRuntimeModel !== expectation.model) {
        mismatches.push('actualRuntimeModel');
      } else if (result.actualRuntimeModelSource !== 'launch_argv') {
        mismatches.push('actualRuntimeModelSource');
      } else {
        verifyQueueRuntimeEvidence({
          entryDir,
          requestId: queuedRequest.requestId,
          round: queuedRequest.round,
          inputHash: actualInputHash,
          attempt: result.attempt,
          leaseGeneration: result.leaseGeneration,
          ownerToken: result.ownerToken,
          evidencePath: result.actualRuntimeModelEvidencePath,
          evidenceSha256: result.actualRuntimeModelEvidenceSha256,
          actualRuntimeModel: expectation.model,
          actualRuntimeModelSource: result.actualRuntimeModelSource,
          expectedEffort: expectation.effort,
        });
      }
    } catch (error) {
      mismatches.push(`runtimeEvidenceVerify:${error.message}`);
    }
  }
  // native連鎖だけ usage を許可し、欠落・余分・非整数・合計不一致・cache超過をすべて不合格にする。
  // それ以外の依頼では usage は今まで通り unknownKeys として拒否する（旧方式の結果は usage を持たない）。
  if (nativeChain) {
    allowedKeys.add('usage');
    if (!Object.hasOwn(result, 'usage')) mismatches.push('usage');
    else nativeQueueUsageMismatches(result.usage, mismatches);
  }
  if (Object.keys(result).some((key) => !allowedKeys.has(key))) mismatches.push('unknownKeys');
  if (mismatches.length) throw new Error(`result.jsonの厳密照合に失敗しました: ${mismatches.join(', ')}`);
  return { ready: true, entryDir, state, queuedRequest, result, resultPath, actualInputHash };
}

const REVIEW_BASE_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/iu;

export function normalizeQueueReviewBaseCommit(value) {
  if (value === null || value === undefined) return null;
  const candidate = String(value).trim();
  if (!candidate) return null;
  if (!REVIEW_BASE_COMMIT_PATTERN.test(candidate)) {
    throw new Error('レビュー基点(reviewBaseCommit)がcommit IDの形式ではありません');
  }
  return candidate;
}

/**
 * レビューの照合対象から外すpath。
 *
 * .ai/user-instructions/ はフックがユーザー発話のたびに追記するセッション記録で、
 * レビュー対象の成果物ではない。ここを一覧へ含めると、queue登録から受入までの間に
 * 必ず内容が変わり、どのレーンでも2往復目以降が
 * 「queue登録後に…の内容が変わりました」で必ず失敗していた(2026-09-10実測)。
 * 送信側のmanifest生成と受入側の照合の両方がこの除外を共有する。
 */
export const REVIEW_EXCLUDED_PATH_PREFIXES = ['.ai/user-instructions/'];
export const REVIEW_EXCLUDED_EXACT_PATHS = new Set([
  '.ai/context/review-request.md',
  '.ai/context/review-request.json',
  '.ai/context/review-result.md',
]);

export function isReviewExcludedPath(path) {
  const normalized = String(path || '').replaceAll('\\', '/');
  return REVIEW_EXCLUDED_EXACT_PATHS.has(normalized)
    || REVIEW_EXCLUDED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * queue入力へ固定する変更ファイル一覧を数える唯一の場所。
 * 送信側のmanifest生成と受入側のworktree照合が同じ基準で列挙するために共有する。
 * baseCommitがあれば「基準commitからの差分＋未追跡」、無ければ「未保存の変更＋未追跡」。
 */
export function listQueueChangedPaths(repoRoot, { baseCommit = null, label = '変更ファイル一覧' } = {}) {
  const base = normalizeQueueReviewBaseCommit(baseCommit);
  const collect = (args) => {
    let output;
    try {
      // path名も生バイトで受け取る。UTF-8でない名前を置換文字へ潰すと、
      // manifestのpathと実ファイルが一致せず、原因の分からない受入失敗になる。
      output = decodeReviewBytes(gitOutput([...args, '-z', '--', '.'], { cwd: repoRoot, encoding: 'buffer' }), label);
    } catch (error) {
      const reason = String(error?.message || error || '不明なエラー').split('\n')[0];
      throw new Error(`${label}を取得できません: ${reason}`);
    }
    return output.split('\0').filter(Boolean);
  };
  const trackedChanges = base
    ? collect(['diff', '--name-only', '--no-renames', base])
    : [
        ...collect(['diff', '--name-only', '--no-renames']),
        ...collect(['diff', '--cached', '--name-only', '--no-renames']),
      ];
  const all = new Set([
    ...trackedChanges,
    ...collect(['ls-files', '--others', '--exclude-standard']),
  ]);
  let excludedSecretCount = 0;
  const paths = [];
  for (const path of [...all].sort()) {
    if (isSecretPath(path)) {
      excludedSecretCount += 1;
      continue;
    }
    if (isReviewExcludedPath(path)) continue;
    if (!path || path.startsWith('/') || path.split('/').includes('..')) continue;
    paths.push(path);
  }
  return { paths, excludedSecretCount, baseCommit: base };
}

export function validateQueueWorktreeSnapshot(repoRoot, request) {
  // 2026-09-28 (T1-T5 stage 4B): deepseek-native-cli-v1 の依頼は native専用の照合へ回す。公式な
  // native manifest は pin の分類集合(reviewed+protected+forward_frozen)だけを凍結し `.ai/` を
  // 最初から含まないが、登録から受入までの間に公式処理が `.ai/` 状態を必ず書き足す。旧来の全dirty
  // 比較のままでは公式状態だけで受理が必ず失敗する。legacy/direct-API は従来の全dirty比較を維持する。
  const nativeBound = request && typeof request === 'object' && !Array.isArray(request)
    ? nativeReviewPinFromRequest(request)
    : null;
  if (nativeBound) return validateNativeQueueWorktreeSnapshot(repoRoot, request);
  const entryDir = queueEntryPath(request?.requestId);
  const manifest = readQueueJson(join(entryDir, 'manifest.json'), 'manifest.json');
  if (!Array.isArray(manifest.files)) throw new Error('manifest.jsonのfilesが配列ではありません');
  // 除外対象が載っている旧いmanifestでも受け取れるよう、照合前に同じ規則で落とす。
  const reviewedFiles = manifest.files.filter((file) => !isReviewExcludedPath(file?.path));
  // 送信時のmanifestと同じ基準で数える。基準commitが記録されていない旧依頼は、
  // 従来どおり未保存の変更＋未追跡だけで照合する（後方互換）。
  const { paths: actualPaths } = listQueueChangedPaths(repoRoot, {
    baseCommit: request?.reviewBaseCommit ?? null,
    label: 'queue受入時の変更ファイル一覧',
  });
  const expectedPaths = reviewedFiles.map((file) => String(file?.path || '')).sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    throw new Error('queue登録後に変更ファイル一覧が変わりました。新しいRequest-IDで再依頼してください');
  }
  for (const file of reviewedFiles) {
    const path = String(file?.path || '');
    if (!path || path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error('manifest.jsonに不正なpathがあります');
    }
    const absolute = join(repoRoot, path);
    if (file.status === 'deleted') {
      if (existsSync(absolute)) throw new Error(`queue登録後に${path}の状態が変わりました`);
      continue;
    }
    if (file.status !== 'present' || !existsSync(absolute)) {
      throw new Error(`queue登録後に${path}の状態が変わりました`);
    }
    const info = lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`queue登録後に${path}が通常ファイルでなくなりました`);
    if (info.size !== file.size || sha256File(absolute) !== file.sha256) {
      throw new Error(`queue登録後に${path}の内容が変わりました。新しいRequest-IDで再依頼してください`);
    }
  }
  return { manifest, paths: actualPaths };
}

/**
 * `.ai/` は公式の作業状態ディレクトリ。native pin の分類path(`nativePinPath`)は `.ai/` を明示的に
 * 拒否し、review-scope も `.ai/` を変更集合から除外する(`AI_EXEMPT_PREFIX`)。したがって manifest に
 * `.ai/` の path は絶対に載らず、`.ai/` の追加が審査対象の成果物を隠すことはできない。
 */
export function isNativeOfficialStatePath(path) {
  const normalized = String(path || '').replaceAll('\\', '/');
  return normalized === '.ai' || normalized.startsWith('.ai/');
}

/**
 * deepseek-native-cli-v1 専用の queue worktree 照合。
 *
 * 1) queue 登録済み request.json の native pin を権威にし、pin が manifest 全件(path)を過不足なく
 *    覆うことを再確認する(`assertNativeRequestPin`)。手元の依頼の pin と scope は登録済み pin と
 *    完全一致していなければならない(別scopeへの差し替えを止める)。
 * 2) manifest の全件について 存在・通常ファイル・size・sha256 を検証する。reviewed/protected/
 *    forward_frozen の変更・削除・hash変更はここで拒否される。
 * 3) 実 worktree の変更一覧を「送信時と同じ基準」で数え、`.ai/` 公式状態以外の全 path が manifest と
 *    完全一致することを要求する。`.ai/` 以外の未分類追加・欠落は拒否し、変わった path を示す。
 *    `.ai/` は公式状態としてのみ許し、manifest 側に `.ai/` が混ざれば拒否する。
 * scope/approval/HEAD/実バイトの再検証は、同じ claim 内の verifyNativePrimaryReceipt が行う。
 */
export function validateNativeQueueWorktreeSnapshot(repoRoot, request) {
  const entryDir = queueEntryPath(request?.requestId);
  const manifest = readQueueJson(join(entryDir, 'manifest.json'), 'manifest.json');
  if (!Array.isArray(manifest.files)) throw new Error('manifest.jsonのfilesが配列ではありません');
  const reviewedFiles = manifest.files.filter((file) => !isReviewExcludedPath(file?.path));
  const frozenRequest = readQueueJson(join(entryDir, 'request.json'), 'request.json');
  const frozenBound = assertNativeRequestPin(frozenRequest, { manifestFiles: manifest.files });
  if (!frozenBound) throw new Error('NATIVE_PIN_REQUEST_MISMATCH: 登録済みrequest.jsonからnative pinを確認できません');
  const localBound = nativeReviewPinFromRequest(request);
  if (!localBound) throw new Error('NATIVE_PIN_REQUEST_MISMATCH: 依頼からnative pinを確認できません');
  if (
    JSON.stringify(localBound.pin) !== JSON.stringify(frozenBound.pin)
    || localBound.scopeFile !== frozenBound.scopeFile
  ) {
    throw new Error('NATIVE_PIN_REQUEST_MISMATCH: 手元の依頼とqueue登録済み依頼のnative pin/scopeが一致しません');
  }
  const manifestPaths = reviewedFiles.map((file) => String(file?.path || '')).sort();
  if (manifestPaths.some((path) => isNativeOfficialStatePath(path))) {
    throw new Error('NATIVE_PIN_MANIFEST_MISMATCH: manifestに公式状態(.ai/)のpathが混ざっています');
  }
  const classified = nativePinClassifiedPaths(frozenBound.pin);
  if (JSON.stringify(manifestPaths) !== JSON.stringify(classified)) {
    throw new Error(`NATIVE_PIN_MANIFEST_MISMATCH: 分類集合とmanifestが一致しません (manifest=${manifestPaths.length} classified=${classified.length})`);
  }
  for (const file of reviewedFiles) {
    const path = String(file?.path || '');
    if (!path || path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error('manifest.jsonに不正なpathがあります');
    }
    const absolute = join(repoRoot, path);
    if (file.status === 'deleted') {
      if (existsSync(absolute)) throw new Error(`queue登録後に${path}の状態が変わりました`);
      continue;
    }
    if (file.status !== 'present' || !existsSync(absolute)) {
      throw new Error(`queue登録後に${path}の状態が変わりました`);
    }
    const info = lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`queue登録後に${path}が通常ファイルでなくなりました`);
    if (info.size !== file.size || sha256File(absolute) !== file.sha256) {
      throw new Error(`queue登録後に${path}の内容が変わりました。新しいRequest-IDで再依頼してください`);
    }
  }
  const { paths: livePaths } = listQueueChangedPaths(repoRoot, {
    baseCommit: request?.reviewBaseCommit ?? frozenBound.pin.reviewBaseCommit ?? null,
    label: 'queue受入時の変更ファイル一覧',
  });
  const liveNonOfficial = livePaths.filter((path) => !isNativeOfficialStatePath(path));
  if (JSON.stringify(liveNonOfficial) !== JSON.stringify(manifestPaths)) {
    const manifestSet = new Set(manifestPaths);
    const liveSet = new Set(liveNonOfficial);
    const extra = liveNonOfficial.filter((path) => !manifestSet.has(path));
    const drop = manifestPaths.filter((path) => !liveSet.has(path));
    throw new Error(
      'queue登録後にレビュー対象の変更ファイル一覧が変わりました'
      + `（追加: ${extra.length ? extra.join(', ') : 'なし'} / 欠落: ${drop.length ? drop.join(', ') : 'なし'}）。新しいRequest-IDで再依頼してください`,
    );
  }
  return { manifest, paths: manifestPaths };
}

export function queueResultReplyBody(request, result) {
  return `Project: ${request.project}\nRepo: ${request.repo}\nBranch: ${request.branch}\nTask: ${request.task}\nTeam: ${request.team}\nRequest-ID: ${request.requestId}\n\n${result.body.trim()}`;
}

export function withQueueAcceptanceClaim(request, validateInsideClaim) {
  if (typeof validateInsideClaim !== 'function') throw new Error('queue受領の検証処理がありません');
  const entryDir = queueEntryPath(request?.requestId);
  let claim = acquireQueueLeaseClaimLock(entryDir, `acceptor-${process.pid}`);
  if (!claim.acquired) {
    recoverStaleQueueLeaseClaimLock(entryDir, { acceptorOnly: true });
    claim = acquireQueueLeaseClaimLock(entryDir, `acceptor-${process.pid}`);
  }
  if (!claim.acquired) throw new Error('queue状態を別の作業役が更新中です。しばらく待って再実行してください');
  try {
    const validated = loadValidatedQueueResult(request);
    if (!validated.ready || !['result_staged', 'published', 'accepted'].includes(validated.state.status)) {
      if (['pending', 'leased', 'running'].includes(validated.state.status)) {
        throw new Error(`結果はまだ準備中です（status=${validated.state.status}）。ai:review-waitで待ってから再実行してください`);
      }
      throw new Error(`acceptedへ進められないstatusです: ${validated.state.status || 'なし'}`);
    }
    const resultHash = sha256File(validated.resultPath);
    validateInsideClaim(validated);
    const revalidated = loadValidatedQueueResult(request);
    if (
      !revalidated.ready ||
      revalidated.state.status !== validated.state.status ||
      revalidated.state.attempt !== validated.state.attempt ||
      revalidated.state.leaseGeneration !== validated.state.leaseGeneration ||
      revalidated.state.ownerToken !== validated.state.ownerToken ||
      sha256File(revalidated.resultPath) !== resultHash
    ) {
      throw new Error('検証後にqueue結果または世代・owner tokenが差し替えられたためacceptedへ進めません');
    }
    const next = revalidated.state.status === 'accepted'
      ? revalidated.state
      : (() => {
          const acceptedAt = new Date().toISOString();
          const accepted = { ...revalidated.state, status: 'accepted', updatedAt: acceptedAt, acceptedAt };
          atomicWriteJson(join(entryDir, 'state.json'), accepted);
          return accepted;
        })();
    return { ...revalidated, state: next };
  } finally {
    try {
      releaseQueueLeaseClaimLock(entryDir, claim.token);
    } catch (error) {
      console.error(`REVIEW_PROCESS_WARNING: accepted処理後にclaim lockの解放を確認できません: ${error.message}`);
    }
  }
}

// 旧版のimportだけは壊さず、claimなしの受領確定を再導入しない。
export function markQueueAccepted() {
  throw new Error('新版へ更新してください: install.mjs --update');
}
