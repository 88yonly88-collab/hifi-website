import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  atomicWriteJson,
  declarationPathFor,
  ensureRegularFile,
  parseDeclaration,
  readJson,
  resolveRepoPath,
  safeId,
  validateFailedEvidence,
  validatePassedEvidence,
} from './ai-e2e-lib.mjs';
import { RUNTIME_EVIDENCE_MARKER_KEY, verifyPaneRuntimeEvidence, withReviewRequestLock } from './ai-runtime-evidence-lib.mjs';

// ai-complete等の最小fixtureはrounds-libとe2e-libだけを配ることがある。
// 秘密判定helperが無い場合は全pathを秘密扱いしてlargeへ倒し、通知helperが
// 無い場合は外部送信せず失敗警告をstateへ残す。部分配布でもimport時に即死させない。
let optionalReviewQueue = null;
let optionalWorkflow = null;
let optionalReviewEvidence = null;
try { optionalReviewEvidence = await import('./review-evidence.mjs'); } catch { /* legacy minimal fixtures: no external path */ }
try {
  optionalReviewQueue = await import('./ai-review-queue-lib.mjs');
} catch {
  optionalReviewQueue = null;
}
try {
  optionalWorkflow = await import('./ai-workflow-lib.mjs');
} catch {
  optionalWorkflow = null;
}

function isSecretPath(value) {
  if (typeof optionalReviewQueue?.isSecretPath === 'function') {
    return optionalReviewQueue.isSecretPath(value);
  }
  return Boolean(String(value || '').trim());
}

function redactReviewText(value) {
  if (typeof optionalReviewQueue?.redactReviewText === 'function') {
    return optionalReviewQueue.redactReviewText(value);
  }
  return String(value || '').trim() ? '[REDACTED_UNAVAILABLE]' : '';
}

export const REVIEW_ROUNDS_SCHEMA_VERSION = 1;
// ブラウザレビューは従来どおり3往復。新形式のコードレビューも全サイズ最大3往復にする。
export const MAX_REVIEW_ROUNDS = 3;
export const MAX_VISUAL_QC_ATTEMPTS = 2;
export const MAX_VISUAL_QC_PRELIMINARY_CHECKS = 10;
export const SMALL_CODE_REVIEW_ROUNDS = 2;
export const LEGACY_CODE_REVIEW_ROUNDS = 2;
export const LEGACY_LARGE_CODE_REVIEW_ROUNDS = 2;
export const MAX_CODE_REVIEW_ROUNDS = 2; // 2026-10-13 ユーザー決定: 2周×3モデル=計6回
export const FUNCTIONAL_DEFECT_REVIEW_POLICY = 'functional_defects_v1';
export const REVIEW_SIZE_CONFIG_RELATIVE_PATH = '.ai/review-rounds-config.json';
export const DEFAULT_SHARED_CANONICAL_PATHS = [
  'templates/',
  'config/',
  'scripts/*-lib.mjs',
  'scripts/*-lib.cjs',
  'scripts/*-lib.js',
  'scripts/*-lib.ts',
];

// 2026-09-05以降のコードレビューは、担当と観点を3往復へ固定する。
// 既存stateの6/10往復上限は読込互換のため残すが、4往復目以降の独立観点は持たない。
export const REVIEW_CHAIN_VERSION = 'deepseek-opus-v1';
export const LEGACY_REVIEW_CHAIN_VERSION = 'opus-astra-opus-v1';
export const NATIVE_REVIEW_CHAIN_VERSION = 'deepseek-native-cli-v1';
export const CODE_REVIEW_LENSES = [
  { round: 1, primaryReviewer: 'deepseek', parallelPrimaryReviewer: 'sol', reviewer: 'opus', key: 'spec', focus: '同じ対象版に固定されたDeepSeek一次照合とSol独立確認の記録を根拠に、Opusが仕様漏れ・誤実装・依頼範囲外の動作変更と実利用の経路を確認する' },
  { round: 2, primaryReviewer: 'deepseek', parallelPrimaryReviewer: 'sol', reviewer: 'opus', key: 'user_path', focus: '同じ対象版に固定されたDeepSeek一次確認とSol独立確認の記録を根拠に、Opusが主要操作・保存・再読込と、空入力・境界値・連続操作・失敗時・再試行の証拠を照合する。実行できなかった項目は理由とともに未確認として残す' },
];
export const LEGACY_CODE_REVIEW_LENSES = [
  { round: 1, primaryReviewer: null, reviewer: 'opus', key: 'spec', focus: 'Opusが独立に仕様漏れ・誤実装・依頼範囲外の動作変更を確認する' },
  { round: 2, primaryReviewer: null, reviewer: 'astra', key: 'user_path', focus: 'GPT-6 Astraが指定の検証環境で主要操作・出力・保存・再読込を確認する。実行できなかった項目は理由とともに未確認として残す' },
];
// 2026-09-28 (native dual-review acceptance): the explicit deepseek-native-cli-v1 chain reviews
// each bound version in parallel independence. DeepSeek high and Opus 5.5 each verify the same
// scope/HEAD/approval version on their own, and only then are the two results formally compared.
// The rounds stay sequential. This wording must not claim Opus read DeepSeek's body first; the
// legacy direct-API chain keeps its original "DeepSeek一次確認の記録を根拠に" text in CODE_REVIEW_LENSES.
export const NATIVE_CODE_REVIEW_LENSES = [
  { round: 1, primaryReviewer: 'deepseek', parallelPrimaryReviewer: 'sol', reviewer: 'opus', key: 'spec', focus: '同一scope/HEAD/approvalに固定された対象版を、DeepSeek highとSolが各自独立に確認し、Opusが仕様漏れ・誤実装・依頼範囲外の動作変更を両結果で正式照合する' },
  { round: 2, primaryReviewer: 'deepseek', parallelPrimaryReviewer: 'sol', reviewer: 'opus', key: 'user_path', focus: '同一scope/HEAD/approvalに固定された対象版を、DeepSeek highとSolが各自独立に確認し、Opusが主要操作・保存・再読込と境界値・失敗時・再試行の証拠を両結果で正式照合する。どちらかが実行できなかった項目は理由とともに未確認として残す' },
];

export const CODE_REVIEW_COMMON_RULES = [
  '指摘対象は不具合のみ。好み、命名、整形、任意のリファクタ、仕様外の改善は指摘しない。',
  '指摘には「発生条件」「期待と実際の違い」「該当箇所」「根拠」を付ける。',
  '推測だけで不具合と断定しない。疑いは可能な範囲で自分で検証し、確認できなければ未確認事項として区別する。',
  '過去に確認済みの内容は、変更や新しい根拠がなければ繰り返さない。ただし担当観点以外でも、実際に見つけた不具合は報告する。',
  'レビューは対象の変更と、影響が及ぶ関連処理に絞る。',
];
export const COMPREHENSIVE_CODE_REVIEW_LENS = {
  round: null,
  reviewer: 'opus',
  key: 'comprehensive',
  focus: [
    '1回で全観点を確認する。重要度順は、仕様不一致、利用者経路が通らない、データ破損、既存機能の退行、不可逆操作、その他',
    '境界値と異常系も同じ回で確認する',
    '既存の単一観点依頼を受理する場合も、確認できない項目は未確認として区別する',
    '各指摘へ Finding-Kind: spec|user_path|data_loss|regression|irreversible|other のいずれかを付ける',
  ].join('。'),
};

// === CMGB native focused spec→user_path→edge closure (2026-09-29) ===
// 有効化は taskId/taskFingerprint/repo/surfaceKind と native連鎖の全一致だけ。他task native・
// legacy・direct-API・既存単一 focusedRecheck の挙動は変えない。accepted は
// codeReview.focusedRechecks へ追記し、rounds[3] は水増ししない。旧 focusedRecheck.result からの
// 自動移行はしない。対象keyは原文全文から作り、480等の切詰めで別指摘を同一keyにしない。
export const CMGB_NATIVE_FOCUSED_CONTRACT = 'cmgb-native-focused-v1';
export const CMGB_NATIVE_FOCUSED_LENS_ORDER = ['spec', 'user_path', 'edge'];
export const CMGB_NATIVE_FOCUSED_TARGET_LIMIT = 200;
const CMGB_NATIVE_FOCUSED_IDENTITY = Object.freeze({
  taskId: 'cmgb-t0-t5-local-recovery-20260927',
  taskFingerprint: 'cmgb-local-recovery-20260927-t0-t5',
  repo: 'cmgb-recovery',
  surfaceKind: 'web_ui',
});

function cmgbCanonicalJson(value) {
  if (Array.isArray(value)) return value.map(cmgbCanonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, cmgbCanonicalJson(value[key])]));
}

function cmgbSha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function cmgbNativeFocusedIdentity(task) {
  const actual = {
    taskId: String(task?.taskId || '').trim(),
    taskFingerprint: String(task?.taskFingerprint || '').trim(),
    repo: String(task?.repo || '').trim(),
    surfaceKind: String(task?.surfaceKind || '').trim(),
  };
  return Object.entries(CMGB_NATIVE_FOCUSED_IDENTITY)
    .every(([field, expected]) => actual[field] === expected);
}

function usesCmgbNativeFocused(task, chainVersion) {
  return chainVersion === NATIVE_REVIEW_CHAIN_VERSION && cmgbNativeFocusedIdentity(task);
}

function isCmgbNativeFocusedState(state) {
  return String(state?.taskId || '').trim() === CMGB_NATIVE_FOCUSED_IDENTITY.taskId
    && String(state?.taskFingerprint || '').trim() === CMGB_NATIVE_FOCUSED_IDENTITY.taskFingerprint
    && String(state?.codeReview?.reviewChainVersion || '').trim() === NATIVE_REVIEW_CHAIN_VERSION;
}

function cmgbFocusedTargetKey(entry) {
  return cmgbSha256(JSON.stringify(cmgbCanonicalJson({
    originRequestId: entry?.originRequestId ?? null,
    round: entry?.round ?? null,
    lens: entry?.lens ?? null,
    source: entry?.source ?? null,
    kind: entry?.kind ?? null,
    index: entry?.index ?? null,
    originalText: entry?.originalText ?? '',
    evidenceHash: entry?.evidenceHash ?? '',
  })));
}

// 3観点の accepted が同じ修正版を指すための固定鍵。send/check lane も同じ関数を使い、
// 独自実装でhash入力を分岐させない。
export function cmgbFocusedBatchKey(binding) {
  return cmgbSha256(JSON.stringify(cmgbCanonicalJson({
    taskId: binding?.taskId ?? null,
    taskFingerprint: binding?.taskFingerprint ?? null,
    reviewBaseCommit: binding?.reviewBaseCommit ?? null,
    reviewHeadCommit: binding?.reviewHeadCommit ?? null,
    approvalHash: binding?.approvalHash ?? null,
    scopeHash: binding?.scopeHash ?? null,
    scopeManifestHash: binding?.scopeManifestHash ?? null,
    manifestHash: binding?.manifestHash ?? null,
  })));
}

// 対象key列挙の canonical hash。send が request.nativeFocusedTargetsHash を固定するのと
// core が再計算するのが同じ実装になるよう export する。
export function cmgbFocusedTargetsHash(descriptors) {
  return cmgbSha256(JSON.stringify(cmgbCanonicalJson(Array.isArray(descriptors) ? descriptors : [])));
}

// originalText / evidenceHash は原物全文から作る（切詰めで別指摘を同一keyにしない）。
function cmgbFocusedDescriptors(state, lens) {
  const rounds = Array.isArray(state?.codeReview?.rounds) ? state.codeReview.rounds : [];
  const accepted = Array.isArray(state?.codeReview?.focusedRechecks) ? state.codeReview.focusedRechecks : [];
  // 受理済み再確認の result が再掲する固定unverified原文は、既に元descriptorとして履歴に残るため
  // 新しい未確認事項として二重計上しない（新規/改変の原文だけが新しい阻害として残る）。
  const coveredFor = (entry) => {
    const covered = new Set();
    for (const target of Array.isArray(entry?.targets) ? entry.targets : []) {
      if (target?.kind !== 'unverified') continue;
      covered.add(`${String(target.source || '')}\u0000${String(target.originalText ?? '')}`);
    }
    return covered;
  };
  const records = [
    ...rounds.map((record) => ({ record, originLens: record?.lens, covered: null })),
    ...accepted.map((entry) => ({ record: entry?.result, originLens: entry?.lens, covered: coveredFor(entry) })),
  ];
  const byKey = new Map();
  const push = (descriptor) => {
    const key = cmgbFocusedTargetKey(descriptor);
    if (!byKey.has(key)) byKey.set(key, { key, ...descriptor });
  };
  for (const { record, originLens, covered } of records) {
    if (!record || originLens !== lens) continue;
    const dual = nativeDualSide(record);
    if (!dual) continue;
    const origin = { originRequestId: record.requestId ?? null, round: record.round ?? null, lens };
    const isCovered = (source, kind, text) => kind === 'unverified'
      && covered instanceof Set
      && covered.has(`${source}\u0000${String(text ?? '')}`);
    const deepseek = nativeDualSideObject(dual.deepseek);
    if (deepseek) {
      (Array.isArray(deepseek.findings) ? deepseek.findings : []).forEach((finding, index) => {
        const severity = String(finding?.severity || '').trim().toUpperCase();
        if (severity !== 'P0' && severity !== 'P1') return;
        const text = String(finding?.summary || finding?.evidence || '');
        push({ ...origin, source: 'deepseek', kind: 'finding', index, originalText: text, evidenceHash: cmgbSha256(String(finding?.evidence ?? text)) });
      });
      (Array.isArray(deepseek.importantUnknowns) ? deepseek.importantUnknowns : []).forEach((item, index) => {
        const text = String(item ?? '');
        push({ ...origin, source: 'deepseek', kind: 'important_unknown', index, originalText: text, evidenceHash: cmgbSha256(text) });
      });
      (Array.isArray(deepseek.unverified) ? deepseek.unverified : []).forEach((item, index) => {
        const text = String(item ?? '');
        if (isCovered('deepseek', 'unverified', text)) return;
        push({ ...origin, source: 'deepseek', kind: 'unverified', index, originalText: text, evidenceHash: cmgbSha256(text) });
      });
    }
    const opus = nativeDualSideObject(dual.opus);
    if (opus) {
      if (!nativeDualPassed(opus)) {
        const text = String(opus.findingsText ?? '');
        push({ ...origin, source: 'opus', kind: 'finding', index: 0, originalText: text, evidenceHash: cmgbSha256(text) });
      }
      (Array.isArray(opus.unverified) ? opus.unverified : []).forEach((item, index) => {
        const text = String(item ?? '');
        if (isCovered('opus', 'unverified', text)) return;
        push({ ...origin, source: 'opus', kind: 'unverified', index, originalText: text, evidenceHash: cmgbSha256(text) });
      });
    }
  }
  return [...byKey.values()];
}

// 限定再確認（CMGB native focused）だけに載せる依頼文の補足。検証の証跡（機械固定の生ログ）と
// 自分の再実行の有無を混同させない。ai-review-send.mjs の nativeFocusedSection からのみ展開し、
// 通常native/legacy/単一focusedの依頼文は変えない。生成される依頼文をテストからそのまま
// 検査できるよう、ここへ置く。
export function cmgbFocusedProofSourceGuidance() {
  return [
    '### 検証証跡の出典と自己実行の区別（CMGB native focused）',
    '- 自分で実行していない build・テスト・E2E・ブラウザ操作を「実行した」と書かないでください。実行していないことは方法の説明です。',
    '- 依頼に固定された同一scopeのテスト・E2Eの生ログが同一HEADの現版に結び付いており、その内容を実際に確認した場合、自分でコマンドを再実行していないことは方法の説明であって、新しい未確認事項として計上しないでください。確認した出典（ログのpath・結び付いたHEAD）と、その証跡が覆う範囲・覆えない範囲を本文と Recheck-Decision の根拠へ書いてください。',
    '- buildの生ログは同一HEADとは限りません。ログのHEADが現版と異なる場合は、関連するbuild入力（製品コード・設定・依存）が現版と同一であることを独立に確認できたときにだけ、自分の再実行の不在を方法の説明として扱えます。比較した入力（対象pathとhash等）と、一致を確認できていない範囲を本文と Recheck-Decision の根拠へ明記し、その古い生ログを現版のbuildとして扱わないでください。関連build入力の同一性が未証明なら、必要なbuildは未確認のまま open としてください。',
    '- ログが無い・不正・現版と別の版で同一性の証明も無い・要求された観点を覆うのに不足する場合は、その実質的な不明点をそのまま ## 未確認事項 に残し、該当keyを open としてください。必要な前提の欠落を隠さないでください。',
    '- 未確認事項を空に見せるためだけに「なし」と書かず、実際に見つけた不具合や open にすべきkeyを resolved として扱わないでください。',
    '- この区別は、固定一覧のkey・原文の一致判定や、新たに生じた重要unknownの拒否を緩めるものではありません。',
  ].join('\n');
}

// 送信時に対象keyを公式requestへ固定する側（send）と、受理時の再計算（core）が同じ列挙を使う。
export function cmgbFocusedTargets(state, lens) {
  return cmgbFocusedDescriptors(state, lens);
}

function cmgbAllFocusedDescriptors(state) {
  return CMGB_NATIVE_FOCUSED_LENS_ORDER.flatMap((lens) => cmgbFocusedDescriptors(state, lens));
}

function cmgbAcceptedRechecks(state) {
  const list = Array.isArray(state?.codeReview?.focusedRechecks) ? state.codeReview.focusedRechecks : [];
  return list.filter((entry) => entry
    && entry.contract === CMGB_NATIVE_FOCUSED_CONTRACT
    && entry.status === 'accepted'
    && entry.result);
}

function cmgbSameBatchRechecks(state, batchKey) {
  if (!batchKey) return [];
  return cmgbAcceptedRechecks(state).filter((entry) => entry.batchKey === batchKey);
}

function cmgbResolvedKeySet(state, batchKey) {
  const resolved = new Set();
  for (const entry of cmgbSameBatchRechecks(state, batchKey)) {
    for (const key of [...(entry.resolvedKeys || []), ...(entry.nonblockingKeys || [])]) resolved.add(key);
  }
  return resolved;
}

function cmgbLatestBatchKey(state) {
  const accepted = cmgbAcceptedRechecks(state);
  return accepted.length ? accepted[accepted.length - 1].batchKey : null;
}

function nextCmgbFocusedLens(lens) {
  const index = CMGB_NATIVE_FOCUSED_LENS_ORDER.indexOf(lens);
  return index >= 0 && index < CMGB_NATIVE_FOCUSED_LENS_ORDER.length - 1
    ? CMGB_NATIVE_FOCUSED_LENS_ORDER[index + 1]
    : null;
}

function cmgbNormalizeDecision(value) {
  const decision = String(value || '').trim().toLowerCase();
  return ['resolved', 'nonblocking', 'open'].includes(decision) ? decision : '';
}

function cmgbFocusedEvidence(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return /^(?:確認済み|確認した|問題なし|なし|ok|済|済み)$/iu.test(text) ? '' : text;
}

// CMGB native focused の nonblocking 根拠は、両独立者が次を独立に記したものだけを認める。
// criterion=<承認済み完成図 completionCriteria の index 又は none>; reach=<成果物への到達/非到達>;
// evidence=<現版の具体的証拠>。欠落・定型文・空は nonblocking として認めない。
function cmgbFocusedNonblockingEvidence(value) {
  const text = cmgbFocusedEvidence(value);
  if (!text) return '';
  const criterion = text.match(/(?:^|[;；,、\s])criterion\s*[=:：]\s*(none|[0-9]+(?:\s*[,\-]\s*[0-9]+)*)/iu);
  const reach = text.match(/(?:^|[;；,、\s])reach\s*[=:：]\s*([^\s;；,、]+)/iu);
  const evidence = text.match(/(?:^|[;；,、\s])evidence\s*[=:：]\s*(\S.*)$/isu);
  if (!criterion || !reach || !evidence) return '';
  const evidenceValue = String(evidence[1]).trim();
  if (!evidenceValue || /^(?:確認済み|確認した|問題なし|なし|ok|済|済み)$/iu.test(evidenceValue)) return '';
  return text;
}

// 今回requestで事前固定した kind=unverified target のうち、両独立者が criterion/reach/evidence 付きで
// nonblocking と判定した key だけを集め、その (source, 原文) を「再掲しても非阻害」として許す。
function cmgbFocusedNonblockingUnverifiedAllowed({ descriptors, resolution }) {
  const nonblockingKeys = new Set();
  for (const target of Array.isArray(resolution?.targets) ? resolution.targets : []) {
    if (cmgbNormalizeDecision(target?.deepseek?.decision) !== 'nonblocking') continue;
    if (cmgbNormalizeDecision(target?.opus?.decision) !== 'nonblocking') continue;
    if (!cmgbFocusedNonblockingEvidence(target?.deepseek?.evidence)) continue;
    if (!cmgbFocusedNonblockingEvidence(target?.opus?.evidence)) continue;
    nonblockingKeys.add(String(target?.key || ''));
  }
  const allowed = new Set();
  for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
    if (descriptor?.kind !== 'unverified') continue;
    if (!nonblockingKeys.has(descriptor.key)) continue;
    allowed.add(`${String(descriptor.source || '')}\u0000${String(descriptor.originalText ?? '')}`);
  }
  return allowed;
}

function cmgbFocusedUnverifiedAllowed(items, source, allowed) {
  for (const item of Array.isArray(items) ? items : []) {
    if (!allowed.has(`${source}\u0000${String(item ?? '')}`)) return false;
  }
  return true;
}

// CMGB focused だけの DeepSeek 判定。verdict=pass/ok は findings が「実在する空配列」のときだけ通す
// （欠落・null・非配列を clean とみなさない。合格が所見を黙って抱え込めない）。verdict=findings は
// findings が配列で非空、かつ全 severity が P2/P3 のときだけ通す。P0/P1・severity欠落/不明・
// 非配列findings・判定欠落は阻害。nativeDualPassed 自体は変えず、通常native/legacyの意味を保つ。
const CMGB_FOCUSED_PASS_VERDICTS = ['pass', 'ok'];
const CMGB_FOCUSED_NONBLOCKING_SEVERITIES = new Set(['P2', 'P3']);
function cmgbFocusedDeepseekNonblocking(side, findings) {
  const verdict = String(side?.verdict || '').trim();
  if (CMGB_FOCUSED_PASS_VERDICTS.includes(verdict)) {
    return Array.isArray(findings) && findings.length === 0;
  }
  if (verdict !== 'findings') return false;
  if (!Array.isArray(findings) || findings.length === 0) return false;
  return findings.every((finding) => CMGB_FOCUSED_NONBLOCKING_SEVERITIES.has(
    String(finding?.severity || '').trim().toUpperCase(),
  ));
}

