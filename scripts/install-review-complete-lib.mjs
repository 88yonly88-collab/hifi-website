#!/usr/bin/env node
/**
 * install-review-complete-lib.mjs — 完了ゲートから設置レビュー（`install-review-check --ledger`）を
 * 必ず呼ぶための判定（2026-10-17 親の裁定「選択肢1」）。
 *
 * 目的: 台帳（`deploy_targets`）を書いた指示書がある案件を、設置レビュー未通過のまま完了させない。
 * 方針:
 *   - **台帳を書いていない指示書は止めない**（誤差し戻しを避ける）。
 *   - 不良（MISMATCH）も未確認（UNVERIFIED）も blocking（fail-closed）。記録上は区別する。
 *   - 検査器 `install-review-check.mjs` が無いリポジトリでは、このゲートは **inactive** と明示して
 *     素通りする（黙って合格にしない。理由を必ず出力する）。
 *   - 候補の解決は ①明示 `--instruction` ②完了宣言に書かれた指示書パス ③タスク記録の指示書欄
 *     ④共有の指示書ディレクトリの中で **このリポジトリ内に設置先を持つ** 台帳つき指示書（`instruction_status: done` は除外）。
 *   - 明示指定の指示書が無い場合は blocking（指定ミスを素通りさせない）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHECKER_PATH = path.join(REPO_ROOT, 'scripts/install-review-check.mjs');
export const DEFAULT_INSTRUCTIONS_DIR = path.join(os.homedir(), 'projects/.agent-work/instructions');

// 指示書パスを本文から拾う（`/…/instructions/….md` の絶対パスだけ）。
export function extractInstructionPaths(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(/\/[A-Za-z0-9._/@+-]*\/instructions\/[A-Za-z0-9._@+-]+\.md/g)) {
    found.add(match[0]);
  }
  return [...found];
}

// 候補を優先順で解決する（重複は除く）。
export function resolveInstructionCandidates({ instruction = '', declaration = '', task = null } = {}) {
  const candidates = [];
  const push = (value) => {
    const text = String(value ?? '').trim();
    if (text && !candidates.includes(text)) candidates.push(text);
  };
  push(instruction);
  for (const value of extractInstructionPaths(declaration)) push(value);
  for (const key of ['instruction', 'instructionPath', 'instruction_path']) {
    if (task && typeof task === 'object') push(task[key]);
  }
  for (const value of extractInstructionPaths(task ? JSON.stringify(task) : '')) push(value);
  return candidates;
}

function readFileSafe(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { error: 'not_regular_file' };
    return { text: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    return { error: error.code === 'ENOENT' ? 'missing' : String(error.code || error.message) };
  }
}

// 検査器を読み込む。**ファイルが無い**ときだけ inactive（配布先を落とさない）。
// 存在するのに読めない・壊れている場合は「未確認」として止める（合格に読み替えない）。
async function loadChecker(checkerPath = CHECKER_PATH) {
  let stat;
  try {
    stat = fs.lstatSync(checkerPath);
  } catch (error) {
    // 「無い」と確認できたときだけ inactive。権限エラー等は未確認として止める。
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { error: 'missing' };
    return { error: `stat_failed:${error && error.code ? error.code : String(error)}` };
  }
  if (!stat.isFile()) {
    return { error: `not_regular_file:${stat.isSymbolicLink() ? 'symlink' : 'other'}` };
  }
  try {
    const url = pathToFileURL(checkerPath).href;
    return { checker: await import(url) };
  } catch (error) {
    return { error: `load_failed:${String(error && error.message ? error.message : error)}` };
  }
}

function instructionStatus(text) {
  // 先頭の欄（最初の空行まで）だけを見る。本文の例示行で skip しない。
  const header = String(text ?? '').split(/\r?\n\r?\n/)[0] || '';
  const match = /^instruction_status:[ \t]*(.*)$/m.exec(header);
  return match ? match[1].trim() : '';
}

// 実体パスへ正規化する（symlink・worktree・.. を畳む）。存在しない末尾は親ディレクトリで解決する。
function realResolve(target) {
  const value = String(target || '');
  if (!value) return '';
  try {
    return fs.realpathSync.native(value);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(value)), path.basename(value));
    } catch {
      return '';
    }
  }
}

// 「このリポジトリの中」と見なすルート（worktree なら主リポジトリも含める）。
function repoRoots(root) {
  const roots = new Set();
  const resolved = realResolve(root);
  if (resolved) roots.add(resolved);
  try {
    const result = spawnSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', timeout: 10000,
    });
    const common = String(result.stdout || '').trim();
    if (common) {
      const commonDir = realResolve(common) || common;
      roots.add(path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir);
    }
  } catch {
    // git が無い環境では root だけで判定する
  }
  return [...roots].filter(Boolean);
}

function isInsideAnyRoot(target, roots) {
  const resolved = realResolve(target);
  if (!resolved) return null; // 判定不能
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

// `--ledger` を子プロセスで実行する（既定の実行者）。
export function defaultRunLedgerCheck(file, { root = REPO_ROOT, timeoutMs = 120000, checkerPath = CHECKER_PATH } = {}) {
  const result = spawnSync(process.execPath, [checkerPath, '--ledger', file], {
    cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.code || result.error.message) : '',
  };
}

function blockingLines(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .filter((line) => /^(MISMATCH|UNVERIFIED)\t/.test(line))
    .slice(0, 20);
}

/**
 * 完了を止める理由を返す。
 *   blockers … 空でなければ完了にしない（不良・未確認・指定ミス）
 *   checked  … 設置レビューに合格した指示書
 *   skipped  … 台帳が無い・設置不要・done など、止めないもの（理由つき）
 *   inactive … 検査器が無いなど、このゲートが働かない場合の理由（空でなければ素通り）
 *   active   … このリポジトリ内に設置先を持つ台帳つき指示書（＝設置レビューが実際に効いている案件）。
 *              成果物4点記録の既定ON判定はこの一覧を根拠にする（台帳なし・設置不要・外・done は空）。
 */
