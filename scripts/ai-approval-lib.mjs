import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import {
  actualRepoName,
  agentWorkDir,
  atomicWriteJson,
  declarationPathFor,
  ensureRegularFile,
  gitValue,
  parseDeclaration,
  readJson,
  resolveRepoPath,
  safeId,
} from './ai-e2e-lib.mjs';
import { aiCmd } from './ai-workflow-lib.mjs';

export const APPROVAL_SCHEMA_VERSION = 1;
export const APPROVAL_RELATIVE_PATH = '.ai/approval.json';
// profile/team/identityの手編集境界。knowledge/scripts/ai-docs-task.mjsの同名定数と完全一致させる。
export const PROTECTED_TASK_FIELDS = ['workflowProfile', 'team', 'reviewer', 'implementer'];
const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion', 'status', 'taskId', 'taskFingerprint', 'repo', 'branch', 'revision',
  'source', 'vision', 'deliverable_summary', 'userAgreementQuotes', 'completionCriteria', 'nonGoals',
  'assumptions', 'openQuestions', 'concerns', 'implementationPlan', 'surfaceKind', 'deploymentKind',
  'productionDeployment', 'classificationCorrections', 'reviewEscalationDecisions', 'documentHash', 'approval',
]);
const IMPLEMENTATION_PLAN_FIELDS = new Set(['estimatedMinutes', 'lanes', 'singleLaneReason']);
const SURFACE_KINDS = new Set(['web_ui', 'non_web']);
const DEPLOYMENT_KINDS = new Set(['production', 'non_production']);
const UI_PATH_PREFIXES = ['src/app/', 'src/components/', 'src/pages/', 'app/', 'components/'];
const UI_FILE_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.css', '.scss', '.html']);
const COMPARISON_OR_EVALUATION_PATTERN = /(?:比較|評価|横並び|compare|comparison|evaluate|evaluation)/iu;
const AGREEMENT_PLACEHOLDER_PATTERN = /(?:\[\s*(?:(?:(?:ユーザー)?(?:合意)?(?:原文|引用)|記入|ここ)[^\]]*)?\s*\]|<\s*(?:合意|原文|引用|記入|ここ)[^>]*>|\b(?:todo|tbd|fixme)\b|後で(?:記入|確認)|未記入|仮置き|ダミー|プレースホルダ|趣旨(?:です|のみ)|要約(?:です|のみ)|原文(?:未確認|なし)|同上)/iu;
const AGREEMENT_SUMMARY_ESCAPE_PATTERN = /(?:という|との)趣旨(?:です|でした|だ|のみ)?(?:[。.．]?以上)?[。.．]?$/u;
const AGREEMENT_CHECK_PATTERN = /agreementCheck\s*[:：]\s*(矛盾なし|例外として合意済み)\s*[（(]([^）)]*)[）)]/u;
const AGREEMENT_CHECK_DECLARATION_PATTERN = /agreementCheck\s*[:：]/u;
const SIMPLE_AGREEMENT_CHECK = '（agreementCheck: 矛盾なし(引用index=0を確認)）';
const GENERIC_FEATURE_TERMS = new Set([
  'agreementcheck', 'useragreementquotes', 'ユーザー', 'タスク', '今回', '既存', '対象', '範囲',
  '合意', '引用', '確認', '完了', '条件', '作業', '変更', '機能', '仕様', '実装', '対応', '追加',
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function approvalContent(approval) {
  const content = {
    schemaVersion: approval?.schemaVersion,
    taskId: approval?.taskId,
    taskFingerprint: approval?.taskFingerprint,
    repo: approval?.repo,
    branch: approval?.branch,
    revision: approval?.revision,
    source: approval?.source,
    vision: approval?.vision,
    deliverable_summary: approval?.deliverable_summary,
    userAgreementQuotes: approval?.userAgreementQuotes,
    completionCriteria: approval?.completionCriteria,
    nonGoals: approval?.nonGoals,
    assumptions: approval?.assumptions,
    openQuestions: approval?.openQuestions,
    concerns: approval?.concerns,
  };
  for (const field of ['implementationPlan', 'surfaceKind', 'deploymentKind', 'productionDeployment', 'classificationCorrections', 'reviewEscalationDecisions']) {
    if (Object.hasOwn(approval || {}, field)) content[field] = approval[field];
  }
  return content;
}

function requiresDeliverableSummary(task) {
  return [task?.task, task?.taskFingerprint].some((value) =>
    COMPARISON_OR_EVALUATION_PATTERN.test(String(value || '')),
  );
}

export function approvalContentHash(approval) {
  return sha256(JSON.stringify(canonical(approvalContent(approval))));
}

export function autofillSimpleNonGoalAgreementChecks(draft) {
  if (draft?.source?.type !== 'simple' || !Array.isArray(draft.nonGoals)) {
    return { draft, count: 0 };
  }
  let count = 0;
  const nonGoals = draft.nonGoals.map((item) => {
    if (typeof item !== 'string' || !item.trim() || AGREEMENT_CHECK_DECLARATION_PATTERN.test(item)) return item;
    count += 1;
    return `${item}${SIMPLE_AGREEMENT_CHECK}`;
  });
  if (count === 0) return { draft, count };
  const autofilled = { ...draft, nonGoals };
  autofilled.documentHash = approvalContentHash(autofilled);
  return { draft: autofilled, count };
}

export function approvalRecordHash(record) {
  return sha256(JSON.stringify(canonical({
    approvedBy: record?.approvedBy,
    approvedAt: record?.approvedAt,
    approvedContentHash: record?.approvedContentHash,
    warnings: record?.warnings,
  })));
}

function stringArray(value, label, errors, { required = false } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${label}は配列が必要です`);
    return;
  }
  if (required && value.length === 0) errors.push(`${label}は1件以上必要です`);
  value.forEach((item, index) => {
    if (!text(item)) errors.push(`${label}[${index}]は空でない文字列が必要です`);
  });
}

function classificationSnapshot(value) {
  const snapshot = { surfaceKind: text(value?.surfaceKind) || null };
  if (text(value?.deploymentKind)) snapshot.deploymentKind = text(value.deploymentKind);
  if (typeof value?.productionDeployment === 'boolean') {
    snapshot.productionDeployment = value.productionDeployment;
  }
  return snapshot;
}

function validateClassificationCorrections(value, errors) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push('classificationCorrectionsは配列が必要です');
    return;
  }
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`classificationCorrections[${index}]はobjectが必要です`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!['changedAt', 'reason', 'from', 'to'].includes(key)) {
        errors.push(`classificationCorrections[${index}]の未知fieldは使用できません: ${key}`);
      }
    }
    if (!text(entry.changedAt) || !Number.isFinite(Date.parse(entry.changedAt))) {
      errors.push(`classificationCorrections[${index}].changedAtが日時として不正です`);
    }
    if (!text(entry.reason)) errors.push(`classificationCorrections[${index}].reasonが空です`);
    for (const side of ['from', 'to']) {
      const snapshot = entry[side];
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        errors.push(`classificationCorrections[${index}].${side}はobjectが必要です`);
        continue;
      }
      for (const key of Object.keys(snapshot)) {
        if (!['surfaceKind', 'deploymentKind', 'productionDeployment'].includes(key)) {
          errors.push(`classificationCorrections[${index}].${side}の未知fieldは使用できません: ${key}`);
        }
      }
      if (snapshot.surfaceKind !== null && !SURFACE_KINDS.has(text(snapshot.surfaceKind))) {
        errors.push(`classificationCorrections[${index}].${side}.surfaceKindが不正です`);
      }
      if (snapshot.deploymentKind !== undefined && !DEPLOYMENT_KINDS.has(text(snapshot.deploymentKind))) {
        errors.push(`classificationCorrections[${index}].${side}.deploymentKindが不正です`);
      }
      if (snapshot.productionDeployment !== undefined && typeof snapshot.productionDeployment !== 'boolean') {
        errors.push(`classificationCorrections[${index}].${side}.productionDeploymentはbooleanが必要です`);
      }
    }
  });
}

function validateReviewEscalationDecisions(value, errors) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push('reviewEscalationDecisionsは配列が必要です');
    return;
  }
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`reviewEscalationDecisions[${index}]はobjectが必要です`);
      return;
    }
    const fields = [
      'taskId', 'taskFingerprint', 'escalationId', 'sizeClass', 'maxRounds', 'lastRequestId',
      'findingsDigest', 'decision', 'decidedBy', 'decidedAt', 'reason',
    ];
    for (const key of Object.keys(entry)) {
      if (!fields.includes(key)) errors.push(`reviewEscalationDecisions[${index}]の未知fieldは使用できません: ${key}`);
    }
    for (const field of ['taskId', 'taskFingerprint', 'escalationId', 'lastRequestId', 'findingsDigest', 'decidedBy', 'reason']) {
      if (!text(entry[field])) errors.push(`reviewEscalationDecisions[${index}].${field}が空です`);
    }
    const currentPolicyDecision = ['small', 'large'].includes(entry.sizeClass) && entry.maxRounds === 3;
    const legacyLargeDecision = entry.sizeClass === 'large' && entry.maxRounds === 10;
    if (!currentPolicyDecision && !legacyLargeDecision) {
      errors.push(`reviewEscalationDecisions[${index}]は現行の3往復または旧形式largeの10往復が必要です`);
    }
    if (entry.decision !== 'proceed_with_findings') {
      errors.push(`reviewEscalationDecisions[${index}].decisionが不正です`);
    }
    if (!text(entry.decidedAt) || !Number.isFinite(Date.parse(entry.decidedAt))) {
      errors.push(`reviewEscalationDecisions[${index}].decidedAtが日時として不正です`);
    }
    if (!/^[a-f0-9]{64}$/u.test(text(entry.findingsDigest))) {
      errors.push(`reviewEscalationDecisions[${index}].findingsDigestが不正です`);
    }
  });
}

function validateApprovalClassification(task, approval, errors) {
  const hasClassification = ['surfaceKind', 'deploymentKind', 'productionDeployment', 'classificationCorrections']
    .some((field) => Object.hasOwn(approval, field));
  if (!hasClassification) return;
  const surfaceKind = text(approval.surfaceKind);
  if (!SURFACE_KINDS.has(surfaceKind)) errors.push('approval.jsonのsurfaceKindはweb_ui|non_webが必要です');
  if (surfaceKind && surfaceKind !== text(task?.surfaceKind)) {
    errors.push('approval.jsonのsurfaceKindがcurrent-task.jsonと一致しません');
  }
  if (surfaceKind === 'non_web') {
    if (Object.hasOwn(approval, 'deploymentKind') || Object.hasOwn(approval, 'productionDeployment')) {
      errors.push('approval.jsonのnon_webにはdeploymentKind/productionDeploymentを保存できません');
    }
  } else if (surfaceKind === 'web_ui') {
    const deploymentKind = text(approval.deploymentKind);
    if (!DEPLOYMENT_KINDS.has(deploymentKind)) {
      errors.push('approval.jsonのweb_uiにはdeploymentKind=production|non_productionが必要です');
    }
    if (typeof approval.productionDeployment !== 'boolean'
      || approval.productionDeployment !== (deploymentKind === 'production')) {
      errors.push('approval.jsonのproductionDeploymentとdeploymentKindが矛盾しています');
    }
    if (deploymentKind !== text(task?.deploymentKind)
      || approval.productionDeployment !== task?.productionDeployment) {
      errors.push('approval.jsonのdeployment設定がcurrent-task.jsonと一致しません');
    }
  }
  validateClassificationCorrections(approval.classificationCorrections, errors);
}

function agreementInputExample() {
  return '例: "userAgreementQuotes": [{"quote":"ユーザーの合意原文をそのまま貼る","source":"2026-08-12の打ち合わせ"}], "nonGoals": ["対象外（agreementCheck: 矛盾なし(引用index=0を確認)）"]。合意が無い場合だけ quote を NONE、source を合意不在の理由にしてください';
}

function hasPlaceholder(value) {
  const valueText = text(value);
  return AGREEMENT_PLACEHOLDER_PATTERN.test(valueText) || AGREEMENT_SUMMARY_ESCAPE_PATTERN.test(valueText);
}

function hasUnusableAgreementSource(value) {
  return /^(?:なし|不明|未確認|未記入|同上|-+)$/u.test(text(value));
}

function validateUserAgreementQuotes(value, errors) {
  if (!Array.isArray(value)) {
    errors.push(`userAgreementQuotesは1件以上の配列が必要です。${agreementInputExample()}`);
    return [];
  }
  if (value.length === 0) errors.push(`userAgreementQuotesは空配列にできません。${agreementInputExample()}`);
  const quotes = [];
  value.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`userAgreementQuotes[${index}]はquoteとsourceを持つobjectが必要です。${agreementInputExample()}`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (!['quote', 'source'].includes(key)) errors.push(`userAgreementQuotes[${index}]の未知fieldは使用できません: ${key}`);
    }
    const quote = text(item.quote);
    const source = text(item.source);
    if (!quote) errors.push(`userAgreementQuotes[${index}].quoteは空にできません。${agreementInputExample()}`);
    if (!source) errors.push(`userAgreementQuotes[${index}].sourceは空にできません。${agreementInputExample()}`);
    if (quote && quote !== 'NONE' && hasPlaceholder(quote)) {
      errors.push(`userAgreementQuotes[${index}].quoteはプレースホルダ・要約・定型逃げ文言を使用できません。合意原文をそのまま貼ってください。${agreementInputExample()}`);
    }
    if (quote && quote !== 'NONE' && /^none$/iu.test(quote)) {
      errors.push(`userAgreementQuotes[${index}].quoteの合意不在宣言は大文字のNONEだけを使用してください。${agreementInputExample()}`);
    }
    if (source && (source === 'NONE' || hasPlaceholder(source) || hasUnusableAgreementSource(source))) {
      errors.push(`userAgreementQuotes[${index}].sourceには合意日時・場所、または合意不在の具体的な理由が必要です。${agreementInputExample()}`);
    }
    quotes.push({ quote, source });
  });
  const noneQuotes = quotes.filter((item) => item.quote === 'NONE');
  if (noneQuotes.length > 0 && (quotes.length !== 1 || noneQuotes.length !== 1)) {
    errors.push('quote=NONEは他の引用と混在できません。合意が無いタスクではNONEを1件だけ明示してください');
  }
  if (noneQuotes.length === 1 && hasUnusableAgreementSource(noneQuotes[0].source)) {
    errors.push('quote=NONEのsourceには「合意が存在しない理由」を具体的に記載してください');
  }
  return quotes;
}

function featureTerms(value) {
  const normalized = text(value).normalize('NFKC').toLowerCase();
  const terms = new Set();
  for (const token of normalized.match(/[a-z][a-z0-9_-]{2,}/gu) || []) {
    if (!GENERIC_FEATURE_TERMS.has(token)) terms.add(token);
  }
  for (const segment of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{3,}/gu) || []) {
    const maxLength = Math.min(8, segment.length);
    for (let size = 3; size <= maxLength; size += 1) {
      for (let offset = 0; offset + size <= segment.length; offset += 1) {
        const term = segment.slice(offset, offset + size);
        if (!/[\p{Script=Han}\p{Script=Katakana}]/u.test(term)) continue;
        if (!GENERIC_FEATURE_TERMS.has(term)) terms.add(term);
      }
    }
  }
  return terms;
}

function sharedFeatureTerms(left, right) {
  const leftTerms = featureTerms(left);
  const rightTerms = featureTerms(right);
  return [...leftTerms]
    .filter((term) => rightTerms.has(term))
    .sort((a, b) => b.length - a.length || a.localeCompare(b, 'ja'))
    .filter((term, index, all) => !all.slice(0, index).some((longer) => longer.includes(term)))
    .slice(0, 3);
}

function validateNonGoalAgreementChecks(nonGoals, quotes, errors) {
  if (!Array.isArray(nonGoals)) return;
  nonGoals.forEach((item, nonGoalIndex) => {
    if (!text(item)) return;
    const match = text(item).match(AGREEMENT_CHECK_PATTERN);
    if (!match) {
      errors.push(`nonGoals[${nonGoalIndex}]にはagreementCheckの明示宣言が必要です。例: "対象外（agreementCheck: 矛盾なし(引用index=0を確認)）"`);
      return;
    }
    const [, verdict, detail] = match;
    const scopeText = text(item).replace(AGREEMENT_CHECK_PATTERN, '');
    const referencedIndexes = [...detail.matchAll(/引用index\s*=\s*(\d+)/gu)].map((entry) => Number(entry[1]));
    for (const quoteIndex of referencedIndexes) {
      if (!Number.isInteger(quoteIndex) || quoteIndex < 0 || quoteIndex >= quotes.length) {
        errors.push(`nonGoals[${nonGoalIndex}]のagreementCheckが存在しない引用index=${quoteIndex}を参照しています`);
      }
    }
    if (verdict === '例外として合意済み' && referencedIndexes.length === 0) {
      errors.push(`nonGoals[${nonGoalIndex}]の「例外として合意済み」には該当する引用indexが必要です`);
    }
    quotes.forEach((quote, quoteIndex) => {
      if (!quote.quote || quote.quote === 'NONE') return;
      const shared = sharedFeatureTerms(scopeText, quote.quote);
      if (shared.length === 0 || referencedIndexes.includes(quoteIndex)) return;
      errors.push([
        `nonGoals[${nonGoalIndex}]とuserAgreementQuotes[${quoteIndex}]に特徴語の重なりがあります（${shared.join('、')}）`,
        `対象ペアを原文で確認し、agreementCheckへ「引用index=${quoteIndex}」を明記してください。例: "対象外（agreementCheck: ${verdict}(引用index=${quoteIndex}を確認)）"`,
      ].join('。'));
    });
  });
}

export function agreementCoverageWarnings(approval) {
  if (!Array.isArray(approval?.userAgreementQuotes) || !Array.isArray(approval?.completionCriteria)) return [];
  return approval.userAgreementQuotes.flatMap((item, index) => {
    const quote = text(item?.quote);
    if (!quote || quote === 'NONE') return [];
    const referenced = approval.completionCriteria.some((criterion) =>
      new RegExp(`引用(?:index|インデックス)?\\s*[:=]?\\s*${index}(?:\\D|$)`, 'iu').test(text(criterion))
      || text(criterion).includes(quote),
    );
    return referenced ? [] : [`userAgreementQuotes[${index}]がcompletionCriteriaから参照されていません`];
  });
}

function validateImplementationPlan(value, errors) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('implementationPlanはobjectが必要です');
    return;
  }
  for (const key of Object.keys(value)) {
    if (!IMPLEMENTATION_PLAN_FIELDS.has(key)) {
      errors.push(`implementationPlanの未知fieldは使用できません: ${key}`);
    }
  }
  for (const field of ['estimatedMinutes', 'lanes']) {
    if (!Object.hasOwn(value, field)) errors.push(`implementationPlan.${field}が必要です`);
  }
  const estimatedMinutesValid = typeof value.estimatedMinutes === 'number'
    && Number.isFinite(value.estimatedMinutes)
    && value.estimatedMinutes >= 0;
  if (!estimatedMinutesValid) {
    errors.push('implementationPlan.estimatedMinutesは0以上の有限な数値が必要です');
  }
  const lanesValid = Number.isInteger(value.lanes) && value.lanes >= 1;
  if (!lanesValid) errors.push('implementationPlan.lanesは1以上の整数が必要です');
  if (Object.hasOwn(value, 'singleLaneReason')) {
    if (typeof value.singleLaneReason !== 'string') {
      errors.push('implementationPlan.singleLaneReasonは文字列が必要です');
    } else if (/[\r\n\u2028\u2029]/u.test(value.singleLaneReason)) {
      errors.push('implementationPlan.singleLaneReasonは1行で指定してください');
    }
  }
  if (
    estimatedMinutesValid
    && lanesValid
    && value.estimatedMinutes > 30
    && value.lanes <= 1
    && !text(value.singleLaneReason)
  ) {
    errors.push('PARALLEL_LANES_REQUIRED: estimatedMinutesが30分を超え、lanesが1以下です。複数レーンへ分割するか、singleLaneReasonへ分割できない理由を1行で指定してください');
  }
}

export function implementationPlanWarnings(approval) {
  return Object.hasOwn(approval || {}, 'implementationPlan')
    ? []
    : ['PARALLEL_PLAN_MISSING: implementationPlanがないため並行実装計画の検査を省略しました'];
}

function validateAgreementGate(
  approval,
  errors,
  { allowLegacyDraft = false, allowAgreementRepairDraft = false } = {},
) {
  // 既に承認済みの旧形式は遡及拒否しない。reopen/createした時点から新しい入力契約を適用する。
  if (approval.status === 'approved' && !Object.hasOwn(approval, 'userAgreementQuotes')) return;
  if (allowAgreementRepairDraft && approval.status !== 'approved') return;
  if (allowLegacyDraft && !Object.hasOwn(approval, 'userAgreementQuotes')) return;
  const quotes = validateUserAgreementQuotes(approval.userAgreementQuotes, errors);
  validateNonGoalAgreementChecks(approval.nonGoals, quotes, errors);
}

function validateSource(root, source, errors) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    errors.push('sourceはobjectが必要です');
    return;
  }
  if (!['simple', 'spec-leader'].includes(source.type)) {
    errors.push('source.typeはsimpleまたはspec-leaderが必要です');
    return;
  }
  const sourceFields = source.type === 'simple'
    ? new Set(['type'])
    : new Set(['type', 'project', 'exportedAt', 'handoffDir', 'files']);
  for (const key of Object.keys(source)) {
    if (!sourceFields.has(key)) errors.push(`sourceの未知fieldは使用できません: ${key}`);
  }
  if (source.type === 'simple') return;
  if (!text(source.project)) errors.push('spec-leader source.projectが空です');
  if (!text(source.exportedAt) || !Number.isFinite(Date.parse(source.exportedAt))) {
    errors.push('spec-leader source.exportedAtが日時として不正です');
  }
  if (!Array.isArray(source.files) || source.files.length < 4) {
    errors.push('spec-leader source.filesは4成果物以上が必要です');
    return;
  }
  const requiredNames = new Set(['AGENTS.md', 'acceptance_checklist.md', 'spec_core.json', 'decisions_log.md']);
  const actualNames = new Set(source.files.map((file) => basename(text(file?.path))));
  for (const name of requiredNames) {
    if (!actualNames.has(name)) errors.push(`spec-leader source.filesに${name}がありません`);
  }
  if (new Set(source.files.map((file) => text(file?.path))).size !== source.files.length) {
    errors.push('spec-leader source.filesのpathが重複しています');
  }
  for (const [index, file] of source.files.entries()) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      errors.push(`source.files[${index}]はobjectが必要です`);
      continue;
    }
    for (const key of Object.keys(file)) {
      if (!['path', 'sha256'].includes(key)) errors.push(`source.files[${index}]の未知fieldは使用できません: ${key}`);
    }
    if (!text(file.path) || !/^[a-f0-9]{64}$/.test(text(file.sha256))) {
      errors.push(`source.files[${index}]はpathとsha256が必要です`);
      continue;
    }
    if (!root) continue;
    try {
      const resolved = resolveRepoPath(root, file.path, 'spec-leader成果物');
      if (!existsSync(resolved)) throw new Error(`実在しません: ${file.path}`);
      ensureRegularFile(resolved, 'spec-leader成果物');
      const actual = sha256(readFileSync(resolved));
      if (actual !== file.sha256) errors.push(`spec-leader成果物が承認後に変更されました: ${file.path}`);
    } catch (error) {
      errors.push(error.message);
    }
  }
}

// repo名解決はai-e2e-lib.mjsの一つに統一する（worktreeでもフォルダ名でなく元repo名を返す）。
export { actualRepoName };

function validateDeclarationBinding(root, task, approval, errors) {
  let path;
  try {
    path = declarationPathFor(root, task, task?.branch);
  } catch (error) {
    errors.push(error.message);
    return;
  }
  if (!existsSync(path)) {
    errors.push(`active作業宣言がありません: ${path}`);
    return;
  }
  try {
    ensureRegularFile(path, 'active作業宣言');
    const declaration = parseDeclaration(readFileSync(path, 'utf8'));
    for (const [field, expected] of Object.entries({
      task_id: approval.taskId,
      task_fingerprint: approval.taskFingerprint,
      repo: approval.repo,
      branch: approval.branch,
    })) {
      if (declaration[field] !== expected) errors.push(`active作業宣言の${field}が承認済み完成図と一致しません`);
    }
    if (!['running', 'waiting', 'blocked', 'needs_parent'].includes(declaration.status)) {
      errors.push(`active作業宣言のstatusが開始可能状態ではありません: ${declaration.status || '(missing)'}`);
    }
  } catch (error) {
    errors.push(error.message);
  }
}

export function validateApproval({
  root,
  task,
  approval,
  requireApproved = true,
  allowLegacyDraft = false,
  allowAgreementRepairDraft = false,
}) {
  const errors = [];
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
    return { errors: ['approval.jsonはobjectが必要です'], contentHash: '' };
  }
  for (const key of Object.keys(approval)) {
    if (!TOP_LEVEL_FIELDS.has(key)) errors.push(`未知fieldは使用できません: ${key}`);
  }
  if (approval.schemaVersion !== APPROVAL_SCHEMA_VERSION) {
    errors.push(`schemaVersionは${APPROVAL_SCHEMA_VERSION}必須です`);
  }
  try {
    safeId(approval.taskId);
  } catch (error) {
    errors.push(error.message);
  }
  if (!text(approval.taskFingerprint)) errors.push('taskFingerprintが空です');
  if (!text(approval.repo)) errors.push('repoが空です');
  if (!text(approval.branch)) errors.push('branchが空です');
  if (!Number.isInteger(approval.revision) || approval.revision < 1) errors.push('revisionは1以上の整数が必要です');
  if (!text(approval.vision)) errors.push('visionが空です');
  if (approval.deliverable_summary !== undefined && typeof approval.deliverable_summary !== 'string') {
    errors.push('deliverable_summaryは文字列が必要です');
  }
  if (requiresDeliverableSummary(task) && !text(approval.deliverable_summary)) {
    errors.push('比較・評価系タスクはdeliverable_summary（横並び定義・完成物の1行定義）が必要です');
  }
  stringArray(approval.completionCriteria, 'completionCriteria', errors, { required: true });
  stringArray(approval.nonGoals, 'nonGoals', errors, { required: true });
  validateAgreementGate(approval, errors, { allowLegacyDraft, allowAgreementRepairDraft });
  stringArray(approval.assumptions, 'assumptions', errors);
  stringArray(approval.openQuestions, 'openQuestions', errors);
  validateImplementationPlan(approval.implementationPlan, errors);
  if (!Array.isArray(approval.concerns)) {
    errors.push('concernsは配列が必要です');
  } else {
    approval.concerns.forEach((concern, index) => {
      if (!concern || typeof concern !== 'object' || Array.isArray(concern)) {
        errors.push(`concerns[${index}]はobjectが必要です`);
        return;
      }
      for (const key of Object.keys(concern)) {
        if (!['problem', 'userImpact', 'recommendation'].includes(key)) {
          errors.push(`concerns[${index}]の未知fieldは使用できません: ${key}`);
        }
      }
      for (const field of ['problem', 'userImpact', 'recommendation']) {
        if (!text(concern?.[field])) errors.push(`concerns[${index}].${field}が空です`);
      }
    });
  }
  validateSource(root, approval.source, errors);
  validateApprovalClassification(task, approval, errors);
  validateReviewEscalationDecisions(approval.reviewEscalationDecisions, errors);

  for (const [field, expected] of Object.entries({
    taskId: task?.taskId,
    taskFingerprint: task?.taskFingerprint,
    repo: task?.repo,
    branch: task?.branch,
  })) {
    if (!text(expected)) errors.push(`current-task.jsonの${field}が空です`);
    else if (approval[field] !== expected) errors.push(`${field}がcurrent-task.jsonと一致しません`);
  }
  if (root) {
    const actualBranch = gitValue(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!actualBranch) errors.push('実git branchを取得できません');
    else if (approval.branch !== actualBranch) errors.push('branchが実git branchと一致しません');
    try {
      const repo = actualRepoName(root);
      if (!repo) errors.push('実git repoを取得できません');
      else if (approval.repo !== repo) errors.push(`repoが実git repoと一致しません（承認=${approval.repo} / 実=${repo}）`);
    } catch (error) {
      errors.push(error.message);
    }
  }

  const contentHash = approvalContentHash(approval);
  if (approval.documentHash !== contentHash) errors.push('documentHashが現在の完成図内容と一致しません');
  if (requireApproved) {
    if (approval.status !== 'approved') errors.push('statusがapprovedではありません');
    if (approval.openQuestions?.length !== 0) errors.push('未解決事項が残っています');
    if (!approval.approval || typeof approval.approval !== 'object') {
      errors.push('ユーザー承認記録がありません');
    } else {
      for (const key of Object.keys(approval.approval)) {
        if (!['approvedBy', 'approvedAt', 'approvedContentHash', 'warnings', 'recordHash'].includes(key)) {
          errors.push(`approvalの未知fieldは使用できません: ${key}`);
        }
      }
      if (!text(approval.approval.approvedBy)) errors.push('approval.approvedByが空です');
      if (!text(approval.approval.approvedAt) || !Number.isFinite(Date.parse(approval.approval.approvedAt))) {
        errors.push('approval.approvedAtが日時として不正です');
      }
      if (approval.approval.approvedContentHash !== contentHash) {
        errors.push('承認後に完成図が変更されています（再承認が必要です）');
      }
      if (approval.approval.warnings !== undefined) {
        stringArray(approval.approval.warnings, 'approval.warnings', errors);
      }
      if (approval.approval.recordHash !== approvalRecordHash(approval.approval)) {
        errors.push('承認者または承認日時が承認後に変更されています');
      }
    }
    if (root) validateDeclarationBinding(root, task, approval, errors);
  }
  return {
    errors,
    contentHash,
    warnings: [...implementationPlanWarnings(approval), ...agreementCoverageWarnings(approval)],
  };
}

export function buildDraftApproval(task, input, { revision = 1, source, classification } = {}) {
  const document = {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    status: 'draft',
    taskId: text(task?.taskId),
    taskFingerprint: text(task?.taskFingerprint),
    repo: text(task?.repo),
    branch: text(task?.branch),
    revision,
    source: source || { type: 'simple' },
    vision: text(input?.vision),
    deliverable_summary: text(input?.deliverable_summary),
    userAgreementQuotes: Array.isArray(input?.userAgreementQuotes) ? input.userAgreementQuotes : [],
    completionCriteria: Array.isArray(input?.completionCriteria) ? input.completionCriteria : [],
    nonGoals: Array.isArray(input?.nonGoals) ? input.nonGoals : [],
    assumptions: Array.isArray(input?.assumptions) ? input.assumptions : [],
    openQuestions: Array.isArray(input?.openQuestions) ? input.openQuestions : [],
    concerns: Array.isArray(input?.concerns) ? input.concerns : [],
    approval: null,
  };
  if (input?.implementationPlan !== undefined) document.implementationPlan = input.implementationPlan;
  for (const field of ['surfaceKind', 'deploymentKind', 'productionDeployment', 'classificationCorrections', 'reviewEscalationDecisions']) {
    if (Object.hasOwn(classification || {}, field)) document[field] = classification[field];
  }
  document.documentHash = approvalContentHash(document);
  return document;
}

export function approveDocument(root, task, document, approvedBy, now = new Date().toISOString()) {
  if (document?.status !== 'draft') throw new Error('draft状態だけを承認できます');
  const check = validateApproval({ root, task, approval: document, requireApproved: false });
  if (check.errors.length) throw new Error(check.errors.join('\n'));
  if (document.openQuestions.length !== 0) throw new Error('未解決事項が残っているため承認できません');
  if (!text(approvedBy)) throw new Error('approvedByが空です');
  const record = {
    approvedBy: text(approvedBy),
    approvedAt: now,
    approvedContentHash: check.contentHash,
    warnings: check.warnings,
  };
  record.recordHash = approvalRecordHash(record);
  return {
    ...document,
    status: 'approved',
    documentHash: check.contentHash,
    approval: record,
  };
}

/**
 * taskIdが完了ゲート済みかを機械確認する。完了シグナルは次のいずれか:
 *   - ${AGENT_WORK_DIR:-~/projects/.agent-work}/completed/<taskId>.md が存在する
 *   - .ai/context/completion-verification-<taskId>.json が存在し applied:true
 * current-task.jsonへのマーカー書き込みは行わない(ai:complete --applyのworktree非改変を守るため)。
 */
export function taskCompletedSignal(root, taskId) {
  let id;
  try {
    id = safeId(taskId);
  } catch {
    return false;
  }
  try {
    // 適用証跡側と同じくregular file検査。不在・symlink等はこのシグナル不成立(fail-closed側)。
    ensureRegularFile(join(agentWorkDir(), 'completed', `${id}.md`), '完了履歴');
    return true;
  } catch {
    // 適用証跡側の確認へ進む。
  }
  if (!root) return false;
  const verificationPath = join(root, '.ai', 'context', `completion-verification-${id}.json`);
  if (!existsSync(verificationPath)) return false;
  try {
    ensureRegularFile(verificationPath, '完了適用証跡');
    return readJson(verificationPath).applied === true;
  } catch {
    return false;
  }
}

export function completedTaskError(taskId) {
  const next = aiCmd('approval', 'next-task --task "<内容>" --task-id <新ID> --fingerprint <新FP>');
  return `このタスク(${text(taskId)})は完了済みです。次タスクの開始は: ${next}`;
}

export function loadApproval(
  root,
  task,
  {
    requireApproved = true,
    rejectCompleted = false,
    allowLegacyDraft = false,
    allowAgreementRepairDraft = false,
  } = {},
) {
  const path = resolveRepoPath(root, join(root, APPROVAL_RELATIVE_PATH), '承認済み完成図');
  // 完了済み検出(opt-in): レーン起動ゲート(verify)だけが有効化する。approval.jsonの
  // 読込・検証より前に確認し、「approval.jsonがありません」等の別エラーに埋もれず
  // この1件だけを決定的に返す。
  if (rejectCompleted && taskCompletedSignal(root, task?.taskId)) {
    return { path, approval: null, errors: [completedTaskError(task?.taskId)], contentHash: '' };
  }
  if (!existsSync(path)) return { path, approval: null, errors: [`${APPROVAL_RELATIVE_PATH}がありません`] };
  try {
    ensureRegularFile(path, '承認済み完成図');
    const approval = readJson(path);
    const result = validateApproval({
      root,
      task,
      approval,
      requireApproved,
      allowLegacyDraft,
      allowAgreementRepairDraft,
    });
    return { path, approval, ...result };
  } catch (error) {
    return { path, approval: null, errors: [error.message], contentHash: '' };
  }
}

export function saveApproval(root, document, { expectedApproval } = {}) {
  const path = resolveRepoPath(root, join(root, APPROVAL_RELATIVE_PATH), '承認済み完成図');
  atomicWriteJson(path, document, {
    expectedValue: expectedApproval,
    label: 'approval.json',
  });
  return path;
}

function parentDecisionWorkDir(env = process.env) {
  if (
    env.NODE_ENV === 'test'
    && env.AGENT_WORK_DIR
    && env.AI_DEV_TOOL_ALLOW_AGENT_WORK_DIR === '1'
  ) {
    return agentWorkDir(env);
  }
  return join(homedir(), 'projects', '.agent-work');
}

function requireSafeParentDecisionDirectory(path, label) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label}はsymlinkではないdirectoryが必要です`);
  }
}

