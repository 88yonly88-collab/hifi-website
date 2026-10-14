import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const E2E_SCHEMA_VERSION = 1;
export const TEST_RUN_SCHEMA_VERSION = 1;
export const TEST_RUN_PRODUCER = 'ai-dev-tool/ai-test@1';
export const TEST_RUN_REFERENCE_REQUIRED_ERROR =
  'testRunにテスト実行結果のrepo相対パスが必要です（例: .ai/e2e/test-run-<taskId>.json）。先にai:testを実行し、表示された「実行結果」のパスを指定してください';
export const TEST_RUN_EXIT_CODES = Object.freeze({
  TEST_FAILED: 1,
  SKIPPED: 2,
  NO_TESTS: 3,
  BLOCKED: 4,
});
export const VITEST_JSON_REPORT_BEGIN = '[ai:test] VITEST_JSON_REPORT_BEGIN';
export const VITEST_JSON_REPORT_END = '[ai:test] VITEST_JSON_REPORT_END';
export const DEFAULT_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

// Git stdout is collected completely into a private file with a finite byte/time budget.
export const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
export function gitFullOutput(root, args, { maxBytes = GIT_OUTPUT_MAX_BYTES, timeout = 10000, encoding = 'utf8' } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > GIT_OUTPUT_MAX_BYTES || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10000) throw new Error('GIT_OUTPUT_BOUND_INVALID');
  const dir = mkdtempSync(join(tmpdir(), 'ai-git-output-'));
  const file = join(dir, 'stdout');
  const worker = `
    const {spawn}=require('node:child_process');const fs=require('node:fs');
    const [root,args,file,limit,timeout]=process.argv.slice(1);const fd=fs.openSync(file,'wx',0o600);
    const child=spawn('git',JSON.parse(args),{cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let bytes=0,failure='',stderr='';const timer=setTimeout(()=>{failure='GIT_OUTPUT_TIMEOUT';child.kill('SIGKILL');},Number(timeout));
    process.on('SIGTERM',()=>{child.kill('SIGKILL');});
    child.stdout.on('data',chunk=>{if(failure)return;bytes+=chunk.length;if(bytes>Number(limit)){failure='GIT_OUTPUT_TOO_LARGE';child.kill('SIGKILL');return;}try{let n=0;while(n<chunk.length){const written=fs.writeSync(fd,chunk,n,chunk.length-n);if(!written)throw new Error('short write');n+=written;}}catch(e){failure='GIT_OUTPUT_WRITE_FAILED';child.kill('SIGKILL');}});
    child.stderr.on('data',chunk=>{if(stderr.length<4096)stderr+=chunk.toString().slice(0,4096-stderr.length);});
    child.on('error',()=>{failure='GIT_OUTPUT_SPAWN_FAILED';});
    child.on('close',(code,signal)=>{clearTimeout(timer);try{fs.closeSync(fd);}catch{}if(failure||code!==0||signal){console.error(failure||'GIT_OUTPUT_EXIT_FAILED: '+code+' '+stderr);process.exitCode=1;}});
  `;
  try {
    const run = spawnSync(process.execPath, ['-e', worker, root, JSON.stringify(args), file, String(maxBytes), String(timeout)], { timeout: timeout + 2000, windowsHide: true, encoding: 'utf8', stdio: ['ignore','ignore','pipe'], maxBuffer: 8192 });
    if (run.error || run.status !== 0 || run.signal) throw new Error(String(run.stderr || run.error?.message || 'GIT_OUTPUT_CAPTURE_FAILED').trim());
    const size = statSync(file).size;
    if (size > maxBytes) throw new Error('GIT_OUTPUT_TOO_LARGE');
    const bytes = readFileSync(file);
    if (bytes.length !== size) throw new Error('GIT_OUTPUT_INCOMPLETE');
    return encoding === null ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// Integrity failures cannot be treated as an unavailable Git command.
export function isGitIntegrityError(error) {
  return /GIT_(?:STATUS_(?:INCOMPLETE|FORMAT_INVALID|RENAME_SOURCE_MISSING)|OUTPUT_(?:TOO_LARGE|INCOMPLETE|TIMEOUT|WRITE_FAILED))/.test(String(error?.code || '') + ' ' + String(error?.message || ''))
    || error?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA';
}
export function validatePorcelainZ(text) {
  if (text && !text.endsWith('\0')) throw new Error('GIT_STATUS_INCOMPLETE');
  const records = text.split('\0');
  for (let i=0;i<records.length-1;i++) {
    const record=records[i];
    if (!/^[ MTADRCU?!]{2} [\s\S]+$/u.test(record)) throw new Error('GIT_STATUS_FORMAT_INVALID');
    if (/[RC]/u.test(record.slice(0,2)) && !records[++i]) throw new Error('GIT_STATUS_RENAME_SOURCE_MISSING');
  }
  return text;
}

// branch/hash等の補助情報用。失敗は空値にして、各ゲート側の既存の必須検査へ渡す。
export function gitValue(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function repoGitValue(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      // stderrは保存経路へ流さず、終了statusだけで値なしと環境失敗を分類する。
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    // 一部sandboxは実終了0の子プロセスにもspawnSync EPERMを付ける。実終了0だけ成功として回収する。
    if (error?.code === 'EPERM' && error?.status === 0) return String(error.stdout ?? '').trim();
    const stage = args[0] === 'config'
      ? 'origin設定'
      : args.includes('--git-common-dir') ? '共通gitディレクトリ' : 'top-level';
    if (typeof error?.code === 'string') {
      throw new Error(`gitコマンドを起動できません（段階=${stage}）`);
    }
    if (error?.status === 1) return '';
    if (error?.status === 128) {
      throw new Error(`gitがrepo情報を読み取れません（段階=${stage} / status=128）`);
    }
    // 値なし・個別command非対応は次の解決手段へfallbackし、3手段とも空なら呼び出し側が拒否する。
    return '';
  }
}

function redactUrlCredentials(value) {
  return String(value || '').replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/giu,
    '$1[credentials-redacted]@',
  );
}

function repoGitReadError(error) {
  const raw = redactUrlCredentials(error?.message || error || '原因不明').trim();
  const detail = raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
  return new Error(
    `実git repo名を取得できません。gitの利用可否、作業場所の所有者、safe.directory設定を確認してください（詳細=${JSON.stringify(detail)}）`,
  );
}

/**
 * origin、共通gitディレクトリ、top-levelの順で実repo名を返す。
 * worktreeのフォルダ名ではなく元repo名を返すため、top-levelは最後の手段にする。
 * 値なしは次の手段へ進み、git自体の起動不能・status=128の環境失敗は復旧案内付きでthrowする。
 * readGitValueは単体テスト専用の注入口。本番経路は必ず省略する。
 */
export function actualRepoName(root, readGitValue = repoGitValue) {
  const read = (args) => {
    try {
      return String(readGitValue(root, args) || '').trim();
    } catch (error) {
      throw repoGitReadError(error);
    }
  };
  const origin = read(['config', '--get-all', 'remote.origin.url'])
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find(Boolean) || '';
  if (origin) {
    const name = origin.replace(/[\\/]+$/, '').replace(/\.git$/, '').split(/[/:]/).pop();
    if (name) return name;
  }
  const commonDir = read(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (commonDir) {
    const normalized = commonDir.replace(/[\\/]+$/, '');
    // submoduleの共通gitディレクトリは <親>/.git/modules/<名前> なので、その末尾が実repo名。
    const name = /[\\/]\.git[\\/]modules[\\/]/u.test(normalized)
      ? basename(normalized)
      : basename(dirname(normalized));
    if (name) return name;
  }
  const top = read(['rev-parse', '--show-toplevel']);
  return top ? basename(top) : '';
}

export function validateCurrentTaskRepoName(task, repo) {
  const rawDeclared = task?.repo;
  const display = (value, fallback) => {
    const normalized = typeof value === 'string'
      ? (value.trim() || fallback)
      : (value == null ? fallback : `(${typeof value})`);
    const limited = normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
    return JSON.stringify(limited);
  };
  const reject = (reason, recovery = '') => {
    throw new Error(
      `current-task.jsonのrepoが実repo名と一致しません（旧表現: current-task.jsonのrepoが実repo basenameと一致しません / 理由=${reason} / 宣言=${display(rawDeclared, '(missing)')} / 実repo=${display(repo, '(unresolved)')}）${recovery}`,
    );
  };
  if (!repo) {
    throw new Error('実git repo名を取得できません。gitの利用可否、作業場所の所有者、safe.directory設定を確認してください');
  }
  if (typeof rawDeclared !== 'string') reject('repoは文字列が必要です');
  const declared = rawDeclared.trim();
  if (!declared || declared.includes('/')) reject('repo名が空、または安全でない形式です');
  if (declared !== repo) {
    reject('repo名が一致しません', '。originを変更した場合はcurrent-task.jsonのrepoも更新してください');
  }
  return declared;
}

export function gitStatusHash(root) {
  const status = gitFullOutput(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status && !status.endsWith('\n')) throw new Error('GIT_STATUS_INCOMPLETE');
  return createHash('sha256').update(status.trim()).digest('hex');
}

function gitBuffer(root, args) { return gitFullOutput(root, args, { encoding: null }); }

function hashFrame(hash, label, value) {
  const labelBuffer = Buffer.from(label, 'utf8');
  const valueBuffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  hash.update(Buffer.from(`${labelBuffer.length}:`, 'ascii'));
  hash.update(labelBuffer);
  hash.update(Buffer.from(`:${valueBuffer.length}:`, 'ascii'));
  hash.update(valueBuffer);
}

// HEADとの差分だけでなく、Gitが認識する全untracked fileのパス・mode・内容も含める。
// status文字列だけのhashと違い、同じM表示のまま内容を変えても必ず値が変わる。
export function worktreeContentHash(root) {
  const repoRoot = realpathSync(root);
  const hash = createHash('sha256');
  hashFrame(hash, 'tracked-diff', gitBuffer(repoRoot, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--']));
  const untracked = gitBuffer(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = untracked.toString('utf8').split('\0').filter(Boolean);
  for (const path of paths) {
    const absolute = resolve(repoRoot, path);
    if (!isInside(repoRoot, absolute)) throw new Error(`untracked pathがrepo外です: ${path}`);
    const stat = lstatSync(absolute);
    hashFrame(hash, 'untracked-path', path);
    hashFrame(hash, 'untracked-mode', stat.mode.toString(8));
    if (stat.isSymbolicLink()) {
      hashFrame(hash, 'untracked-symlink', readlinkSync(absolute));
    } else if (stat.isFile()) {
      const objectHash = gitValue(repoRoot, ['hash-object', '--no-filters', '--', path]);
      if (!objectHash) throw new Error(`untracked fileをhashできません: ${path}`);
      hashFrame(hash, 'untracked-object', objectHash);
    } else {
      hashFrame(hash, 'untracked-type', 'other');
    }
  }
  return hash.digest('hex');
}

export function safeId(value, label = 'taskId') {
  const id = String(value || '').trim();
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new Error(`${label}は1..128文字の安全なID（英数字開始、英数字._-のみ）が必要です`);
  }
  return id;
}

export function currentGitIdentity(root) {
  return {
    branch:
      gitValue(root, ['rev-parse', '--abbrev-ref', 'HEAD']) ||
      gitValue(root, ['symbolic-ref', '--short', 'HEAD']),
    gitHead: gitValue(root, ['rev-parse', 'HEAD']),
    gitStatusHash: gitStatusHash(root),
    worktreeHash: worktreeContentHash(root),
  };
}

export function parseDeclaration(text) {
  const fields = {};
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^([a-z][a-z0-9_]*):\s*(.*)$/);
    if (match && !Object.prototype.hasOwnProperty.call(fields, match[1])) fields[match[1]] = match[2].trim();
  }
  return fields;
}

export function agentWorkDir(env = process.env) {
  if (
    env.AGENT_WORK_DIR &&
    env.AI_DEV_TOOL_ALLOW_AGENT_WORK_DIR === '1'
  ) {
    return resolve(env.AGENT_WORK_DIR);
  }
  return join(homedir(), 'projects', '.agent-work');
}

/** readGitValueは単体テスト専用の注入口。本番経路は必ず省略する。 */
export function declarationPathFor(
  root,
  task,
  branch = '',
  { validateTaskRepo = true, readGitValue } = {},
) {
  const actualRepo = actualRepoName(root, readGitValue);
  // 後追い完了は古いcurrent-taskを救済するため実repoから探し、宣言自体のrepoは呼び出し側で別途検査する。
  const repo = validateTaskRepo ? validateCurrentTaskRepoName(task, actualRepo) : actualRepo;
  const actualBranch = String(branch || task?.branch || '').trim();
  if (!repo || repo.includes('/') || !actualBranch || actualBranch.includes('\n')) {
    throw new Error('repo/branchから作業宣言パスを安全に解決できません');
  }
  return join(agentWorkDir(), `${repo}--${actualBranch.replaceAll('/', '-')}.md`);
}

export function ensureRegularFile(filePath, label) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}はsymlinkではないregular fileが必要です: ${filePath}`);
}

export function resolveRepoPath(root, requested, label = 'path') {
  const repoRoot = realpathSync(root);
  const absolute = resolve(repoRoot, requested);
  if (!isInside(repoRoot, absolute)) throw new Error(`${label}はrepo内を指定してください: ${requested}`);
  let cursor = dirname(absolute);
  while (isInside(repoRoot, cursor) && cursor !== repoRoot) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`${label}の親ディレクトリにsymlinkは使えません: ${cursor}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    cursor = dirname(cursor);
  }
  return absolute;
}

