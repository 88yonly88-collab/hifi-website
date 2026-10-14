/**
 * agmsg Manager - ai:feature-pack（追加機能 相談用 Markdown の自動生成）
 *
 * 目的:
 *   追加機能を作る前に、目的・作業範囲・やらないこと・リスク・検証方法を整理する。
 *   .ai/requests/feature.md（追加機能依頼）と現在の作業状況を1つの Markdown にまとめ、
 *   AI（Claude Code / Codex reviewer）への相談時に毎回コピペする手間を減らす。
 *
 * 使い方:
 *   npm run ai:feature-pack      （package.json のある repo）
 *   bash scripts/ai feature-pack （standalone: package.json が無い repo）
 *
 * 入力:
 *   .ai/requests/feature.md（無ければ初期テンプレートを作成し、記入を促して終了）
 *
 * 出力先:
 *   .ai/context/feature-pack.md
 *
 * 含める内容:
 *   現在日時 / 実行ディレクトリ / current-task.json / feature.md / git branch /
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
const outFile = join(contextDir, 'feature-pack.md');
const requestFile = join(requestsDir, 'feature.md');
const taskFile = join(root, '.ai', 'current-task.json');
const latestLog = join(root, '.ai', 'logs', 'latest-command.log');
const pkgFile = join(root, 'package.json');

const MAX_DIFF_CHARS = 12000;
const MAX_LOG_CHARS = 8000;

// .ai/requests/feature.md が無いときに作る初期テンプレート
const FEATURE_TEMPLATE = `# 追加機能依頼

## 追加したい機能

例：

* 新しいボタンを追加したい
* 出力形式を増やしたい
* 既存フローに確認画面を追加したい
* 生成結果を保存できるようにしたい

## なぜ必要か

*

## 現在困っていること

*

## 理想の動き

*

## 今日の作業時間

最大6時間

## 今日やる範囲

*

## 今日やらない範囲

*

## 完了条件

*

## 注意点

* 既存機能を壊さない
* 最小変更で進める
* 大規模リファクタリングは禁止
* 今日中に検証できる範囲にする
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
  writeFileSync(requestFile, FEATURE_TEMPLATE, 'utf8');
  console.log('=== ai:feature-pack ===');
  console.log(`  初期テンプレートを作成しました: ${requestFile}`);
  console.log('');
  console.log('→ feature.md を記入してから再実行してください。');
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
  '以下は追加機能の相談です。\n' +
  'ユーザーに追加のログ貼り付けを求めず、この情報をもとに、追加機能の目的・実装範囲・影響範囲・リスク・検証方法を整理してください。\n' +
  '6時間以内で完了できる最小範囲に圧縮してください。\n' +
  '今日やること、今日やらないこと、Claude Codeに渡す実装指示文を作ってください。\n' +
  '既存機能を壊さないことを最優先にしてください。';

// --- Markdown 生成 ---
const md = `# 追加機能パック (feature-pack.md)

## 1. 現在日時
${now}

## 2. 実行ディレクトリ
${root}

## 3. .ai/current-task.json
\`\`\`json
${taskRaw ? taskRaw.trim() : '(.ai/current-task.json がありません)'}
\`\`\`

## 4. .ai/requests/feature.md
${requestRaw ? requestRaw.trim() : '(.ai/requests/feature.md がありません)'}

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

console.log('=== ai:feature-pack ===');
console.log(`  生成しました: ${outFile}`);
console.log(`  request     : ${requestFile}`);
console.log(`  branch      : ${branch}`);
console.log(`  diff        : ${diffRaw.length > MAX_DIFF_CHARS ? `切詰め（${MAX_DIFF_CHARS}文字）` : `${diffRaw.length}文字`}`);
console.log(`  latest log  : ${logRaw ? `含む（${Math.min(logRaw.length, MAX_LOG_CHARS)}文字）` : 'なし'}`);
console.log('');
console.log('→ このファイルを AI（Claude Code / Codex reviewer）に渡してください。');