export function loadParentReviewEscalationDecision(task, state, escalation, env = process.env) {
  const repo = text(task?.repo);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(repo)) {
    throw new Error('親判断記録のrepo名が不正です');
  }
  const workDir = parentDecisionWorkDir(env);
  const handoffDir = join(workDir, '.parent-handoff');
  const decisionPath = join(handoffDir, `${repo}.decisions`);
  try {
    requireSafeParentDecisionDirectory(workDir, 'agent-work');
    requireSafeParentDecisionDirectory(handoffDir, 'parent-handoff');
    ensureRegularFile(decisionPath, '親判断記録');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`親レーンの判断記録がありません: ${decisionPath}`);
    }
    throw error;
  }
  const stat = lstatSync(decisionPath);
  if ((stat.mode & 0o077) !== 0) throw new Error('親判断記録は所有者だけが読める権限(0600)にしてください');
  if (stat.size > 1024 * 1024) throw new Error('親判断記録が読み取り上限を超えています');

  const expected = {
    kind: 'review_escalation',
    taskId: state.taskId,
    taskFingerprint: state.taskFingerprint,
    escalationId: escalation.escalationId,
    sizeClass: escalation.sizeClass,
    maxRounds: escalation.maxRounds,
    lastRequestId: escalation.lastRequestId,
    findingsDigest: escalation.findingsDigest,
    decision: 'proceed_with_findings',
  };
  const lines = readFileSync(decisionPath, 'utf8').split('\n').reverse();
  for (const line of lines) {
    const separator = line.indexOf('\t');
    if (separator < 1) continue;
    const decidedAt = line.slice(0, separator).trim();
    const body = line.slice(separator + 1).trim();
    if (!body.startsWith('{')) continue;
    let candidate;
    try {
      candidate = JSON.parse(body);
    } catch {
      continue;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    if (!Object.entries(expected).every(([key, value]) => candidate[key] === value)) continue;
    if (!text(candidate.decidedBy) || !text(candidate.reason)) {
      throw new Error('親判断記録にはdecidedByとreasonが必要です');
    }
    if ([candidate.decidedBy, candidate.reason].some((value) => /[\u0000-\u001f\u007f-\u009f]/u.test(String(value)))) {
      throw new Error('親判断記録のdecidedByとreasonは制御文字なしの1行が必要です');
    }
    if ([...text(candidate.reason)].length > 500) throw new Error('親判断記録のreasonは500文字以内が必要です');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(decidedAt) || !Number.isFinite(Date.parse(decidedAt))) {
      throw new Error('親判断記録の日時が不正です');
    }
    return { ...expected, decidedBy: text(candidate.decidedBy), reason: text(candidate.reason), decidedAt };
  }
  throw new Error(`現在のレビュー指摘と完全一致する親判断記録がありません: ${decisionPath}`);
}