export function atomicWriteJson(filePath, value, { expectedValue, label = 'JSON' } = {}) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(dirname(filePath));
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`出力先はsymlinkではない実ディレクトリが必要です: ${dirname(filePath)}`);
  }
  const temp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  let tempCreated = false;
  try {
    fd = openSync(temp, 'wx', 0o600);
    tempCreated = true;
    if (!fstatSync(fd).isFile()) throw new Error(`一時出力がregular fileではありません: ${temp}`);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (expectedValue !== undefined) {
      ensureRegularFile(filePath, label);
      const current = readJson(filePath);
      if (JSON.stringify(current) !== JSON.stringify(expectedValue)) {
        throw new Error(`${label}が同時に更新されたため、処理をやり直してください`);
      }
    }
    renameSync(temp, filePath);
    tempCreated = false;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (tempCreated) {
      try {
        unlinkSync(temp);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

function requiredText(value, label, errors) {
  if (typeof value !== 'string' || !value.trim()) errors.push(`${label}が空です`);
}

/**
 * Node.js のテスト出力から、完了判定に使う件数と実際に走ったテスト名を取り出す。
 * counts.total は登録総数ではなく、実行された pass + fail の件数とする。
 * これにより「130件すべてskip」は total=0 / skipped=130 として区別できる。
 *
 * TAP形式（`# tests 10` / `ok 1 - name`）と、Node 18以降の既定レポータである
 * spec形式（`ℹ tests 10` / `✔ name (1.2ms)`）の両方を読む。
 * 独立したTAP planまたはtests集計が複数ある場合は各ブロックの結果行を合算し、
 * plan合計とトップレベルの結果行数が違うときはplanMismatchを残す。
 * Node 24 では非TTYでも既定が spec になり、TAPだけを見ていると
 * 「集計を取得できない=BLOCKED」になってテスト全件合格でも証跡が残らないため。
 */
const ANSI_PATTERN = /\[[0-9;]*m/gu;

export function parseTapTestReport(rawOutput) {
  const summary = {};
  const summaryTotals = {};
  const summaryFieldCounts = {};
  const observed = { pass: 0, fail: 0, skipped: 0, todo: 0 };
  const planCounts = [];
  const tapBlocks = [];
  let currentTapBlock = null;
  let summaryReportCount = 0;
  let topLevelPointCount = 0;
  let tapVersionDetected = false;
  const testNames = [];
  const recordObserved = (key) => {
    observed[key] += 1;
    if (currentTapBlock) currentTapBlock.observed[key] += 1;
  };
  for (const raw of String(rawOutput || '').replaceAll('\r\n', '\n').split('\n')) {
    const line = raw.replace(ANSI_PATTERN, '');
    if (/^TAP version \d+\s*$/u.test(line)) {
      tapVersionDetected = true;
      currentTapBlock = {
        plan: null,
        pointCount: 0,
        observed: { pass: 0, fail: 0, skipped: 0, todo: 0 },
        summary: {},
        summaryTotals: {},
        summaryFieldCounts: {},
      };
      tapBlocks.push(currentTapBlock);
      continue;
    }
    const planMatch = line.match(/^1\.\.(\d+)(?:\s+#.*)?\s*$/u);
    if (planMatch) {
      const count = Number(planMatch[1]);
      planCounts.push(count);
      if (currentTapBlock) currentTapBlock.plan = count;
      continue;
    }
    const countMatch = line.match(/^(?:#|\s*ℹ) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/u);
    if (countMatch) {
      const key = countMatch[1];
      const value = Number(countMatch[2]);
      if (!Number.isInteger(summary[key])) summary[key] = value;
      summaryTotals[key] = (summaryTotals[key] || 0) + value;
      summaryFieldCounts[key] = (summaryFieldCounts[key] || 0) + 1;
      if (currentTapBlock) {
        if (!Number.isInteger(currentTapBlock.summary[key])) currentTapBlock.summary[key] = value;
        currentTapBlock.summaryTotals[key] = (currentTapBlock.summaryTotals[key] || 0) + value;
        currentTapBlock.summaryFieldCounts[key] = (currentTapBlock.summaryFieldCounts[key] || 0) + 1;
      }
      if (key === 'tests') summaryReportCount += 1;
      continue;
    }
    const specMatch = line.match(/^\s*(✔|✖) (.+?)(?:\s+\([\d.]+m?s\))?\s*$/u);
    if (specMatch) {
      const name = specMatch[2].trim();
      if (specMatch[1] === '✔') recordObserved('pass');
      else recordObserved('fail');
      if (name) testNames.push(name);
      continue;
    }
    const pointMatch = line.match(/^\s*(ok|not ok)\s+\d+(?:\s*$|\s+((?:#.*)|(?:-\s*.*))$)/u);
    if (!pointMatch) continue;
    if (line === line.trimStart()) {
      topLevelPointCount += 1;
      if (currentTapBlock) currentTapBlock.pointCount += 1;
    }
    const detail = (pointMatch[2] || '').replace(/^-\s*/u, '');
    // Vitest の tap reporter は file/suite を末尾 `{` のコンテナ行として出す。
    // 集計行がないときにこの行までテスト件数へ含めると、実件数より多くなる。
    if (/\{\s*$/u.test(detail)) continue;
    const directive = detail.match(/(?:^|\s+)#\s+(SKIP|TODO)\b[^#]*$/iu);
    if (directive?.[1].toUpperCase() === 'SKIP') {
      recordObserved('skipped');
      continue;
    }
    if (directive?.[1].toUpperCase() === 'TODO') {
      recordObserved('todo');
      continue;
    }
    const name = (directive ? detail.slice(0, directive.index) : detail).trim();
    if (pointMatch[1] === 'ok') recordObserved('pass');
    else recordObserved('fail');
    if (name) testNames.push(name);
  }
  const multipleTapBlocks = planCounts.length > 1;
  const multipleSummaryBlocks = summaryReportCount > 1;
  const multipleBlocks = multipleTapBlocks || multipleSummaryBlocks;
  const observedPointCount = observed.pass + observed.fail + observed.skipped + observed.todo;
  const plannedBlocks = tapBlocks.filter((block) => Number.isInteger(block.plan));
  const useTapBlockCounts = multipleTapBlocks
    && tapBlocks.length === summaryReportCount
    && plannedBlocks.length === planCounts.length;
  const resultCount = (key) => {
    if (useTapBlockCounts) {
      return tapBlocks.reduce((sum, block) => {
        if (key === 'skipped' || key === 'todo') {
          return sum + Math.max(block.summaryTotals[key] || 0, block.observed[key]);
        }
        if (
          ((block.summary.suites || 0) > 0 || (block.summary.cancelled || 0) > 0)
          && Number.isInteger(block.summary[key])
        ) {
          return sum + block.summary[key];
        }
        const blockPointCount = block.observed.pass + block.observed.fail + block.observed.skipped + block.observed.todo;
        if (blockPointCount === 0 && Number.isInteger(block.summary[key])) return sum + block.summary[key];
        return sum + block.observed[key];
      }, 0);
    }
    if (multipleBlocks && (key === 'skipped' || key === 'todo')) {
      return Math.max(summaryTotals[key] || 0, observed[key]);
    }
    if (multipleTapBlocks) {
      if (observedPointCount === 0 && summaryFieldCounts[key] === summaryReportCount) return summaryTotals[key];
      return observed[key];
    }
    if (multipleSummaryBlocks && summaryFieldCounts[key] === summaryReportCount) return summaryTotals[key];
    if (!multipleBlocks && Number.isInteger(summary[key])) return summary[key];
    return observed[key];
  };
  const pass = resultCount('pass');
  const fail = resultCount('fail');
  const skipped = resultCount('skipped');
  const todo = resultCount('todo');
  const cancelledSummary = multipleBlocks ? summaryTotals.cancelled : summary.cancelled;
  const cancelled = Number.isInteger(cancelledSummary) ? cancelledSummary : 0;
  const counts = {
    total: pass + fail,
    pass,
    fail,
    skipped,
    todo,
    cancelled,
  };
  const fallbackPointCount = topLevelPointCount > 0
    ? topLevelPointCount
    : summaryReportCount === planCounts.length ? summaryTotals.tests : topLevelPointCount;
  const planMismatch = plannedBlocks.length > 0 && plannedBlocks.length === planCounts.length
    ? plannedBlocks.some((block) => {
        const comparableCount = block.pointCount > 0 ? block.pointCount : block.summary.tests;
        return !Number.isInteger(comparableCount) || block.plan !== comparableCount;
      })
    : planCounts.length > 0 && planCounts.reduce((sum, count) => sum + count, 0) !== fallbackPointCount;
  const summaryMismatch = summaryReportCount > 0
    && counts.total + counts.skipped + counts.todo + counts.cancelled !== summaryTotals.tests;
  if (planMismatch || summaryMismatch) {
    counts.planMismatch = true;
    counts.mismatchReasons = [
      ...(planMismatch ? ['plan'] : []),
      ...(summaryMismatch ? ['summary'] : []),
    ];
  }
  return {
    counts,
    testNames,
    reportDetected: Number.isInteger(summary.tests) || (tapVersionDetected && planCounts.length > 0),
  };
}

function emptyTestReport(extra = {}) {
  return {
    counts: { total: 0, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 },
    testNames: [],
    reportDetected: false,
    ...extra,
  };
}

/**
 * Vitest 3/4 の JSON reporter が出す Jest 互換JSONから実行件数を読む。
 * stdout が非TTYで空でも、--outputFile に書かれたこのJSONを正本にできる。
 */
export function parseVitestJsonReport(rawReport) {
  let report;
  try {
    report = typeof rawReport === 'string' ? JSON.parse(rawReport) : rawReport;
  } catch (error) {
    return emptyTestReport({ format: 'vitest-json', error: `JSONを解析できません: ${error.message}` });
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return emptyTestReport({ format: 'vitest-json', error: 'JSONの最上位はobjectが必要です' });
  }
  const requiredCounts = [
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
  ];
  const invalidField = requiredCounts.find((key) => !Number.isInteger(report[key]) || report[key] < 0);
  if (invalidField) {
    return emptyTestReport({ format: 'vitest-json', error: `${invalidField}は0以上の整数が必要です` });
  }
  if (!Array.isArray(report.testResults)) {
    return emptyTestReport({ format: 'vitest-json', error: 'testResultsは配列が必要です' });
  }

  const counts = {
    total: report.numPassedTests + report.numFailedTests,
    pass: report.numPassedTests,
    fail: report.numFailedTests,
    skipped: report.numPendingTests,
    todo: report.numTodoTests,
    cancelled: 0,
  };
  if (report.numTotalTests !== counts.total + counts.skipped + counts.todo) {
    counts.planMismatch = true;
    counts.mismatchReasons = ['summary'];
  }

  const testNames = [];
  let assertionCount = 0;
  for (const testResult of report.testResults) {
    if (!testResult || !Array.isArray(testResult.assertionResults)) continue;
    for (const assertion of testResult.assertionResults) {
      const status = String(assertion?.status || '').toLowerCase();
      if (!['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled'].includes(status)) continue;
      assertionCount += 1;
      if (status !== 'passed' && status !== 'failed') continue;
      const fallbackName = [
        ...(Array.isArray(assertion?.ancestorTitles) ? assertion.ancestorTitles : []),
        assertion?.title,
      ].filter((part) => typeof part === 'string' && part.trim()).join(' ');
      const name = typeof assertion?.fullName === 'string' && assertion.fullName.trim()
        ? assertion.fullName.trim()
        : fallbackName.trim();
      if (name) testNames.push(name);
    }
  }
  if (assertionCount !== report.numTotalTests) {
    counts.planMismatch = true;
    counts.mismatchReasons = ['summary'];
  }

  return { counts, testNames, reportDetected: true, format: 'vitest-json' };
}

export function embedVitestJsonReport(rawReport) {
  return `${VITEST_JSON_REPORT_BEGIN}\n${String(rawReport || '').trim()}\n${VITEST_JSON_REPORT_END}\n`;
}

export function parseTestReport(rawOutput) {
  const raw = String(rawOutput || '').replaceAll('\r\n', '\n');
  const begin = `${VITEST_JSON_REPORT_BEGIN}\n`;
  const beginIndex = raw.lastIndexOf(begin);
  if (beginIndex >= 0) {
    const reportStart = beginIndex + begin.length;
    const endIndex = raw.indexOf(`\n${VITEST_JSON_REPORT_END}`, reportStart);
    if (endIndex >= 0) return parseVitestJsonReport(raw.slice(reportStart, endIndex));
  }
  return parseTapTestReport(raw);
}

export function testRunExitCode(childExitCode, counts) {
  if (childExitCode !== 0 || counts.fail > 0) return TEST_RUN_EXIT_CODES.TEST_FAILED;
  if (counts.skipped > 0 || counts.cancelled > 0) return TEST_RUN_EXIT_CODES.SKIPPED;
  if (counts.total === 0) return TEST_RUN_EXIT_CODES.NO_TESTS;
  return 0;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deployGateRecordDigest(record) {
  const unsigned = { ...record };
  delete unsigned.recordIntegrity;
  return sha256(canonicalJson(unsigned));
}

function sameInstant(left, right) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

function shellWords(command) {
  if (typeof command !== 'string') return null;
  const words = [];
  let current = '';
  let state = 'plain';
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (state === 'single') {
      if (character === "'") state = 'plain';
      else current += character;
      continue;
    }
    if (state === 'double') {
      if (character === '"') {
        state = 'plain';
      } else if (character === '\\') {
        index += 1;
        if (index >= command.length) return null;
        const escaped = command[index];
        if (escaped === '\n') continue;
        if (!['$', '`', '"', '\\'].includes(escaped)) return null;
        current += escaped;
      } else {
        current += character;
      }
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        words.push(current);
        current = '';
        started = false;
      }
    } else if (character === "'") {
      state = 'single';
      started = true;
    } else if (character === '"') {
      state = 'double';
      started = true;
    } else if (character === '\\') {
      index += 1;
      if (index >= command.length) return null;
      if (command[index] === '\n') continue;
      current += command[index];
      started = true;
    } else {
      current += character;
      started = true;
    }
  }
  if (state !== 'plain') return null;
  if (started) words.push(current);
  return words;
}

function validInitialRollbackCommand(command, service) {
  const words = shellWords(command);
  if (!words || words.length < 6) return false;
  const expectedPrefix = ['gcloud', 'run', 'services', 'delete', service?.name];
  if (expectedPrefix.some((value, index) => words[index] !== value)) return false;
  const values = {};
  let quiet = false;
  for (let index = 5; index < words.length;) {
    const token = words[index];
    if (token === '--quiet') {
      if (quiet) return false;
      quiet = true;
      index += 1;
      continue;
    }
    let matched = false;
    for (const field of ['project', 'region']) {
      const option = `--${field}`;
      if (token === option) {
        if (Object.hasOwn(values, field) || index + 1 >= words.length) return false;
        values[field] = words[index + 1];
        index += 2;
        matched = true;
        break;
      }
      if (token.startsWith(`${option}=`)) {
        if (Object.hasOwn(values, field)) return false;
        values[field] = token.slice(option.length + 1);
        index += 1;
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return quiet && values.project === service?.project && values.region === service?.region;
}

function validateDeployGateIntegrity(record, errors) {
  if (record?.gateVersion !== 'deploy-gate/v2') {
    errors.push('deploy-gate記録のgateVersion=deploy-gate/v2が必要です');
  }
  const integrity = record?.recordIntegrity;
  if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity)) {
    errors.push('deploy-gate記録のrecordIntegrityが必要です');
    return;
  }
  if (integrity.algorithm !== 'sha256' || integrity.canonicalization !== 'json-sort-keys-v1') {
    errors.push('deploy-gate記録のrecordIntegrityはsha256/json-sort-keys-v1必須です');
  }
  if (typeof integrity.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(integrity.digest)) {
    errors.push('deploy-gate記録のrecordIntegrity.digestは64桁のsha256必須です');
  } else if (integrity.digest !== deployGateRecordDigest(record)) {
    errors.push('deploy-gate記録のrecordIntegrity.digestがcanonical JSONと一致しません');
  }
  // これは未鍵付きdigestなので、記録を書き換えられる攻撃者はdigestも再計算できる。
  // その残余リスクは、以下の実行痕跡と全フィールドの相互整合をfail-closedで検証して縮小する。
}

function validateDeployGateExecutionTrace(record, errors) {
  const trace = record?.executionTrace;
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
    errors.push('deploy-gate記録のexecutionTraceが必要です');
    return;
  }
  if (trace.generator !== 'knowledge/scripts/deploy-gate.sh') {
    errors.push('deploy-gate記録のexecutionTrace.generatorが不正です');
  }
  if (trace.result !== 'DEPLOY_GATE_PASSED') {
    errors.push('deploy-gate記録のexecutionTrace.result=DEPLOY_GATE_PASSEDが必要です');
  }
  const startedAt = Date.parse(trace.startedAt);
  const completedAt = Date.parse(trace.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || startedAt > completedAt) {
    errors.push('deploy-gate記録のexecutionTrace開始・完了時刻が不正です');
  }
  if (!sameInstant(trace.completedAt, record?.recordedAt)) {
    errors.push('deploy-gate記録のexecutionTrace.completedAtがrecordedAtと一致しません');
  }

  const initialService = record?.initial_service === true;
  const service = record?.service;
  const serviceQuery = trace.serviceQuery;
  if (!serviceQuery || typeof serviceQuery !== 'object' || Array.isArray(serviceQuery)) {
    errors.push('deploy-gate記録のexecutionTrace.serviceQueryが必要です');
  } else {
    if (serviceQuery.method !== 'gcloud-run-services-describe') {
      errors.push('deploy-gate記録のserviceQuery.methodが不正です');
    }
    for (const [field, expected] of [
      ['service', service?.name],
      ['region', service?.region],
      ['latestReadyRevisionName', service?.latestReadyRevisionName],
    ]) {
      if (serviceQuery[field] !== expected) errors.push(`deploy-gate記録のserviceQuery.${field}がservice記録と一致しません`);
    }
    if (initialService && serviceQuery.result !== 'NOT_FOUND') {
      errors.push('初回deploy-gate記録のserviceQuery.result=NOT_FOUNDが必要です');
    }
  }

  const revisionQuery = trace.revisionQuery;
  if (initialService) {
    if (revisionQuery !== null) errors.push('初回deploy-gate記録のexecutionTrace.revisionQueryはnull必須です');
  } else if (!revisionQuery || typeof revisionQuery !== 'object' || Array.isArray(revisionQuery)) {
    errors.push('deploy-gate記録のexecutionTrace.revisionQueryが必要です');
  } else {
    if (revisionQuery.method !== 'gcloud-run-revisions-describe') {
      errors.push('deploy-gate記録のrevisionQuery.methodが不正です');
    }
    for (const [field, expected] of [
      ['revision', service?.latestReadyRevisionName],
      ['region', service?.region],
      ['imageDigest', service?.imageDigest],
    ]) {
      if (revisionQuery[field] !== expected) errors.push(`deploy-gate記録のrevisionQuery.${field}がservice記録と一致しません`);
    }
  }

  const provenance = record?.productionProvenance;
  const provenanceTrace = trace.provenanceVerification;
  if (!provenanceTrace || typeof provenanceTrace !== 'object' || Array.isArray(provenanceTrace)) {
    errors.push('deploy-gate記録のexecutionTrace.provenanceVerificationが必要です');
  } else {
    for (const field of ['source', 'branch', 'commit', 'artifactImage']) {
      if ((provenanceTrace[field] ?? null) !== (provenance?.[field] ?? null)) {
        errors.push(`deploy-gate記録のprovenanceVerification.${field}がproductionProvenanceと一致しません`);
      }
    }
    if (provenanceTrace.method !== provenance?.origin) {
      errors.push('deploy-gate記録のprovenanceVerification.methodがproductionProvenance.originと一致しません');
    }
    const expectedVerified = provenance?.origin === 'artifact-registry-slsa-provenance';
    if (provenanceTrace.verified !== expectedVerified) {
      errors.push('deploy-gate記録のprovenanceVerification.verifiedがprovenance methodと矛盾しています');
    }
  }

  const deployBase = record?.deployBase;
  const hasApproval = typeof deployBase?.userApprovalFile === 'string' && Boolean(deployBase.userApprovalFile.trim());
  const expectedBaseMethod = deployBase?.matchesProductionCommit === true
    ? 'production-commit-match'
    : deployBase?.mechanicallyVerified === true
      ? 'git-ancestor'
      : 'user-approval-file';
  const baseTrace = trace.deployBaseVerification;
  if (!baseTrace || typeof baseTrace !== 'object' || Array.isArray(baseTrace)) {
    errors.push('deploy-gate記録のexecutionTrace.deployBaseVerificationが必要です');
  } else {
    if (baseTrace.method !== expectedBaseMethod || baseTrace.verified !== true) {
      errors.push('deploy-gate記録のdeployBaseVerification method/verifiedがdeployBaseと矛盾しています');
    }
    for (const [field, expected] of [
      ['productionCommit', provenance?.commit],
      ['deployBaseCommit', deployBase?.commit],
      ['proofFile', deployBase?.proofFile ?? null],
    ]) {
      if ((baseTrace[field] ?? null) !== (expected ?? null)) {
        errors.push(`deploy-gate記録のdeployBaseVerification.${field}がdeployBase/provenanceと一致しません`);
      }
    }
  }

  const approvalTrace = trace.approvalVerification;
  if (!approvalTrace || typeof approvalTrace !== 'object' || Array.isArray(approvalTrace)) {
    errors.push('deploy-gate記録のexecutionTrace.approvalVerificationが必要です');
  } else {
    const expectedApprovalMethod = hasApproval ? 'user-approval-file' : 'not-required';
    if (
      approvalTrace.method !== expectedApprovalMethod ||
      approvalTrace.verified !== hasApproval ||
      (approvalTrace.file ?? null) !== (deployBase?.userApprovalFile ?? null)
    ) {
      errors.push('deploy-gate記録のapprovalVerificationがdeployBase.userApprovalFileと矛盾しています');
    }
    for (const [field, expected] of [
      ['service', service?.name],
      ['latestReadyRevisionName', service?.latestReadyRevisionName],
      ['imageDigest', service?.imageDigest],
      ['deployBaseCommit', deployBase?.commit],
    ]) {
      if (approvalTrace[field] !== expected) {
        errors.push(`deploy-gate記録のapprovalVerification.${field}が承認対象と一致しません`);
      }
    }
  }

  const rollbackTrace = trace.rollbackVerification;
  if (!rollbackTrace || typeof rollbackTrace !== 'object' || Array.isArray(rollbackTrace)) {
    errors.push('deploy-gate記録のexecutionTrace.rollbackVerificationが必要です');
  } else if (
    rollbackTrace.method !== (initialService ? 'gcloud-run-service-delete' : 'gcloud-run-traffic') ||
    rollbackTrace.service !== service?.name ||
    rollbackTrace.rollbackCommand !== record?.rollbackCommand
  ) {
    errors.push('deploy-gate記録のrollbackVerificationがservice/rollbackCommandと一致しません');
  }
  if (typeof record?.rollbackCommand === 'string' && typeof service?.name === 'string') {
    if (initialService && !validInitialRollbackCommand(record.rollbackCommand, service)) {
      errors.push('初回deploy-gate記録のrollbackCommandは同一service/project/regionへのquiet delete必須です');
    } else if (!initialService) {
      const escapedService = service.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const commandPattern = new RegExp(`^gcloud\\s+run\\s+services\\s+update-traffic\\s+${escapedService}(?:\\s|$)`, 'u');
      if (!commandPattern.test(record.rollbackCommand) || !/(?:^|\s)--to-revisions(?:=|\s+)/u.test(record.rollbackCommand)) {
        errors.push('deploy-gate記録のrollbackCommandは同一serviceへのgcloud traffic rollbackである必要があります');
      }
    }
  }

  const keyTrace = trace.keyRotationVerification;
  const keyRecord = record?.keyRotationVerification;
  if (!keyTrace || typeof keyTrace !== 'object' || Array.isArray(keyTrace)) {
    errors.push('deploy-gate記録のexecutionTrace.keyRotationVerificationが必要です');
  } else {
    const expectedMethod = keyRecord?.required === true ? 'live-serving-path' : 'not-required';
    if (
      keyTrace.method !== expectedMethod ||
      keyTrace.status !== keyRecord?.status ||
      (keyTrace.evidence ?? null) !== (keyRecord?.livePathEvidence ?? null)
    ) {
      errors.push('deploy-gate記録のexecutionTrace.keyRotationVerificationが記録本体と矛盾しています');
    }
  }
}

function jsonPointerValue(document, pointer, label, errors) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
    errors.push(`${label}.json_pointerは/で始まるJSON Pointerが必要です`);
    return undefined;
  }
  let current = document;
  for (const rawToken of pointer.slice(1).split('/')) {
    if (/~(?![01])/u.test(rawToken)) {
      errors.push(`${label}.json_pointerのescapeが不正です`);
      return undefined;
    }
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, token)
    ) {
      errors.push(`${label}.json_pointerがartifact内に存在しません: ${pointer}`);
      return undefined;
    }
    current = current[token];
  }
  return current;
}

function artifactItemIds(root, descriptor, label, errors, { allowEmpty = false } = {}) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    errors.push(`${label}はpath/sha256/json_pointer/itemsを持つobjectが必要です`);
    return null;
  }
  requiredText(descriptor.path, `${label}.path`, errors);
  requiredText(descriptor.sha256, `${label}.sha256`, errors);
  requiredText(descriptor.json_pointer, `${label}.json_pointer`, errors);
  if (typeof descriptor.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(descriptor.sha256)) {
    errors.push(`${label}.sha256は64桁のsha256必須です`);
  }
  if (!Array.isArray(descriptor.items) || (!allowEmpty && descriptor.items.length === 0)) {
    errors.push(`${label}.itemsは${allowEmpty ? 'array' : '1件以上'}必要です`);
  } else {
    for (const [index, item] of descriptor.items.entries()) requiredText(item, `${label}.items[${index}]`, errors);
  }
  if (typeof descriptor.path !== 'string' || !descriptor.path.trim() || !root) {
    if (!root) errors.push(`${label}の実測にはrepo rootが必要です`);
    return null;
  }
  if (isAbsolute(descriptor.path)) {
    errors.push(`${label}.pathはrepo相対パスが必要です`);
    return null;
  }

  let raw;
  try {
    const absolute = resolveRepoPath(root, descriptor.path, `${label}.path`);
    ensureRegularFile(absolute, `${label}.path`);
    const real = realpathSync(absolute);
    if (!isInside(realpathSync(root), real)) throw new Error(`${label}.pathはrepo内を指定してください`);
    raw = readFileSync(real);
  } catch (error) {
    errors.push(`${label}のartifactを読めません: ${error.message}`);
    return null;
  }
  const actualHash = sha256(raw);
  if (descriptor.sha256 !== actualHash) errors.push(`${label}.sha256が実artifactと一致しません`);

  let document;
  try {
    document = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    errors.push(`${label}のartifactはJSON必須です: ${error.message}`);
    return null;
  }
  const items = jsonPointerValue(document, descriptor.json_pointer, label, errors);
  if (!Array.isArray(items)) {
    if (items !== undefined) errors.push(`${label}.json_pointerの参照先はarray必須です`);
    return null;
  }
  if (items.length === 0) {
    if (!allowEmpty) errors.push(`${label}の実測項目は1件以上必要です（0件の自己一致は許可しません）`);
    return [];
  }

  const ids = [];
  for (const [index, item] of items.entries()) {
    let id;
    if (descriptor.item_key !== undefined) {
      if (typeof descriptor.item_key !== 'string' || !descriptor.item_key.trim()) {
        errors.push(`${label}.item_keyは空でない文字列が必要です`);
        return null;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item) || !Object.hasOwn(item, descriptor.item_key)) {
        errors.push(`${label}の項目[${index}]にitem_key '${descriptor.item_key}' がありません`);
        continue;
      }
      id = item[descriptor.item_key];
    } else {
      id = item;
    }
    if (!['string', 'number', 'boolean'].includes(typeof id) || !String(id).trim()) {
      errors.push(`${label}の項目[${index}]から非空のprimitive IDを実測できません`);
      continue;
    }
    ids.push(String(id));
  }
  if (new Set(ids).size !== ids.length) errors.push(`${label}の実測項目IDに重複があります`);
  if (
    Array.isArray(descriptor.items) &&
    (descriptor.items.length !== ids.length || descriptor.items.some((item, index) => item !== ids[index]))
  ) {
    errors.push(`${label}.itemsが実artifactの項目一覧と一致しません`);
  }
  return ids;
}

function validateElementCounts(evidence, errors, { root, artifactRequired = false } = {}) {
  const counts = evidence?.element_counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    errors.push('element_countsはexpected_count/actual_countを持つobjectが必要です');
    return;
  }
  if (!Number.isInteger(counts.expected_count) || counts.expected_count < 0) {
    errors.push('element_counts.expected_countは0以上の整数が必要です');
  }
  if (!Number.isInteger(counts.actual_count) || counts.actual_count < 0) {
    errors.push('element_counts.actual_countは0以上の整数が必要です');
  }
  const zeroCountReason = typeof counts.zero_count_reason === 'string' ? counts.zero_count_reason.trim() : '';
  if (counts.actual_count === 0 && !zeroCountReason) {
    errors.push('element_counts.actual_countが0件の場合はzero_count_reasonに許容理由が必要です');
  }
  if (
    Number.isInteger(counts.expected_count) &&
    Number.isInteger(counts.actual_count) &&
    counts.expected_count !== counts.actual_count
  ) {
    errors.push(`確認要素の期待件数と実測件数が一致しません（期待=${counts.expected_count} / 実測=${counts.actual_count}）`);
  }
  if (Array.isArray(evidence?.checkedElements) && Number.isInteger(counts.actual_count)) {
    if (counts.actual_count !== evidence.checkedElements.length) {
      errors.push(`element_counts.actual_countがcheckedElements件数と一致しません（実測=${counts.actual_count} / 証跡=${evidence.checkedElements.length}）`);
    }
  }
  if (!artifactRequired) return;

  if (
    root &&
    typeof counts.source?.path === 'string' &&
    typeof counts.output_artifact?.path === 'string' &&
    typeof counts.source?.json_pointer === 'string' &&
    counts.source.json_pointer === counts.output_artifact?.json_pointer
  ) {
    try {
      const sourcePath = resolveRepoPath(root, counts.source.path, 'element_counts.source.path');
      const outputPath = resolveRepoPath(root, counts.output_artifact.path, 'element_counts.output_artifact.path');
      if (resolve(sourcePath) === resolve(outputPath)) {
        errors.push('element_countsの源泉と出力artifactは同一path/json_pointerを参照できません');
      }
    } catch {
      // artifactItemIdsがpathごとの具体的な検証エラーを返す。
    }
  }

  const allowEmpty = counts.actual_count === 0 && Boolean(zeroCountReason);
  const sourceIds = artifactItemIds(root, counts.source, 'element_counts.source', errors, { allowEmpty });
  const outputIds = artifactItemIds(root, counts.output_artifact, 'element_counts.output_artifact', errors, { allowEmpty });
  if (sourceIds && Number.isInteger(counts.expected_count) && counts.expected_count !== sourceIds.length) {
    errors.push(`element_counts.expected_countが源泉artifactの実測件数と一致しません（申告=${counts.expected_count} / 実測=${sourceIds.length}）`);
  }
  if (outputIds && Number.isInteger(counts.actual_count) && counts.actual_count !== outputIds.length) {
    errors.push(`element_counts.actual_countが出力artifactの実測件数と一致しません（申告=${counts.actual_count} / 実測=${outputIds.length}）`);
  }
  if (sourceIds && outputIds) {
    const sourceSet = new Set(sourceIds);
    const outputSet = new Set(outputIds);
    const missing = sourceIds.filter((item) => !outputSet.has(item));
    const extra = outputIds.filter((item) => !sourceSet.has(item));
    if (missing.length || extra.length) {
      errors.push(`源泉と出力artifactの項目一覧が一致しません（欠落=${missing.join(',') || 'なし'} / 余剰=${extra.join(',') || 'なし'}）`);
    }
  }
}

function validateRegressionCheck(evidence, errors, { required = false, root } = {}) {
  const check = evidence?.regression_check;
  if (check === undefined && !required) return;
  if (!check || typeof check !== 'object' || Array.isArray(check)) {
    errors.push('browser E2Eはregression_checkが必要です');
    return;
  }
  const gate = check.deploy_gate;
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
    errors.push('regression_check.deploy_gateは機械照合情報が必要です');
  }
  if (!Array.isArray(check.items) || check.items.length === 0) {
    errors.push('regression_check.itemsは1件以上必要です');
    return;
  }
  const allowedResults = new Set(['equivalent', 'degraded', 'unchecked']);
  const itemNames = [];
  for (const [index, item] of check.items.entries()) {
    requiredText(item?.name, `regression_check.items[${index}].name`, errors);
    if (!allowedResults.has(item?.result)) {
      errors.push(`regression_check.items[${index}].resultが不正です`);
    }
    if (item?.result !== 'equivalent') {
      errors.push(`regression_checkの全major surfaceはequivalent必須です: ${String(item?.name || `item-${index + 1}`)}=${String(item?.result)}`);
    }
    if (typeof item?.name === 'string' && item.name.trim()) itemNames.push(item.name);
  }
  if (new Set(itemNames).size !== itemNames.length) errors.push('regression_check.itemsのnameに重複があります');

  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) return;
  for (const field of ['path', 'sha256', 'service']) {
    requiredText(gate[field], `regression_check.deploy_gate.${field}`, errors);
  }
  if (typeof gate.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(gate.sha256)) {
    errors.push('regression_check.deploy_gate.sha256は64桁のsha256必須です');
  }
  if (!root) {
    errors.push('deploy-gate記録の機械照合にはrepo rootが必要です');
    return;
  }
  if (typeof gate.path !== 'string' || !gate.path.trim() || isAbsolute(gate.path)) {
    errors.push('regression_check.deploy_gate.pathはrepo相対パスが必要です');
    return;
  }
  if (!gate.path.startsWith('.ai/deploy-gates/')) {
    errors.push('regression_check.deploy_gate.pathは.ai/deploy-gates/配下が必要です');
    return;
  }

  let raw;
  let record;
  try {
    const absolute = resolveRepoPath(root, gate.path, 'regression_check.deploy_gate.path');
    ensureRegularFile(absolute, 'deploy-gate記録');
    if ((statSync(absolute).mode & 0o077) !== 0) {
      errors.push('deploy-gate記録はdeploy-gate.shと同じくowner-only権限である必要があります');
    }
    raw = readFileSync(absolute);
    record = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    errors.push(`deploy-gate記録を読めません: ${error.message}`);
    return;
  }
  if (gate.sha256 !== sha256(raw)) errors.push('regression_check.deploy_gate.sha256が実記録と一致しません');
  if (record?.schemaVersion !== 1 || record?.status !== 'passed') {
    errors.push('deploy-gate記録はschemaVersion=1かつstatus=passed必須です');
  }
  validateDeployGateIntegrity(record, errors);
  validateDeployGateExecutionTrace(record, errors);
  const initialService = record?.initial_service === true;
  if (record?.initial_service !== undefined && record.initial_service !== true) {
    errors.push('deploy-gate記録のinitial_serviceは指定時true必須です');
  }
  if (initialService) {
    if (record?.live_revision !== null) errors.push('初回deploy-gate記録のlive_revisionはnull必須です');
    if (record?.service?.latestReadyRevisionName !== null || record?.service?.imageDigest !== null) {
      errors.push('初回deploy-gate記録のrevision/imageDigestはnull必須です');
    }
    if (gate.latest_ready_revision_name !== null || gate.image_digest !== null) {
      errors.push('初回regression_check.deploy_gateのrevision/image digestはnull必須です');
    }
    if (check.baseline !== null) errors.push('初回regression_check.baselineはnull必須です');
    requiredText(record?.service?.project, '初回deploy-gate記録のservice.project', errors);
  } else {
    requiredText(check.baseline, 'regression_check.baseline', errors);
    requiredText(gate.latest_ready_revision_name, 'regression_check.deploy_gate.latest_ready_revision_name', errors);
    requiredText(gate.image_digest, 'regression_check.deploy_gate.image_digest', errors);
  }
  const recordedAt = Date.parse(record?.recordedAt);
  const executedAt = Date.parse(evidence?.executedAt);
  if (!Number.isFinite(recordedAt)) {
    errors.push('deploy-gate記録のrecordedAtは有効な日時が必要です');
  } else if (Number.isFinite(executedAt) && recordedAt > executedAt) {
    errors.push('deploy-gate記録のrecordedAtはE2E実行時刻以前である必要があります');
  }
  requiredText(record?.service?.region, 'deploy-gate記録のservice.region', errors);
  if (!initialService && (typeof record?.service?.imageDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.service.imageDigest))) {
    errors.push('deploy-gate記録のservice.imageDigestは完全なsha256 digest必須です');
  }
  for (const [field, actual] of [
    ['service', record?.service?.name],
    ['latest_ready_revision_name', record?.service?.latestReadyRevisionName],
    ['image_digest', record?.service?.imageDigest],
  ]) {
    if (gate[field] !== actual) errors.push(`regression_check.deploy_gate.${field}が実記録と一致しません`);
  }
  if (check.baseline !== gate.latest_ready_revision_name) {
    errors.push('regression_check.baselineがdeploy-gateのlatestReadyRevisionNameと一致しません');
  }
  if (record?.regressionChecklist?.requiredAfterDeploy !== true) {
    errors.push('deploy-gate記録のregressionChecklist.requiredAfterDeploy=trueが必要です');
  }
  const provenance = record?.productionProvenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    errors.push('deploy-gate記録のproductionProvenanceが必要です');
  } else {
    for (const field of ['source', 'branch', 'commit', 'origin']) {
      requiredText(provenance[field], `deploy-gate記録のproductionProvenance.${field}`, errors);
    }
    if (provenance.commit !== 'unknown' && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(String(provenance.commit))) {
      errors.push('deploy-gate記録のproductionProvenance.commitは完全なGit object IDまたはunknown必須です');
    }
    if (!['artifact-registry-slsa-provenance', 'unknown'].includes(provenance.origin)) {
      errors.push('deploy-gate記録のproductionProvenance.originが不正です');
    } else if (provenance.origin === 'artifact-registry-slsa-provenance') {
      requiredText(provenance.artifactImage, 'deploy-gate記録のproductionProvenance.artifactImage', errors);
      if (typeof provenance.artifactImage === 'string' && !provenance.artifactImage.endsWith(`@${record?.service?.imageDigest || ''}`)) {
        errors.push('deploy-gate記録のproductionProvenance.artifactImageがservice.imageDigestと一致しません');
      }
    } else if (
      provenance.source !== 'unknown' ||
      provenance.branch !== 'unknown' ||
      provenance.commit !== 'unknown' ||
      provenance.artifactImage != null
    ) {
      errors.push('deploy-gate記録のunknown provenanceとsource/branch/commit/artifactImageが矛盾しています');
    }
  }
  const deployBase = record?.deployBase;
  if (!deployBase || typeof deployBase !== 'object' || Array.isArray(deployBase)) {
    errors.push('deploy-gate記録のdeployBaseが必要です');
  } else {
    requiredText(deployBase.ref, 'deploy-gate記録のdeployBase.ref', errors);
    if (typeof deployBase.commit !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(deployBase.commit)) {
      errors.push('deploy-gate記録のdeployBase.commitは完全なGit object ID必須です');
    }
    for (const field of ['matchesProductionCommit', 'mechanicallyVerified']) {
      if (typeof deployBase[field] !== 'boolean') errors.push(`deploy-gate記録のdeployBase.${field}はboolean必須です`);
    }
    const provenanceKnown =
      provenance?.origin === 'artifact-registry-slsa-provenance' &&
      provenance?.source !== 'unknown' &&
      provenance?.branch !== 'unknown' &&
      provenance?.commit !== 'unknown';
    const hasApproval = typeof deployBase.userApprovalFile === 'string' && Boolean(deployBase.userApprovalFile.trim());
    if (!provenanceKnown && !hasApproval) {
      errors.push('deploy-gate記録は検証済みproductionProvenanceまたはuserApprovalFileが必要です');
    }
    if (
      provenanceKnown &&
      deployBase.matchesProductionCommit === true &&
      deployBase.commit !== provenance?.commit
    ) {
      errors.push('deploy-gate記録のdeployBase.matchesProductionCommitとcommitが矛盾しています');
    }
    if (
      deployBase.matchesProductionCommit !== true &&
      deployBase.mechanicallyVerified !== true &&
      !hasApproval
    ) {
      errors.push('deploy-gate記録の異なるdeployBaseにはmechanical proofまたはuser approvalが必要です');
    }
    if (deployBase.mechanicallyVerified === true) {
      requiredText(deployBase.proofFile, 'deploy-gate記録のdeployBase.proofFile', errors);
      if (!provenanceKnown) errors.push('deploy-gate記録のmechanical proofには検証済みproductionProvenanceが必要です');
    }
    const declared = record?.declaredProductionProvenance;
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
      errors.push('deploy-gate記録のdeclaredProductionProvenanceが必要です');
    } else {
      for (const field of ['source', 'branch', 'commit']) {
        if (declared[field] !== null && (typeof declared[field] !== 'string' || !declared[field].trim())) {
          errors.push(`deploy-gate記録のdeclaredProductionProvenance.${field}はnullまたは非空文字列必須です`);
        } else if (declared[field] !== null && declared[field] !== provenance?.[field] && !hasApproval) {
          errors.push(`deploy-gate記録のdeclaredProductionProvenance.${field}がprovider provenanceと一致しません`);
        }
      }
    }
  }
  requiredText(record?.rollbackCommand, 'deploy-gate記録のrollbackCommand', errors);
  if (!record?.keyRotationVerification || typeof record.keyRotationVerification !== 'object' || Array.isArray(record.keyRotationVerification)) {
    errors.push('deploy-gate記録のkeyRotationVerificationが必要です');
  } else {
    if (typeof record.keyRotationVerification.required !== 'boolean') {
      errors.push('deploy-gate記録のkeyRotationVerification.requiredはboolean必須です');
    }
    requiredText(record.keyRotationVerification.status, 'deploy-gate記録のkeyRotationVerification.status', errors);
    if (record.keyRotationVerification.required === true) {
      if (record.keyRotationVerification.status !== 'passed') {
        errors.push('deploy-gate記録のkey rotationはpassed必須です');
      }
      requiredText(record.keyRotationVerification.livePathEvidence, 'deploy-gate記録のkeyRotationVerification.livePathEvidence', errors);
    }
  }
  if (!Array.isArray(record?.rejectionReasons) || record.rejectionReasons.length !== 0) {
    errors.push('passed deploy-gate記録のrejectionReasonsは空配列必須です');
  }
  const majorSurfaces = record?.regressionChecklist?.majorSurfaces;
  if (!Array.isArray(majorSurfaces) || majorSurfaces.length === 0 || majorSurfaces.some((item) => typeof item !== 'string' || !item.trim())) {
    errors.push('deploy-gate記録のmajorSurfacesは1件以上必要です');
    return;
  }
  if (new Set(majorSurfaces).size !== majorSurfaces.length) errors.push('deploy-gate記録のmajorSurfacesに重複があります');
  const recordedSet = new Set(majorSurfaces);
  const evidenceSet = new Set(itemNames);
  const missing = majorSurfaces.filter((item) => !evidenceSet.has(item));
  const extra = itemNames.filter((item) => !recordedSet.has(item));
  if (missing.length || extra.length || itemNames.length !== majorSurfaces.length) {
    errors.push(`regression_check.itemsがdeploy-gateの全major surfaceと一致しません（欠落=${missing.join(',') || 'なし'} / 余剰=${extra.join(',') || 'なし'}）`);
  }
}

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function validateBlockedEvidence(evidence, expected = {}) {
  const errors = [];
  if (evidence?.schemaVersion !== E2E_SCHEMA_VERSION) errors.push(`schemaVersionは${E2E_SCHEMA_VERSION}必須です`);
  if (evidence?.status !== 'blocked') errors.push('blocked証跡のstatusはblocked必須です');
  requiredText(evidence?.taskId, 'taskId', errors);
  requiredText(evidence?.taskFingerprint, 'taskFingerprint', errors);
  requiredText(evidence?.repo, 'repo', errors);
  requiredText(evidence?.branch, 'branch', errors);
  requiredText(evidence?.url, 'url', errors);
  requiredText(evidence?.executedAt, 'executedAt', errors);
  requiredText(evidence?.browser?.name, 'browser.name', errors);
  requiredText(evidence?.browser?.version, 'browser.version', errors);
  requiredText(evidence?.blocker?.reason, 'blocker.reason', errors);
  if (!Array.isArray(evidence?.blocker?.requiredEnvironment) || evidence.blocker.requiredEnvironment.length === 0) {
    errors.push('blocker.requiredEnvironmentは1件以上必要です');
  }
  for (const [field, value] of Object.entries({
    taskId: expected.taskId,
    taskFingerprint: expected.taskFingerprint,
    repo: expected.repo,
    branch: expected.branch,
  })) {
    if (value && evidence?.[field] !== value) errors.push(`${field}が現在タスクと一致しません`);
  }
  return errors;
}

