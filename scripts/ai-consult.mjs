/**
 * agmsg Manager - ai:consult（GPT-5.6 Sol High への自動相談）
 *
 * 目的:
 *   ai:pack で作る相談パックを、OpenAI API の高精度モデル（gpt-5.6-sol / reasoning effort: high）へ
 *   直接送信し、回答を .ai/context/consult-result.md に保存する。
 *   ChatGPT のブラウザ画面に貼り付ける作業を無くす。
 *
 * 使い方:
 *   npm run ai:consult                 dry-run（送信内容と概算コストを表示するだけ。課金なし）
 *   （standalone: bash scripts/ai consult ... と読み替える。npm 固有の `--` は不要）
 *   npm run ai:consult -- --yes        実際に送信する（従量課金が発生する）
 *   npm run ai:consult -- --yes --effort medium   思考の深さを下げて安く速くする
 *   npm run ai:consult -- --yes --model gpt-5.5   別モデルに切り替える（--model は常にこの既定より優先）
 *
 * APIキー:
 *   次の順で OPENAI_API_KEY を探す。キーの値は絶対に表示・保存しない。
 *     1. 環境変数
 *     2. 導入先リポジトリ直下の .env
 *     3. 設計書ツールの ~/projects/spec-leader/.env（spec-leader と同じキーを共用）
 *   spec-leader を設定済みなら、プロジェクトごとの追加設定は不要。
 *
 * 課金ガード:
 *   - --yes なしでは絶対に送信しない（dry-run）。
 *   - 出力トークンに上限（MAX_OUTPUT_TOKENS）を設け、1回の最大コストを固定する。
 *   - dry-run と送信後の両方でコスト（概算/実測）を表示する。料金表（PRICES）に無いモデルを
 *     指定した場合のみ、コスト計算をせず「不明」と表示する（未確認の金額を出さないため）。
 *
 * 制約:
 *   - gpt-5.6-sol は難問向けのため、回答に数分かかることがある（background モードで送信しポーリングする）。
 *   - 自動修正ループはしない。回答の適用判断は人間と実装AIが行う。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { aiCmd } from './ai-workflow-lib.mjs';

const root = process.cwd();
const contextDir = join(root, '.ai', 'context');
const packFile = join(contextDir, 'ask-agent.md');
const outFile = join(contextDir, 'consult-result.md');

const args = process.argv.slice(2);
const send = args.includes('--yes');

function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const MODEL = argValue('--model', 'gpt-5.6-sol');
const EFFORT = argValue('--effort', 'high'); // reasoningモデル向け: none / minimal / low / medium / high / xhigh
const MAX_OUTPUT_TOKENS = 16000;
const POLL_INTERVAL_MS = 10000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

// 料金表（USD / 100万トークン）。モデル追加時はここに足す。
const PRICES = {
  'gpt-5.6-sol': { input: 5, output: 30 },
  'gpt-5.5-pro': { input: 30, output: 180 },
  'gpt-5.5': { input: 5, output: 30 },
};
const JPY_PER_USD = 150; // 概算表示用

function price(model) {
  return PRICES[model] ?? null;
}

function fmtUsd(v) {
  return `$${v.toFixed(2)}`;
}

function fmtJpy(v) {
  return `約${Math.ceil(v * JPY_PER_USD)}円`;
}

/** .env ファイルから OPENAI_API_KEY を読む。無ければ null。値はログに出さない。 */
function readKeyFromEnvFile(envFile) {
  if (!existsSync(envFile)) return null;
  try {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.+)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch {
    // 読めない場合はキーなし扱い
  }
  return null;
}

/**
 * APIキーを探す。優先順: 環境変数 → 導入先の .env → spec-leader の .env（キー共用）。
 * 戻り値は { key, source }。source は表示用（キーの値は含めない）。
 */
function readApiKey() {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()) {
    return { key: process.env.OPENAI_API_KEY.trim(), source: '環境変数' };
  }
  const localKey = readKeyFromEnvFile(join(root, '.env'));
  if (localKey) {
    return { key: localKey, source: 'このリポジトリの .env' };
  }
  const specLeaderEnv = join(homedir(), 'projects', 'spec-leader', '.env');
  const sharedKey = readKeyFromEnvFile(specLeaderEnv);
  if (sharedKey) {
    return { key: sharedKey, source: 'spec-leader の .env（設計書ツールとキー共用）' };
  }
  return null;
}

