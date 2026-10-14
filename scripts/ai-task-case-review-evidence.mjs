import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ensureRegularFile, readJson, resolveRepoPath } from './ai-e2e-lib.mjs';

function fail(message) { throw new Error(`TASK_CASE_REVIEW_EVIDENCE_ERROR: ${message}`); }
function assertNonEmpty(value, label) { if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`); return value; }
function assertObject(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`); return value; }
function sha256(data) { return createHash('sha256').update(data).digest('hex'); }
function sha256File(filePath) { return sha256(readFileSync(filePath)); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) fail(`${label} must be a sha256 hex digest`);
  return value;
}
function validateFileRef(root, ref, label) {
  assertObject(ref, label);
  assertNonEmpty(ref.path, `${label}.path`);
  assertSha256(ref.sha256, `${label}.sha256`);
  const abs = resolveRepoPath(root, ref.path, label);
  ensureRegularFile(abs, label);
  const actual = sha256File(abs);
  if (actual !== ref.sha256) fail(`${label} sha256 mismatch`);
  return { abs, sha256: actual };
}
function argvOption(argv, name) {
  if (!Array.isArray(argv)) return null;
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  const prefix = `${name}=`;
  const found = argv.find((arg) => typeof arg === 'string' && arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}
function validateUsage(usage) {
  assertObject(usage, 'review usage');
  const nums = Object.values(usage).filter((value) => Number.isFinite(value));
  if (nums.length === 0) fail('review usage requires numeric values');
  if (nums.some((value) => value < 0)) fail('review usage invalid');
  return usage;
}
function extractJsonObjects(text) {
  const source = String(text || '');
  const objects = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = index; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === '{') {
        depth += 1;
        continue;
      }
      if (character !== '}') continue;
      depth -= 1;
      if (depth !== 0) continue;
      const candidate = source.slice(index, cursor + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) objects.push(parsed);
      } catch {
        // Not a complete JSON object from this opening brace; keep scanning.
      }
      index = cursor;
      break;
    }
  }
  return objects;
}
function parseActualReportVerdict(verdict, { binding, requestNonce, request }) {
  if (verdict.verdict !== 'passed') fail(`review verdict not passed: ${String(verdict.verdict)}${verdict.severity ? `/${verdict.severity}` : ''}`);
  if (verdict.independent !== true) fail('review verdict independent required');
  for (const [field, value] of Object.entries(binding)) {
    if (verdict[field] !== value) fail(`review verdict binding mismatch: ${field}`);
  }
  if (verdict.requestNonce !== requestNonce) fail('review verdict nonce mismatch');
  if (verdict.requestId !== request.requestId) fail('review verdict requestId mismatch');
  if (verdict.reviewer !== request.reviewer) fail('review verdict reviewer mismatch');
  if (verdict.model !== request.model) fail('review verdict model mismatch');
  if (String(verdict.effort || '').toLowerCase() !== String(request.effort || '').toLowerCase()) fail('review verdict effort mismatch');
  return verdict;
}

function parseLegacyVerdict(verdict, { binding, requestNonce, promptSha256, request }) {
  if (verdict.verdict !== 'passed') fail(`review verdict not passed: ${String(verdict.verdict)}${verdict.severity ? `/${verdict.severity}` : ''}`);
  if (!verdict.binding || canonicalJson(verdict.binding) !== canonicalJson(binding)) fail('review verdict binding mismatch');
  if (verdict.nonce !== requestNonce) fail('review verdict nonce mismatch');
  if (verdict.promptSha256 !== promptSha256) fail('review verdict prompt hash mismatch');
  if (verdict.reviewer !== request.reviewer) fail('review verdict reviewer mismatch');
  if (verdict.requestId !== request.requestId) fail('review verdict requestId mismatch');
  if (verdict.model && verdict.model !== request.model) fail('review verdict model mismatch');
  if (verdict.effort && String(verdict.effort).toLowerCase() !== String(request.effort || '').toLowerCase()) fail('review verdict effort mismatch');
  return verdict;
}