export function validateFailedEvidence(evidence, expected = {}) {
  const errors = [];
  if (evidence?.schemaVersion !== E2E_SCHEMA_VERSION) errors.push(`schemaVersionは${E2E_SCHEMA_VERSION}必須です`);
  if (evidence?.status !== 'failed') errors.push('failed証跡のstatusはfailed必須です');
  for (const field of ['taskId', 'taskFingerprint', 'repo', 'branch', 'url', 'executedAt']) {
    requiredText(evidence?.[field], field, errors);
  }
  requiredText(evidence?.browser?.name, 'browser.name', errors);
  requiredText(evidence?.browser?.version, 'browser.version', errors);
  requiredText(evidence?.failure?.reason, 'failure.reason', errors);
  try {
    const url = new URL(evidence?.url);
    if (!['http:', 'https:'].includes(url.protocol)) errors.push('urlはhttp/httpsが必要です');
  } catch {
    errors.push('urlが不正です');
  }
  if (!Number.isFinite(Date.parse(evidence?.executedAt))) errors.push('executedAtが日時として不正です');
  for (const [field, value] of Object.entries({
    taskId: expected.taskId,
    taskFingerprint: expected.taskFingerprint,
    repo: expected.repo,
    branch: expected.branch,
  })) {
    if (value && evidence?.[field] !== value) errors.push(`${field}が現在タスクと一致しません`);
  }
  return errors;
}

