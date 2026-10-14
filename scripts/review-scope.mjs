// review-scope-v1: official review-scope generator/validator for a task worktree.
//
// It classifies the real Git change set of the worktree into an exclusive, total-covering
// union of reviewed / protected / forward_frozen paths. A changed path that no entry names is
// an error and never a silent pass, so an unrelated pre-existing asset can only be frozen by
// an explicit snapshot-time inventory of literal paths. There is deliberately no
// directory/prefix rule: a prefix rule would swallow a newly added task output.
//
// The two frozen kinds are kept apart on purpose.
//   protected      tracked-at-base files that were already dirty when the task started. Its
//                  sha is the saved historical hash of those bytes, and the path must still
//                  exist in the official base commit.
//   forward_frozen unrelated pre-existing untracked assets. Its sha is the hash of the bytes
//                  observed at freeze time; a later modification or deletion fails. No
//                  historical baseline is ever claimed for forward_frozen.
//
// Trusted caller inputs are never read back from the scope file: the ignored-pathspec bound,
// the expected scope hash, and the task's registered output list (re-read from the official
// `.ai/current-task.json` by verifyReviewScopeAtRoot). `.ai/` is existing userdata, not reviewed
// source, so it is kept out of the reviewed set at enumeration time and a scope that names it is
// rejected outright; its task/approval anchors are still verified from the real files.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { sha, regular } from './review-evidence.mjs';

export const REVIEW_SCOPE_VERSION = 'review-scope-v1';
export const SCOPE_ENTRY_KINDS = ['reviewed', 'protected', 'forward_frozen'];
export const AI_EXEMPT_PREFIX = '.ai/';
const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40,64}$/;
const SCOPE_OUTPUT_GLOB_RE = /[*?[\]{}!]/;
const MAX_ENUMERATION_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const SCOPE_BY_KIND = {
  reviewed: { missing: 'SCOPE_REVIEWED_MISSING', changed: 'SCOPE_REVIEWED_CHANGED' },
  protected: { missing: 'SCOPE_PROTECTED_MISSING', changed: 'SCOPE_PROTECTED_CHANGED' },
  forward_frozen: { missing: 'SCOPE_FORWARD_FROZEN_MISSING', changed: 'SCOPE_FORWARD_FROZEN_CHANGED' },
};

function scopeFail(code, detail) {
  throw Error(detail ? `${code}: ${detail}` : code);
}

/** Literal, worktree-relative, forward-slash path. Rejects the shapes a scope cannot bind. */
function scopePath(value) {
  if (typeof value !== 'string' || !value) scopeFail('SCOPE_PATH_INVALID', 'empty');
  if (value.includes('\\') || value.includes('\u0000')) scopeFail('SCOPE_PATH_INVALID', 'backslash or NUL');
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) scopeFail('SCOPE_PATH_INVALID', 'absolute');
  const parts = value.split('/');
  if (parts.includes('..') || parts.includes('') || parts.includes('.')) scopeFail('SCOPE_PATH_INVALID', 'traversal or empty segment');
  if (value.startsWith(AI_EXEMPT_PREFIX)) scopeFail('SCOPE_PATH_INVALID', '.ai is existing userdata, not reviewed source');
  return value;
}

function requireText(value, code) {
  if (typeof value !== 'string' || !value.trim()) scopeFail(code);
  return value;
}

function requireBindings(manifest, { taskId, taskFingerprint, approvalHash, base, head, round }) {
  requireText(manifest.taskId, 'SCOPE_TASK_MISSING');
  requireText(manifest.taskFingerprint, 'SCOPE_TASK_MISSING');
  if (!HASH_RE.test(manifest.approvalHash || '')) scopeFail('SCOPE_APPROVAL_MISSING');
  if (!COMMIT_RE.test(manifest.base || '')) scopeFail('SCOPE_BASE_INVALID');
  if (!COMMIT_RE.test(manifest.head || '')) scopeFail('SCOPE_HEAD_INVALID');
  if (!Number.isInteger(manifest.round) || manifest.round < 1) scopeFail('SCOPE_ROUND_INVALID');
  if (taskId !== undefined && manifest.taskId !== taskId) scopeFail('SCOPE_TASK_MISMATCH');
  if (taskFingerprint !== undefined && manifest.taskFingerprint !== taskFingerprint) scopeFail('SCOPE_TASK_MISMATCH');
  if (approvalHash !== undefined && manifest.approvalHash !== approvalHash) scopeFail('SCOPE_APPROVAL_MISMATCH');
  if (base !== undefined && manifest.base !== base) scopeFail('SCOPE_BASE_MISMATCH');
  if (head !== undefined && manifest.head !== head) scopeFail('SCOPE_HEAD_MISMATCH');
  if (round !== undefined && manifest.round !== round) scopeFail('SCOPE_ROUND_MISMATCH');
}