/** 相談パックを最新化する（失敗しても既存ファイルがあれば続行）。 */
function refreshPack() {
  try {
    execFileSync('node', [join('scripts', 'ai-pack.mjs')], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** ざっくりトークン数を見積もる（日本語・コード混在を想定して 3文字≒1トークン）。 */
function estimateTokens(text) {
  return Math.ceil(text.length / 3);
}

// --- 1. 相談パックを用意 ---
const refreshed = refreshPack();
if (!existsSync(packFile)) {
  console.error('✗ 相談パック（.ai/context/ask-agent.md）を作れませんでした。');
  console.error(`  先に ${aiCmd('pack')} を実行して、エラーが出ていないか確認してください。`);
  process.exit(2);
}
const pack = readFileSync(packFile, 'utf8');

const instruction = [
  'あなたは経験豊富なソフトウェア開発アドバイザーです。以下は現在の作業状況をまとめた相談パックです。',
  '受け入れチェックリストが含まれる場合は、それを完了基準として扱ってください。',
  '次の順で、日本語で答えてください。',
  '1. 状況の要約（3行以内）',
  '2. 原因分析（最も可能性が高い順）',
  '3. 次にやるべき作業方針（具体的に）',
  '4. 実装AI（Claude Code）にそのまま渡せる指示文',
  '',
  '---',
  '',
  pack,
].join('\n');

const pricing = price(MODEL);
const inputEst = estimateTokens(instruction);
const inputCostEst = pricing ? (inputEst / 1e6) * pricing.input : null;
const outputCostMax = pricing ? (MAX_OUTPUT_TOKENS / 1e6) * pricing.output : null;

console.log('=== ai:consult ===');
console.log(`  mode        : ${send ? 'SEND (--yes)' : 'dry-run（送信しません・課金されません）'}`);
console.log(`  model       : ${MODEL}（思考の深さ: ${EFFORT}）`);
console.log(`  相談パック  : ${packFile}${refreshed ? '（いま再生成しました）' : '（既存ファイルを使用）'}`);
console.log(`  入力サイズ  : 約${inputEst.toLocaleString()}トークン`);
if (pricing) {
  console.log(`  概算コスト  : 入力 ${fmtUsd(inputCostEst)} + 出力 最大 ${fmtUsd(outputCostMax)}`);
  console.log(`               = 1回あたり最大 ${fmtUsd(inputCostEst + outputCostMax)}（${fmtJpy(inputCostEst + outputCostMax)}）`);
} else {
  console.log('  概算コスト  : 不明なモデルのため計算できません（料金表にありません）');
}
console.log('');

if (!send) {
  console.log('これは dry-run です。実際に相談するには:');
  console.log(`  ${aiCmd('consult', '--yes')}`);
  console.log('');
  console.log('安く速くしたい場合（精度は下がります）:');
  console.log(`  ${aiCmd('consult', '--yes --effort medium')}`);
  console.log(`  ${aiCmd('consult', '--yes --model gpt-5.5')}`);
  process.exit(0);
}

const found = readApiKey();
if (!found) {
  console.error('✗ OpenAI APIキーが見つかりません。次のどちらかを用意してください。');
  console.error('  A. 設計書ツール（~/projects/spec-leader/.env）に OPENAI_API_KEY を設定する（おすすめ・共用）');
  console.error('  B. このリポジトリ直下の .env に OPENAI_API_KEY=sk-... の1行を書く');
  console.error('  ※ .env が .gitignore に入っている（コミットされない）ことを必ず確認してください。');
  process.exit(2);
}
const apiKey = found.key;
console.log(`  APIキー     : ${found.source} から読み込みました`);

// --- 2. background モードで送信し、完了までポーリング ---
// OPENAI_BASE_URL はテスト用の上書き口（通常は設定不要）
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

async function api(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

function extractText(response) {
  const parts = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && content.text) parts.push(content.text);
    }
  }
  return parts.join('\n');
}

async function main() {
  console.log('送信しています…（難問モードのため、数分かかることがあります）');
  const created = await api('/responses', {
    method: 'POST',
    body: JSON.stringify({
      model: MODEL,
      input: instruction,
      reasoning: { effort: EFFORT },
      max_output_tokens: MAX_OUTPUT_TOKENS,
      background: true,
    }),
  });

  const startedAt = Date.now();
  let response = created;

  while (response.status === 'queued' || response.status === 'in_progress') {
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new Error(`30分以内に完了しませんでした（response id: ${created.id}）。時間をおいて確認してください。`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    response = await api(`/responses/${created.id}`);
    process.stdout.write('.');
  }
  console.log('');

  if (response.status !== 'completed') {
    const reason = response?.error?.message ?? response.status;
    throw new Error(`相談に失敗しました: ${reason}`);
  }

  const text = extractText(response);
  if (!text.trim()) {
    throw new Error('回答が空でした。時間をおいて再実行してください。');
  }

  const usage = response.usage ?? {};
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  const actualCost = pricing ? (inTok / 1e6) * pricing.input + (outTok / 1e6) * pricing.output : null;

  const md = [
    `# GPT相談結果 (consult-result.md)`,
    '',
    `- 日時: ${new Date().toISOString()}`,
    `- モデル: ${MODEL}（思考の深さ: ${EFFORT}）`,
    `- トークン: 入力 ${inTok.toLocaleString()} / 出力 ${outTok.toLocaleString()}`,
    actualCost !== null ? `- コスト実測: ${fmtUsd(actualCost)}（${fmtJpy(actualCost)}）` : '- コスト実測: 不明',
    '',
    '---',
    '',
    text.trim(),
    '',
  ].join('\n');

  mkdirSync(contextDir, { recursive: true });
  writeFileSync(outFile, md, 'utf8');

  console.log('✓ 相談が完了しました。');
  console.log(`  保存先      : ${outFile}`);
  console.log(`  トークン    : 入力 ${inTok.toLocaleString()} / 出力 ${outTok.toLocaleString()}`);
  if (actualCost !== null) {
    console.log(`  コスト実測  : ${fmtUsd(actualCost)}（${fmtJpy(actualCost)}）`);
  }
  console.log('');
  console.log('→ 回答を確認するには、Cursor で .ai/context/consult-result.md を開いてください。');
  console.log('→ Claude Code に渡す場合: 「.ai/context/consult-result.md を読んで、指示文の通りに作業してください。」');
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