export function validatePassedEvidence(evidence, expected = {}) {
  const errors = [];
  const root = realpathSync(expected.root || process.cwd());
  if (evidence?.schemaVersion !== E2E_SCHEMA_VERSION) errors.push(`schemaVersionは${E2E_SCHEMA_VERSION}必須です`);
  for (const field of ['taskId', 'taskFingerprint', 'repo', 'branch', 'url', 'executedAt']) {
    requiredText(evidence?.[field], field, errors);
  }
  requiredText(evidence?.gitHead, 'gitHead', errors);
  if (typeof evidence?.gitStatusHash !== 'string' || !/^[0-9a-f]{64}$/.test(evidence.gitStatusHash)) {
    errors.push('gitStatusHashは64桁のsha256必須です');
  }
  if (typeof evidence?.worktreeHash !== 'string' || !/^[0-9a-f]{64}$/.test(evidence.worktreeHash)) {
    errors.push('worktreeHashは64桁のsha256必須です');
  }
  for (const [field, value] of Object.entries({
    taskId: expected.taskId,
    taskFingerprint: expected.taskFingerprint,
    repo: expected.repo,
    branch: expected.branch,
    gitHead: expected.gitHead,
    gitStatusHash: expected.gitStatusHash,
    worktreeHash: expected.worktreeHash,
  })) {
    if (value && evidence?.[field] !== value) errors.push(`${field}が現在のtask/worktreeと一致しません`);
  }
  try {
    const url = new URL(evidence?.url);
    if (!['http:', 'https:'].includes(url.protocol)) errors.push('urlはhttp/httpsが必要です');
  } catch {
    errors.push('urlが不正です');
  }
  const executed = Date.parse(evidence?.executedAt);
  const now = expected.now ?? Date.now();
  if (!Number.isFinite(executed)) errors.push('executedAtが日時として不正です');
  else {
    if (executed > now + 5 * 60 * 1000) errors.push('executedAtが未来です');
    const started = Date.parse(expected.startedAt || '');
    if (Number.isFinite(started) && executed < started) errors.push('証跡がtask開始より古いです');
    if (now - executed > (expected.maxAgeMs ?? DEFAULT_EVIDENCE_MAX_AGE_MS)) errors.push('証跡が有効期限を超えています');
  }
  if (evidence?.status !== 'passed') errors.push('statusがpassedではありません');
  requiredText(evidence?.browser?.name, 'browser.name', errors);
  requiredText(evidence?.browser?.version, 'browser.version', errors);
  if (!Array.isArray(evidence?.actions) || evidence.actions.length === 0) errors.push('actionsは1件以上必要です');
  else {
    for (const [index, action] of evidence.actions.entries()) {
      requiredText(action?.name, `actions[${index}].name`, errors);
      if (action?.passed !== true) errors.push(`actions[${index}].passedはtrue必須です`);
    }
  }
  if (evidence?.screenReflection?.passed !== true) errors.push('screenReflection.passedはtrue必須です');
  requiredText(evidence?.screenReflection?.details, 'screenReflection.details', errors);
  if (evidence?.reload?.passed !== true) errors.push('reload.passedはtrue必須です');
  requiredText(evidence?.reload?.details, 'reload.details', errors);
  if (!Number.isInteger(evidence?.consoleErrorCount) || evidence.consoleErrorCount !== 0) {
    errors.push('consoleErrorCountは整数0必須です');
  }
  if (!Number.isInteger(evidence?.failedNetworkRequestCount) || evidence.failedNetworkRequestCount !== 0) {
    errors.push('failedNetworkRequestCountは整数0必須です');
  }
  if (!Array.isArray(evidence?.requiredElements) || evidence.requiredElements.length === 0) {
    errors.push('requiredElementsは1件以上必要です');
  } else {
    for (const [index, label] of evidence.requiredElements.entries()) {
      requiredText(label, `requiredElements[${index}]`, errors);
    }
  }
  if (!Array.isArray(evidence?.checkedElements) || evidence.checkedElements.length === 0) {
    errors.push('checkedElementsは1件以上必要です');
  } else {
    const visibleLabels = new Set();
    const allowedKinds = new Set(['image', 'card', 'button', 'form', 'text', 'other']);
    for (const [index, item] of evidence.checkedElements.entries()) {
      requiredText(item?.label, `checkedElements[${index}].label`, errors);
      requiredText(item?.kind, `checkedElements[${index}].kind`, errors);
      if (typeof item?.kind === 'string' && !allowedKinds.has(item.kind)) {
        errors.push(`checkedElements[${index}].kindが不正です`);
      }
      if (item?.visible !== true) errors.push(`checkedElements[${index}].visibleはtrue必須です`);
      if (item?.visible === true && typeof item?.label === 'string') visibleLabels.add(item.label);
    }
    for (const label of evidence?.requiredElements || []) {
      if (!visibleLabels.has(label)) errors.push(`requiredElements '${label}' のvisible証跡がありません`);
    }
  }
  validateElementCounts(evidence, errors);
  validateRegressionCheck(evidence, errors, { required: expected.requireDeployGate === true, root });
  if (!Array.isArray(evidence?.screenshots) || evidence.screenshots.length === 0) {
    errors.push('screenshotsは1件以上必要です');
  } else {
    for (const [index, shot] of evidence.screenshots.entries()) {
      requiredText(shot?.path, `screenshots[${index}].path`, errors);
      if (typeof shot?.path !== 'string' || !shot.path.trim()) continue;
      const absolute = resolve(root, shot.path);
      try {
        const real = realpathSync(absolute);
        const stat = statSync(real);
        if (!isInside(root, real)) errors.push(`screenshots[${index}]がrepo外を指しています`);
        if (!stat.isFile() || stat.size === 0) errors.push(`screenshots[${index}]が空またはregular fileではありません`);
      } catch {
        errors.push(`screenshots[${index}]が実在しません: ${shot.path}`);
      }
    }
  }
  return errors;
}