function requireBound(value) {
  if (!Array.isArray(value)) scopeFail('SCOPE_IGNORED_BOUND_INVALID', 'the ignored-pathspec bound is a trusted caller input');
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.includes('\\') || path.isAbsolute(item) || item.split('/').includes('..')) scopeFail('SCOPE_IGNORED_BOUND_INVALID', String(item).slice(0, 48));
  }
  return [...value];
}

/** A registered task output: a literal file path, never a directory, glob or .ai path. */
function scopeOutputPath(value) {
  const rel = scopePath(value);
  if (rel === '.ai') scopeFail('SCOPE_OUTPUT_PATH_INVALID', '.ai is existing userdata, not reviewed source');
  if (SCOPE_OUTPUT_GLOB_RE.test(rel)) scopeFail('SCOPE_OUTPUT_PATH_INVALID', `not a literal file path: ${rel}`);
  return rel;
}

/**
 * The registered task-output list is a trusted task input, never a scope or receipt self-claim.
 * It is canonicalised to a sorted, case-insensitively unique list so the official task and the
 * scope can be compared without an order or case alias. A non-array is an error: a legacy task
 * with no field is normalised to [] by the callers rather than being accepted here.
 */
function requireOutputPaths(value) {
  if (!Array.isArray(value)) scopeFail('SCOPE_OUTPUT_BOUND_INVALID', 'the registered task output list is a trusted task input');
  const seen = new Set();
  const paths = [];
  for (const item of value) {
    const rel = scopeOutputPath(item);
    const key = rel.toLowerCase();
    if (seen.has(key)) scopeFail('SCOPE_OUTPUT_DUPLICATE', rel);
    seen.add(key);
    paths.push(rel);
  }
  return paths.sort();
}

/** Validate an entry list into an ordered path -> entry map. */
export function normalizeScopeEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) scopeFail('SCOPE_EMPTY');
  const map = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') scopeFail('SCOPE_ENTRY_INVALID');
    const rel = scopePath(entry.path);
    if (map.has(rel)) scopeFail('SCOPE_DUPLICATE_PATH', rel);
    if (!SCOPE_ENTRY_KINDS.includes(entry.kind)) scopeFail('SCOPE_ENTRY_KIND_INVALID', `${rel} kind=${String(entry.kind)}`);
    requireText(entry.reason, 'SCOPE_ENTRY_REASON_MISSING');
    // Every kind carries the observed byte hash. forward_frozen included: a null hash there was
    // exactly the hole that let an asset change after the freeze without anything failing.
    if (!HASH_RE.test(entry.sha || '')) scopeFail('SCOPE_ENTRY_SHA_MISSING', rel);
    map.set(rel, { path: rel, kind: entry.kind, sha: entry.sha, reason: entry.reason });
  }
  return map;
}

