import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { agentWorkDir, gitValue } from './ai-e2e-lib.mjs';

/**
 * 後追い完了(retrospective close)の入力検証。
 *
 * 目的: 正規の完了ゲート(事前承認済み完成図 + 機械検証可能なE2E証跡)を「作業より後に
 * ハーネスを入れた」「当時の証跡ファイルが実在しない」「記録同士が食い違う」といった
 * 構造的理由で通せない滞留タスクを、**正規ゲート通過とは機械的に区別できる別区分**で
 * 終了させる。承認記録やE2E証跡を後から捏造して通常ゲートを通す代わりにはならない。
 *
 * 設計方針:
 * - 裏付けは必ず機械検証する。fileは実在・regular file・非symlink・非空をlstatで確認して
 *   sha256を記録し、commitは実git objectとして解決し、declarationは実宣言fieldと突合する。
 *   1件でも検証に失敗したらfail-closed(呼び出し側が非0終了)。
 * - ユーザー確認は「事前承認」ではなく「後追いの結果確認」であることを記録上明示する。
 * - 通常完了の検証JSONと同じ形にしない。closureKindで機械判別できることを最優先にする。
 */

export const RETROSPECTIVE_SCHEMA_VERSION = 1;
/** 完了検証JSONのclosureKind。通常ゲート通過 / 警告前進 / 後追い完了を機械判別する。 */
export const GATED_CLOSURE_KIND = 'gated';
export const WARNED_FORWARD_CLOSURE_KIND = 'warned_forward';
export const RETROSPECTIVE_CLOSURE_KIND = 'retrospective';
/** 通常ゲートを通せない構造的理由。ここに無い理由は後追い完了の対象外(=通常ゲートで閉じる)。 */
export const RETROSPECTIVE_REASON_CODES = [
  // 作業より後にハーネスを導入したため、作業前の承認済み完成図が存在しようがない
  'harness_installed_after_work',
  // 当時の確認は行われたが、宣言が指すE2E証跡ファイルが実在しない
  'evidence_file_missing',
  // current-task.json・作業宣言・証跡の記録同士が食い違い、正規ゲートがfail-closedする
  'record_mismatch',
];
/** ユーザー確認の種別。approval.jsonの事前承認(approvedBy/approvedAt)と混同させない。 */
export const RETROSPECTIVE_CONFIRMATION_KIND = 'after_the_fact_result_confirmation';
export const RETROSPECTIVE_CONFIRMATION_NOTE =
  '事前承認ではなく、作業完了後にユーザーが結果だけを確認した記録です（.ai/approval.jsonの事前承認とは別物）。';

const TOP_LEVEL_FIELDS = new Set(['schemaVersion', 'reasonCode', 'reason', 'supportingEvidence', 'userConfirmation']);
const CONFIRMATION_FIELDS = new Set(['confirmedBy', 'confirmedAt', 'source', 'statement', 'acknowledgedNotPreApproval']);
const EVIDENCE_KINDS = new Set(['file', 'commit', 'declaration']);
const MIN_REASON_LENGTH = 20;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
const DECLARATION_FIELD_PATTERN = /^[a-z][a-z0-9_]*$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 作業宣言の1行へ書き戻す値に使うため、改行・制御文字を含む文字列は受け付けない。 */
function singleLine(value) {
  return typeof value === 'string' && !CONTROL_CHAR_PATTERN.test(value);
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * 後追い完了の対象宣言パスを解決する。
 * 台帳(${AGENT_WORK_DIR:-~/projects/.agent-work})の直下だけを許可し、
 * completed/配下や台帳外のパス、symlinkを拒否する。
 */
export function resolveDeclarationPath(requested) {
  const workDir = resolve(agentWorkDir());
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(workDir, requested);
  if (resolve(absolute, '..') !== workDir) {
    throw new Error(`作業宣言は台帳直下(${workDir})のファイルだけを指定できます: ${requested}`);
  }
  if (!existsSync(absolute)) throw new Error(`active作業宣言がありません: ${absolute}`);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('作業宣言はsymlinkではないregular fileが必要です');
  return absolute;
}

/** 作業宣言のrepo/branchから期待されるファイル名。台帳の命名規約と同じ。 */
export function declarationFileName(declaration) {
  const repo = text(declaration?.repo);
  const branch = text(declaration?.branch);
  if (!repo || !branch) return '';
  return `${repo}--${branch.replaceAll('/', '-')}.md`;
}

/**
 * 裏付け1件ずつを実データへ突き合わせる。戻り値のverifiedは検証済みの正規化結果で、
 * 完了検証JSONへそのまま保存する（後から第三者が同じ検査を再実行できるようにするため）。
 */
export function verifySupportingEvidence({ root, items, declaration }) {
  const errors = [];
  const verified = [];
  if (!Array.isArray(items) || items.length === 0) {
    return { errors: ['supportingEvidenceは1件以上必要です'], verified };
  }
  items.forEach((item, index) => {
    const label = `supportingEvidence[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${label}はobjectが必要です`);
      return;
    }
    const kind = text(item.kind);
    if (!EVIDENCE_KINDS.has(kind)) {
      errors.push(`${label}.kindはfile/commit/declarationのいずれかが必要です: ${kind || '(missing)'}`);
      return;
    }
    const note = text(item.note);
    if (!note) {
      errors.push(`${label}.noteに「何の裏付けか」を書いてください`);
      return;
    }
    if (kind === 'file') {
      const raw = text(item.path);
      if (!raw) {
        errors.push(`${label}.pathが空です`);
        return;
      }
      if (!singleLine(raw) || raw.includes(',')) {
        errors.push(`${label}.pathに改行・カンマ・制御文字は使えません`);
        return;
      }
      const absolute = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
      if (!existsSync(absolute)) {
        errors.push(`${label}の裏付けファイルが実在しません: ${absolute}`);
        return;
      }
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        errors.push(`${label}はsymlinkではないregular fileが必要です: ${absolute}`);
        return;
      }
      if (statSync(absolute).size === 0) {
        errors.push(`${label}の裏付けファイルが空です: ${absolute}`);
        return;
      }
      verified.push({ kind, note, path: absolute, bytes: stat.size, sha256: sha256File(absolute) });
      return;
    }
    if (kind === 'commit') {
      const ref = text(item.ref);
      if (!COMMIT_PATTERN.test(ref)) {
        errors.push(`${label}.refは7〜40桁のcommit SHAが必要です: ${ref || '(missing)'}`);
        return;
      }
      const resolved = gitValue(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      if (!/^[0-9a-f]{40}$/.test(resolved)) {
        errors.push(`${label}のcommitがこのリポジトリに実在しません: ${ref}`);
        return;
      }
      verified.push({ kind, note, ref, commit: resolved });
      return;
    }
    const field = text(item.field);
    const expected = text(item.expected);
    if (!DECLARATION_FIELD_PATTERN.test(field)) {
      errors.push(`${label}.fieldは作業宣言のfield名が必要です: ${field || '(missing)'}`);
      return;
    }
    if (!expected) {
      errors.push(`${label}.expectedが空です`);
      return;
    }
    const actual = text(declaration?.[field]);
    if (actual !== expected) {
      errors.push(`${label}: 作業宣言の${field}が${expected}ではありません（実際: ${actual || '(missing)'}）`);
      return;
    }
    verified.push({ kind, note, field, value: actual });
  });
  if (!verified.some((item) => item.kind === 'file')) {
    errors.push('supportingEvidenceには実在するファイル(kind=file)を1件以上含めてください');
  }
  return { errors, verified };
}

