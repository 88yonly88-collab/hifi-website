#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadState, readPlan, resolveCaseDir, statusCase } from './ai-task-continuity-lib.mjs';
import { summarizeProgress } from './ai-task-progress-lib.mjs';

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift() || 'progress';
  if (command !== 'progress') throw new Error(`TASK_PROGRESS_CLI_ERROR: unknown command ${command}`);
  const root = resolve(flag(args, '--repo') || process.cwd());
  const caseRelative = flag(args, '--case');
  if (!caseRelative) throw new Error('TASK_PROGRESS_CLI_ERROR: --case is required');
  const caseDir = resolveCaseDir(root, caseRelative);
  const taskId = flag(args, '--task');
  const status = statusCase({ caseDir });
  if (!taskId) {
    writeJson({ readonly: true, status, plan: readPlan(caseDir) });
    return;
  }
  const state = loadState(caseDir);
  const task = state.tasks[taskId];
  if (!task) throw new Error('TASK_PROGRESS_CLI_ERROR: task not found');
  writeJson({
    readonly: true,
    caseId: state.caseId,
    taskId,
    taskState: task.state,
    progress: task.progress || null,
    summary: summarizeProgress(task.progress),
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exit(2);
});
