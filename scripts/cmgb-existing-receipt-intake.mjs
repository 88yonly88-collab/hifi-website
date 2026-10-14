// Completion-only CMGB existing-receipt intake verifier.
// This module is pure: it reads pinned evidence, validates the native owner
// criterion, and never writes state, dispatches, resends, resets reviews,
// releases stops, or creates a provider PASS record.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApproval } from './ai-approval-lib.mjs';

const REPO = 'cookingmangaGeneratorB';
const TASK_ID = 'cmgb-production-contract-integration-20261009';
const TASK_FINGERPRINT = 'cookingmangaGeneratorB|fix|image-review-integration-20261007';
const SCOPE = 'cmgb-existing-receipt-intake-only';
const MARKER = 'cmgbExistingReceiptIntake:';
const RECORD_IDS = ['DS1', 'DS2R', 'DS3', 'SOL1', 'SOL2', 'OPUS1'];
const EVIDENCE_NAMES = [
  'secret_exclusion_delivery',
  'two_cut_ng_retains_a',
  'cas409',
  'restart_counts_id400_other168_memos',
  'history_wav_pdf',
  'backup_conflicts_source_ownership',
  'canonical_e2e',
  'no_required_unknowns',
];
const RESOLUTION_KEYS = [
  'DS1:0', 'DS1:1', 'DS1:2', 'DS1:3', 'DS1:4',
  'DS2R:0', 'DS2R:1', 'DS2R:2',
  'DS3:0', 'DS3:1', 'DS3:2',
];
const NONBLOCKING_KEYS = new Set(['DS1:3', 'DS1:4']);
const COMPLETION_EXPIRY_KEYS = ['completionExpiresAt', 'completionOnlyExpiresAt', 'freeCompletionExpiresAt'];
const ORIGINAL_CUTOFF_KEYS = ['originalSendDeadline', 'originalCutoff', 'sendDeadline'];