export async function installReviewCompletionBlockers({
  root = REPO_ROOT,
  instruction = '',
  declaration = '',
  task = null,
  instructionsDir = DEFAULT_INSTRUCTIONS_DIR,
  includeSweep = true,
  checkerPath = CHECKER_PATH,
  runCheck = defaultRunLedgerCheck,
} = {}) {
  const blockers = [];
  const checked = [];
  const skipped = [];
  const inactive = [];
  const warnings = [];
  const active = [];
  const loaded = await loadChecker(checkerPath);
  if (loaded.error === 'missing') {
    inactive.push(`検査器が無いため設置レビューのゲートは働きません: ${CHECKER_PATH}`);
    return { blockers, checked, skipped, inactive, warnings, active };
  }
  if (loaded.error) {
    blockers.push(`設置レビュー未確認（検査器を読み込めない）: ${checkerPath} (${loaded.error})`);
    return { blockers, checked, skipped, inactive, warnings, active };
  }
  const checker = loaded.checker;
  if (typeof checker.extractDeployTargets !== 'function' || typeof checker.validateLedger !== 'function') {
    blockers.push(`設置レビュー未確認（検査器の版が古い: extractDeployTargets/validateLedger が無い）: ${checkerPath}`);
    return { blockers, checked, skipped, inactive, warnings, active };
  }

  const roots = repoRoots(root);
  const evaluate = async (file, { explicit = false, allowDoneSkip = false } = {}) => {
    const read = readFileSafe(file);
    if (read.error) {
      if (explicit) blockers.push(`設置レビューの対象指示書を読めない（--instruction）: ${file} (${read.error})`);
      else warnings.push(`指示書を読めない（--instruction・完了宣言・タスク記録の候補）: ${file} (${read.error})`);
      return;
    }
    if (allowDoneSkip && instructionStatus(read.text) === 'done') {
      skipped.push(`instruction_status: done なので止めない: ${file}`);
      return;
    }
    let blocks;
    try {
      blocks = checker.extractDeployTargets(read.text);
    } catch (error) {
      blockers.push(`設置レビュー未確認（台帳を解析できない）: ${file} (${error.message})`);
      return;
    }
    if (blocks.length === 0) {
      if (String(read.text).includes('deploy_targets')) {
        blockers.push(`設置レビュー未確認（台帳を解析できない）: ${file}`);
        return;
      }
      skipped.push(`台帳（deploy_targets）が無いので止めない: ${file}`);
      return;
    }
    const structural = checker.validateLedger(blocks);
    if (structural.error) {
      blockers.push(`設置レビュー未確認（台帳が不正）: ${file}: ${structural.error}`);
      return;
    }
    if (structural.notRequired) {
      // 設置不要の明記は検査器に判断させる（凍結済み台帳の書き換えは検査器が落とす）。
      const result = await runCheck(file, { root, checkerPath });
      if (result.error) { blockers.push(`設置レビュー未確認（実行できない）: ${file} (${result.error})`); return; }
      if (result.status === 0) { checked.push(file); return; }
      blockers.push(`設置レビュー未確認（設置不要の判定で終了コード ${result.status}）: ${file}`);
      return;
    }
    const targetPaths = (structural.targets || []).map((target) => (typeof target?.path === 'string' ? target.path : ''));
    if (targetPaths.length === 0 || targetPaths.some((targetPath) => !targetPath || !path.isAbsolute(targetPath))) {
      blockers.push(`設置レビュー未確認（設置先パスが不正）: ${file}`);
      return;
    }
    // 設置先がすべてこのリポジトリの外なら止めない。判定不能は止める（未確認）。
    let anyInside = false;
    for (const targetPath of targetPaths) {
      const verdict = isInsideAnyRoot(targetPath, roots);
      if (verdict === null) {
        blockers.push(`設置レビュー未確認（設置先の実体を解決できない）: ${file} (${targetPath})`);
        return;
      }
      if (verdict) anyInside = true;
    }
    if (!anyInside) {
      skipped.push(`このリポジトリ内に設置先が無いので止めない: ${file}`);
      return;
    }
    // ここから先は「台帳つき・このリポジトリ内・設置不要でない・明示doneでない」案件。
    // 成果物4点記録の既定ON判定（ai-complete）がこの一覧だけを対象にする。
    active.push(file);
    const result = await runCheck(file, { root, checkerPath });
    if (result.error) {
      blockers.push(`設置レビュー未確認（実行できない）: ${file} (${result.error})`);
      return;
    }
    const output = `${result.stdout}\n${result.stderr}`;
    const lines = blockingLines(output);
    const passedMarker = output.includes('INSTALL_REVIEW_PASSED');
    if (result.status === 0 && passedMarker && lines.length === 0) {
      checked.push(file);
      return;
    }
    if (result.status === 1 || lines.length > 0) {
      blockers.push(`設置レビュー未通過: ${file}${lines.length ? `\n    ${lines.join('\n    ')}` : ''}`);
      return;
    }
    blockers.push(`設置レビュー未確認（終了コード ${result.status}・合格マーカーなし）: ${file}`);
  };

  const candidates = resolveInstructionCandidates({ instruction, declaration, task });
  for (const [index, candidate] of candidates.entries()) {
    const file = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
    await evaluate(file, { explicit: index === 0 && Boolean(String(instruction || '').trim()) });
  }

  const sweepFailures = [];
  if (includeSweep) {
    const stat = fs.statSync(instructionsDir, { throwIfNoEntry: false });
    if (stat && stat.isDirectory()) {
      for (const name of fs.readdirSync(instructionsDir).sort()) {
        if (!name.endsWith('.md') || name.startsWith('_')) continue;
        const file = path.join(instructionsDir, name);
        if (candidates.some((candidate) => path.resolve(path.isAbsolute(candidate) ? candidate : path.join(root, candidate)) === path.resolve(file))) continue;
        const read = readFileSafe(file);
        if (read.error) continue;
        let blocks;
        try { blocks = checker.extractDeployTargets(read.text); } catch { continue; }
        if (blocks.length === 0) continue;
        const structural = checker.validateLedger(blocks);
        if (structural.error || structural.notRequired) continue;
        if (instructionStatus(read.text) === 'done') continue;
        const targetPaths = (structural.targets || []).map((target) => (typeof target?.path === 'string' ? target.path : ''));
        const inRepo = targetPaths.some((targetPath) => isInsideAnyRoot(targetPath, roots) === true);
        if (!inRepo) continue;
        const result = await runCheck(file, { root, checkerPath });
        const output = `${result.stdout}\n${result.stderr}`;
        const lines = blockingLines(output);
        if (result.status === 0 && output.includes('INSTALL_REVIEW_PASSED') && lines.length === 0) {
          warnings.push(`走査: 合格 ${file}`);
        } else {
          sweepFailures.push(file);
          warnings.push(`走査: 未通過または未確認 ${file}${lines.length ? ` / ${lines[0]}` : ''}`);
        }
      }
    }
  }
  // 閉じる指示書が1件も解決できないときだけ、走査の未通過を blocking にする
  // （--instruction を書かずに完了する迂回を塞ぐ。候補があるときは別案件の不良で誤停止しない）。
  if (candidates.length === 0 && sweepFailures.length > 0) {
    blockers.push(`設置レビュー未確認（閉じる指示書が指定されていない）。--instruction <指示書> を付けて完了してください。走査で未通過/未確認: ${sweepFailures.slice(0, 5).join(', ')}${sweepFailures.length > 5 ? ` ほか${sweepFailures.length - 5}件` : ''}`);
  }
  return { blockers, checked, skipped, inactive, warnings, active };
}

// 単体で動かす（試験・確認用）。引数は無し。判定不能は exit 2。
const cliEntry = (() => {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (cliEntry) {
  const [file = ''] = process.argv.slice(2);
  const checkerExists = fs.existsSync(CHECKER_PATH);
  const result = await installReviewCompletionBlockers({ instruction: file });
  for (const line of result.inactive) console.log(`INACTIVE: ${line}`);
  for (const line of result.warnings) console.log(`WARN: ${line}`);
  for (const line of result.checked) console.log(`CHECKED: ${line}`);
  for (const line of result.skipped) console.log(`SKIPPED: ${line}`);
  for (const line of result.blockers) console.error(`BLOCKED: ${line}`);
  console.log(`INSTALL_REVIEW_COMPLETE_GATE blockers=${result.blockers.length} checked=${result.checked.length} skipped=${result.skipped.length} checker=${checkerExists ? 'present' : 'missing'}`);
  process.exit(result.blockers.length > 0 ? 1 : 0);
}
