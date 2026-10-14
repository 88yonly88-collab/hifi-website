#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  agentWorkDir,
  ensureRegularFile,
  gitValue,
  parseDeclaration,
  readJson,
  resolveRepoPath,
  safeId,
} from './ai-e2e-lib.mjs';
import {
  approveDocument,
  applyReviewEscalationDecision,
  applyTaskClassificationCorrection,
  approvalContentHash,
  appendPreReviewImplementerBinding,
  appendReviewImplementerBinding,
  archiveCurrentTask,
  autofillSimpleNonGoalAgreementChecks,
  bindReviewChainBinding,
  buildDraftApproval,
  loadApproval,
  repointCurrentTask,
  saveApproval,
  specLeaderSource,
  taskCompletedSignal,
  validateApproval,
} from './ai-approval-lib.mjs';
import { aiCmd } from './ai-workflow-lib.mjs';

const root = process.cwd();
const taskPath = resolve(root, '.ai', 'current-task.json');
const command = process.argv[2] || 'status';

function fail(errors) {
  for (const error of Array.isArray(errors) ? errors : [errors]) console.error(`APPROVAL_GATE_REJECTED: ${error}`);
  process.exit(2);
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) fail(`${name}には値が必要です`);
  return process.argv[index + 1];
}

function rejectDuplicateOptions(names) {
  for (const name of names) {
    const count = process.argv.filter((arg) => arg === name).length;
    if (count > 1) fail(`${name}は重複して指定できません`);
  }
}

