import { loadApproval } from './ai-approval-lib.mjs';
let cmgbIntakeModule = null;
let cmgbIntakeLoadError = null;
try {
  cmgbIntakeModule = await import('./cmgb-existing-receipt-intake.mjs');
  if (typeof cmgbIntakeModule.verifyCmgbExistingReceiptCompletion !== 'function') {
    throw new Error('CMGB_INTAKE_HELPER_EXPORT_MISSING: verifyCmgbExistingReceiptCompletion');
  }
} catch (error) {
  cmgbIntakeModule = null;
  cmgbIntakeLoadError = error;
}
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

export const REVIEW_CYCLE_SCHEMA_VERSION = 1;
export const REVIEW_CYCLE_REGISTRY = 'review-cycle-registry.json';
export const REVIEW_CYCLE_LOCK = 'review-cycle.lock';
export const REVIEW_RECEIPTS_DIR = 'review-receipts';
const MAX_NORMAL_CYCLE = 2;
const ASTRA_CYCLE = 3;
const LIMITED_IMPLEMENTATION_STEP = 'repair';
const LIMITED_REVIEW_STEPS = ['deepseek','sol','opus'];
const STEP_ORDER = { deepseek: 0, sol: 1, repair: 2, practical: 3, opus: 4, 'astra-diagnosis': 5 };
const STEP_MODELS = {
  // 2026-10-13: deepseek step = 一次確認。利用者決定(2026-10-12「レビューだけMax」)どおり max。
  // 実装(repair/実装レーン)は high のまま。sol/opus/astra も変更しない。
  deepseek: { model: 'deepseek-flash', effort: 'max', adapter: 'responses-ds', provider: 'responses-ds' },
  sol: { model: 'gpt-6.1-sol', effort: 'medium', adapter: 'pro-sol', provider: 'pro-sol' },
  opus: { model: 'claude-opus-5-5', effort: 'high', adapter: 'max-opus', provider: 'max-opus' },
  astra: { model: 'gpt-6-astra', effort: 'high', adapter: 'astra', provider: 'astra' },
  practical: { model: 'practical-runner', effort: 'high', adapter: 'practical', provider: 'practical' },
  repair: { model: 'repair-runner', effort: 'high', adapter: 'repair', provider: 'repair' },
};
function extractResponsesText(r) {
  if (!r) return '';
  const root = r.response && typeof r.response === 'object' ? r.response : r;
  if (typeof root.output_text === 'string') return root.output_text;
  if (typeof root.output === 'string') return root.output;
  if (Array.isArray(root.output)) {
    const message = [...root.output].reverse().find((o) => o && typeof o === 'object' && o.type === 'message');
    if (message) {
      if (Array.isArray(message.content)) return message.content.map((c) => {
        if (typeof c === 'string') return c;
        if (c?.type === 'reasoning_text') return '';
        return c?.output_text || c?.text || '';
      }).join('');
      if (typeof message.content === 'string') return message.content;
      return message?.output_text || message?.text || '';
    }
    const hasReasoning = root.output.some((o) => o && typeof o === 'object' && (o.type === 'reasoning' || (Array.isArray(o.content) && o.content.some((c) => c?.type === 'reasoning_text'))));
    if (hasReasoning) return '';
    return root.output.map((o) => {
      if (typeof o === 'string') return o;
      if (o && Array.isArray(o.content)) return o.content.map((c) => (typeof c === 'string' ? c : c?.text || c?.output_text || '')).join('');
      if (o && typeof o.content === 'string') return o.content;
      return o?.text || '';
    }).join('');
  }
  if (Array.isArray(root.choices)) return root.choices.map((c) => c?.message?.content || c?.text || '').join('');
  return '';
}
function parseVerdictBody(text, { candidateHash, purposeId, taskId, nonce }) {
  const body = String(text || '');
  if (!body.trim()) throw new Error('REVIEW_CYCLE_ORIGINAL_BODY_MISSING');
  const m = body.match(/\{[\s\S]*?"kind"\s*:\s*"ai-review-verdict"[\s\S]*?\}/);
  if (!m) throw new Error('REVIEW_CYCLE_ORIGINAL_VERDICT_MISSING');
  let v;
  try { v = JSON.parse(m[0]); } catch (e) { throw new Error(`REVIEW_CYCLE_ORIGINAL_VERDICT_INVALID: ${e.message}`); }
  if (v.kind !== 'ai-review-verdict') throw new Error('REVIEW_CYCLE_ORIGINAL_VERDICT_KIND');
  if (candidateHash && v.candidateHash !== candidateHash) throw new Error('REVIEW_CYCLE_ORIGINAL_VERDICT_CANDIDATE_MISMATCH');
  if (purposeId && v.purposeId !== purposeId) throw new Error('REVIEW_CYCLE_ORIGINAL_VERDICT_PURPOSE_MISMATCH');
  if (taskId && v.taskId !== taskId) throw new Error('REVIEW_CYCLE_ORIGINAL_VERDICT_TASK_MISMATCH');
  if (nonce && v.nonce !== nonce) throw new Error('REVIEW_CYCLE_ORIGINAL_VERDICT_NONCE_MISMATCH');
  if (!v.model || !v.effort || !v.verdict) throw new Error('REVIEW_CYCLE_ORIGINAL_VERDICT_FIELDS_REQUIRED');
  if (!['pass', 'blocked'].includes(v.verdict)) throw new Error('REVIEW_CYCLE_ORIGINAL_VERDICT_VALUE');
  if (v.verdict === 'blocked' && !['P0', 'P1', 'P2', 'P3'].includes(String(v.severity))) throw new Error('REVIEW_CYCLE_ORIGINAL_VERDICT_SEVERITY');
  return v;
}
const ADAPTERS = {
  'responses-ds': {
    provider: 'responses-ds', model: 'deepseek-flash', effort: 'max',
    extract: (r, ctx) => {
      const root = r && r.response && typeof r.response === 'object' ? r.response : r;
      return {
        provider: 'responses-ds',
        model: root?.model,
        effort: root?.reasoning?.effort || root?.effort || ctx?.reservedEffort,
        id: root?.id || root?.response_id,
        requestId: root?.request_id || root?.requestId,
        transportStatus: root?.status || root?.stop_reason || 'unknown',
        usage: root?.usage,
        inputHash: root?.inputHash || root?.input_hash,
        originalBody: extractResponsesText(root),
      };
    },
  },
  'pro-sol': {
    provider: 'pro-sol', model: 'gpt-6.1-sol', effort: 'medium',
    extract: (r, ctx) => {
      const text = String(ctx?.text || '');
      let model; let effort; let sessionId; let lastAssistant = null; let lastUsage = null;
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let obj; try { obj = JSON.parse(s); } catch { continue; }
        const p = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj;
        if (obj.type === 'session_meta') sessionId = p.id || sessionId;
        if (obj.type === 'turn_context') { model = p.model || model; effort = p.effort || p.reasoning_effort || effort; }
        if (obj.type === 'response_item' && p.role === 'assistant' && String(p.phase || '').toLowerCase() === 'final_answer') {
          lastAssistant = p;
        }
        if (obj.type === 'token_count' && p.usage) lastUsage = p.usage;
        if (obj.type === 'event_msg' && p.type === 'token_count') {
          const info = p.info && typeof p.info === 'object' ? p.info : p;
          lastUsage = info.last_token_usage || info.total_token_usage || info.usage || lastUsage;
        }
      }
      if (!lastAssistant) throw new Error('REVIEW_CYCLE_SOL_ASSISTANT_FINAL_MISSING');
      const content = Array.isArray(lastAssistant.content)
        ? lastAssistant.content.map((c) => (typeof c === 'string' ? c : c?.text || c?.output_text || '')).join('')
        : String(lastAssistant.output_text || lastAssistant.content || lastAssistant.text || '');
      return {
        provider: 'pro-sol',
        model,
        effort,
        id: lastAssistant.id || sessionId,
        requestId: lastAssistant.request_id || null,
        transportStatus: 'completed',
        usage: lastUsage,
        inputHash: lastAssistant.inputHash,
        originalBody: content,
      };
    },
  },
  'max-opus': {
    provider: 'max-opus', model: 'claude-opus-5-5', effort: 'high',
    extract: (r, ctx) => {
      if (!r || r.type !== 'result') throw new Error('REVIEW_CYCLE_MAXCLI_TYPE_INVALID');
      if (r.subtype !== 'success') throw new Error('REVIEW_CYCLE_MAXCLI_SUBTYPE_INVALID');
      if (r.is_error === true) throw new Error('REVIEW_CYCLE_MAXCLI_ERROR');
      const modelKeys = Object.keys(r.modelUsage || {});
      if (modelKeys.length !== 1) throw new Error('REVIEW_CYCLE_MAXCLI_MODEL_USAGE_INVALID');
      const model = modelKeys[0];
      if (model !== 'claude-opus-5-5') throw new Error('REVIEW_CYCLE_MAXCLI_MODEL_MISMATCH');
      const req = ctx?.request && typeof ctx.request === 'object' ? ctx.request : {};
      const argv = Array.isArray(req.argv) ? req.argv.join(' ') : String(req.argv || '');
      const inputEffort = req.effort || req.input?.effort || (argv.match(/--effort\s+(\S+)/) || [])[1];
      const effort = String(inputEffort || ctx?.reservedEffort || 'high').toLowerCase();
      if (effort !== 'high') throw new Error('REVIEW_CYCLE_MAXCLI_EFFORT_MISMATCH');
      return {
        provider: 'max-opus',
        model,
        effort,
        id: r.session_id,
        requestId: r.request_id || null,
        transportStatus: r.subtype,
        usage: r.modelUsage[model],
        inputHash: r.inputHash,
        originalBody: String(r.result || ''),
      };
    },
  },
  astra: {
    provider: 'astra', model: 'gpt-6-astra', effort: 'high',
    extract: (r, ctx) => ({
      provider: 'astra',
      model: r?.model,
      effort: r?.reasoning?.effort || r?.effort || ctx?.reservedEffort,
      id: r?.id || r?.response_id,
      requestId: r?.request_id || r?.requestId,
      transportStatus: r?.status || 'unknown',
      usage: r?.usage,
      inputHash: r?.inputHash || r?.input_hash,
      originalBody: extractResponsesText(r),
    }),
  },
  practical: {
    provider: 'practical', model: 'practical-runner', effort: 'high',
    extract: (r, ctx) => ({
      provider: 'practical',
      model: r?.model || 'practical-runner',
      effort: r?.effort || ctx?.reservedEffort,
      id: r?.id || r?.session_id,
      requestId: r?.requestId || null,
      transportStatus: r?.status || 'unknown',
      usage: r?.usage,
      inputHash: r?.inputHash,
      originalBody: String(r?.output || r?.result || r?.body || ''),
    }),
  },
  repair: {
    provider: 'repair', model: 'repair-runner', effort: 'high',
    extract: (r, ctx) => ({
      provider: 'repair',
      model: r?.model || 'repair-runner',
      effort: r?.effort || ctx?.reservedEffort,
      id: r?.id || r?.session_id,
      requestId: r?.requestId || null,
      transportStatus: r?.status || 'unknown',
      usage: r?.usage,
      inputHash: r?.inputHash,
      originalBody: String(r?.output || r?.result || r?.body || ''),
    }),
  },
};
function sha256(v) { return createHash('sha256').update(v).digest('hex'); }
export function sha256File(p) { return sha256(readFileSync(p)); }
function canon(v) { if (Array.isArray(v)) return v.map(canon); if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])); return v; }
export function canonicalJson(v) { return JSON.stringify(canon(v)); }
function safeId(v) { const s = String(v || '').trim(); if (!/^[A-Za-z0-9._-]{1,120}$/.test(s)) throw new Error('REVIEW_CYCLE_INVALID_ID'); return s; }
function git(root, args) { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }
export function resolveCommonGitDir(root) { const out = git(root, ['rev-parse', '--git-common-dir']); if (!out) return ''; return isAbsolute(out) ? out : resolve(root, out); }
export function resolveCanonicalAiRoot(root) { const common = resolveCommonGitDir(root); const base = common ? dirname(common) : resolve(root); return join(base, '.ai'); }
export function registryPath(root) { return join(resolveCanonicalAiRoot(root), REVIEW_CYCLE_REGISTRY); }
export function reviewCycleRegistryExists(root) { const p = registryPath(root); if (!existsSync(p)) return false; if (lstatSync(p).isSymbolicLink()) throw new Error('REVIEW_CYCLE_SYMLINK_PATH_REJECTED'); return true; }
function assertPlainFile(p) { if (!existsSync(p)) throw new Error(`REVIEW_CYCLE_FILE_MISSING: ${p}`); const st = lstatSync(p); if (st.isSymbolicLink()) throw new Error(`REVIEW_CYCLE_SYMLINK_PATH_REJECTED: ${p}`); if (!st.isFile()) throw new Error(`REVIEW_CYCLE_NOT_FILE: ${p}`); }
function readJson(p) { assertPlainFile(p); const raw = readFileSync(p, 'utf8'); try { return JSON.parse(raw); } catch (e) { throw new Error(`REVIEW_CYCLE_STATE_CORRUPT: ${p}: ${e.message}`); } }
function atomicWriteJson(p, v) { if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('REVIEW_CYCLE_SYMLINK_PATH_REJECTED'); mkdirSync(dirname(p), { recursive: true, mode: 0o700 }); const t = `${p}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(t, `${JSON.stringify(v, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); try { const fd = openSync(t, 'r+'); fsyncSync(fd); closeSync(fd); } catch {} renameSync(t, p); }
function withLock(root, fn) { const ai = resolveCanonicalAiRoot(root); mkdirSync(ai, { recursive: true, mode: 0o700 }); const lock = join(ai, REVIEW_CYCLE_LOCK); const token = randomUUID(); try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error('REVIEW_CYCLE_LOCK_HELD'); } const owner = join(lock, 'owner.json'); atomicWriteJson(owner, { token, pid: process.pid, at: new Date().toISOString() }); try { return fn(); } finally { const cur = readJson(owner); if (cur && cur.token === token) rmSync(lock, { recursive: true, force: true }); } }
function emptyRegistry(purposeId) { return { schemaVersion: REVIEW_CYCLE_SCHEMA_VERSION, kind: 'ai-review-cycle-registry', activePurposeId: purposeId, binding: null, purposes: {}, cycles: [], attempts: [], unknown: [], history: [], final: null, halted: false, haltedReason: null, restartCount: 0, limitedGrant: null, updatedAt: new Date().toISOString() }; }
function validateBinding(reg) { if (!reg || reg.schemaVersion !== 1 || reg.kind !== 'ai-review-cycle-registry' || !reg.binding) throw new Error('REVIEW_CYCLE_PURPOSE_UNBOUND'); const b = reg.binding; if (b.kind !== 'ai-review-purpose-binding' || b.purposeId !== reg.activePurposeId || !b.userSource || sha256(b.userSource) !== b.sourceHash) throw new Error('REVIEW_CYCLE_PURPOSE_BINDING_INVALID'); }
export function loadRegistry(root, { mode = 'display' } = {}) { const p = registryPath(root); if (!existsSync(p)) { if (mode !== 'display') throw new Error('REVIEW_CYCLE_PURPOSE_UNBOUND'); return null; } if (lstatSync(p).isSymbolicLink()) throw new Error('REVIEW_CYCLE_SYMLINK_PATH_REJECTED'); const reg = readJson(p); if (mode !== 'display') validateBinding(reg); return reg; }
function saveRegistry(root, reg) { reg.updatedAt = new Date().toISOString(); atomicWriteJson(registryPath(root), reg); }
function assertCycleRange(cycle, step) { const c = Number(cycle); if (!Number.isInteger(c)) throw new Error('REVIEW_CYCLE_INVALID_CYCLE'); if (step === 'astra-diagnosis') { if (c !== ASTRA_CYCLE) throw new Error('REVIEW_CYCLE_ASTRA_CYCLE_REQUIRED'); return c; } if (c < 1 || c > MAX_NORMAL_CYCLE) { throw new Error('REVIEW_CYCLE_CYCLE_OUT_OF_RANGE'); } return c; }
function currentCycle(reg, cycle, step) { const c = assertCycleRange(cycle, step); let x = reg.cycles.find((y) => y.cycle === c); if (!x) { x = { cycle: c, status: 'in_progress', startedAt: new Date().toISOString(), completedAt: null, candidateHash: null, repairTransition: null, steps: {}, practical: null, opusOutcome: null, blockers: [] }; reg.cycles.push(x); } return x; }
function cycleByNumber(reg, cycle) { return reg.cycles.find((x) => x.cycle === cycle); }
function assertNoUnknownResend(reg, { step, cycle, candidateHash }) { if (reg.unknown.some((u) => u.step === step && u.cycle === cycle && u.candidateHash === candidateHash)) throw new Error('REVIEW_CYCLE_UNKNOWN_SEND_NOT_RESENT'); }
function resolveCycleCandidateHash(c, step, candidateHash) { if (!c.candidateHash) { c.candidateHash = candidateHash; return candidateHash; } const afterRepair = c.repairTransition?.to || c.candidateHash; if (step === 'repair') { if (c.repairTransition && c.repairTransition.to === candidateHash) return candidateHash; c.repairTransition = { from: c.candidateHash, to: candidateHash, at: new Date().toISOString() }; c.candidateHash = candidateHash; return candidateHash; } const expected = STEP_ORDER[step] >= STEP_ORDER.repair ? afterRepair : c.candidateHash; if (candidateHash !== expected) throw new Error('REVIEW_CYCLE_CANDIDATE_BINDING_MISMATCH'); return expected; }
function assertStepDependencies(c, step) { if (step === 'repair' || step === 'practical') { for (const s of ['deepseek', 'sol']) if (c.steps[s]?.status !== 'recorded') throw new Error(`REVIEW_CYCLE_${s.toUpperCase()}_REQUIRED_FIRST`); } if (step === 'opus') { for (const s of ['deepseek', 'sol']) if (c.steps[s]?.status !== 'recorded') throw new Error(`REVIEW_CYCLE_${s.toUpperCase()}_REQUIRED_FIRST`); if (c.steps.repair && c.steps.repair.status !== 'recorded' && c.repairTransition) throw new Error('REVIEW_CYCLE_REPAIR_REQUIRED_FIRST'); if (!c.practical || !['passed','failed'].includes(c.practical.status)) throw new Error('REVIEW_CYCLE_PRACTICAL_OUTCOME_REQUIRED_BEFORE_OPUS'); } }
function isFullCompletedBlockedCycle(c) { return !!(c && c.status==='blocked' && c.completedAt && c.steps.deepseek?.status==='recorded' && c.steps.sol?.status==='recorded' && ['passed','failed'].includes(c.practical?.status) && c.steps.opus?.status==='recorded' && c.opusOutcome==='blocked'); }
function completedBlockedCycles(reg) { return reg.cycles.filter(isFullCompletedBlockedCycle); }
function stepSpec(step) { if (step === 'astra-diagnosis') return STEP_MODELS.astra; return STEP_MODELS[step] || null; }
function expectedAdapter(step) { if (step === 'astra-diagnosis') return 'astra'; return STEP_MODELS[step]?.adapter || step; }
function isLimitedStep(step) { return LIMITED_REVIEW_STEPS.includes(step) || step === LIMITED_IMPLEMENTATION_STEP || step === 'practical'; }
function limitedKey(step) { return step === 'repair' ? 'implementation' : step; }
function findTicket(reg, ticketId) { for (const cyc of reg.cycles || []) { for (const v of Object.values(cyc.steps || {})) { if (v.ticketId === ticketId) return v; } } return reg.limitedTickets?.[ticketId] || null; }
function validateLimitedGrant(reg, { root, ticket, step, ...action } = {}) {
  const g = reg.limitedGrant;
  if (!g || g.revoked || g.final) throw new Error('REVIEW_CYCLE_LIMITED_GRANT_REQUIRED');
  if (!root) throw new Error('REVIEW_CYCLE_LIMITED_APPROVAL_CONTEXT_REQUIRED');
  const current = nativeLimitedApproval(root, g.scope, reg.activePurposeId);
  if (current.hash !== g.approvalHash || current.approval.documentHash !== g.documentHash || current.approval.revision !== g.approvalRev ||
      current.task.taskId !== g.taskId || current.task.taskFingerprint !== g.taskFingerprint) throw new Error('REVIEW_CYCLE_LIMITED_APPROVAL_CHANGED');
  if (g.purposeId !== reg.activePurposeId || g.taskId !== reg.binding.taskId) throw new Error('REVIEW_CYCLE_LIMITED_PURPOSE_MISMATCH');
  const key = limitedKey(ticket?.step || step);
  if (!g.policy.steps.includes(ticket?.step || step)) throw new Error('REVIEW_CYCLE_LIMITED_EXTERNAL_REQUEST_FORBIDDEN');
  if (ticket) {
    if (ticket.grantId !== g.grantId || ticket.approvalRev !== g.approvalRev || ticket.documentHash !== g.documentHash || ticket.approvalHash !== g.approvalHash)
      throw new Error('REVIEW_CYCLE_LIMITED_TICKET_BINDING_MISMATCH');
  } else if (g.consumed[key] >= 1) throw new Error('REVIEW_CYCLE_LIMITED_ALREADY_CONSUMED');
  if (g.candidateBinding && action.candidateHash !== undefined && action.candidateHash !== g.candidateBinding.candidateHash)
    throw new Error('REVIEW_CYCLE_LIMITED_CANDIDATE_MISMATCH');
  if (g.scope === 'limited-formal-review') verifyCandidateBinding(root, g.candidateBinding);
  return g;
}
function assertTicketContext(reg, state, action) {
  if (!state) throw new Error('REVIEW_CYCLE_TICKET_NOT_FOUND');
  if (state.purposeId !== reg.activePurposeId || state.taskId !== reg.binding.taskId) throw new Error('REVIEW_CYCLE_TICKET_BINDING_MISMATCH');
  for (const key of ['purposeId','taskId','step','cycle','candidateHash','requestId','model','effort']) {
    if (action[key] !== undefined && action[key] !== state[key]) throw new Error('REVIEW_CYCLE_TICKET_' + key.toUpperCase() + '_MISMATCH');
  }
  if (!state.requestId || !state.taskId || !state.ticketId || !state.candidateHash) throw new Error('REVIEW_CYCLE_TICKET_IDS_REQUIRED');
  if (state.status !== 'reserved') throw new Error(state.status === 'unknown' ? 'REVIEW_CYCLE_UNKNOWN_SEND_NOT_RESENT' : 'REVIEW_CYCLE_TICKET_ALREADY_RECORDED');
}
function nativeLimitedApproval(root, scope, purposeId) {
  const task = readJson(join(root, '.ai', 'current-task.json'));
  const result = loadApproval(root, task, { requireApproved: true });
  if (result.errors?.length || !result.approval) throw new Error('REVIEW_CYCLE_LIMITED_APPROVAL_INVALID: ' + result.errors?.join('; '));
  const entries = result.approval.completionCriteria.filter(x => x.includes('limitedPlan: '));
  if (entries.length !== 1) throw new Error('REVIEW_CYCLE_LIMITED_SCOPE_REQUIRED');
  let policy; try { policy = JSON.parse(entries[0].split('limitedPlan: ')[1]); } catch { throw new Error('REVIEW_CYCLE_LIMITED_SCOPE_INVALID'); }
  if (policy.scope !== scope || policy.purposeId !== purposeId) throw new Error('REVIEW_CYCLE_LIMITED_SCOPE_MISMATCH');
  if (scope === 'limited-local-repair') {
    if (policy.implementationAttempts !== 1 || policy.externalRequests !== 0 || policy.independentReviews !== 0 ||
        canonicalJson(policy.steps) !== canonicalJson(['repair', 'practical'])) throw new Error('REVIEW_CYCLE_LIMITED_SCOPE_MISMATCH');
  } else if (scope === 'limited-formal-review') {
    if (canonicalJson(policy.steps) !== canonicalJson(['deepseek', 'sol', 'practical', 'opus'])) throw new Error('REVIEW_CYCLE_LIMITED_SCOPE_MISMATCH');
    if (policy.budgetOverlayYen !== 50) throw new Error('REVIEW_CYCLE_LIMITED_BUDGET_INVALID');
    if (!/^[a-f0-9]{64}$/.test(String(policy.candidateHash || ''))) throw new Error('REVIEW_CYCLE_LIMITED_CANDIDATE_REQUIRED');
    if (!Array.isArray(policy.sourceHashes) || policy.sourceHashes.length === 0) throw new Error('REVIEW_CYCLE_LIMITED_SOURCE_REQUIRED');
  } else {
    throw new Error('REVIEW_CYCLE_LIMITED_SCOPE_MISMATCH');
  }
  if (!Number.isFinite(Date.parse(policy.expiresAt)) || Date.parse(policy.expiresAt) <= Date.now()) throw new Error('REVIEW_CYCLE_LIMITED_EXPIRED');
  return { task, approval: result.approval, path: result.path, hash: sha256File(result.path), policy };
}
function normalizeCandidateSourcePath(p) {
  const s = String(p || '').trim();
  if (!s) throw new Error('REVIEW_CYCLE_CANDIDATE_SOURCE_PATH_REQUIRED');
  if (isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) throw new Error('REVIEW_CYCLE_CANDIDATE_SOURCE_PATH_UNTRUSTED');
  const parts = s.split(/[\\/]+/);
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('REVIEW_CYCLE_CANDIDATE_SOURCE_PATH_UNTRUSTED');
  return parts.join('/');
}
function normalizeSourceHashes(root, sourceHashes) {
  if (!Array.isArray(sourceHashes) || sourceHashes.length === 0) throw new Error('REVIEW_CYCLE_CANDIDATE_SOURCE_REQUIRED');
  const seen = new Set();
  const normalized = sourceHashes.map((x) => {
    if (!x || typeof x.path !== 'string' || !/^[a-f0-9]{64}$/.test(String(x.sha256 || ''))) throw new Error('REVIEW_CYCLE_CANDIDATE_SOURCE_INVALID');
    const path = normalizeCandidateSourcePath(x.path);
    if (seen.has(path)) throw new Error('REVIEW_CYCLE_CANDIDATE_SOURCE_DUPLICATE');
    seen.add(path);
    const abs = resolveArtifactPath(root, path);
    assertPlainFile(abs);
    if (sha256File(abs) !== x.sha256) throw new Error('REVIEW_CYCLE_CANDIDATE_SOURCE_CHANGED');
    return { path, sha256: x.sha256 };
  });
  normalized.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return normalized;
}
function candidateHashFromSourceHashes(sourceHashes) {
  return sha256(canonicalJson(sourceHashes));
}
function normalizeCandidateBinding(root, { candidateHash, candidateManifestPath, sourceHashes } = {}) {
  let manifestPath = null; let manifestHash = null; let rawSources = sourceHashes;
  if (candidateManifestPath) {
    const p = resolveArtifactPath(root, candidateManifestPath);
    assertPlainFile(p);
    manifestPath = candidateManifestPath;
    manifestHash = sha256File(p);
    const manifest = readJson(p);
    if (manifest?.kind !== 'ai-review-candidate-binding' || manifest?.schemaVersion !== 1 || !Array.isArray(manifest.sourceHashes)) throw new Error('REVIEW_CYCLE_CANDIDATE_MANIFEST_INVALID');
    if (rawSources && rawSources.length > 0) {
      const requested = normalizeSourceHashes(root, rawSources);
      const manifestSources = normalizeSourceHashes(root, manifest.sourceHashes);
      if (canonicalJson(requested) !== canonicalJson(manifestSources)) throw new Error('REVIEW_CYCLE_CANDIDATE_MANIFEST_SOURCE_MISMATCH');
      rawSources = requested;
    } else {
      rawSources = manifest.sourceHashes;
    }
    if (manifest.candidateHash && String(manifest.candidateHash) !== String(candidateHash || '')) throw new Error('REVIEW_CYCLE_CANDIDATE_MANIFEST_HASH_MISMATCH');
  }
  const normalized = normalizeSourceHashes(root, rawSources);
  const computed = candidateHashFromSourceHashes(normalized);
  if (!/^[a-f0-9]{64}$/.test(String(candidateHash || '')) || candidateHash !== computed) throw new Error('REVIEW_CYCLE_CANDIDATE_HASH_MISMATCH');
  return { candidateHash: computed, sourceHashes: normalized, ...(manifestPath ? { manifestPath, manifestHash } : {}) };
}
function verifyCandidateBinding(root, binding) {
  if (!binding || !/^[a-f0-9]{64}$/.test(String(binding.candidateHash || ''))) throw new Error('REVIEW_CYCLE_CANDIDATE_BINDING_REQUIRED');
  if (binding.manifestPath) {
    const p = resolveArtifactPath(root, binding.manifestPath);
    assertPlainFile(p);
    if (sha256File(p) !== binding.manifestHash) throw new Error('REVIEW_CYCLE_CANDIDATE_MANIFEST_CHANGED');
    const manifest = readJson(p);
    if (manifest?.kind !== 'ai-review-candidate-binding' || manifest?.schemaVersion !== 1 || !Array.isArray(manifest.sourceHashes)) throw new Error('REVIEW_CYCLE_CANDIDATE_MANIFEST_INVALID');
    const manifestSources = normalizeSourceHashes(root, manifest.sourceHashes);
    if (canonicalJson(manifestSources) !== canonicalJson(binding.sourceHashes)) throw new Error('REVIEW_CYCLE_CANDIDATE_MANIFEST_SOURCE_MISMATCH');
  }
  const normalized = normalizeSourceHashes(root, binding.sourceHashes);
  if (canonicalJson(normalized) !== canonicalJson(binding.sourceHashes)) throw new Error('REVIEW_CYCLE_CANDIDATE_SOURCE_CHANGED');
  if (candidateHashFromSourceHashes(normalized) !== binding.candidateHash) throw new Error('REVIEW_CYCLE_CANDIDATE_HASH_MISMATCH');
}
function retainedCounts(reg) {
  return { normal: reg.retainedHistory?.normalCycles || 0, astra: reg.retainedHistory?.astraUsed || 0 };
}
function activeFormalGrant(reg) {
  return reg?.limitedGrant?.scope === 'limited-formal-review' ? reg.limitedGrant : null;
}
function mostRelevantFormalGrant(reg) {
  const current = activeFormalGrant(reg);
  if (current) return current;
  const plans = Array.isArray(reg?.limitedPlans) ? reg.limitedPlans : [];
  for (let i = plans.length - 1; i >= 0; i--) {
    if (plans[i]?.scope === 'limited-formal-review') return plans[i];
  }
  return null;
}
function currentCycleStatus(reg) {
  const formal = activeFormalGrant(reg);
  if (formal && !formal.revoked && !formal.final) return 'active';
  if (formal?.final?.status === 'stopped_final_pass') return 'stopped_final_pass';
  if (formal?.final?.status === 'blocked') return 'halted';
  if (reg?.halted) return 'halted';
  return reg?.final?.status || 'active';
}
function assertRetainedHistory(reg) {
  for (const f of reg.retainedHistory?.files || []) if (sha256File(f.path) !== f.sha256) throw new Error('REVIEW_CYCLE_RETAINED_HISTORY_CHANGED');
}
export function retainExecutionHistory(root, { statusPath, budgetPath } = {}) {
  return withLock(root, () => {
    const reg = loadRegistry(root, { mode: 'dispatch' });
    const ai = resolveCanonicalAiRoot(root);
    const paths = [statusPath, budgetPath].map(x => resolve(String(x || '')));
    for (const f of paths) if (!f.startsWith(ai + sep)) throw new Error('REVIEW_CYCLE_HISTORY_PATH_UNTRUSTED');
    const status = readJson(paths[0]), budget = readJson(paths[1]);
    if (status.purpose !== reg.activePurposeId || status.completedCycles?.length !== 2 || status.astraUsed !== 1 ||
        !status.normalCyclesClosed || budget.totalYen !== 3000 || budget.costBreakdown?.combinedConservativeMaximumYen !== 2550)
      throw new Error('REVIEW_CYCLE_HISTORY_INVALID');
    const files = paths.map(path => ({ path, sha256: sha256File(path) }));
    // Keep original records as audit references, never fabricate provider receipts or passing cycles.
    const historyRoot = dirname(paths[0]);
    for (const c of status.completedCycles) {
      if (c.result !== 'blocked') throw new Error('REVIEW_CYCLE_HISTORY_RESULT_INVALID');
      for (const key of ['deepseekOriginal','solOriginal','opusFinalOriginal']) {
        const f = resolve(historyRoot, c[key]);
        if (!f.startsWith(historyRoot + sep)) throw new Error('REVIEW_CYCLE_HISTORY_PATH_UNTRUSTED');
        files.push({ path: f, sha256: sha256File(f) });
      }
    }
    const snapshot = { purposeId: status.purpose, normalCycles: 2, astraUsed: 1,
      limitedFailures: status.limitedReplans, protectedMaximumYen: 2550,
      statusSnapshot: status, budgetSnapshot: budget, files };
    if (reg.retainedHistory) {
      if (canonicalJson(reg.retainedHistory) !== canonicalJson(snapshot)) throw new Error('REVIEW_CYCLE_HISTORY_ALREADY_BOUND');
      return { ok: true, already: true };
    }
    reg.retainedHistory = snapshot; reg.halted = true; reg.haltedReason = 'legacy_stop_retained';
    reg.history.push({ event: 'execution_history_retained', at: new Date().toISOString(), files });
    saveRegistry(root, reg); return { ok: true, normalCycles: 2, astraUsed: 1, protectedMaximumYen: 2550 };
  });
}
function assertOpen(root, reg, ticket = null) {
  assertRetainedHistory(reg);
  const formalTicket = ticket?.limited && activeFormalGrant(reg) && ticket.grantId === reg.limitedGrant.grantId;
  if (reg.final?.status === 'stopped_final_pass' && !formalTicket) throw new Error('REVIEW_CYCLE_PRACTICAL_PASS_STOP');
  if (ticket?.limited) validateLimitedGrant(reg, { root, ticket });
  else if (reg.halted) throw new Error('REVIEW_CYCLE_HALTED');
}

