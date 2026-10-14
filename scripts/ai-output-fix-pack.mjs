/**
 * agmsg Manager - ai:output-fix-pack（出力物修正 相談用 Markdown の自動生成）
 *
 * 目的:
 *   生成物・JSON・プロンプト・ストーリーボード・画像生成指示などの「出力が意図と違う時」に、
 *   .ai/requests/output-fix.md（修正依頼）と現在の作業状況を1つの Markdown にまとめ、
 *   AI（Claude Code / Codex reviewer）への相談時に毎回コピペする手間を減らす。
 *
 * 使い方:
 *   npm run ai:output-fix-pack      （package.json のある repo）
 *   bash scripts/ai output-fix-pack （standalone: package.json が無い repo）
 *
 * 入力:
 *   .ai/requests/output-fix.md（無ければ初期テンプレートを作成し、記入を促して終了）
 *
 * 出力先:
 *   .ai/context/output-fix-pack.md
 *
 * 含める内容:
 *   現在日時 / 実行ディレクトリ / current-task.json / output-fix.md / git branch /
 *   git status --short / git diff --stat / git diff / latest-command.log /
 *   package.json scripts / AI への相談テンプレート
 *
 * セキュリティ:
 *   - .env / .env.* / *.pem / *.key / *.token などは git diff・git status から除外する
 *   - 読むログは .ai/logs/latest-command.log のみ（history/ は読まない）
 *   - .env / node_modules は読まない
 *
 * 制約:
 *   - 自動修正ループ / 自動 commit / 自動 push はしない
 *   - git diff・ログが長い場合は上限文字数で切り、省略した旨を明記する
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { aiCmd } from './ai-workflow-lib.mjs';

const root = process.cwd();
const contextDir = join(root, '.ai', 'context');
const requestsDir = join(root, '.ai', 'requests');
const outFile = join(contextDir, 'output-fix-pack.md');
const requestFile = join(requestsDir, 'output-fix.md');
const taskFile = join(root, '.ai', 'current-task.json');
const latestLog = join(root, '.ai', 'logs', 'latest-command.log');
const pkgFile = join(root, 'package.json');

const MAX_DIFF_CHARS = 12000;
const MAX_LOG_CHARS = 8000;

// .ai/requests/output-fix.md が無いときに作る初期テンプレート
const OUTPUT_FIX_TEMPLATE = `# 出力物修正依頼

## 修正したい出力物

例：
- 画像生成プロンプト
- JSON出力
- ストーリーボード
- 生成ログ
- UI表示
- Markdown
- 台本出力

## 現在の出力

ここに現在の出力を貼る、またはファイルパスを書く。

## 何が問題か

-

## 理想の出力

-

## 修正してよい範囲

-

## 修正してはいけない範囲

-

## 再生成が必要か

必要 / 不要 / 不明

## 完了条件

-

## 注意点

- 既存データ構造を壊さない
- 他の出力形式に影響を出さない
- 一気に全部直さず、対象出力だけ直す
`;

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

// --- 入力ファイルの用意（無ければ初期テンプレートを作って終了） ---
mkdirSync(requestsDir, { recursive: true });
if (!existsSync(requestFile)) {
  writeFileSync(requestFile, OUTPUT_FIX_TEMPLATE, 'utf8');
  console.log('=== ai:output-fix-pack ===');
  console.log(`  初期テンプレートを作成しました: ${requestFile}`);
  console.log('');
  console.log('→ output-fix.md を記入してから再実行してください。');
  process.exit(0);
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

const requestRaw = readIfExists(requestFile);
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

const consultTemplate =
  '以下は出力物修正の相談です。\n' +
  'ユーザーに追加のログ貼り付けを求めず、この情報をもとに、現在出力と理想出力の差分を分析してください。\n' +
  '問題の原因が、仕様・実装・プロンプト・入力データのどこにありそうかを切り分けてください。\n' +
  'そのうえで、最小修正案、変更対象候補、影響範囲、検証方法、Claude Codeに渡す修正指示文を作ってください。\n' +
  '既存データ構造や他の出力形式を壊さないことを優先してください。';

// --- Markdown 生成 ---
const md = `# 出力物修正パック (output-fix-pack.md)

## 1. 現在日時
${now}

## 2. 実行ディレクトリ
${root}

## 3. .ai/current-task.json
\`\`\`json
${taskRaw ? taskRaw.trim() : '(.ai/current-task.json がありません)'}
\`\`\`

## 4. .ai/requests/output-fix.md
${requestRaw ? requestRaw.trim() : '(.ai/requests/output-fix.md がありません)'}

## 5. git branch
${branch}

## 6. git status --short
\`\`\`
${statusShort || '(クリーン)'}
\`\`\`

## 7. git diff --stat
\`\`\`
${diffStat || '(変更なし)'}
\`\`\`

## 8. git diff
\`\`\`diff
${truncate(diffRaw, MAX_DIFF_CHARS) || '(変更なし)'}
\`\`\`

## 9. .ai/logs/latest-command.log
\`\`\`
${logRaw ? truncate(logRaw.trim(), MAX_LOG_CHARS) : `(latest-command.log がありません。${aiCmd('run')} でコマンドを実行すると生成されます)`}
\`\`\`

## 10. package.json の scripts
\`\`\`json
${scriptsBlock}
\`\`\`

## 11. AIへの相談テンプレート
${consultTemplate}
`;

// --- 保存 ---
mkdirSync(contextDir, { recursive: true });
writeFileSync(outFile, md, 'utf8');

console.log('=== ai:output-fix-pack ===');
console.log(`  生成しました: ${outFile}`);
console.log(`  request     : ${requestFile}`);
console.log(`  branch      : ${branch}`);
console.log(`  diff        : ${diffRaw.length > MAX_DIFF_CHARS ? `切詰め（${MAX_DIFF_CHARS}文字）` : `${diffRaw.length}文字`}`);
console.log(`  latest log  : ${logRaw ? `含む（${Math.min(logRaw.length, MAX_LOG_CHARS)}文字）` : 'なし'}`);
console.log('');
console.log('→ このファイルを AI（Claude Code / Codex reviewer）に渡してください。');
