#!/usr/bin/env node
/**
 * テストを実行し、TAPまたはVitest JSONの件数・実行名・生ログを完了ゲート用の証跡として保存する。
 * 引数なしは `npm test`、引数ありはそのコマンドをshellを介さずに実行する。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import {
  TEST_RUN_PRODUCER,
  TEST_RUN_SCHEMA_VERSION,
  TEST_RUN_EXIT_CODES,
  atomicWriteJson,
  embedVitestJsonReport,
  gitValue,
  parseTestReport,
  parseVitestJsonReport,
  resolveRepoPath,
  safeId,
  testRunExitCode,
} from './ai-e2e-lib.mjs';

const root = process.cwd();
const taskPath = join(root, '.ai', 'current-task.json');

function loadTaskId() {
  try {
    const task = JSON.parse(readFileSync(taskPath, 'utf8'));
    return task?.taskId ? safeId(task.taskId) : 'untasked';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'untasked';
    throw new Error(`.ai/current-task.jsonを読めません: ${error.message}`);
  }
}

function fileStamp(date) {
  return date.toISOString().replace(/[:.]/gu, '-');
}

function displayCommand(command, args) {
  return [command, ...args].map((part) => (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(part) ? part : JSON.stringify(part))).join(' ');
}

function prepareDirectory(path, label) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}はsymlinkではない実ディレクトリが必要です`);
}

function packageTestVitestConfig(repoRoot) {
  try {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const testScript = packageJson?.scripts?.test;
    const usesVitest = typeof testScript === 'string'
      && /^\s*(?:(?:npx|bunx)\s+)?vitest(?:\s|$)/u.test(testScript)
      && !/[;&|\n]/u.test(testScript);
    return {
      usesVitest,
      hasOutputFile: usesVitest && /--outputFile(?:$|[\s.=])/u.test(testScript),
    };
  } catch {
    return { usesVitest: false, hasOutputFile: false };
  }
}

function addVitestJsonReporter(command, args, repoRoot, outputFile) {
  const executable = basename(command).toLowerCase().replace(/\.(?:cmd|exe)$/u, '');
  const firstArg = args[0] ? basename(args[0]).toLowerCase() : '';
  const directVitest = executable === 'vitest' || executable === 'vitest.mjs';
  const nodeVitest = executable === 'node' && firstArg === 'vitest.mjs';
  const runnerVitest = ['npx', 'bunx'].includes(executable) && args.some((arg) => arg === 'vitest');
  const packageTest = packageTestVitestConfig(repoRoot);
  const npmTest = ['npm', 'pnpm', 'yarn'].includes(executable)
    && ['test', 't'].includes(args[0])
    && packageTest.usesVitest;
  if (!directVitest && !nodeVitest && !runnerVitest && !npmTest) return null;
  const hasOutputFile = args.some((arg) => /^--outputFile(?:$|[.=])/u.test(arg))
    || (npmTest && packageTest.hasOutputFile);
  if (hasOutputFile) return null;
  const reporterArgs = ['--reporter=default', '--reporter=json', `--outputFile.json=${outputFile}`];
  if (npmTest) return args.includes('--') ? [...args, ...reporterArgs] : [...args, '--', ...reporterArgs];
  return [...args, ...reporterArgs];
}

function readPrivateVitestReport(path) {
  let fd;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Vitest結果はsymlinkではないregular fileが必要です: ${path}`);
    if (stat.size > 64 * 1024 * 1024) throw new Error(`Vitest結果が64MBを超えています: ${path}`);
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    if (!fstatSync(fd).isFile()) throw new Error(`Vitest結果がregular fileではありません: ${path}`);
    fchmodSync(fd, 0o600);
    return readFileSync(fd, 'utf8');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function restoreMissingVitestFailureOutput(rawReport, capturedOutput) {
  let report;
  try {
    report = JSON.parse(rawReport);
  } catch {
    return '';
  }
  const failures = [];
  for (const testResult of Array.isArray(report?.testResults) ? report.testResults : []) {
    for (const assertion of Array.isArray(testResult?.assertionResults) ? testResult.assertionResults : []) {
      if (String(assertion?.status || '').toLowerCase() !== 'failed') continue;
      const name = typeof assertion?.fullName === 'string' && assertion.fullName.trim()
        ? assertion.fullName.trim()
        : String(assertion?.title || '').trim();
      const messages = Array.isArray(assertion?.failureMessages)
        ? assertion.failureMessages.filter((message) => typeof message === 'string' && message.trim())
        : [];
      const markers = messages.map((message) => message.split('\n', 1)[0].trim()).filter(Boolean);
      const detailAlreadyVisible = markers.length > 0
        ? markers.every((marker) => capturedOutput.includes(marker))
        : Boolean(name && capturedOutput.includes(name));
      if (!detailAlreadyVisible) failures.push({ name, messages });
    }
  }
  if (failures.length === 0) return '';
  const lines = ['[ai:test] Vitestの失敗内容（既定表示を取得できなかったためJSON結果から復元）'];
  for (const failure of failures) {
    lines.push(`FAIL ${failure.name || '(テスト名なし)'}`);
    lines.push(...failure.messages);
  }
  const output = `${lines.join('\n')}\n`;
  const maxFailureOutputChars = 1_000_000;
  return output.length <= maxFailureOutputChars
    ? output
    : `${output.slice(0, maxFailureOutputChars)}\n[ai:test] Vitestの失敗内容を100万文字で省略しました\n`;
}

function writePrivateFile(path, content) {
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
    if (!fstatSync(fd).isFile()) throw new Error(`出力先がregular fileではありません: ${path}`);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const requested = process.argv.slice(2);
const defaultNpm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let [command, ...args] = requested.length ? requested : [defaultNpm, 'test'];
const taskId = loadTaskId();
const startedAt = new Date();
const gitHead = gitValue(root, ['rev-parse', 'HEAD']);
const logDir = resolveRepoPath(root, join('.ai', 'logs'), 'テスト生ログ出力先');
const resultDir = resolveRepoPath(root, join('.ai', 'e2e'), 'テスト実行結果出力先');
prepareDirectory(logDir, 'テスト生ログ出力先');
prepareDirectory(resultDir, 'テスト実行結果出力先');
const rawLogPath = join(logDir, `test-run-${fileStamp(startedAt)}-${process.pid}.tap`);
const resultPath = join(resultDir, `test-run-${taskId}.json`);
let vitestReportPath = null;
const proposedVitestReportPath = join(logDir, `vitest-report-${fileStamp(startedAt)}-${process.pid}.json`);
const vitestArgs = addVitestJsonReporter(command, args, root, proposedVitestReportPath);
if (vitestArgs) {
  args = vitestArgs;
  vitestReportPath = proposedVitestReportPath;
}
const commandLine = displayCommand(command, args);
let rawOutput = '';

function finish({ childExitCode, blockedError = null, signal = null, commandStarted = false }) {
  const finishedAt = new Date();
  const capturedOutput = rawOutput;
  const blockedFailureCode = blockedError
    ? commandStarted ? 'TEST_COMMAND_ABORTED' : 'TEST_COMMAND_NOT_STARTED'
    : null;
  let vitestReportError = null;
  if (vitestReportPath) {
    try {
      const vitestReport = readPrivateVitestReport(vitestReportPath);
      const parsedVitest = parseVitestJsonReport(vitestReport);
      if (!parsedVitest.reportDetected) throw new Error(parsedVitest.error || 'Vitest JSON結果を解析できません');
      const restoredFailureOutput = restoreMissingVitestFailureOutput(vitestReport, capturedOutput);
      if (restoredFailureOutput) {
        process.stderr.write(restoredFailureOutput);
        rawOutput += restoredFailureOutput;
      }
      rawOutput += `${rawOutput && !rawOutput.endsWith('\n') ? '\n' : ''}${embedVitestJsonReport(vitestReport)}`;
    } catch (error) {
      vitestReportError = error;
    }
  }
  if (blockedError) {
    const detailCode = blockedError.code ? ` (${blockedError.code})` : '';
    const action = commandStarted ? 'テストコマンドを途中で打ち切りました' : 'テストコマンドを起動できません';
    const line = `[ai:test] ${action}${detailCode}: ${blockedError.message}\n`;
    process.stderr.write(line);
    rawOutput += line;
  }
  if (signal) rawOutput += `[ai:test] signalで終了しました: ${signal}\n`;

  try {
    const parsed = parseTestReport(rawOutput);
    const reportMissing = !blockedError && childExitCode === 0 && !parsed.reportDetected;
    const outputMissing = !capturedOutput.trim() && (!vitestReportPath || vitestReportError);
    const invalidVitestReport = vitestReportError && vitestReportError?.code !== 'ENOENT';
    const reportFailureCode = invalidVitestReport
      ? 'TEST_REPORT_INVALID'
      : outputMissing
        ? 'TEST_OUTPUT_NOT_CAPTURED'
        : 'TEST_REPORT_NOT_DETECTED';
    if (reportMissing) {
      const detail = reportFailureCode === 'TEST_OUTPUT_NOT_CAPTURED'
        ? 'テストコマンドは正常終了しましたが、結果出力も機械可読な結果ファイルも取得できませんでした。'
        : vitestReportError
          ? `機械可読なテスト結果を取得できませんでした: ${vitestReportError.message}`
          : 'TAP形式またはVitest JSON形式のテスト集計を取得できませんでした。';
      rawOutput += `[ai:test] ${reportFailureCode}: ${detail}\n`;
    }
    writePrivateFile(rawLogPath, rawOutput);
    const blocked = Boolean(blockedError) || reportMissing;
    const exitCode = blocked ? TEST_RUN_EXIT_CODES.BLOCKED : testRunExitCode(childExitCode, parsed.counts);
    const result = {
      schemaVersion: TEST_RUN_SCHEMA_VERSION,
      producedBy: TEST_RUN_PRODUCER,
      taskId,
      command: commandLine,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      exitCode: childExitCode,
      wrapperExitCode: exitCode,
      counts: parsed.counts,
      testNames: parsed.testNames,
      rawLogPath: relative(root, rawLogPath),
      rawLogSha256: createHash('sha256').update(readFileSync(rawLogPath)).digest('hex'),
      gitHead,
      status: blocked ? 'blocked' : exitCode === 0 ? 'passed' : 'failed',
      ...(blocked
        ? {
            blocker: {
              code: blockedFailureCode || reportFailureCode,
              reason: blockedError
                ? commandStarted
                  ? `テストコマンド起動後に結果取得を中止しました: ${blockedError.message}`
                  : `子プロセスを起動できません: ${blockedError.message}`
                : reportFailureCode === 'TEST_OUTPUT_NOT_CAPTURED'
                  ? 'TEST_OUTPUT_NOT_CAPTURED: テストコマンドは正常終了しましたが、結果出力を取得できません'
                  : 'TAP形式のテスト集計を取得できず、Vitest JSON形式の結果も無いため実行件数を確認できません',
              requiredEnvironment: commandStarted
                ? [
                    '起動後の標準出力・標準エラーを最後まで取得できる実行環境',
                    '標準出力・標準エラーの合計が64MB以内に収まるテストコマンド',
                  ]
                : [
                    '子プロセスを起動して標準出力を取得できるOS権限',
                    `TAP形式またはVitest JSON形式の結果を出すテストコマンド: ${command}`,
                  ],
            },
          }
        : {}),
    };
    atomicWriteJson(resultPath, result);
    console.log('');
    console.log(`[ai:test] 実行=${result.counts.total} / 成功=${result.counts.pass} / 失敗=${result.counts.fail} / skip=${result.counts.skipped} / 打ち切り=${result.counts.cancelled}`);
    if (result.counts.planMismatch === true) {
      const reasons = Array.isArray(result.counts.mismatchReasons) ? result.counts.mismatchReasons : [];
      const detail = reasons.includes('plan') && reasons.includes('summary')
        ? 'plan行またはtests集計の件数が実行結果と一致しません。'
        : reasons.includes('summary')
          ? 'tests集計の合計と実行結果の内訳が一致しません。'
          : 'plan行の合計と結果行数が一致しません。';
      console.warn(`[ai:test] 警告: ${detail}件数が実態と違う可能性があります。`);
    }
    console.log(`[ai:test] 生ログ: ${result.rawLogPath}`);
    console.log(`[ai:test] 実行結果: ${relative(root, resultPath)}`);
    if (exitCode === 0) {
      if (result.counts.planMismatch === true) {
        console.log('[ai:test] 警告の内容と件数を確認したうえで、この「実行結果」のパスを完了証跡JSONの testRun に指定してください。');
      } else {
        console.log('[ai:test] この「実行結果」のパスを、完了証跡JSONの testRun に指定してください。');
      }
    } else {
      console.log('[ai:test] この実行は合格ではないため、完了証跡には使えません。');
    }
    process.exit(exitCode);
  } catch (error) {
    console.error(`[ai:test] 実行結果を保存できません: ${error.message}`);
    process.exit(TEST_RUN_EXIT_CODES.BLOCKED);
  }
}

try {
  console.log(`[ai:test] 実行中: ${commandLine}（完了までしばらくかかることがあります）`);
  const child = spawn(command, args, {
    cwd: root,
    shell: false,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const maxOutputBytes = 64 * 1024 * 1024;
  let stdout = '';
  let stderr = '';
  let capturedBytes = 0;
  let childError = null;
  let childStarted = false;
  const capture = (stream, chunk) => {
    if (childError?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return;
    const text = String(chunk);
    capturedBytes += Buffer.byteLength(text);
    if (capturedBytes > maxOutputBytes) {
      childError = new Error('stdout/stderrが64MBを超えたため取得を中止しました');
      childError.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      child.kill();
      return;
    }
    if (stream === 'stdout') {
      stdout += text;
      process.stdout.write(text);
    } else {
      stderr += text;
      process.stderr.write(text);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.once('spawn', () => {
    childStarted = true;
  });
  child.stdout.on('data', (chunk) => capture('stdout', chunk));
  child.stderr.on('data', (chunk) => capture('stderr', chunk));
  child.stdout.on('error', (error) => {
    childError ||= error;
    child.kill();
  });
  child.stderr.on('error', (error) => {
    childError ||= error;
    child.kill();
  });
  const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const signalHandlers = new Map(forwardedSignals.map((signal) => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of signalHandlers) process.once(signal, handler);
  child.on('error', (error) => {
    childError ||= error;
  });
  child.on('close', (status, signal) => {
    for (const [forwardedSignal, handler] of signalHandlers) process.removeListener(forwardedSignal, handler);
    rawOutput = `${stdout}${stderr}`;
    finish({ childExitCode: status, blockedError: childError, signal, commandStarted: childStarted });
  });
} catch (error) {
  finish({ childExitCode: null, blockedError: error });
}
