/**
 * agmsg Manager - ai:start（作業開始時の現状把握パックの自動生成）
 *
 * 目的:
 *   翌日や別 AI への引き継ぎ時に、前回の作業終了メモ（close.md）と現在の git 状態・
 *   current-task を1つの Markdown にまとめ、「現状を誤解したまま変な修正をされる」リスクを減らす。
 *   作業開始時に AI が最初に読むべき情報をまとめ、ユーザーを中継係に戻さない。
 *
 * 使い方:
 *   npm run ai:start      （package.json のある repo）
 *   bash scripts/ai start （standalone: package.json が無い repo）
 *
 * 出力先:
 *   .ai/context/start.md
 *
 * 含める内容:
 *   現在日時 / 実行ディレクトリ / current-task.json / git branch /
 *   git status --short / 最新コミット / close.md（あれば）/
 *   latest-command.log（あれば）/ review-result.md（あれば）/ 開始プロンプト
 *
 * セキュリティ:
 *   - .env / .env.* / *.pem / *.key / *.token などは git status から除外する
 *   - 読むログは .ai/logs/latest-command.log のみ（history/ は読まない）
 *   - .env / node_modules は読まない
 *
 * 制約:
 *   - 自動修正ループ / 自動 commit / 自動 push はしない
 *   - ログが長い場合は上限文字数で切り、省略した旨を明記する
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { aiCmd } from './ai-workflow-lib.mjs';
import { loadApproval } from './ai-approval-lib.mjs';
import { noteImplementationEntry } from './ai-review-cycle-lib.mjs';

const root = process.cwd();
noteImplementationEntry(root, { stage: 'ai-start', mode: 'display' });
const contextDir = join(root, '.ai', 'context');
const outFile = join(contextDir, 'start.md');
const taskFile = join(root, '.ai', 'current-task.json');
const latestLog = join(root, '.ai', 'logs', 'latest-command.log');
const closeFile = join(contextDir, 'close.md');
const reviewResult = join(contextDir, 'review-result.md');

const MAX_LOG_CHARS = 8000;
const MAX_DOC_CHARS = 12000;

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
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
const latestCommit = git(['log', '-1', '--stat', '--no-color']) || '(コミットがありません)';

const taskRaw = readIfExists(taskFile);
let task;
try {
  task = taskRaw ? JSON.parse(taskRaw) : null;
} catch (error) {
  console.error(`APPROVAL_GATE_REJECTED: current-task.jsonを読めません: ${error.message}`);
  process.exit(2);
}
if (!task) {
  console.error('APPROVAL_GATE_REJECTED: .ai/current-task.jsonがありません');
  process.exit(2);
}
const approvalResult = loadApproval(root, task);
if (approvalResult.errors.length) {
  for (const error of approvalResult.errors) console.error(`APPROVAL_GATE_REJECTED: ${error}`);
  process.exit(2);
}
const approvalRaw = readFileSync(approvalResult.path, 'utf8');

const continuityCase = task.continuityCase || task.continuity?.case || '';
if (continuityCase) {
  const continuityOwner = task.continuity?.owner || process.env.USER || 'parent';
  try {
    const continuityOut = execFileSync(process.execPath, [
      join(root, 'scripts', 'ai-task-continuity.mjs'),
      'tick',
      '--repo', root,
      '--case', continuityCase,
      '--owner', continuityOwner,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('[continuity] tick');
    console.log(continuityOut.trim());
  } catch (error) {
    console.error(`CONTINUITY_TICK_BLOCKED: ${String(error?.stderr || error?.message || error).trim()}`);
  }
}

const closeRaw = readIfExists(closeFile);
const logRaw = readIfExists(latestLog);
const reviewRaw = readIfExists(reviewResult);

const startPrompt =
  'これは作業開始時の現状把握パックです。\n' +
  'ユーザーにログや diff の貼り付けを求めず、まずこの start.md と前回の close.md、' +
  'リポジトリ内の現在状態（git / .ai/ / ログ）を自分で確認してください。\n' +
  '現在の Project / Repo / Branch / Task を current-task.json と実 git で照合し、' +
  'close.md の内容が現在の git 状態と矛盾しないか確認してから再開してください。\n' +
  '未完了事項から、今日最初にやるべき最小タスクを提案してください。' +
  '既存機能を壊さず、最小変更で進めてください。';

// --- Markdown 生成 ---
const md = `# 作業開始パック (start.md)

## 1. 現在日時
${now}

## 2. 実行ディレクトリ
${root}

## 3. .ai/current-task.json
\`\`\`json
${taskRaw ? taskRaw.trim() : '(.ai/current-task.json がありません)'}
\`\`\`

## 4. 承認済み完成図 (.ai/approval.json)
\`\`\`json
${approvalRaw.trim()}
\`\`\`

## 5. git branch
${branch}

## 6. git status --short
\`\`\`
${statusShort || '(クリーン)'}
\`\`\`

## 7. 最新コミット
\`\`\`
${latestCommit}
\`\`\`

## 8. .ai/context/close.md（前回の作業終了メモ）
${closeRaw ? truncate(closeRaw.trim(), MAX_DOC_CHARS) : `(close.md はありません。前回 ${aiCmd('close')} を実行すると生成されます)`}

## 9. .ai/logs/latest-command.log
\`\`\`
${logRaw ? truncate(logRaw.trim(), MAX_LOG_CHARS) : `(latest-command.log がありません。${aiCmd('run')} でコマンドを実行すると生成されます)`}
\`\`\`

## 10. .ai/context/review-result.md
${reviewRaw ? truncate(reviewRaw.trim(), MAX_DOC_CHARS) : `(review-result.md はありません。${aiCmd('review-check', '--verdict auto')} で取得できます)`}

## 11. 今日最初にやるための開始プロンプト
${startPrompt}
`;

// --- 保存 ---
mkdirSync(contextDir, { recursive: true });
writeFileSync(outFile, md, 'utf8');

console.log('=== ai:start ===');
console.log(`  生成しました: ${outFile}`);
console.log(`  branch      : ${branch}`);
console.log(`  close.md     : ${closeRaw ? '含む' : 'なし'}`);
console.log(`  latest log  : ${logRaw ? `含む（${Math.min(logRaw.length, MAX_LOG_CHARS)}文字）` : 'なし'}`);
console.log(`  review-result: ${reviewRaw ? '含む' : 'なし'}`);
console.log('');
console.log('→ このファイルを AI（Claude Code）に渡して、現状を確認してから再開してください。');