export function applyReviewEscalationDecision(
  root,
  task,
  approval,
  { escalationId, decision },
) {
  if (approval?.status !== 'approved') throw new Error('親判断は承認済み完成図にだけ記録できます');
  if (text(decision) !== 'proceed_with_findings') {
    throw new Error('--decisionはproceed_with_findingsが必要です');
  }
  for (const [label, value] of [['--escalation-id', escalationId]]) {
    if (!text(value)) throw new Error(`${label}は空にできません`);
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(String(value))) {
      throw new Error(`${label}は制御文字なしの1行で指定してください`);
    }
  }
  const existing = validateApproval({ root, task, approval });
  if (existing.errors.length) throw new Error(existing.errors.join('\n'));
  const statePath = resolveRepoPath(root, '.ai/context/review-rounds.json', 'review-rounds.json');
  ensureRegularFile(statePath, 'review-rounds.json');
  const state = readJson(statePath);
  const escalation = state?.codeReview?.parentEscalation;
  if (
    state?.taskId !== task?.taskId
    || state?.taskFingerprint !== task?.taskFingerprint
    || !escalation
    || escalation.escalationId !== text(escalationId)
  ) {
    throw new Error('指定したescalationIdは現在タスクの未解決レビュー判断と一致しません');
  }
  if (
    !(
      (['small', 'large'].includes(escalation.sizeClass) && escalation.maxRounds === 3)
      || (escalation.sizeClass === 'large' && escalation.maxRounds === 10)
    )
    || state.codeReview.outcome !== 'passed_max_rounds'
  ) {
    throw new Error('親判断を記録できるレビュー上限到達状態ではありません');
  }
  const parentDecision = loadParentReviewEscalationDecision(task, state, escalation);
  const decisions = Array.isArray(approval.reviewEscalationDecisions)
    ? approval.reviewEscalationDecisions : [];
  if (decisions.some((entry) =>
    entry.escalationId === escalation.escalationId && entry.decision === text(decision))) {
    throw new Error('このescalationIdには同じ親判断が既に記録されています');
  }
  const record = {
    taskId: state.taskId,
    taskFingerprint: state.taskFingerprint,
    escalationId: escalation.escalationId,
    sizeClass: escalation.sizeClass,
    maxRounds: escalation.maxRounds,
    lastRequestId: escalation.lastRequestId,
    findingsDigest: escalation.findingsDigest,
    decision: parentDecision.decision,
    decidedBy: parentDecision.decidedBy,
    decidedAt: parentDecision.decidedAt,
    reason: parentDecision.reason,
  };
  const nextApproval = {
    ...approval,
    revision: approval.revision + 1,
    reviewEscalationDecisions: [...decisions, record],
  };
  nextApproval.documentHash = approvalContentHash(nextApproval);
  nextApproval.approval = {
    ...approval.approval,
    approvedContentHash: nextApproval.documentHash,
  };
  nextApproval.approval.recordHash = approvalRecordHash(nextApproval.approval);
  const checked = validateApproval({ root, task, approval: nextApproval });
  if (checked.errors.length) throw new Error(checked.errors.join('\n'));
  saveApproval(root, nextApproval, { expectedApproval: approval });
  return { approval: nextApproval, decision: record };
}