// 両者が clean かを返す。DeepSeek は verdict=pass/ok（findingsが空配列）に加え、記録として残した
// P2/P3 のみの verdict=findings も非阻害として通す（配列は書き換えない）。unverified は無条件拒否
// ではなく、今回requestに事前固定した同source/lensの kind=unverified target原文と完全一致し、
// 両独立者がそのkeyを criterion/reach/evidence 付き nonblocking と判定した項目だけを非阻害として
// 通す。新規・原文改変・曖昧・片側のみ・別targetは阻害のまま残す（旧結果も書き換えない）。
export function cmgbFocusedBothClean(round, { descriptors = [], resolution = null } = {}) {
  const dual = nativeDualSide(round);
  const deepseek = nativeDualSideObject(dual?.deepseek);
  if (!deepseek) return false;
  const deepseekFindings = Array.isArray(deepseek.findings) ? deepseek.findings : null;
  if (!cmgbFocusedDeepseekNonblocking(deepseek, deepseekFindings)) return false;
  const blocking = (deepseekFindings || [])
    .filter((finding) => ['P0', 'P1'].includes(String(finding?.severity || '').trim().toUpperCase()));
  if (blocking.length > 0) return false;
  if ((deepseek.importantUnknowns || []).length > 0) return false;
  const opus = nativeDualSideObject(dual?.opus);
  if (!opus || !nativeDualPassed(opus)) return false;
  if (oneLine(opus.findingsText)) return false;
  const allowedUnverified = cmgbFocusedNonblockingUnverifiedAllowed({ descriptors, resolution });
  if (!cmgbFocusedUnverifiedAllowed(deepseek.unverified, 'deepseek', allowedUnverified)) return false;
  if (!cmgbFocusedUnverifiedAllowed(opus.unverified, 'opus', allowedUnverified)) return false;
  return true;
}

// 上限超過を静かに slice で隠さない。超過は明示overflow行を足し、件数も落とさない。
function cmgbVisibleList(items, cap, overflowLabel) {
  const list = items.filter(Boolean);
  if (list.length <= cap) return list;
  return [...list, `${overflowLabel}: 表示上限 ${cap} 件を超えています(合計 ${list.length} 件)`];
}

// CMGBだけの dual status。旧所見は「同版(latest batch)で明示 resolved / nonblocking したkey」だけが
// 消える。単一結果・別版・他lensでは消さない。新batchと旧batchの closure を混用しない。
function cmgbNativeDualStatus(state) {
  const rounds = Array.isArray(state?.codeReview?.rounds) ? state.codeReview.rounds : [];
  const accepted = cmgbAcceptedRechecks(state);
  const resolved = cmgbResolvedKeySet(state, cmgbLatestBatchKey(state));
  const blocking = [];
  const unknowns = [];
  for (const descriptor of cmgbAllFocusedDescriptors(state)) {
    if (resolved.has(descriptor.key)) continue;
    if (descriptor.kind === 'important_unknown' || descriptor.kind === 'unverified') {
      unknowns.push(`${descriptor.source} ${descriptor.kind}: ${oneLine(descriptor.originalText, 500)}`);
    } else {
      blocking.push({
        source: descriptor.source,
        round: descriptor.round,
        lens: descriptor.lens,
        severity: '',
        summary: oneLine(descriptor.originalText, 500),
        key: descriptor.key,
      });
    }
  }
  const dedupedUnknowns = cmgbVisibleList([...new Set(unknowns)], 50, 'CMGB_UNKNOWN_OVERFLOW');
  return {
    blocking,
    blockingCount: blocking.length,
    unknowns: dedupedUnknowns,
    unknownCount: dedupedUnknowns.length,
    rounds: rounds.length + accepted.length,
  };
}

// 公式queueの検証済み結果を正規helperから再取得する。取得不能・未readyは fail closed。
function cmgbFocusedQueueEvidence(request) {
  const load = optionalReviewQueue?.loadValidatedQueueResult;
  if (typeof load !== 'function') {
    return { error: 'CMGB_FOCUSED_QUEUE_UNAVAILABLE: ai-review-queue-lib.mjs の loadValidatedQueueResult が必要です' };
  }
  let evidence;
  try {
    evidence = load(request);
  } catch (error) {
    return { error: `CMGB_FOCUSED_QUEUE_ERROR: 公式queue結果を再取得できません: ${error?.message || error}` };
  }
  if (!evidence || evidence.ready !== true) {
    return { error: 'CMGB_FOCUSED_QUEUE_NOT_READY: 公式queueの検証済みaccepted結果がありません' };
  }
  return { evidence };
}

// check lane が claim 内の公式 queue/receipt から組み立てて渡す recheckResolution を、
// 実 queue state/result・verified receipt・request pin と値照合してから追記する。
// 相違・欠落は review-rounds.json 書込前に reject（自己申告だけ・形式だけでは合格にしない）。
function buildCmgbFocusedAcceptance({ state, task, request, round, resolution, nativePrimaryVerified, roundNumber, acceptedAt }) {
  if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) {
    return { error: 'CMGB_FOCUSED_RESOLUTION_REQUIRED: CMGB native focused の再確認には options.recheckResolution が必要です' };
  }
  if (String(resolution.contract || '') !== CMGB_NATIVE_FOCUSED_CONTRACT) {
    return { error: `CMGB_FOCUSED_RESOLUTION_CONTRACT: contract が不正です: ${String(resolution.contract || '')}` };
  }
  const pendingLens = oneLine(state?.codeReview?.focusedRecheck?.lens);
  if (!pendingLens || String(resolution.lens || '') !== pendingLens) {
    return { error: `CMGB_FOCUSED_RESOLUTION_LENS: 再確認する観点が一致しません（pending=${pendingLens || '不明'} / resolution=${String(resolution.lens || '不明')}）` };
  }
  if (String(resolution.requestId || '') !== String(request?.requestId || '')) {
    return { error: 'CMGB_FOCUSED_RESOLUTION_REQUEST: requestId が依頼と一致しません' };
  }
  const requestInputHash = String(request?.inputHash || '');
  if (!requestInputHash || String(resolution.inputHash || '') !== requestInputHash) {
    return { error: 'CMGB_FOCUSED_RESOLUTION_INPUT_HASH: inputHash が依頼と一致しません' };
  }
  if (resolution.round !== roundNumber) {
    return { error: `CMGB_FOCUSED_RESOLUTION_ROUND: round が一致しません（期待 ${roundNumber} / 実際 ${String(resolution.round)}）` };
  }
  // --- 実 queue state/result の再取得と値照合 ---
  const queue = cmgbFocusedQueueEvidence(request);
  if (queue.error) return { error: queue.error };
  const queueEvidence = queue.evidence;
  const queueState = queueEvidence.state && typeof queueEvidence.state === 'object' ? queueEvidence.state : {};
  const queuedRequest = queueEvidence.queuedRequest && typeof queueEvidence.queuedRequest === 'object' ? queueEvidence.queuedRequest : {};
  if (String(queuedRequest.requestId || '') !== String(request.requestId || '')
    || String(queueState.requestId || '') !== String(request.requestId || '')) {
    return { error: 'CMGB_FOCUSED_QUEUE_REQUEST: 公式queueのRequest-IDが依頼と一致しません' };
  }
  if (String(queueEvidence.actualInputHash || '') !== requestInputHash) {
    return { error: 'CMGB_FOCUSED_QUEUE_INPUT_HASH: 公式queueのinputHashが依頼と一致しません' };
  }
  if (queueState.leaseGeneration !== resolution.leaseGeneration) {
    return { error: 'CMGB_FOCUSED_QUEUE_LEASE: leaseGeneration が公式queue stateと一致しません' };
  }
  if (cmgbSha256(String(queueState.ownerToken ?? '')) !== String(resolution.ownerTokenSha256 || '')) {
    return { error: 'CMGB_FOCUSED_QUEUE_OWNER: ownerTokenSha256 が公式queue stateと一致しません' };
  }
  const resultPath = String(queueEvidence.resultPath || '');
  let queueResultSha256;
  try {
    queueResultSha256 = createHash('sha256').update(readFileSync(resultPath)).digest('hex');
  } catch (error) {
    return { error: `CMGB_FOCUSED_QUEUE_RESULT_UNREADABLE: result 実bytesを読めません: ${error?.message || error}` };
  }
  if (queueResultSha256 !== String(resolution.queueResultSha256 || '')) {
    return { error: 'CMGB_FOCUSED_QUEUE_RESULT_HASH: result 実bytes SHAがresolutionと一致しません' };
  }
  // --- verified primary receipt の実 hash ---
  if (String(nativePrimaryVerified?.evidenceHash || '') !== String(resolution.primaryReceiptSha256 || '')) {
    return { error: 'CMGB_FOCUSED_PRIMARY_RECEIPT: primaryReceiptSha256 が検証済みreceipt hashと一致しません' };
  }
  if (!nativePrimaryVerified?.sessionIdHash
    || String(nativePrimaryVerified.sessionIdHash) !== String(resolution.primarySessionIdHash || '')) {
    return { error: 'CMGB_FOCUSED_PRIMARY_SESSION: primarySessionIdHash が検証済みreceiptのsessionIdHashと一致しません' };
  }
  // --- request pin / verified の版照合 ---
  const deepseekSide = nativeDualSideObject(nativeDualSide(round)?.deepseek);
  const requestHead = String(request?.reviewHeadCommit || '');
  const requestScopeHash = String(request?.nativeReview?.scopeHash || '');
  if (!requestHead
    || String(resolution.reviewHeadCommit || '') !== requestHead
    || String(deepseekSide?.reviewHeadCommit || '') !== requestHead
    || String(nativePrimaryVerified?.reviewHeadCommit || '') !== requestHead) {
    return { error: 'CMGB_FOCUSED_RESOLUTION_HEAD: reviewHeadCommit が依頼・検証済み一次結果と一致しません' };
  }
  if (!requestScopeHash
    || String(resolution.scopeHash || '') !== requestScopeHash
    || String(deepseekSide?.changedScopeHash || '') !== requestScopeHash
    || String(nativePrimaryVerified?.changedScopeHash || '') !== requestScopeHash) {
    return { error: 'CMGB_FOCUSED_RESOLUTION_SCOPE: scopeHash が依頼・検証済み一次結果と一致しません' };
  }
  if (!String(deepseekSide?.approvalHash || '')
    || String(resolution.approvalHash || '') !== String(deepseekSide.approvalHash)
    || String(nativePrimaryVerified?.approvalHash || '') !== String(deepseekSide.approvalHash)) {
    return { error: 'CMGB_FOCUSED_RESOLUTION_APPROVAL: approvalHash が検証済み一次結果と一致しません' };
  }
  const binding = {
    taskId: String(task?.taskId || ''),
    taskFingerprint: String(task?.taskFingerprint || ''),
    reviewBaseCommit: String(nativePrimaryVerified?.reviewBaseCommit ?? request?.reviewBaseCommit ?? '') || null,
    reviewHeadCommit: requestHead,
    approvalHash: String(deepseekSide.approvalHash),
    scopeHash: requestScopeHash,
    scopeManifestHash: String(nativePrimaryVerified?.scopeManifestHash ?? '') || null,
    manifestHash: String(nativePrimaryVerified?.manifestHash ?? '') || null,
  };
  const batchKey = cmgbFocusedBatchKey(binding);
  if (String(resolution.batchKey || '') !== batchKey) {
    return { error: 'CMGB_FOCUSED_RESOLUTION_BATCH: batchKey が正規化hashと一致しません' };
  }
  // --- 対象key集合は request 側固定一覧・hashと再突合。上限超過は明示拒否 ---
  const descriptors = cmgbFocusedDescriptors(state, pendingLens);
  if (descriptors.length > CMGB_NATIVE_FOCUSED_TARGET_LIMIT) {
    return { error: `CMGB_FOCUSED_TARGET_LIMIT: 対象keyが上限 ${CMGB_NATIVE_FOCUSED_TARGET_LIMIT} を超えています` };
  }
  const expectedKeys = descriptors.map((descriptor) => descriptor.key).sort();
  const requestTargetsHash = String(request?.nativeFocusedTargetsHash || '');
  if (!requestTargetsHash) {
    return { error: 'CMGB_FOCUSED_TARGETS_HASH_REQUIRED: 依頼に nativeFocusedTargetsHash がありません' };
  }
  if (cmgbFocusedTargetsHash(descriptors) !== requestTargetsHash) {
    return { error: 'CMGB_FOCUSED_TARGETS_HASH: 対象一覧hashが依頼と一致しません' };
  }
  // 依頼の原文一覧そのものを、公式CORE descriptorとの正規化一致で照合する。宣言hashだけでは
  // 一覧の欠落・非配列や、keyを揃えたまま originalText/evidenceHash/source/lens を差し替えた
  // 改ざんを受理し得る。対象0件でも [] を明示させ、完全一致しなければ state 書込前に拒否する。
  if (!Array.isArray(request.nativeFocusedTargets)) {
    return { error: 'CMGB_FOCUSED_TARGETS_LIST_REQUIRED: 依頼に nativeFocusedTargets 配列がありません（対象0件でも [] を明示）' };
  }
  if (JSON.stringify(cmgbCanonicalJson(request.nativeFocusedTargets)) !== JSON.stringify(cmgbCanonicalJson(descriptors))) {
    return { error: 'CMGB_FOCUSED_TARGETS_LIST: request.nativeFocusedTargets が再計算した対象一覧（key・原文・順序）と一致しません' };
  }
  if (!Array.isArray(resolution.targets)) {
    return { error: 'CMGB_FOCUSED_RESOLUTION_TARGETS: targets 配列が必要です' };
  }
  const suppliedKeys = resolution.targets.map((target) => String(target?.key || ''));
  if (new Set(suppliedKeys).size !== suppliedKeys.length) {
    return { error: 'CMGB_FOCUSED_RESOLUTION_TARGET_DUPLICATE: 対象keyが重複しています' };
  }
  const suppliedSorted = [...suppliedKeys].sort();
  if (suppliedSorted.length !== expectedKeys.length
    || suppliedSorted.some((key, index) => key !== expectedKeys[index])) {
    return { error: 'CMGB_FOCUSED_RESOLUTION_TARGET_MISMATCH: 対象key集合が公式target一覧と一致しません' };
  }
  const resolvedKeys = [];
  const nonblockingKeys = [];
  const openKeys = [];
  for (const target of resolution.targets) {
    const key = String(target?.key || '');
    const deepseekDecision = cmgbNormalizeDecision(target?.deepseek?.decision);
    const opusDecision = cmgbNormalizeDecision(target?.opus?.decision);
    const deepseekEvidence = cmgbFocusedEvidence(target?.deepseek?.evidence);
    const opusEvidence = cmgbFocusedEvidence(target?.opus?.evidence);
    if (!deepseekDecision || !opusDecision || !deepseekEvidence || !opusEvidence
      || deepseekDecision !== opusDecision) {
      openKeys.push(key);
    } else if (deepseekDecision === 'resolved') {
      resolvedKeys.push(key);
    } else if (deepseekDecision === 'nonblocking') {
      // nonblocking は対象成果物・criterion・reachを両側が独立に記した時だけ認める。
      if (!cmgbFocusedNonblockingEvidence(target?.deepseek?.evidence)
        || !cmgbFocusedNonblockingEvidence(target?.opus?.evidence)) {
        openKeys.push(key);
      } else {
        nonblockingKeys.push(key);
      }
    } else {
      openKeys.push(key);
    }
  }
  if (!cmgbFocusedBothClean(round, { descriptors, resolution })) {
    return { accepted: false, reason: 'CMGB_FOCUSED_NOT_CLEAN', summary: '両者cleanではないため観点を閉じません', batchKey };
  }
  if (openKeys.length > 0) {
    return { accepted: false, reason: 'CMGB_FOCUSED_OPEN_KEYS', summary: `未分類またはopenの対象keyが ${openKeys.length} 件残っています`, batchKey };
  }
  // 受理の監査履歴。対象keyごとにdescriptor原文・key・hashと両者の実判定/根拠を、正規queue/result/
  // receiptから組み立てたresolutionとdescriptorから写す。resolvedKeys/nonblockingKeysだけでは原文と
  // 根拠が落ちるため、旧round/resultを上書きせず、この追記で監査履歴として残す。
  const targetHistory = descriptors.map((descriptor) => {
    const target = resolution.targets.find((item) => String(item?.key || '') === descriptor.key) || null;
    return {
      key: descriptor.key,
      kind: descriptor.kind,
      source: descriptor.source,
      lens: descriptor.lens,
      round: descriptor.round,
      originRequestId: descriptor.originRequestId,
      originalText: descriptor.originalText,
      evidenceHash: descriptor.evidenceHash,
      deepseek: {
        decision: cmgbNormalizeDecision(target?.deepseek?.decision),
        evidence: oneLine(redactFindingSummary(target?.deepseek?.evidence), 1200),
      },
      opus: {
        decision: cmgbNormalizeDecision(target?.opus?.decision),
        evidence: oneLine(redactFindingSummary(target?.opus?.evidence), 1200),
      },
    };
  });
  const element = {
    contract: CMGB_NATIVE_FOCUSED_CONTRACT,
    status: 'accepted',
    batchKey,
    lens: pendingLens,
    sourceRound: roundNumber,
    requestId: String(request?.requestId || ''),
    inputHash: requestInputHash,
    acceptedAt,
    binding,
    acceptance: {
      leaseGeneration: resolution.leaseGeneration,
      ownerTokenSha256: String(resolution.ownerTokenSha256 || ''),
      queueResultSha256: String(resolution.queueResultSha256 || ''),
      primaryReceiptSha256: String(resolution.primaryReceiptSha256 || ''),
      primarySessionIdHash: String(resolution.primarySessionIdHash || ''),
    },
    targetKeys: expectedKeys,
    targets: targetHistory,
    resolvedKeys: [...new Set(resolvedKeys)].sort(),
    nonblockingKeys: [...new Set(nonblockingKeys)].sort(),
    openKeys: [],
    result: round,
  };
  return { accepted: true, element, batchKey };
}

// ai-complete の最終ゲート。同batch全対象閉鎖・重要unknown0・両者実証跡が無ければ拒否材料を返す。
export function cmgbFocusedCompletionBlockers(root, task) {
  if (!cmgbNativeFocusedIdentity(task)) return [];
  let state;
  try {
    state = loadReviewRounds(root, task, { persist: false }).state;
  } catch (error) {
    return [`CMGB native focused の完了判定でreview-rounds.jsonを読めません: ${error?.message || error}`];
  }
  if (String(state?.codeReview?.reviewChainVersion || '') !== NATIVE_REVIEW_CHAIN_VERSION) return [];
  const blockers = [];
  const latest = cmgbLatestBatchKey(state);
  const sameBatch = cmgbSameBatchRechecks(state, latest);
  for (const lens of CMGB_NATIVE_FOCUSED_LENS_ORDER) {
    const entry = sameBatch.find((candidate) => candidate.lens === lens);
    if (!entry) blockers.push(`CMGB native focused: ${lens} の同版accepted再確認がありません`);
    else if ((entry.openKeys || []).length > 0) blockers.push(`CMGB native focused: ${lens} にopenな対象keyが残っています`);
  }
  const status = nativeDualReviewStatus(state);
  if (status.blockingCount > 0) {
    blockers.push(`CMGB native focused: 未解決のP0/P1・Opus findingsが ${status.blockingCount} 件残っています`);
  }
  if (status.unknownCount > 0) {
    blockers.push(`CMGB native focused: 重要unknown・未確認が ${status.unknownCount} 件残っています`);
  }
  if (state?.codeReview?.outcome !== 'passed_clean') {
    blockers.push(`CMGB native focused: コードレビューoutcomeがpassed_cleanではありません（${String(state?.codeReview?.outcome || '不明')}）`);
  }
  for (const entry of sameBatch) {
    const dual = nativeDualSide(entry.result);
    if (!nativeDualSideObject(dual?.deepseek) || !nativeDualSideObject(dual?.opus)) {
      blockers.push(`CMGB native focused: ${entry.lens} の両者実証跡(reviewerResults)が揃っていません`);
    }
  }
  return [...new Set(blockers)];
}

if (CODE_REVIEW_LENSES.length !== MAX_CODE_REVIEW_ROUNDS) {
  throw new Error(`CODE_REVIEW_LENSESは${MAX_CODE_REVIEW_ROUNDS}件必要です`);
}

function implementerModel(task) {
  return String(task?.implementer?.model || '').trim().toLowerCase();
}

function implementerEffort(task) {
  return String(task?.implementer?.effort || '').trim().toLowerCase();
}

// DeepSeek一次確認を実際に担当できるDeepSeek Flash highのレーンを新しい連鎖へ入れる。
// 非DeepSeekレーンは従来連鎖を継続する。
// 明示的に native 連鎖(deepseek-native-cli-v1)を宣言したレーンは request-owned scope の
// 別経路なので、direct-API の一次確認/外部集計の対象にしない(review-evidence 側の
// deepseekDirectReviewEligible と同じ条件。片方だけ通る組み合わせを作らない)。
export function deepseekReviewChainEligible(task) {
  const surfaceKind = String(task?.surfaceKind || '').trim();
  return implementerModel(task) === 'deepseek-flash'
    && implementerEffort(task) === 'high'
    && ['non_web', 'web_ui'].includes(surfaceKind)
    && String(task?.reviewChainVersion || '').trim() !== NATIVE_REVIEW_CHAIN_VERSION;
}

const DEEPSEEK_CHAIN_BASELINE_HELPERS = [
  'ai-review-send.mjs',
  'review-evidence.mjs',
  'deepseek-primary-review.mjs',
  'ai-review-lens-lib.mjs',
  'ai-complete.mjs',
  'ai-review-queue-lib.mjs',
  'ai-review-rounds-lib.mjs',
  'ai-review-wait.mjs',
];

