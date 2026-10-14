/**
 * agmsg Manager - ai:pack（AI相談用 Markdown の自動生成）
 *
 * 目的:
 *   git status / git diff / 直近の実行ログ / current-task.json / package.json scripts
 *   などの作業状況を1つの Markdown にまとめ、AI（Claude Code / Codex reviewer）への
 *   相談時に毎回コピペする手間を減らす。
 *
 * 使い方:
 *   npm run ai:pack      （package.json のある repo）
 *   bash scripts/ai pack （standalone: package.json が無い repo）
 *
 * 出力先:
 *   .ai/context/ask-agent.md
 *
 * 含める内容:
 *   現在日時 / 実行ディレクトリ / current-task.json / git branch /
 *   git status --short / git diff --stat / git diff / latest-command.log /
 *   package.json scripts / AI への相談テンプレート
 *
 * セキュリティ:
 *   - .env / *.pem / *.key などは git diff から除外する
 *   - 読むログは .ai/logs/latest-command.log のみ（history/ は読まない）
 *   - .env / node_modules は読まない
 *
 * 制約:
 *   - 自動修正ループ / 自動 commit / 自動 push はしない
 *   - git diff・ログが長い場合は上限文字数で切り、省略した旨を明記する
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { aiCmd } from './ai-workflow-lib.mjs';

const root = process.cwd();
const contextDir = join(root, '.ai', 'context');
const outFile = join(contextDir, 'ask-agent.md');
const taskFile = join(root, '.ai', 'current-task.json');
const latestLog = join(root, '.ai', 'logs', 'latest-command.log');
const pkgFile = join(root, 'package.json');

const MAX_DIFF_CHARS = 12000;
const MAX_LOG_CHARS = 8000;
const MAX_HANDOFF_CHARS = 6000;

/**
 * spec-leader の handoff ファイル（受け入れチェックリスト / 実装中判断ログ）を探す。
 * リポジトリ直下 → handoff_<プロジェクト名>/（フォルダごとコピーされた形）→ handoff/ → docs/ の順で探す。
 */
function handoffSearchDirs() {
  const dirs = [''];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('handoff_')) dirs.push(entry.name);
    }
  } catch {
    // 読めない場合は固定候補のみで探す
  }
  dirs.push('handoff', 'docs');
  return dirs;
}

function findHandoffFile(fileName) {
  for (const dir of handoffSearchDirs()) {
    const p = join(root, dir, fileName);
    if (existsSync(p)) return p;
  }
  return null;
}

// git diff から秘密ファイルを除外する pathspec
const secretExcludes = [
  ':(exclude).env',
  ':(exclude).env.*',
  ':(exclude)*.env',
  ':(exclude).app-access-password.tmp',
  ':(exclude)*.pem',
  ':(exclude)*.key',
];

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

/**
 * git status --short の出力から秘密情報系ファイルの行を除外する。
 * 各行は "XY path"（rename は "XY old -> new"）形式。path 部分をパターン照合する。
 */
function filterSecretStatus(statusOutput) {
  return statusOutput
    .split('\n')
    .filter((line) => {
      if (!line.trim()) return false;
      const pathPart = line.slice(3); // 先頭2文字=ステータス + 空白1文字
      // rename "old -> new" は両側を見て、どちらかが秘密なら除外
      const candidates = pathPart.split(' -> ').map((s) => s.trim());
      return !candidates.some(isSecretPath);
    })
    .join('\n');
}

/** 長すぎる本文を上限で切り、省略した旨を付す。サロゲートペア中間で切らない。 */
function truncate(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + `\n\n…（長いため省略：先頭 ${max} 文字のみ表示）`;
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

const taskRaw = readIfExists(taskFile);
const logRaw = readIfExists(latestLog);

let scriptsBlock = '(package.json が読めませんでした)';
const pkgRaw = readIfExists(pkgFile);
if (pkgRaw) {
  try {
    const pkg = JSON.parse(pkgRaw);
    scriptsBlock = JSON.stringify(pkg.scripts ?? {}, null, 2);
  } catch {
    scriptsBlock = '(package.json の解析に失敗しました)';
  }
}

// spec-leader handoff（あれば同梱する）。同梱判定は trim 後の内容基準（空ファイルは「内容が空」扱い）。
const checklistPath = findHandoffFile('acceptance_checklist.md');
const decisionsLogPath = findHandoffFile('decisions_log.md');
const checklistText = (checklistPath && readIfExists(checklistPath)?.trim()) || null;
const decisionsLogText = (decisionsLogPath && readIfExists(decisionsLogPath)?.trim()) || null;
const hasHandoff = Boolean(checklistText || decisionsLogText);

const consultTemplate =
  '以下は現在の作業状況です。\n' +
  'ユーザーに追加のログ貼り付けを求めず、この情報をもとに原因分析・次の作業方針・' +
  'Claude Code / Codex reviewer に渡す指示文を作ってください。\n' +
  '不明点がある場合は、まずリポジトリ内のファイル・ログ・git diff を確認する前提で進めてください。' +
  (checklistText
    ? '\n設計書の受け入れチェックリスト（上記セクション）を完了基準として扱い、これと矛盾する助言をしないでください。'
    : '');

// handoff がある場合はセクション 10・11 に入れ、相談テンプレートの番号を繰り下げる
const handoffSection = hasHandoff
  ? `
## 10. 受け入れチェックリスト（spec-leader handoff）
${checklistText
    ? `出典: ${checklistPath}\n\n${truncate(checklistText, MAX_HANDOFF_CHARS)}`
    : checklistPath
      ? `(${checklistPath} はありますが内容が空です)`
      : '(acceptance_checklist.md が見つかりません)'}

## 11. 実装中判断ログ（decisions_log.md）
${decisionsLogText
    ? `出典: ${decisionsLogPath}\n\n${truncate(decisionsLogText, MAX_HANDOFF_CHARS)}`
    : decisionsLogPath
      ? `(${decisionsLogPath} はありますが内容が空です)`
      : '(decisions_log.md が見つかりません)'}
`
  : '';
const consultSectionNo = hasHandoff ? 12 : 10;

// --- Markdown 生成 ---
const md = `# AI相談パック (ask-agent.md)

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

## 8. .ai/logs/latest-command.log
\`\`\`
${logRaw ? truncate(logRaw.trim(), MAX_LOG_CHARS) : `(latest-command.log がありません。${aiCmd('run')} でコマンドを実行すると生成されます)`}
\`\`\`

## 9. package.json の scripts
\`\`\`json
${scriptsBlock}
\`\`\`
${handoffSection}
## ${consultSectionNo}. AIへの相談テンプレート
${consultTemplate}
`;

// --- 保存 ---
mkdirSync(contextDir, { recursive: true });
writeFileSync(outFile, md, 'utf8');

console.log('=== ai:pack ===');
console.log(`  生成しました: ${outFile}`);
console.log(`  branch      : ${branch}`);
console.log(`  diff        : ${diffRaw.length > MAX_DIFF_CHARS ? `切詰め（${MAX_DIFF_CHARS}文字）` : `${diffRaw.length}文字`}`);
console.log(`  latest log  : ${logRaw ? `含む（${Math.min(logRaw.length, MAX_LOG_CHARS)}文字）` : 'なし'}`);
console.log(`  合格基準    : ${checklistText
  ? '含む（acceptance_checklist.md）'
  : checklistPath
    ? '配置済みだが内容が空（acceptance_checklist.md）'
    : 'なし（spec-leader handoff 未配置）'}`);
console.log('');
console.log('→ このファイルを AI（ChatGPT / Claude Code / Codex reviewer）に渡してください。');
