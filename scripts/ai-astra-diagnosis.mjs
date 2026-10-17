#!/usr/bin/env node
// Astra原因診断の記録と関所。
//   node bin/ai-astra-diagnosis.mjs status --repo <abs>
//   node bin/ai-astra-diagnosis.mjs check  --repo <abs>          # 未記録なら終了コード2
//   node bin/ai-astra-diagnosis.mjs record --repo <abs> --receipt <path> --summary "<原因>" [--executed-by <id>] [--task-id <id>] [--candidate-hash <hash>]
//   node bin/ai-astra-diagnosis.mjs block-consult --repo <abs> --channel <decision|agmsg> [--note <text>]   # 未記録なら受付拒否（記録つき・終了コード2）
import { assertAstraDiagnosisSatisfied, astraDiagnosisStatus, blockConsultIfPending, recordAstraDiagnosis } from '../scripts/astra-diagnosis-gate.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
for (let i = 1; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue;
  const k = argv[i].slice(2);
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) { flags[k] = true; continue; }
  flags[k] = v; i += 1;
}
const repo = flags.repo;
if (typeof repo !== 'string' || !repo.startsWith('/')) { console.error('✗ --repo にレーンの絶対パスが必要です'); process.exit(2); }

if (cmd === 'status') {
  const s = astraDiagnosisStatus({ root: repo });
  console.log(`要求=${s.required ? 'あり' : 'なし'} / 状態=${s.status}`);
  if (s.record) console.log(`  モデル=${s.record.model} effort=${s.record.effort} 終了コード=${s.record.exitCode}`);
} else if (cmd === 'check') {
  try {
    const r = assertAstraDiagnosisSatisfied({ root: repo });
    console.log(r.skipped ? '診断は要求されていません（関所は通過）' : '診断は記録済み（関所は通過）');
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
} else if (cmd === 'record') {
  const r = recordAstraDiagnosis({
    root: repo,
    model: flags.model || 'gpt-6-astra',
    effort: flags.effort || 'high',
    receiptPath: flags.receipt,
    exitCode: flags['exit-code'] ?? 0,
    summary: flags.summary,
    executedBy: flags['executed-by'],
    taskId: flags['task-id'],
    candidateHash: flags['candidate-hash'],
  });
  if (!r.ok) { for (const e of r.errors) console.error(`✗ ${e}`); process.exit(2); }
  console.log(`診断を記録しました: ${r.path}`);
} else if (cmd === 'block-consult') {
  const r = blockConsultIfPending({ root: repo, channel: flags.channel, note: flags.note });
  if (r.ok) { console.log('診断は不要または記録済み（相談を受け付けます）'); }
  else {
    console.error(`✗ ASTRA_DIAGNOSIS_REQUIRED: 相談を受け付けません（${r.reasons.join(' / ')}）`);
    console.error(`  拒否記録: ${r.recordPath}`);
    process.exit(2);
  }
} else {
  console.error('使い方: status | check | record --repo <abs> --receipt <path> --summary "<原因>" | block-consult --repo <abs> --channel <name>');
  process.exit(2);
}