function parseVerdictBody(body, { binding, requestNonce, promptSha256, request }) {
  const text = String(body || '');
  if (!text.trim()) fail('review original body missing');
  const objects = extractJsonObjects(text);
  const actualReports = objects.filter((item) => item.kind === 'actual_report_independent_review');
  const legacyVerdicts = objects.filter((item) => item.kind === 'ai-review-verdict');
  if (actualReports.length > 1 || legacyVerdicts.length > 1 || (actualReports.length > 0 && legacyVerdicts.length > 0)) {
    fail('review verdict ambiguous');
  }
  if (actualReports.length === 1) return parseActualReportVerdict(actualReports[0], { binding, requestNonce, request });
  if (legacyVerdicts.length === 1) return parseLegacyVerdict(legacyVerdicts[0], { binding, requestNonce, promptSha256, request });
  fail('review verdict missing');
}
function extractProSol(text) {
  let model; let effort; let sessionId; let lastAssistant = null; let lastUsage = null;
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj; try { obj = JSON.parse(s); } catch { continue; }
    const p = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj;
    if (obj.type === 'session_meta') sessionId = p.id || sessionId;
    if (obj.type === 'turn_context') { model = p.model || model; effort = p.effort || p.reasoning_effort || effort; }
    if (obj.type === 'response_item' && p.role === 'assistant' && String(p.phase || '').toLowerCase() === 'final_answer') lastAssistant = p;
    if (obj.type === 'token_count' && p.usage) lastUsage = p.usage;
    if (obj.type === 'event_msg' && p.type === 'token_count') {
      const info = p.info && typeof p.info === 'object' ? p.info : p;
      lastUsage = info.last_token_usage || info.total_token_usage || info.usage || lastUsage;
    }
  }
  if (!lastAssistant) fail('pro-sol final assistant missing');
  const content = Array.isArray(lastAssistant.content)
    ? lastAssistant.content.map((c) => (typeof c === 'string' ? c : c?.text || c?.output_text || '')).join('')
    : String(lastAssistant.output_text || lastAssistant.content || lastAssistant.text || '');
  return { provider: 'pro-sol', model, effort, id: sessionId || lastAssistant.id, requestId: lastAssistant.request_id || null, transportStatus: 'completed', usage: lastUsage, originalBody: content };
}
function extractMaxOpus(rawText, request) {
  let r; try { r = JSON.parse(rawText); } catch (error) { fail(`max-opus raw JSON invalid: ${error.message}`); }
  if (!r || r.type !== 'result') fail('max-opus raw type invalid');
  if (r.subtype !== 'success') fail('max-opus subtype invalid');
  if (r.is_error === true) fail('max-opus error');
  const expectedModel = 'claude-opus-5-5';
  const expectedEffort = 'high';
  const modelKeys = Object.keys(r.modelUsage || {});
  if (modelKeys.length !== 1) fail('max-opus model usage invalid');
  const rawModel = modelKeys[0];
  if (rawModel !== expectedModel) fail('max-opus model mismatch');
  for (const modelKey of modelKeys) {
    const usage = r.modelUsage[modelKey];
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;
    if (usage.canonicalModel === undefined || usage.canonicalModel === null) continue;
    if (typeof usage.canonicalModel !== 'string' || !usage.canonicalModel.trim()) fail('max-opus modelUsage canonicalModel invalid');
    if (usage.canonicalModel !== expectedModel) fail('max-opus modelUsage canonicalModel mismatch');
  }
  const modelFields = [
    ['model', r.model],
    ['request.model', r.request?.model],
    ['input.model', r.input?.model],
  ];
  for (const [label, value] of modelFields) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value.trim()) fail(`max-opus ${label} invalid`);
    if (value !== expectedModel) fail(`max-opus ${label} mismatch`);
  }
  const effortFields = [
    ['effort', r.effort],
    ['reasoning_effort', r.reasoning_effort],
    ['request.effort', r.request?.effort],
    ['request.reasoning_effort', r.request?.reasoning_effort],
    ['input.effort', r.input?.effort],
    ['input.reasoning_effort', r.input?.reasoning_effort],
  ];
  let effort = null;
  for (const [label, value] of effortFields) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value.trim()) fail(`max-opus ${label} invalid`);
    if (value.toLowerCase() !== expectedEffort) fail(`max-opus ${label} mismatch`);
    effort = expectedEffort;
  }
  if (effort === null) {
    if (!request?.sentPromptRef || !request?.runtimeInputRef) fail('max-opus raw effort absent requires sentPromptRef and runtimeInputRef');
    if (!Array.isArray(request.argv)) fail('max-opus raw effort absent requires exact argv');
    const argvModel = argvOption(request.argv, '--model');
    if (argvModel !== expectedModel) fail('max-opus argv model mismatch');
    const argvEffort = argvOption(request.argv, '--effort');
    if (argvEffort !== expectedEffort) fail('max-opus argv effort mismatch');
    effort = argvEffort;
  }
  return { provider: 'max-opus', model: rawModel, effort, id: r.session_id, requestId: r.request_id || null, transportStatus: r.subtype, usage: r.modelUsage[rawModel], originalBody: String(r.result || '') };
}
const ADAPTERS = Object.freeze({
  'pro-sol': { name: 'pro-sol', provider: 'pro-sol', model: 'gpt-6.1-sol', effort: 'medium', extract: extractProSol },
  'max-opus': { name: 'max-opus', provider: 'max-opus', model: 'claude-opus-5-5', effort: 'high', extract: extractMaxOpus },
});
function adapterFor(name) { const adapter = ADAPTERS[name]; if (!adapter) fail(`unsupported review adapter: ${String(name)}`); return adapter; }
function validateRequestBinding(request, binding, adapter, expectedReviewer, { root } = {}) {
  assertObject(request, 'review request');
  if (request.kind !== 'case_native_review_request') fail('review request kind mismatch');
  if (request.schemaVersion !== 1) fail('review request schemaVersion mismatch');
  for (const [field, value] of Object.entries(binding)) {
    if (request[field] !== value) fail(`review request ${field} mismatch`);
  }
  if (request.adapter !== adapter.name) fail('review request adapter mismatch');
  if (request.model !== adapter.model) fail('review request model mismatch');
  if (request.effort !== adapter.effort) fail('review request effort mismatch');
  assertNonEmpty(request.reviewer, 'review request reviewer');
  if (request.reviewer === binding.owner) fail('review request reviewer equals implementer');
  if (expectedReviewer && request.reviewer !== expectedReviewer) fail('review request reviewer mismatch');
  assertNonEmpty(request.requestNonce, 'review request requestNonce');
  assertNonEmpty(request.requestId, 'review request requestId');
  const promptSha256 = request.promptSha256 || request.sentPromptRef?.sha256;
  assertSha256(promptSha256, 'review request promptSha256');
  if (request.promptSha256 && request.sentPromptRef?.sha256 && request.promptSha256 !== request.sentPromptRef.sha256) {
    fail('review request promptSha256 mismatch with sentPromptRef');
  }
  if (Array.isArray(request.argv)) {
    const argvModel = argvOption(request.argv, '--model');
    if (argvModel && argvModel !== request.model) fail('review request argv model mismatch');
    const argvEffort = argvOption(request.argv, '--effort');
    if (argvEffort && argvEffort !== request.effort) fail('review request argv effort mismatch');
  }
  if (request.sentPromptRef !== undefined) {
    const sent = validateFileRef(root, request.sentPromptRef, 'review request sentPromptRef');
    if (promptSha256 !== sent.sha256) fail('review request sentPromptRef sha256 mismatch');
  }
  if (request.runtimeInputRef !== undefined) {
    const runtimeRef = validateFileRef(root, request.runtimeInputRef, 'review request runtimeInputRef');
    const runtimeInput = readJson(runtimeRef.abs);
    assertObject(runtimeInput, 'review runtime input');
    if (runtimeInput.binding && typeof runtimeInput.binding === 'object') {
      for (const [field, value] of Object.entries(binding)) {
        if (runtimeInput.binding[field] !== value) fail(`review runtime input binding ${field} mismatch`);
      }
    }
    if (runtimeInput.requestId === undefined || runtimeInput.requestId !== request.requestId) fail('review runtime input requestId mismatch');
    if (runtimeInput.requestNonce === undefined || runtimeInput.requestNonce !== request.requestNonce) fail('review runtime input requestNonce mismatch');
    if (runtimeInput.promptSha256 === undefined || runtimeInput.promptSha256 !== promptSha256) fail('review runtime input promptSha256 mismatch');
    if (runtimeInput.model === undefined || runtimeInput.model !== request.model) fail('review runtime input model mismatch');
    if (runtimeInput.effort === undefined || runtimeInput.effort !== request.effort) fail('review runtime input effort mismatch');
    if (!Array.isArray(request.argv)) fail('review request argv required with runtimeInputRef');
    if (!Array.isArray(runtimeInput.argv) || canonicalJson(runtimeInput.argv) !== canonicalJson(request.argv)) {
      fail('review runtime input argv mismatch');
    }
  }
  return { promptSha256 };
}
export function validateCaseReviewRawEvidence({ root, binding, reviewRawRef, requestRef, expectedReviewer = null }) {
  assertObject(binding, 'binding');
  assertObject(reviewRawRef, 'reviewRawRef');
  assertObject(requestRef, 'requestRef');
  assertNonEmpty(reviewRawRef.path, 'reviewRawRef.path');
  assertNonEmpty(reviewRawRef.sha256, 'reviewRawRef.sha256');
  assertNonEmpty(requestRef.path, 'requestRef.path');
  assertNonEmpty(requestRef.sha256, 'requestRef.sha256');
  const rawAbs = resolveRepoPath(root, reviewRawRef.path, 'review raw');
  ensureRegularFile(rawAbs, 'review raw');
  const rawHash = sha256File(rawAbs);
  if (rawHash !== reviewRawRef.sha256) fail('review raw sha256 mismatch');
  const reqAbs = resolveRepoPath(root, requestRef.path, 'review request');
  ensureRegularFile(reqAbs, 'review request');
  const reqHash = sha256File(reqAbs);
  if (reqHash !== requestRef.sha256) fail('review request sha256 mismatch');
  const request = readJson(reqAbs);
  const adapter = adapterFor(request.adapter);
  const requestBinding = validateRequestBinding(request, binding, adapter, expectedReviewer, { root });
  const extracted = adapter.extract(readFileSync(rawAbs, 'utf8'), request);
  if (!extracted || extracted.provider !== adapter.provider) fail('review provider mismatch');
  if (!extracted.model || typeof extracted.model !== 'string' || !extracted.model.trim()) fail('review model evidence missing');
  if (!extracted.effort || typeof extracted.effort !== 'string' || !extracted.effort.trim()) fail('review effort evidence missing');
  if (extracted.model !== adapter.model) fail('review model mismatch');
  if (String(extracted.effort).toLowerCase() !== adapter.effort) fail('review effort mismatch');
  if (!extracted.id || typeof extracted.id !== 'string') fail('review real id required');
  if (extracted.requestId && extracted.requestId !== request.requestId) fail('review requestId mismatch');
  validateUsage(extracted.usage);
  const originalBodyHash = sha256(String(extracted.originalBody || ''));
  const verdict = parseVerdictBody(extracted.originalBody, { binding, requestNonce: request.requestNonce, promptSha256: requestBinding.promptSha256, request });
  if (verdict.sessionId && verdict.sessionId !== extracted.id) fail('review verdict sessionId mismatch');
  return {
    provider: extracted.provider,
    model: extracted.model,
    effort: extracted.effort,
    reviewer: request.reviewer,
    requestId: request.requestId,
    sessionId: extracted.id,
    usage: extracted.usage,
    originalBodyHash,
    rawSha256: rawHash,
    requestSha256: reqHash,
    requestNonce: request.requestNonce,
    rawPath: reviewRawRef.path,
    requestPath: requestRef.path,
  };
}