/** current-task.jsonの現物を.ai/backups/current-task/へatomic(0600)でコピーし、バックアップパスを返す。 */
export function archiveCurrentTask(root, task) {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const taskId = text(task?.taskId) || 'no-task-id';
  const backupPath = join(root, '.ai', 'backups', 'current-task', `${stamp}-${taskId}.json`);
  atomicWriteJson(backupPath, task);
  return backupPath;
}

function runGitBuffer(root, args, label) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || Buffer.from(result.stderr || '').toString('utf8').trim() || `status=${result.status}`;
    throw new Error(`実装差分を確認できません（${label}: ${detail}）`);
  }
  return Buffer.from(result.stdout || '');
}

function nulPaths(buffer) {
  return buffer.toString('utf8').split('\0').map((item) => item.trim()).filter(Boolean);
}

export function implementationChangedPaths(root, approval) {
  const approvedAt = text(approval?.approval?.approvedAt);
  if (!approvedAt || !Number.isFinite(Date.parse(approvedAt))) {
    throw new Error('承認日時が不正なため実装差分の基準を決められません');
  }
  // Gitのcommit時刻は秒精度。承認と同じ秒に作られたcommitを「承認前」と誤認して
  // 差分から落とさないよう、検索上限は承認時刻より1秒前へ倒す（見つからなければfail-closed）。
  const strictBefore = new Date(Date.parse(approvedAt) - 1000).toISOString();
  const baseline = runGitBuffer(
    root,
    ['rev-list', '-1', `--before=${strictBefore}`, 'HEAD'],
    '承認時点の基準commit',
  ).toString('utf8').trim();
  if (!/^[a-f0-9]{40,64}$/iu.test(baseline)) {
    throw new Error(
      '承認時点より前のcommitを特定できないため実装差分を確認できません。'
      + 'surfaceKindはweb_uiのままにしてブラウザ確認を続けてください',
    );
  }
  const tracked = nulPaths(runGitBuffer(root, ['diff', '--name-only', '-z', baseline, '--'], '追跡中ファイル'));
  const untracked = nulPaths(runGitBuffer(root, ['ls-files', '--others', '--exclude-standard', '-z'], '未追跡ファイル'));
  return [...new Set([...tracked, ...untracked])].sort();
}

export function isUiImplementationPath(path) {
  const normalized = String(path || '').replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
  if (!normalized) return false;
  if (UI_PATH_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
    return true;
  }
  const dot = normalized.lastIndexOf('.');
  return dot >= 0 && UI_FILE_EXTENSIONS.has(normalized.slice(dot));
}

function correctedTaskClassification(root, task, approval, { surfaceKind, deploymentKind }) {
  const previousSurfaceKind = text(task?.surfaceKind);
  if (!SURFACE_KINDS.has(previousSurfaceKind)) {
    throw new Error('current-task.jsonのsurfaceKindが未設定または不正なため訂正元を確認できません');
  }
  const hasSurfaceKind = surfaceKind !== undefined;
  const requestedSurfaceKind = hasSurfaceKind ? text(surfaceKind) : previousSurfaceKind;
  if (!SURFACE_KINDS.has(requestedSurfaceKind)) {
    throw new Error('--surface-kindはweb_ui|non_webを指定してください');
  }
  const hasDeploymentKind = deploymentKind !== undefined;
  const requestedDeploymentKind = hasDeploymentKind ? text(deploymentKind) : '';
  if (hasDeploymentKind && !DEPLOYMENT_KINDS.has(requestedDeploymentKind)) {
    throw new Error('--deployment-kindはproduction|non_productionを指定してください');
  }

  const next = { ...task, surfaceKind: requestedSurfaceKind };
  if (requestedSurfaceKind === 'non_web') {
    if (hasDeploymentKind) throw new Error('non_webには--deployment-kindを指定できません');
    delete next.deploymentKind;
    delete next.productionDeployment;
  } else {
    const resolvedDeploymentKind = hasDeploymentKind
      ? requestedDeploymentKind
      : previousSurfaceKind === 'web_ui' ? text(task?.deploymentKind) : '';
    if (!DEPLOYMENT_KINDS.has(resolvedDeploymentKind)) {
      throw new Error('web_uiへの訂正には--deployment-kind production|non_productionを指定してください');
    }
    next.deploymentKind = resolvedDeploymentKind;
    next.productionDeployment = resolvedDeploymentKind === 'production';
  }

  const weakensProductionGate = previousSurfaceKind === 'web_ui'
    && text(task?.deploymentKind) === 'production'
    && (requestedSurfaceKind === 'non_web'
      || (requestedSurfaceKind === 'web_ui' && next.deploymentKind === 'non_production'));
  if (weakensProductionGate) {
    throw new Error(
      '本番反映の安全確認を弱める訂正はこの経路では実行できません。'
      + 'reopenして利用者の再確認後に完成図を更新・再承認してください',
    );
  }

  if (previousSurfaceKind === 'web_ui' && requestedSurfaceKind === 'non_web') {
    const changedPaths = implementationChangedPaths(root, approval);
    const uiPaths = changedPaths.filter(isUiImplementationPath);
    if (uiPaths.length > 0) {
      throw new Error(`UIファイルの実装差分があるためweb_uiからnon_webへ訂正できません: ${uiPaths.join(', ')}`);
    }
  }

  for (const field of PROTECTED_TASK_FIELDS) {
    if (JSON.stringify(next[field]) !== JSON.stringify(task[field])) {
      throw new Error(`保護field ${field} を変更しようとしました。profile/team/identityの変更はai-dev-toolのv2移行経路を使ってください`);
    }
  }
  if (JSON.stringify(classificationSnapshot(next)) === JSON.stringify(classificationSnapshot(task))) {
    throw new Error('指定されたsurfaceKind/deploymentKindは現在値と同じです');
  }
  return next;
}