function validateTestRunReference(evidence, errors, expected = {}) {
  const { root } = expected;
  if (typeof evidence?.testRun !== 'string' || !evidence.testRun.trim()) {
    errors.push(TEST_RUN_REFERENCE_REQUIRED_ERROR);
  }
  if (typeof evidence?.testRun !== 'string' || !evidence.testRun.trim() || !root) {
    if (!root) errors.push('testRunの実測にはrepo rootが必要です');
    return;
  }
  if (isAbsolute(evidence.testRun)) {
    errors.push('testRunはrepo相対パスが必要です');
    return;
  }

  let result;
  try {
    const resultPath = resolveRepoPath(root, evidence.testRun, 'testRun');
    ensureRegularFile(resultPath, 'testRun');
    result = readJson(resultPath);
  } catch (error) {
    errors.push(`テスト実行結果を読めません: ${error.message}`);
    return;
  }

  if (result?.schemaVersion !== TEST_RUN_SCHEMA_VERSION) {
    errors.push(`testRun.schemaVersionは${TEST_RUN_SCHEMA_VERSION}必須です`);
  }
  if (result?.producedBy !== TEST_RUN_PRODUCER) {
    errors.push('テスト実行結果が所定の実行方法で作られていません');
  }
  if (result?.taskId !== evidence?.taskId) {
    errors.push('テスト実行結果のtaskIdがE2E証跡と一致しません');
  }
  if (result?.gitHead !== evidence?.gitHead) {
    errors.push('テスト実行結果のgitHeadがE2E証跡と一致しません');
  }

  const countKeys = ['total', 'pass', 'fail', 'skipped', 'todo', 'cancelled'];
  const countsValid = result?.counts && typeof result.counts === 'object' && !Array.isArray(result.counts);
  if (!countsValid) {
    errors.push('テスト実行結果のcountsがありません');
  } else {
    for (const key of countKeys) {
      if (!Number.isInteger(result.counts[key]) || result.counts[key] < 0) {
        errors.push(`テスト実行結果のcounts.${key}は0以上の整数が必要です`);
      }
    }
  }
  if (result?.exitCode !== 0) errors.push('テストコマンドが正常終了していません');
  if (!Array.isArray(result?.testNames)) errors.push('テスト実行結果のtestNamesは配列が必要です');

  const testStartedAt = Date.parse(result?.startedAt);
  const testFinishedAt = Date.parse(result?.finishedAt);
  if (!Number.isFinite(testStartedAt) || !Number.isFinite(testFinishedAt)) {
    errors.push('テスト実行結果の開始・終了時刻が不正です');
  } else {
    if (testStartedAt > testFinishedAt) errors.push('テスト実行結果の終了時刻が開始時刻より前です');
    const evidenceExecutedAt = Date.parse(evidence?.executedAt);
    if (Number.isFinite(evidenceExecutedAt) && testFinishedAt > evidenceExecutedAt) {
      errors.push('テスト実行結果はE2E証跡を作る前に完了している必要があります');
    }
    const now = expected.now ?? Date.now();
    if (testFinishedAt > now + 5 * 60 * 1000) errors.push('テスト実行結果の終了時刻が未来です');
    if (now - testFinishedAt > (expected.maxAgeMs ?? DEFAULT_EVIDENCE_MAX_AGE_MS)) {
      errors.push('テスト実行結果が有効期限を超えているため、もう一度ai:testを実行してください');
    }
  }

  requiredText(result?.rawLogPath, 'testRun.rawLogPath', errors);
  if (typeof result?.rawLogSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(result.rawLogSha256)) {
    errors.push('testRun.rawLogSha256は64桁のsha256必須です');
  }
  let rawLog;
  if (typeof result?.rawLogPath === 'string' && result.rawLogPath.trim()) {
    if (isAbsolute(result.rawLogPath)) {
      errors.push('testRun.rawLogPathはrepo相対パスが必要です');
    } else {
      try {
        const rawLogPath = resolveRepoPath(root, result.rawLogPath, 'testRun.rawLogPath');
        ensureRegularFile(rawLogPath, 'testRun.rawLogPath');
        rawLog = readFileSync(rawLogPath);
        if (result.rawLogSha256 !== sha256(rawLog)) {
          errors.push('テストの生ログが記録時から変わっているため、この実行を合格として扱えません');
        }
      } catch (error) {
        errors.push(`テストの生ログを読めません: ${error.message}`);
      }
    }
  }

  if (rawLog && countsValid) {
    const measured = parseTestReport(rawLog.toString('utf8'));
    if (countKeys.some((key) => result.counts[key] !== measured.counts[key])) {
      errors.push('テスト実行結果の件数が生ログから数え直した件数と一致しません');
    }
    if (
      Array.isArray(result.testNames) &&
      (result.testNames.length !== measured.testNames.length ||
        result.testNames.some((name, index) => name !== measured.testNames[index]))
    ) {
      errors.push('テスト実行結果のテスト名が生ログから読み取った内容と一致しません');
    }
  }

  if (countsValid && Number.isInteger(result.counts.skipped) && result.counts.skipped > 0) {
    const executed = Number.isInteger(result.counts.total) ? result.counts.total : 0;
    errors.push(
      `テストに未実行項目があります（実行${executed}件 / skip${result.counts.skipped}件）。この実行を合格として扱えません`,
    );
  }
  if (countsValid && Number.isInteger(result.counts.cancelled) && result.counts.cancelled > 0) {
    const executed = Number.isInteger(result.counts.total) ? result.counts.total : 0;
    errors.push(
      `テストが途中で打ち切られています（実行${executed}件 / 打ち切り${result.counts.cancelled}件）。この実行を合格として扱えません`,
    );
  }
  if (countsValid && Number.isInteger(result.counts.total) && result.counts.total === 0) {
    errors.push(`テストが実行されていません（実行0件 / skip${Number(result.counts.skipped) || 0}件）。この実行を合格として扱えません`);
  }
  if (countsValid && Number.isInteger(result.counts.fail) && result.counts.fail > 0) {
    errors.push(`失敗したテストがあります（実行${Number(result.counts.total) || 0}件 / 失敗${result.counts.fail}件）`);
  }
}

