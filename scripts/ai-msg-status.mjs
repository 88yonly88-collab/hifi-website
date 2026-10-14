/**
 * agmsg Manager 最小版 - status コマンド
 *
 * 目的:
 *  1. agmsg で「違うリポジトリ」のメッセージを受け取る事故を防ぐため、
 *     .ai/current-task.json の repo / branch と、実際の git の状態を突き合わせて検証する。
 *  2. agmsg を毎回手打ちする運用を減らすため、現在のタスク設定をまとめて表示する。
 *
 * 表示内容:
 *  - .ai/current-task.json の内容
 *  - 現在の git repo 名
 *  - 現在の git branch
 *  - git status --short
 *  - current-task.json の repo と実 repo の一致判定
 *  - current-task.json の branch と実 branch の一致判定
 *  - 不一致があれば警告
 *
 * 使い方:
 *   node scripts/ai-msg-status.mjs
 *
 * 終了コード:
 *   0  repo / branch ともに一致（agmsg を使ってよい状態）
 *   1  不一致あり（agmsg を使う前に確認が必要）
 *   2  .ai/current-task.json が無い・壊れているなど致命的エラー
 *
 * ※ 今回は status のみ。agmsg 送信 / inbox 取得 / review-send / review-check は未実装。
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { gitOutput } from './ai-workflow-lib.mjs';
import { actualRepoName } from './ai-e2e-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const taskFile = join(root, '.ai', 'current-task.json');

/** git コマンドをリポジトリルートで実行。失敗時は null を返す。
 * execFileSync直呼びだと一部sandboxで「実終了0なのにspawnSync EPERM」が付き、
 * 成功した実行を失敗扱いにする。回収処理を持つ共通の gitOutput を使う。 */
function git(args) {
  try {
    return gitOutput(args, { cwd: root });
  } catch {
    return null;
  }
}

// --- .ai/current-task.json 読み込み ---
if (!existsSync(taskFile)) {
  console.error('✗ .ai/current-task.json が見つかりません。先にタスク設定ファイルを作成してください。');
  process.exit(2);
}

let task;
try {
  task = JSON.parse(readFileSync(taskFile, 'utf8'));
} catch (e) {
  console.error(`✗ .ai/current-task.json の読み込みに失敗しました: ${e.message}`);
  process.exit(2);
}

// --- 実際の git 状態 ---
// repo名はai-e2e-lib.mjsの共通解決を使う（worktreeでもフォルダ名でなく元repo名）。
let actualRepo = null;
let repoResolutionError = '';
try {
  actualRepo = actualRepoName(root) || null;
} catch (error) {
  repoResolutionError = String(error?.message || error || '実git repo名を取得できません');
}
const actualBranch = (git(['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();
const statusShort = git(['status', '--short']);

// --- 一致判定 ---
const repoMatches = Boolean(task.repo) && task.repo === actualRepo;
const branchMatches = Boolean(task.branch) && task.branch === actualBranch;

// --- 表示 ---
console.log('=== agmsg current task (.ai/current-task.json) ===');
console.log(JSON.stringify(task, null, 2));
console.log('');
console.log('=== git ===');
console.log(`  repo (origin) : ${actualRepo ?? '(判定不可)'}`);
console.log(`  branch        : ${actualBranch || '(判定不可)'}`);
console.log('');
console.log('=== git status --short ===');
console.log(statusShort && statusShort.trim() ? statusShort.replace(/\n$/, '') : '  (クリーン)');
console.log('');
console.log('=== 一致確認 ===');
console.log(`  repo  : ${repoMatches ? '✓ 一致' : '✗ 不一致'}  (設定='${task.repo ?? ''}' / 実='${actualRepo ?? ''}')`);
console.log(`  branch: ${branchMatches ? '✓ 一致' : '✗ 不一致'}  (設定='${task.branch ?? ''}' / 実='${actualBranch}')`);

const warnings = [];
if (repoResolutionError) warnings.push(repoResolutionError);
else if (!repoMatches) {
  warnings.push('repo が一致しません。違うリポジトリで agmsg を使おうとしている可能性があります。');
}
if (!branchMatches) {
  warnings.push('branch が一致しません。current-task.json の branch を現在のブランチに更新してください。');
}

if (warnings.length > 0) {
  console.log('');
  console.log('=== ⚠ 警告 ===');
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  process.exit(1);
}

console.log('');
console.log('✓ repo / branch ともに一致。agmsg を使えます。');
process.exit(0);