function sortedEntries(byPath) {
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The exact hash of an exclusive, total-covering scope: every path's kind and sha are in it. */
export function computeScopeHash(manifest) {
  const payload = {
    version: REVIEW_SCOPE_VERSION,
    taskId: manifest.taskId,
    taskFingerprint: manifest.taskFingerprint,
    approvalHash: manifest.approvalHash,
    base: manifest.base,
    head: manifest.head,
    round: manifest.round,
    ignoredPathspecs: [...(manifest.ignoredPathspecs || [])],
    entries: (manifest.entries || []).map((entry) => ({ path: entry.path, kind: entry.kind, sha: entry.sha, reason: entry.reason })),
  };
  // Bind the registered task-output list only when it is non-empty: a scope generated before this
  // field existed keeps its exact hash, while a scope that registers outputs cannot have them
  // silently dropped (removing the field changes the hash).
  if ((manifest.reviewOutputPaths || []).length) payload.reviewOutputPaths = [...manifest.reviewOutputPaths];
  return sha(JSON.stringify(payload));
}

/** Both directions are errors: an unnamed changed path, and an entry that is not changed. */
function requireCoverage(byPath, changedSet, reviewedManifestPaths, reviewOutputPaths) {
  const changed = new Set();
  for (const item of changedSet) changed.add(scopePath(item));
  for (const rel of changed) if (!byPath.has(rel)) scopeFail('SCOPE_UNCLASSIFIED_CHANGED_PATH', rel);
  for (const rel of byPath.keys()) if (!changed.has(rel)) scopeFail('SCOPE_PATH_NOT_CHANGED', rel);
  for (const item of reviewedManifestPaths) {
    const rel = scopePath(item);
    const entry = byPath.get(rel);
    if (!entry) scopeFail('SCOPE_REVIEWED_MANIFEST_PATH_UNCLASSIFIED', rel);
    if (entry.kind !== 'reviewed') scopeFail('SCOPE_TASK_FILE_MUST_BE_REVIEWED', `${rel} kind=${entry.kind}`);
  }
  // A registered task output that is present in the change set must be reviewed. It may be absent
  // at freeze time (it then simply has no entry); it is caught the moment it appears as an
  // unclassified changed path, and it can never be hidden as protected or forward_frozen.
  for (const item of reviewOutputPaths) {
    const rel = scopeOutputPath(item);
    const entry = byPath.get(rel);
    if (entry && entry.kind !== 'reviewed') scopeFail('SCOPE_TASK_OUTPUT_MUST_BE_REVIEWED', `${rel} kind=${entry.kind}`);
  }
  return changed;
}

export function buildReviewScope({ changedSet, entries, taskId, taskFingerprint, approvalHash, base, head, round, ignoredPathspecs = [], reviewedManifestPaths = [], reviewOutputPaths = [] }) {
  const byPath = normalizeScopeEntries(entries);
  const manifest = {
    version: REVIEW_SCOPE_VERSION,
    taskId,
    taskFingerprint,
    approvalHash,
    base,
    head,
    round,
    ignoredPathspecs: requireBound(ignoredPathspecs),
    reviewOutputPaths: requireOutputPaths(reviewOutputPaths),
    entries: sortedEntries(byPath),
    scopeHash: '',
  };
  requireBindings(manifest, {});
  requireCoverage(byPath, changedSet, reviewedManifestPaths, manifest.reviewOutputPaths);
  return { ...manifest, scopeHash: computeScopeHash(manifest) };
}

export function verifyReviewScope(manifest, { changedSet, ignoredPathspecs, expectedScopeHash = '', taskId, taskFingerprint, approvalHash, base, head, round, reviewedManifestPaths = [], reviewOutputPaths, readSha, current = true } = {}) {
  if (!manifest || manifest.version !== REVIEW_SCOPE_VERSION) scopeFail('SCOPE_VERSION_MISMATCH', String(manifest && manifest.version));
  // The enumeration bound is a trusted caller input: a scope that narrowed or widened its own
  // ignored bound must not pass merely because it says so.
  const bound = requireBound(manifest.ignoredPathspecs);
  const wanted = requireBound(ignoredPathspecs);
  if (JSON.stringify(bound) !== JSON.stringify(wanted)) scopeFail('SCOPE_IGNORED_BOUND_MISMATCH', `scope=${JSON.stringify(bound)} caller=${JSON.stringify(wanted)}`);
  // The registered output list is a trusted task input too. A missing field means "none
  // registered" (a legacy scope); a caller-supplied list (the official current task) must equal
  // the scope exactly, so neither a request nor the scope itself can widen or narrow it.
  const outputs = requireOutputPaths(manifest.reviewOutputPaths === undefined ? [] : manifest.reviewOutputPaths);
  if (reviewOutputPaths !== undefined) {
    const wantedOutputs = requireOutputPaths(reviewOutputPaths);
    if (JSON.stringify(outputs) !== JSON.stringify(wantedOutputs)) scopeFail('SCOPE_OUTPUT_BOUND_MISMATCH', `scope=${JSON.stringify(outputs)} caller=${JSON.stringify(wantedOutputs)}`);
  }
  const byPath = normalizeScopeEntries(manifest.entries);
  const recomputed = computeScopeHash(manifest);
  if (manifest.scopeHash !== recomputed) scopeFail('SCOPE_HASH_MISMATCH');
  if (expectedScopeHash && expectedScopeHash !== recomputed) scopeFail('SCOPE_PINNED_HASH_MISMATCH', 'the externally pinned scope hash differs');
  requireBindings(manifest, { taskId, taskFingerprint, approvalHash, base, head, round });
  const changed = requireCoverage(byPath, changedSet, reviewedManifestPaths, outputs);
  if (current) {
    if (typeof readSha !== 'function') scopeFail('SCOPE_READER_MISSING', 'the current-bytes reader is a caller input');
    for (const entry of sortedEntries(byPath)) {
      const actual = readSha(entry.path);
      if (actual === null) scopeFail(SCOPE_BY_KIND[entry.kind].missing, entry.path);
      if (actual !== entry.sha) scopeFail(SCOPE_BY_KIND[entry.kind].changed, `${entry.path} frozen=${entry.sha}`);
    }
  }
  const kinds = { reviewed: 0, protected: 0, forward_frozen: 0 };
  for (const entry of byPath.values()) kinds[entry.kind] += 1;
  return { ...manifest, scopeHash: recomputed, entryCount: byPath.size, changedCount: changed.size, kinds };
}

/**
 * True only when two stats prove the same file. When a filesystem reports no inode (ino 0) there
 * is nothing to prove identity with, so the check fails closed instead of accepting a possible swap.
 */
function sameIdentity(a, b) {
  if (a.ino === 0 || b.ino === 0) return false;
  return a.ino === b.ino && a.dev === b.dev;
}

/**
 * Hash a worktree-relative path from the real bytes; null means "absent".
 *
 * `regular` caps a receipt/evidence body at 4 MiB, which is right for a loaded document but wrong
 * for a frozen worktree asset: a real media file can be hundreds of MiB. The bytes are therefore
 * streamed into SHA-256 in bounded chunks. Safety is not relaxed: the path is resolved inside the
 * root, the leaf must be a real regular file (never a symlink), the resolved path must stay under
 * the real root (so a symlinked ancestor cannot escape), the file is opened without following a
 * final symlink, and the opened descriptor is re-checked against the lstat result so a path
 * swapped between the two steps fails closed instead of hashing a foreign file.
 *
 * `lstatSync` is injectable so a platform that forbids creating a symlink can still drive the
 * reject branch in tests; production always uses the real `fs.lstatSync`.
 */
export function worktreeReadSha(root, { lstatSync = fs.lstatSync } = {}) {
  const rootAbs = path.resolve(root);
  let rootReal;
  return (rel) => {
    const file = path.resolve(rootAbs, rel);
    if (!file.startsWith(rootAbs + path.sep)) scopeFail('SCOPE_PATH_ESCAPES_ROOT', rel);
    let before;
    try {
      before = lstatSync(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink()) scopeFail('SCOPE_PATH_NOT_REGULAR_FILE', rel);
    if (rootReal === undefined) rootReal = fs.realpathSync(rootAbs);
    let realFile;
    try {
      realFile = fs.realpathSync(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    if (!realFile.startsWith(rootReal + path.sep)) scopeFail('SCOPE_PATH_ESCAPES_ROOT', rel);
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      if (error && (error.code === 'ELOOP' || error.code === 'EMLINK')) scopeFail('SCOPE_PATH_NOT_REGULAR_FILE', rel);
      throw error;
    }
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || !sameIdentity(opened, before)) scopeFail('SCOPE_PATH_CHANGED_DURING_READ', rel);
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let bytes;
      while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
      const after = fs.fstatSync(fd);
      if (!sameIdentity(after, opened) || after.size !== opened.size) scopeFail('SCOPE_PATH_CHANGED_DURING_READ', rel);
      return hash.digest('hex');
    } finally {
      fs.closeSync(fd);
    }
  };
}

function gitHead(root) {
  const run = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (run.status !== 0 || !COMMIT_RE.test((run.stdout || '').trim())) scopeFail('SCOPE_HEAD_INVALID');
  return run.stdout.trim();
}

/**
 * Enumerate the real Git change set against `base`. `.ai/` is existing userdata rather than
 * reviewed source, so it is left out here and its anchors are read from the real files by
 * verifyReviewScopeAtRoot instead. Ignored paths are looked at only inside the caller's
 * explicit bound, so unrelated build/cache trees stay out while a task path hiding behind
 * .gitignore still surfaces as an unclassified changed path.
 *
 * The only ignored sources ever enumerated are the caller's literal bound, the literal
 * `reviewedManifestPaths` the official send request declares, and the task's registered output
 * paths (literal, bounded, re-read from the official task). There is deliberately no
 * whole-repository ignored scan: binding every cache/old-media root would reintroduce the
 * all-dirty problem and overflow the enumeration cap. An ignored tree that is neither bounded,
 * declared nor registered stays outside this contract, so completeness of the reviewed set still
 * has to be proven by the official send request and the official task registration.
 */
export function collectChangedSet(root, base, { ignoredPathspecs = [], reviewedManifestPaths = [], reviewOutputPaths = [] } = {}) {
  if (!COMMIT_RE.test(base || '')) scopeFail('SCOPE_BASE_INVALID');
  const bound = requireBound(ignoredPathspecs);
  const outputs = requireOutputPaths(reviewOutputPaths);
  const run = (args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: MAX_ENUMERATION_BYTES });
    if (result.status !== 0) scopeFail('SCOPE_GIT_ENUMERATION_FAILED', args.slice(0, 2).join(' '));
    return result.stdout.split('\u0000').filter(Boolean);
  };
  const seen = new Set();
  for (const rel of run(['diff', '--name-only', '--no-renames', '-z', base])) seen.add(rel);
  for (const rel of run(['ls-files', '--others', '--exclude-standard', '-z'])) seen.add(rel);
  if (bound.length) for (const rel of run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...bound])) seen.add(rel);
  // A reviewed task output may be declared while .gitignore hides it outside the bound.
  // Enumerating the literal declared paths (never the repository) keeps it visible so it can
  // only pass as `reviewed`, and never as an unrelated frozen asset.
  if (reviewedManifestPaths.length) for (const rel of run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...reviewedManifestPaths])) seen.add(rel);
  // The registered task outputs are enumerated as literal paths (:(literal), never a Git glob),
  // so a changed or newly created ignored output surfaces as an unclassified changed path rather
  // than disappearing. This is a bounded list, not a whole-repository ignored scan.
  if (outputs.length) for (const rel of run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...outputs.map((item) => `:(literal)${item}`)])) seen.add(rel);
  const changed = new Set();
  for (const rel of seen) if (!rel.startsWith(AI_EXEMPT_PREFIX)) changed.add(rel);
  return changed;
}