export function validateNonWebEvidence(evidence, expected = {}) {
  const errors = [];
  if (evidence?.schemaVersion !== E2E_SCHEMA_VERSION) errors.push(`schemaVersionは${E2E_SCHEMA_VERSION}必須です`);
  for (const field of ['taskId', 'taskFingerprint', 'repo', 'branch', 'executedAt']) {
    requiredText(evidence?.[field], field, errors);
  }
  requiredText(evidence?.gitHead, 'gitHead', errors);
  if (typeof evidence?.gitStatusHash !== 'string' || !/^[0-9a-f]{64}$/.test(evidence.gitStatusHash)) {
    errors.push('gitStatusHashは64桁のsha256必須です');
  }
  if (typeof evidence?.worktreeHash !== 'string' || !/^[0-9a-f]{64}$/.test(evidence.worktreeHash)) {
    errors.push('worktreeHashは64桁のsha256必須です');
  }
  for (const [field, value] of Object.entries({
    taskId: expected.taskId,
    taskFingerprint: expected.taskFingerprint,
    repo: expected.repo,
    branch: expected.branch,
    gitHead: expected.gitHead,
    gitStatusHash: expected.gitStatusHash,
    worktreeHash: expected.worktreeHash,
    e2eKind: expected.e2eKind,
  })) {
    if (value && evidence?.[field] !== value) errors.push(`${field}が現在のtask/worktreeと一致しません`);
  }
  const allowedKinds = new Set(['cli', 'api', 'batch', 'library', 'docs', 'other']);
  if (!allowedKinds.has(evidence?.e2eKind)) errors.push('non_webのe2eKindが不正です');
  const executed = Date.parse(evidence?.executedAt);
  const now = expected.now ?? Date.now();
  if (!Number.isFinite(executed)) errors.push('executedAtが日時として不正です');
  else {
    if (executed > now + 5 * 60 * 1000) errors.push('executedAtが未来です');
    const started = Date.parse(expected.startedAt || '');
    if (Number.isFinite(started) && executed < started) errors.push('証跡がtask開始より古いです');
    if (now - executed > (expected.maxAgeMs ?? DEFAULT_EVIDENCE_MAX_AGE_MS)) errors.push('証跡が有効期限を超えています');
  }
  if (evidence?.status !== 'passed') errors.push('statusがpassedではありません');
  requiredText(evidence?.command, 'command', errors);
  if (evidence?.exitCode !== 0) errors.push('exitCodeは0必須です');
  requiredText(evidence?.summary, 'summary', errors);
  // docs は文書確認だけで閉じる経路なので、テスト実行結果の必須化から除外する。
  if (evidence?.e2eKind !== 'docs') validateTestRunReference(evidence, errors, expected);
  validateElementCounts(evidence, errors, { root: expected.root, artifactRequired: true });
  return errors;
}

