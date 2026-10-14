/**
 * agmsg Manager - ai:close（作業終了メモの自動生成）
 *
 * 目的:
 *   作業終了時に、今日の作業内容・変更内容・実行ログ・残課題・次回開始メモを
 *   1つの Markdown にまとめる。「今日どこまでやったか」「次に何をするか」を
 *   毎回手作業でまとめる負担を減らす。
 *
 * 使い方:
 *   npm run ai:close      （package.json のある repo）
 *   bash scripts/ai close （standalone: package.json が無い repo）
 *
 * 出力先:
 *   .ai/context/close.md
 *
 * 含める内容:
 *   現在日時 / 実行ディレクトリ / current-task.json / git branch /
 *   git status --short / git diff --stat / git diff / 最新コミット /
 *   latest-command.log / review-result.md（あれば）/ ask-agent.md の有無 /
 *   今日できたこと / 未完了のこと / 次回最初にやること / 次回開始プロンプト
 *
 * セキュリティ:
 *   - .env / *.pem / *.key / *.token などは git diff・git status から除外する
 *   - 読むログは .ai/logs/latest-command.log のみ（history/ は読まない）
 *   - .env / node_modules は読まない
 *
 * 制約:
 *   - 自動修正ループ / 自動 commit / 自動 push はしない
 *   - git diff・ログが長い場合は上限文字数で切り、省略した旨を明記する
 *   - 「今日できたこと/未完了/次回やること」は判断材料を添えた記入欄として出力する
 */
import { readFileSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { aiCmd } from './ai-workflow-lib.mjs';
import {
  currentGitIdentity,
  gitFullOutput,
  validatePorcelainZ,
  isGitIntegrityError,
  parseDeclaration,
  readJson,
  safeId,
  validateNonWebEvidence,
  validatePassedEvidence,
} from './ai-e2e-lib.mjs';

const root = process.cwd();
const contextDir = join(root, '.ai', 'context');
const outFile = join(contextDir, 'close.md');
const taskFile = join(root, '.ai', 'current-task.json');
const latestLog = join(root, '.ai', 'logs', 'latest-command.log');
const reviewResult = join(contextDir, 'review-result.md');
const askAgent = join(contextDir, 'ask-agent.md');

const MAX_DIFF_CHARS = 12000;
const MAX_LOG_CHARS = 8000;

// git diff から秘密ファイルを除外する pathspec
const secretExcludes = [
  ':(exclude).env',
  ':(exclude).env.*',
  ':(exclude)*.env',
  ':(exclude).app-access-password.tmp',
  ':(exclude)*.pem',
  ':(exclude)*.key',
  ':(exclude)*.token',
];

function git(args) {
  try {
    return gitFullOutput(root, args).trim();
  } catch (error) {
    if (args[0] === 'status' && !isGitIntegrityError(error)) {
      // An actual completion may record a reasoned inspection-unavailable exception.
      // Preserve that fact in the report; it never means a clean working tree.
      try {
        const task = readJson(taskFile);
        const verification = readJson(join(contextDir, `completion-verification-${safeId(task.taskId)}.json`));
        const unavailable = verification.uncommittedChanges;
        if (verification.applied === true && unavailable?.allowed === true &&
            unavailable.detected === null && unavailable.inspectionError && unavailable.reason &&
            unavailable.skippedIdentityChecks?.includes('gitStatusHash')) {
          return `(取得不能: ${String(error.message).slice(0, 1000)}; 承認済み理由: ${unavailable.reason})`;
        }
      } catch { /* Missing or invalid completion proof must still reject. */ }
    }
    if (['status','diff'].includes(args[0])) throw error;
    return null;
  }
}

function gitStatusReadable() {
  try {
    validatePorcelainZ(gitFullOutput(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    return true;
  } catch (error) {
    if (String(error?.message || '').includes('GIT_OUTPUT_TOO_LARGE') || error?.code === 'ENOBUFS' || /maxBuffer|stdout maxBuffer length exceeded/iu.test(String(error?.message || ''))) {
      console.error('COMPLETION_GATE_REJECTED: git statusの出力が読み取り上限を超えました。変更を小分けにしてcommitしてから再実行してください');
      process.exit(2);
    }
    if (isGitIntegrityError(error)) {
      console.error(`COMPLETION_GATE_REJECTED: ${error.message}`);
      process.exit(2);
    }
    return false;
  }
}

/** ファイル名が秘密情報系（.env / *.pem / *.key / *.token 等）かどうか。中身は読まない。 */
function isSecretPath(p) {
  const name = p.split('/').pop() || p;
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    name === '.app-access-password.tmp' ||
    /\.(pem|key|token)$/.test(name)
  );
}

/** git status --short の出力から秘密情報系ファイルの行を除外する。 */
function filterSecretStatus(statusOutput) {
  return statusOutput
    .split('\n')
    .filter((line) => {
      if (!line.trim()) return false;
      const pathPart = line.slice(3); // 先頭2文字=ステータス + 空白1文字
      const candidates = pathPart.split(' -> ').map((s) => s.trim());
      return !candidates.some(isSecretPath);
    })
    .join('\n');
}

/** 長すぎる本文を上限で切り、省略した旨を付す。 */
function truncate(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n…（長いため省略：先頭 ${max} 文字のみ表示）`;
}

/** ファイル内容を読む。無ければ null。（対象を限定して安全に読む） */
function readIfExists(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

// --- 収集 ---
const now = new Date().toISOString();
const branch =
  git(['rev-parse', '--abbrev-ref', 'HEAD']) ||
  git(['symbolic-ref', '--short', 'HEAD']) ||
  '(判定不可)';
const statusShort = filterSecretStatus(git(['status', '--short']) || '');
const diffStat = git(['diff', '--stat', '--', '.', ...secretExcludes]) || '';
const diffRaw = git(['diff', '--no-color', '--', '.', ...secretExcludes]) || '';
const latestCommit = git(['log', '-1', '--stat', '--no-color']) || '(コミットがありません)';
// 今日のコミット（記入欄の手がかり用）
const sinceMidnight = new Date();
sinceMidnight.setHours(0, 0, 0, 0);
const todaysCommits =
  git(['log', `--since=${sinceMidnight.toISOString()}`, '--pretty=format:- %h %s']) || '';

const taskRaw = readIfExists(taskFile);
const logRaw = readIfExists(latestLog);
const reviewRaw = readIfExists(reviewResult);
const hasAskAgent = existsSync(askAgent);
let reviewProcess = null;

// taskIdを持つ新フローのclose.mdは完了報告として使われるため、surfaceを問わず
// 正本完了コマンドの適用証跡が無ければ拒否する。taskId未導入のlegacyは維持する。
if (taskRaw) {
  let task;
  try {
    task = JSON.parse(taskRaw);
  } catch {
    console.error('COMPLETION_GATE_REJECTED: .ai/current-task.jsonが壊れています');
    process.exit(2);
  }
  if (String(task.taskId || '').trim()) {
    try {
      task.taskId = safeId(task.taskId);
    } catch (error) {
      console.error(`COMPLETION_GATE_REJECTED: ${error.message}`);
      process.exit(2);
    }
    const completionVerification = join(contextDir, `completion-verification-${task.taskId}.json`);
    let verification;
    try {
      verification = readJson(completionVerification);
    } catch (error) {
      console.error(`COMPLETION_GATE_REJECTED: 完了適用証跡を読めません: ${error.message}`);
      process.exit(2);
    }
    reviewProcess = verification.reviewProcess || {
      codeReviewRounds: 0,
      codeReviewOutcome: 'unavailable',
      browserReviewOutcome: 'unavailable',
      browserReviewRounds: 0,
      warnings: ['完了検証JSONにreviewProcessがありません'],
    };
    for (const warning of Array.isArray(reviewProcess.warnings) ? reviewProcess.warnings : []) {
      console.log(`REVIEW_PROCESS_WARNING: ${warning}`);
    }
    const skippedIdentityChecks = new Set(
      verification.uncommittedChanges?.allowed === true &&
      verification.uncommittedChanges?.detected === null &&
      typeof verification.uncommittedChanges?.inspectionError === 'string' &&
      verification.uncommittedChanges.inspectionError.trim() &&
      typeof verification.uncommittedChanges?.reason === 'string' &&
      verification.uncommittedChanges.reason.trim()
        ? verification.uncommittedChanges.skippedIdentityChecks || []
        : [],
    );
    const statusRecovered = gitStatusReadable();
    const skipGitStatusHash = !statusRecovered && skippedIdentityChecks.has('gitStatusHash');
    const skipWorktreeHash = !statusRecovered && skippedIdentityChecks.has('worktreeHash');
    let identity;
    try {
      identity = currentGitIdentity(root);
    } catch (error) {
      if (isGitIntegrityError(error) || !skipGitStatusHash || !skipWorktreeHash) {
        console.error(`COMPLETION_GATE_REJECTED: 現在のGit状態を確認できません: ${error.message}`);
        process.exit(2);
      }
      identity = {
        branch: verification.branch,
        gitHead: verification.gitHead,
        gitStatusHash: null,
        worktreeHash: null,
      };
    }
    if (skipGitStatusHash || skipWorktreeHash) {
      const skipped = [skipGitStatusHash ? 'gitStatusHash' : '', skipWorktreeHash ? 'worktreeHash' : '']
        .filter(Boolean)
        .join(',');
      console.log(`COMPLETION_IDENTITY_SKIPPED: ${skipped}; reason=${verification.uncommittedChanges.reason}`);
    }
    let matches =
      verification.status === 'passed' &&
      verification.applied === true &&
      verification.taskId === task.taskId &&
      verification.taskFingerprint === task.taskFingerprint &&
      verification.repo === task.repo &&
      verification.branch === identity.branch &&
      verification.gitHead === identity.gitHead &&
      (skipGitStatusHash || verification.gitStatusHash === identity.gitStatusHash) &&
      (skipWorktreeHash || verification.worktreeHash === identity.worktreeHash) &&
      verification.e2eStatus === 'passed' &&
      verification.evidence &&
      verification.completedDeclaration &&
      existsSync(verification.completedDeclaration);
    if (matches) {
      try {
        const completedStat = lstatSync(verification.completedDeclaration);
        if (!completedStat.isFile() || completedStat.isSymbolicLink()) throw new Error('完了宣言がregular fileではありません');
        const completed = parseDeclaration(readFileSync(verification.completedDeclaration, 'utf8'));
        const evidence = readJson(verification.evidence);
        const expected = {
          root,
          taskId: task.taskId,
          taskFingerprint: task.taskFingerprint,
          repo: task.repo,
          branch: identity.branch,
          gitHead: identity.gitHead,
          ...(skipGitStatusHash ? {} : { gitStatusHash: identity.gitStatusHash }),
          ...(skipWorktreeHash ? {} : { worktreeHash: identity.worktreeHash }),
          startedAt: completed.started,
        };
        const evidenceErrors = task.surfaceKind === 'non_web'
          ? validateNonWebEvidence(evidence, { ...expected, e2eKind: completed.e2e_kind })
          : validatePassedEvidence(evidence, {
            ...expected,
            requireDeployGate: task.deploymentKind !== 'non_production',
          });
        if (
          task.surfaceKind === 'web_ui' &&
          !['production', 'non_production'].includes(String(task.deploymentKind || '').trim())
        ) {
          evidenceErrors.push('web_uiのcurrent-task.jsonはdeploymentKind=production|non_production必須です');
        }
        if (
          completed.status !== 'done' ||
          completed.progress !== '100' ||
          completed.review_status !== 'passed' ||
          completed.e2e_status !== 'passed' ||
          completed.e2e_evidence !== verification.evidence
        ) {
          evidenceErrors.push('完了宣言のdone/100/e2e_evidenceが適用証跡と一致しません');
        }
        matches = evidenceErrors.length === 0;
      } catch {
        matches = false;
      }
    }
    if (!matches) {
      console.error('COMPLETION_GATE_REJECTED: task/branch/worktree/review/E2E証跡と完了履歴が一致しません');
      process.exit(2);
    }
  }
}

const startPrompt =
  '前回の作業終了メモは以下です。\n' +
  'ユーザーにログやdiffの貼り付けを求めず、まずこのclose.mdとリポジトリ内の現在状態を確認してください。\n' +
  '現在のProject / Repo / Branch / Taskを確認し、未完了事項から次にやるべき最小タスクを提案してください。';

// --- Markdown 生成 ---
const md = `# 作業終了メモ (close.md)

## 1. 現在日時
${now}

## 2. 実行ディレクトリ
${root}

## 3. .ai/current-task.json
\`\`\`json
${taskRaw ? taskRaw.trim() : '(.ai/current-task.json がありません)'}
\`\`\`

## 4. git branch
${branch}

## 5. git status --short
\`\`\`
${statusShort || '(クリーン)'}
\`\`\`

## 6. git diff --stat
\`\`\`
${diffStat || '(変更なし)'}
\`\`\`

## 7. git diff
\`\`\`diff
${truncate(diffRaw, MAX_DIFF_CHARS) || '(変更なし)'}
\`\`\`

## 8. 最新コミット
\`\`\`
${latestCommit}
\`\`\`

## 9. .ai/logs/latest-command.log
\`\`\`
${logRaw ? truncate(logRaw.trim(), MAX_LOG_CHARS) : `(latest-command.log がありません。${aiCmd('run')} でコマンドを実行すると生成されます)`}
\`\`\`

## 10. .ai/context/review-result.md
${reviewRaw ? reviewRaw.trim() : `(review-result.md はありません。${aiCmd('review-check', '--verdict auto')} で取得できます)`}

## 11. reviewProcess
\`\`\`json
${reviewProcess ? JSON.stringify(reviewProcess, null, 2) : '(完了検証前のため未記録)'}
\`\`\`

## 12. .ai/context/ask-agent.md
${hasAskAgent ? `存在します（${aiCmd('pack')} で生成された相談用パックがあります）` : '(ask-agent.md はありません)'}

## 13. 今日できたこと
${todaysCommits ? `本日のコミット:\n${todaysCommits}\n\n（上記を踏まえて補足を記入）` : '（ここに記入）'}

## 14. 未完了のこと
${statusShort ? '※ 作業ツリーに未コミットの変更があります（上記 git status を参照）。\n\n（ここに記入）' : '（ここに記入）'}

## 15. 次回最初にやること
（ここに記入）

## 16. 次回Claude Codeに渡す開始プロンプト
${startPrompt}
`;

// --- 保存 ---
mkdirSync(contextDir, { recursive: true });
writeFileSync(outFile, md, 'utf8');

console.log('=== ai:close ===');
console.log(`  生成しました: ${outFile}`);
console.log(`  branch      : ${branch}`);
console.log(`  diff        : ${diffRaw.length > MAX_DIFF_CHARS ? `切詰め（${MAX_DIFF_CHARS}文字）` : `${diffRaw.length}文字`}`);
console.log(`  latest log  : ${logRaw ? `含む（${Math.min(logRaw.length, MAX_LOG_CHARS)}文字）` : 'なし'}`);
console.log(`  review-result: ${reviewRaw ? '含む' : 'なし'}`);
console.log('');
console.log('→ 13〜15（今日できたこと/未完了/次回やること）を記入して保存してください。');