function fail(code) { throw new Error(code); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameJson(left, right) {
  const canon = (value) => {
    if (Array.isArray(value)) return value.map(canon);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])]));
    return value;
  };
  return JSON.stringify(canon(left)) === JSON.stringify(canon(right));
}
function firstDefined(record, keys) {
  for (const key of keys) {
    if (record && Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}
function explicitCompletionExpiry(policy) {
  return firstDefined(policy, COMPLETION_EXPIRY_KEYS);
}
function explicitOriginalCutoff(policy) {
  return firstDefined(policy, ORIGINAL_CUTOFF_KEYS);
}
function parseTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(label);
  return timestamp;
}
function resolvePinPath(root, pinPath) {
  if (typeof pinPath !== 'string' || pinPath.length === 0) fail('CMGB_INTAKE_PIN_PATH_MISSING');
  return isAbsolute(pinPath) ? pinPath : resolve(root, pinPath);
}
function readRegular(path, label) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) fail(`${label}_MISSING`);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label}_NOT_REGULAR_FILE`);
  return readFileSync(absolute);
}
function pinned(root, pin, label = 'CMGB_INTAKE_ARTIFACT') {
  if (!pin || typeof pin !== 'object') fail(`${label}_INVALID`);
  if (typeof pin.path !== 'string' || pin.path.length === 0) fail(`${label}_PATH_MISSING`);
  if (!/^[a-f0-9]{64}$/u.test(String(pin.sha256 || ''))) fail(`${label}_SHA_INVALID`);
  const bytes = readRegular(resolvePinPath(root, pin.path), label);
  if (sha256(bytes) !== pin.sha256) fail(`${label}_CHANGED`);
  if (pin.bytes !== undefined && (!Number.isInteger(pin.bytes) || bytes.length !== pin.bytes)) fail(`${label}_SIZE_CHANGED`);
  return bytes;
}
function pinnedJson(root, pin, label) {
  return JSON.parse(pinned(root, pin, label).toString('utf8'));
}
function pointer(value, pointerText) {
  if (typeof pointerText !== 'string' || !pointerText.startsWith('/') || pointerText.length < 2) fail('CMGB_INTAKE_ASSERTION_POINTER_INVALID');
  return pointerText.slice(1).split('/').reduce((current, rawKey) => {
    const key = rawKey.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) fail('CMGB_INTAKE_ASSERTION_MISSING');
    return current[key];
  }, value);
}
function gitHead(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    fail('CMGB_INTAKE_GIT_HEAD_UNAVAILABLE');
  }
}
function rawApprovalHasCriterion(root) {
  const approvalPath = join(root, '.ai', 'approval.json');
  if (!existsSync(approvalPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(approvalPath, 'utf8'));
    if (raw?.status !== 'approved' || !Array.isArray(raw.completionCriteria)) return false;
    return raw.completionCriteria.some((criterion) => typeof criterion === 'string' && criterion.includes(MARKER));
  } catch {
    return false;
  }
}
function assertEvidence(root, entry, bundle, label) {
  if (!entry || typeof entry !== 'object') fail(`${label}_INVALID`);
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) fail(`${label}_WEAK_PROOF`);
  if (!['review_resolution', 'normal_gate', 'sender_authentication'].includes(entry.stage)) fail(`${label}_STAGE_INVALID`);
  if (!Array.isArray(entry.assertions) || entry.assertions.length === 0) fail(`${label}_ASSERTION_MISSING`);
  for (const assertion of entry.assertions) {
    if (!assertion || typeof assertion !== 'object' || !Object.prototype.hasOwnProperty.call(assertion, 'equals')) fail(`${label}_ASSERTION_INVALID`);
    const artifact = pinnedJson(root, assertion.artifact, `${label}_ARTIFACT`);
    const actual = pointer(artifact, assertion.pointer);
    if (!sameJson(actual, assertion.equals)) fail(`${label}_ASSERTION_FAILED`);
  }
  if (Array.isArray(entry.reviewers) && entry.reviewers.length > 0) {
    for (const reviewerId of entry.reviewers) {
      const reviewer = bundle.records.find((record) => record.id === reviewerId);
      if (!reviewer) fail(`${label}_REVIEWER_MISSING`);
      if (reviewer.verdict !== 'pass' || !Array.isArray(reviewer.findings) || reviewer.findings.length !== 0 || !Array.isArray(reviewer.unverified) || reviewer.unverified.length !== 0) fail(`${label}_REVIEWER_NOT_PASS`);
    }
  } else if (entry.stage === 'review_resolution') {
    fail(`${label}_REVIEWERS_REQUIRED`);
  }
}
function parseJsonBody(text, label) {
  const normalized = String(text).trim().replace(/^```(?:json)?\s*|\s*```$/gu, '');
  try {
    return JSON.parse(normalized);
  } catch {
    fail(`${label}_JSON_INVALID`);
  }
}
function extractOriginalProviderBody(root, record) {
  const bytes = pinned(root, record.original, 'CMGB_INTAKE_ORIGINAL');
  const text = bytes.toString('utf8');
  if (record.id.startsWith('DS')) {
    const original = parseJsonBody(text, 'CMGB_INTAKE_ORIGINAL');
    const content = original?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') fail('CMGB_INTAKE_ORIGINAL_SHAPE');
    return { body: parseJsonBody(content, 'CMGB_INTAKE_ORIGINAL_BODY'), usage: original.usage };
  }
  if (record.id.startsWith('SOL')) {
    return { body: parseJsonBody(text, 'CMGB_INTAKE_ORIGINAL_BODY'), usage: record.usage };
  }
  if (record.id.startsWith('OPUS')) {
    const original = parseJsonBody(text, 'CMGB_INTAKE_ORIGINAL');
    if (typeof original?.result !== 'string') fail('CMGB_INTAKE_ORIGINAL_SHAPE');
    return { body: parseJsonBody(original.result, 'CMGB_INTAKE_ORIGINAL_BODY'), usage: original.usage };
  }
  fail('CMGB_INTAKE_RECORD_ID_UNKNOWN');
}
function verifyManifestRows(root, bundle) {
  const manifest = pinnedJson(root, bundle.manifest, 'CMGB_INTAKE_MANIFEST');
  if (!Array.isArray(manifest.rows)) fail('CMGB_INTAKE_MANIFEST_ROWS');
  for (const row of manifest.rows) {
    if (!row || typeof row.path !== 'string' || !/^[a-f0-9]{64}$/u.test(String(row.sha256 || ''))) fail('CMGB_INTAKE_MANIFEST_ROW_INVALID');
    const absolute = resolvePinPath(root, row.path);
    const bytes = readRegular(absolute, 'CMGB_INTAKE_MANIFEST_ROW');
    if (row.bytes !== undefined && (!Number.isInteger(row.bytes) || bytes.length !== row.bytes)) fail('CMGB_INTAKE_MANIFEST_ROW_BYTES');
    if (sha256(bytes) !== row.sha256) fail('CMGB_INTAKE_MANIFEST_ROW_HASH');
  }
}
function validateRecords(root, bundle, policy, contract) {
  verifyManifestRows(root, bundle);
  if (!Array.isArray(bundle.records) || bundle.records.length !== RECORD_IDS.length) fail('CMGB_INTAKE_RECORDS_INCOMPLETE');
  if (!sameJson(bundle.records.map((record) => record.id), RECORD_IDS)) fail('CMGB_INTAKE_RECORDS_ORDER');
  const plan = bundle.plan ? pinnedJson(root, bundle.plan, 'CMGB_INTAKE_PLAN') : null;
  const contractResolutions = Array.isArray(contract.preparedResolutionMappings)
    ? new Map(contract.preparedResolutionMappings.map((mapping) => [mapping.key, mapping]))
    : null;
  for (const record of bundle.records) {
    const derived = pinnedJson(root, record.derivedResult, 'CMGB_INTAKE_DERIVED');
    const original = extractOriginalProviderBody(root, record);
    for (const key of Object.keys(original.body)) {
      if (!sameJson(derived[key], original.body[key])) fail('CMGB_INTAKE_DERIVED_FIELD_MISMATCH');
    }
    if (original.usage && !sameJson(record.usage, original.usage)) fail('CMGB_INTAKE_USAGE_MISMATCH');
    if (derived.actualUsage && !sameJson(derived.actualUsage, record.usage)) fail('CMGB_INTAKE_DERIVED_USAGE_MISMATCH');
    pinned(root, record.actualInput, 'CMGB_INTAKE_ACTUAL_INPUT');
    const preflight = pinnedJson(root, record.preflight, 'CMGB_INTAKE_PREFLIGHT');
    if (preflight.inputSha256 !== record.actualInput.sha256 || preflight.fullBodiesVerified !== true) fail('CMGB_INTAKE_PREFLIGHT_INVALID');
    if (!Array.isArray(record.transport) || record.transport.length === 0) fail('CMGB_INTAKE_TRANSPORT_MISSING');
    for (const transportPin of record.transport) pinned(root, transportPin, 'CMGB_INTAKE_TRANSPORT');
    if (!record.usage || typeof record.usage !== 'object') fail('CMGB_INTAKE_USAGE_MISSING');
    const receipt = original.body.receipt;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('CMGB_INTAKE_RECEIPT_MISSING');
    const packetId = record.logicalPacketId ?? record.id;
    if (receipt.packetId !== packetId) fail('CMGB_INTAKE_RECEIPT_PACKET_MISMATCH');
    if (receipt.manifestSha256 !== policy.manifestSha256) fail('CMGB_INTAKE_RECEIPT_MANIFEST_MISMATCH');
    if (receipt.fullInputReceived !== true) fail('CMGB_INTAKE_RECEIPT_INPUT_INCOMPLETE');
    if (!Array.isArray(receipt.inputOmissions) || receipt.inputOmissions.length !== 0) fail('CMGB_INTAKE_RECEIPT_OMISSIONS');
    if (!Array.isArray(receipt.bodies)) fail('CMGB_INTAKE_RECEIPT_BODIES_MISSING');
    if (record.bodyCount !== undefined && receipt.bodies.length !== record.bodyCount) fail('CMGB_INTAKE_RECEIPT_BODY_COUNT');
    for (const bodyRow of receipt.bodies) {
      if (!bodyRow || typeof bodyRow.path !== 'string' || !/^[a-f0-9]{64}$/u.test(String(bodyRow.sha256 || ''))) fail('CMGB_INTAKE_RECEIPT_BODY_ROW');
      if (bodyRow.startAcknowledged !== true || bodyRow.endAcknowledged !== true) fail('CMGB_INTAKE_RECEIPT_BODY_MARKERS');
    }
    if (plan) {
      const planRecord = plan.records?.find((candidate) => candidate.id === record.id)
        || plan.records?.find((candidate) => (candidate.logicalPacketId ?? candidate.id) === packetId);
      if (!planRecord || !Array.isArray(planRecord.bodies)) fail('CMGB_INTAKE_PLAN_RECORD_MISSING');
      const expected = planRecord.bodies.map(({ kind, path, sha256 }) => ({ kind, path, sha256 }));
      const actual = receipt.bodies.map(({ kind, path, sha256 }) => ({ kind, path, sha256 }));
      if (actual.length === expected.length) {
        if (!sameJson(actual, expected)) fail('CMGB_INTAKE_RECEIPT_BODIES_MISMATCH');
      } else {
        if (actual.length <= expected.length) fail('CMGB_INTAKE_RECEIPT_BODIES_MISMATCH');
        if (!sameJson(actual.slice(actual.length - expected.length), expected)) fail('CMGB_INTAKE_RECEIPT_BODIES_MISMATCH');
      }
    }
    if (record.id.startsWith('DS')) {
      if (record.verdict !== 'unverified' || !Array.isArray(record.findings) || record.findings.length !== 0) fail('CMGB_INTAKE_DS_VERDICT_CHANGED');
      if (!Array.isArray(original.body.unverified)) fail('CMGB_INTAKE_DS_UNVERIFIED_MISSING');
      if (!sameJson(record.unverified, original.body.unverified)) fail('CMGB_INTAKE_DS_UNVERIFIED_CHANGED');
      if (contractResolutions) {
        for (let index = 0; index < original.body.unverified.length; index += 1) {
          const key = `${record.id}:${index}`;
          const mapping = contractResolutions.get(key);
          if (!mapping) fail('CMGB_INTAKE_CONTRACT_RESOLUTION_MISSING');
          if (!sameJson(mapping.originalItem, original.body.unverified[index])) fail('CMGB_INTAKE_RESOLUTION_ORIGINAL_ITEM_MISMATCH');
          const policyEntry = policy.resolutions.find((entry) => entry.key === key);
          if (!policyEntry) fail('CMGB_INTAKE_RESOLUTION_MISSING');
          if (policyEntry.state !== mapping.proposedState) fail('CMGB_INTAKE_RESOLUTION_STATE_MISMATCH');
        }
      }
    } else if (record.verdict !== 'pass' || !Array.isArray(record.findings) || record.findings.length !== 0 || !Array.isArray(record.unverified) || record.unverified.length !== 0) {
      fail('CMGB_INTAKE_REVIEWER_VERDICT_INVALID');
    }
  }
}
function invokeCanonicalVerifier(root, policy) {
  if (!policy.receiptVerifierPath || !policy.receiptVerifierSha256) return;
  const verifierPath = resolvePinPath(root, policy.receiptVerifierPath);
  const bytes = readRegular(verifierPath, 'CMGB_INTAKE_RECEIPT_VERIFIER');
  if (sha256(bytes) !== policy.receiptVerifierSha256) fail('CMGB_INTAKE_RECEIPT_VERIFIER_CHANGED');
  if (!verifierPath.endsWith('/prepare-receipt-intake.mjs')) return;
  const contractPath = resolvePinPath(root, policy.contractPath);
  const marker = '/.ai/';
  const markerIndex = contractPath.indexOf(marker);
  const cwd = markerIndex > 0 ? contractPath.slice(0, markerIndex) : root;
  try {
    execFileSync(process.execPath, [verifierPath, '--verify-only'], {
      cwd,
      timeout: 120000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    fail('CMGB_INTAKE_CANONICAL_VERIFIER_FAILED');
  }
}
function validatePolicyIdentity(root, policy, bundle, contract) {
  if (policy.scope !== SCOPE) fail('CMGB_INTAKE_SCOPE_MISMATCH');
  if (policy.taskId !== TASK_ID || policy.purposeFingerprint !== TASK_FINGERPRINT) fail('CMGB_INTAKE_TASK_PURPOSE_MISMATCH');
  if (contract.taskId !== TASK_ID || contract.purposeFingerprint !== TASK_FINGERPRINT) fail('CMGB_INTAKE_CONTRACT_TASK_PURPOSE_MISMATCH');
  if (!/^[a-f0-9]{40}$/u.test(String(policy.candidateCommit || ''))) fail('CMGB_INTAKE_CANDIDATE_INVALID');
  if (contract.candidateCommit !== policy.candidateCommit) fail('CMGB_INTAKE_CONTRACT_CANDIDATE_MISMATCH');
  if (contract.manifestSha256 !== policy.manifestSha256) fail('CMGB_INTAKE_CONTRACT_MANIFEST_MISMATCH');
  if (contract.bundleSha256 !== policy.bundleSha256) fail('CMGB_INTAKE_CONTRACT_BUNDLE_MISMATCH');
  if (bundle.taskId !== TASK_ID || bundle.purposeFingerprint !== TASK_FINGERPRINT || bundle.candidateCommit !== policy.candidateCommit) fail('CMGB_INTAKE_BUNDLE_BINDING_MISMATCH');
  if (bundle.sourceFingerprint !== policy.sourceFingerprint) fail('CMGB_INTAKE_SOURCE_MISMATCH');
  if (bundle.manifest?.sha256 !== policy.manifestSha256) fail('CMGB_INTAKE_MANIFEST_MISMATCH');
  pinned(root, bundle.manifest, 'CMGB_INTAKE_MANIFEST');
  const completionExpiry = explicitCompletionExpiry(policy);
  if (completionExpiry !== undefined) {
    const originalCutoff = explicitOriginalCutoff(policy);
    if (originalCutoff === undefined) fail('CMGB_INTAKE_ORIGINAL_CUTOFF_MISSING');
    const originalCutoffTime = parseTimestamp(originalCutoff, 'CMGB_INTAKE_ORIGINAL_CUTOFF_INVALID');
    const completionExpiryTime = parseTimestamp(completionExpiry, 'CMGB_INTAKE_COMPLETION_EXPIRY_INVALID');
    if (Date.now() >= completionExpiryTime) fail('CMGB_INTAKE_EXPIRED');
    if (completionExpiryTime <= originalCutoffTime) fail('CMGB_INTAKE_COMPLETION_EXPIRY_NOT_INDEPENDENT');
    const authority = pinnedJson(root, bundle.authority, 'CMGB_INTAKE_AUTHORITY');
    const authorityCutoff = firstDefined(authority, ['deadline', ...ORIGINAL_CUTOFF_KEYS]);
    if (authorityCutoff === undefined) fail('CMGB_INTAKE_AUTHORITY_CUTOFF_MISSING');
    if (authorityCutoff !== originalCutoff) fail('CMGB_INTAKE_ORIGINAL_CUTOFF_MISMATCH');
  } else if (!Number.isFinite(Date.parse(policy.expiresAt)) || Date.now() >= Date.parse(policy.expiresAt)) {
    fail('CMGB_INTAKE_EXPIRED');
  }
  const selfPath = fileURLToPath(import.meta.url);
  if (sha256(readRegular(selfPath, 'CMGB_INTAKE_VERIFIER')) !== policy.verifierSha256) fail('CMGB_INTAKE_VERIFIER_CHANGED');
  if (sha256(readRegular(resolvePinPath(root, policy.receiptVerifierPath), 'CMGB_INTAKE_RECEIPT_VERIFIER')) !== policy.receiptVerifierSha256) fail('CMGB_INTAKE_RECEIPT_VERIFIER_CHANGED');
  const contractNames = Array.isArray(contract.requiredEvidence) ? contract.requiredEvidence.map((name) => String(name).split(':')[0]) : [];
  if (!sameJson([...contractNames].sort(), [...EVIDENCE_NAMES].sort())) fail('CMGB_INTAKE_CONTRACT_EVIDENCE_MISMATCH');
  if (!Array.isArray(policy.resolutions) || policy.resolutions.length !== RESOLUTION_KEYS.length) fail('CMGB_INTAKE_RESOLUTIONS_INCOMPLETE');
  const resolutionKeys = policy.resolutions.map((entry) => entry?.key);
  if (new Set(resolutionKeys).size !== RESOLUTION_KEYS.length || !sameJson([...resolutionKeys].sort(), [...RESOLUTION_KEYS].sort())) fail('CMGB_INTAKE_RESOLUTIONS_MISMATCH');
  for (const entry of policy.resolutions) {
    if (!entry || entry.state === 'unverified') fail('CMGB_INTAKE_REQUIRED_UNVERIFIED');
    if (!['resolved', 'nonblocking'].includes(entry.state)) fail('CMGB_INTAKE_RESOLUTION_STATE_INVALID');
    if (entry.state === 'nonblocking' && !NONBLOCKING_KEYS.has(entry.key)) fail('CMGB_INTAKE_NONBLOCKING_NOT_ALLOWED');
    assertEvidence(root, entry, bundle, `CMGB_INTAKE_RESOLUTION_${entry.key}`);
  }
  if (!Array.isArray(policy.requiredEvidence) || policy.requiredEvidence.length !== EVIDENCE_NAMES.length) fail('CMGB_INTAKE_EVIDENCE_INCOMPLETE');
  const evidenceNames = policy.requiredEvidence.map((entry) => entry?.name);
  if (new Set(evidenceNames).size !== EVIDENCE_NAMES.length || !sameJson([...evidenceNames].sort(), [...EVIDENCE_NAMES].sort())) fail('CMGB_INTAKE_EVIDENCE_MISMATCH');
  for (const entry of policy.requiredEvidence) {
    if (!entry || entry.state !== 'resolved') fail('CMGB_INTAKE_REQUIRED_UNVERIFIED');
    assertEvidence(root, entry, bundle, `CMGB_INTAKE_EVIDENCE_${entry.name}`);
  }
}
function validateRetainedState(root, policy, bundle) {
  if (!Array.isArray(bundle.retainedHistory) || bundle.retainedHistory.length === 0) fail('CMGB_INTAKE_HISTORY_MISSING');
  for (const pin of bundle.retainedHistory) pinned(root, pin, 'CMGB_INTAKE_HISTORY');
  if (!bundle.retainedFailedDS2 || typeof bundle.retainedFailedDS2 !== 'object') fail('CMGB_INTAKE_DS2_FAILURE_MISSING');
  const ds2 = bundle.retainedFailedDS2;
  if (ds2.call?.id !== 'DS2' || ds2.call?.state !== 'result-or-transport-unconfirmed' || ds2.call?.receiptVerified !== false || ds2.call?.invoiceConfirmed !== false) fail('CMGB_INTAKE_DS2_FAILURE_CHANGED');
  if (!ds2.response) fail('CMGB_INTAKE_DS2_RESPONSE_MISSING');
  pinned(root, ds2.response, 'CMGB_INTAKE_DS2_RESPONSE');
  if (!bundle.retainedSol1Failure || typeof bundle.retainedSol1Failure !== 'object') fail('CMGB_INTAKE_SOL1_FAILURE_MISSING');
  const sol1 = bundle.retainedSol1Failure;
  if (sol1.call?.id !== 'SOL1' || sol1.call?.state !== 'result-or-transport-unconfirmed' || sol1.call?.receiptVerified !== false || sol1.call?.invoiceConfirmed !== false) fail('CMGB_INTAKE_SOL1_FAILURE_CHANGED');
  if (!sol1.reconciliation) fail('CMGB_INTAKE_SOL1_RECONCILIATION_MISSING');
  pinned(root, sol1.reconciliation, 'CMGB_INTAKE_SOL1_RECONCILIATION');
  const secret = policy.requiredEvidence.find((entry) => entry.name === 'secret_exclusion_delivery');
  if (!secret || secret.stage !== 'sender_authentication') fail('CMGB_INTAKE_SECRET_STAGE_INVALID');
  if (!sameJson(secret.actualInputSha256s, bundle.records.map((record) => record.actualInput.sha256))) fail('CMGB_INTAKE_SECRET_INPUT_BINDING_MISMATCH');
  const authority = pinnedJson(root, bundle.authority, 'CMGB_INTAKE_AUTHORITY');
  if (authority.historicalCountersFeesFailuresStopsRetained !== true || authority.additionalCeilingJPYIncludingPrior102 !== 204 || authority.cumulativeCeilingJPY !== 1229) fail('CMGB_INTAKE_AUTHORITY_CHANGED');
  const ledger = pinnedJson(root, bundle.ledger, 'CMGB_INTAKE_LEDGER');
  if (ledger.noCounterReset !== true || ledger.historicalPairsRetained !== 11 || ledger.historicalHeldJPY !== 1025) fail('CMGB_INTAKE_LEDGER_CHANGED');
  if (explicitCompletionExpiry(policy) !== undefined) {
    const originalCutoff = explicitOriginalCutoff(policy);
    const originalCutoffTime = parseTimestamp(originalCutoff, 'CMGB_INTAKE_ORIGINAL_CUTOFF_INVALID');
    if (!Array.isArray(ledger.calls) || ledger.calls.length === 0) fail('CMGB_INTAKE_LEDGER_CALLS_MISSING');
    for (const call of ledger.calls) {
      const startedAt = Date.parse(call?.startedAt);
      if (!Number.isFinite(startedAt)) fail('CMGB_INTAKE_LEDGER_STARTED_AT_INVALID');
      if (startedAt >= originalCutoffTime) fail('CMGB_INTAKE_ORIGINAL_CALL_AFTER_CUTOFF');
    }
  }
  const prior = pinnedJson(root, bundle.practicalEvidence[0], 'CMGB_INTAKE_PRIOR_FAILURE');
  if (prior.passed !== false) fail('CMGB_INTAKE_OLD_FAILURE_ERASED');
  const readback = pinnedJson(root, bundle.practicalEvidence[1], 'CMGB_INTAKE_READBACK');
  if (readback.passed !== true || readback.priorFailedRegexAssertionRetained !== true) fail('CMGB_INTAKE_READBACK_INVALID');
  const e2e = pinnedJson(root, bundle.practicalEvidence[3], 'CMGB_INTAKE_E2E');
  if (e2e.status !== 'passed' || e2e.sourceManifestSha256 !== policy.manifestSha256 || e2e.gitHead !== policy.candidateCommit) fail('CMGB_INTAKE_E2E_MISMATCH');
  if (bundle.historicalCompletedGroups !== 11 || bundle.oldHeldJPY !== 1025 || bundle.newHeldJPY !== 136 || bundle.cumulativeHeldJPY !== 1161 || bundle.cumulativeCeilingJPY !== 1229) fail('CMGB_INTAKE_HISTORY_CHANGED');
}
function provenance(root, policy) {
  return {
    ok: true,
    kind: 'cmgb-intake-only-terminal-provenance',
    taskId: TASK_ID,
    taskFingerprint: TASK_FINGERPRINT,
    purposeFingerprint: TASK_FINGERPRINT,
    candidateCommit: policy.candidateCommit,
    manifestSha256: policy.manifestSha256,
    sourceFingerprint: policy.sourceFingerprint,
    approvalHash: sha256(readRegular(join(root, '.ai', 'approval.json'), 'CMGB_INTAKE_APPROVAL')),
    contractSha256: policy.contractSha256,
    bundleSha256: policy.bundleSha256,
    closureFlags: { completionOnly: true, registryPASS: false, requiredEvidenceVerified: true, originalFailuresRetained: true, normalE2ESeparate: true },
    dispatchAuthority: false,
    registryWritten: false,
    newModelRequests: 0,
    additionalFeeJPY: 0,
  };
}
export function cmgbExistingReceiptIntakeApprovedCriterionPresent(root) {
  return rawApprovalHasCriterion(root);
}
export function verifyCmgbExistingReceiptCompletion(root, suppliedTask) {
  const task = suppliedTask || (existsSync(join(root, '.ai', 'current-task.json')) ? JSON.parse(readFileSync(join(root, '.ai', 'current-task.json'), 'utf8')) : null);
  if (!rawApprovalHasCriterion(root)) return null;
  if (!task || task.repo !== REPO || task.taskId !== TASK_ID || task.taskFingerprint !== TASK_FINGERPRINT) fail('CMGB_INTAKE_TASK_BINDING_MISMATCH');
  let loaded;
  try {
    loaded = loadApproval(root, task, { requireApproved: true });
  } catch (error) {
    throw error;
  }
  if (Array.isArray(loaded.errors) && loaded.errors.length > 0) fail('CMGB_INTAKE_APPROVAL_INVALID');
  const criteria = Array.isArray(loaded?.approval?.completionCriteria) ? loaded.approval.completionCriteria : [];
  const matches = criteria.filter((criterion) => typeof criterion === 'string' && criterion.includes(MARKER));
  if (matches.length !== 1) fail('CMGB_INTAKE_CRITERION_COUNT');
  const markerIndex = matches[0].indexOf(MARKER);
  let policy;
  try {
    policy = JSON.parse(matches[0].slice(markerIndex + MARKER.length).trim());
  } catch {
    fail('CMGB_INTAKE_CRITERION_NOT_JSON');
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('CMGB_INTAKE_CRITERION_NOT_OBJECT');
  const bundle = pinnedJson(root, { path: policy.bundlePath, sha256: policy.bundleSha256 }, 'CMGB_INTAKE_BUNDLE');
  const contract = pinnedJson(root, { path: policy.contractPath, sha256: policy.contractSha256 }, 'CMGB_INTAKE_CONTRACT');
  validatePolicyIdentity(root, policy, bundle, contract);
  validateRecords(root, bundle, policy, contract);
  validateRetainedState(root, policy, bundle);
  invokeCanonicalVerifier(root, policy);
  if (gitHead(root) !== policy.candidateCommit) fail('CMGB_INTAKE_CANDIDATE_CHANGED');
  return provenance(root, policy);
}