// R3(2026-09-19) F3-1: ai-dev-tool に新しい 2 本(review-evidence.mjs / deepseek-primary-review.mjs)が
// 届く前に helper-baseline-refresh.sh が記録する 6 本形(旧 3 本 + send + lens-lib + ai-complete)。
// この変更の配布一覧が作る正規の途中世代なので、記録に載っている分が現物と一致すれば受理し、
// 載っていない 2 本は記録が揃った時点から検査する(旧世代の 3 本だけの基準は従来どおり拒否する)。
const DEEPSEEK_CHAIN_STAGED_HELPERS = [
  'ai-review-send.mjs',
  'ai-review-lens-lib.mjs',
  'ai-complete.mjs',
  'ai-review-queue-lib.mjs',
  'ai-review-rounds-lib.mjs',
  'ai-review-wait.mjs',
];

export function helperBaselineSupportsDeepseekReview(root) {
  if (typeof root !== 'string' || !root.trim()) return false;
  try {
    const baseline = readJson(join(root, '.ai', 'context', 'helper-baseline.json'));
    const hashes = baseline?.helpers;
    if (!hashes || typeof hashes !== 'object') return false;
    const complete = DEEPSEEK_CHAIN_BASELINE_HELPERS.every(
      (name) => typeof hashes[name] === 'string',
    );
    if (!complete && !DEEPSEEK_CHAIN_STAGED_HELPERS.every((name) => typeof hashes[name] === 'string')) {
      return false;
    }
    const required = complete ? [...DEEPSEEK_CHAIN_BASELINE_HELPERS] : [...DEEPSEEK_CHAIN_STAGED_HELPERS];
    const runtimeEvidenceHelper = 'ai-runtime-evidence-lib.mjs';
    const runtimeEvidencePath = join(root, 'scripts', runtimeEvidenceHelper);
    let runtimeEvidenceDeployed = false;
    try {
      lstatSync(runtimeEvidencePath);
      runtimeEvidenceDeployed = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const runtimeEvidenceRecorded = Object.prototype.hasOwnProperty.call(hashes, runtimeEvidenceHelper);
    if (runtimeEvidenceDeployed || runtimeEvidenceRecorded) {
      if (!runtimeEvidenceDeployed || !runtimeEvidenceRecorded) return false;
      required.push(runtimeEvidenceHelper);
    }
    return required.every((name) => {
      const expected = hashes[name];
      if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/u.test(expected)) return false;
      const path = join(root, 'scripts', name);
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) return false;
      const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
      return actual === expected;
    });
  } catch {
    return false;
  }
}

// 明示宣言されたときだけ web_ui をネイティブ連鎖へ入れる。未宣言の web_ui と保存済みstateは
// 従来連鎖のまま。宣言があるのに前提が欠ける場合は、自動で旧方式へ戻さずエラーで止める。
function declaredNativeReviewChain(task) {
  return String(task?.reviewChainVersion || '').trim() === NATIVE_REVIEW_CHAIN_VERSION;
}

export function nativeReviewChainEligible(task) {
  return implementerModel(task) === 'deepseek-flash'
    && implementerEffort(task) === 'high'
    && String(task?.surfaceKind || '').trim() === 'web_ui'
    && typeof task?.implementerSessionId === 'string'
    && task.implementerSessionId.length > 0;
}

export function reviewChainVersionForTask(task, state = null, { root = null } = {}) {
  const saved = String(state?.codeReview?.reviewChainVersion || '').trim();
  if (saved) {
    if (![REVIEW_CHAIN_VERSION, LEGACY_REVIEW_CHAIN_VERSION, NATIVE_REVIEW_CHAIN_VERSION].includes(saved)) {
      throw new Error(`REVIEW_CHAIN_VERSION_INVALID: 保存済みレビュー方式を認識できません: ${saved}`);
    }
    return saved;
  }
  const rounds = Array.isArray(state?.codeReview?.rounds) ? state.codeReview.rounds : [];
  if (rounds.length > 0) return LEGACY_REVIEW_CHAIN_VERSION;
  if (declaredNativeReviewChain(task)) {
    if (!nativeReviewChainEligible(task)) throw new Error('REVIEW_CHAIN_RUNTIME_UNAVAILABLE: web_uiネイティブ連鎖にはDeepSeek Flash highと実装セッションIDの紐付けが必要です');
    if (root && !helperBaselineSupportsDeepseekReview(root)) throw new Error('REVIEW_CHAIN_HELPERS_UNAVAILABLE: 最新の配布helperと起動基準を揃えてください。旧担当方式へ自動で戻しません');
    return NATIVE_REVIEW_CHAIN_VERSION;
  }
  if (!deepseekReviewChainEligible(task)) return LEGACY_REVIEW_CHAIN_VERSION;
  if (root && !helperBaselineSupportsDeepseekReview(root)) throw new Error('REVIEW_CHAIN_HELPERS_UNAVAILABLE: 最新の配布helperと起動基準を揃えてください。旧担当方式へ自動で戻しません');
  return REVIEW_CHAIN_VERSION;
}

export function reviewLensesForTask(task, state = null, { root = null } = {}) {
  const version = reviewChainVersionForTask(task, state, { root });
  if (version === NATIVE_REVIEW_CHAIN_VERSION) {
    if (!nativeReviewChainEligible(task)) {
      throw new Error('REVIEW_CHAIN_RUNTIME_UNAVAILABLE: 保存済みweb_uiネイティブ連鎖に必要なDeepSeek Flash high / web_ui / 実装セッションIDを確認できません');
    }
    if (root && !helperBaselineSupportsDeepseekReview(root)) {
      throw new Error('REVIEW_CHAIN_HELPERS_UNAVAILABLE: 保存済みweb_uiネイティブ連鎖に必要なhelper一式が起動基準と一致しません');
    }
    // 2026-10-13: CMGB native focused は同版で spec→user_path→edge を順に閉じる専用経路。
    // 標準チェーンの2周化とは別枠として3観点を維持する。
    if (usesCmgbNativeFocused(task, version)) {
      return CMGB_NATIVE_FOCUSED_LENS_ORDER.map((key, index) => ({
        round: index + 1,
        primaryReviewer: 'deepseek',
        reviewer: 'opus',
        key,
        focus: NATIVE_CODE_REVIEW_LENSES[index]?.focus || `CMGB native focused: ${key} を同版で閉じる`,
      }));
    }
    return NATIVE_CODE_REVIEW_LENSES;
  }
  if (version === REVIEW_CHAIN_VERSION) {
    if (!deepseekReviewChainEligible(task)) {
      throw new Error('REVIEW_CHAIN_RUNTIME_UNAVAILABLE: 保存済みDeepSeek→Opus方式に必要なDeepSeek Flash high担当を確認できません');
    }
    if (root && !helperBaselineSupportsDeepseekReview(root)) {
      throw new Error('REVIEW_CHAIN_HELPERS_UNAVAILABLE: 保存済みDeepSeek→Opus方式に必要なhelper一式が起動基準と一致しません。旧方式へは自動で戻しません');
    }
    return CODE_REVIEW_LENSES;
  }
  return LEGACY_CODE_REVIEW_LENSES;
}

export function codeReviewReviewerRuntime(lens) {
  if (lens?.reviewer === 'astra') {
    return { model: 'gpt-6-astra', effort: 'high', sandbox: 'read-only' };
  }
  return { model: lens?.reviewer || 'opus', effort: 'high', sandbox: 'read-only' };
}

function unknownBranchFreshness(reason, baseRef = null) {
  return { isFresh: null, behind: null, baseRef, reason, warning: '' };
}

function runGit(root, args) {
  try {
    return spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/**
 * 現在のHEADがローカル基準枝(main、無ければmaster)の内容を含むかを調べる。
 * fetchや作業ツリー変更は行わず、判定不能は例外にせずisFresh=nullで返す。
 */
export function branchFreshness(root, { phase = 'current' } = {}) {
  if (typeof root !== 'string' || !root.trim()) return unknownBranchFreshness('invalid_root');

  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return unknownBranchFreshness('not_git_repository');
  }

  const attached = runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!attached || attached.status !== 0) return unknownBranchFreshness('detached_head');

  let baseRef = null;
  for (const candidate of ['main', 'master']) {
    const found = runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (!found || ![0, 1].includes(found.status)) return unknownBranchFreshness('git_command_failed');
    if (found.status === 0) {
      baseRef = candidate;
      break;
    }
  }
  if (!baseRef) return unknownBranchFreshness('base_branch_not_found');

  const ancestor = runGit(root, ['merge-base', '--is-ancestor', baseRef, 'HEAD']);
  if (!ancestor || ![0, 1].includes(ancestor.status)) {
    return unknownBranchFreshness('git_command_failed', baseRef);
  }
  if (ancestor.status === 0) {
    return { isFresh: true, behind: 0, baseRef, reason: '', warning: '' };
  }

  const counted = runGit(root, ['rev-list', '--count', `HEAD..${baseRef}`]);
  const countText = counted?.stdout?.trim() || '';
  if (counted?.status !== 0 || !/^[1-9]\d*$/u.test(countText)) {
    return unknownBranchFreshness('git_command_failed', baseRef);
  }
  const behind = Number(countText);
  const suffix = phase === 'completion'
    ? 'で完了しました。必要なら、基準の内容を取り込んで再確認してください'
    : phase === 'review'
      ? 'でレビューを開始します。結果を確定する前に、基準の内容を取り込む必要があるか確認してください'
      : 'です';
  return {
    isFresh: false,
    behind,
    baseRef,
    reason: '',
    warning: `枝が基準(${baseRef})より ${behind} コミット古い状態${suffix}`,
  };
}

export function codeReviewLensFor(roundNumber, task = null, state = null) {
  const lenses = task ? reviewLensesForTask(task, state) : CODE_REVIEW_LENSES;
  return lenses.find((lens) => lens.round === roundNumber) || null;
}

function usesFunctionalDefectReviewPolicy(state) {
  return state?.codeReview?.policy === FUNCTIONAL_DEFECT_REVIEW_POLICY;
}

export function codeReviewMaxRounds(state) {
  if (usesFunctionalDefectReviewPolicy(state)) {
    if (state?.codeReview?.sizingStatus === 'pending') return null;
    return MAX_CODE_REVIEW_ROUNDS;
  }
  // 新方式の印を持たない進行中stateは、sizeClassの有無に応じて従来の上限を維持する。
  if (state?.codeReview?.sizeClass === 'small') return SMALL_CODE_REVIEW_ROUNDS;
  if (state?.codeReview?.sizeClass === 'large') return LEGACY_LARGE_CODE_REVIEW_ROUNDS;
  return LEGACY_CODE_REVIEW_ROUNDS;
}

function latestLensVerdicts(rounds) {
  const latest = new Map();
  for (const [index, round] of rounds.entries()) {
    if (round?.lens) latest.set(round.lens, { verdict: round.verdict, index, round });
  }
  return latest;
}

export function unresolvedCodeReviewLenses(state) {
  if (usesFunctionalDefectReviewPolicy(state)) {
    return CODE_REVIEW_LENSES.filter((lens) => (
      state.codeReview.rounds?.find((round) => round.round === lens.round)?.hasFunctionalDefects
    ));
  }
  const maxRounds = codeReviewMaxRounds(state);
  const required = maxRounds === SMALL_CODE_REVIEW_ROUNDS
    ? CODE_REVIEW_LENSES.slice(0, SMALL_CODE_REVIEW_ROUNDS)
    : CODE_REVIEW_LENSES;
  const latest = latestLensVerdicts(state?.codeReview?.rounds || []);
  return required.filter((lens) => latest.get(lens.key)?.verdict === 'findings');
}

export function nextCodeReviewLens(state, lenses = CODE_REVIEW_LENSES) {
  const rounds = state?.codeReview?.rounds || [];
  const roundNumber = rounds.length + 1;
  if (usesFunctionalDefectReviewPolicy(state)) {
    return lenses[roundNumber - 1] || null;
  }
  if (roundNumber <= lenses.length) return lenses[roundNumber - 1] || null;
  return lenses[(roundNumber - 1) % lenses.length] || null;
}

function missingPrimaryReviewRecord(round) {
  return round?.primaryReviewer === 'deepseek' && round?.primaryReview?.status !== 'completed';
}

export function reviewHandoffSummary(state) {
  const rounds = Array.isArray(state?.codeReview?.rounds) ? state.codeReview.rounds : [];
  if (rounds.length === 0) {
    return [
      '- 前回の指摘: なし（1往復目）',
      '- 対応状況: 新規確認',
      '- 検証結果: まだありません',
      '- 未確認事項: なし',
    ].join('\n');
  }
  const summaries = rounds.map((round) => {
    const finding = round.hasFunctionalDefects
      ? round.remainingDefects || round.findingSummary || round.note || '機能の不具合あり'
      : round.verdict === 'findings'
        ? round.findingSummary || round.note || '機能外の候補のみ'
        : '機能の不具合なし';
    const status = round.hasFunctionalDefects ? '修正後の再確認待ち' : '確認済み';
    const verification = round.verificationSummary || `判定 ${round.verdict || '不明'}`;
    const unverifiedItems = [
      ...(Array.isArray(round.unverified) ? round.unverified : []),
      ...(missingPrimaryReviewRecord(round) ? ['DeepSeek一次確認の同一対象版記録なし'] : []),
    ];
    const unverified = unverifiedItems.length > 0 ? unverifiedItems.join(' / ') : 'なし';
    const reviewerFlow = missingPrimaryReviewRecord(round)
      ? `${round.primaryReviewer}(記録なし)→${round.reviewer || '独立担当不明'}`
      : `${round.primaryReviewer || '一次担当なし'}→${round.reviewer || '独立担当不明'}`;
    return [
      `- R${round.round} ${round.lens || '観点不明'} / ${reviewerFlow}`,
      `  - 前回の指摘: ${finding}`,
      `  - 対応状況: ${status}`,
      `  - 検証結果: ${verification}`,
      `  - 未確認事項: ${unverified}`,
    ].join('\n');
  });
  if (state?.codeReview?.focusedRecheck?.status === 'pending') {
    summaries.push([
      '- R3 focused recheck / opus',
      `  - 前回の指摘: ${state.codeReview.focusedRecheck.summary || 'R3の機能不具合'}`,
      '  - 対応状況: 実装者修正後の限定再確認待ち',
      '  - 検証結果: 指摘箇所と影響範囲だけを再確認する',
      '  - 未確認事項: 再確認未実施',
    ].join('\n'));
  }
  return summaries.join('\n');
}

// 2026-09-28 (native dual-review acceptance): native rounds keep both reviewers' independent
// results under round.reviewerResults. A clean round needs DeepSeek AND Opus to pass with no
// P0/P1 finding and no important unknown. A DeepSeek P0/P1 from an earlier round stays unresolved
// across the remaining rounds: a later ordinary round's Opus pass never clears it, and only an
// accepted focused recheck of the same lens that itself comes back clean does. P2/P3 findings stay
// recorded and never block a clean outcome.
const NATIVE_DUAL_PASS_VERDICTS = ['pass', 'ok'];
function nativeDualSide(round) {
  return round?.reviewerResults && typeof round.reviewerResults === 'object' ? round.reviewerResults : null;
}
function nativeDualSideObject(value) {
  return value && typeof value === 'object' ? value : null;
}
function nativeDualPassed(side) {
  return NATIVE_DUAL_PASS_VERDICTS.includes(String(side?.verdict || '').trim());
}
function nativeDualCleanSide(side) {
  if (!side) return false;
  const findings = Array.isArray(side.findings) ? side.findings : [];
  const unknowns = [
    ...(Array.isArray(side.importantUnknowns) ? side.importantUnknowns : []),
    ...(Array.isArray(side.unverified) ? side.unverified : []),
  ];
  return nativeDualPassed(side) && findings.length === 0 && unknowns.length === 0;
}
export function nativeRoundOutstandingUnverified(round) {
  const dual = nativeDualSide(round);
  if (!dual) return [];
  const deepseek = nativeDualSideObject(dual.deepseek);
  if (!deepseek) return [`DeepSeek一次結果が記録されていません(round ${round.round ?? '?'})`];
  const items = [
    ...(Array.isArray(deepseek.importantUnknowns) ? deepseek.importantUnknowns : []).map((item) => `DeepSeek重要unknown: ${oneLine(item, 480)}`),
    ...(Array.isArray(deepseek.unverified) ? deepseek.unverified : []).map((item) => `DeepSeek未確認: ${oneLine(item, 480)}`),
  ];
  return items.filter((item) => !/^(?:DeepSeek重要unknown|DeepSeek未確認): $/u.test(item));
}
// The only thing that clears a prior native P0/P1 is an accepted focused recheck of the same lens
// that re-ran both reviewers and came back clean; a later ordinary round's Opus pass never does.
function nativeRecheckResolution(state) {
  const recheck = state?.codeReview?.focusedRecheck;
  if (recheck?.status !== 'accepted' || !recheck.result || recheck.result.recheck !== 1) return null;
  const dual = nativeDualSide(recheck.result);
  if (!dual || !nativeDualCleanSide(nativeDualSideObject(dual.deepseek)) || !nativeDualCleanSide(nativeDualSideObject(dual.opus))) return null;
  return {
    lens: recheck.lens ?? recheck.result.lens ?? null,
    throughRound: recheck.sourceRound ?? recheck.result.round ?? null,
  };
}
export function nativeDualReviewStatus(state) {
  if (isCmgbNativeFocusedState(state)) return cmgbNativeDualStatus(state);
  const rounds = Array.isArray(state?.codeReview?.rounds) ? state.codeReview.rounds : [];
  const focused = state?.codeReview?.focusedRecheck?.status === 'accepted' ? state.codeReview.focusedRecheck.result : null;
  const records = [...rounds, focused].filter((round) => round && nativeDualSide(round));
  const blocking = [];
  const unknowns = [];
  for (const round of records) {
    const dual = nativeDualSide(round);
    const deepseek = nativeDualSideObject(dual.deepseek);
    const opus = nativeDualSideObject(dual.opus);
    if (deepseek) {
      for (const finding of Array.isArray(deepseek.findings) ? deepseek.findings : []) {
        const severity = String(finding?.severity || '').trim().toUpperCase();
        if (severity === 'P0' || severity === 'P1') {
          blocking.push({
            source: 'deepseek',
            round: round.round ?? null,
            lens: round.lens ?? null,
            severity,
            summary: oneLine(finding?.summary || finding?.evidence || '', 300),
          });
        }
        // P2/P3 stay in reviewerResults as records and never block a clean round.
      }
    }
    if (opus && !nativeDualPassed(opus)) {
      blocking.push({
        source: 'opus',
        round: round.round ?? null,
        lens: round.lens ?? null,
        severity: '',
        summary: oneLine(opus.findingsText, 300),
      });
    }
    unknowns.push(...nativeRoundOutstandingUnverified(round));
  }
  const resolution = nativeRecheckResolution(state);
  const unresolved = blocking.filter((item) => !(
    resolution
    && item.lens === resolution.lens
    && (item.round === null || resolution.throughRound === null || item.round <= resolution.throughRound)
  ));
  const dedupedUnknowns = [...new Set(unknowns.map((item) => oneLine(item, 500)).filter(Boolean))].slice(0, 50);
  return {
    blocking: unresolved,
    blockingCount: unresolved.length,
    unknowns: dedupedUnknowns,
    unknownCount: dedupedUnknowns.length,
    rounds: records.length,
  };
}

export function outstandingCodeReviewUnverified(state) {
  if (isCmgbNativeFocusedState(state)) {
    const resolved = cmgbResolvedKeySet(state, cmgbLatestBatchKey(state));
    const items = [];
    for (const descriptor of cmgbAllFocusedDescriptors(state)) {
      if (resolved.has(descriptor.key)) continue;
      if (descriptor.kind === 'important_unknown' || descriptor.kind === 'unverified') {
        items.push(`${descriptor.source} ${descriptor.kind}: ${oneLine(descriptor.originalText, 500)}`);
      }
    }
    return cmgbVisibleList([...new Set(items)], 50, 'CMGB_UNVERIFIED_OVERFLOW');
  }
  const rounds = Array.isArray(state?.codeReview?.rounds) ? state.codeReview.rounds : [];
  const focusedResult = state?.codeReview?.focusedRecheck?.status === 'accepted'
    ? state.codeReview.focusedRecheck.result
    : null;
  return [...new Set(
    [...rounds, focusedResult]
      .filter(Boolean)
      .flatMap((round) => [
        ...(Array.isArray(round.unverified) ? round.unverified : []),
        ...nativeRoundOutstandingUnverified(round),
        ...(missingPrimaryReviewRecord(round) ? ['DeepSeek一次確認の同一対象版記録なし'] : []),
      ])
      .map((item) => oneLine(item, 500))
      .filter(Boolean),
  )].slice(0, 50);
}

export function inferReviewVerdictHint(text) {
  const value = String(text || '');
  const hasPositive = /レビューOK/u.test(value);
  const hasNegation = /レビューOK(?:には|に|では|じゃ)(?:できません|しません|ない|ありません)/u.test(value);
  const hasFindingsHeading = /^#{1,6}\s*(?:指摘|問題|findings|重要度)/imu.test(value);
  return hasPositive && !hasNegation && !hasFindingsHeading ? 'ok' : 'findings';
}

const REVIEW_REPLY_HEADERS = [
  ['Project', 'project'],
  ['Repo', 'repo'],
  ['Branch', 'branch'],
  ['Task', 'task'],
  ['Team', 'team'],
  ['Request-ID', 'requestId'],
];
const FUNCTIONAL_FINDING_KINDS = new Set([
  'spec', 'user_path', 'data_loss', 'regression', 'irreversible',
]);
const REVIEW_FINDING_KINDS = new Set([...FUNCTIONAL_FINDING_KINDS, 'other']);

