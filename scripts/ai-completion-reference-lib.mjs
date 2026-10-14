import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  agentId,
  IDENTIFIER_PATTERN,
  parseHistoryLine,
  runAgmsgScript,
} from './ai-workflow-lib.mjs';

const libraryPromises = new Map();
const REQUIRED_LIBRARY_FUNCTIONS = [
  'completionReferencePolicy',
  'isCompletionReferenceReport',
  'mergeCompletionReferenceReports',
  'parseCompletionReferenceReport',
  'validateCompletionReferenceTargets',
];

function knowledgeRootFor() {
  return join(homedir(), 'projects', 'knowledge');
}

function loadCompletionReferenceLibrary(knowledgeRoot) {
  const libraryPath = join(knowledgeRoot, 'scripts', 'kb-completion-reference-lib.mjs');
  const stat = lstatSync(libraryPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`参照ナレッジ共通検査はsymlinkではないregular fileが必要です: ${libraryPath}`);
  }
  if (!libraryPromises.has(libraryPath)) {
    libraryPromises.set(libraryPath, import(pathToFileURL(libraryPath).href));
  }
  return libraryPromises.get(libraryPath);
}

function completionReferenceSources({ root, task, declaration, declarationText, library, historyRunner }) {
  const sources = [];
  const embeddedReport = String(declaration.completion_report || '').trim();
  if (embeddedReport && library.isCompletionReferenceReport(embeddedReport, declaration)) {
    sources.push(embeddedReport);
  }
  if (library.isCompletionReferenceReport(declarationText, declaration)) {
    sources.push(declarationText);
  }
  const warnings = [];
  const parentTeam = String(declaration.parent_team || '').trim();
  if (!IDENTIFIER_PATTERN.test(parentTeam)) return { sources, warnings, historyUnavailable: false };

  const allowedSenders = new Set([
    String(declaration.agent || '').trim(),
    agentId(task.implementer),
  ].filter((value) => IDENTIFIER_PATTERN.test(value)));
  try {
    const history = historyRunner('history.sh', [parentTeam, 'claude-code', '500'], {
      cwd: root,
      timeout: 5_000,
    });
    for (const line of String(history || '').split(/\r?\n/u)) {
      const message = parseHistoryLine(line);
      if (!message || message.to !== 'claude-code' || !allowedSenders.has(message.from)) continue;
      if (!message.body.includes(task.taskId) || !library.isCompletionReferenceReport(message.body)) continue;
      sources.push(message.body);
    }
  } catch (error) {
    warnings.push(`history_unavailable: ${error.message}`);
    return { sources, warnings, historyUnavailable: true };
  }
  return { sources, warnings, historyUnavailable: false };
}

export async function assessCompletionReferenceReport({
  root,
  task,
  declaration,
  declarationText,
  env = process.env,
  knowledgeRoot = knowledgeRootFor(),
  historyRunner = runAgmsgScript,
  libraryLoader = loadCompletionReferenceLibrary,
}) {
  let library;
  try {
    library = await libraryLoader(knowledgeRoot);
    for (const name of REQUIRED_LIBRARY_FUNCTIONS) {
      if (typeof library[name] !== 'function') throw new Error(`参照ナレッジ共通検査に ${name} がありません`);
    }
  } catch (error) {
    return {
      assessment: null,
      policy: null,
      requirement: null,
      missing: null,
      unavailable: true,
      detail: '',
      warnings: [`validator_unavailable: ${error.message}`],
    };
  }

  let policy;
  try {
    policy = library.completionReferencePolicy(env.KB_COMPLETION_REFERENCE_TODAY);
  } catch (error) {
    // 外部validatorが無い場合と同じく、期限判定自体を実行できない状態として記録して前進する。
    return {
      assessment: null,
      policy: null,
      requirement: null,
      missing: null,
      unavailable: true,
      detail: '',
      warnings: [`validator_unavailable: ${error.message}`],
    };
  }

  let collected;
  let assessment;
  let requirement;
  try {
    collected = completionReferenceSources({
      root,
      task,
      declaration,
      declarationText,
      library,
      historyRunner,
    });
    const reports = collected.sources.map((source) => library.parseCompletionReferenceReport(source, knowledgeRoot));
    // 「未記入」の正本はknowledge共通libのmerge戻り値。参照先の実在性はwarningとして別に検査する。
    const merged = library.mergeCompletionReferenceReports(reports);
    requirement = {
      hasReferenceLine: merged.hasReferenceLine === true,
      hasReferenceDeclaration: merged.hasReferenceDeclaration === true,
    };
    assessment = library.validateCompletionReferenceTargets(merged, knowledgeRoot);
  } catch (error) {
    return {
      assessment: null,
      policy,
      requirement: null,
      missing: null,
      unavailable: true,
      detail: '',
      warnings: [
        ...(collected?.warnings || []),
        `validator_unavailable: ${error.message}`,
      ],
    };
  }
  const missing = !(requirement.hasReferenceLine && requirement.hasReferenceDeclaration);
  const unavailable = missing && collected.historyUnavailable;
  return {
    assessment,
    policy,
    requirement,
    missing,
    unavailable,
    detail: missing
      ? `完了報告に「参照ナレッジ: <path>」または「参照ナレッジ: 該当なし」がありません（${policy.today}、2026-09-14までは警告）`
      : '',
    warnings: [...collected.warnings, ...assessment.warnings],
  };
}