/**
 * Freeze unrelated pre-existing assets forward from now. Only literal paths can be frozen and
 * the bytes are hashed as they are at this moment; there is no rule that could later match a
 * path nobody classified.
 */
export function snapshotForwardFrozen(paths, reason, readSha) {
  requireText(reason, 'SCOPE_ENTRY_REASON_MISSING');
  if (typeof readSha !== 'function') scopeFail('SCOPE_READER_MISSING', 'the current-bytes reader is a caller input');
  if (!Array.isArray(paths) || !paths.length) scopeFail('SCOPE_EMPTY');
  return paths.map((value) => {
    const rel = scopePath(value);
    const observed = readSha(rel);
    if (observed === null) scopeFail('SCOPE_FORWARD_FROZEN_MISSING', rel);
    return { path: rel, kind: 'forward_frozen', sha: observed, reason };
  });
}

export function generateReviewScope(root, { taskId, taskFingerprint, approvalHash, base, round, entries, ignoredPathspecs = [], reviewedManifestPaths = [], reviewOutputPaths = [] }) {
  const head = gitHead(root);
  const changedSet = collectChangedSet(root, base, { ignoredPathspecs, reviewedManifestPaths, reviewOutputPaths });
  const manifest = buildReviewScope({ changedSet, entries, taskId, taskFingerprint, approvalHash, base, head, round, ignoredPathspecs, reviewedManifestPaths, reviewOutputPaths });
  // Generation refuses to emit a scope whose real bytes do not match the classification.
  return verifyReviewScope(manifest, { changedSet, ignoredPathspecs, reviewedManifestPaths, reviewOutputPaths: manifest.reviewOutputPaths, readSha: worktreeReadSha(root), current: true });
}

