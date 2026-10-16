// Astra原因診断の必須関所。
// ねらい: レビュー上限に達して実用阻害が残ったとき、Astraの原因診断を記録しない限り
//         「停止して本人へ相談」へ進めないようにする（言葉のルールではなく機械の関所）。
// 根拠: knowledge/rules/code-review-three-rounds.md 現行節（2巡後も実用阻害が残る場合だけ Astra 診断を最大1回）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ASTRA_MODEL_RE = /^gpt-6-astra$/u;
export const DIAGNOSIS_FILE = ['.ai', 'context', 'astra-diagnosis.json'];
export const ROUNDS_FILE = ['.ai', 'context', 'review-rounds.json'];

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function diagnosisPath(root) { return join(root, ...DIAGNOSIS_FILE); }

function loadState(root) { return readJson(join(root, ...ROUNDS_FILE), null); }

// 診断が「義務づけられているか」（記録済みでも true）
export function astraDiagnosisMandated(state) {
  return state?.codeReview?.astraDiagnosis?.required === true;
}

// まだ記録されていない（未達の）要求があるか
export function astraDiagnosisRequired(state) {
  const d = state?.codeReview?.astraDiagnosis;
  if (!d || d.required !== true) return false;
  return d.status !== 'recorded';
}

// 記録が有効か（モデル・effort・終了コード・証跡の実在）
export function validateAstraDiagnosis(record, { root } = {}) {
  const errors = [];
  if (!record) return ['診断の記録がありません'];
  if (!ASTRA_MODEL_RE.test(String(record.model || ''))) errors.push(`モデルがAstraではありません: ${record.model || '(未指定)'}`);
  if (String(record.effort || '') !== 'high') errors.push(`effortはhighが必要です: ${record.effort || '(未指定)'}`);
  if (Number(record.exitCode) !== 0) errors.push(`終了コードが0ではありません: ${record.exitCode}`);
  if (!record.receiptPath || !String(record.receiptPath).trim()) errors.push('証跡（receipt）のパスが必要です');
  else if (root && !existsSync(String(record.receiptPath))) errors.push(`証跡ファイルがありません: ${record.receiptPath}`);
  if (!record.summary || !String(record.summary).trim()) errors.push('原因の要約（summary）が必要です');
  return errors;
}

// 停止・本人相談の直前に関所として呼ぶ（未記録なら throw）
export function assertAstraDiagnosisSatisfied({ root, state }) {
  const st = state || loadState(root);
  if (!astraDiagnosisMandated(st)) return { ok: true, skipped: true };
  const record = readJson(diagnosisPath(root), null);
  const errors = validateAstraDiagnosis(record, { root });
  if (errors.length) {
    const error = new Error(`ASTRA_DIAGNOSIS_REQUIRED: ${errors.join(' / ')}`);
    error.code = 'ASTRA_DIAGNOSIS_REQUIRED';
    throw error;
  }
  return { ok: true, record };
}

// 診断の実施を記録する（実施しなくても required は消えない）
export function recordAstraDiagnosis({ root, model, effort, receiptPath, exitCode, summary, executedBy, now = new Date().toISOString() }) {
  const state = loadState(root);
  if (!state) return { ok: false, errors: [`レビュー状態がありません: ${join(root, ...ROUNDS_FILE)}`] };
  if (!astraDiagnosisRequired(state)) {
    return { ok: false, errors: ['このレーンはAstra診断が要求されていません（上限未到達、または記録済み）'] };
  }
  const record = {
    schema: 'ai-dev-tool/astra-diagnosis@1',
    model: String(model || ''),
    effort: String(effort || ''),
    receiptPath: receiptPath ? String(receiptPath) : '',
    exitCode: Number(exitCode),
    summary: String(summary || '').trim(),
    executedBy: String(executedBy || '').trim() || null,
    recordedAt: now,
  };
  const errors = validateAstraDiagnosis(record, { root });
  if (errors.length) return { ok: false, errors };
  writeJson(diagnosisPath(root), record);
  state.codeReview.astraDiagnosis = {
    ...(state.codeReview.astraDiagnosis || {}),
    required: true,
    status: 'recorded',
    model: record.model,
    effort: record.effort,
    recordedAt: now,
  };
  writeJson(join(root, ...ROUNDS_FILE), state);
  return { ok: true, record, path: diagnosisPath(root) };
}

export function astraDiagnosisStatus({ root }) {
  const state = loadState(root);
  const record = readJson(diagnosisPath(root), null);
  return {
    required: Boolean(state?.codeReview?.astraDiagnosis?.required),
    status: state?.codeReview?.astraDiagnosis?.status || (record ? 'recorded' : 'none'),
    record,
  };
}