export function atomicWriteText(filePath, content, label, { expectedContent } = {}) {
  ensureRegularFile(filePath, label);
  const directory = dirname(filePath);
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`${label}の親はsymlinkではない実ディレクトリが必要です: ${directory}`);
  }
  const originalMode = lstatSync(filePath).mode & 0o777;
  const temp = join(directory, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  let tempCreated = false;
  try {
    fd = openSync(temp, 'wx', originalMode);
    tempCreated = true;
    if (!fstatSync(fd).isFile()) throw new Error(`${label}の一時出力がregular fileではありません`);
    fchmodSync(fd, originalMode);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (expectedContent !== undefined && readFileSync(filePath, 'utf8') !== expectedContent) {
      throw new Error(`${label}が同時に更新されたため、訂正をやり直してください`);
    }
    renameSync(temp, filePath);
    tempCreated = false;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (tempCreated) {
      try {
        unlinkSync(temp);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

function replaceDeclarationField(content, field, value) {
  const pattern = new RegExp(`^${field}:.*$`, 'gmu');
  const matches = String(content).match(pattern) || [];
  if (matches.length > 1) throw new Error(`active作業宣言の${field}が重複しています`);
  if (matches.length === 1) return String(content).replace(pattern, `${field}: ${value}`);
  return `${String(content).replace(/\s*$/u, '')}\n${field}: ${value}\n`;
}

function removeDeclarationField(content, field) {
  const pattern = new RegExp(`^${field}:.*(?:\n|$)`, 'gmu');
  const matches = String(content).match(pattern) || [];
  if (matches.length > 1) throw new Error(`active作業宣言の${field}が重複しています`);
  return String(content).replace(pattern, '');
}

function prepareDeclarationCorrection(root, task, nextTask, now) {
  const path = declarationPathFor(root, task, task?.branch);
  ensureRegularFile(path, 'active作業宣言');
  const original = readFileSync(path, 'utf8');
  const declaration = parseDeclaration(original);
  for (const [field, expected] of Object.entries({
    task_id: task.taskId,
    task_fingerprint: task.taskFingerprint,
    repo: task.repo,
    branch: task.branch,
  })) {
    if (declaration[field] !== expected) {
      throw new Error(`active作業宣言の${field}が訂正対象タスクと一致しません`);
    }
  }
  if (!['running', 'waiting', 'blocked', 'needs_parent'].includes(declaration.status)) {
    throw new Error(`active作業宣言のstatusが訂正可能状態ではありません: ${declaration.status || '(missing)'}`);
  }
  let next = replaceDeclarationField(original, 'surface_kind', nextTask.surfaceKind);
  next = nextTask.surfaceKind === 'web_ui'
    ? replaceDeclarationField(next, 'e2e_kind', 'browser')
    : removeDeclarationField(next, 'e2e_kind');
  next = replaceDeclarationField(next, 'e2e_status', 'pending');
  next = replaceDeclarationField(next, 'updated_at', now);
  return { path, original, next };
}

function assertDeclarationUnchanged(change) {
  if (!change) return;
  if (readFileSync(change.path, 'utf8') !== change.original) {
    throw new Error('active作業宣言が同時に更新されたため、訂正をやり直してください');
  }
}

function prepareReviewStateCorrection(root, task, nextTask, now) {
  const path = join(root, '.ai', 'context', 'review-rounds.json');
  if (!existsSync(path)) return { change: null, warning: '' };
  ensureRegularFile(path, 'review-rounds.json');
  const original = readJson(path);
  if (original?.taskId !== task.taskId || original?.taskFingerprint !== task.taskFingerprint) {
    return {
      change: null,
      warning: 'review-rounds.jsonは別タスクの記録だったため変更していません',
    };
  }
  if (!original.codeReview || !Array.isArray(original.codeReview.rounds)) {
    throw new Error('review-rounds.jsonのcodeReviewが不正なため種別訂正できません');
  }
  const next = JSON.parse(JSON.stringify(original));
  next.classificationHistory = [
    ...(Array.isArray(original.classificationHistory) ? original.classificationHistory : []),
    {
      changedAt: now,
      fromSurfaceKind: task.surfaceKind,
      toSurfaceKind: nextTask.surfaceKind,
      visualQc: original.visualQc ?? null,
      browserReview: original.browserReview ?? null,
    },
  ];
  if (nextTask.surfaceKind === 'web_ui') {
    next.visualQc = {
      maxAttempts: Number.isInteger(original.visualQc?.maxAttempts) ? original.visualQc.maxAttempts : 2,
      maxPreliminaryChecks: Number.isInteger(original.visualQc?.maxPreliminaryChecks)
        ? original.visualQc.maxPreliminaryChecks : 10,
      attempts: [],
      preliminaryChecks: [],
      outcome: 'not_started',
      closedReason: null,
    };
    next.browserReview = {
      maxRounds: Number.isInteger(original.browserReview?.maxRounds) ? original.browserReview.maxRounds : 3,
      preflight: 'not_run',
      rounds: [],
      outcome: 'not_started',
      closedReason: null,
    };
  } else {
    next.visualQc = {
      maxAttempts: Number.isInteger(original.visualQc?.maxAttempts) ? original.visualQc.maxAttempts : 2,
      maxPreliminaryChecks: Number.isInteger(original.visualQc?.maxPreliminaryChecks)
        ? original.visualQc.maxPreliminaryChecks : 10,
      attempts: [],
      preliminaryChecks: [],
      outcome: 'not_applicable',
      closedReason: 'surfaceKind!=web_ui（種別訂正）',
    };
    next.browserReview = {
      maxRounds: Number.isInteger(original.browserReview?.maxRounds) ? original.browserReview.maxRounds : 3,
      preflight: 'not_applicable',
      rounds: [],
      outcome: 'not_applicable',
      closedReason: 'surfaceKind!=web_ui（種別訂正）',
    };
  }
  return { change: { path, original, next }, warning: '' };
}

export function applyTaskClassificationCorrection(
  root,
  task,
  approval,
  { surfaceKind, deploymentKind, reason, now = new Date().toISOString() },
) {
  if (approval?.status !== 'approved') throw new Error('開始後の種別訂正は承認済み完成図だけに実行できます');
  if (!text(reason)) throw new Error('--reasonは空にできません');
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(String(reason))) {
    throw new Error('--reasonは制御文字なしの1行で指定してください');
  }
  if ([...text(reason)].length > 500) throw new Error('--reasonは500文字以内で指定してください');
  if (text(reason).startsWith('--')) throw new Error('--reasonには理由の文章を指定してください（option名は使えません）');
  const existing = validateApproval({ root, task, approval });
  if (existing.errors.length) throw new Error(existing.errors.join('\n'));
  const nextTask = correctedTaskClassification(root, task, approval, { surfaceKind, deploymentKind });
  const correction = {
    changedAt: now,
    reason: text(reason),
    from: classificationSnapshot(task),
    to: classificationSnapshot(nextTask),
  };
  const nextApproval = {
    ...approval,
    revision: approval.revision + 1,
    surfaceKind: nextTask.surfaceKind,
    classificationCorrections: [...(Array.isArray(approval.classificationCorrections)
      ? approval.classificationCorrections : []), correction],
  };
  if (nextTask.surfaceKind === 'web_ui') {
    nextApproval.deploymentKind = nextTask.deploymentKind;
    nextApproval.productionDeployment = nextTask.productionDeployment;
  } else {
    delete nextApproval.deploymentKind;
    delete nextApproval.productionDeployment;
  }
  nextApproval.documentHash = approvalContentHash(nextApproval);
  nextApproval.approval = {
    ...approval.approval,
    approvedContentHash: nextApproval.documentHash,
  };
  nextApproval.approval.recordHash = approvalRecordHash(nextApproval.approval);
  const checked = validateApproval({ root, task: nextTask, approval: nextApproval });
  if (checked.errors.length) throw new Error(checked.errors.join('\n'));

  const surfaceChanged = text(task.surfaceKind) !== nextTask.surfaceKind;
  const declarationChange = surfaceChanged ? prepareDeclarationCorrection(root, task, nextTask, now) : null;
  const reviewState = surfaceChanged
    ? prepareReviewStateCorrection(root, task, nextTask, now)
    : { change: null, warning: '' };
  const reviewStateChange = reviewState.change;
  const warnings = reviewState.warning ? [reviewState.warning] : [];
  if (nextApproval.classificationCorrections.length > 10) {
    warnings.push('種別訂正が10回を超えています。理由の重複や誤操作がないか確認してください');
  }
  const taskPath = join(root, '.ai', 'current-task.json');
  const written = { task: false, approval: false, declaration: false, reviewState: false };
  // 全ファイルの検査を終えた後、最初の書き込み直前にも宣言の同時更新を確認する。
  // atomicWriteText側でもrename直前に再確認し、この2点の間の競合も上書きしない。
  assertDeclarationUnchanged(declarationChange);
  try {
    atomicWriteJson(taskPath, nextTask, { expectedValue: task, label: 'current-task.json' });
    written.task = true;
    saveApproval(root, nextApproval, { expectedApproval: approval });
    written.approval = true;
    if (declarationChange) {
      atomicWriteText(declarationChange.path, declarationChange.next, 'active作業宣言', {
        expectedContent: declarationChange.original,
      });
      written.declaration = true;
    }
    if (reviewStateChange) {
      atomicWriteJson(reviewStateChange.path, reviewStateChange.next, {
        expectedValue: reviewStateChange.original,
        label: 'review-rounds.json',
      });
      written.reviewState = true;
    }
  } catch (error) {
    const restored = [];
    const restoreErrors = [];
    const restore = (label, enabled, action) => {
      if (!enabled) return;
      try {
        action();
        restored.push(label);
      } catch (rollbackError) {
        restoreErrors.push(`${label}: ${rollbackError.message}`);
      }
    };
    restore('current-task.json', written.task, () => atomicWriteJson(taskPath, task, {
      expectedValue: nextTask,
      label: 'current-task.json',
    }));
    restore('approval.json', written.approval, () => saveApproval(root, approval, {
      expectedApproval: nextApproval,
    }));
    restore('active作業宣言', written.declaration, () => atomicWriteText(
      declarationChange.path,
      declarationChange.original,
      'active作業宣言',
      { expectedContent: declarationChange.next },
    ));
    restore('review-rounds.json', written.reviewState, () => atomicWriteJson(
      reviewStateChange.path,
      reviewStateChange.original,
      { expectedValue: reviewStateChange.next, label: 'review-rounds.json' },
    ));
    if (restoreErrors.length > 0) {
      throw new Error([
        `種別訂正の保存に失敗しました: ${error.message}`,
        `復元できた対象: ${restored.join(', ') || 'なし'}`,
        `復元できなかった対象: ${restoreErrors.join('; ')}`,
      ].join('\n'));
    }
    throw error;
  }
  return { task: nextTask, approval: nextApproval, correction, warnings };
}

/**
 * current-task.jsonを新task用に付け替える。ai-docs-task.mjsのrepointTaskと同じ安全機構:
 * 入力検証・保護field不変検査・atomicWriteJson。surface/deployment設定の不変条件も維持する。
 */
export function repointCurrentTask(
  root,
  previous,
  { task, taskId, taskFingerprint, branch, surfaceKind, deploymentKind },
) {
  safeId(taskId);
  if (!text(taskFingerprint) || /[\r\n]/.test(taskFingerprint)) throw new Error('taskFingerprintが空または不正です');
  if (!text(task)) throw new Error('taskが空です');
  if (!text(branch) || branch.includes('\n')) throw new Error('branchが不正です');

  const hasSurfaceKind = surfaceKind !== undefined;
  const requestedSurfaceKind = hasSurfaceKind ? text(surfaceKind) : '';
  if (hasSurfaceKind && !['web_ui', 'non_web'].includes(requestedSurfaceKind)) {
    throw new Error('--surface-kindはweb_ui|non_webを指定してください');
  }
  const resolvedSurfaceKind = hasSurfaceKind ? requestedSurfaceKind : text(previous?.surfaceKind);
  if (!['web_ui', 'non_web'].includes(resolvedSurfaceKind)) {
    throw new Error('surfaceKindが未設定または不正です。--surface-kind web_ui|non_webを指定してください');
  }

  const hasDeploymentKind = deploymentKind !== undefined;
  const requestedDeploymentKind = hasDeploymentKind ? text(deploymentKind) : '';
  if (hasDeploymentKind && !['production', 'non_production'].includes(requestedDeploymentKind)) {
    throw new Error('--deployment-kindはproduction|non_productionを指定してください');
  }

  const next = { ...previous };
  next.task = task;
  next.taskId = taskId;
  next.taskFingerprint = taskFingerprint;
  next.branch = branch;
  next.surfaceKind = resolvedSurfaceKind;

  if (resolvedSurfaceKind === 'non_web') {
    if (hasDeploymentKind) {
      throw new Error('non_webには--deployment-kindを指定できません');
    }
    delete next.deploymentKind;
    delete next.productionDeployment;
  } else if (hasDeploymentKind) {
    next.deploymentKind = requestedDeploymentKind;
    next.productionDeployment = requestedDeploymentKind === 'production';
  } else {
    const previousDeploymentKind = text(previous?.deploymentKind);
    const expectedProduction = previousDeploymentKind === 'production';
    // surfaceKindはresolved側と同じくtext()で正規化して比較する。ここだけ生値で比較すると
    // 末尾空白付きのweb_uiが「整合しているのに引き継げない」状態になり、1回目と2回目で挙動が変わる。
    const carryable = text(previous?.surfaceKind) === 'web_ui'
      && ['production', 'non_production'].includes(previousDeploymentKind);
    // 矛盾は欠落と区別して名乗らせる。同じ文言に畳むと、壊れた状態を運用者が
    // 案内どおり上書きして直したときに、壊れていた事実が一度も表面化しない。
    if (
      carryable
      && previous.productionDeployment !== undefined
      && (
        typeof previous.productionDeployment !== 'boolean'
        || previous.productionDeployment !== expectedProduction
      )
    ) {
      throw new Error(
        'current-task.jsonのproductionDeploymentとdeploymentKindが矛盾しています。'
        + '--deployment-kind production|non_productionで明示し直してください',
      );
    }
    if (!carryable) {
      throw new Error('web_uiには--deployment-kind production|non_productionを指定してください');
    }
    next.deploymentKind = previousDeploymentKind;
    next.productionDeployment = expectedProduction;
  }

  // 手編集境界: 保護fieldが1つでも変わっていたら書き込まない。
  for (const field of PROTECTED_TASK_FIELDS) {
    if (JSON.stringify(next[field]) !== JSON.stringify(previous[field])) {
      throw new Error(`保護field ${field} を変更しようとしました。profile/team/identityの変更はai-dev-toolのv2移行経路を使ってください`);
    }
  }
  const taskPath = join(root, '.ai', 'current-task.json');
  atomicWriteJson(taskPath, next);
  return next;
}

// deepseek-native-cli-v1 only: the exact literal worktree-relative files this task may write,
// registered atomically with the implementer-session binding. review-scope-v1 consumes this as a
// trusted task input (never as a reviewed claim), so a glob, directory, traversal or .ai path is
// rejected here rather than silently widening the change set. A registered path may be absent at
// binding time; an empty list and a case-insensitive duplicate are rejected.
const REVIEW_OUTPUT_GLOB_RE = /[*?[\]{}!]/;
export function normalizeReviewOutputPaths(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('REVIEW_OUTPUT_PATH_MISSING: --review-output-path must list at least one file');
  const seen = new Set();
  const paths = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) throw new Error('REVIEW_OUTPUT_PATH_INVALID: an empty --review-output-path is not allowed');
    const rel = item.trim().replaceAll('\\', '/');
    if (rel.includes('\u0000') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new Error(`REVIEW_OUTPUT_PATH_INVALID: not worktree-relative: ${rel}`);
    const parts = rel.split('/');
    if (parts.includes('..') || parts.includes('') || parts.includes('.')) throw new Error(`REVIEW_OUTPUT_PATH_INVALID: traversal, empty segment or directory: ${rel}`);
    if (rel === '.ai' || rel.startsWith('.ai/')) throw new Error(`REVIEW_OUTPUT_PATH_INVALID: .ai is existing userdata, not reviewed output: ${rel}`);
    if (REVIEW_OUTPUT_GLOB_RE.test(rel)) throw new Error(`REVIEW_OUTPUT_PATH_INVALID: a literal file path is required, not a glob: ${rel}`);
    const key = rel.toLowerCase();
    if (seen.has(key)) throw new Error(`REVIEW_OUTPUT_PATH_DUPLICATE: ${rel}`);
    seen.add(key);
    paths.push(rel);
  }
  return paths.sort();
}

// 2026-09-28: web_uiネイティブ連鎖(deepseek-native-cli-v1)の実装主体を「実在するCodex
// ネイティブセッションの集合」としてだけ束縛する。承認済みapproval.jsonは書き換えず、
// current-task.jsonだけをatomicに更新する。旧タスクの自動移行はしない。
// セッション証拠の検証は信頼境界が別なので review-evidence.mjs を遅延importする
// (承認ゲートの起動に証拠モジュールの読込を強制しないため)。
export async function bindReviewChainBinding(root, task, options = {}) {
  const sessionFiles = Array.isArray(options.sessionFiles) ? options.sessionFiles.filter((item) => typeof item === 'string' && item) : [];
  const taskId = text(options.taskId);
  const fingerprint = text(options.fingerprint);
  const expectTaskSha256 = text(options.expectTaskSha256);
  const expectApprovalSha256 = text(options.expectApprovalSha256);
  const aliasSession = text(options.aliasSession);
  const reviewOutputPaths = normalizeReviewOutputPaths(options.reviewOutputPaths);
  if (!taskId || !fingerprint) throw new Error('--task-id と --fingerprint が必要です');
  if (!/^[a-f0-9]{64}$/u.test(expectTaskSha256) || !/^[a-f0-9]{64}$/u.test(expectApprovalSha256)) {
    throw new Error('--expect-task-sha256 と --expect-approval-sha256 には64桁のSHA256が必要です');
  }
  if (sessionFiles.length === 0) throw new Error('--session-file を1件以上指定してください');
  if (!aliasSession) throw new Error('--alias-session が必要です');

  // 事前条件: 対象は現行タスクそのものだけ。別タスクや別レーンへは束縛しない。
  if (text(task?.taskId) !== taskId) throw new Error(`current-task.jsonのtaskIdが一致しません: ${text(task?.taskId) || '(missing)'}`);
  if (text(task?.taskFingerprint) !== fingerprint) throw new Error('current-task.jsonのtaskFingerprintが一致しません');
  if (text(task?.surfaceKind) !== 'web_ui') throw new Error('web_ui以外のタスクへネイティブ連鎖は束縛できません');
  if (text(options.model) !== 'deepseek-flash' || text(options.effort) !== 'high') throw new Error('--model deepseek-flash と --effort high だけを束縛できます');
  if (text(options.reviewChainVersion) !== 'deepseek-native-cli-v1') throw new Error('--review-chain-version deepseek-native-cli-v1 が必須です');
  // 旧タスク/既存束縛の自動移行はしない。二重束縛は人へ戻す。
  if (task?.implementerSessions !== undefined || task?.implementerSessionId !== undefined) {
    throw new Error('このタスクには既に実装セッション束縛があります。自動での再束縛・移行はしません');
  }

  const taskPath = join(root, '.ai', 'current-task.json');
  const approvalPath = join(root, '.ai', 'approval.json');
  const taskBytes = readFileSync(taskPath);
  if (sha256(taskBytes) !== expectTaskSha256) throw new Error('current-task.jsonの実物SHA256が事前条件と一致しません');
  ensureRegularFile(approvalPath, 'approval.json');
  const approvalBytes = readFileSync(approvalPath);
  if (sha256(approvalBytes) !== expectApprovalSha256) throw new Error('approval.jsonの実物SHA256が事前条件と一致しません');
  const approval = readJson(approvalPath);
  if (
    text(approval?.taskId) !== taskId
    || text(approval?.taskFingerprint) !== fingerprint
    || approval?.status !== 'approved'
    || !Number.isInteger(approval?.revision)
  ) {
    throw new Error('approval.jsonが現行タスクの承認済み完成図と一致しません');
  }
  const loaded = loadApproval(root, task);
  if (loaded.errors.length) throw new Error(loaded.errors.join('\n'));

  // レビュー開始後は束縛しない(往復の主体が確定している必要がある)。
  const reviewStatePath = join(root, '.ai', 'context', 'review-rounds.json');
  if (existsSync(reviewStatePath)) {
    ensureRegularFile(reviewStatePath, 'review-rounds.json');
    const reviewState = readJson(reviewStatePath);
    const started = (Array.isArray(reviewState?.codeReview?.rounds) ? reviewState.codeReview.rounds.length : 0)
      + (Array.isArray(reviewState?.browserReview?.rounds) ? reviewState.browserReview.rounds.length : 0)
      + (Array.isArray(reviewState?.visualQc?.attempts) ? reviewState.visualQc.attempts.length : 0);
    if (started > 0) throw new Error('レビューが既に開始されています。実装セッション束縛はレビュー開始前にだけ行えます');
  }

  const evidence = await import('./review-evidence.mjs');
  const trustedRoot = options.trustedRoot !== undefined ? options.trustedRoot : evidence.trustedCodexSessionRoot(homedir());
  const sessionRoot = evidence.resolveTrustedSessionRoot(trustedRoot, options.requestedSessionRoot);

  const sessions = [];
  const ids = [];
  for (const file of sessionFiles) {
    const verified = evidence.verifyImplementerSessionFile(file, {
      sessionRoot,
      expectedCwd: root,
      allowedSandboxes: evidence.NATIVE_IMPLEMENTER_SANDBOXES,
    });
    if (ids.some((id) => id.toLowerCase() === verified.id.toLowerCase())) {
      throw new Error(`同じ実装セッションを重複して指定できません: ${verified.id}`);
    }
    ids.push(verified.id);
    sessions.push(verified);
  }
  if (!ids.some((id) => id.toLowerCase() === aliasSession.toLowerCase())) {
    throw new Error('--alias-session は --session-file で検証した実装セッションから選んでください');
  }
  sessions.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const record = { schemaVersion: evidence.IMPLEMENTER_SESSIONS_SCHEMA, alias: aliasSession, sessions };
  record.hash = evidence.implementerSessionsFingerprint(record);

  const next = { ...task };
  const implementer = task?.implementer && typeof task.implementer === 'object' && !Array.isArray(task.implementer) ? task.implementer : {};
  next.implementer = { ...implementer, model: 'deepseek-flash', effort: 'high' };
  next.implementerSessionId = aliasSession;
  next.reviewChainVersion = 'deepseek-native-cli-v1';
  next.implementerSessions = record;
  next.reviewOutputPaths = reviewOutputPaths;

  atomicWriteJson(taskPath, next, { expectedValue: task, label: 'current-task.json' });
  if (sha256(readFileSync(approvalPath)) !== expectApprovalSha256) {
    try {
      atomicWriteJson(taskPath, task, { expectedValue: next, label: 'current-task.json' });
    } catch {
      // 復元できなくても事実は下のerrorで伝える。
    }
    throw new Error('approval.jsonが同時に更新されたため束縛を取り消しました。approval.jsonを確認してやり直してください');
  }
  return { alias: aliasSession, sessionIds: ids, sessionsHash: record.hash, reviewOutputPaths };
}

// 2026-09-28: after an accepted functional finding, append ONE new separately verified
// DeepSeek-high native implementer session instead of resuming a bound session (whose bytes
// would then fail revalidation). Additive and fail-closed: it reuses the same trusted-root,
// alias, model and completion checks as the initial binding, keeps every previous session
// byte-for-byte, and rewrites only current-task.json.
export const APPEND_IMPLEMENTER_PENDING_REQUEST_STATUSES = ['prepared', 'send-attempted', 'sent'];
const APPEND_IMPLEMENTER_OPEN_QUEUE_STATES = ['pending', 'leased', 'running', 'result_staged', 'published'];
const appendImplementerIdKey = value => String(value || '').trim().toLowerCase();

// A rework append is only allowed when the review state itself shows an outstanding functional
// finding (an in-progress round after a functional-defect round, or a pending focused recheck).
// An accepted clean round, a closed review, an empty/foreign state and a focused recheck that
// already passed all return ok:false, so a clean pipeline can never grow a new implementer.
export function reviewReworkRequired(state, task) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { ok: false, reason: 'REVIEW_STATE_INVALID' };
  if (state.taskId !== task?.taskId || state.taskFingerprint !== task?.taskFingerprint) return { ok: false, reason: 'REVIEW_STATE_TASK_MISMATCH' };
  const codeReview = state.codeReview;
  if (!codeReview || typeof codeReview !== 'object' || Array.isArray(codeReview)) return { ok: false, reason: 'REVIEW_STATE_CODEREVIEW_MISSING' };
  const rounds = Array.isArray(codeReview.rounds) ? codeReview.rounds : [];
  if (rounds.length === 0) return { ok: false, reason: 'REVIEW_STATE_NO_ROUNDS' };
  const last = rounds[rounds.length - 1];
  // 2026-09-28 (native dual-review acceptance): native連鎖では最終往復のOpus返信がokでも、前の往復で
  // 受理済みのDeepSeek P0/P1(nativeDualReview.blockingFindings)が未解決のまま残り得る。記録済みの
  // dual所見を権威にし、legacy/direct-APIは従来どおり最終往復の判定を使う(nativeDualReviewはnative
  // 往復でしか書かれないため、この項は非nativeでは常に0)。
  const nativeDualBlocking = Array.isArray(codeReview.nativeDualReview?.blockingFindings)
    ? codeReview.nativeDualReview.blockingFindings.length
    : 0;
  const hasOutstandingFinding = (last?.verdict === 'findings' && last?.hasFunctionalDefects === true)
    || nativeDualBlocking > 0;
  if (codeReview.focusedRecheck?.status === 'pending') {
    if (codeReview.outcome !== 'focused_recheck_required') return { ok: false, reason: 'REVIEW_STATE_FOCUSED_OUTCOME' };
    if (!hasOutstandingFinding) return { ok: false, reason: 'REVIEW_STATE_FOCUSED_CLEAN' };
    return { ok: true, round: last.round, requestId: text(last.requestId), mode: 'focused_recheck' };
  }
  if (codeReview.outcome !== 'in_progress') return { ok: false, reason: 'REVIEW_STATE_NOT_IN_PROGRESS' };
  if (!hasOutstandingFinding) return { ok: false, reason: 'REVIEW_STATE_LAST_ROUND_CLEAN' };
  return { ok: true, round: last.round, requestId: text(last.requestId), mode: 'next_round' };
}

// The accepted reviewer sessions are recovered from the persisted native receipts, because the
// review state only stores an unsalted sessionIdHash. Every recovered fact is re-checked against
// the real receipt bytes; anything missing or unreadable fails closed instead of assuming a
// distinctness we cannot prove.
function acceptedReviewerSessionIds(reviewState) {
  const codeReview = reviewState?.codeReview;
  const records = [
    ...(Array.isArray(codeReview?.rounds) ? codeReview.rounds : []),
    ...(codeReview?.focusedRecheck?.status === 'accepted' && codeReview.focusedRecheck.result ? [codeReview.focusedRecheck.result] : []),
    ...(Array.isArray(codeReview?.focusedRechecks)
      ? codeReview.focusedRechecks
        .filter((entry) => entry?.status === 'accepted' && entry.result)
        .map((entry) => entry.result)
      : []),
  ];
  const ids = [];
  for (const record of records) {
    const primary = record?.primaryReview;
    const round = String(record?.round ?? '');
    if (primary?.status !== 'completed') throw new Error('ACCEPTED_REVIEWER_SESSION_UNKNOWN: round ' + round + ' has no completed primary review');
    if (primary.evidenceType !== 'native-cli-session-v1') throw new Error('ACCEPTED_REVIEWER_SESSION_UNKNOWN: round ' + round + ' primary review is not a native CLI receipt');
    const evidencePath = text(primary.evidencePath);
    if (!evidencePath) throw new Error('ACCEPTED_REVIEWER_SESSION_UNKNOWN: round ' + round + ' native primary review has no evidencePath');
    let bytes;
    try { bytes = readFileSync(evidencePath); } catch (error) { throw new Error('ACCEPTED_REVIEWER_SESSION_UNREADABLE: round ' + round + ': ' + String(error?.message || error)); }
    if (sha256(bytes) !== text(primary.evidenceHash)) throw new Error('ACCEPTED_REVIEWER_SESSION_DRIFT: round ' + round + ' primary review receipt bytes changed');
    let receipt;
    try { receipt = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('ACCEPTED_REVIEWER_SESSION_INVALID: round ' + round + ' receipt is not JSON'); }
    if (receipt?.type !== 'native-cli-session-v1' || typeof receipt?.sessionId !== 'string' || !receipt.sessionId.trim()) {
      throw new Error('ACCEPTED_REVIEWER_SESSION_INVALID: round ' + round + ' receipt has no native sessionId');
    }
    ids.push(receipt.sessionId.trim());
  }
  // 同じDeepSeek reviewer sessionを複数の accepted 往復で使い回さない。重複は独立実行の
  // 前提を崩すため fail-closed。Opusは receipt に session ID を持たないためここでは対象外。
  const seen = new Set();
  for (const id of ids) {
    const key = id.toLowerCase();
    if (seen.has(key)) {
      throw new Error('ACCEPTED_REVIEWER_SESSION_REUSED: the same DeepSeek reviewer session is accepted by multiple rounds (' + id + ')');
    }
    seen.add(key);
  }
  return ids;
}

// 2026-09-29: a review has not started yet only when the persisted state itself shows zero code
// rounds, zero browser rounds and zero visual attempts. Any recorded round, a closed/other outcome,
// a focused recheck, a recovered dual finding or a real browser/visual attempt means the review has
// already begun, so a completed old review result can never be relabelled as pre-review.
export function reviewNotStarted(state, task) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { ok: false, reason: 'REVIEW_STATE_INVALID' };
  if (state.taskId !== task?.taskId || state.taskFingerprint !== task?.taskFingerprint) return { ok: false, reason: 'REVIEW_STATE_TASK_MISMATCH' };
  const codeReview = state.codeReview;
  if (!codeReview || typeof codeReview !== 'object' || Array.isArray(codeReview)) return { ok: false, reason: 'REVIEW_STATE_CODEREVIEW_MISSING' };
  if ((Array.isArray(codeReview.rounds) ? codeReview.rounds : []).length > 0) return { ok: false, reason: 'REVIEW_STATE_ROUNDS_STARTED' };
  if (codeReview.outcome !== 'in_progress' || text(codeReview.closedReason)) return { ok: false, reason: 'REVIEW_STATE_CLOSED' };
  if (codeReview.focusedRecheck !== undefined && codeReview.focusedRecheck !== null) return { ok: false, reason: 'REVIEW_STATE_FOCUSED_STARTED' };
  if (Array.isArray(codeReview.nativeDualReview?.blockingFindings) && codeReview.nativeDualReview.blockingFindings.length > 0) return { ok: false, reason: 'REVIEW_STATE_ROUNDS_STARTED' };
  const browser = state.browserReview;
  if (browser && typeof browser === 'object' && !Array.isArray(browser)) {
    if ((Array.isArray(browser.rounds) ? browser.rounds : []).length > 0) return { ok: false, reason: 'REVIEW_STATE_BROWSER_STARTED' };
    if (['passed', 'blocked', 'not_applicable'].includes(text(browser.preflight))) return { ok: false, reason: 'REVIEW_STATE_BROWSER_STARTED' };
    if (text(browser.outcome) && text(browser.outcome) !== 'not_started') return { ok: false, reason: 'REVIEW_STATE_BROWSER_STARTED' };
  }
  const visual = state.visualQc;
  if (visual && typeof visual === 'object' && !Array.isArray(visual)) {
    if ((Array.isArray(visual.attempts) ? visual.attempts : []).length > 0) return { ok: false, reason: 'REVIEW_STATE_VISUAL_STARTED' };
    if ((Array.isArray(visual.preliminaryChecks) ? visual.preliminaryChecks : []).length > 0) return { ok: false, reason: 'REVIEW_STATE_VISUAL_STARTED' };
    const outcome = text(visual.outcome);
    if (outcome && !['not_started', 'not_applicable'].includes(outcome)) return { ok: false, reason: 'REVIEW_STATE_VISUAL_STARTED' };
  }
  return { ok: true, reason: '' };
}