/**
 * 後追い完了の入力JSONを検証し、完了検証JSONへ保存する正規化済みrecordを返す。
 * errorsが1件でもあれば呼び出し側はfail-closedで非0終了する。
 */
export function validateRetrospectiveInput({ root, input, declaration }) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: ['後追い完了の入力JSONはobjectが必要です'], record: null };
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_FIELDS.has(key)) errors.push(`未知fieldは使用できません: ${key}`);
  }
  if (input.schemaVersion !== RETROSPECTIVE_SCHEMA_VERSION) {
    errors.push(`schemaVersionは${RETROSPECTIVE_SCHEMA_VERSION}必須です`);
  }
  const reasonCode = text(input.reasonCode);
  if (!RETROSPECTIVE_REASON_CODES.includes(reasonCode)) {
    errors.push(`reasonCodeは${RETROSPECTIVE_REASON_CODES.join(' / ')}のいずれかが必要です: ${reasonCode || '(missing)'}`);
  }
  const reason = text(input.reason);
  if (reason.length < MIN_REASON_LENGTH) {
    errors.push(`reasonには「なぜ通常ゲートを通せないか」を${MIN_REASON_LENGTH}文字以上で書いてください`);
  }
  const evidence = verifySupportingEvidence({ root, items: input.supportingEvidence, declaration });
  errors.push(...evidence.errors);

  const confirmation = input.userConfirmation;
  let normalizedConfirmation = null;
  if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) {
    errors.push('userConfirmation（後追いでの結果確認の記録）が必要です');
  } else {
    for (const key of Object.keys(confirmation)) {
      if (!CONFIRMATION_FIELDS.has(key)) errors.push(`userConfirmationの未知fieldは使用できません: ${key}`);
    }
    const confirmedBy = text(confirmation.confirmedBy);
    const confirmedAt = text(confirmation.confirmedAt);
    const source = text(confirmation.source);
    const statement = text(confirmation.statement);
    if (!confirmedBy) errors.push('userConfirmation.confirmedBy（誰が確認したか）が空です');
    if (!confirmedAt || !Number.isFinite(Date.parse(confirmedAt))) {
      errors.push('userConfirmation.confirmedAt（いつ確認したか）が日時として不正です');
    }
    if (!source) errors.push('userConfirmation.source（どこでの確認か・出所）が空です');
    if (!statement) errors.push('userConfirmation.statement（何を確認したか）が空です');
    if (confirmation.acknowledgedNotPreApproval !== true) {
      errors.push('userConfirmation.acknowledgedNotPreApprovalにtrue（事前承認ではなく後追い確認だと認識している）が必要です');
    }
    if (![confirmedBy, confirmedAt, source].every((value) => singleLine(value) && !value.includes(','))) {
      errors.push('userConfirmationのconfirmedBy/confirmedAt/sourceに改行・カンマ・制御文字は使えません');
    }
    normalizedConfirmation = {
      confirmationKind: RETROSPECTIVE_CONFIRMATION_KIND,
      note: RETROSPECTIVE_CONFIRMATION_NOTE,
      confirmedBy,
      confirmedAt,
      source,
      statement,
    };
  }
  if (errors.length) return { errors, record: null };
  return {
    errors,
    record: {
      schemaVersion: RETROSPECTIVE_SCHEMA_VERSION,
      reasonCode,
      reason,
      supportingEvidence: evidence.verified,
      userConfirmation: normalizedConfirmation,
    },
  };
}

/** 作業宣言のretrospective_evidenceへ書き戻す、file裏付けの実パス一覧(カンマ区切り)。 */
export function evidencePathList(record) {
  return (record?.supportingEvidence || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.path)
    .join(',');
}
