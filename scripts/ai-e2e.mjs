#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  E2E_SCHEMA_VERSION,
  actualRepoName,
  atomicWriteJson,
  currentGitIdentity,
  ensureRegularFile,
  readJson,
  resolveRepoPath,
  safeId,
  validateCurrentTaskRepoName,
  validateBlockedEvidence,
  validateFailedEvidence,
  validateNonWebEvidence,
  validatePassedEvidence,
} from './ai-e2e-lib.mjs';
import { isBrowserReviewRoundEvidencePath } from './ai-review-rounds-lib.mjs';

const root = process.cwd();
const taskPath = join(root, '.ai', 'current-task.json');

function fail(message, code = 2) {
  console.error(`E2E_GATE_REJECTED: ${message}`);
  process.exit(code);
}

function option(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : fallback;
}

function loadTask() {
  if (!existsSync(taskPath)) fail('.ai/current-task.jsonがありません');
  try {
    return readJson(taskPath);
  } catch (error) {
    fail(`current-task.jsonを読めません: ${error.message}`);
  }
}

function identity(task) {
  // worktreeのフォルダ名は元repo名と異なり得るため、basename(root)ではなく実repo名と照合する。
  let declaredRepo;
  try {
    declaredRepo = validateCurrentTaskRepoName(task, actualRepoName(root));
  } catch (error) {
    fail(error.message);
  }
  const git = currentGitIdentity(root);
  const id = {
    taskId: String(task.taskId || '').trim(),
    taskFingerprint: String(task.taskFingerprint || '').trim(),
    repo: declaredRepo,
    branch: git.branch,
    gitHead: git.gitHead,
    gitStatusHash: git.gitStatusHash,
    worktreeHash: git.worktreeHash,
  };
  try {
    id.taskId = safeId(id.taskId);
  } catch (error) {
    fail(error.message);
  }
  if (!id.taskFingerprint || /[\r\n]/.test(id.taskFingerprint)) fail('taskFingerprintが空または不正です');
  if (!id.branch || String(task.branch || '').trim() !== id.branch) fail('current-task.jsonのbranchが実branchと一致しません');
  return id;
}

function localPath(requested, label) {
  try {
    return resolveRepoPath(root, requested, label);
  } catch (error) {
    fail(error.message);
  }
}

function validHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function defaultEvidencePath(taskId) {
  return join(root, '.ai', 'e2e', `${taskId}.json`);
}

function browserExecutable() {
  const requested = process.env.E2E_BROWSER_BIN;
  const candidates = [requested, 'chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const path = candidate.includes('/') ? candidate : execFileSync('sh', ['-c', 'command -v "$1"', 'sh', candidate], { encoding: 'utf8' }).trim();
      if (path) return path;
    } catch {
      // 次候補へ進む。
    }
  }
  return '';
}

function runPreflight(task) {
  const id = identity(task);
  if (!id.taskId || !id.taskFingerprint || !id.branch) fail('taskId/taskFingerprint/実branchが必要です');
  const url = option('--url');
  if (!url || !validHttpUrl(url)) fail('preflightにはhttp/httpsの--urlが必要です');
  const output = localPath(option('--output', join(root, '.ai', 'e2e', `${id.taskId}-browser-preflight.json`)), 'preflight出力');
  const executable = browserExecutable();
  let status = 'blocked';
  let browser = { name: 'unavailable', version: 'unavailable' };
  let blocker = null;
  if (!executable) {
    blocker = {
      reason: 'Chromium/Chrome実行ファイルが見つからず、実ブラウザを起動できません',
      requiredEnvironment: ['ChromiumまたはGoogle Chrome', 'headless browserを起動できるOS権限'],
    };
  } else {
    const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
    browser = { name: basename(executable), version: String(version.stdout || version.stderr || '').trim() || 'unknown' };
    const launched = spawnSync(
      executable,
      ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', 'about:blank'],
      { encoding: 'utf8', timeout: 15000 },
    );
    if (launched.status === 0 && /<html/i.test(String(launched.stdout || ''))) status = 'passed';
    else {
      blocker = {
        reason: `実ブラウザ起動に失敗しました（status=${launched.status ?? 'spawn-error'}）`,
        requiredEnvironment: ['headless Chromiumを起動できる共有ライブラリとsandbox権限', executable],
      };
    }
  }
  const evidence = {
    schemaVersion: E2E_SCHEMA_VERSION,
    ...id,
    e2eKind: 'browser',
    url,
    executedAt: new Date().toISOString(),
    browser,
    status,
    ...(blocker ? { blocker } : {}),
  };
  atomicWriteJson(output, evidence);
  if (status !== 'passed') {
    console.error(`BROWSER_E2E_BLOCKED: ${blocker.reason}`);
    console.error(`EVIDENCE: ${output}`);
    process.exit(3);
  }
  console.log(`BROWSER_PREFLIGHT_PASSED: ${browser.name} ${browser.version}`);
  console.log(`EVIDENCE: ${output}`);
}