// Shared fail-closed preconditions for adding exactly ONE new verified DeepSeek-high native
// implementer session. Both the post-finding rework append and the pre-first-review append call
// this, so neither path can drift weaker than the initial bind-review-chain checks: exact current
// task/approval byte hashes, the task/approval identity binding, the native chain and an existing
// verified session set are all re-proved before any mode-specific gating runs.
function appendImplementerPreconditions(root, task, options, commandLabel) {
  const sessionFiles = Array.isArray(options.sessionFiles) ? options.sessionFiles.filter((item) => typeof item === 'string' && item) : [];
  const taskId = text(options.taskId);
  const fingerprint = text(options.fingerprint);
  const expectTaskSha256 = text(options.expectTaskSha256);
  const expectApprovalSha256 = text(options.expectApprovalSha256);
  if (!taskId || !fingerprint) throw new Error('--task-id and --fingerprint are required');
  if (!/^[a-f0-9]{64}$/u.test(expectTaskSha256) || !/^[a-f0-9]{64}$/u.test(expectApprovalSha256)) {
    throw new Error('--expect-task-sha256 and --expect-approval-sha256 require a 64-hex SHA256');
  }
  if (sessionFiles.length !== 1) throw new Error('--session-file must name exactly one NEW implementer session');
  if (text(options.model) !== 'deepseek-flash' || text(options.effort) !== 'high') throw new Error('--model deepseek-flash and --effort high are required');
  if (text(options.reviewChainVersion) !== 'deepseek-native-cli-v1') throw new Error('--review-chain-version deepseek-native-cli-v1 is required');
  if (text(task?.reviewChainVersion) !== 'deepseek-native-cli-v1') throw new Error('APPEND_REQUIRES_NATIVE_CHAIN: the task is not bound to the deepseek-native-cli-v1 chain');
  if (text(task?.taskId) !== taskId) throw new Error('current-task.json taskId mismatch: ' + (text(task?.taskId) || '(missing)'));
  if (text(task?.taskFingerprint) !== fingerprint) throw new Error('current-task.json taskFingerprint mismatch');
  if (text(task?.surfaceKind) !== 'web_ui') throw new Error('APPEND_SURFACE_MISMATCH: ' + commandLabel + ' only applies to web_ui tasks');

  const taskPath = join(root, '.ai', 'current-task.json');
  const approvalPath = join(root, '.ai', 'approval.json');
  const taskBytes = readFileSync(taskPath);
  if (sha256(taskBytes) !== expectTaskSha256) throw new Error('current-task.json byte SHA256 does not match --expect-task-sha256');
  ensureRegularFile(approvalPath, 'approval.json');
  const approvalBytes = readFileSync(approvalPath);
  if (sha256(approvalBytes) !== expectApprovalSha256) throw new Error('approval.json byte SHA256 does not match --expect-approval-sha256');
  const approval = readJson(approvalPath);
  if (
    text(approval?.taskId) !== taskId
    || text(approval?.taskFingerprint) !== fingerprint
    || approval?.status !== 'approved'
    || !Number.isInteger(approval?.revision)
  ) {
    throw new Error('approval.json is not the approved, unchanged approval for the current task');
  }
  const loaded = loadApproval(root, task);
  if (loaded.errors.length) throw new Error(loaded.errors.join('\n'));

  const record = task?.implementerSessions;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('APPEND_PRIOR_BINDING_MISSING: the task has no verified implementer session set yet; run approval bind-review-chain first');
  }
  return { sessionFiles, taskId, fingerprint, taskPath, approvalPath, expectApprovalSha256, record };
}