function optionList(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${name}には値が必要です`);
    values.push(value);
  }
  return values;
}

function readInput(pathOption, label) {
  const inputPath = resolveRepoPath(root, option(pathOption), label);
  try {
    ensureRegularFile(inputPath, label);
    return readJson(inputPath);
  } catch (error) {
    fail(`${label}を読めません: ${error.message}`);
  }
}

function optionalInput(pathOption, label) {
  if (!process.argv.includes(pathOption)) return {};
  return readInput(pathOption, label);
}

function agreementMigrationHint(command = 'update') {
  return command === 'import-spec'
    ? `既存handoffでは ${aiCmd('approval', 'import-spec --handoff <handoff_dir> --input <合意入力.json>')} とし、userAgreementQuotes、全nonGoalsのagreementCheck、引用indexを含むcompletionCriteriaを同時に渡してください`
    : `旧形式draftは ${aiCmd('approval', 'update --input <合意追記.json>')} でuserAgreementQuotes、全nonGoalsのagreementCheck、completionCriteriaの引用index参照を補ってから再承認してください`;
}

function validateDraftBeforeSave(draft, { allowLegacyDraft = false, recoveryHint = '' } = {}) {
  const check = validateApproval({ root, task, approval: draft, requireApproved: false, allowLegacyDraft });
  if (check.errors.length) fail(recoveryHint ? [...check.errors, recoveryHint] : check.errors);
  return check;
}

function realPathOrResolved(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// 同じ作業ツリー(worktree)を指すactive宣言だけを衝突として扱う。
// current-task.jsonはworktreeごとの別ファイルなので、別worktreeのレーンの宣言を上書きすることはない。
// worktreeを分けた並行レーンは正規手順のため、repo名だけで弾くと正しい手順が必ず止まる。
// 参照: ~/projects/knowledge/rules/parallel-lanes-for-urgent-work.md
function declarationTargetsWorktree(declaration, { rootPath, branches }) {
  const declaredWorktree = String(declaration.worktree || '').trim();
  if (declaredWorktree) return realPathOrResolved(declaredWorktree) === rootPath;
  const declaredBranch = String(declaration.branch || '').trim();
  // worktreeもbranchも無い宣言は所在を特定できない。上書き事故を避けるため衝突扱いにする。
  if (!declaredBranch) return true;
  return branches.has(declaredBranch);
}

if (!existsSync(taskPath)) fail('.ai/current-task.jsonがありません');
let task;
try {
  task = readJson(taskPath);
} catch (error) {
  fail(`current-task.jsonを読めません: ${error.message}`);
}

if (command === 'verify' || command === 'status') {
  // verify(レーン起動ゲートの入口)だけ完了済み検出を有効化する。statusは情報表示のため既定のまま。
  const result = loadApproval(root, task, { rejectCompleted: command === 'verify' });
  if (result.errors.length) fail(result.errors);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      status: 'approved',
      path: relative(root, result.path),
      taskId: result.approval.taskId,
      revision: result.approval.revision,
      contentHash: result.contentHash,
      sourceType: result.approval.source.type,
    }));
  } else {
    console.log(`APPROVAL_GATE_PASSED: ${result.path}`);
    console.log(`  taskId: ${result.approval.taskId}`);
    console.log(`  revision: ${result.approval.revision}`);
    console.log(`  contentHash: ${result.contentHash}`);
  }
  process.exit(0);
}

if (command === 'next-task') {
  // 前タスクを完了ゲート済みと機械確認できる場合だけ、current-task.jsonを新task用に安全付け替えする。
  const newTaskId = option('--task-id');
  try {
    safeId(newTaskId);
  } catch (error) {
    fail(error.message);
  }
  const newTask = option('--task');
  if (!newTask.trim()) fail('--taskは空にできません');
  const newFingerprint = option('--fingerprint');
  if (!newFingerprint.trim() || /[\r\n]/.test(newFingerprint)) fail('--fingerprintが空または不正です');
  const surfaceKind = process.argv.includes('--surface-kind') ? option('--surface-kind').trim() : undefined;
  if (surfaceKind !== undefined && !['web_ui', 'non_web'].includes(surfaceKind)) {
    fail('--surface-kindはweb_ui|non_webを指定してください');
  }
  const deploymentKind = process.argv.includes('--deployment-kind') ? option('--deployment-kind').trim() : undefined;
  if (deploymentKind !== undefined && !['production', 'non_production'].includes(deploymentKind)) {
    fail('--deployment-kindはproduction|non_productionを指定してください');
  }
  let branch = process.argv.includes('--branch') ? option('--branch').trim() : '';
  if (!branch) {
    branch = gitValue(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || '';
    if (!branch) fail('実git branchを取得できません（--branchで明示してください）');
  }
  if (branch.includes('\n')) fail('branchが不正です');

  const workDir = agentWorkDir();
  const completedDir = join(workDir, 'completed');
  const prevTaskId = String(task.taskId || '').trim();

  // 前タスク完了の機械確認: completed/<prevTaskId>.md または applied:true完了適用証跡のいずれか。
  if (prevTaskId) {
    if (!taskCompletedSignal(root, prevTaskId)) {
      fail(`前タスク(${prevTaskId})が完了ゲートを通っていません。先に ai:complete -- --apply を完了してください`);
    }
  } else {
    console.log('前タスクなし(初期状態)のため完了確認をスキップします。');
  }

  // active宣言の残置検査: この作業ツリーの稼働中の前タスク宣言があれば上書きしない。
  if (prevTaskId) {
    const rootPath = realPathOrResolved(root);
    // 前タスクのbranch(task.branch)と、今回のbranchの両方を自分の作業ツリーとして扱う。
    // 同一worktreeでbranchを切り替える付け替えでも、残置宣言を見逃さないため。
    const branches = new Set([String(task.branch || '').trim(), branch].filter(Boolean));
    let entries = [];
    try {
      entries = readdirSync(workDir);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const full = join(workDir, name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      let declaration;
      try {
        declaration = parseDeclaration(readFileSync(full, 'utf8'));
      } catch {
        continue;
      }
      const status = String(declaration.status || '').toLowerCase();
      if (
        declaration.repo === task.repo
        && declaration.task_id === prevTaskId
        && !['done', 'cancelled', 'failed'].includes(status)
        && declarationTargetsWorktree(declaration, { rootPath, branches })
      ) {
        fail([
          `前タスク(${prevTaskId})のactive作業宣言がこの作業ツリーに残っています: ${full}。稼働中タスクを上書きできません`,
          `この作業ツリー: ${rootPath}（別worktreeのレーンなら、その宣言に worktree: <作業ツリーの絶対パス> を書いてください）`,
        ]);
      }
    }
  }

  // 新taskIdの再利用検査。
  const newCompletedPath = join(completedDir, `${newTaskId}.md`);
  if (existsSync(newCompletedPath)) {
    fail(`新taskId(${newTaskId})は完了履歴に既存です: ${newCompletedPath}`);
  }

  const backupPath = archiveCurrentTask(root, task);
  try {
    repointCurrentTask(root, task, {
      task: newTask,
      taskId: newTaskId,
      taskFingerprint: newFingerprint,
      branch,
      surfaceKind,
      deploymentKind,
    });
  } catch (error) {
    // 拒否時はcurrent-task.jsonを一切変えていないので、取ったバックアップも残さない。
    // 残すと、引数を試行錯誤しただけで.ai/backups/current-task/が実体のない履歴で埋まる。
    try {
      rmSync(backupPath, { force: true });
    } catch {
      // 消せなくても停止理由は変わらないため、拒否メッセージをそのまま返す。
    }
    fail(error.message.split('\n'));
  }
  console.log(`TASK_ROLLOVER_APPLIED: ${prevTaskId || '(初期状態)'} -> ${newTaskId}`);
  console.log(`  backup: ${backupPath}`);
  console.log('次の手順:');
  console.log(`  1) ${aiCmd('approval', 'create --input <完成図入力.json>')}（userAgreementQuotes、全nonGoalsのagreementCheck、completionCriteriaの引用index参照を含める）`);
  console.log(`  2) ${aiCmd('approval', 'approve --user-confirmed --by <承認者>')}`);
  console.log('  3) 作業宣言を作成(agent-coordination)してから実装を開始');
  process.exit(0);
}

if (command === 'bind-review-chain') {
  // web_uiネイティブ連鎖の実装主体を、実在するCodexネイティブセッション集合として束縛する。
  // approval.jsonは触らず、current-task.jsonだけをatomicに更新する。
  rejectDuplicateOptions([
    '--task-id', '--fingerprint', '--expect-task-sha256', '--expect-approval-sha256',
    '--model', '--effort', '--review-chain-version', '--alias-session', '--session-root',
  ]);
  let bound;
  try {
    bound = await bindReviewChainBinding(root, task, {
      taskId: option('--task-id'),
      fingerprint: option('--fingerprint'),
      expectTaskSha256: option('--expect-task-sha256'),
      expectApprovalSha256: option('--expect-approval-sha256'),
      model: option('--model'),
      effort: option('--effort'),
      reviewChainVersion: option('--review-chain-version'),
      aliasSession: option('--alias-session'),
      sessionFiles: optionList('--session-file'),
      reviewOutputPaths: optionList('--review-output-path'),
      requestedSessionRoot: process.argv.includes('--session-root') ? option('--session-root') : undefined,
    });
  } catch (error) {
    fail(String(error?.message || error).split('\n'));
  }
  console.log(`REVIEW_CHAIN_BOUND: ${bound.alias}`);
  console.log(`  sessions: ${bound.sessionIds.length}`);
  console.log(`  sessionsHash: ${bound.sessionsHash}`);
  console.log(`  reviewOutputPaths: ${bound.reviewOutputPaths.length}`);
  console.log('  approval.json: untouched');
  process.exit(0);
}

if (command === 'append-review-implementer') {
  rejectDuplicateOptions([
    '--task-id', '--fingerprint', '--expect-task-sha256', '--expect-approval-sha256',
    '--model', '--effort', '--review-chain-version', '--session-file', '--session-root',
  ]);
  let appended;
  try {
    appended = await appendReviewImplementerBinding(root, task, {
      taskId: option('--task-id'),
      fingerprint: option('--fingerprint'),
      expectTaskSha256: option('--expect-task-sha256'),
      expectApprovalSha256: option('--expect-approval-sha256'),
      model: option('--model'),
      effort: option('--effort'),
      reviewChainVersion: option('--review-chain-version'),
      sessionFiles: optionList('--session-file'),
      requestedSessionRoot: process.argv.includes('--session-root') ? option('--session-root') : undefined,
    });
  } catch (error) {
    fail(String(error?.message || error).split('\n'));
  }
  console.log(`REVIEW_IMPLEMENTER_APPENDED: ${appended.appended}`);
  console.log(`  sessions: ${appended.sessionIds.length}`);
  console.log(`  sessionsHash: ${appended.sessionsHash}`);
  console.log(`  alias: ${appended.alias}`);
  console.log('  approval.json: untouched');
  process.exit(0);
}

if (command === 'append-pre-review-implementer') {
  rejectDuplicateOptions([
    '--task-id', '--fingerprint', '--expect-task-sha256', '--expect-approval-sha256',
    '--model', '--effort', '--review-chain-version', '--session-file', '--session-root',
  ]);
  let appended;
  try {
    appended = await appendPreReviewImplementerBinding(root, task, {
      taskId: option('--task-id'),
      fingerprint: option('--fingerprint'),
      expectTaskSha256: option('--expect-task-sha256'),
      expectApprovalSha256: option('--expect-approval-sha256'),
      model: option('--model'),
      effort: option('--effort'),
      reviewChainVersion: option('--review-chain-version'),
      sessionFiles: optionList('--session-file'),
      requestedSessionRoot: process.argv.includes('--session-root') ? option('--session-root') : undefined,
    });
  } catch (error) {
    fail(String(error?.message || error).split('\n'));
  }
  console.log(`REVIEW_PRE_REVIEW_IMPLEMENTER_APPENDED: ${appended.appended}`);
  console.log(`  sessions: ${appended.sessionIds.length}`);
  console.log(`  sessionsHash: ${appended.sessionsHash}`);
  console.log(`  alias: ${appended.alias}`);
  console.log('  approval.json: untouched');
  process.exit(0);
}

let previousRevision = 0;
const previous = loadApproval(root, task, { requireApproved: false });
if (previous.approval?.taskId === task.taskId && Number.isInteger(previous.approval.revision)) {
  previousRevision = previous.approval.revision;
}

if (command === 'review-decision') {
  rejectDuplicateOptions(['--escalation-id', '--decision']);
  const loaded = loadApproval(root, task);
  if (loaded.errors.length) fail(loaded.errors);
  try {
    const result = applyReviewEscalationDecision(root, task, loaded.approval, {
      escalationId: option('--escalation-id'),
      decision: option('--decision'),
    });
    console.log(`REVIEW_ESCALATION_DECISION_RECORDED: ${result.decision.escalationId}`);
    console.log(`  decision: ${result.decision.decision}`);
    console.log(`  revision: ${result.approval.revision}`);
    process.exit(0);
  } catch (error) {
    fail(error.message.split('\n'));
  }
}

if (command === 'create') {
  const input = readInput('--input', '簡易完成図入力');
  const builtDraft = buildDraftApproval(task, input, {
    revision: previousRevision + 1,
    classification: previous.approval?.taskId === task.taskId ? previous.approval : undefined,
  });
  const { draft, count: autofilledNonGoals } = autofillSimpleNonGoalAgreementChecks(builtDraft);
  if (autofilledNonGoals > 0) console.log(`APPROVAL_GATE_AUTOFILLED nonGoals=${autofilledNonGoals}`);
  const check = validateDraftBeforeSave(draft);
  const path = saveApproval(root, draft);
  console.log(`APPROVAL_DRAFT_SAVED: ${path}`);
  for (const warning of check.warnings) console.warn(`APPROVAL_WARNING: ${warning}`);
  process.exit(0);
}

if (command === 'import-spec') {
  let imported;
  try {
    imported = specLeaderSource(root, option('--handoff'));
  } catch (error) {
    fail(error.message);
  }
  const conditions = Array.isArray(imported.core?.completionConditions?.items)
    ? imported.core.completionConditions.items
    : [];
  const completionCriteria = conditions.map((item) => {
    const verification = typeof item?.verification === 'string' && item.verification.trim()
      ? `（確認: ${item.verification.trim()}）`
      : '';
    return `${item?.description || item?.id || ''}${verification}`.trim();
  }).filter(Boolean);
  const nonGoals = [
    ...(Array.isArray(imported.core?.outOfScope?.items) ? imported.core.outOfScope.items : []),
    ...(Array.isArray(imported.core?.outOfScope?.rawItems) ? imported.core.outOfScope.rawItems : []),
  ].filter((item) => typeof item === 'string' && item.trim());
  const openQuestions = conditions
    .filter((item) => item?.unverifiable)
    .map((item) => `完了条件「${item?.description || item?.id || '不明'}」の確認方法が未解決です`);
  if (completionCriteria.length === 0) openQuestions.push('spec-leader成果物に機械判定できる完了条件がありません');
  const dataSources = Array.isArray(imported.core?.dataSources?.items) ? imported.core.dataSources.items : [];
  const rawDataSources = Array.isArray(imported.core?.dataSources?.rawItems)
    ? imported.core.dataSources.rawItems
    : [];
  const assumptions = [
    ...dataSources.map((item) => `${item.data}の正本は${item.sourceOfTruth}`),
    ...rawDataSources
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => `正データ候補（未構造化）: ${item.trim()}`),
  ];
  const warnings = Array.isArray(imported.core?.warnings) ? imported.core.warnings : [];
  const concerns = warnings.map((warning) => ({
    problem: String(warning),
    userImpact: '設計の読み違いまたは検証漏れにつながる可能性があります',
    recommendation: '実装開始前にhandoff原本と受け入れチェックリストで確認してください',
  }));
  const source = {
    type: 'spec-leader',
    project: imported.core.project,
    exportedAt: imported.core.generatedAt,
    handoffDir: relative(root, imported.directory),
    files: imported.files,
  };
  const importedInput = optionalInput('--input', 'spec-leader合意追記入力');
  if (!importedInput || typeof importedInput !== 'object' || Array.isArray(importedInput)) {
    fail('spec-leader合意追記入力はobjectが必要です');
  }
  const editableFields = new Set(['userAgreementQuotes', 'completionCriteria', 'nonGoals', 'implementationPlan']);
  for (const key of Object.keys(importedInput)) {
    if (!editableFields.has(key)) fail(`spec-leader合意追記入力の未知fieldは使用できません: ${key}`);
  }
  const derivedNonGoals = nonGoals.length
    ? nonGoals
    : ['handoffに記載されていない機能・仕様は変更しない（agreementCheck: 矛盾なし(合意範囲外)）'];
  if (Object.hasOwn(importedInput, 'nonGoals')) {
    if (!Array.isArray(importedInput.nonGoals)) fail('spec-leader合意追記入力のnonGoalsは配列が必要です');
    for (const original of nonGoals) {
      const originalText = original.trim();
      const preserved = importedInput.nonGoals.some((item) => {
        if (typeof item !== 'string') return false;
        const candidate = item.trim();
        if (candidate === originalText) return true;
        if (!candidate.startsWith(originalText)) return false;
        return /^\s*[（(]\s*agreementCheck\s*[:：]/u.test(candidate.slice(originalText.length));
      });
      if (!preserved) {
        fail(`spec-leader由来のnonGoalを合意追記入力から削除できません: ${original}`);
      }
    }
  }
  const extraCompletionCriteria = Object.hasOwn(importedInput, 'completionCriteria')
    ? importedInput.completionCriteria
    : [];
  if (!Array.isArray(extraCompletionCriteria)) {
    fail('spec-leader合意追記入力のcompletionCriteriaは配列が必要です');
  }
  const derivedInput = {
    vision: `spec-leaderでfinalize/exportされた「${imported.core.project}」の完成図を実装する`,
    deliverable_summary: '',
    userAgreementQuotes: imported.core?.userAgreementQuotes,
    completionCriteria: [...new Set([...completionCriteria, ...extraCompletionCriteria])],
    nonGoals: Object.hasOwn(importedInput, 'nonGoals') ? importedInput.nonGoals : derivedNonGoals,
    assumptions,
    openQuestions,
    concerns,
    ...(Object.hasOwn(importedInput, 'implementationPlan')
      ? { implementationPlan: importedInput.implementationPlan }
      : {}),
  };
  const draft = buildDraftApproval(task, {
    ...derivedInput,
    ...(Object.hasOwn(importedInput, 'userAgreementQuotes')
      ? { userAgreementQuotes: importedInput.userAgreementQuotes }
      : {}),
  }, {
    revision: previousRevision + 1,
    source,
    classification: previous.approval?.taskId === task.taskId ? previous.approval : undefined,
  });
  validateDraftBeforeSave(draft, { recoveryHint: agreementMigrationHint('import-spec') });
  const path = saveApproval(root, draft);
  console.log(`SPEC_LEADER_APPROVAL_DRAFT_SAVED: ${path}`);
  console.log(`  handoff: ${source.handoffDir}`);
  console.log(`  openQuestions: ${openQuestions.length}`);
  process.exit(0);
}

if (command === 'update') {
  const loaded = loadApproval(root, task, { requireApproved: false, allowAgreementRepairDraft: true });
  if (loaded.errors.length) fail(loaded.errors);
  const hasSurfaceKind = process.argv.includes('--surface-kind');
  const hasDeploymentKind = process.argv.includes('--deployment-kind');
  if (hasSurfaceKind || hasDeploymentKind) {
    rejectDuplicateOptions(['--surface-kind', '--deployment-kind', '--reason']);
    if (process.argv.includes('--input')) {
      fail('種別訂正と完成図本文のupdateは同時に実行できません');
    }
    const reason = option('--reason').trim();
    if (!reason) fail('--reasonは空にできません');
    try {
      const result = applyTaskClassificationCorrection(root, task, loaded.approval, {
        surfaceKind: hasSurfaceKind ? option('--surface-kind').trim() : undefined,
        deploymentKind: hasDeploymentKind ? option('--deployment-kind').trim() : undefined,
        reason,
      });
      console.log(`TASK_CLASSIFICATION_CORRECTED: ${result.correction.from.surfaceKind} -> ${result.correction.to.surfaceKind}`);
      console.log(`  revision: ${result.approval.revision}`);
      console.log(`  reason: ${result.correction.reason}`);
      for (const warning of result.warnings) console.log(`  warning: ${warning}`);
      console.log('次の手順: 訂正後の種別に合うE2E証跡を作り直してから、レビューと完了確認を続けてください。');
      if (result.task.surfaceKind === 'non_web') {
        console.log('  完了前にactive作業宣言のe2e_kindを実態に合う値へ設定してください。');
      }
      process.exit(0);
    } catch (error) {
      fail(error.message.split('\n'));
    }
  }
  if (loaded.approval.status === 'approved') {
    fail('承認済み完成図は直接更新できません。先に reopen で実装を停止してください');
  }
  const input = readInput('--input', '完成図更新入力');
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('完成図更新入力はobjectが必要です');
  const editableFields = new Set([
    'vision', 'deliverable_summary', 'userAgreementQuotes', 'completionCriteria', 'nonGoals', 'assumptions',
    'openQuestions', 'concerns', 'implementationPlan',
  ]);
  for (const key of Object.keys(input)) {
    if (!editableFields.has(key)) fail(`完成図更新入力の未知fieldは使用できません: ${key}`);
  }
  if (Object.keys(input).length === 0) fail('完成図更新入力には1項目以上必要です');
  const merged = Object.fromEntries(
    [...editableFields].map((field) => [field, Object.hasOwn(input, field) ? input[field] : loaded.approval[field]]),
  );
  const draft = buildDraftApproval(task, merged, {
    revision: loaded.approval.revision + 1,
    source: loaded.approval.source,
    classification: loaded.approval,
  });
  const legacyDraft = !Object.hasOwn(loaded.approval, 'userAgreementQuotes');
  const migratingAgreement = Object.hasOwn(input, 'userAgreementQuotes');
  if (legacyDraft && Object.hasOwn(input, 'nonGoals') && !migratingAgreement) {
    fail(agreementMigrationHint());
  }
  if (legacyDraft && !migratingAgreement) {
    delete draft.userAgreementQuotes;
    draft.documentHash = approvalContentHash(draft);
  }
  validateDraftBeforeSave(draft, {
    allowLegacyDraft: legacyDraft && !migratingAgreement,
    recoveryHint: agreementMigrationHint(),
  });
  const path = saveApproval(root, draft);
  console.log(`APPROVAL_DRAFT_UPDATED: ${path}`);
  console.log(`  revision: ${draft.revision}`);
  console.log(`  openQuestions: ${draft.openQuestions.length}`);
  process.exit(0);
}

if (command === 'approve') {
  if (!process.argv.includes('--user-confirmed')) {
    fail('明示的なユーザー承認後に --user-confirmed を付けてください');
  }
  const loaded = loadApproval(root, task, { requireApproved: false });
  if (loaded.errors.length) {
    const legacyHint = loaded.approval && !Object.hasOwn(loaded.approval, 'userAgreementQuotes')
      ? [agreementMigrationHint()]
      : [];
    fail([...loaded.errors, ...legacyHint]);
  }
  let approved;
  try {
    approved = approveDocument(root, task, loaded.approval, option('--by'));
  } catch (error) {
    fail(error.message.split('\n'));
  }
  const path = saveApproval(root, approved);
  console.log(`APPROVAL_RECORDED: ${path}`);
  console.log(`  contentHash: ${approved.approval.approvedContentHash}`);
  for (const warning of approved.approval.warnings) console.warn(`APPROVAL_WARNING: ${warning}`);
  process.exit(0);
}

if (command === 'reopen') {
  const loaded = loadApproval(root, task);
  if (loaded.errors.length) fail(loaded.errors);
  const reason = option('--reason').trim();
  if (!reason) fail('--reasonは空にできません');
  const reopened = {
    ...loaded.approval,
    status: 'needs_wall',
    revision: loaded.approval.revision + 1,
    openQuestions: [...loaded.approval.openQuestions, reason],
    approval: null,
  };
  reopened.documentHash = approvalContentHash(reopened);
  const path = saveApproval(root, reopened);
  console.log(`APPROVAL_REOPENED: ${path}`);
  console.log('実装を停止し、事実 / 仮判断 / 推奨案 / 質問1つで壁打ちしてください。');
  process.exit(0);
}

fail(`未知のcommandです: ${command}（create / import-spec / update / approve / verify / status / reopen / next-task / review-decision / bind-review-chain / append-review-implementer / append-pre-review-implementer）`);