function runRecord(task) {
  const input = option('--input');
  if (!input) fail('recordには--input <json>が必要です');
  let raw;
  try {
    const inputPath = localPath(input, '入力JSON');
    ensureRegularFile(inputPath, '入力JSON');
    raw = JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch (error) {
    fail(`入力JSONを読めません: ${error.message}`);
  }
  const id = identity(task);
  const evidence = {
    ...raw,
    schemaVersion: E2E_SCHEMA_VERSION,
    ...id,
    e2eKind: task.surfaceKind === 'web_ui' ? 'browser' : raw.e2eKind,
    executedAt: raw.executedAt || new Date().toISOString(),
  };
  const output = localPath(option('--output', defaultEvidencePath(id.taskId)), 'E2E証跡出力');
  // review round証跡はdeploy前に作る。完了ゲートが読む既定の<taskId>.jsonは
  // 従来どおりproduction deploy-gateを要求し、fail-closedを維持する。
  const reviewRoundOutput = isBrowserReviewRoundEvidencePath(root, id.taskId, output);
  const errors = task.surfaceKind === 'non_web'
    ? validateNonWebEvidence(evidence, { root, ...id })
    : evidence.status === 'blocked'
      ? validateBlockedEvidence(evidence, id)
      : evidence.status === 'failed'
        ? validateFailedEvidence(evidence, id)
        : validatePassedEvidence(evidence, {
          root,
          ...id,
          requireDeployGate: !reviewRoundOutput && task.deploymentKind !== 'non_production',
        });
  if (errors.length) fail(errors.join('; '));
  atomicWriteJson(output, evidence);
  console.log(`E2E_EVIDENCE_RECORDED: ${output}`);
}

function runVerify(task) {
  const id = identity(task);
  const evidencePath = localPath(option('--evidence', defaultEvidencePath(id.taskId)), 'E2E証跡');
  let evidence;
  try {
    ensureRegularFile(evidencePath, 'E2E証跡');
    evidence = readJson(evidencePath);
  } catch (error) {
    fail(`証跡を読めません: ${error.message}`);
  }
  const errors = task.surfaceKind === 'non_web'
    ? validateNonWebEvidence(evidence, { root, ...id })
    : validatePassedEvidence(evidence, {
      root,
      ...id,
      requireDeployGate: task.deploymentKind !== 'non_production',
    });
  if (errors.length) fail(errors.join('; '));
  console.log(`E2E_EVIDENCE_VALID: ${evidencePath}`);
}

const command = process.argv[2];
const task = loadTask();
if (command === 'preflight') runPreflight(task);
else if (command === 'record') runRecord(task);
else if (command === 'verify') runVerify(task);
else {
  console.log('使い方: ai-e2e.mjs preflight --url URL | record --input report.json | verify [--evidence path]');
  process.exit(command ? 2 : 0);
}