// Shared commit tail: re-open every bound implementer session under the trusted root, verify the
// one new session's real JSONL (trusted root, expected cwd, an allowed sandbox, model/effort, a
// completed turn), prove it is distinct from every bound implementer AND every accepted reviewer,
// then atomically rewrite only current-task.json and re-read approval.json to catch a concurrent
// approval change. The caller owns the gating and passes the exact reviewer ids it recovered;
// reviewOutputPaths, the alias and every previous session stay byte-for-byte, so alias/old sessions
// are preserved. Not exported: the two official entry points below are the only callers.
async function commitVerifiedImplementerSession(root, task, options, { sessionFiles, taskPath, approvalPath, expectApprovalSha256, record, reviewerIds }) {
  const evidence = await import('./review-evidence.mjs');
  const trustedRoot = options.trustedRoot !== undefined ? options.trustedRoot : evidence.trustedCodexSessionRoot(homedir());
  const sessionRoot = evidence.resolveTrustedSessionRoot(trustedRoot, options.requestedSessionRoot);
  const previousIds = evidence.boundImplementerSessionIds(task, { sessionRoot, expectedCwd: root });

  const verifiedNew = evidence.verifyImplementerSessionFile(sessionFiles[0], {
    sessionRoot,
    expectedCwd: root,
    allowedSandboxes: evidence.NATIVE_IMPLEMENTER_SANDBOXES,
  });
  if (verifiedNew.model !== 'deepseek-flash') throw new Error('APPEND_MODEL_MISMATCH: the new implementer session is not deepseek-flash: ' + String(verifiedNew.model));
  if (verifiedNew.effort !== 'high') throw new Error('APPEND_EFFORT_MISMATCH: the new implementer session is not high: ' + String(verifiedNew.effort));
  if (!Array.isArray(verifiedNew.completedTurnIds) || verifiedNew.completedTurnIds.length === 0) {
    throw new Error('APPEND_NOT_COMPLETED: the new implementer session has no completed turn');
  }
  if (previousIds.some((id) => appendImplementerIdKey(id) === appendImplementerIdKey(verifiedNew.id))) {
    throw new Error('APPEND_SESSION_NOT_DISTINCT: the new session already belongs to the verified implementer set: ' + verifiedNew.id);
  }
  if (reviewerIds.some((id) => appendImplementerIdKey(id) === appendImplementerIdKey(verifiedNew.id))) {
    throw new Error('APPEND_REVIEWER_SESSION_REUSE: the new session equals an accepted reviewer session: ' + verifiedNew.id);
  }

  const sessions = [...record.sessions, verifiedNew];
  sessions.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const nextRecord = { ...record, sessions };
  nextRecord.hash = evidence.implementerSessionsFingerprint(nextRecord);
  const next = { ...task, implementerSessions: nextRecord };

  atomicWriteJson(taskPath, next, { expectedValue: task, label: 'current-task.json' });
  if (sha256(readFileSync(approvalPath)) !== expectApprovalSha256) {
    try {
      atomicWriteJson(taskPath, task, { expectedValue: next, label: 'current-task.json' });
    } catch {
      void 0;
    }
    throw new Error('approval.json changed while appending the implementer session; current-task.json was restored');
  }
  return {
    alias: record.alias,
    appended: verifiedNew.id,
    sessionIds: nextRecord.sessions.map((session) => session.id),
    previousIds,
    reviewerIds,
    sessionsHash: nextRecord.hash,
  };
}