export function authorizeNextStep(root, action = {}) {
  const kind = action.kind || 'inspect';
  const display = ['inspect','status'].includes(kind);
  const reg = loadRegistry(root, { mode: display ? 'display' : 'dispatch' });
  if (display) return { ok: true, allowed: !!reg, purposeId: reg?.activePurposeId, status: reg ? currentCycleStatus(reg) : 'unconfirmed' };
  if (!['start','run','send','queue','provider','pane'].includes(kind)) throw new Error('REVIEW_CYCLE_ACTION_UNKNOWN');
  const st = findTicket(reg, safeId(action.ticketId));
  assertTicketContext(reg, st, action); assertOpen(root, reg, st);
  if (['start','run'].includes(kind) && !['repair','practical'].includes(st.step)) throw new Error('REVIEW_CYCLE_IMPLEMENTATION_TICKET_REQUIRED');
  if (st.actualRoute) throw new Error('REVIEW_CYCLE_TICKET_ALREADY_CONSUMED');
  return { ok: true, allowed: true, purposeId: reg.activePurposeId, ticketId: st.ticketId, step: st.step, cycle: st.cycle, limited: !!st.limited };
}
export async function grantLimitedPlan(root, { approvalPath, taskId, purposeId, userSource, scope = 'limited-local-repair', candidateHash, candidateManifestPath, sourceHashes, budgetOverlayYen } = {}) {
  if (!String(userSource || '').trim()) throw new Error('REVIEW_CYCLE_USER_SOURCE_REQUIRED');
  const reg0 = loadRegistry(root, { mode: 'dispatch' });
  const native = nativeLimitedApproval(root, scope, purposeId || reg0.activePurposeId);
  if (resolve(approvalPath || '') !== resolve(native.path) || taskId !== native.task.taskId) throw new Error('REVIEW_CYCLE_LIMITED_APPROVAL_TASK_MISMATCH');
  let candidateBinding = null;
  if (scope === 'limited-formal-review') {
    candidateBinding = normalizeCandidateBinding(root, { candidateHash, candidateManifestPath, sourceHashes });
    const policyBinding = normalizeCandidateBinding(root, { candidateHash: native.policy.candidateHash, sourceHashes: native.policy.sourceHashes });
    if (candidateBinding.candidateHash !== native.policy.candidateHash || canonicalJson(candidateBinding.sourceHashes) !== canonicalJson(policyBinding.sourceHashes)) throw new Error('REVIEW_CYCLE_LIMITED_CANDIDATE_MISMATCH');
    if (budgetOverlayYen !== undefined && Number(budgetOverlayYen) !== native.policy.budgetOverlayYen) throw new Error('REVIEW_CYCLE_LIMITED_BUDGET_MISMATCH');
  }
  return withLock(root, () => {
    const reg = loadRegistry(root, { mode: 'dispatch' }); assertRetainedHistory(reg);
    if (purposeId !== reg.activePurposeId || taskId !== reg.binding.taskId) throw new Error('REVIEW_CYCLE_LIMITED_PURPOSE_MISMATCH');
    const formalScope = scope === 'limited-formal-review';
    if (reg.final?.status === 'stopped_final_pass' && !formalScope) throw new Error('REVIEW_CYCLE_PRACTICAL_PASS_STOP');
    if (!formalScope && mostRelevantFormalGrant(reg)) throw new Error('REVIEW_CYCLE_FORMAL_GRANT_EXISTS');
    if (formalScope) {
      const resumeStoppedGrantId = native.policy.resumeStoppedGrantId ? safeId(native.policy.resumeStoppedGrantId) : null;
      const existingFormal = mostRelevantFormalGrant(reg);
      if (existingFormal && !existingFormal.revoked && !existingFormal.final) throw new Error('REVIEW_CYCLE_FORMAL_GRANT_ACTIVE');
      const stoppedFormal = existingFormal && (existingFormal.revoked || existingFormal.final?.status === 'blocked' || existingFormal.final?.status === 'stopped_final_pass') ? existingFormal : null;
      if (resumeStoppedGrantId) {
        if (!stoppedFormal || stoppedFormal.grantId !== resumeStoppedGrantId) throw new Error('REVIEW_CYCLE_FORMAL_RESUME_BINDING_MISMATCH');
        if (!Number.isInteger(stoppedFormal.approvalRev) || native.approval.revision <= stoppedFormal.approvalRev) throw new Error('REVIEW_CYCLE_FORMAL_RESUME_REVISION_REQUIRED');
        if (native.hash === stoppedFormal.approvalHash) throw new Error('REVIEW_CYCLE_FORMAL_RESUME_APPROVAL_REUSED');
      } else if (stoppedFormal) {
        throw new Error('REVIEW_CYCLE_FORMAL_STOPPED');
      }
      if (reg.final && !reg.retainedFinal) reg.retainedFinal = reg.final;
    }
    if (reg.history.some(h => h.event === 'limited_grant' && h.approvalHash === native.hash)) throw new Error('REVIEW_CYCLE_LIMITED_APPROVAL_REUSED');
    reg.limitedPlans = reg.limitedPlans || [];
    if (reg.limitedGrant) reg.limitedPlans.push(reg.limitedGrant);
    const consumed = Object.fromEntries(native.policy.steps.map((step) => [limitedKey(step), 0]));
    reg.limitedGrant = { grantId: randomUUID(), scope, purposeId, taskId, taskFingerprint: native.task.taskFingerprint,
      approvalPath: native.path, approvalHash: native.hash, approvalRev: native.approval.revision, documentHash: native.approval.documentHash,
      policy: native.policy, expiresAt: native.policy.expiresAt, consumed,
      budgetOverlayYen: native.policy.budgetOverlayYen,
      candidateBinding, practical: null, revoked: false, final: null, grantedAt: new Date().toISOString() };
    reg.history.push({ event: 'limited_grant', approvalHash: native.hash, at: new Date().toISOString(), previousHaltRetained: reg.halted, previousFinalRetained: Boolean(reg.retainedFinal), scope });
    saveRegistry(root, reg); return { ok: true, granted: true, grantId: reg.limitedGrant.grantId };
  });
}
export function reviewedDispatchStep(plan, nativeChain = false) {
  const phase=nativeChain?'opus':plan?.lens?.reviewer;
  const step={deepseek:'deepseek',sol:'sol',opus:'opus',astra:'astra-diagnosis'}[phase];
  if(!step)throw new Error('REVIEW_CYCLE_REVIEW_PHASE_REQUIRED');
  return step;
}
export function prepareReviewCycleForSend(root, opts = {}) {
  let r;
  if (opts.ticketId) {
    // A prepared request owns one unconsumed reservation. Reusing that request
    // validates the same binding; it never allocates or consumes a second ticket.
    authorizeNextStep(root, { ...opts, kind: 'send' });
    r = findTicket(loadRegistry(root, { mode: 'dispatch' }), opts.ticketId);
    if (opts.ticketHash !== r.ticketHash) throw new Error('REVIEW_CYCLE_TICKET_HASH_MISMATCH');
  } else r = reserveStep(root, opts);
  return { root, purposeId: r.purposeId, ticketId: r.ticketId, ticketHash: r.ticketHash, step: r.step, cycle: r.cycle, candidateHash: r.candidateHash, requestId: r.requestId, model: r.model, effort: r.effort, limited: r.limited === true };
}
export function bindPurpose(root, { purposeId, userSource, restartOf, reason, aliasOf, taskId }) { const src = String(userSource || '').trim(); if (!src) throw new Error('REVIEW_CYCLE_USER_SOURCE_REQUIRED'); const rawId = safeId(purposeId); const id = aliasOf ? safeId(aliasOf) : rawId; return withLock(root, () => { let reg = loadRegistry(root, { mode: 'display' }) || emptyRegistry(id); if (reg.binding && reg.binding.purposeId !== id && !restartOf) throw new Error('REVIEW_CYCLE_PURPOSE_MERGE_FORBIDDEN'); if (restartOf && reg.binding && reg.binding.purposeId !== safeId(restartOf)) throw new Error('REVIEW_CYCLE_RESTART_PURPOSE_MISMATCH'); if (aliasOf && !reg.purposes?.[id]) throw new Error('REVIEW_CYCLE_ALIAS_TARGET_UNKNOWN'); if (!reg.purposes) reg.purposes = {}; if (!reg.purposes[id]) reg.purposes[id] = { purposeId: id, createdAt: new Date().toISOString(), sourceHashes: [], aliases: [] }; if (aliasOf && !reg.purposes[id].aliases.includes(rawId)) reg.purposes[id].aliases.push(rawId); if (!reg.purposes[id].sourceHashes.includes(sha256(src))) reg.purposes[id].sourceHashes.push(sha256(src)); if (reg.binding && reg.binding.purposeId !== id) reg.history.push({ at: new Date().toISOString(), event: 'purpose_switch', from: reg.binding.purposeId, to: id, reason: reason || '' }); reg.activePurposeId = id; reg.binding = { kind: 'ai-review-purpose-binding', purposeId: id, userSource: src, sourceHash: sha256(src), taskId: taskId || reg.binding?.taskId || null, createdAt: reg.binding?.createdAt || new Date().toISOString(), boundAt: new Date().toISOString(), restartOf: restartOf || null, reason: reason || '' }; saveRegistry(root, reg); return inspectCycle(root); }); }
export async function restartFromHalt(root, { userSource } = {}) {
  // A restart never erases a halt or normal counters; only a native bounded grant can permit actions.
  const reg = loadRegistry(root, { mode: 'dispatch' });
  const task = readJson(join(root,'.ai','current-task.json'));
  return grantLimitedPlan(root, { approvalPath: userSource, taskId: task.taskId, purposeId: reg.activePurposeId, userSource, scope: 'limited-local-repair' });
}
export function reserveStep(root, { step, cycle, candidateHash, requestId, model, effort, taskId } = {}) {
  if (!Object.hasOwn(STEP_ORDER, step)) throw new Error('REVIEW_CYCLE_STEP_INVALID');
  const cyc = Number(cycle);
  if (!Number.isInteger(cyc) || cyc < 1 || !/^[a-f0-9]{64}$/.test(candidateHash || '')) throw new Error('REVIEW_CYCLE_CANDIDATE_OR_CYCLE_INVALID');
  return withLock(root, () => {
    const reg = loadRegistry(root,{mode:'dispatch'}); assertRetainedHistory(reg);
    const limited = cyc > MAX_NORMAL_CYCLE && step !== 'astra-diagnosis';
    const formalException = limited && activeFormalGrant(reg) && !reg.limitedGrant.revoked && !reg.limitedGrant.final;
    if (reg.final?.status === 'stopped_final_pass' && !formalException) throw new Error('REVIEW_CYCLE_PRACTICAL_PASS_STOP');
    let c, g;
    if (limited) {
      const existingLimited = Object.values(reg.limitedTickets || {}).find((t) => t.grantId === reg.limitedGrant?.grantId && t.step === step && t.cycle === cyc && t.status === 'reserved' && !t.actualRoute && t.candidateHash === candidateHash && t.requestId === requestId && t.taskId === taskId);
      if (existingLimited) {
        g = validateLimitedGrant(reg, { root, step, candidateHash, ticket: existingLimited });
        assertTicketContext(reg, existingLimited, { step, cycle: cyc, candidateHash, requestId, taskId, model, effort });
        return { ok: true, ...existingLimited };
      }
      g = validateLimitedGrant(reg, { root, step, candidateHash });
      if (cyc !== 3) throw new Error('REVIEW_CYCLE_LIMITED_CYCLE_REQUIRED');
      const recorded = (s) => Object.values(reg.limitedTickets || {}).find(x => x.grantId === g.grantId && x.step === s && x.status === 'recorded');
      if (g.scope === 'limited-local-repair') {
        if (step === 'practical') {
          const repair = recorded('repair');
          if (!repair || repair.candidateHash !== candidateHash) throw new Error('REVIEW_CYCLE_REPAIR_REQUIRED_FIRST');
        }
      } else if (g.scope === 'limited-formal-review') {
        if (step === 'practical') {
          for (const s of ['deepseek', 'sol']) {
            const x = recorded(s);
            if (!x || x.candidateHash !== candidateHash) throw new Error(`REVIEW_CYCLE_${s.toUpperCase()}_REQUIRED_FIRST`);
          }
        }
        if (step === 'opus') {
          for (const s of ['deepseek', 'sol', 'practical']) {
            const x = recorded(s);
            if (!x || x.candidateHash !== candidateHash) throw new Error(`REVIEW_CYCLE_${s.toUpperCase()}_REQUIRED_FIRST`);
          }
          if (!g.practical || g.practical.status !== 'passed' || g.practical.candidateHash !== candidateHash) throw new Error('REVIEW_CYCLE_PRACTICAL_PASS_REQUIRED_BEFORE_OPUS');
        }
      } else throw new Error('REVIEW_CYCLE_LIMITED_SCOPE_MISMATCH');
    } else {
      assertCycleRange(cyc,step);
      if (retainedCounts(reg).normal >= cyc && step !== 'astra-diagnosis') throw new Error('REVIEW_CYCLE_NORMAL_HISTORY_CLOSED');
      if (step === 'astra-diagnosis' && (retainedCounts(reg).astra || reg.cycles.some(x=>x.steps?.['astra-diagnosis']))) throw new Error('REVIEW_CYCLE_ASTRA_MAX_ONE');
      assertOpen(root,reg);
      if (step === 'astra-diagnosis' && completedBlockedCycles(reg).length < 2) throw new Error('REVIEW_CYCLE_ASTRA_AFTER_TWO_CYCLES');
      if (cyc === 2 && !isFullCompletedBlockedCycle(cycleByNumber(reg,1))) throw new Error('REVIEW_CYCLE_CYCLE2_AFTER_BLOCKED_CYCLE1_ONLY');
      c=currentCycle(reg,cyc,step);
      if (c.steps[step]) {
        const existing = c.steps[step];
        // Concurrent publication of exactly one request reuses its reservation.
        // A new request, changed input or actual execution never gets another slot.
        const spec = stepSpec(step);
        if (!requestId || requestId !== existing.requestId || candidateHash !== existing.candidateHash ||
            taskId !== existing.taskId || (model && model !== spec.model) || (effort && effort !== spec.effort)) {
          throw new Error('REVIEW_CYCLE_STEP_ALREADY_RECORDED');
        }
        assertTicketContext(reg, existing, {step,cycle:cyc,candidateHash,requestId,taskId,model:spec.model,effort:spec.effort});
        if (existing.actualRoute) throw new Error('REVIEW_CYCLE_TICKET_ALREADY_CONSUMED');
        return {ok:true,...existing};
      }
      if (c.practical && step === 'repair') throw new Error('REVIEW_CYCLE_PRACTICAL_CANDIDATE_CLOSED');
      assertStepDependencies(c,step); resolveCycleCandidateHash(c,step,candidateHash);
    }
    if (taskId !== undefined && taskId !== reg.binding.taskId) throw new Error('REVIEW_CYCLE_TASK_MISMATCH');
    assertNoUnknownResend(reg,{step,cycle:cyc,candidateHash});
    const spec=stepSpec(step); const ticketId=randomUUID();
    if ((model && model !== spec.model) || (effort && effort !== spec.effort)) throw new Error('REVIEW_CYCLE_MODEL_MISMATCH');
    const ticket = { ticketId, ticketHash: sha256(ticketId), purposeId:reg.activePurposeId,taskId:reg.binding.taskId,
      step,cycle:cyc,candidateHash,requestId: requestId || randomUUID(),model:spec.model,effort:spec.effort,
      status:'reserved',consumed:{},actualRoute:null,limited,reservedAt:new Date().toISOString() };
    if (limited) {
      Object.assign(ticket,{grantId:g.grantId,approvalRev:g.approvalRev,documentHash:g.documentHash,approvalHash:g.approvalHash});
      reg.limitedTickets=reg.limitedTickets||{};reg.limitedTickets[ticketId]=ticket;g.consumed[limitedKey(step)]++;
    } else c.steps[step]=ticket;
    reg.attempts.push({...ticket,state:'reserved'});saveRegistry(root,reg);return {ok:true,...ticket};
  });
}
function queueApprovalBinding(root, reg, ticket) {
  const task = readJson(join(root, '.ai', 'current-task.json'));
  const current = loadApproval(root, task, { requireApproved: true });
  if (current.errors?.length || !current.approval) throw new Error('REVIEW_CYCLE_QUEUE_APPROVAL_INVALID: ' + current.errors?.join('; '));
  if (task.taskId !== ticket.taskId || task.taskId !== reg.binding.taskId) throw new Error('REVIEW_CYCLE_QUEUE_APPROVAL_TASK_MISMATCH');
  // Existing structured expiry contracts remain binding, including normal tickets
  // issued under a document that also contains a limited plan.
  for (const entry of current.approval.completionCriteria.filter(x => x.includes('limitedPlan: '))) {
    let policy; try { policy = JSON.parse(entry.split('limitedPlan: ')[1]); } catch { throw new Error('REVIEW_CYCLE_QUEUE_APPROVAL_SCOPE_INVALID'); }
    if (policy.purposeId !== reg.activePurposeId) throw new Error('REVIEW_CYCLE_QUEUE_APPROVAL_PURPOSE_MISMATCH');
    if (!Number.isFinite(Date.parse(policy.expiresAt)) || Date.parse(policy.expiresAt) <= Date.now()) throw new Error('REVIEW_CYCLE_QUEUE_APPROVAL_EXPIRED');
  }
  return { taskId: task.taskId, taskFingerprint: task.taskFingerprint, purposeId: reg.activePurposeId,
    revision: current.approval.revision, documentHash: current.approval.documentHash,
    approvalHash: sha256(canonicalJson(current.approval)) };
}
export function assertQueueTicketReuse(root, action = {}) {
  return withLock(root, () => {
    const reg = loadRegistry(root, { mode: 'dispatch' });
    const st = findTicket(reg, safeId(action.ticketId));
    for (const key of ['taskId','purposeId','step','cycle','candidateHash','requestId','model','effort']) {
      if (action[key] === undefined || action[key] === '') throw new Error('REVIEW_CYCLE_QUEUE_IDS_REQUIRED');
    }
    assertTicketContext(reg, st, action); assertOpen(root, reg, st);
    if (!st.consumed.queue || !st.queueApproval || !st.queueInputHash) throw new Error('REVIEW_CYCLE_QUEUE_BINDING_REQUIRED');
    if (!/^[a-f0-9]{64}$/.test(action.queueInputHash || '') || st.queueInputHash !== action.queueInputHash) throw new Error('REVIEW_CYCLE_QUEUE_INPUT_MISMATCH');
    if (canonicalJson(st.queueApproval) !== canonicalJson(queueApprovalBinding(root, reg, st))) throw new Error('REVIEW_CYCLE_QUEUE_APPROVAL_CHANGED');
    return { ok: true, ticketId: st.ticketId, reused: true };
  });
}
export function consumeDispatchTicket(root, action = {}) {
  const stg=action.stage;
  if (!['queue','send','provider','pane'].includes(stg)) throw new Error('REVIEW_CYCLE_TICKET_STAGE_INVALID');
  return withLock(root,()=>{
    const reg=loadRegistry(root,{mode:'dispatch'});const st=findTicket(reg,safeId(action.ticketId));
    assertTicketContext(reg,st,action);assertOpen(root,reg,st);
    if (st.consumed[stg]) throw new Error('REVIEW_CYCLE_TICKET_ALREADY_CONSUMED');
    if ((stg==='provider'||stg==='pane')&&st.actualRoute) throw new Error('REVIEW_CYCLE_ONE_ROUTE_ONLY');
    if ((stg==='queue'||stg==='send')&&st.actualRoute) throw new Error('REVIEW_CYCLE_TICKET_STAGE_ORDER');
    if (stg === 'queue' && action.queueInputHash !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(action.queueInputHash)) throw new Error('REVIEW_CYCLE_QUEUE_INPUT_MISMATCH');
      st.queueApproval = queueApprovalBinding(root, reg, st);
      st.queueInputHash = action.queueInputHash;
    }
    st.consumed[stg]={at:new Date().toISOString()};if(stg==='provider'||stg==='pane')st.actualRoute=stg;
    reg.attempts.push({ticketId:st.ticketId,state:'consumed_'+stg,at:new Date().toISOString()});saveRegistry(root,reg);
    return {ok:true,ticketId:st.ticketId,stage:stg};
  });
}
export function inspectFiniteProviderPlan(root, { ticketId } = {}) {
  const reg = loadRegistry(root, { mode: 'dispatch' });
  const st = findTicket(reg, safeId(ticketId));
  assertTicketContext(reg, st, {});
  assertOpen(root, reg, st);
  const plan = st.planConsumed || null;
  const consumed = plan ? Object.keys(plan.consumed).map(Number).sort((a, b) => a - b) : [];
  return {
    ok: true,
    ticketId: st.ticketId,
    purposeId: st.purposeId,
    taskId: st.taskId,
    step: st.step,
    cycle: st.cycle,
    candidateHash: st.candidateHash,
    requestId: st.requestId,
    model: st.model,
    effort: st.effort,
    status: st.status,
    actualRoute: st.actualRoute,
    planHash: plan ? plan.planHash : null,
    total: plan ? plan.total : null,
    consumed,
    nextIndex: plan ? plan.nextIndex : 0,
    limited: st.limited === true,
  };
}
export function consumeFiniteProviderPlanPart(root, action = {}) {
  const stage = action.stage || 'provider';
  if (stage !== 'provider') throw new Error('REVIEW_CYCLE_FINITE_PLAN_PROVIDER_STAGE_REQUIRED');
  const planHash = String(action.planHash || '');
  if (!/^[a-f0-9]{64}$/u.test(planHash)) throw new Error('REVIEW_CYCLE_FINITE_PLAN_HASH_INVALID');
  const total = Number(action.total);
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('REVIEW_CYCLE_FINITE_PLAN_TOTAL_INVALID');
  const index = Number(action.index);
  if (!Number.isSafeInteger(index) || index < 0 || index >= total) throw new Error('REVIEW_CYCLE_FINITE_PLAN_INDEX_INVALID');
  return withLock(root, () => {
    const reg = loadRegistry(root, { mode: 'dispatch' });
    const st = findTicket(reg, safeId(action.ticketId));
    assertTicketContext(reg, st, action);
    assertOpen(root, reg, st);
    if (!st.planConsumed) {
      if (st.actualRoute || st.consumed.provider || st.consumed.pane) throw new Error('REVIEW_CYCLE_FINITE_PLAN_ROUTE_ALREADY_CONSUMED');
      if (index !== 0) throw new Error('REVIEW_CYCLE_FINITE_PLAN_INDEX_GAP');
      st.planConsumed = { planHash, total, consumed: {}, nextIndex: 0 };
      st.actualRoute = 'provider';
      if (!st.consumed.provider) st.consumed.provider = { at: new Date().toISOString(), finitePlan: true, planHash, total };
    } else {
      if (st.planConsumed.planHash !== planHash || st.planConsumed.total !== total) throw new Error('REVIEW_CYCLE_FINITE_PLAN_BINDING_MISMATCH');
      if (st.actualRoute !== 'provider') throw new Error('REVIEW_CYCLE_FINITE_PLAN_ROUTE_MISMATCH');
      if (Object.hasOwn(st.planConsumed.consumed, String(index))) throw new Error('REVIEW_CYCLE_FINITE_PLAN_PART_ALREADY_CONSUMED');
      if (index !== st.planConsumed.nextIndex) throw new Error('REVIEW_CYCLE_FINITE_PLAN_INDEX_GAP');
    }
    st.planConsumed.consumed[String(index)] = { at: new Date().toISOString(), requestId: st.requestId };
    st.planConsumed.nextIndex = index + 1;
    reg.attempts.push({ ticketId: st.ticketId, state: 'consumed_provider_part', planHash, index, total, at: new Date().toISOString() });
    saveRegistry(root, reg);
    return { ok: true, ticketId: st.ticketId, stage: 'provider', planHash, index, total, nextIndex: st.planConsumed.nextIndex, actualRoute: 'provider' };
  });
}
export function recordUnknownSend(root, {step,cycle,candidateHash,requestId,note}={}) {
  return withLock(root,()=>{
    const reg=loadRegistry(root,{mode:'dispatch'});
    const st=[...reg.cycles.flatMap(c=>Object.values(c.steps)),...Object.values(reg.limitedTickets||{})].find(t=>t.step===step&&t.cycle===Number(cycle)&&t.candidateHash===candidateHash&&(!requestId||t.requestId===requestId));
    assertTicketContext(reg,st,{});assertOpen(root,reg,st);if(!st.actualRoute)throw new Error('REVIEW_CYCLE_DISPATCH_NOT_CONSUMED');
    st.status='unknown';reg.unknown.push({step,cycle:Number(cycle),candidateHash,requestId:st.requestId,note,state:'unknown'});
    reg.halted=true;reg.haltedReason='unknown_result';if(st.limited)reg.limitedGrant.revoked=true;
    saveRegistry(root,reg);return {ok:true,halted:true};
  });
}
function validateUsage(usage) { if (!usage || typeof usage !== 'object') throw new Error('REVIEW_CYCLE_USAGE_REQUIRED'); const nums = Object.values(usage).filter((v) => Number.isFinite(v)); if (nums.length === 0) throw new Error('REVIEW_CYCLE_USAGE_REQUIRED'); if (nums.some((v) => v < 0)) throw new Error('REVIEW_CYCLE_USAGE_INVALID'); return usage; }
function resolveArtifactPath(root, p) { const s = String(p || ''); if (!s) throw new Error('REVIEW_CYCLE_ARTIFACT_PATH_REQUIRED'); const abs = isAbsolute(s) ? resolve(s) : resolve(root, s); const rr = resolve(root); if (!abs.startsWith(rr + sep) && abs !== rr) throw new Error('REVIEW_CYCLE_ARTIFACT_PATH_UNTRUSTED'); return abs; }
function readArtifact(root, art) { if (!art || typeof art !== 'object') throw new Error('REVIEW_CYCLE_ARTIFACT_REQUIRED'); const p = resolveArtifactPath(root, art.path); assertPlainFile(p); const h = sha256File(p); if (h !== art.sha256) throw new Error('REVIEW_CYCLE_ARTIFACT_HASH_MISMATCH'); return { path: p, hash: h, bytes: readFileSync(p) }; }
function parseJsonBytes(bytes, p) { try { return JSON.parse(bytes.toString('utf8')); } catch (e) { throw new Error(`REVIEW_CYCLE_ARTIFACT_JSON_INVALID: ${p}: ${e.message}`); } }
function validateWrapper(root, { wrapperPath, wrapperHash, receiptPath, receiptHash, step, cycle, purposeId, candidateHash, model, effort, requestId, taskId, reservedEffort }) {
  const wp = resolve(root, String(wrapperPath || ''));
  const rp = resolve(root, String(receiptPath || ''));
  const rr = resolve(root);
  for (const p of [wp, rp]) { if (!p.startsWith(rr + sep) && p !== rr) throw new Error('REVIEW_CYCLE_PATH_UNTRUSTED'); assertPlainFile(p); }
  const wh = sha256File(wp);
  if (wh !== wrapperHash) throw new Error('REVIEW_CYCLE_WRAPPER_HASH_MISMATCH');
  const rh = sha256File(rp);
  if (rh !== receiptHash) throw new Error('REVIEW_CYCLE_RECEIPT_HASH_MISMATCH');
  const w = readJson(wp);
  if (!w || w.kind !== 'ai-review-cycle-wrapper-record') throw new Error('REVIEW_CYCLE_WRAPPER_INVALID');
  if (!w.recordedBy || typeof w.recordedBy !== 'string') throw new Error('REVIEW_CYCLE_WRAPPER_RECORDER_REQUIRED');
  const wc = { ...w };
  delete wc.recordHash;
  if (w.recordHash !== sha256(canonicalJson(wc))) throw new Error('REVIEW_CYCLE_WRAPPER_RECORD_HASH_MISMATCH');
  if (w.purposeId !== purposeId) throw new Error('REVIEW_CYCLE_WRAPPER_PURPOSE_MISMATCH');
  if (taskId && w.taskId !== taskId) throw new Error('REVIEW_CYCLE_WRAPPER_TASK_MISMATCH');
  if (w.step !== step) throw new Error('REVIEW_CYCLE_WRAPPER_STEP_MISMATCH');
  if (Number(w.cycle) !== Number(cycle)) throw new Error('REVIEW_CYCLE_WRAPPER_CYCLE_MISMATCH');
  if (w.candidateHash !== candidateHash) throw new Error('REVIEW_CYCLE_WRAPPER_CANDIDATE_MISMATCH');
  if (requestId && w.requestId !== requestId) throw new Error('REVIEW_CYCLE_WRAPPER_REQUEST_MISMATCH');
  if (!w.requestNonce || typeof w.requestNonce !== 'string') throw new Error('REVIEW_CYCLE_WRAPPER_NONCE_REQUIRED');
  const adapterName = expectedAdapter(step);
  if (w.adapter !== adapterName) throw new Error('REVIEW_CYCLE_WRAPPER_ADAPTER_MISMATCH');
  const adapter = ADAPTERS[adapterName];
  if (!adapter) throw new Error('REVIEW_CYCLE_ADAPTER_UNSUPPORTED');
  const artifacts = w.artifacts || {};
  const reqArt = readArtifact(root, artifacts.request);
  const resArt = readArtifact(root, artifacts.response);
  const exitArt = readArtifact(root, artifacts.exit);
  const inputArt = readArtifact(root, artifacts.input);
  const req = parseJsonBytes(reqArt.bytes, reqArt.path);
  const input = parseJsonBytes(inputArt.bytes, inputArt.path);
  if (input.candidateHash && input.candidateHash !== candidateHash) throw new Error('REVIEW_CYCLE_INPUT_CANDIDATE_MISMATCH');
  if (input.purposeId && input.purposeId !== purposeId) throw new Error('REVIEW_CYCLE_INPUT_PURPOSE_MISMATCH');
  if (input.requestId && w.requestId && input.requestId !== w.requestId) throw new Error('REVIEW_CYCLE_INPUT_REQUEST_MISMATCH');
  if (input.nonce && w.requestNonce && input.nonce !== w.requestNonce) throw new Error('REVIEW_CYCLE_INPUT_NONCE_MISMATCH');
  if (input.model && input.model !== adapter.model) throw new Error('REVIEW_CYCLE_INPUT_MODEL_MISMATCH');
  if (input.effort && String(input.effort).toLowerCase() !== adapter.effort) throw new Error('REVIEW_CYCLE_INPUT_EFFORT_MISMATCH');
  if (taskId && input.taskId && input.taskId !== taskId) throw new Error('REVIEW_CYCLE_INPUT_TASK_MISMATCH');
  for (const [name, artifact] of [['request',req],['input',input]]) {
    for (const [key, expected] of Object.entries({purposeId,taskId,candidateHash,requestId:w.requestId,nonce:w.requestNonce,model:ADAPTERS[adapterName].model,effort:ADAPTERS[adapterName].effort})) {
      if (!expected || artifact[key] !== expected) throw new Error('REVIEW_CYCLE_' + name.toUpperCase() + '_BINDING_REQUIRED');
    }
  }
  if (resolveArtifactPath(root, artifacts.response.path) !== rp) throw new Error('REVIEW_CYCLE_RECEIPT_RESPONSE_MISMATCH');
  const resText = resArt.bytes.toString('utf8');
  let res = null;
  try { res = JSON.parse(resText); } catch { res = null; }
  const exitText = exitArt.bytes.toString('utf8').trim();
  if (!exitText) throw new Error('REVIEW_CYCLE_EXIT_MISSING');
  const raw = adapter.extract(res, { text: resText, reservedEffort: reservedEffort || effort, requestId: w.requestId, candidateHash, purposeId, taskId, nonce: w.requestNonce, request: req });
  if (!raw || raw.provider !== adapter.provider) throw new Error('REVIEW_CYCLE_PROVIDER_MISMATCH');
  const rawModel = raw.model || adapter.model;
  if (rawModel !== adapter.model) throw new Error('REVIEW_CYCLE_MODEL_MISMATCH');
  const rawEffort = String(raw.effort || reservedEffort || effort || adapter.effort).toLowerCase();
  if (rawEffort !== adapter.effort) throw new Error('REVIEW_CYCLE_EFFORT_MISMATCH');
  if (!raw.id || typeof raw.id !== 'string') throw new Error('REVIEW_CYCLE_REAL_ID_REQUIRED');
  if (raw.requestId && w.requestId && raw.requestId !== w.requestId) throw new Error('REVIEW_CYCLE_RAW_REQUEST_MISMATCH');
  const transportStatus = String(raw.transportStatus || '').toLowerCase();
  if (!transportStatus) throw new Error('REVIEW_CYCLE_RAW_TRANSPORT_STATUS_REQUIRED');
  if (raw.inputHash && raw.inputHash !== candidateHash) throw new Error('REVIEW_CYCLE_INPUT_BINDING_MISMATCH');
  if (req.candidateHash && req.candidateHash !== candidateHash) throw new Error('REVIEW_CYCLE_REQUEST_CANDIDATE_MISMATCH');
  if (req.model && req.model !== adapter.model) throw new Error('REVIEW_CYCLE_REQUEST_MODEL_MISMATCH');
  if (req.effort && String(req.effort).toLowerCase() !== adapter.effort) throw new Error('REVIEW_CYCLE_REQUEST_EFFORT_MISMATCH');
  validateUsage(raw.usage);
  let verdict = null;
  if (raw.originalBody && raw.originalBody.includes('"ai-review-verdict"')) {
    verdict = parseVerdictBody(raw.originalBody, { candidateHash, purposeId, taskId, nonce: w.requestNonce });
    if (verdict.model !== adapter.model) throw new Error('REVIEW_CYCLE_ORIGINAL_VERDICT_MODEL_MISMATCH');
    if (String(verdict.effort).toLowerCase() !== adapter.effort) throw new Error('REVIEW_CYCLE_ORIGINAL_VERDICT_EFFORT_MISMATCH');
  } else if (step === 'opus') {
    throw new Error('REVIEW_CYCLE_ORIGINAL_VERDICT_REQUIRED');
  }
  return { rp, rh, wp, wh, w, provider: raw.provider, rawModel, rawEffort, rawId: raw.id, rawTransportStatus: transportStatus, usage: raw.usage, inputHash: candidateHash, requestId: w.requestId, taskId: w.taskId || taskId || null, nonce: w.requestNonce, verdict, originalBody: raw.originalBody, responseHash: resArt.hash, exitText };
}
export function recordStepReceipt(root, opts) {
  if(opts.step==='astra-diagnosis')throw new Error('REVIEW_CYCLE_ASTRA_RECEIPT_USE_DIAGNOSIS_ENTRY');
  return withLock(root,()=>{
    const reg=loadRegistry(root,{mode:'dispatch'});const cycle=Number(opts.cycle);
    const limited=cycle>2 && opts.step!=='astra-diagnosis';const c=limited?null:cycleByNumber(reg,cycle);
    const st=limited?Object.values(reg.limitedTickets||{}).find(t=>t.grantId===reg.limitedGrant?.grantId&&t.step===opts.step&&t.cycle===cycle):c?.steps[opts.step];
    assertTicketContext(reg,st,{candidateHash:opts.candidateHash,requestId:opts.requestId,taskId:opts.taskId});assertOpen(root,reg,st);
    if(!st.actualRoute)throw new Error('REVIEW_CYCLE_DISPATCH_NOT_CONSUMED');
    const v=validateWrapper(root,{...opts,cycle,purposeId:reg.activePurposeId,requestId:st.requestId,taskId:st.taskId,model:st.model,effort:st.effort});
    if (!['completed','success'].includes(v.rawTransportStatus)||Number(v.exitText)!==0)throw new Error('REVIEW_CYCLE_TRANSPORT_INCOMPLETE');
    const formal = limited && reg.limitedGrant?.scope === 'limited-formal-review' ? reg.limitedGrant : null;
    if (formal && ['deepseek','sol'].includes(opts.step)) {
      if (!v.verdict) throw new Error('REVIEW_CYCLE_FORMAL_VERDICT_REQUIRED');
      if (v.verdict.verdict === 'blocked' && ['P0','P1'].includes(String(v.verdict.severity))) {
        Object.assign(st,{status:'recorded',receiptPath:opts.receiptPath,receiptHash:opts.receiptHash,wrapperPath:opts.wrapperPath,wrapperHash:opts.wrapperHash,rawId:v.rawId,recordedAt:new Date().toISOString()});
        formal.final={status:'blocked',step:opts.step,cycle,candidateHash:opts.candidateHash,kind:'limited_formal_review',grantId:formal.grantId,severity:v.verdict.severity};
        formal.revoked=true;reg.halted=true;reg.haltedReason=`formal_${opts.step}_blocker_${v.verdict.severity}`;
        reg.history.push({event:'receipt_recorded',ticketId:st.ticketId,step:opts.step,cycle,blocked:true,at:new Date().toISOString()});
        saveRegistry(root,reg);
        throw new Error('REVIEW_CYCLE_FORMAL_BLOCKER_STOP');
      }
    }
    if(opts.step==='opus'){
      if(!v.verdict)throw new Error('REVIEW_CYCLE_OPUS_VERDICT_REQUIRED');
      const aggregate = formal || c;
      if(v.verdict.verdict==='pass' && (aggregate.practical?.status!=='passed'||aggregate.practical.candidateHash!==opts.candidateHash))throw new Error('REVIEW_CYCLE_PRACTICAL_PASS_REQUIRED_BEFORE_OPUS');
      if(v.verdict.verdict==='blocked' && (!['P0','P1'].includes(v.verdict.severity)||v.verdict.actualTestResult!==true))throw new Error('REVIEW_CYCLE_OPUS_BLOCKER_ACTUAL_TEST_REQUIRED');
      aggregate.opusOutcome=v.verdict.verdict==='pass'?'passed':'blocked';
      aggregate.status=aggregate.opusOutcome;
      aggregate.completedAt=new Date().toISOString();
      if(aggregate.opusOutcome==='passed'){
        if(formal){
          formal.final={status:'stopped_final_pass',cycle,candidateHash:opts.candidateHash,kind:'limited_formal_review',grantId:formal.grantId};
        } else {
          reg.final={status:'stopped_final_pass',cycle,candidateHash:opts.candidateHash,nonblocking:aggregate.practical?.nonblocking || []};
        }
      } else if(formal){
        formal.final={status:'blocked',cycle,candidateHash:opts.candidateHash,kind:'limited_formal_review',grantId:formal.grantId};
        formal.revoked=true;reg.halted=true;reg.haltedReason='formal_opus_blocked';
      }
    }
    Object.assign(st,{status:'recorded',receiptPath:opts.receiptPath,receiptHash:opts.receiptHash,wrapperPath:opts.wrapperPath,wrapperHash:opts.wrapperHash,rawId:v.rawId,recordedAt:new Date().toISOString()});
    reg.history.push({event:'receipt_recorded',ticketId:st.ticketId,step:opts.step,cycle,at:new Date().toISOString()});saveRegistry(root,reg);return{ok:true,opusOutcome:(formal||c)?.opusOutcome||null};
  });
}
export function recordPracticalOutcome(root, opts) {
  return withLock(root,()=>{
    const reg=loadRegistry(root,{mode:'dispatch'});const cycle=Number(opts.cycle);const limited=cycle>2;
    const c=limited?reg.limitedGrant:cycleByNumber(reg,cycle);
    const st=limited?Object.values(reg.limitedTickets||{}).find(t=>t.grantId===c?.grantId&&t.step==='practical'):c?.steps.practical;
    assertTicketContext(reg,st,{candidateHash:opts.candidateHash,taskId:opts.taskId,requestId:opts.requestId});assertOpen(root,reg,st);
    if(!st.actualRoute)throw new Error('REVIEW_CYCLE_DISPATCH_NOT_CONSUMED');
    const v=validateWrapper(root,{...opts,step:'practical',cycle,receiptPath:opts.proofPath||opts.receiptPath,receiptHash:opts.proofHash||opts.receiptHash,purposeId:reg.activePurposeId,taskId:st.taskId,requestId:st.requestId});
    if(!['completed','success'].includes(v.rawTransportStatus))throw new Error('REVIEW_CYCLE_TRANSPORT_INCOMPLETE');
    const exit=Number(v.exitText);if(!Number.isFinite(exit))throw new Error('REVIEW_CYCLE_PRACTICAL_EXIT_INVALID');
    const lines=v.originalBody.split('\n').map(x=>x.trim()).filter(x=>/^(ok|not ok)\b/.test(x));
    if(!lines.length)throw new Error('REVIEW_CYCLE_PRACTICAL_EVIDENCE_EMPTY');
    const derived=exit===0&&!lines.some(x=>x.startsWith('not ok'))?'passed':'failed';
    if(derived!==opts.status)throw new Error('REVIEW_CYCLE_PRACTICAL_STATUS_CONTRADICTION');
    if (opts.nonblocking !== undefined && (!Array.isArray(opts.nonblocking) || opts.nonblocking.some(x => !x || !['P2','P3'].includes(x.severity)))) throw new Error('REVIEW_CYCLE_NONBLOCKING_INVALID');
    st.status='recorded';c.practical={status:derived,candidateHash:opts.candidateHash,rawId:v.rawId,wrapperHash:opts.wrapperHash,nonblocking:opts.nonblocking || []};
    if(limited && c.scope === 'limited-formal-review'){
      if (derived === 'failed') {
        c.final={status:'blocked',candidateHash:opts.candidateHash,kind:'limited_formal_review',grantId:c.grantId,practical:c.practical};
        c.revoked=true;reg.halted=true;reg.haltedReason='formal_practical_failed';
      }
    } else if(limited){
      c.final={status:derived==='passed'?'stopped_final_pass':'blocked',candidateHash:opts.candidateHash,kind:'explicit_free_local_acceptance'};
      if(derived==='passed')reg.final={...c.final,limited:true,grantId:c.grantId};
      else {reg.halted=true;reg.haltedReason='limited_tests_failed';c.revoked=true;}
    } else c.status='practical_'+derived;
    reg.history.push({event:'practical_outcome',cycle,status:derived,candidateHash:opts.candidateHash,at:new Date().toISOString()});saveRegistry(root,reg);
    const formalPending = limited && c.scope === 'limited-formal-review' && derived === 'passed';
    return{ok:true,status:derived,stopped: limited && !formalPending};
  });
}
export function recordBlocker(root, { cycle, candidateHash, severity, summary, proofPath, proofHash, wrapperPath, wrapperHash, step = 'practical', actualTestResult = false }) { const sev = String(severity || ''); if (!/^P[0-3]$/.test(sev)) throw new Error('REVIEW_CYCLE_BLOCKER_SEVERITY_INVALID'); const cyc = assertCycleRange(cycle, step); const h = String(candidateHash || ''); return withLock(root, () => { const reg = loadRegistry(root, { mode: 'dispatch' }); if (reg.final?.status === 'stopped_final_pass') throw new Error('REVIEW_CYCLE_PRACTICAL_PASS_STOP'); if (reg.halted) throw new Error('REVIEW_CYCLE_HALTED'); const c = currentCycle(reg, cyc, step); validateWrapper(root, { wrapperPath, wrapperHash, receiptPath: proofPath, receiptHash: proofHash, step, cycle: cyc, purposeId: reg.activePurposeId, candidateHash: h, requestId: null, taskId: reg.binding?.taskId }); const b = { id: `b${cyc}-${c.blockers.length + 1}`, step, severity: sev, summary: String(summary || ''), actualTestResult: actualTestResult === true, candidateHash: h, proofPath: String(proofPath), proofHash, wrapperPath: String(wrapperPath), wrapperHash, at: new Date().toISOString() }; c.blockers.push(b); if (c.status === 'in_progress') c.status = 'blocked'; reg.history.push({ at: new Date().toISOString(), event: 'blocker_recorded', cycle: cyc, blockerId: b.id, severity: sev }); saveRegistry(root, reg); return { ok: true, blockerId: b.id }; }); }
export function requestAstraRootDiagnosis(root, opts) {
  const {cycle,candidateHash,blockerId,userSource,receiptPath,receiptHash,wrapperPath,wrapperHash,requestId,taskId,ticketId}=opts;
  const src=String(userSource||'').trim();if(!src)throw new Error('REVIEW_CYCLE_USER_SOURCE_REQUIRED');
  const cyc=assertCycleRange(cycle,'astra-diagnosis');
  return withLock(root,()=>{
    const reg=loadRegistry(root,{mode:'dispatch'});assertRetainedHistory(reg);
    if(completedBlockedCycles(reg).length<2)throw new Error('REVIEW_CYCLE_ASTRA_AFTER_TWO_CYCLES');
    const st=cycleByNumber(reg,cyc)?.steps['astra-diagnosis'];
    if(!st)throw new Error('REVIEW_CYCLE_ASTRA_NOT_RESERVED');
    if(ticketId!==undefined&&ticketId!==st.ticketId)throw new Error('REVIEW_CYCLE_TICKET_BINDING_MISMATCH');
    assertTicketContext(reg,st,{step:'astra-diagnosis',cycle:cyc,candidateHash,requestId,taskId});assertOpen(root,reg,st);
    if(!st.actualRoute)throw new Error('REVIEW_CYCLE_DISPATCH_NOT_CONSUMED');
    const blocker=reg.cycles.flatMap(c=>c.blockers||[]).find(b=>b.id===blockerId);
    if(!blocker)throw new Error('REVIEW_CYCLE_PROVEN_BLOCKER_REQUIRED');
    if(!['P0','P1'].includes(blocker.severity)||blocker.actualTestResult!==true||blocker.candidateHash!==candidateHash)throw new Error('REVIEW_CYCLE_PROVEN_PRACTICAL_BLOCKER_REQUIRED');
    const v=validateWrapper(root,{wrapperPath,wrapperHash,receiptPath,receiptHash,step:'astra-diagnosis',cycle:cyc,purposeId:st.purposeId,candidateHash:st.candidateHash,model:st.model,effort:st.effort,requestId:st.requestId,taskId:st.taskId});
    if(!['completed','success'].includes(v.rawTransportStatus)||Number(v.exitText)!==0)throw new Error('REVIEW_CYCLE_TRANSPORT_INCOMPLETE');
    Object.assign(st,{status:'recorded',receiptPath,receiptHash,wrapperPath,wrapperHash,model:v.rawModel,effort:v.rawEffort,recordedAt:new Date().toISOString(),blockerId,userSourceHash:sha256(src)});
    reg.history.push({at:new Date().toISOString(),event:'astra_root_diagnosis',cycle:cyc,ticketId:st.ticketId,blockerId,userSourceHash:sha256(src)});saveRegistry(root,reg);
    return{ok:true,halted:false,diagnosisRecorded:true};
  });
}
export function haltAfterAstraUnresolved(root, { cycle, reason, userSource } = {}) { return withLock(root, () => { const reg = loadRegistry(root, { mode: 'dispatch' }); if (!reg.cycles.some((c) => c.steps?.['astra-diagnosis']?.status === 'recorded')) throw new Error('REVIEW_CYCLE_ASTRA_DIAGNOSIS_REQUIRED'); if (reg.halted && reg.haltedReason === 'astra_diagnosis_unresolved') return { ok: true, halted: true, already: true }; reg.halted = true; reg.haltedReason = String(reason || 'astra_diagnosis_unresolved'); reg.history.push({ at: new Date().toISOString(), event: 'halt_after_astra_unresolved', cycle: cycle || null, userSourceHash: userSource ? sha256(String(userSource)) : null }); saveRegistry(root, reg); return { ok: true, halted: true }; }); }
export function inspectCycle(root) { const reg = loadRegistry(root, { mode: 'display' }); if (!reg) return { status: 'unconfirmed', reason: 'REVIEW_CYCLE_PURPOSE_UNBOUND' }; const formal = activeFormalGrant(reg); return { status: currentCycleStatus(reg), purposeId: reg.activePurposeId, cycleCount: Math.max(reg.cycles.length, retainedCounts(reg).normal), retainedHistory: reg.retainedHistory || null, retainedFinal: reg.retainedFinal || null, attempts: reg.attempts.length, unknown: reg.unknown.length, cycles: reg.cycles.map((c) => ({ cycle: c.cycle, status: c.status, steps: Object.fromEntries(Object.entries(c.steps).map(([k, v]) => [k, v.status])), practical: c.practical?.status || null, blockers: c.blockers.length })), final: reg.final, formalFinal: formal?.final || null, halted: reg.halted, haltedReason: reg.haltedReason, restartCount: reg.restartCount, limitedGrant: reg.limitedGrant ? { approvalHash: reg.limitedGrant.approvalHash, consumed: reg.limitedGrant.consumed, revoked: reg.limitedGrant.revoked, final: reg.limitedGrant.final || null } : null }; }
export function assertDispatchAllowed(root, { stage, mode = 'dispatch', candidateHash } = {}) { const auth = authorizeNextStep(root, { kind: 'send', stage: stage || '', mode, candidateHash }); return { ok: true, stage: stage || '', purposeId: auth.purposeId, limited: auth.limited === true }; }
export function cmgbIntakeCriterionPresent(root, task) {
  const resolvedTask = task || (existsSync(join(root, '.ai', 'current-task.json')) ? readJson(join(root, '.ai', 'current-task.json')) : null);
  if (!resolvedTask) return false;
  let result;
  try {
    result = loadApproval(root, resolvedTask, { requireApproved: true });
  } catch {
    return false;
  }
  if (result.errors?.length || !result.approval) return false;
  const criteria = Array.isArray(result.approval.completionCriteria) ? result.approval.completionCriteria : [];
  return criteria.some((criterion) => typeof criterion === 'string' && criterion.includes('cmgbExistingReceiptIntake:'));
}
export function assertCompletionAllowed(root, task) {
  if (cmgbIntakeCriterionPresent(root, task)) {
    if (!cmgbIntakeModule) {
      throw new Error(`CMGB_INTAKE_HELPER_UNAVAILABLE: ${cmgbIntakeLoadError?.message ?? 'cmgb-existing-receipt-intake.mjs unavailable'}`);
    }
    const nativeIntake = cmgbIntakeModule.verifyCmgbExistingReceiptCompletion(root, task);
    if (nativeIntake) return nativeIntake;
  }
  const reg = loadRegistry(root, { mode: 'completion' });
  const formal = activeFormalGrant(reg);
  const currentFinal = formal
    ? (formal.final ? { ...formal.final, limited: true, grantId: formal.grantId } : null)
    : reg.final;
  if (!currentFinal || currentFinal.status !== 'stopped_final_pass') throw new Error('REVIEW_CYCLE_PRACTICAL_PASS_REQUIRED');
  const grantId = currentFinal.grantId || null;
  if (grantId) {
    const grant = reg.limitedGrant?.grantId === grantId ? reg.limitedGrant : (reg.limitedPlans || []).find((g) => g.grantId === grantId);
    if (!grant || grant.revoked) throw new Error('REVIEW_CYCLE_GRANT_REVOKED');
    const currentTask = task || (existsSync(join(root, '.ai', 'current-task.json')) ? readJson(join(root, '.ai', 'current-task.json')) : null);
    if (!currentTask) throw new Error('REVIEW_CYCLE_CURRENT_TASK_REQUIRED');
    if (grant.taskId !== currentTask.taskId || grant.purposeId !== reg.activePurposeId) throw new Error('REVIEW_CYCLE_COMPLETION_TASK_PURPOSE_MISMATCH');
    const native = nativeLimitedApproval(root, grant.scope, grant.purposeId);
    if (native.hash !== grant.approvalHash || native.approval.documentHash !== grant.documentHash || native.approval.revision !== grant.approvalRev ||
        native.task.taskId !== grant.taskId || native.task.taskFingerprint !== grant.taskFingerprint) throw new Error('REVIEW_CYCLE_COMPLETION_APPROVAL_CHANGED');
    if (grant.scope === 'limited-formal-review') {
      if (!grant.final || grant.final.status !== 'stopped_final_pass') throw new Error('REVIEW_CYCLE_FORMAL_FINAL_REQUIRED');
      if (grant.final.candidateHash !== currentFinal.candidateHash) throw new Error('REVIEW_CYCLE_COMPLETION_CANDIDATE_MISMATCH');
      verifyCandidateBinding(root, grant.candidateBinding);
      const opus = Object.values(reg.limitedTickets || {}).find((t) => t.grantId === grant.grantId && t.step === 'opus' && t.status === 'recorded');
      if (!opus || opus.candidateHash !== currentFinal.candidateHash) throw new Error('REVIEW_CYCLE_FORMAL_OPUS_RECEIPT_REQUIRED');
      const practical = Object.values(reg.limitedTickets || {}).find((t) => t.grantId === grant.grantId && t.step === 'practical' && t.status === 'recorded');
      if (!practical || practical.candidateHash !== currentFinal.candidateHash) throw new Error('REVIEW_CYCLE_FORMAL_PRACTICAL_RECEIPT_REQUIRED');
    } else if (grant.scope === 'limited-local-repair') {
      if (!grant.final || grant.final.status !== 'stopped_final_pass') throw new Error('REVIEW_CYCLE_LIMITED_FINAL_REQUIRED');
      if (grant.final.candidateHash && grant.final.candidateHash !== currentFinal.candidateHash) throw new Error('REVIEW_CYCLE_COMPLETION_CANDIDATE_MISMATCH');
    } else {
      throw new Error('REVIEW_CYCLE_COMPLETION_SCOPE_UNSUPPORTED');
    }
  }
  return { ok: true, cycle: currentFinal.cycle, grantId };
}
export function noteImplementationEntry(root, { stage, mode = 'display' } = {}) { if (mode === 'display') return inspectCycle(root); const auth = authorizeNextStep(root, { kind: mode === 'start' || mode === 'bootstrap' ? 'start' : 'run', stage: stage || 'implementation' }); return { ok: true, stage: stage || 'bootstrap', purposeId: auth.purposeId, limited: auth.limited === true }; }
export function noteExternalReset(root, { requestId, reason } = {}) { return withLock(root, () => { const reg = loadRegistry(root, { mode: 'display' }) || null; if (!reg) return { ok: true, recorded: false }; if (reg.halted) throw new Error('REVIEW_CYCLE_HALTED'); reg.history.push({ at: new Date().toISOString(), event: 'external_reset', requestId: requestId || null, reason: String(reason || '') }); saveRegistry(root, reg); return { ok: true, recorded: true, cycleCount: reg.cycles.length, limitedGrant: reg.limitedGrant ? { approvalHash: reg.limitedGrant.approvalHash, consumed: reg.limitedGrant.consumed } : null }; }); }
