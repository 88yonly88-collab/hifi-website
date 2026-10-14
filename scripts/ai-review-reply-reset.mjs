/** reviewer replyの送信状態を履歴退避して明示resetする。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { IDENTIFIER_PATTERN } from './ai-workflow-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const contextDir = join(root, '.ai', 'context');
const idIndex = process.argv.indexOf('--request-id');
const requestId = idIndex >= 0 ? process.argv[idIndex + 1] : '';

if (!process.argv.includes('--yes')) {
  console.error('✗ reply resetは --yes が必須です。');
  process.exit(1);
}
if (!requestId || !IDENTIFIER_PATTERN.test(requestId)) {
  console.error('✗ 1〜128文字の安全な --request-id を指定してください。');
  process.exit(2);
}
const stateFile = join(contextDir, `reviewer-reply-${requestId}.json`);
if (!existsSync(stateFile)) {
  console.error('✗ reset対象のreply stateがありません。');
  process.exit(1);
}
let state;
try {
  state = JSON.parse(readFileSync(stateFile, 'utf8'));
} catch (error) {
  console.error(`✗ reply stateを読めません: ${error.message}`);
  process.exit(2);
}
if (state.requestId !== requestId) {
  console.error('✗ reply stateのRequest-IDが指定値と一致しません。resetしません。');
  process.exit(2);
}
const now = new Date().toISOString();
const historyDir = join(contextDir, 'reviewer-reply-history');
mkdirSync(historyDir, { recursive: true });
writeFileSync(
  join(historyDir, `${requestId}-${randomUUID()}-reset.json`),
  `${JSON.stringify({ ...state, archivedAt: now, archiveReason: 'explicit-reset' }, null, 2)}\n`,
  'utf8',
);
writeFileSync(stateFile, `${JSON.stringify({ ...state, status: 'reset', resetAt: now }, null, 2)}\n`, 'utf8');
console.log(`✓ reviewer reply ${requestId} をresetしました。`);
console.log('→ 次回は通常の ai:review-reply --yes で送信できます。');