// The pre-review gate must prove no review work is in flight. A request that cannot be tied to a
// task, belongs to another task, or is neither explicitly reset/archived nor a provably idle state
// is refused rather than assumed idle. A reset/archived old request is not active, and even a stale
// open queue lease from before that reset must not block the append.
async function assertNoActivePreReviewWork(root, { taskId, fingerprint }) {
  const requestStatePath = join(root, '.ai', 'context', 'review-request.json');
  if (!existsSync(requestStatePath)) return '';
  ensureRegularFile(requestStatePath, 'review-request.json');
  const requestState = readJson(requestStatePath);
  const boundTaskId = text(requestState?.taskId);
  const boundFingerprint = text(requestState?.taskFingerprint);
  if (!boundTaskId || !boundFingerprint) {
    throw new Error('APPEND_PRE_REVIEW_REQUEST_AMBIGUOUS: review-request.json has no taskId/taskFingerprint binding');
  }
  if (boundTaskId !== taskId || boundFingerprint !== fingerprint) {
    throw new Error('APPEND_PRE_REVIEW_FOREIGN_REQUEST: review-request.json belongs to another task');
  }
  const status = text(requestState?.status);
  if (APPEND_IMPLEMENTER_PENDING_REQUEST_STATUSES.includes(status)) {
    throw new Error('APPEND_REQUEST_PENDING: a review request is still in flight (status=' + status + '); finish or reset it before appending an implementer session');
  }
  if (status === 'reset' || status === 'archived') return '';
  const requestId = text(requestState?.requestId);
  if (requestId) {
    const queue = await import('./ai-review-queue-lib.mjs').catch(() => null);
    if (queue) {
      let entryStatus = '';
      try {
        const entryDir = queue.queueEntryPath(requestId);
        if (existsSync(join(entryDir, 'reset.json'))) entryStatus = 'reset';
        else {
          const stateFile = join(entryDir, 'state.json');
          if (existsSync(stateFile)) entryStatus = text(queue.readQueueJson(stateFile, 'state.json')?.status);
        }
      } catch { entryStatus = ''; }
      if (APPEND_IMPLEMENTER_OPEN_QUEUE_STATES.includes(entryStatus)) {
        throw new Error('APPEND_QUEUE_LEASE_OPEN: the current request queue entry is still open (status=' + entryStatus + ')');
      }
    }
  }
  throw new Error('APPEND_PRE_REVIEW_REQUEST_ACTIVE: review-request.json status is not active-free (status=' + (status || '(missing)') + ')');
}

// 2026-09-29: pre-first-review追加。まだ1往復も始まっていない(code rounds0/browser0/visual0)間に、
// 実在する完了済みDeepSeek-highネイティブ実装セッションを1件だけ足す。束縛済みセッションを再開して
// 書き換えるのではなく、実装者とレビュアーの別性・出所をレビュー開始前に揃えるための最小の追加経路。
// 承認済みapproval.jsonはbyte同一のまま、current-task.jsonだけをatomicに更新する。
export async function appendPreReviewImplementerBinding(root, task, options = {}) {
  const { sessionFiles, taskId, fingerprint, taskPath, approvalPath, expectApprovalSha256, record } =
    appendImplementerPreconditions(root, task, options, 'append-pre-review-implementer');

  const reviewStatePath = join(root, '.ai', 'context', 'review-rounds.json');
  if (!existsSync(reviewStatePath)) {
    throw new Error('APPEND_PRE_REVIEW_STATE_MISSING: .ai/context/review-rounds.json is required; a pre-review append must prove no round has started');
  }
  ensureRegularFile(reviewStatePath, 'review-rounds.json');
  const reviewState = readJson(reviewStatePath);
  const preReview = reviewNotStarted(reviewState, task);
  if (!preReview.ok) throw new Error('APPEND_PRE_REVIEW_ALREADY_STARTED: ' + preReview.reason);

  const requestId = await assertNoActivePreReviewWork(root, { taskId, fingerprint });
  // No round exists, so there is no accepted reviewer receipt to recover; distinctness from every
  // bound implementer session is still re-proved inside the shared commit tail.
  const committed = await commitVerifiedImplementerSession(root, task, options, {
    sessionFiles, taskPath, approvalPath, expectApprovalSha256, record, reviewerIds: [],
  });
  return { ...committed, requestId: requestId || null };
}

export async function appendReviewImplementerBinding(root, task, options = {}) {
  const { sessionFiles, taskId, fingerprint, taskPath, approvalPath, expectApprovalSha256, record } =
    appendImplementerPreconditions(root, task, options, 'append-review-implementer');

  const reviewStatePath = join(root, '.ai', 'context', 'review-rounds.json');
  if (!existsSync(reviewStatePath)) throw new Error('APPEND_REVIEW_STATE_MISSING: .ai/context/review-rounds.json is required; a rework append needs an accepted finding');
  ensureRegularFile(reviewStatePath, 'review-rounds.json');
  const reviewState = readJson(reviewStatePath);
  const rework = reviewReworkRequired(reviewState, task);
  if (!rework.ok) throw new Error('APPEND_REWORK_NOT_REQUIRED: ' + rework.reason);
  const reviewerIds = acceptedReviewerSessionIds(reviewState);

  const requestStatePath = join(root, '.ai', 'context', 'review-request.json');
  if (existsSync(requestStatePath)) {
    ensureRegularFile(requestStatePath, 'review-request.json');
    const requestState = readJson(requestStatePath);
    if (requestState?.taskId === taskId && requestState?.taskFingerprint === fingerprint) {
      const status = text(requestState?.status);
      if (APPEND_IMPLEMENTER_PENDING_REQUEST_STATUSES.includes(status)) {
        throw new Error('APPEND_REQUEST_PENDING: a review request is still in flight (status=' + status + '); finish or reset it before appending an implementer session');
      }
    }
  }
  if (rework.requestId) {
    const queue = await import('./ai-review-queue-lib.mjs').catch(() => null);
    if (queue) {
      let entryStatus = '';
      try {
        const stateFile = join(queue.queueEntryPath(rework.requestId), 'state.json');
        if (existsSync(stateFile)) entryStatus = text(queue.readQueueJson(stateFile, 'state.json')?.status);
      } catch { entryStatus = ''; }
      if (APPEND_IMPLEMENTER_OPEN_QUEUE_STATES.includes(entryStatus)) {
        throw new Error('APPEND_QUEUE_LEASE_OPEN: the accepted round queue entry is still open (status=' + entryStatus + ')');
      }
    }
  }

  const committed = await commitVerifiedImplementerSession(root, task, options, {
    sessionFiles, taskPath, approvalPath, expectApprovalSha256, record, reviewerIds,
  });
  return { ...committed, requestId: rework.requestId || null };
}

export function specLeaderSource(root, handoffDir) {
  const directory = resolveRepoPath(root, handoffDir, 'spec-leader handoff');
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('handoffはsymlinkではない実ディレクトリが必要です');
  const names = ['AGENTS.md', 'acceptance_checklist.md', 'spec_core.json', 'decisions_log.md'];
  const files = names.map((name) => {
    const path = join(directory, name);
    ensureRegularFile(path, 'spec-leader成果物');
    const content = readFileSync(path);
    if (content.length === 0) throw new Error(`spec-leader成果物が空です: ${name}`);
    return { path: relative(root, path), sha256: sha256(content) };
  });
  const core = readJson(join(directory, 'spec_core.json'));
  if (!text(core.project)) throw new Error('spec_core.jsonのprojectが空です');
  if (!text(core.generatedAt) || !Number.isFinite(Date.parse(core.generatedAt))) {
    throw new Error('spec_core.jsonのgeneratedAtが日時として不正です');
  }
  return { directory, files, core };
}
