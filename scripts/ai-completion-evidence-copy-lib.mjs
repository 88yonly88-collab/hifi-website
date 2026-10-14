import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import {
  atomicWriteJson,
  ensureRegularFile,
  gitValue,
  readJson,
  resolveRepoPath,
} from './ai-e2e-lib.mjs';

// testsの別processが複製後の破損を再現するためだけの注入口。未設定なら本番経路へ影響しない。
const COPY_TEST_FAULT_HOOK = Symbol.for('knowledge.ai-completion-evidence-copy.test-fault-hook');

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function samePath(left, right) {
  return realpathSync(left) === realpathSync(right);
}

/**
 * linked worktreeと同じgit common-dirを持つ本体checkoutを返す。
 * bare repoや通常の`.git`配置ではない構成は、別の場所へ誤複製しないようfail-closedにする。
 */
export function mainCheckoutRoot(root) {
  const worktreeRoot = realpathSync(root);
  const commonDirValue = gitValue(worktreeRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDirValue) throw new Error('git common-dirを取得できません');
  const commonDir = realpathSync(commonDirValue);
  if (basename(commonDir) !== '.git') {
    throw new Error(`本体checkoutを安全に特定できないgit配置です: ${commonDir}`);
  }
  const candidate = realpathSync(dirname(commonDir));
  const candidateTop = gitValue(candidate, ['rev-parse', '--path-format=absolute', '--show-toplevel']);
  const candidateCommon = gitValue(candidate, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!candidateTop || !candidateCommon) throw new Error('本体checkoutのgit情報を取得できません');
  if (realpathSync(candidateTop) !== candidate || realpathSync(candidateCommon) !== commonDir) {
    throw new Error('本体checkoutと作業場のgit common-dirが一致しません');
  }
  return candidate;
}

function sourceFile(root, requested, label) {
  if (typeof requested !== 'string' || !requested.trim()) return '';
  const path = resolveRepoPath(root, requested, label);
  ensureRegularFile(path, label);
  return path;
}

/**
 * 完了E2E証跡から、後日の再検証に必要なrepo内ファイルを列挙する。
 * 現行schemaでファイル参照として検証されるfieldだけを対象にし、自由記述からパスを推測しない。
 */
export function completionEvidenceFiles(root, evidencePath) {
  const evidenceFile = sourceFile(root, evidencePath, 'E2E証跡');
  const evidence = readJson(evidenceFile);
  const files = new Map();
  const add = (requested, label) => {
    const path = sourceFile(root, requested, label);
    if (path) files.set(path, path);
    return path;
  };

  const testRunPath = add(evidence.testRun, 'E2E証跡のtestRun');
  add(evidence?.element_counts?.source?.path, 'E2E証跡のelement_counts.source');
  add(evidence?.element_counts?.output_artifact?.path, 'E2E証跡のelement_counts.output_artifact');
  add(evidence?.regression_check?.deploy_gate?.path, 'E2E証跡のdeploy-gate記録');
  for (const [index, screenshot] of (Array.isArray(evidence.screenshots) ? evidence.screenshots : []).entries()) {
    add(screenshot?.path, `E2E証跡のscreenshots[${index}]`);
  }
  if (testRunPath) {
    const testRun = readJson(testRunPath);
    add(testRun.rawLogPath, 'testRunの生ログ');
  }

  // 参照先を先に置き、最後に証跡本体を公開する。
  files.delete(evidenceFile);
  return [...files.values(), evidenceFile];
}

function safeDestination(mainRoot, worktreeRoot, source) {
  const rel = relative(realpathSync(worktreeRoot), source);
  return resolveRepoPath(mainRoot, rel, '本体checkoutの証跡複製先');
}

function atomicCopyAndVerify(mainRoot, source, destination) {
  ensureRegularFile(source, '証跡複製元');
  const content = readFileSync(source);
  const sourceHash = digest(content);
  const destinationDir = dirname(destination);
  mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  // mkdir中の競合を含め、作成後にも親symlinkを検査する。
  const checkedDestination = resolveRepoPath(mainRoot, destination, '本体checkoutの証跡複製先');
  if (checkedDestination !== destination) throw new Error(`証跡複製先を一意に解決できません: ${destination}`);
  try {
    const existing = lstatSync(destination);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`証跡複製先はsymlinkではないregular fileが必要です: ${destination}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const pending = join(destinationDir, `.${basename(destination)}.${process.pid}.${Date.now()}.tmp`);
  const noFollow = constants.O_NOFOLLOW || 0;
  let descriptor;
  let pendingCreated = false;
  try {
    descriptor = openSync(
      pending,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_CLOEXEC | noFollow,
      0o600,
    );
    pendingCreated = true;
    if (!fstatSync(descriptor).isFile()) throw new Error(`証跡の一時複製先がregular fileではありません: ${pending}`);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // 同じtaskの再試行では、regular fileと確認済みの既存証跡を検証付きで置き換える。
    renameSync(pending, destination);
    pendingCreated = false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (pendingCreated) {
      try {
        unlinkSync(pending);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  const testFaultHook = globalThis[COPY_TEST_FAULT_HOOK];
  if (typeof testFaultHook === 'function') {
    testFaultHook({ stage: 'after-copy-before-verify', source, destination });
  }
  ensureRegularFile(destination, '証跡複製先');
  const destinationHash = digest(readFileSync(destination));
  if (destinationHash !== sourceHash) {
    throw new Error(`証跡の複製元と複製先の内容が一致しません: ${destination}`);
  }
}

/** 完了E2E証跡と参照先一式を本体checkoutの同じ相対位置へ複製する。 */
export function copyCompletionEvidenceBundle({ root, evidencePath }) {
  const worktreeRoot = realpathSync(root);
  const mainRoot = mainCheckoutRoot(worktreeRoot);
  if (!evidencePath) return { mainRoot, durableEvidencePath: null, copied: [] };
  const files = completionEvidenceFiles(worktreeRoot, evidencePath);
  if (samePath(worktreeRoot, mainRoot)) {
    return { mainRoot, durableEvidencePath: realpathSync(evidencePath), copied: [] };
  }
  const copied = [];
  for (const source of files) {
    const destination = safeDestination(mainRoot, worktreeRoot, source);
    atomicCopyAndVerify(mainRoot, source, destination);
    copied.push(destination);
  }
  return {
    mainRoot,
    durableEvidencePath: safeDestination(mainRoot, worktreeRoot, realpathSync(evidencePath)),
    copied,
  };
}

/** 完了検証JSONを作業場と本体checkoutへ同じ内容で保存し、内容一致を確認する。 */
export function writeCompletionVerificationCopies({ root, verificationPath, value }) {
  const worktreeRoot = realpathSync(root);
  const mainRoot = mainCheckoutRoot(worktreeRoot);
  atomicWriteJson(verificationPath, value);
  if (samePath(worktreeRoot, mainRoot)) {
    return { durableVerificationPath: verificationPath, copied: false };
  }
  const durableVerificationPath = safeDestination(mainRoot, worktreeRoot, verificationPath);
  atomicCopyAndVerify(mainRoot, verificationPath, durableVerificationPath);
  return { durableVerificationPath, copied: true };
}
