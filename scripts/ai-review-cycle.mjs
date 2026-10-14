#!/usr/bin/env node
import {
  inspectCycle,
  retainExecutionHistory,
  bindPurpose,
  restartFromHalt,
  noteExternalReset,
  reserveStep,
  consumeDispatchTicket,
  recordUnknownSend,
  recordStepReceipt,
  recordPracticalOutcome,
  requestAstraRootDiagnosis,
  haltAfterAstraUnresolved,
  assertDispatchAllowed,
  assertCompletionAllowed,
  authorizeNextStep,
  grantLimitedPlan,
  prepareReviewCycleForSend,
} from './ai-review-cycle-lib.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
const cmd = args[0] || 'inspect';
function out(v) { console.log(JSON.stringify(v, null, 2)); }
function num(v) { const n = Number(v); if (!Number.isInteger(n)) throw new Error(`invalid integer: ${v}`); return n; }
try {
  if (cmd === 'retain-history') out(retainExecutionHistory(root, {statusPath: args[1], budgetPath: args[2]}));
  else if (cmd === 'inspect') out(inspectCycle(root));
  else if (cmd === 'bind') out(bindPurpose(root, { purposeId: args[1], userSource: args[2], taskId: args[3] }));
  else if (cmd === 'reserve') out(reserveStep(root, { step: args[1], cycle: num(args[2]), candidateHash: args[3], requestId: args[4], model: args[5], effort: args[6], taskId: args[7] }));
  else if (cmd === 'consume') out(consumeDispatchTicket(root, { ticketId: args[1], stage: args[2], step: args[3], cycle: args[4] ? num(args[4]) : undefined, candidateHash: args[5], requestId: args[6], model: args[7], effort: args[8] }));
  else if (cmd === 'unknown') out(recordUnknownSend(root, { step: args[1], cycle: num(args[2]), candidateHash: args[3], requestId: args[4], note: args[5] }));
  else if (cmd === 'receipt') out(recordStepReceipt(root, { step: args[1], cycle: num(args[2]), candidateHash: args[3], receiptPath: args[4], receiptHash: args[5], wrapperPath: args[6], wrapperHash: args[7], severity: args[8], summary: args[9], actualTestResult: args[10] === 'true' }));
  else if (cmd === 'practical') out(recordPracticalOutcome(root, { cycle: num(args[1]), candidateHash: args[2], status: args[3], proofPath: args[4], proofHash: args[5], wrapperPath: args[6], wrapperHash: args[7] }));
  else if (cmd === 'astra') out(requestAstraRootDiagnosis(root, { cycle: num(args[1]), candidateHash: args[2], blockerId: args[3], userSource: args[4], receiptPath: args[5], receiptHash: args[6], wrapperPath: args[7], wrapperHash: args[8] }));
  else if (cmd === 'halt') out(haltAfterAstraUnresolved(root, { cycle: num(args[1]), reason: args[2], userSource: args[3] }));
  else if (cmd === 'restart') out(await restartFromHalt(root, { userSource: args[1], reason: args[2] }));
  else if (cmd === 'reset-event') out(noteExternalReset(root, { requestId: args[1], reason: args[2] }));
  else if (cmd === 'assert-dispatch') out(assertDispatchAllowed(root, { stage: args[1], mode: 'dispatch', candidateHash: args[2] }));
  else if (cmd === 'assert-complete') out(assertCompletionAllowed(root));
  else if (cmd === 'authorize') out(authorizeNextStep(root, { kind: args[1] || 'inspect', stage: args[2], step: args[3], cycle: args[4] ? num(args[4]) : undefined, candidateHash: args[5], requestId: args[6], model: args[7], effort: args[8], taskId: args[9] }));
  else if (cmd === 'grant-limited') out(await grantLimitedPlan(root, { approvalPath: args[1], taskId: args[2], purposeId: args[3], userSource: args[4], scope: args[5] }));
  else if (cmd === 'grant-formal') out(await grantLimitedPlan(root, { approvalPath: args[1], taskId: args[2], purposeId: args[3], userSource: args[4], scope: 'limited-formal-review', candidateHash: args[5], candidateManifestPath: args[6], sourceHashes: args[7] ? JSON.parse(args[7]) : undefined, budgetOverlayYen: args[8] ? num(args[8]) : undefined }));
  else if (cmd === 'prepare-send') out(prepareReviewCycleForSend(root, { step: args[1], cycle: num(args[2]), candidateHash: args[3], requestId: args[4], model: args[5], effort: args[6], taskId: args[7] }));
  else {
    console.error('usage: ai review-cycle <inspect|bind|reserve|consume|unknown|receipt|practical|astra|halt|restart|reset-event|assert-dispatch|assert-complete|grant-limited|grant-formal|prepare-send>');
    process.exit(1);
  }
} catch (error) { console.error(`✗ ${error.message}`); process.exit(2); }