export function parseReviewReplyVerdict(body, request, {
  requiredVerdict = '',
  overrideVerdict = '',
  allowNumberedFindingKinds = false,
  requireFindingKinds,
  requireFinalReport = false,
} = {}) {
  const diagnostic = (value, max = 160) => String(value || '')
    .replace(/[\u0000-\u001F\u007F]/gu, '?')
    .slice(0, max);
  const lines = String(body || '').replace(/\r\n?/gu, '\n').split('\n');
  const matchedHeaderFields = new Set();
  let foundMatchingHeaders = false;
  let fenceMarker = '';
  const failures = [];
  const verdicts = [];
  const findingKinds = [];
  const visibleAfterHeaders = [];
  let unclassifiedFindingCount = 0;

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fenceMarker) fenceMarker = marker;
      else if (
        fenceMarker[0] === marker[0]
        && marker.length >= fenceMarker.length
        && !line.slice(fenceMatch.index + fenceMatch[0].length).trim()
      ) fenceMarker = '';
      continue;
    }
    if (fenceMarker) continue;
    for (const [label, field] of REVIEW_REPLY_HEADERS) {
      const match = line.match(new RegExp(`^\\s*${label}\\s*:\\s*(.*)$`, 'iu'));
      if (match && match[1].trim() === String(request?.[field] ?? '')) matchedHeaderFields.add(field);
    }
    if (matchedHeaderFields.size === REVIEW_REPLY_HEADERS.length) foundMatchingHeaders = true;
    if (!foundMatchingHeaders) continue;
    visibleAfterHeaders.push(line);
    const findingKindLine = line.match(
      /^\s*(?:(?:\d+\.\s+)|(?:#{1,6}|[-*+])\s+)?(?:\*\*)?Finding-Kind(?:\*\*)?\s*:\s*(.*)$/iu,
    );
    // 連番ラベル(`1. Finding-Kind: spec`)は native chain の queue 受領だけが認める。
    // 他の経路では分類行として扱わず、番号なし・bullet の既存判定を変えない。
    if (findingKindLine && !allowNumberedFindingKinds
      && /^\s*\d+\.\s+/u.test(line)) continue;
    if (findingKindLine) {
      const rawFindingKind = findingKindLine[1].trim();
      const findingKindMatch = rawFindingKind.match(
        /^([a-z_]+(?:-[a-z_]+)*)(?:\s+(?=\S).+|\s*[-—:：。（(【\[].*)?\s*$/iu,
      );
      if (!findingKindMatch) {
        if (overrideVerdict === 'findings') unclassifiedFindingCount += 1;
        else failures.push(`Finding-Kind: の値 '${diagnostic(rawFindingKind)}' は想定外です`);
        continue;
      }
      const kind = findingKindMatch[1].toLowerCase().replaceAll('-', '_');
      if (REVIEW_FINDING_KINDS.has(kind)) findingKinds.push(kind);
      else if (overrideVerdict === 'findings') unclassifiedFindingCount += 1;
      else failures.push(`Finding-Kind: の値 '${diagnostic(rawFindingKind)}' は想定外です`);
      continue;
    }
    const verdictMatch = line.match(
      /^\s*(?:(?:#{1,6}|[-*+])\s+)?(?:\*\*)?Verdict(?:\*\*)?\s*:\s*(.*)$/iu,
    );
    if (!verdictMatch) continue;
    const valueMatch = verdictMatch[1].match(
      /^(ok|findings)(?:\s+(?=\S).+|\s*[-—:：。,.、（(【\[].*)?\s*$/iu,
    );
    if (!valueMatch) {
      failures.push(`Verdict: の値 '${diagnostic(verdictMatch[1].trim())}' は想定外です`);
      continue;
    }
    verdicts.push(valueMatch[1].toLowerCase());
  }

  const uniqueVerdicts = [...new Set(verdicts)];
  if (uniqueVerdicts.length > 1) failures.push('Verdict: 行が複数あり、値が一致しません');
  const parsedVerdict = uniqueVerdicts.length === 1 ? uniqueVerdicts[0] : '';
  if (overrideVerdict && !['ok', 'findings'].includes(overrideVerdict)) {
    failures.push(`上書きする Verdict: ${diagnostic(overrideVerdict)} は想定外です`);
  }
  if (requiredVerdict && parsedVerdict && parsedVerdict !== requiredVerdict) {
    failures.push(`返信本文の Verdict: ${parsedVerdict} は採用する判定 ${requiredVerdict} と一致しません`);
  }
  const verdict = ['ok', 'findings'].includes(overrideVerdict) ? overrideVerdict : parsedVerdict;
  const findingKindsRequired = requireFindingKinds === undefined
    ? request?.lens === COMPREHENSIVE_CODE_REVIEW_LENS.key
    : requireFindingKinds === true;
  if (findingKindsRequired && verdict === 'findings' && findingKinds.length === 0) {
    failures.push('Verdict: findings には指摘ごとの Finding-Kind: が必要です');
  }
  const finalSections = new Map([
    ['残存不具合', []],
    ['未確認事項', []],
    ['検証結果', []],
  ]);
  const seenFinalSections = new Set();
  let activeFinalSection = '';
  for (const line of visibleAfterHeaders) {
    const heading = line.match(/^\s*#{2,6}\s*(残存不具合|未確認事項|検証結果)\s*$/u);
    if (heading) {
      activeFinalSection = heading[1];
      seenFinalSections.add(activeFinalSection);
      continue;
    }
    if (/^\s*#{1,6}\s+/u.test(line)) {
      activeFinalSection = '';
      continue;
    }
    if (activeFinalSection && line.trim()) finalSections.get(activeFinalSection).push(line.trim());
  }
  const missingFinalSections = requireFinalReport
    ? [...finalSections.keys()].filter((label) => !seenFinalSections.has(label))
    : [];
  const sectionValue = (label, max = 1200) => oneLine(
    finalSections.get(label).join(' ').replace(/^(?:[-*+]\s*)+/gu, ''),
    max,
  );
  const unverifiedText = sectionValue('未確認事項');
  const unverified = !unverifiedText || /^(?:なし|該当なし|none)(?:[。.]|$)/iu.test(unverifiedText)
    ? []
    : [unverifiedText];
  if (missingFinalSections.length > 0) {
    unverified.push(`返信に必須欄がありません: ${missingFinalSections.join(' / ')}`);
  }
  if (verdict && failures.length === 0) {
    return {
      verdict,
      findingKinds: verdict === 'ok' ? [] : findingKinds,
      functionalDefectCount: verdict === 'ok'
        ? 0
        : findingKinds.length > 0 || unclassifiedFindingCount > 0
          ? findingKinds.filter((kind) => FUNCTIONAL_FINDING_KINDS.has(kind)).length
            + unclassifiedFindingCount
          : null,
      remainingDefects: sectionValue('残存不具合'),
      unverified,
      verificationSummary: sectionValue('検証結果'),
      error: '',
    };
  }
  return {
    verdict: '',
    findingKinds: [],
    functionalDefectCount: null,
    remainingDefects: '',
    unverified: [],
    verificationSummary: '',
    error: !foundMatchingHeaders
      ? '一致する6行ヘッダーを読み取れません'
      : failures[0] || '一致する6行ヘッダーより後に Verdict: 行がありません',
  };
}

export function taskIdentity(task) {
  const taskId = safeId(task?.taskId, 'taskId');
  const taskFingerprint = String(task?.taskFingerprint || '').trim();
  if (!taskFingerprint || /[\r\n]/u.test(taskFingerprint)) {
    throw new Error('taskFingerprintが空または不正です');
  }
  return { taskId, taskFingerprint };
}

function oneLine(value, max = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

function redactFindingSummary(value) {
  return redactReviewText(value).replace(/\S+/gu, (token) => {
    const withoutAssignment = token.includes('=') ? token.slice(token.lastIndexOf('=') + 1) : token;
    const candidate = withoutAssignment.replace(/^[\[({<'"`]+|[\])}>'"`,;:!?。、「」]+$/gu, '');
    return candidate && isSecretPath(candidate) ? '[REDACTED_PATH]' : token;
  });
}

// レビュー依頼書の「実行した検証」欄を、機械が集めた実測結果から組み立てる。
//
// なぜ雛形文をやめるか（この節を消さない）:
// 雛形のまま送ると査読側は「実行結果が提示されていない」で不通過にする。
// 実装者が送信の直前だけ手で書き換える回避策は、次のセッションで必ず元へ戻り、
// 同じ指摘が再発した（2026-08-09 IG8査読）。担当者が何もしなくても実測が載る形にする。
const MAX_VERIFICATION_NOTE_CHARS = 4000;

// testCommandHintは呼び出し側がaiCmd()で組み立てて渡す（配布先でrunnerが違うため、ここで固定しない）。
export function buildVerificationSection(root, task, { currentHead = null, testCommandHint = '' } = {}) {
  const parts = [];
  let taskId = null;
  try {
    taskId = taskIdentity(task).taskId;
  } catch {
    taskId = null;
  }

  if (taskId) {
    const testRunPath = join(root, '.ai', 'e2e', `test-run-${taskId}.json`);
    if (existsSync(testRunPath)) {
      let result = null;
      try {
        result = JSON.parse(readFileSync(testRunPath, 'utf8'));
      } catch (error) {
        parts.push(`- テスト実行結果 \`.ai/e2e/test-run-${taskId}.json\` を読めませんでした: ${error.message}`);
      }
      if (result) {
        const counts = result.counts ?? {};
        const normalizedCurrentHead = String(currentHead ?? '').trim();
        const normalizedResultGitHead = String(result.gitHead ?? '').trim();
        const lines = [
          `- テスト: \`${result.command ?? '(コマンド不明)'}\``,
          `  - 判定: **${result.status ?? '不明'}**（実行${counts.total ?? '?'} / 成功${counts.pass ?? '?'} / 失敗${counts.fail ?? '?'} / skip${counts.skipped ?? '?'} / 打ち切り${counts.cancelled ?? '?'}）`,
          `  - 実行時刻: ${result.finishedAt ?? '不明'} / 対象コミット: ${normalizedResultGitHead || '不明'}`,
          `  - 証跡: \`.ai/e2e/test-run-${taskId}.json\` / 生ログ \`${result.rawLogPath ?? '不明'}\``,
        ];
        if (normalizedCurrentHead && normalizedResultGitHead && normalizedCurrentHead !== normalizedResultGitHead) {
          lines.push(`  - ⚠ この結果は現在のHEAD(${normalizedCurrentHead})とは別のコミットで取得したものです。再実行が必要です。`);
        }
        if (result.blocker?.reason) lines.push(`  - ⚠ 取得できなかった理由: ${result.blocker.reason}`);
        parts.push(lines.join('\n'));
      }
    }
  }

  const notePath = join(root, '.ai', 'context', 'review-verification.md');
  if (existsSync(notePath)) {
    const body = readFileSync(notePath, 'utf8').trim();
    if (body) {
      const truncated = body.length > MAX_VERIFICATION_NOTE_CHARS;
      parts.push(
        `- 実装者による追記（出典: \`.ai/context/review-verification.md\`）:\n\n${
          truncated ? `${body.slice(0, MAX_VERIFICATION_NOTE_CHARS)}\n（長いため切り詰めています）` : body
        }`,
      );
    }
  }

  if (parts.length) return parts.join('\n');
  return [
    `- ⚠ 実測結果がまだありません。${testCommandHint ? `\`${testCommandHint}\`` : 'このプロジェクトのテスト実行コマンド'} を実行するか、`,
    '`.ai/context/review-verification.md` に実施した検証と結果を書いてから再送してください。',
    '\n  （このまま送るとレビュアーは実行結果を確認できません）',
  ].join('');
}

export function reviewRoundsPath(root) {
  return resolveRepoPath(root, '.ai/context/review-rounds.json', 'review-rounds.json');
}

export function loadReviewRequest(root, task) {
  const contextDir = join(root, '.ai', 'context');
  const statePath = join(contextDir, 'review-request.json');
  const markdownPath = join(contextDir, 'review-request.md');
  if (!existsSync(statePath)) return { request: null, staleDiscarded: false };
  return withReviewRequestLock(root, () => {
    if (!existsSync(statePath)) return { request: null, staleDiscarded: false };
    const expected = taskIdentity(task);
    ensureRegularFile(statePath, 'review-request.json');
    const request = readJson(statePath);
    const matches =
      request?.taskId === expected.taskId &&
      request?.taskFingerprint === expected.taskFingerprint;
    if (matches) return { request, staleDiscarded: false };

    // taskIdの無い旧形式も復元しない。誤ったレビュー往復へ混ざる損害は、
    // 依頼を1回作り直す手間より大きいため、安全側で前タスク扱いにする。
    const historyDir = join(contextDir, 'review-request-history');
    if (existsSync(historyDir)) {
      const stat = lstatSync(historyDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('review-request-historyが安全なdirectoryではありません');
      }
    } else {
      mkdirSync(historyDir, { recursive: true, mode: 0o700 });
    }

    let archiveId;
    try {
      archiveId = safeId(request?.requestId, 'Request-ID');
    } catch {
      archiveId = randomUUID();
    }
    const archiveBase = `${archiveId}-${randomUUID()}-stale-task-rollover`;
    const archivedAt = new Date().toISOString();
    writeFileSync(
      join(historyDir, `${archiveBase}.json`),
      `${JSON.stringify({
        ...request,
        archivedAt,
        archiveReason: 'stale-task-rollover',
      }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    if (existsSync(markdownPath)) {
      ensureRegularFile(markdownPath, 'review-request.md');
      copyFileSync(
        markdownPath,
        join(historyDir, `${archiveBase}.md`),
        fsConstants.COPYFILE_EXCL,
      );
      unlinkSync(markdownPath);
    }
    unlinkSync(statePath);
    return { request: null, staleDiscarded: true };
  });
}

// 2026-09-23: pane経路で「実際に起動したレビュアーのモデル」を機械で名指しできるようにする。
// cc-send.sh --start-reviewer が起動に使った明示IDを .ai/context/reviewer-current-request.json の
// actualRuntimeModel へ残す。Request-ID が一致するときだけ返す(別の依頼へ取り違えない)。
// 旧記録(欄が無い)や読めない記録では '' を返し、往復の記録は従来どおり論理名のままにする。
export function reviewerRuntimeEvidence(root, requestId) {
  const empty = {
    model: '',
    source: '',
    evidencePath: '',
    evidenceSha256: '',
    paneId: '',
    sessionIdentity: null,
    executionKind: '',
    unverified: false,
  };
  if (!requestId) return empty;
  const file = join(root, '.ai', 'context', 'review-request.json');
  if (!existsSync(file)) return empty;
  ensureRegularFile(file, 'review-request.json');
  const record = readJson(file);
  if (record?.requestId !== requestId) return empty;
  const marker = record[RUNTIME_EVIDENCE_MARKER_KEY];
  const executionKind = String(record?.replyExecutionKind || '');
  if (marker === 1) {
    if (executionKind === 'watcher_headless') {
      return { ...empty, executionKind, unverified: true };
    }
    if (executionKind !== 'pane') {
      throw new Error(`marker=1 runtime evidence requires replyExecutionKind=pane, got ${executionKind || '(missing)'}`);
    }
    const model = record?.actualRuntimeModel;
    const source = record?.actualRuntimeModelSource;
    const evidencePath = record?.actualRuntimeModelEvidencePath;
    const evidenceSha256 = record?.actualRuntimeModelEvidenceSha256;
    const paneId = record?.actualRuntimeModelPaneId;
    const sessionIdentity = record?.actualRuntimeModelSessionIdentity;
    if (typeof model !== 'string' || !/^[a-z0-9.-]{1,80}$/.test(model)) {
      throw new Error('marker=1 pane runtime evidence requires canonical actualRuntimeModel');
    }
    if (source !== 'launch_argv') {
      throw new Error('marker=1 pane runtime evidence requires launch_argv source');
    }
    if (typeof evidencePath !== 'string' || !evidencePath || evidencePath.startsWith('/') || evidencePath.split('/').includes('..')) {
      throw new Error('marker=1 pane runtime evidence requires a safe evidencePath');
    }
    if (typeof evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidenceSha256)) {
      throw new Error('marker=1 pane runtime evidence requires evidenceSha256');
    }
    if (typeof paneId !== 'string' || !paneId.trim()) {
      throw new Error('marker=1 pane runtime evidence requires paneId');
    }
    if (
      !sessionIdentity ||
      typeof sessionIdentity !== 'object' ||
      Array.isArray(sessionIdentity) ||
      sessionIdentity.backend !== 'orca' ||
      sessionIdentity.field !== 'incarnationId' ||
      typeof sessionIdentity.value !== 'string' ||
      !sessionIdentity.value.trim()
    ) {
      throw new Error('marker=1 pane runtime evidence requires Orca incarnationId sessionIdentity');
    }
    try {
      verifyPaneRuntimeEvidence({
        repoRoot: root,
        requestId,
        round: record.round,
        contentHash: record.contentHash,
        reviewHeadCommit: record.reviewHeadCommit,
        evidencePath,
        evidenceSha256,
        expectedPaneId: paneId,
        expectedRuntimeModel: model,
        expectedEffort: record?.reviewerEffort,
      });
    } catch (error) {
      throw new Error(`pane runtime evidence verification failed: ${error.message}`);
    }
    return { model, source, evidencePath, evidenceSha256, paneId, sessionIdentity, executionKind, unverified: false };
  }
  const model = record?.actualRuntimeModel;
  const source = record?.actualRuntimeModelSource;
  const evidencePath = record?.actualRuntimeModelEvidencePath;
  const evidenceSha256 = record?.actualRuntimeModelEvidenceSha256;
  const paneId = record?.actualRuntimeModelPaneId;
  if (typeof model !== 'string' || !/^[a-z0-9.-]{1,80}$/.test(model)) return empty;
  if (!['launch_argv', 'provider_observed'].includes(source)) return empty;
  if (typeof evidencePath !== 'string' || !evidencePath || evidencePath.startsWith('/') || evidencePath.split('/').includes('..')) return empty;
  if (typeof evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidenceSha256)) return empty;
  if (typeof paneId !== 'string' || !paneId.trim()) return empty;
  return { model, source, evidencePath, evidenceSha256, paneId, sessionIdentity: null, executionKind: '', unverified: source === 'provider_observed' };
}

export function reviewerRuntimeModel(root, requestId) {
  return reviewerRuntimeEvidence(root, requestId).model;
}

export function isBrowserReviewRoundEvidencePath(root, taskId, filePath) {
  const id = safeId(taskId, 'taskId');
  return [1, 2, 3].some(
    (round) => filePath === join(root, '.ai', 'e2e', `${id}-browser-round${round}.json`),
  );
}

function normalizeRepoPath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//u, '');
}

function isToolStatePath(path) {
  return path === '.ai' || path.startsWith('.ai/');
}

function validateSharedPathPattern(value, index) {
  if (typeof value !== 'string') throw new Error(`sharedCanonicalPaths[${index}]は文字列が必要です`);
  const pattern = normalizeRepoPath(value).trim();
  if (
    !pattern
    || pattern.startsWith('/')
    || /^[A-Za-z]:\//u.test(pattern)
    || /[\u0000-\u001f\u007f]/u.test(pattern)
  ) {
    throw new Error(`sharedCanonicalPaths[${index}]が空またはrepo外pathです`);
  }
  const parts = pattern.split('/');
  if (parts.some((part) => part === '..' || part === '.')) {
    throw new Error(`sharedCanonicalPaths[${index}]に相対移動は使えません`);
  }
  if ([...pattern.matchAll(/\*/gu)].length > 1 || pattern.includes('**')) {
    throw new Error(`sharedCanonicalPaths[${index}]の*は1個までです`);
  }
  if (pattern.includes('*') && pattern.endsWith('/')) {
    throw new Error(`sharedCanonicalPaths[${index}]は*と末尾/を同時に使えません`);
  }
  return pattern;
}

function sharedPathPatterns(root) {
  try {
    const path = join(root, REVIEW_SIZE_CONFIG_RELATIVE_PATH);
    try {
      lstatSync(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return { patterns: DEFAULT_SHARED_CANONICAL_PATHS, source: 'default' };
      throw error;
    }
    ensureRegularFile(path, REVIEW_SIZE_CONFIG_RELATIVE_PATH);
    const config = readJson(path);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`${REVIEW_SIZE_CONFIG_RELATIVE_PATH}はobjectが必要です`);
    }
    for (const key of Object.keys(config)) {
      if (key !== 'sharedCanonicalPaths') {
        throw new Error(`${REVIEW_SIZE_CONFIG_RELATIVE_PATH}の未知fieldは使用できません: ${key}`);
      }
    }
    if (!Array.isArray(config.sharedCanonicalPaths) || config.sharedCanonicalPaths.length > 100) {
      throw new Error('sharedCanonicalPathsは100件以内の配列が必要です');
    }
    return {
      patterns: config.sharedCanonicalPaths.map(validateSharedPathPattern),
      source: REVIEW_SIZE_CONFIG_RELATIVE_PATH,
    };
  } catch (error) {
    const invalid = new Error(String(error?.message || error || '変更サイズ設定を読めません'), { cause: error });
    invalid.code = 'REVIEW_SIZE_CONFIG_INVALID';
    throw invalid;
  }
}

function patternMatchesPath(pattern, path) {
  if (pattern.endsWith('/')) return path.startsWith(pattern);
  if (!pattern.includes('*')) return path === pattern;
  const [prefix, suffix] = pattern.split('*');
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false;
  return !path.slice(prefix.length, path.length - suffix.length).includes('/');
}

function gitBuffer(root, args, label) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  });
  // 制限環境ではtimeout後片付けのkillだけがEPERMでも、git本体はstatus=0と完全なstdoutを返す。
  // 成功statusを優先し、実コマンド失敗だけを拒否する。
  if (result.status !== 0) {
    const detail = result.error?.message || Buffer.from(result.stderr || '').toString('utf8').trim();
    throw new Error(`レビュー開始時の変更量を確認できません（${label}${detail ? `: ${detail}` : ''}）`);
  }
  return Buffer.from(result.stdout || '');
}

function gitHasHead(root) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD'], {
    encoding: null,
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status === 0) return true;
  // --verify --quiet は初回commit前だけstatus=1・stderrなしになる。
  if (result.status === 1 && !Buffer.from(result.stderr || '').length) return false;
  const detail = result.error?.message || Buffer.from(result.stderr || '').toString('utf8').trim();
  throw new Error(`レビュー開始時の変更量を確認できません（HEAD確認${detail ? `: ${detail}` : ''}）`);
}

const REVIEW_BASE_CANDIDATES = [
  ['refs/remotes/origin/HEAD', 'origin/HEAD'],
  ['refs/remotes/origin/main', 'origin/main'],
  ['refs/remotes/origin/master', 'origin/master'],
  ['refs/heads/main', 'main'],
  ['refs/heads/master', 'master'],
];

function commitForRef(root, ref) {
  const result = runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const stdout = String(result?.stdout || '').trim();
  const stderr = String(result?.stderr || '').trim();
  if (result?.status === 0 && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(stdout)) return stdout;
  if (result?.status === 1 && !stdout && !stderr) return null;
  const detail = result?.error?.message || stderr || `status=${result?.status ?? 'unknown'}`;
  const error = new Error(`レビュー対象の基準枝を確認できません（${ref}: ${detail}）`);
  error.code = 'REVIEW_BASE_UNRESOLVED';
  throw error;
}

function reviewBaseError(message) {
  const error = new Error(message);
  error.code = 'REVIEW_BASE_UNRESOLVED';
  return error;
}

function declaredReviewBase(root, task) {
  if (!task || typeof task !== 'object') return null;

  const values = [];
  let declarationPath = null;
  try {
    // 宣言は実repoから探し、repo不一致は下の宣言とcurrent-taskの照合でREVIEW_BASE_UNRESOLVEDとして止める。
    // 既定のrepo検証で例外を握りつぶすと、宣言の基点が黙って無視されmerge-baseへ縮むため使わない。
    declarationPath = declarationPathFor(root, task, task.branch, { validateTaskRepo: false });
  } catch {
    // repo/branchを持たないライブラリ単体利用ではcurrent-task側だけを確認する。
  }
  if (declarationPath && existsSync(declarationPath)) {
    try {
      ensureRegularFile(declarationPath, 'レビュー基点を持つ作業宣言');
      const declaration = parseDeclaration(readFileSync(declarationPath, 'utf8'));
      for (const [taskField, declarationField] of [
        ['repo', 'repo'],
        ['branch', 'branch'],
        ['taskId', 'task_id'],
        ['taskFingerprint', 'task_fingerprint'],
      ]) {
        const expected = String(task[taskField] || '').trim();
        const actual = String(declaration[declarationField] || '').trim();
        if (expected && actual && expected !== actual) {
          throw reviewBaseError(`レビュー基点を持つ作業宣言の${declarationField}がcurrent-taskと一致しません`);
        }
      }
      for (const field of ['base_commit', 'base']) {
        if (String(declaration[field] || '').trim()) {
          values.push({ value: declaration[field], label: `作業宣言 ${field}` });
        }
      }
    } catch (error) {
      if (error?.code === 'REVIEW_BASE_UNRESOLVED') throw error;
      throw reviewBaseError(`レビュー基点を持つ作業宣言を確認できません: ${error.message}`);
    }
  }

  for (const field of ['baseCommit', 'base_commit', 'base']) {
    if (String(task[field] || '').trim()) {
      values.push({ value: task[field], label: `current-task ${field}` });
    }
  }
  if (values.length === 0) return null;

  const resolved = values.map(({ value, label }) => {
    const candidate = String(value).trim().split(/\s+/u)[0];
    if (!/^[a-f0-9]{7,64}$/iu.test(candidate)) {
      throw reviewBaseError(`${label}がcommit IDの形式ではありません`);
    }
    const commit = commitForRef(root, candidate);
    if (!commit) throw reviewBaseError(`${label}のcommitがこのリポジトリにありません`);
    return { baseRef: label, baseCommit: commit };
  });
  const commits = new Set(resolved.map(({ baseCommit }) => baseCommit));
  if (commits.size > 1) {
    throw reviewBaseError('作業宣言とcurrent-taskに異なるレビュー基点が記録されています');
  }

  const selected = resolved[0];
  const ancestor = runGit(root, ['merge-base', '--is-ancestor', selected.baseCommit, 'HEAD']);
  if (ancestor?.status === 1) {
    throw reviewBaseError(`${selected.baseRef}のcommitが現在のHEADの祖先ではありません`);
  }
  if (ancestor?.status !== 0) {
    const detail = ancestor?.error?.message || String(ancestor?.stderr || '').trim()
      || `status=${ancestor?.status ?? 'unknown'}`;
    throw reviewBaseError(`${selected.baseRef}とHEADの関係を確認できません: ${detail}`);
  }
  return selected;
}

/**
 * 保存済み変更と未保存変更が共通して使うレビュー基点を決める。
 * remoteの既定枝を優先し、ネットワーク取得やref更新は行わない。
 */
export function resolveReviewDiffScope(root, { task = null } = {}) {
  if (!gitHasHead(root)) {
    return {
      unbornHead: true,
      baseRef: '(empty repository)',
      baseCommit: null,
      headCommit: null,
      baseSource: 'empty',
      committedRangeEmpty: true,
    };
  }

  const headCommit = commitForRef(root, 'HEAD');
  const declaredBase = declaredReviewBase(root, task);
  if (declaredBase) {
    return {
      unbornHead: false,
      ...declaredBase,
      headCommit,
      baseSource: 'declared',
      committedRangeEmpty: declaredBase.baseCommit === headCommit,
    };
  }
  for (const [ref, label] of REVIEW_BASE_CANDIDATES) {
    const candidateCommit = commitForRef(root, ref);
    if (!candidateCommit) continue;
    const merged = runGit(root, ['merge-base', 'HEAD', ref]);
    const baseCommit = String(merged?.stdout || '').trim();
    const stderr = String(merged?.stderr || '').trim();
    if (merged?.status === 1 && !baseCommit) continue;
    if (
      merged?.status !== 0
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(baseCommit)
    ) {
      const detail = merged?.error?.message || stderr || `status=${merged?.status ?? 'unknown'}`;
      const error = new Error(`レビュー対象の分岐点を確認できません（${label}: ${detail}）`);
      error.code = 'REVIEW_BASE_UNRESOLVED';
      throw error;
    }
    return {
      unbornHead: false,
      baseRef: label,
      baseCommit,
      headCommit,
      baseSource: 'merge-base',
      committedRangeEmpty: baseCommit === headCommit,
    };
  }

  const error = new Error(
    'レビュー対象の基点を判別できません。origin/HEAD、origin/main、origin/master、main、masterのいずれかを用意してください',
  );
  error.code = 'REVIEW_BASE_UNRESOLVED';
  throw error;
}

function nulItems(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function untrackedLineCount(root, path) {
  const fullPath = resolveRepoPath(root, path, '未追跡の変更ファイル');
  const stat = lstatSync(fullPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) return null;
  const buffer = readFileSync(fullPath);
  if (buffer.includes(0)) return null;
  if (buffer.length === 0) return 0;
  let lines = 0;
  for (const byte of buffer) if (byte === 10) lines += 1;
  return lines + (buffer.at(-1) === 10 ? 0 : 1);
}

function trackedFileModes(root) {
  const modes = new Map();
  for (const entry of nulItems(gitBuffer(root, ['ls-files', '--stage', '-z', '--'], '追跡中ファイル種別'))) {
    const match = entry.match(/^(\d+)\s+[a-f0-9]+\s+\d+\t([\s\S]+)$/u);
    if (!match) throw new Error('レビュー開始時の追跡ファイル種別がgitの想定形式ではありません');
    const path = normalizeRepoPath(match[2]);
    if (!modes.has(path)) modes.set(path, new Set());
    modes.get(path).add(match[1]);
  }
  return modes;
}

function changedPathIsUnmeasured(root, path, indexModes) {
  if ([...(indexModes.get(path) || [])].some((mode) => !['100644', '100755'].includes(mode))) {
    return true;
  }
  let fullPath;
  try {
    fullPath = resolveRepoPath(root, path, '変更ファイル');
  } catch {
    return true;
  }
  try {
    const stat = lstatSync(fullPath);
    return !stat.isFile() || stat.isSymbolicLink();
  } catch (error) {
    // 削除済みregular fileはnumstatで行数を測れる。その他の読取失敗は安全側へ倒す。
    return error?.code !== 'ENOENT';
  }
}

export function measureReviewSize(root, { measuredAt = new Date().toISOString(), task = null } = {}) {
  const shared = sharedPathPatterns(root);
  const changed = new Map();
  const indexModes = trackedFileModes(root);
  const reviewScope = resolveReviewDiffScope(root, { task });
  const hasHead = !reviewScope.unbornHead;
  let hasUnmeasuredContent = false;
  let excludedToolStateFileCount = 0;
  if (hasHead) {
    for (const entry of nulItems(gitBuffer(
      root,
      ['diff', '--numstat', '--no-renames', '-z', reviewScope.baseCommit, '--'],
      '追跡中ファイル',
    ))) {
      const match = entry.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/u);
      if (!match) throw new Error('レビュー開始時の変更量がgitの想定形式ではありません');
      const path = normalizeRepoPath(match[3]);
      if (isToolStatePath(path)) {
        excludedToolStateFileCount += 1;
        continue;
      }
      const additions = match[1] === '-' ? null : Number(match[1]);
      const deletions = match[2] === '-' ? null : Number(match[2]);
      if (additions === null || deletions === null) hasUnmeasuredContent = true;
      changed.set(path, (additions ?? 0) + (deletions ?? 0));
    }
  } else {
    // 初回commit前は比較元が存在しない。index上の全ファイルを変更対象へ含め、
    // 行数は推測せずlargeへ倒す。レビュー開始を止めず、smallへの誤分類もしない。
    hasUnmeasuredContent = true;
    for (const path of indexModes.keys()) {
      if (isToolStatePath(path)) {
        excludedToolStateFileCount += 1;
        continue;
      }
      changed.set(path, 0);
    }
  }
  for (const rawPath of nulItems(gitBuffer(root, ['ls-files', '--others', '--exclude-standard', '-z'], '未追跡ファイル'))) {
    const path = normalizeRepoPath(rawPath);
    if (isToolStatePath(path)) {
      excludedToolStateFileCount += 1;
      continue;
    }
    let lines = null;
    try {
      lines = untrackedLineCount(root, path);
    } catch {
      lines = null;
    }
    if (lines === null) hasUnmeasuredContent = true;
    changed.set(path, lines ?? 0);
  }
  const allChangedFiles = [...changed.keys()].sort();
  if (allChangedFiles.some((path) => changedPathIsUnmeasured(root, path, indexModes))) {
    hasUnmeasuredContent = true;
  }
  const secretFiles = allChangedFiles.filter(isSecretPath);
  const changedFiles = allChangedFiles.filter((path) => !isSecretPath(path));
  if (secretFiles.length > 0) hasUnmeasuredContent = true;
  const lineCount = changedFiles.reduce((sum, path) => sum + (changed.get(path) || 0), 0);
  const sharedCanonicalFiles = changedFiles.filter((path) =>
    shared.patterns.some((pattern) => patternMatchesPath(pattern, path)));
  const sizeClass = lineCount <= 50
    && changedFiles.length <= 2
    && sharedCanonicalFiles.length === 0
    && !hasUnmeasuredContent
    ? 'small'
    : 'large';
  return {
    sizeClass,
    evidence: {
      measuredAt,
      diffScope: hasHead
        ? `${reviewScope.baseCommit}..${reviewScope.headCommit} + worktree (staged, unstaged, untracked)`
        : 'unborn HEAD worktree (all indexed and untracked, conservative large)',
      baseRef: reviewScope.baseRef,
      baseCommit: reviewScope.baseCommit,
      headCommit: reviewScope.headCommit,
      baseSource: reviewScope.baseSource,
      committedRangeEmpty: reviewScope.committedRangeEmpty,
      unbornHead: !hasHead,
      lineCount,
      fileCount: allChangedFiles.length,
      changedFiles,
      sharedCanonicalFiles,
      sharedCanonicalPatterns: shared.patterns,
      sharedCanonicalConfigSource: shared.source,
      excludedSecretFileCount: secretFiles.length,
      excludedToolStateFileCount,
      hasUnmeasuredContent,
    },
  };
}

function unavailableReviewSize(error, measuredAt = new Date().toISOString()) {
  const measurementWarning = oneLine(
    `レビュー開始時の変更量を測定できなかったため、安全側のlargeとして送信を続けます: ${error?.message || error || '原因不明'}`,
    1200,
  );
  return {
    sizeClass: 'large',
    evidence: {
      measuredAt,
      measurementStatus: 'unavailable',
      measurementWarning,
      diffScope: 'measurement unavailable (conservative large)',
      baseRef: null,
      baseCommit: null,
      headCommit: null,
      unbornHead: null,
      lineCount: null,
      fileCount: null,
      changedFiles: [],
      sharedCanonicalFiles: [],
      sharedCanonicalPatterns: [],
      sharedCanonicalConfigSource: null,
      excludedSecretFileCount: 0,
      excludedToolStateFileCount: 0,
      hasUnmeasuredContent: true,
    },
  };
}

export function createReviewRounds(task, { sizing = null, pendingSizing = false, root = null } = {}) {
  const identity = taskIdentity(task);
  const sizeClass = sizing?.sizeClass;
  if (sizeClass && !['small', 'large'].includes(sizeClass)) throw new Error('sizeClassはsmallまたはlargeが必要です');
  const maxRounds = pendingSizing && !sizeClass
    ? null
    : sizeClass === 'small'
    ? SMALL_CODE_REVIEW_ROUNDS
    : sizeClass === 'large' ? MAX_CODE_REVIEW_ROUNDS : LEGACY_CODE_REVIEW_ROUNDS;
  return {
    schemaVersion: REVIEW_ROUNDS_SCHEMA_VERSION,
    ...identity,
    codeReview: {
      maxRounds,
      ...((pendingSizing || sizeClass) ? { policy: FUNCTIONAL_DEFECT_REVIEW_POLICY } : {}),
      ...((pendingSizing || sizeClass) ? { reviewChainVersion: reviewChainVersionForTask(task, null, { root }) } : {}),
      ...(pendingSizing && !sizeClass ? { sizingStatus: 'pending' } : {}),
      ...(sizeClass ? { sizeClass, sizeEvidence: sizing.evidence } : {}),
      rounds: [],
      outcome: 'in_progress',
      closedReason: null,
    },
    visualQc: {
      maxAttempts: MAX_VISUAL_QC_ATTEMPTS,
      maxPreliminaryChecks: MAX_VISUAL_QC_PRELIMINARY_CHECKS,
      attempts: [],
      preliminaryChecks: [],
      outcome: 'not_started',
      closedReason: null,
    },
    browserReview: {
      maxRounds: MAX_REVIEW_ROUNDS,
      preflight: 'not_run',
      rounds: [],
      outcome: 'not_started',
      closedReason: null,
    },
  };
}

function ensureVisualQcShape(state) {
  if (
    state.visualQc &&
    Array.isArray(state.visualQc.attempts) &&
    typeof state.visualQc.outcome === 'string'
  ) {
    let changed = false;
    if (!Array.isArray(state.visualQc.preliminaryChecks)) {
      state.visualQc.preliminaryChecks = [];
      changed = true;
    }
    if (state.visualQc.maxPreliminaryChecks !== MAX_VISUAL_QC_PRELIMINARY_CHECKS) {
      state.visualQc.maxPreliminaryChecks = MAX_VISUAL_QC_PRELIMINARY_CHECKS;
      changed = true;
    }
    return changed;
  }
  const browserReviewAlreadyStarted =
    ['passed', 'blocked', 'not_applicable'].includes(state.browserReview?.preflight) ||
    state.browserReview?.rounds?.length > 0 ||
    ['in_progress', 'passed_clean', 'passed_max_rounds', 'skipped_blocked', 'not_applicable']
      .includes(state.browserReview?.outcome);
  state.visualQc = {
    maxAttempts: MAX_VISUAL_QC_ATTEMPTS,
    maxPreliminaryChecks: MAX_VISUAL_QC_PRELIMINARY_CHECKS,
    attempts: [],
    preliminaryChecks: [],
    outcome: browserReviewAlreadyStarted ? 'not_applicable' : 'not_started',
    closedReason: browserReviewAlreadyStarted
      ? 'visual QC導入前にブラウザレビュー開始済み'
      : null,
  };
  return true;
}

function ensureCodeReviewShape(state) {
  const expectedMaxRounds = codeReviewMaxRounds(state);
  if (state.codeReview.maxRounds === expectedMaxRounds) return false;
  state.codeReview.maxRounds = expectedMaxRounds;
  return true;
}

function validShape(state) {
  return (
    state &&
    state.schemaVersion === REVIEW_ROUNDS_SCHEMA_VERSION &&
    state.codeReview &&
    Array.isArray(state.codeReview.rounds) &&
    state.browserReview &&
    Array.isArray(state.browserReview.rounds)
  );
}

export function saveReviewRounds(root, state) {
  atomicWriteJson(reviewRoundsPath(root), state);
  return state;
}

export function loadReviewRounds(root, task, { persist = true } = {}) {
  const expected = taskIdentity(task);
  const path = reviewRoundsPath(root);
  let state = null;
  if (existsSync(path)) {
    ensureRegularFile(path, 'review-rounds.json');
    state = readJson(path);
  }
  const matches =
    validShape(state) &&
    state.taskId === expected.taskId &&
    state.taskFingerprint === expected.taskFingerprint;
  if (matches) {
    const visualUpgraded = ensureVisualQcShape(state);
    const codeUpgraded = ensureCodeReviewShape(state);
    const upgraded = visualUpgraded || codeUpgraded;
    if (upgraded && persist) saveReviewRounds(root, state);
    return { state, initialized: false, staleReset: false, path };
  }

  // 状態表示・完了summary・dry-runでは変更量を確定しない。round 1の実送信時に
  // freezeReviewSizeAtFirstSendが測定し、それ以降の往復では固定する。
  // git判定自体ができない旧fixture・非git環境は、従来互換の6往復stateにする。
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  const pendingSizing = inside?.status === 0 && inside.stdout.trim() === 'true';
  const fresh = createReviewRounds(task, { pendingSizing, root });
  if (persist) saveReviewRounds(root, fresh);
  return {
    state: fresh,
    initialized: true,
    staleReset: Boolean(state),
    path,
  };
}

export function freezeReviewSizeAtFirstSend(root, task) {
  const loaded = loadReviewRounds(root, task, { persist: false });
  const state = loaded.state;
  const rounds = state.codeReview.rounds;
  if (rounds.length > 0) return { state, measured: false };

  // round 1送信時に確定済みなら、受理までにcommitや追加編集があっても測り直さない。
  // 旧実装がround 0で早期固定したstateにはsizingStatus自体が無いので、下で再測定できる。
  if (state.codeReview.sizingStatus === 'frozen') return { state, measured: false };

  // 新形式のpending stateと、旧実装がround 0で早期固定してしまったsizeClassだけを
  // 再測定する。sizeClassもpending印も無い既存stateは従来の固定6往復を維持する。
  const shouldMeasure = state.codeReview.sizingStatus === 'pending'
    || (
      state.codeReview.sizingStatus === undefined
      && ['small', 'large'].includes(state.codeReview.sizeClass)
    );
  if (!shouldMeasure) return { state, measured: false };

  let sizing;
  try {
    sizing = measureReviewSize(root, { task });
  } catch (error) {
    // 設定破損は利用者が直す必要があるため従来どおり停止する。git失敗、timeout、
    // 出力量超過、想定外形式など測定系の失敗だけはレビュー全体へ波及させない。
    if (['REVIEW_SIZE_CONFIG_INVALID', 'REVIEW_BASE_UNRESOLVED'].includes(error?.code)) throw error;
    sizing = unavailableReviewSize(error);
  }
  state.codeReview.sizeClass = sizing.sizeClass;
  state.codeReview.sizeEvidence = sizing.evidence;
  state.codeReview.sizingStatus = 'frozen';
  state.codeReview.policy = FUNCTIONAL_DEFECT_REVIEW_POLICY;
  state.codeReview.reviewChainVersion = reviewChainVersionForTask(task, state, { root });
  state.codeReview.maxRounds = sizing.sizeClass === 'small'
    ? SMALL_CODE_REVIEW_ROUNDS
    : MAX_CODE_REVIEW_ROUNDS;
  saveReviewRounds(root, state);
  return { state, measured: true };
}

export function codeReviewClosed(state) {
  return ['passed_clean', 'passed_with_unverified', 'passed_max_rounds']
    .includes(state?.codeReview?.outcome);
}

export function browserReviewApplicable(task) {
  return task?.surfaceKind === 'web_ui';
}

export function visualQcClosed(state) {
  return ['passed_clean', 'findings_warning', 'skipped_warning', 'unavailable_warning', 'not_applicable']
    .includes(state?.visualQc?.outcome);
}

export function detectWebAppTraces(root) {
  if (typeof root !== 'string' || !root.trim()) return [];

  const traces = [];
  const configBases = ['next', 'vite', 'nuxt', 'astro', 'svelte', 'remix'];
  const configExtensions = ['js', 'mjs', 'cjs', 'ts'];
  for (const base of configBases) {
    for (const extension of configExtensions) {
      const name = `${base}.config.${extension}`;
      if (existsSync(join(root, name))) traces.push(name);
    }
  }

  try {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const webDependencies = [
      'next',
      'react-dom',
      'nuxt',
      'vue',
      '@sveltejs/kit',
      'astro',
      '@remix-run/react',
    ];
    for (const section of ['dependencies', 'devDependencies']) {
      const dependencies = packageJson?.[section];
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
      for (const name of webDependencies) {
        if (Object.hasOwn(dependencies, name)) traces.push(`package.json ${section}: ${name}`);
      }
    }
  } catch {
    // package.jsonが無い・壊れていても、設定ファイルからの検出結果は維持する。
  }

  return traces;
}

export function webAppTraceWarning(root, task) {
  if (browserReviewApplicable(task)) return '';
  const webAppTraces = detectWebAppTraces(root);
  if (!webAppTraces.length) return '';

  let surfaceKindStatus;
  if (task?.surfaceKind === 'non_web') {
    surfaceKindStatus = 'surfaceKind=non_web です';
  } else if (task?.surfaceKind === undefined || task?.surfaceKind === null || !String(task.surfaceKind).trim()) {
    surfaceKindStatus = 'surfaceKind が未設定です';
  } else {
    surfaceKindStatus = `surfaceKind=${oneLine(JSON.stringify(String(task.surfaceKind)))} で、web_uiではありません`;
  }
  return `このrepoにはWebアプリの痕跡(${webAppTraces.join(', ')})がありますが ${surfaceKindStatus}。画面に影響する変更なら surfaceKind を web_ui へ直してブラウザレビューを行ってください。画面に影響しない変更なら、完了報告にその旨を1行書いてください。`;
}

// 2026-09-28 (T1-T5 stage 4B): the request-owned acceptance of one native CLI primary review.
// Every pin is read from the official send request (reviewChainVersion/nativeReview/nativeScopeFile/
// round/lens/reviewHeadCommit) and the trusted session root is supplied by the caller, never by the
// receipt. A missing verified evidence module, receipt, pin, or session root fails closed instead of
// silently falling back to the legacy direct-API or full-dirty comparison.
export function verifyNativePrimaryReceipt(root, task, request, { receiptPath = '', sessionRoot = '' } = {}) {
  const chain = String(request?.reviewChainVersion || '').trim();
  if (chain !== NATIVE_REVIEW_CHAIN_VERSION) {
    throw new Error(`NATIVE_PRIMARY_CHAIN_MISMATCH: 依頼のレビュー方式が ${NATIVE_REVIEW_CHAIN_VERSION} ではありません: ${chain || '(未設定)'}`);
  }
  const pin = request?.nativeReview;
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) throw new Error('NATIVE_PRIMARY_PIN_REQUIRED: 依頼にnativeReview pinがありません');
  if (!/^[a-f0-9]{64}$/.test(String(pin.scopeHash || ''))) throw new Error('NATIVE_PRIMARY_PIN_REQUIRED: pin.scopeHashが64桁の16進数ではありません');
  if (!Array.isArray(pin.reviewedPaths) || pin.reviewedPaths.length === 0) throw new Error('NATIVE_PRIMARY_PIN_REQUIRED: pin.reviewedPathsが空です');
  if (!Array.isArray(pin.ignoredPathspecs)) throw new Error('NATIVE_PRIMARY_PIN_REQUIRED: pin.ignoredPathspecsがありません');
  const scopeRel = String(request.nativeScopeFile || '').replaceAll('\\', '/');
  if (!scopeRel || scopeRel.startsWith('/') || /^[A-Za-z]:/.test(scopeRel) || scopeRel.split('/').includes('..')) {
    throw new Error('NATIVE_PRIMARY_SCOPE_FILE_REQUIRED: nativeScopeFileはリポジトリ内の相対pathである必要があります');
  }
  const round = Number.isInteger(request.round) ? request.round : null;
  const lensKey = oneLine(request.lens);
  if (!round || !lensKey) throw new Error('NATIVE_PRIMARY_ROUND_LENS_REQUIRED: 依頼のround/lensがありません');
  if (typeof optionalReviewEvidence?.nativeSessionEvidence !== 'function') {
    throw new Error('NATIVE_PRIMARY_EVIDENCE_UNAVAILABLE: review-evidence.mjs の nativeSessionEvidence が必要です');
  }
  const role = Array.isArray(optionalReviewEvidence.NATIVE_REVIEWER_ROLES)
    ? String(optionalReviewEvidence.NATIVE_REVIEWER_ROLES[0] || '')
    : '';
  if (!role) throw new Error('NATIVE_PRIMARY_EVIDENCE_UNAVAILABLE: レビュー役のrole定義がありません');
  const trustedRoot = String(sessionRoot || '').trim();
  if (!trustedRoot) throw new Error('NATIVE_PRIMARY_SESSION_ROOT_REQUIRED: 信頼済みセッションルートが必要です（receiptからは読みません）');
  const receipt = String(receiptPath || '').trim();
  if (!receipt) throw new Error('NATIVE_PRIMARY_EVIDENCE_REQUIRED: 一次レビューの実証跡JSONが必要です');
  // expectedRequestId/expectedInputHash are the request-owned queue binding. The current
  // nativeSessionEvidence accepts them and ignores them until the binding owner extends the verifier
  // (see the separate H-owner interface note). Passing them here never lets a receipt name its own
  // request, and the caller never reads a request id/hash out of the receipt.
  const verified = optionalReviewEvidence.nativeSessionEvidence(root, receipt, {
    task,
    round,
    lens: lensKey,
    role,
    sessionRoot: trustedRoot,
    current: true,
    expectedScopeHash: String(pin.scopeHash),
    scopeFile: join(root, scopeRel),
    reviewedManifestPaths: pin.reviewedPaths.slice(),
    ignoredPathspecs: pin.ignoredPathspecs.slice(),
    expectedRequestId: String(request.requestId || ''),
    expectedInputHash: String(request.inputHash || ''),
  });
  return assertNativeVerifiedPrimary(verified, request);
}

function assertNativeVerifiedPrimary(verified, request) {
  const pin = request?.nativeReview;
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) throw new Error('NATIVE_PRIMARY_PIN_REQUIRED');
  if (!verified || typeof verified !== 'object') throw new Error('NATIVE_PRIMARY_EVIDENCE_REQUIRED: 検証済み一次レビューがありません');
  if (verified.status !== 'completed') throw new Error('NATIVE_PRIMARY_NOT_COMPLETED');
  if (String(verified.reviewChainVersion || '') !== NATIVE_REVIEW_CHAIN_VERSION) throw new Error('NATIVE_PRIMARY_CHAIN_MISMATCH');
  if (verified.model !== String(pin.primaryModel || '') || verified.effort !== String(pin.primaryEffort || '')) {
    throw new Error(`NATIVE_PRIMARY_MODEL_MISMATCH: 実測 ${verified.model}/${verified.effort} が依頼の ${pin.primaryModel}/${pin.primaryEffort} と一致しません`);
  }
  if (verified.round !== request.round || verified.lens !== oneLine(request.lens)) throw new Error('NATIVE_PRIMARY_ROUND_LENS_MISMATCH');
  if (verified.reviewHeadCommit !== request.reviewHeadCommit) throw new Error('NATIVE_PRIMARY_HEAD_MISMATCH');
  if (verified.changedScopeHash !== String(pin.scopeHash || '')) throw new Error('NATIVE_PRIMARY_SCOPE_HASH_MISMATCH');
  if (!['pass', 'findings'].includes(String(verified.verdict || ''))) throw new Error('NATIVE_PRIMARY_VERDICT_MISSING: 検証済み一次レビューに判定(pass/findings)がありません');
  return verified;
}

export function recordCodeReviewRound(root, task, request, {
  verdict = 'findings',
  verdictWasExplicit = false,
  verdictSource = '',
  note = '',
  autoVerdictHint = 'findings',
  acceptedAt = new Date().toISOString(),
  mode = 'pane',
  workerDurationMs = null,
  attempt = null,
  failureReason = '',
  actualReviewer = '',
  actualRuntimeModel = '',
  actualRuntimeModelSource = '',
  actualRuntimeModelEvidencePath = '',
  actualRuntimeModelEvidenceSha256 = '',
  actualRuntimeModelPaneId = '',
  actualRuntimeModelSessionIdentity = null,
  replyExecutionKind = '',
  inputHash = '',
  leaseGeneration = null,
  ownerToken = '',
  fallbackFrom = '',
  findingSummary = '',
  findingKinds = [],
  functionalDefectCount = null,
  remainingDefects = '',
  unverified = [],
  verificationSummary = '',
  sendParent,
  deferParentNotification = false,
  nativePrimaryEvidence = '',
  nativeSessionRoot = '',
  verifiedNativePrimary = null,
  recheckResolution = null,
} = {}) {
  if (!['ok', 'findings'].includes(verdict)) throw new Error('verdictはokまたはfindingsが必要です');
  if (!['pane', 'queue'].includes(mode)) throw new Error('modeはpaneまたはqueueが必要です');
  const loaded = loadReviewRounds(root, task);
  let state = loaded.state;
  if (
    state.codeReview.rounds.length === 0
    && (state.codeReview.sizingStatus === 'pending' || state.codeReview.sizeClass)
  ) {
    state = freezeReviewSizeAtFirstSend(root, task).state;
  }
  const requestId = safeId(request?.requestId, 'Request-ID');
  const existing = state.codeReview.rounds.find((round) => round.requestId === requestId)
    || (
      state.codeReview.focusedRecheck?.status === 'accepted'
      && state.codeReview.focusedRecheck.result?.requestId === requestId
        ? state.codeReview.focusedRecheck.result
        : null
    )
    || (Array.isArray(state.codeReview.focusedRechecks)
      ? state.codeReview.focusedRechecks.find((entry) => entry?.requestId === requestId)?.result || null
      : null);
  if (existing) {
    if (!deferParentNotification && state.codeReview.parentEscalation?.notification?.status !== 'sent') {
      notifyReviewEscalation(root, task, state, { sendParent });
    }
    return { state, round: existing, duplicate: true };
  }
  const requestMarker = request?.[RUNTIME_EVIDENCE_MARKER_KEY] === 1;
  const normalizedReplyExecutionKind = String(replyExecutionKind || '').trim();
  if (requestMarker) {
    if (!['pane', 'queue'].includes(normalizedReplyExecutionKind)) {
      throw new Error('新marker=1のroundはreplyExecutionKind=pane/queueが必要です');
    }
    if (normalizedReplyExecutionKind !== mode) {
      throw new Error('replyExecutionKindとmodeが一致しません');
    }
    if (typeof actualRuntimeModel !== 'string' || !/^[a-z0-9.-]{1,80}$/.test(actualRuntimeModel)) {
      throw new Error('新marker=1のroundはcanonical actualRuntimeModelが必要です');
    }
    if (actualRuntimeModelSource !== 'launch_argv') {
      throw new Error('新marker=1のroundはactualRuntimeModelSource=launch_argvが必要です');
    }
    if (typeof actualRuntimeModelEvidencePath !== 'string' || !actualRuntimeModelEvidencePath || actualRuntimeModelEvidencePath.startsWith('/') || actualRuntimeModelEvidencePath.split('/').includes('..')) {
      throw new Error('新marker=1のroundは安全なactualRuntimeModelEvidencePathが必要です');
    }
    if (typeof actualRuntimeModelEvidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(actualRuntimeModelEvidenceSha256)) {
      throw new Error('新marker=1のroundはactualRuntimeModelEvidenceSha256が必要です');
    }
    if (mode === 'pane') {
      if (typeof actualRuntimeModelPaneId !== 'string' || !actualRuntimeModelPaneId.trim()) {
        throw new Error('新marker=1 pane roundはactualRuntimeModelPaneIdが必要です');
      }
      if (
        !actualRuntimeModelSessionIdentity ||
        typeof actualRuntimeModelSessionIdentity !== 'object' ||
        Array.isArray(actualRuntimeModelSessionIdentity) ||
        actualRuntimeModelSessionIdentity.backend !== 'orca' ||
        actualRuntimeModelSessionIdentity.field !== 'incarnationId' ||
        typeof actualRuntimeModelSessionIdentity.value !== 'string' ||
        !actualRuntimeModelSessionIdentity.value.trim()
      ) {
        throw new Error('新marker=1 pane roundはOrca incarnationId sessionIdentityが必要です');
      }
    } else {
      if (typeof inputHash !== 'string' || !inputHash) throw new Error('新marker=1 queue roundはinputHashが必要です');
      if (!Number.isInteger(attempt) || attempt < 1) throw new Error('新marker=1 queue roundはattemptが必要です');
      if (!Number.isInteger(leaseGeneration) || leaseGeneration < 1) throw new Error('新marker=1 queue roundはleaseGenerationが必要です');
      if (typeof ownerToken !== 'string' || !ownerToken) throw new Error('新marker=1 queue roundはownerTokenが必要です');
      if (inputHash !== request.inputHash) throw new Error('queue inputHashがrequestと一致しません');
      if (Number.isInteger(request.leaseGeneration) && request.leaseGeneration !== leaseGeneration) throw new Error('queue leaseGenerationがrequestと一致しません');
      if (request.ownerToken && request.ownerToken !== ownerToken) throw new Error('queue ownerTokenがrequestと一致しません');
    }
  } else if (normalizedReplyExecutionKind === 'watcher_headless') {
    throw new Error('watcher_headlessは新規accepted roundを作れません');
  }
  // 2026-10-13: CMGB native focused は同版3観点(spec→user_path→edge)を閉じる専用経路。
  // 標準チェーンの2周化とは別枠なので、閉止判定より前に上限を確定する。
  const earlyChainVersion = reviewChainVersionForTask(task, state, { root });
  const maxRounds = usesCmgbNativeFocused(task, earlyChainVersion)
    ? CMGB_NATIVE_FOCUSED_LENS_ORDER.length
    : codeReviewMaxRounds(state);
  const focusedRecheckPending = usesFunctionalDefectReviewPolicy(state)
    && state.codeReview.focusedRecheck?.status === 'pending';
  if (codeReviewClosed(state) || (state.codeReview.rounds.length >= maxRounds && !focusedRecheckPending)) {
    throw new Error('コードレビューは既に終了しています');
  }

  const roundNumber = focusedRecheckPending ? maxRounds : state.codeReview.rounds.length + 1;
  if (focusedRecheckPending && request?.recheck !== 1) {
    throw new Error('R3修正後はfocused recheck=1の依頼だけを受理します');
  }
  const requestedRound = request?.round;
  if (requestedRound !== undefined && requestedRound !== null) {
    if (!Number.isInteger(requestedRound) || requestedRound !== roundNumber) {
      throw new Error(`送信時のreview round(${requestedRound})が現在のround(${roundNumber})と一致しません`);
    }
  }
  const activeLenses = reviewLensesForTask(task, state, { root });
  const activeReviewChainVersion = reviewChainVersionForTask(task, state, { root });
  const cmgbNativeFocused = usesCmgbNativeFocused(task, activeReviewChainVersion);
  // 2026-10-13: CMGB native focused は同版で spec→user_path→edge の3観点を閉じる専用経路。
  // 標準チェーンの2周化（Sol+DeepSeek→Opus）とは別枠として3観点を維持する。
  const effectiveMaxRounds = maxRounds;
  const requestedLensKey = oneLine(request?.lens);
  const lens = requestedLensKey
    ? [...activeLenses, COMPREHENSIVE_CODE_REVIEW_LENS]
      .find((candidate) => candidate.key === requestedLensKey)
    : nextCodeReviewLens(state, activeLenses);
  if (requestedLensKey && !lens) {
    throw new Error(`送信時のreview lensが不正です: ${requestedLensKey}`);
  }
  if (focusedRecheckPending) {
    // 2026-09-28: 限定再確認は pending に記録した「指摘の元の観点」と同一のlensだけを受理する。
    // 未指定・別観点で記録すると、別観点の結果が元の指摘を消し得るため停止する。
    const pendingRecheckLensKey = oneLine(state.codeReview.focusedRecheck?.lens);
    if (!requestedLensKey) {
      throw new Error(`限定再確認は指摘の観点(${pendingRecheckLensKey || '不明'})を指定して行います`);
    }
    if (!pendingRecheckLensKey || lens?.key !== pendingRecheckLensKey) {
      throw new Error(`限定再確認は指摘の観点(${pendingRecheckLensKey || '不明'})だけで行います: ${lens?.key || requestedLensKey || '(未設定)'}`);
    }
  }
  let primaryReviewRecord = request?.primaryReview || null;
  let nativePrimaryVerified = null;
  const usesNativeReviewChain = activeReviewChainVersion === NATIVE_REVIEW_CHAIN_VERSION;
  // 2026-10-17 (Astra診断): 一次確認の要否はチェーンが宣言する観点集合から導く（観点キーや担当欄に依存しない）。
  const requiresDeepseekPrimary = (Array.isArray(activeLenses) ? activeLenses : [])
    .some((entry) => entry?.primaryReviewer === 'deepseek');
  if (usesNativeReviewChain && requiresDeepseekPrimary) {
    // 2026-09-28 (T1-T5 stage 4B): the native chain re-verifies its primary reviewer from the real
    // Codex JSONL receipt against the live worktree (current:true) and the request-owned
    // review-scope-v1 pin. A self-declared primaryReview, a hand-written .ai/queue artifact, or a
    // receipt from another request/round/lens/scope is never accepted, and there is no fallback.
    const verified = verifiedNativePrimary
      ? assertNativeVerifiedPrimary(verifiedNativePrimary, request)
      : verifyNativePrimaryReceipt(root, task, request, {
          receiptPath: nativePrimaryEvidence,
          sessionRoot: nativeSessionRoot,
        });
    primaryReviewRecord = {
      status: 'completed',
      evidenceType: verified.evidenceType,
      model: verified.model,
      effort: verified.effort,
      round: verified.round,
      lens: verified.lens,
      reviewerRole: verified.reviewerRole,
      reviewBaseCommit: verified.reviewBaseCommit,
      reviewHeadCommit: verified.reviewHeadCommit,
      approvalHash: verified.approvalHash,
      manifestHash: verified.manifestHash,
      changedScopeHash: verified.changedScopeHash,
      scopeHash: verified.scopeHash,
      scopeManifestHash: verified.scopeManifestHash,
      verdict: verified.verdict,
      findings: Array.isArray(verified.findings) ? verified.findings : [],
      unverified: Array.isArray(verified.unverified) ? verified.unverified : [],
      importantUnknowns: Array.isArray(verified.importantUnknowns) ? verified.importantUnknowns : [],
      usage: verified.usage,
      evidencePath: verified.evidencePath,
      evidenceHash: verified.evidenceHash,
    };
    nativePrimaryVerified = verified;
  }
  // 選ばれた観点（comprehensive 等）に担当欄が無くても、既存の証跡照合を迂回させない。
  if (requiresDeepseekPrimary && !usesNativeReviewChain) {
    const primary = request?.primaryReview;
    if (typeof optionalReviewEvidence?.primaryEvidence !== 'function' || !primary?.evidencePath || !primary?.evidenceHash) {
      throw new Error('DeepSeek一次確認の記録が無いか、実API証跡が指定されていません');
    }
    const receiptBytes = readFileSync(primary.evidencePath);
    if (createHash('sha256').update(receiptBytes).digest('hex') !== primary.evidenceHash) throw new Error('DeepSeek証跡が送信後に変更されています');
    // R2 F2-6: 記録時は、送信後に作業場が進んでいても依頼記録へ結び付いた証跡を受理する。
    const verifiedPrimary = optionalReviewEvidence.primaryEvidence(root, primary.evidencePath, {task,round:roundNumber,lens:lens.key,current:false});
    // 2026-10-05: 現在の作業場とは比べない(F2-6 を保つ)。代わりに、証跡そのものが持つ対象版・基点・承認・
    // manifest を、送信時に依頼記録へ固定した値と照合する。evidencePath/evidenceHash だけを別レビューの
    // 証跡へ差し替えた記録を受理しない。これらの値は証跡付き送信(primaryEvidence の戻り値)が必ず記録するため、
    // 欠けた記録は正規の送信によるものではなく、止める側に倒す。
    const pinnedPrimary = [
      ['reviewHeadCommit', request?.reviewHeadCommit],
      ['reviewHeadCommit', primary.reviewHeadCommit],
      ['reviewBaseCommit', request?.reviewBaseCommit],
      ['reviewBaseCommit', primary.reviewBaseCommit],
      ['approvalHash', primary.approvalHash],
      ['manifestHash', primary.manifestHash],
    ];
    const unpinned = pinnedPrimary.find(([key, pinned]) => typeof pinned !== 'string' || !pinned || verifiedPrimary?.[key] !== pinned);
    if (unpinned) {
      throw new Error(`DeepSeek証跡が送信時の依頼記録と一致しません(${unpinned[0]})。別のレビューの証跡は記録しません`);
    }
    const validPrimary = primary?.status === 'completed'
      && ['deepseek-flash','deepseek-v4.1-flash'].includes(primary.model)
      && primary.effort === 'high'
      && primary.round === roundNumber
      && primary.lens === lens.key
      && primary.reviewHeadCommit === request?.reviewHeadCommit
      && typeof primary.contentHash === 'string'
      && primary.contentHash === request?.contentHash;
    if (!validPrimary) {
      throw new Error('DeepSeek一次確認の記録が無いか、レビュー対象版と一致しません');
    }
  }
  const allowedFindingKinds = new Set([
    'spec', 'user_path', 'data_loss', 'regression', 'irreversible', 'other',
  ]);
  const parsedFindingKinds = [...new Set(
    (Array.isArray(findingKinds) ? findingKinds : [])
      .map((kind) => oneLine(kind, 40).toLowerCase())
      .filter(Boolean),
  )];
  if (parsedFindingKinds.some((kind) => !allowedFindingKinds.has(kind))) {
    throw new Error('findingKindsに未対応の分類があります');
  }
  const normalizedFindingKinds = verdict === 'ok' ? [] : parsedFindingKinds;
  const normalizedFunctionalDefectCount = verdict === 'ok'
    ? 0
    : Number.isInteger(functionalDefectCount) && functionalDefectCount >= 0
      ? functionalDefectCount
      : 1;
  const hasFunctionalDefects = verdict === 'findings' && normalizedFunctionalDefectCount > 0;
  const legacyUnverified = !requestMarker && mode === 'pane' && actualRuntimeModelSource === 'provider_observed'
    ? ['legacy_unverified']
    : [];
  const normalizedUnverified = [...new Set([
    ...(Array.isArray(unverified) ? unverified : [])
      .map((item) => oneLine(redactFindingSummary(item), 500))
      .filter(Boolean),
    ...legacyUnverified,
  ])].slice(0, 50);
  const currentPolicy = usesFunctionalDefectReviewPolicy(state);
  state.codeReview.reviewChainVersion = activeReviewChainVersion;
  const round = {
    round: roundNumber,
    lens: lens?.key || null,
    reviewChainVersion: activeReviewChainVersion,
    primaryReviewer: lens?.primaryReviewer || null,
    primaryReview: primaryReviewRecord,
    reviewer: lens?.reviewer || null,
    requestId,
    sentAt: request.sentAt || request.sendAttemptedAt || null,
    acceptedAt,
    mode,
    workerDurationMs: Number.isFinite(workerDurationMs) && workerDurationMs >= 0 ? workerDurationMs : null,
    attempt: Number.isInteger(attempt) && attempt >= 1 ? attempt : null,
    failureReason: oneLine(failureReason),
    actualReviewer: oneLine(actualReviewer),
    actualRuntimeModel: oneLine(actualRuntimeModel),
    actualRuntimeModelSource: ['launch_argv', 'provider_observed'].includes(actualRuntimeModelSource) ? actualRuntimeModelSource : '',
    actualRuntimeModelEvidencePath: oneLine(actualRuntimeModelEvidencePath),
    actualRuntimeModelEvidenceSha256: /^[a-f0-9]{64}$/u.test(String(actualRuntimeModelEvidenceSha256)) ? String(actualRuntimeModelEvidenceSha256) : '',
    actualRuntimeModelPaneId: oneLine(actualRuntimeModelPaneId),
    actualRuntimeModelSessionIdentity: actualRuntimeModelSessionIdentity && typeof actualRuntimeModelSessionIdentity === 'object' ? actualRuntimeModelSessionIdentity : null,
    replyExecutionKind: normalizedReplyExecutionKind,
    fallbackFrom: oneLine(fallbackFrom),
    contentHash: oneLine(request?.contentHash),
    reviewHeadCommit: oneLine(request?.reviewHeadCommit),
    inputHash: oneLine(requestMarker ? inputHash : request?.inputHash),
    leaseGeneration: requestMarker
      ? (Number.isInteger(leaseGeneration) ? leaseGeneration : null)
      : (Number.isInteger(request?.leaseGeneration) ? request.leaseGeneration : null),
    ownerToken: oneLine(requestMarker ? ownerToken : request?.ownerToken),
    ...(request?.[RUNTIME_EVIDENCE_MARKER_KEY] === 1 ? { [RUNTIME_EVIDENCE_MARKER_KEY]: 1 } : {}),
    verdict,
    verdictSource: mode === 'queue'
      ? 'queue_result'
      : ['explicit', 'message_verdict'].includes(verdictSource)
        ? verdictSource
        : verdictWasExplicit ? 'explicit' : 'default_findings',
    autoVerdictHint: autoVerdictHint === 'ok' ? 'ok' : 'findings',
    note: oneLine(redactFindingSummary(note)),
    findingSummary: verdict === 'findings' ? oneLine(redactFindingSummary(findingSummary || note), 1200) : '',
    findingKinds: normalizedFindingKinds,
    functionalDefectCount: normalizedFunctionalDefectCount,
    hasFunctionalDefects,
    remainingDefects: oneLine(redactFindingSummary(remainingDefects), 1200),
    unverified: normalizedUnverified,
    verificationSummary: oneLine(redactFindingSummary(verificationSummary), 1200),
    recheck: focusedRecheckPending ? 1 : null,
  };
  if (usesNativeReviewChain) {
    // 2026-09-28 (native dual-review acceptance): keep both reviewers' independent results,
    // each with its own source label, next to each other, bound to this round/head/approval/scope,
    // so the round outcome can require BOTH to pass instead of Opus alone.
    round.reviewerResults = {
      deepseek: nativePrimaryVerified
        ? {
            source: 'deepseek-native-cli-v1',
            round: nativePrimaryVerified.round,
            lens: nativePrimaryVerified.lens,
            reviewHeadCommit: nativePrimaryVerified.reviewHeadCommit,
            approvalHash: nativePrimaryVerified.approvalHash,
            changedScopeHash: nativePrimaryVerified.changedScopeHash,
            verdict: nativePrimaryVerified.verdict,
            findings: Array.isArray(nativePrimaryVerified.findings) ? nativePrimaryVerified.findings : [],
            unverified: Array.isArray(nativePrimaryVerified.unverified) ? nativePrimaryVerified.unverified : [],
            importantUnknowns: Array.isArray(nativePrimaryVerified.importantUnknowns) ? nativePrimaryVerified.importantUnknowns : [],
          }
        : null,
      opus: {
        source: mode === 'queue' ? 'queue_result' : 'pane',
        round: roundNumber,
        lens: lens?.key || null,
        requestId,
        verdict,
        unverified: normalizedUnverified,
        findingsText: verdict === 'findings' ? oneLine(redactFindingSummary(findingSummary || note), 1200) : '',
      },
    };
  }
  if (cmgbNativeFocused && focusedRecheckPending) {
    // CMGB native focused: 単一結果で全旧所見を消さず、recheckResolution の対象keyごとの
    // 双方一致判定と実queue/receipt照合が揃った同版だけを accepted 履歴へ追記し、次観点へ進める。
    const focused = buildCmgbFocusedAcceptance({
      state, task, request, round,
      resolution: recheckResolution,
      nativePrimaryVerified,
      roundNumber,
      acceptedAt,
    });
    if (focused.error) throw new Error(focused.error);
    state.codeReview.reviewChainVersion = activeReviewChainVersion;
    if (!focused.accepted) {
      // 受理不能（openキー・未分類・両者cleanでない等）では pending の観点をそのまま維持し、
      // review-rounds.json を書き換えない。拒否の記録で state bytes を増やすと、まだ何も受理して
      // いない往復が state を進めたように見え、再試行の再現性と監査が崩れる。
      return { state, round, duplicate: false, focusedAccepted: false };
    }
    state.codeReview.focusedRechecks = [...cmgbAcceptedRechecks(state), focused.element];
    const nextLens = nextCmgbFocusedLens(focused.element.lens);
    if (nextLens) {
      state.codeReview.outcome = 'focused_recheck_required';
      state.codeReview.closedReason = null;
      state.codeReview.focusedRecheck = {
        status: 'pending',
        sourceRound: roundNumber,
        lens: nextLens,
        requestId,
        summary: `CMGB native focused: 次観点 ${nextLens} を同版で確認`,
        createdAt: acceptedAt,
      };
    } else {
      state.codeReview.outcome = 'passed_clean';
      state.codeReview.closedReason = 'CMGB native focused: spec/user_path/edge を同版で閉鎖し、open P0/P1・重要unknownは0';
      state.codeReview.focusedRecheck = { status: 'closed', lens: null, closedAt: acceptedAt };
    }
    saveReviewRounds(root, state);
    return { state, round, duplicate: false, focusedAccepted: true };
  }
  if (focusedRecheckPending) {
    state.codeReview.focusedRecheck = {
      ...state.codeReview.focusedRecheck,
      status: 'accepted',
      acceptedAt,
      result: round,
    };
  } else {
    state.codeReview.rounds.push(round);
  }
  const lastTwo = state.codeReview.rounds.slice(-2);
  const unresolvedAfterRound = unresolvedCodeReviewLenses(state);
  const nativeDual = usesNativeReviewChain ? nativeDualReviewStatus(state) : null;
  if (nativeDual) {
    state.codeReview.nativeDualReview = {
      round: roundNumber,
      recordedAt: acceptedAt,
      clean: nativeDual.blockingCount === 0 && nativeDual.unknownCount === 0,
      blockingFindings: nativeDual.blocking.slice(0, 20),
      importantUnknowns: nativeDual.unknowns.slice(0, 20),
    };
  }
  const earlyExit = !usesNativeReviewChain && !currentPolicy && Boolean(
        state.codeReview.sizeClass
        && lastTwo.length === 2
        && lastTwo.every((item) => item.verdict === 'ok')
        && unresolvedAfterRound.length === 0
      );
  if (currentPolicy && verdict === 'findings' && !hasFunctionalDefects) {
    state.codeReview.nextCandidates = [
      ...(Array.isArray(state.codeReview.nextCandidates) ? state.codeReview.nextCandidates : []),
      {
        requestId,
        round: roundNumber,
        kinds: normalizedFindingKinds,
        summary: round.findingSummary || round.note || '機能外の候補はreview-result.mdを確認',
      },
    ];
  }
  if (earlyExit) {
    state.codeReview.outcome = 'passed_clean';
    state.codeReview.closedReason = `連続2回の指摘なしでround ${roundNumber}に早期終了`;
    state.codeReview.earlyExit = {
      reason: 'two_consecutive_ok',
      atRound: roundNumber,
      skippedRounds: Array.from({ length: effectiveMaxRounds - roundNumber }, (_, index) => ({
        round: roundNumber + index + 1,
        reason: 'early_exit',
      })),
    };
  } else if (cmgbNativeFocused && !focusedRecheckPending && roundNumber >= effectiveMaxRounds) {
    // CMGBは単一の最終観点へ流さず、同版の spec→user_path→edge を先頭から順に閉じる。
    // passed_max_rounds / passed_with_unverified へ単純落下させず、未解決は次観点を失わない。
    state.codeReview.outcome = 'focused_recheck_required';
    state.codeReview.closedReason = null;
    state.codeReview.focusedRecheck = {
      status: 'pending',
      sourceRound: roundNumber,
      lens: CMGB_NATIVE_FOCUSED_LENS_ORDER[0],
      requestId,
      summary: 'CMGB native focused: spec→user_path→edge を同版で順次閉じる',
      createdAt: acceptedAt,
    };
  } else if (
    currentPolicy && !focusedRecheckPending && roundNumber >= effectiveMaxRounds
    && (usesNativeReviewChain ? nativeDual.blockingCount > 0 : hasFunctionalDefects)
  ) {
    // 2026-09-28 (native dual-review acceptance): native連鎖では最終往復のOpus返信がokでも、受理済みの
    // 前往復DeepSeek P0/P1やOpus findingsが未解決で残り得る。dual所見だけを「まだ阻害中」の根拠にし、
    // 限定再確認は最初に未解決になった観点へ固定する(最後の観点へ流さない)。非nativeは従来どおり。
    const nativeBlocking = usesNativeReviewChain && Array.isArray(nativeDual.blocking) ? nativeDual.blocking : [];
    const blockingOrigin = nativeBlocking.find((item) => item?.lens) || null;
    state.codeReview.outcome = 'focused_recheck_required';
    state.codeReview.closedReason = null;
    state.codeReview.focusedRecheck = {
      status: 'pending',
      sourceRound: roundNumber,
      lens: blockingOrigin?.lens || round.lens,
      requestId,
      summary: nativeBlocking.map((item) => item?.summary).filter(Boolean).join(' / ')
        || round.remainingDefects || round.findingSummary || round.note || 'R3の機能不具合',
      createdAt: acceptedAt,
    };
  } else if (focusedRecheckPending || state.codeReview.rounds.length >= effectiveMaxRounds) {
    const hasFindings = usesNativeReviewChain
      ? nativeDual.blockingCount > 0
      : currentPolicy
        ? hasFunctionalDefects
        : state.codeReview.sizeClass
          ? unresolvedAfterRound.length > 0
          : state.codeReview.rounds.at(-1)?.verdict === 'findings';
    const unresolvedUnverified = usesNativeReviewChain || currentPolicy ? outstandingCodeReviewUnverified(state) : [];
    const hasUnverified = unresolvedUnverified.length > 0;
    state.codeReview.outcome = hasFindings
      ? 'passed_max_rounds'
      : hasUnverified
        ? 'passed_with_unverified'
        : 'passed_clean';
    state.codeReview.closedReason = hasFindings
      ? focusedRecheckPending
        ? 'R3の限定再確認後も機能の不具合が残存'
        : `${effectiveMaxRounds}往復の上限到達（指摘が残存）`
      : hasUnverified
        ? focusedRecheckPending
          ? 'R3の限定再確認を完了したが未確認事項が残存'
          : `${effectiveMaxRounds}往復を完了したが未確認事項が残存`
      : currentPolicy
        ? focusedRecheckPending
          ? 'R3の限定再確認を完了し指摘なし'
          : `${effectiveMaxRounds}往復を完了し指摘なし`
        : `${LEGACY_CODE_REVIEW_ROUNDS}観点すべて通過`;
    const shouldEscalate = hasFindings
      && (currentPolicy || state.codeReview.sizeClass === 'large');
    if (shouldEscalate) {
      const latest = latestLensVerdicts(state.codeReview.rounds);
      const findings = usesNativeReviewChain
        ? nativeDual.blocking.map((item) => ({
            lens: item.lens || round.lens || CODE_REVIEW_LENSES.at(-1).key,
            round: item.round || round.round,
            summary: item.summary || '指摘内容はreview-result.mdを確認',
          }))
        : currentPolicy
        ? [{
            lens: round.lens || CODE_REVIEW_LENSES.at(-1).key,
            round: round.round,
            summary: round.findingSummary || round.note || '指摘内容はreview-result.mdを確認',
          }]
        : unresolvedAfterRound.map((item) => ({
            lens: item.key,
            round: latest.get(item.key)?.round?.round || null,
            summary: latest.get(item.key)?.round?.findingSummary || latest.get(item.key)?.round?.note || '指摘内容はreview-result.mdを確認',
          }));
      const findingsDigest = createHash('sha256').update(JSON.stringify(findings)).digest('hex');
      const escalationId = createHash('sha256').update([
        state.taskId,
        state.taskFingerprint,
        requestId,
        findingsDigest,
      ].join('\n')).digest('hex').slice(0, 24);
      // 2026-10-16: 上限到達で実用阻害が残ったら、Astra原因診断の記録を必須にする（停止・本人相談の前提）。
      state.codeReview.astraDiagnosis = state.codeReview.astraDiagnosis || {
        required: true,
        status: 'pending',
        model: 'gpt-6-astra',
        effort: 'high',
        maxAttempts: 1,
        requiredAt: new Date().toISOString(),
        taskId: state.taskId || null,
        candidateHash: null,
      };
      state.codeReview.parentEscalation = {
        escalationId,
        sizeClass: state.codeReview.sizeClass,
        effectiveMaxRounds,
        lastRequestId: requestId,
        findingsDigest,
        findings,
        notification: { status: 'pending', attemptedAt: null, error: '' },
      };
    }
  } else {
    state.codeReview.outcome = 'in_progress';
    state.codeReview.closedReason = null;
  }
  if (codeReviewClosed(state) && !browserReviewApplicable(task)) {
    state.visualQc.outcome = 'not_applicable';
    state.visualQc.closedReason = 'surfaceKind!=web_ui';
    state.browserReview.preflight = 'not_applicable';
    state.browserReview.outcome = 'not_applicable';
    state.browserReview.closedReason = 'surfaceKind!=web_ui';
  }
  saveReviewRounds(root, state);
  if (!deferParentNotification && state.codeReview.parentEscalation?.notification?.status === 'pending') {
    notifyReviewEscalation(root, task, state, { sendParent });
  }
  return { state, round, duplicate: false };
}

export function notifyReviewEscalation(root, task, state, { sendParent } = {}) {
  const escalation = state?.codeReview?.parentEscalation;
  if (!escalation || escalation.notification?.status === 'sent') return state;
  const workflowAvailable = typeof optionalWorkflow?.repoKey === 'function'
    && typeof optionalWorkflow?.agentId === 'function'
    && typeof optionalWorkflow?.runAgmsgScript === 'function';
  const team = workflowAvailable
    ? `${optionalWorkflow.repoKey(task?.repo).toLowerCase()}-cc-bridge`
    : `${String(task?.repo || 'repo').trim().toLowerCase()}-cc-bridge`;
  const from = workflowAvailable ? optionalWorkflow.agentId(task?.implementer) || 'implementer' : 'implementer';
  const findings = escalation.findings
    .map((item) => `${item.lens}: ${oneLine(redactFindingSummary(item.summary), 1200)}`)
    .join(' / ');
  const parentDecisionTemplate = JSON.stringify({
    kind: 'review_escalation',
    taskId: state.taskId,
    taskFingerprint: state.taskFingerprint,
    escalationId: escalation.escalationId,
    sizeClass: escalation.sizeClass,
    maxRounds: escalation.maxRounds,
    lastRequestId: escalation.lastRequestId,
    findingsDigest: escalation.findingsDigest,
    decision: 'proceed_with_findings',
    decidedBy: 'claude-code',
    reason: 'ここへ判断理由を記入',
  });
  const message = [
    'コードレビューが大きな変更向けの上限に達し、未解決の指摘が残っています。親の判断が必要です。',
    `taskId=${state.taskId}`,
    `escalationId=${escalation.escalationId}`,
    `remaining=${findings}`,
    '続行を認める場合は、親レーンからparent-handoff.sh --add-decisionへ次の1行JSONを記録してください。',
    parentDecisionTemplate,
    '記録後、実装レーンでapproval review-decisionにこのescalationIdを指定してください。',
  ].join('\n');
  const deliver = typeof sendParent === 'function'
    ? sendParent
    : workflowAvailable
      ? ({ team: targetTeam, from: sender, to, message: body }) =>
        optionalWorkflow.runAgmsgScript('send.sh', [targetTeam, sender, to, body], { cwd: root })
      : null;
  escalation.notification = {
    status: 'pending',
    attemptedAt: new Date().toISOString(),
    error: '',
  };
  if (!deliver) {
    escalation.notification.status = 'failed';
    escalation.notification.error = 'ai-workflow-lib.mjsが無いため親通知を送信していません';
    saveReviewRounds(root, state);
    return state;
  }
  try {
    deliver({ team, from, to: 'claude-code', message });
    escalation.notification.status = 'sent';
  } catch (error) {
    escalation.notification.status = 'failed';
    escalation.notification.error = oneLine(error?.message || error);
  }
  saveReviewRounds(root, state);
  return state;
}

export function retryReviewEscalationNotification(root, task, { sendParent } = {}) {
  const state = loadReviewRounds(root, task).state;
  const escalation = state.codeReview.parentEscalation;
  if (!escalation || escalation.notification?.status === 'sent') {
    return {
      state,
      attempted: false,
      sent: escalation?.notification?.status === 'sent',
      error: escalation?.notification?.error || '',
    };
  }
  notifyReviewEscalation(root, task, state, { sendParent });
  return {
    state,
    attempted: true,
    sent: escalation.notification?.status === 'sent',
    error: escalation.notification?.error || '',
  };
}

export function markBrowserNotApplicable(root, task) {
  const loaded = loadReviewRounds(root, task);
  const state = loaded.state;
  state.visualQc.outcome = 'not_applicable';
  state.visualQc.closedReason = 'surfaceKind!=web_ui';
  state.browserReview.preflight = 'not_applicable';
  state.browserReview.outcome = 'not_applicable';
  state.browserReview.closedReason = 'surfaceKind!=web_ui';
  saveReviewRounds(root, state);
  return state;
}

export function recordVisualQcAttempt(root, task, {
  status,
  report = '',
  findingCount = 0,
  url = '',
  reason = '',
  repairCompleted = false,
  warningRetry = false,
  checkedAt = new Date().toISOString(),
} = {}) {
  if (!['clean', 'findings', 'skipped', 'unavailable'].includes(status)) {
    throw new Error('visual QC statusはclean/findings/skipped/unavailableが必要です');
  }
  const loaded = loadReviewRounds(root, task);
  const state = loaded.state;
  if (!browserReviewApplicable(task)) throw new Error('visual QCはsurfaceKind=web_uiだけが対象です');
  if (!codeReviewClosed(state)) {
    throw new Error(`visual QCはコードレビュー完了後に開始します（現在 ${state.codeReview.rounds.length}/${codeReviewMaxRounds(state)}往復）`);
  }
  const preliminary = ['skipped', 'unavailable'].includes(status);
  const warningOutcome = ['skipped_warning', 'unavailable_warning'].includes(state.visualQc.outcome);
  if (warningRetry && !warningOutcome) {
    throw new Error('visual QC警告後の再検査は未検査または実行不能の警告後だけ指定できます');
  }
  if (!warningRetry && visualQcClosed(state)) throw new Error('visual QCは既に終了しています');
  if (warningRetry && !visualQcClosed(state)) throw new Error('visual QC警告後の再検査を開始できる状態ではありません');
  if (!preliminary && state.visualQc.attempts.length >= MAX_VISUAL_QC_ATTEMPTS) {
    throw new Error('visual QCは再検査上限に到達済みです');
  }
  if (preliminary && state.visualQc.preliminaryChecks.length >= MAX_VISUAL_QC_PRELIMINARY_CHECKS) {
    throw new Error(`visual QCの事前警告記録は${MAX_VISUAL_QC_PRELIMINARY_CHECKS}回の上限に到達済みです`);
  }

  const attemptNumber = state.visualQc.attempts.length + 1;
  const repairWasCompleted = repairCompleted || state.visualQc.preliminaryChecks.some((check) => check.repairCompleted);
  const continuingRepairAfterWarning = warningRetry && state.visualQc.attempts[0]?.status === 'findings';
  if (
    !preliminary &&
    attemptNumber === 2 &&
    state.visualQc.outcome !== 'repair_required' &&
    !continuingRepairAfterWarning
  ) {
    throw new Error('visual QC再検査は初回指摘の後だけ実行できます');
  }
  if (!preliminary && attemptNumber === 2 && !repairWasCompleted) {
    throw new Error('visual QC再検査には自己修正完了の明示が必要です');
  }
  if (!preliminary && attemptNumber === 2 && oneLine(url) !== state.visualQc.attempts[0]?.url) {
    throw new Error(`visual QC再検査は初回と同じURLで実行してください（初回: ${state.visualQc.attempts[0]?.url}）`);
  }
  if (preliminary && repairCompleted && state.visualQc.outcome !== 'repair_required') {
    throw new Error('自己修正完了は初回指摘の後だけ指定できます');
  }
  if (!preliminary && attemptNumber === 1 && repairCompleted) {
    throw new Error('初回visual QCに自己修正完了は指定できません');
  }
  if (!Number.isInteger(findingCount) || findingCount < 0) throw new Error('findingCountは0以上の整数が必要です');
  if (status === 'findings' && findingCount === 0) throw new Error('status=findingsには1件以上のfindingCountが必要です');
  if (status === 'clean' && findingCount !== 0) throw new Error('status=cleanのfindingCountは0件である必要があります');

  let reportPath = null;
  const runNumber = state.visualQc.preliminaryChecks.length + state.visualQc.attempts.length + 1;
  if (report) {
    const expected = join(root, '.ai', 'e2e', `${state.taskId}-visual-qc-run${runNumber}.json`);
    reportPath = resolveRepoPath(root, report, 'visual QC結果');
    if (reportPath !== expected) throw new Error(`visual QC結果は命名規約どおり ${expected} を指定してください`);
    ensureRegularFile(reportPath, 'visual QC結果');
    const body = readJson(reportPath);
    if (body?.status !== status) throw new Error(`visual QC結果のstatus(${body?.status || 'なし'})が${status}と一致しません`);
    if (Number(body?.findingCount) !== findingCount) throw new Error('visual QC結果のfindingCountが記録値と一致しません');
  } else if (status !== 'unavailable') {
    throw new Error(`status=${status}にはvisual QC結果ファイルが必要です`);
  }

  const attempt = {
    run: runNumber,
    attempt: preliminary ? null : attemptNumber,
    checkedAt,
    status,
    findingCount,
    report: reportPath,
    url: oneLine(url),
    repairCompleted: Boolean(repairCompleted),
    warningRetry: Boolean(warningRetry),
    reason: oneLine(reason),
    previousFindingCount: !preliminary && attemptNumber === 2
      ? state.visualQc.attempts[0].findingCount
      : null,
    delta: null,
  };
  if (!preliminary && attemptNumber === 2) {
    attempt.delta = findingCount < attempt.previousFindingCount
      ? 'improved'
      : findingCount > attempt.previousFindingCount
        ? 'worse'
        : 'unchanged';
  }
  const outcomeBeforeAttempt = state.visualQc.outcome;
  const hasUnresolvedFindings = state.visualQc.attempts.length === 1 && state.visualQc.attempts[0]?.status === 'findings';
  if (preliminary) state.visualQc.preliminaryChecks.push(attempt);
  else state.visualQc.attempts.push(attempt);
  if (status === 'clean') {
    state.visualQc.outcome = 'passed_clean';
    state.visualQc.closedReason = attemptNumber === 2
      ? `再検査で${attempt.previousFindingCount}件→0件（改善）`
      : 'attempt 1で指摘なし';
  } else if (status === 'skipped') {
    if (outcomeBeforeAttempt === 'repair_required' || hasUnresolvedFindings) {
      state.visualQc.outcome = 'skipped_warning';
      state.visualQc.closedReason = `${state.visualQc.attempts[0].findingCount}件の指摘は未解消、再検査は未実施: ${attempt.reason || '検査対象ページの宣言がありません'}`;
    } else {
      state.visualQc.outcome = 'skipped_warning';
      state.visualQc.closedReason = attempt.reason || '検査対象ページの宣言が無いため未検査';
    }
  } else if (status === 'unavailable') {
    if (outcomeBeforeAttempt === 'repair_required' || hasUnresolvedFindings) {
      state.visualQc.outcome = 'unavailable_warning';
      state.visualQc.closedReason = `${state.visualQc.attempts[0].findingCount}件の指摘は未解消、再検査不能: ${attempt.reason || 'visual QCを実行できませんでした'}`;
    } else {
      state.visualQc.outcome = 'unavailable_warning';
      state.visualQc.closedReason = attempt.reason || 'visual QCを実行できませんでした';
    }
  } else if (attemptNumber === 1) {
    state.visualQc.outcome = 'repair_required';
    state.visualQc.closedReason = `${findingCount}件の指摘を自己修正後に再検査`;
  } else {
    state.visualQc.outcome = 'findings_warning';
    const deltaLabel = {
      improved: '改善',
      worse: '悪化',
      unchanged: '不変',
    }[attempt.delta];
    state.visualQc.closedReason =
      `再検査で${attempt.previousFindingCount}件→${findingCount}件（${deltaLabel}）、指摘が残存`;
  }
  saveReviewRounds(root, state);
  return { state, attempt };
}

// ブラウザレビューはサイズ別コードレビューの完了後にしか始められない。
//
// なぜ順序を強制するか（この節を消さない）:
//   コードが固まる前に画面を確認しても、そのあとの修正で画面は変わる。
//   確認し直しになるだけでなく、「一度OKが出た画面」という誤った安心が残る。
//   コードレビューで実装が固まってから画面を見る。
//   ブラウザ側の往復数は従来どおり3のまま（回数でなく順序だけを強制する）。
export function markBrowserPreflight(root, task, { status, evidence, reason = '', url = '' }) {
  if (!['passed', 'blocked'].includes(status)) throw new Error('browser preflight statusはpassedまたはblockedが必要です');
  const loaded = loadReviewRounds(root, task);
  const state = loaded.state;
  // blocked（実施できない記録）は、コードレビューの途中でも残せるようにする。
  // 環境が理由で実施不能なことは早い段階で判明するし、記録を拒むと事実が残らない。
  if (status === 'passed' && !codeReviewClosed(state)) {
    const done = state.codeReview.rounds.length;
    throw new Error(
      `ブラウザレビューはコードレビュー完了後に開始します（現在 ${done}/${codeReviewMaxRounds(state)}往復）。` +
        'コードが固まる前に画面を見ると、そのあとの修正で確認し直しになります',
    );
  }
  if (status === 'passed' && browserReviewApplicable(task) && !visualQcClosed(state)) {
    throw new Error(`ブラウザレビューはvisual QC完了後に開始します（現在 ${state.visualQc.outcome}）`);
  }
  state.browserReview.preflight = status;
  state.browserReview.preflightEvidence = evidence || null;
  state.browserReview.url = url || null;
  if (status === 'blocked') {
    state.browserReview.outcome = 'skipped_blocked';
    state.browserReview.closedReason = oneLine(reason || 'ブラウザpreflightがblocked');
  } else {
    state.browserReview.outcome = 'in_progress';
    state.browserReview.closedReason = null;
  }
  saveReviewRounds(root, state);
  return state;
}

export function recordBrowserReviewRound(root, task, {
  verdict,
  evidence,
  note = '',
  checkedAt = new Date().toISOString(),
} = {}) {
  if (!['ok', 'error'].includes(verdict)) throw new Error('browser verdictはokまたはerrorが必要です');
  const loaded = loadReviewRounds(root, task);
  const state = loaded.state;
  if (state.browserReview.preflight !== 'passed') {
    throw new Error('ブラウザレビュー記録前にpreflight=passedが必要です');
  }
  if (['passed_clean', 'passed_max_rounds'].includes(state.browserReview.outcome)) {
    throw new Error('ブラウザレビューは既に終了しています');
  }
  if (state.browserReview.rounds.length >= MAX_REVIEW_ROUNDS) {
    throw new Error('ブラウザレビューは上限到達済みです');
  }
  const roundNumber = state.browserReview.rounds.length + 1;
  const expectedEvidencePath = join(root, '.ai', 'e2e', `${state.taskId}-browser-round${roundNumber}.json`);
  const evidencePath = resolveRepoPath(root, evidence, 'ブラウザレビュー証跡');
  if (evidencePath !== expectedEvidencePath) {
    throw new Error(`ブラウザレビュー証跡は命名規約どおり ${expectedEvidencePath} を指定してください`);
  }
  if (!existsSync(evidencePath)) throw new Error(`ブラウザレビュー証跡がありません: ${evidencePath}`);
  ensureRegularFile(evidencePath, 'ブラウザレビュー証跡');
  let evidenceBody;
  try {
    evidenceBody = readJson(evidencePath);
  } catch (error) {
    throw new Error(`ブラウザレビュー証跡をJSONとして読めません: ${error.message}`);
  }
  const evidenceErrors = verdict === 'ok'
    ? validatePassedEvidence(evidenceBody, {
        root,
        taskId: state.taskId,
        taskFingerprint: state.taskFingerprint,
        repo: String(task?.repo || '').trim(),
        branch: String(task?.branch || '').trim(),
        // レビュー往復はdeploy前の確認工程。deploy-gateのfail-closed検証は
        // ai:complete側のvalidateCompletionへ残し、ここでは工程順を逆転させない。
        requireDeployGate: false,
      })
    : validateFailedEvidence(evidenceBody, {
        taskId: state.taskId,
        taskFingerprint: state.taskFingerprint,
        repo: String(task?.repo || '').trim(),
        branch: String(task?.branch || '').trim(),
      });
  if (evidenceErrors.length) {
    throw new Error(`ブラウザレビュー証跡がverdict=${verdict}と一致しません: ${evidenceErrors.join('; ')}`);
  }
  const noteLine = oneLine(note);
  if (verdict === 'error' && roundNumber === MAX_REVIEW_ROUNDS && !noteLine) {
    throw new Error(`${MAX_REVIEW_ROUNDS}往復後も残るエラーを --note の1行で記録してください`);
  }
  const round = {
    round: roundNumber,
    checkedAt,
    verdict,
    evidence: evidencePath,
    note: noteLine,
  };
  state.browserReview.rounds.push(round);
  if (verdict === 'ok') {
    state.browserReview.outcome = 'passed_clean';
    state.browserReview.closedReason = `round ${round.round}でエラーなし`;
  } else if (state.browserReview.rounds.length >= MAX_REVIEW_ROUNDS) {
    state.browserReview.outcome = 'passed_max_rounds';
    state.browserReview.closedReason = round.note || `${MAX_REVIEW_ROUNDS}往復後もエラーが残存`;
  } else {
    state.browserReview.outcome = 'in_progress';
    state.browserReview.closedReason = null;
  }
  saveReviewRounds(root, state);
  return { state, round };
}

function matchingProceedDecision(approval, state) {
  const escalation = state?.codeReview?.parentEscalation;
  if (!escalation || !Array.isArray(approval?.reviewEscalationDecisions)) return null;
  for (let index = approval.reviewEscalationDecisions.length - 1; index >= 0; index -= 1) {
    const decision = approval.reviewEscalationDecisions[index];
    const matches = decision?.taskId === state.taskId
      && decision?.taskFingerprint === state.taskFingerprint
      && decision?.escalationId === escalation.escalationId
      && decision?.sizeClass === escalation.sizeClass
      && decision?.maxRounds === escalation.maxRounds
      && decision?.lastRequestId === escalation.lastRequestId
      && decision?.findingsDigest === escalation.findingsDigest;
    if (matches) return decision.decision === 'proceed_with_findings' ? decision : null;
  }
  return null;
}

// ブラウザ往復・視覚QCの実状態を review-rounds.json の state から summary の欄へ写す。
// external(DeepSeek/Opus)集計でも web_ui のブラウザ/視覚QCを「対象外(not_applicable)」に
// しないため、非 external 経路とまったく同じ値・警告になるよう共通化する。
function browserVisualQcSummary(root, state, task, warnings, { codeReviewClosedOverride = null } = {}) {
  const browserOutcome = state.browserReview.outcome;
  const codeRounds = state.codeReview.rounds.length;
  const maxCodeRoundsLabel = codeReviewMaxRounds(state) ?? '未確定';
  // external 経路ではコードレビュー3往復が review-rounds.json ではなく external index にだけある。
  // ローカル state の codeReview は空なので codeReviewClosed(state) は常に false になり、
  // ブラウザ/視覚QCの実警告が「コードレビュー完了待ち」へ化ける。呼び出し側が external 集計の
  // 完了結果を明示できるようにする(2026-10-02 R3 F3-1)。未指定なら従来どおり state から判定する。
  const codeClosed = codeReviewClosedOverride === null ? codeReviewClosed(state) : codeReviewClosedOverride;
  if (!browserReviewApplicable(task)) {
    const traceWarning = webAppTraceWarning(root, task);
    if (traceWarning) warnings.push(traceWarning);
    if (browserOutcome !== 'not_applicable') warnings.push('ブラウザ非対象ですがnot_applicable記録がありません');
  } else {
    const visualOutcome = state.visualQc.outcome;
    if (visualOutcome === 'not_applicable') {
      warnings.push(`visual QCは移行前にブラウザ段階へ入っていたため免除されています: ${state.visualQc.closedReason || '旧状態からの移行'}`);
    } else if (!codeClosed) {
      warnings.push(`visual QCはコードレビュー完了待ちです（コード ${codeRounds}/${maxCodeRoundsLabel}往復）`);
    } else if (visualOutcome === 'repair_required') {
      warnings.push(`visual QCの指摘を自己修正して再検査する必要があります: ${state.visualQc.closedReason}`);
    } else if (visualOutcome === 'findings_warning') {
      warnings.push(`visual QCは再検査後も指摘が残ったため警告付きで終了しました: ${state.visualQc.closedReason}`);
    } else if (visualOutcome === 'skipped_warning') {
      warnings.push(`visual QCは未検査です: ${state.visualQc.closedReason}`);
    } else if (visualOutcome === 'unavailable_warning') {
      warnings.push(`visual QCを実行できませんでした: ${state.visualQc.closedReason}`);
    } else if (!visualQcClosed(state)) {
      warnings.push(`visual QCが未完了です（outcome=${visualOutcome || 'not_started'}）`);
    }
  }

  if (browserReviewApplicable(task) && browserOutcome === 'skipped_blocked') {
    warnings.push(`ブラウザレビューを実施できませんでした: ${state.browserReview.closedReason || 'preflight blocked'}`);
  } else if (browserReviewApplicable(task) && !['passed_clean', 'passed_max_rounds'].includes(browserOutcome)) {
    // コードレビューが終わっていない間は、ブラウザ未実施は順序どおりであって不備ではない。
    // 区別しないと「まだやる番でない」ものが不備として並び、本当の不備が埋もれる。
    warnings.push(
      codeClosed
        ? `ブラウザレビューが未完了です（outcome=${browserOutcome || 'not_started'}）`
        : `ブラウザレビューはコードレビュー完了待ちです（コード ${codeRounds}/${maxCodeRoundsLabel}往復）`,
    );
  } else if (browserReviewApplicable(task) && browserOutcome === 'passed_max_rounds') {
    warnings.push(`ブラウザレビューは上限到達で終了しました: ${state.browserReview.closedReason || 'エラー残存'}`);
  }

  return {
    visualQcOutcome: state.visualQc.outcome,
    visualQcAttempts: state.visualQc.attempts.length,
    visualQcPreliminaryChecks: state.visualQc.preliminaryChecks.length,
    browserReviewOutcome: browserOutcome,
    browserReviewRounds: state.browserReview.rounds.length,
  };
}

// `.ai/external-reviews/index.json` は他レーンの作業場にも置かれ得る。存在するだけでこの
// レーンの external 経路へ入ると、別タスクの index を集計しようとして throw し、正常な
// web_ui レーンの完了が止まる(R3再々実行 E3-R1)。そこで別タスクの index は無視する。
// ただし無視してよいのは「別タスクと断定できる」場合だけにする(fail-closed)。読めない/
// 壊れた JSON、taskId 欄が無い、taskId が同じで taskFingerprint が違う(途中書き・旧
// fingerprint)は、すべて自分の証跡として external 経路へ送り、集計側で throw/未確定に
// して止める(R3 E3-R2)。無視側へ倒すと external にしかコードレビューが無いレーンが
// 「0往復」警告だけで完了し得るため。
export function externalIndexBelongsToTask(indexFile, task) {
  let index;
  try {
    index = JSON.parse(readFileSync(indexFile, 'utf8'));
  } catch {
    return true;
  }
  const indexTaskId = typeof index?.taskId === 'string' ? index.taskId.trim() : '';
  if (!indexTaskId) return true;
  return indexTaskId === String(task?.taskId ?? '').trim();
}

export function reviewProcessSummary(root, task, { approval = null } = {}) {
  const externalIndex = join(root, '.ai', 'external-reviews', 'index.json');
  const externalIndexPresent = existsSync(externalIndex);
  const foreignExternalIndex = externalIndexPresent && !externalIndexBelongsToTask(externalIndex, task);
  if (externalIndexPresent && !foreignExternalIndex) {
    // Explicit separate evidence route. Never relabel external reviewers as Astra.
    if (typeof optionalReviewEvidence?.externalReviewSummary !== 'function') throw new Error('external review verifier unavailable');
    const summary = optionalReviewEvidence.externalReviewSummary(root, task, externalIndex, resolveReviewDiffScope(root,{task}));
    // 外部集計はコードレビュー3往復だけを担う。web_ui のブラウザ往復・視覚QCは別の正本
    // (review-rounds.json)から読み、非 external 経路と同じ欄へ入れる。not_applicable を
    // 返してよいのは non_web だけ。
    if (String(task?.surfaceKind || '').trim() !== 'web_ui') return summary;
    const warnings = Array.isArray(summary.warnings) ? [...summary.warnings] : [];
    // 状態が無い/別taskの残骸なら「まだ開始していない」= pending として記録する。
    // not_started をそのまま external へ出すと、実状態が未確認であることが伝わらない。
    const pendingBrowserVisualQc = () => ({
      visualQcOutcome: 'pending',
      visualQcAttempts: 0,
      visualQcPreliminaryChecks: 0,
      browserReviewOutcome: 'pending',
      browserReviewRounds: 0,
    });
    let loaded;
    try {
      // 読むだけで state を作らない。fresh state の生成は従来どおり通常経路に任せる。
      loaded = loadReviewRounds(root, task, { persist: false });
    } catch (error) {
      warnings.push(`web_uiのブラウザ/視覚QC状態をreview-rounds.jsonから読めません: ${error.message}`);
      return { ...summary, ...pendingBrowserVisualQc(), warnings };
    }
    if (loaded.initialized) {
      warnings.push('web_uiのブラウザ往復・視覚QCはまだ記録されていません（review-rounds.jsonに実状態がありません）');
      return { ...summary, ...pendingBrowserVisualQc(), warnings };
    }
    // external 集計が3往復を passed_* で返している以上、この経路のコードレビューは閉じている。
    // ローカル state の空 codeReview を再計算させない(2026-10-02 R3 F3-1)。
    return { ...summary, ...browserVisualQcSummary(root, loaded.state, task, warnings, {
      codeReviewClosedOverride: codeReviewClosed({ codeReview: { outcome: summary.codeReviewOutcome } }),
    }), warnings };
  }
  let state;
  const warnings = [];
  if (foreignExternalIndex) {
    // この完了の証跡ではない index を理由に unavailable で止めない。無視した事実だけ残し、
    // 通常経路(review-rounds.json)の実状態で集計する。
    warnings.push(`別タスクの external index を無視した(${join('.ai', 'external-reviews', 'index.json')})`);
  }
  const implementationPlan = approval?.implementationPlan;
  const singleLaneReason = oneLine(implementationPlan?.singleLaneReason);
  if (implementationPlan?.estimatedMinutes > 30 && implementationPlan?.lanes <= 1 && singleLaneReason) {
    warnings.push(`PARALLEL_SINGLE_LANE_REASON: ${singleLaneReason}`);
  }
  try {
    state = loadReviewRounds(root, task).state;
  } catch (error) {
    warnings.push(`review-rounds.jsonを読めません: ${error.message}`);
    state = createReviewRounds(task);
  }
  const codeRounds = state.codeReview.rounds.length;
  const maxCodeRounds = codeReviewMaxRounds(state);
  const maxCodeRoundsLabel = maxCodeRounds ?? '未確定';
  const earlyExit = ['two_consecutive_ok']
    .includes(state.codeReview.earlyExit?.reason);
  if (state.codeReview.sizeEvidence?.measurementWarning) {
    warnings.push(state.codeReview.sizeEvidence.measurementWarning);
  }
  if (
    state.codeReview.parentEscalation
    && state.codeReview.parentEscalation.notification?.status !== 'sent'
  ) {
    warnings.push(`親へのレビュー指摘通知が未送信です: ${state.codeReview.parentEscalation?.notification?.error || '再送が必要です'}`);
  }
  if (codeRounds === 0) warnings.push('コードレビューが0往復です');
  else if (!codeReviewClosed(state)) {
    warnings.push(`コードレビューが未完了です（${codeRounds}/${maxCodeRoundsLabel}往復）`);
  } else if (
    state.codeReview.outcome === 'passed_max_rounds' &&
    state.codeReview.parentEscalation &&
    !matchingProceedDecision(approval, state)
  ) {
    warnings.push(`コードレビューは${maxCodeRounds}往復の上限に達して指摘が残っています。親の判断が必要です（escalationId=${state.codeReview.parentEscalation.escalationId}）`);
  } else if (
    state.codeReview.outcome === 'passed_max_rounds' &&
    !state.codeReview.sizeClass &&
    state.codeReview.rounds.at(-1)?.verdict === 'findings'
  ) {
    warnings.push(`コードレビューは${maxCodeRounds}往復の上限に到達し、指摘が残った状態で終了しました`);
  } else if (
    state.codeReview.outcome === 'passed_max_rounds' &&
    !state.codeReview.parentEscalation
  ) {
    warnings.push(`コードレビューは${maxCodeRounds}往復の上限に到達し、指摘が残った状態で終了しました`);
  }
  if (state.codeReview.outcome === 'passed_with_unverified') {
    const unresolved = outstandingCodeReviewUnverified(state);
    warnings.push(`コードレビューは未確認事項を残して終了しました: ${unresolved.join(' / ') || '詳細未記録'}`);
  }

  // 早期終了で未実施となった観点は正常な省略として記録済みなので警告しない。
  const seenLenses = new Set(state.codeReview.rounds.map((round) => round.lens).filter(Boolean));
  // 旧形式のcomprehensiveは、仕様・利用者経路・端の条件を1回で見る観点。
  // 固定3観点へ移行した途中のstateで、確認済みを永久に未実施扱いしない。
  if (seenLenses.has(COMPREHENSIVE_CODE_REVIEW_LENS.key)) {
    for (const lens of CODE_REVIEW_LENSES) seenLenses.add(lens.key);
  }
  const currentPolicy = usesFunctionalDefectReviewPolicy(state);
  const requiredLenses = currentPolicy
    ? CODE_REVIEW_LENSES
    : maxCodeRounds === SMALL_CODE_REVIEW_ROUNDS
      ? CODE_REVIEW_LENSES.slice(0, SMALL_CODE_REVIEW_ROUNDS)
      : CODE_REVIEW_LENSES;
  const missingLenses = requiredLenses.filter((lens) => !seenLenses.has(lens.key));
  if (codeRounds > 0 && missingLenses.length > 0 && !earlyExit) {
    warnings.push(`未実施のレビュー観点: ${missingLenses.map((lens) => `${lens.round}.${lens.key}`).join(' ')}`);
  }
  return {
    codeReviewRounds: codeRounds,
    codeReviewMaxRounds: maxCodeRounds,
    codeReviewSizeClass: state.codeReview.sizeClass || state.codeReview.sizingStatus || 'legacy',
    codeReviewOutcome: state.codeReview.outcome,
    nextCandidates: Array.isArray(state.codeReview.nextCandidates)
      ? state.codeReview.nextCandidates
      : [],
    unverified: outstandingCodeReviewUnverified(state),
    ...browserVisualQcSummary(root, state, task, warnings),
    warnings,
  };
}