/** repo身元を確認できない場合は、証跡照合を緩めずthrowする。 */
export function validateCompletion({ root, task, declaration, evidence, now = Date.now(), gitIdentity }) {
  const errors = [];
  // repoを確認できないまま後続照合を緩めない。呼び出し側がこの例外を完了失敗として扱う。
  const repo = validateCurrentTaskRepoName(task, actualRepoName(root));
  const git = gitIdentity || currentGitIdentity(root);
  const expected = {
    root,
    now,
    taskId: String(task?.taskId || '').trim(),
    taskFingerprint: String(task?.taskFingerprint || '').trim(),
    repo,
    branch: git.branch,
    gitHead: git.gitHead,
    gitStatusHash: git.gitStatusHash,
    worktreeHash: git.worktreeHash,
    startedAt: declaration.started,
  };
  requiredText(expected.taskId, '.ai/current-task.json taskId', errors);
  try {
    safeId(expected.taskId);
  } catch (error) {
    errors.push(error.message);
  }
  requiredText(expected.taskFingerprint, '.ai/current-task.json taskFingerprint', errors);
  if (task?.branch !== git.branch) errors.push('current-task.jsonのbranchが実branchと一致しません');
  for (const [taskField, declarationField] of [
    ['taskId', 'task_id'],
    ['taskFingerprint', 'task_fingerprint'],
    ['repo', 'repo'],
  ]) {
    if (String(task?.[taskField] || '').trim() !== String(declaration?.[declarationField] || '').trim()) {
      errors.push(`${taskField}が作業宣言と一致しません`);
    }
  }
  if (git.branch !== declaration.branch) errors.push('実branchが作業宣言と一致しません');
  if (String(task?.surfaceKind || '').trim() !== declaration.surface_kind) {
    errors.push('surfaceKindが作業宣言のsurface_kindと一致しません');
  }
  // needs_parentはレビュー指摘専用ではなく、sandbox外の親へ作業を引き継ぐためのactive状態。
  // 状態名だけでは完了できず、直後のreview_status/e2e_statusと証跡検査を従来どおり必須にする。
  if (!['running', 'needs_parent'].includes(declaration.status)) {
    errors.push('完了適用前のstatusはrunningまたはneeds_parentだけ許可します');
  }
  if (declaration.review_status !== 'passed') errors.push('review_status=passedが必要です');
  if (declaration.e2e_status !== 'passed') errors.push('e2e_status=passedが必要です');
  if (declaration.surface_kind === 'web_ui') {
    if (declaration.e2e_kind !== 'browser') errors.push('web_uiはe2e_kind=browser必須です');
    const deploymentKind = String(task?.deploymentKind || '').trim();
    if (!['production', 'non_production'].includes(deploymentKind)) {
      errors.push('web_uiのcurrent-task.jsonはdeploymentKind=production|non_productionを明示する必要があります');
    }
    if (
      task?.productionDeployment !== undefined &&
      (typeof task.productionDeployment !== 'boolean' || task.productionDeployment !== (deploymentKind === 'production'))
    ) {
      errors.push('current-task.jsonのproductionDeploymentとdeploymentKindが矛盾しています');
    }
    errors.push(...validatePassedEvidence(evidence, {
      ...expected,
      requireDeployGate: deploymentKind !== 'non_production',
    }));
  } else if (declaration.surface_kind === 'non_web') {
    if (!['cli', 'api', 'batch', 'library', 'docs', 'other'].includes(declaration.e2e_kind)) {
      errors.push('non_webは同等E2Eのe2e_kindが必要です');
    }
    errors.push(...validateNonWebEvidence(evidence, { ...expected, e2eKind: declaration.e2e_kind }));
  } else {
    errors.push('surface_kindはweb_uiまたはnon_web必須です');
  }
  return { errors, git, expected };
}

