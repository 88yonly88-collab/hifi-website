/**
 * agmsg Manager - ai:run（コマンド実行ログの自動保存）
 *
 * 目的:
 *   ターミナル実行結果を毎回コピペしなくて済むよう、任意コマンドの実行結果を
 *   ログファイルに自動保存する。出力はターミナルにもそのまま表示する。
 *
 * 使い方:
 *   npm run ai:run -- npm run build      （package.json のある repo）
 *   npm run ai:run -- npm test
 *   npm run ai:run -- npx tsc --noEmit
 *   bash scripts/ai run pytest -q          （standalone: package.json が無い repo）
 *
 * 保存先:
 *   .ai/logs/latest-command.log        最新の実行ログ（毎回上書き）
 *   .ai/logs/history/run-<時刻>.log     履歴（実行ごとに新規）
 *
 * ログ内容:
 *   実行日時 / 実行ディレクトリ / 実行コマンド / 開始・終了時刻 / 実行時間 /
 *   終了コード / stdout / stderr
 *
 * 制約:
 *   - 出力をそのまま中継・保存するだけ。.env や秘密情報、node_modules は読まない。
 *   - 長時間監視 / 自動修正ループ / 自動 commit / 自動 push はしない。
 *   - コマンドが失敗してもログ保存は必ず行う。終了コードは ai:run 自身に反映する。
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { aiCmd } from './ai-workflow-lib.mjs';
import { authorizeNextStep, consumeDispatchTicket } from './ai-review-cycle-lib.mjs';

const root = process.cwd();
{
  const ticketId = String(process.env.AI_REVIEW_CYCLE_TICKET || '').trim();
  if (!ticketId) {
    console.error('✗ REVIEW_CYCLE_TICKET_REQUIRED: ai:run requires a reserved review-cycle ticket before side effects');
    process.exit(2);
  }
  try {
    const context = {ticketId, kind: 'run', step: process.env.AI_REVIEW_CYCLE_STEP, cycle: Number(process.env.AI_REVIEW_CYCLE_CYCLE), candidateHash: process.env.AI_REVIEW_CYCLE_CANDIDATE, taskId: process.env.AI_REVIEW_CYCLE_TASK, purposeId: process.env.AI_REVIEW_CYCLE_PURPOSE, requestId: process.env.AI_REVIEW_CYCLE_REQUEST};
    if (Object.values(context).some(x => x === undefined || x === '' || (typeof x === 'number' && !Number.isInteger(x)))) throw new Error('REVIEW_CYCLE_ENTRY_IDS_REQUIRED');
    authorizeNextStep(root, context);
    consumeDispatchTicket(root, {
      ...context,
      ticketId,
      stage: 'provider',
      step: process.env.AI_REVIEW_CYCLE_STEP,
      cycle: Number(process.env.AI_REVIEW_CYCLE_CYCLE || 0),
      candidateHash: process.env.AI_REVIEW_CYCLE_CANDIDATE,
      requestId: process.env.AI_REVIEW_CYCLE_REQUEST,
      model: process.env.AI_REVIEW_CYCLE_MODEL,
      effort: process.env.AI_REVIEW_CYCLE_EFFORT,
    });
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(2);
  }
}
const logDir = join(root, '.ai', 'logs');
const historyDir = join(logDir, 'history');
const latestLog = join(logDir, 'latest-command.log');

// --- 引数（実行コマンド）---
const cmdArgs = process.argv.slice(2);
if (cmdArgs.length === 0) {
  console.error('✗ 実行するコマンドが指定されていません。');
  console.error(`  例: ${aiCmd('run', '<コマンド>')}`);
  process.exit(1);
}
const [command, ...args] = cmdArgs;
const commandLine = cmdArgs.join(' ');

/** ファイル名に使える形式のタイムスタンプ（例: 2026-06-26T12-34-56-789Z）。 */
function fileStamp(date) {
  return date.toISOString().replace(/:/g, '-').replace(/\./g, '-');
}

/** 収集した情報からログ本文を組み立てる。 */
function buildLog({ start, end, exitCode, signal, stdout, stderr }) {
  const durationMs = end.getTime() - start.getTime();
  return [
    '=== ai:run command log ===',
    `実行日時    : ${start.toISOString()}`,
    `実行ディレクトリ: ${root}`,
    `実行コマンド  : ${commandLine}`,
    `開始時刻    : ${start.toISOString()}`,
    `終了時刻    : ${end.toISOString()}`,
    `実行時間    : ${durationMs} ms`,
    `終了コード   : ${exitCode === null ? `(signal ${signal})` : exitCode}`,
    '',
    '----- stdout -----',
    stdout.length ? stdout.replace(/\n$/, '') : '(なし)',
    '',
    '----- stderr -----',
    stderr.length ? stderr.replace(/\n$/, '') : '(なし)',
    '',
  ].join('\n');
}

/** latest と history の両方へ同じ内容を書き出す。 */
function writeLogs(content, start) {
  mkdirSync(historyDir, { recursive: true });
  const historyLog = join(historyDir, `run-${fileStamp(start)}.log`);
  writeFileSync(latestLog, content, 'utf8');
  writeFileSync(historyLog, content, 'utf8');
  return historyLog;
}

const start = new Date();
let stdout = '';
let stderr = '';

// shell: false で引数配列をそのまま渡す（シェル経由の解釈を避ける）
const child = spawn(command, args, { cwd: root, shell: false });

child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk); // ターミナルへそのまま表示
  stdout += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  stderr += chunk.toString();
});

/** 終了処理: ログ保存 → 案内 → 終了コード反映。 */
function finish(exitCode, signal) {
  const end = new Date();
  const content = buildLog({ start, end, exitCode, signal, stdout, stderr });
  const historyLog = writeLogs(content, start);
  console.log('');
  console.log(`[ai:run] 終了コード: ${exitCode === null ? `signal ${signal}` : exitCode}`);
  console.log(`[ai:run] ログ保存: ${latestLog}`);
  console.log(`[ai:run] 履歴保存: ${historyLog}`);
  // コマンドの終了コードを ai:run 自身に反映（signal 終了は 1 とする）
  process.exit(exitCode === null ? 1 : exitCode);
}

child.on('close', (code, signal) => finish(code, signal));

// 起動自体に失敗した場合（コマンドが存在しない等）もログを残す
child.on('error', (err) => {
  stderr += `\n[ai:run] コマンド起動に失敗しました: ${err.message}\n`;
  finish(1, null);
});