export function serializeReviewScope(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Write only a scope that re-verifies against itself. */
export function writeReviewScope(scopeFile, manifest) {
  const byPath = normalizeScopeEntries(manifest.entries);
  const clean = {
    version: REVIEW_SCOPE_VERSION,
    taskId: manifest.taskId,
    taskFingerprint: manifest.taskFingerprint,
    approvalHash: manifest.approvalHash,
    base: manifest.base,
    head: manifest.head,
    round: manifest.round,
    ignoredPathspecs: requireBound(manifest.ignoredPathspecs),
    reviewOutputPaths: requireOutputPaths(manifest.reviewOutputPaths === undefined ? [] : manifest.reviewOutputPaths),
    entries: sortedEntries(byPath),
    scopeHash: manifest.scopeHash,
  };
  const bytes = Buffer.from(serializeReviewScope(clean), 'utf8');
  verifyReviewScope(JSON.parse(bytes.toString('utf8')), { changedSet: clean.entries.map((entry) => entry.path), ignoredPathspecs: clean.ignoredPathspecs, reviewOutputPaths: clean.reviewOutputPaths, current: false });
  fs.mkdirSync(path.dirname(path.resolve(scopeFile)), { recursive: true });
  fs.writeFileSync(scopeFile, bytes);
  return { scopeFile: path.resolve(scopeFile), manifestHash: sha(bytes) };
}

/**
 * Re-verify a written scope against the real worktree: the real change set, the real bytes of
 * every classified path, the official base commit for every protected path, and the official
 * task/approval anchors under `.ai/`.
 */
export function verifyReviewScopeAtRoot(root, scopeFile, { ignoredPathspecs, expectedScopeHash = '', reviewedManifestPaths = [], current = true } = {}) {
  const manifest = JSON.parse(regular(scopeFile).toString('utf8'));
  requireBindings(manifest, {});
  const rootAbs = path.resolve(root);
  // The registered output list is re-read from the official `.ai/current-task.json`; a request
  // or a scope may never widen or narrow it. A legacy task with no field registers nothing.
  const task = current ? JSON.parse(regular(path.join(rootAbs, '.ai', 'current-task.json')).toString('utf8')) : undefined;
  const officialOutputs = requireOutputPaths(
    current
      ? (task.reviewOutputPaths === undefined ? [] : task.reviewOutputPaths)
      : (manifest.reviewOutputPaths === undefined ? [] : manifest.reviewOutputPaths),
  );
  const result = verifyReviewScope(manifest, {
    changedSet: collectChangedSet(root, manifest.base, { ignoredPathspecs, reviewedManifestPaths, reviewOutputPaths: officialOutputs }),
    ignoredPathspecs,
    expectedScopeHash,
    reviewedManifestPaths,
    reviewOutputPaths: officialOutputs,
    readSha: worktreeReadSha(root),
    current,
  });
  if (current) {
    // A registered output that exists must be a regular file: a directory or symlink where a
    // task output was registered is a replaced path and fails closed.
    for (const rel of officialOutputs) {
      let stat;
      try { stat = fs.lstatSync(path.join(rootAbs, rel)); } catch (error) { if (error && error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) scopeFail('SCOPE_TASK_OUTPUT_NOT_FILE', rel);
    }
    const approvalHash = sha(regular(path.join(rootAbs, '.ai', 'approval.json')));
    if (manifest.approvalHash !== approvalHash) scopeFail('SCOPE_APPROVAL_MISMATCH', 'the recorded approval hash is not the official .ai/approval.json');
    if (manifest.taskId !== task.taskId || manifest.taskFingerprint !== task.taskFingerprint) scopeFail('SCOPE_TASK_MISMATCH', 'the recorded task binding is not the official .ai/current-task.json');
    if (manifest.head !== gitHead(root)) scopeFail('SCOPE_HEAD_MISMATCH', 'HEAD moved since the scope was generated');
    for (const entry of manifest.entries.filter((item) => item.kind === 'protected')) {
      const run = spawnSync('git', ['-C', root, 'cat-file', '-e', `${manifest.base}:${entry.path}`], { encoding: 'utf8' });
      if (run.status !== 0) scopeFail('SCOPE_PROTECTED_NOT_AT_BASE', entry.path);
    }
  }
  return { ...result, scopeFile: path.resolve(scopeFile), manifestHash: sha(regular(scopeFile)) };
}