// 作業宣言の先頭にある連続した `key: 値` ブロック(以下 header)を切り出すための規則。
// 先頭の連続ブロックだけを厳密に読むのは validate-declaration.sh の field()/late_field で、
// 最初の非キー行で読みを止める。header の外に置いたキー行は validate-declaration.sh が
// 「フィールドは先頭の連続ブロックに置く」で不備にする。一方 agent-work-watchdog.sh の
// fields() と agent-session-context.sh の読み手は本文も含めたファイル全体を行単位で走査し、
// 同じ key の最初の出現を読む(先頭の header はどちらからも同じ値で読める)。そのため更新
// 対象は header 内だけに限り、新規の key は header の直後(header が見つからない入力では
// ファイル先頭)へ入れる。本文へ同名の行を置いても完了ゲートの読み手は読まないので、
// 本文側は変更しない。
const DECLARATION_HEADER_LINE = /^([a-z][a-z0-9_]*): ?/;

// 2026-09-22以前はファイル全体を走査し、見つからない key をファイル末尾へ足していた。
// 後追い完了(ai:complete --retrospective)では status/progress/closure_kind 等が完了報告
// 本文の後ろへ並び、読み手からは未設定に見えた(証拠:
// harness-closeout-20260922/application-evidence/declaration-validation.log と
// declaration-format-proof.json)。
export function replaceDeclarationFields(text, updates) {
  const remaining = new Map(Object.entries(updates ?? {}));
  const source = String(text);
  if (remaining.size === 0) return source;

  // 行末(CRLFの\r)は本文の一部として扱う。既存行の終端はそのまま残し、足す行だけ周囲に
  // 合わせる。行の位置を変えないので、本文の並び・空行・日本語はそのまま残る。
  const lines = source.split('\n');
  const stripCr = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line);

  let headerEnd = 0;
  while (headerEnd < lines.length && DECLARATION_HEADER_LINE.test(stripCr(lines[headerEnd]))) {
    headerEnd += 1;
  }

  // header の直後から末尾までの実バイト(header のみの入力では空文字列)。
  const body = lines.slice(headerEnd).join('\n');

  // header内の同じkeyは(重複していても)全て同じ値へ揃える。読み手が読むのは最初の1件なので、
  // 残った古い値は誰からも見えない不整合になる。本文側の同名行は読み手が読まないため触らない。
  const updated = new Set();
  for (let index = 0; index < headerEnd; index += 1) {
    const line = lines[index];
    const key = stripCr(line).match(DECLARATION_HEADER_LINE)[1];
    if (!remaining.has(key)) continue;
    lines[index] = `${key}: ${remaining.get(key)}${line.endsWith('\r') ? '\r' : ''}`;
    updated.add(key);
  }

  const missing = [...remaining].filter(([key]) => !updated.has(key));
  if (missing.length > 0) {
    const cr = headerEnd > 0
      ? (lines[headerEnd - 1].endsWith('\r') ? '\r' : '')
      : (source.includes('\r\n') ? '\r' : '');
    lines.splice(headerEnd, 0, ...missing.map(([key, value]) => `${key}: ${value}${cr}`));
  }

  // 本文がある場合は、入力の最終改行の有無・末尾の空行の数・CRLF をそのまま残す。読み手は
  // いずれも行単位で読み、本文の末尾バイトに依存しないため、ここで正規化する理由が無い。
  if (body.length > 0) return lines.join('\n');
  // header のみ(または空)の新規文書は、従来どおり行末を LF で終える。
  const result = lines.join('\n');
  return result.endsWith('\n') ? result : `${result}\n`;
}
