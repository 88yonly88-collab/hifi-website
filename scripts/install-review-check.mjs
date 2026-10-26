#!/usr/bin/env node
/**
 * install-review-check.mjs — 設計レビュー4点と設置台帳(deploy_targets)の機械検査（20261017.2）
 *
 * なぜ必要か:
 *   「実装は完了」と報告されたのに設置（配備・導入）し忘れる事故が繰り返された。原因は
 *   「設置先が機械可読な台帳になっていない」こと。独立した人のレビュー工程を足すのではなく、
 *   既存の完了ゲートの中に機械検査として置く（2026-10-17 三者議論の司会確定）。
 *
 * 使い方:
 *   node scripts/install-review-check.mjs --version
 *   node scripts/install-review-check.mjs --self-check
 *   node scripts/install-review-check.mjs --design-review <指示書.md> [--log <証跡.md>]
 *   node scripts/install-review-check.mjs --freeze <指示書.md>
 *   node scripts/install-review-check.mjs --ledger <指示書.md> [--json]
 *   node scripts/install-review-check.mjs --sweep [<指示書ディレクトリ>] [--repo <ルート>] [--block] [--json]
 *   node scripts/install-review-check.mjs --probe-reader <file> <needle>
 *   node scripts/install-review-check.mjs --probe-package-gate [<name>]
 *
 * 判定（fail-closed）:
 *   0 = 合格（DESIGN_REVIEW_PASSED / INSTALL_REVIEW_PASSED / INSTALL_REVIEW_FROZEN / 問題なしの sweep）
 *   1 = 不合格（BLOCKED・freeze不能・--block 付き sweep の不良あり）
 *   2 = 検査できない（使い方の誤り・指示書が読めない）
 *
 * 原則（2026-10-17 のコードレビュー指摘を反映）:
 *   - 不良(MISMATCH)と未確認(UNVERIFIED)は等しくブロックする。記録上は区別して出す。
 *   - probe は **宣言的な種類だけ**（read/parse のみ）。任意のスクリプトは実行しない（shell なし・実行器は固定）。
 *   - probe は exit 0 だけでは合格にしない。expect_contains との一致を必須にする。
 *   - 台帳は凍結（`--freeze`）を必須にし、凍結時の対象一覧（id/path/sha256）と食い違えばブロックする
 *     （対象を1件消すだけでも落ちる）。
 *   - 設計証跡は「この検査器の版・この指示書・凍結した台帳」に結び付ける。`--ledger` は設計レビューを再実行する。
 *   - 台帳に「設置不要」と理由がある場合だけ、対象0件で合格にする（理由が空なら未確認）。
 *   - 正本ルール: rules/design-review-ai-only.md / 負例: tests/install-review-check-test.sh
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = 'install-review-check 20261017.2';
// 証跡行に埋める識別子（空白を含まない。版表示とは別に持つ）。
export const VERSION_ID = 'install-review-check/20261017.2';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADER_SCAN_LINES = 20;
const PROBE_TIMEOUT_MS = 30000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const FREEZE_MARKER = '<FREEZE>';
const DEFAULT_INSTRUCTIONS_DIR = path.join(os.homedir(), 'projects/.agent-work/instructions');

// ① 必須項目（先頭20行の欄）
const REQUIRED_HEADER_FIELDS = [
  'model', 'effort', 'model_role', 'model_reason',
  'cost_estimate_yen', 'cost_cap_yen', 'review_rounds',
];
// ① 必須の見出し（本文の見出し行。本文のどこかの語では通さない）
const REQUIRED_SECTION_HEADINGS = [
  { key: '目的またはゴール', test: /目的|ゴール/ },
  { key: '非対象', test: /非対象/ },
  { key: '完了条件', test: /完了条件|合格条件/ },
  { key: '証拠', test: /証拠/ },
  { key: '停止条件', test: /停止条件|止まってよい/ },
];
// ② 測れない言い回し（コードブロック内と、禁止・反例として示した行は除く）
const VAGUE_PHRASES = [
  'ちゃんと動く', 'ちゃんと動作', 'ちゃんと確認', '問題なく動く', '問題ないこと', '問題ないはず',
  'うまく動く', 'うまくいく', '適切に動作', '正しく動く', '正常に動く', 'いい感じ',
  'なるべく', 'できるだけ', '必要に応じて', '適当に', '柔軟に対応', 'などなど',
];
const VAGUE_EXEMPT_LINE_RE = /禁止|反例|悪い例|不合格例|やってはいけない|してはいけない/;
const COMMAND_TOKEN_RE = /(?:node|bash|python3|sh|npm|npx|git|grep|test\s+-|exit\s+\d|--version|--ledger|--design-review|--self-check)/;
const EXPECTATION_TOKEN_RE = /期待|exit|終了コード|hash|sha256|一致|件|真|true|false|==|=>|≧|>=|<=/;
const SECTION_SEPARATOR_RE = /^\|[\s:|-]+\|$/;
const TABLE_HEADER_ROW_RE = /^\s*\|\s*(?:#|項目|番号|条件|コマンド|確認)\s*\|/;
const ITEM_LINE_RE = /^\s*(?:[-*]|□|\d+\.|\|)/;

// probe の宣言的な種類（読み取り・構文解析のみ。任意のスクリプトは実行しない）
const PROBE_KINDS = new Set([
  'self-version', 'file-first-line', 'file-contains', 'dir-contains', 'package-gate', 'bash-syntax', 'node-syntax',
]);

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readRegularFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { error: 'missing' };
  if (stat.isSymbolicLink()) return { error: 'symlink' };
  if (!stat.isFile()) return { error: 'not_file' };
  try {
    return { text: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    return { error: `unreadable:${error.code || error.message}` };
  }
}

// 指示書の先頭20行から `key: value` を読む（model-decision-guard と同じ広さ）。
export function readHeaderFields(text, scanLines = HEADER_SCAN_LINES) {
  const fields = {};
  let started = false;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/).slice(0, scanLines)) {
    if (!line.trim()) continue;
    const match = /^([a-z][a-z0-9_]*):[ \t]*(.*)$/.exec(line);
    if (!match) {
      if (!started) continue;
      break;
    }
    started = true;
    if (!Object.hasOwn(fields, match[1])) fields[match[1]] = match[2].trim();
  }
  return fields;
}

// 文書全体から `key: value` を1行で読む（最後の記載を採用。design_review 用）。
export function readFieldAnywhere(text, key) {
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`, 'gm');
  let value = '';
  for (const match of text.matchAll(re)) value = match[1].trim();
  return value;
}

// --- JSONブロックの抽出（行単位。```bash などのフェンスに惑わされない） -------------
export function extractJsonBlocks(text, { requireKey = '' } = {}) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const blocks = [];
  let inFence = false;
  let lang = '';
  let startLine = 0;
  let body = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^\s*```(.*)$/.exec(lines[index]);
    if (!inFence) {
      if (open) {
        inFence = true;
        lang = open[1].trim().toLowerCase();
        startLine = index + 1;
        body = [];
      }
      continue;
    }
    if (/^\s*```\s*$/.test(lines[index])) {
      inFence = false;
      if (lang === 'json' || lang === '') blocks.push({ text: body.join('\n'), line: startLine, lang });
      continue;
    }
    body.push(lines[index]);
  }
  return requireKey ? blocks.filter((block) => block.text.includes(requireKey)) : blocks;
}

// JSONの重複キーを検出する（JSON.parse は後勝ちで黙って捨てるため、上書きを許さない）。
export function findDuplicateJsonKey(source) {
  let index = 0;
  const skipWs = () => { while (index < source.length && /\s/.test(source[index])) index += 1; };
  const readString = () => {
    const begin = index;
    index += 1; // 開き引用符
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index] === '"') { index += 1; break; }
      index += 1;
    }
    try { return JSON.parse(source.slice(begin, index)); } catch { return null; }
  };
  const readValue = (trace) => {
    skipWs();
    const ch = source[index];
    if (ch === '{') return readObject(trace);
    if (ch === '[') return readArray(trace);
    if (ch === '"') return readString() === null ? `string_at_${index}` : null;
    while (index < source.length && !/[,\]}\s]/.test(source[index])) index += 1;
    return null;
  };
  const readObject = (trace) => {
    index += 1;
    const seen = new Set();
    skipWs();
    if (source[index] === '}') { index += 1; return null; }
    for (;;) {
      skipWs();
      if (source[index] !== '"') return `object_key_at_${index}`;
      const key = readString();
      if (key === null) return `string_at_${index}`;
      if (seen.has(key)) return `duplicate_key(${[...trace, key].join('.')})`;
      seen.add(key);
      skipWs();
      if (source[index] !== ':') return `colon_at_${index}`;
      index += 1;
      const nested = readValue([...trace, key]);
      if (nested) return nested;
      skipWs();
      if (source[index] === ',') { index += 1; continue; }
      if (source[index] === '}') { index += 1; return null; }
      return `object_end_at_${index}`;
    }
  };
  const readArray = (trace) => {
    index += 1;
    skipWs();
    if (source[index] === ']') { index += 1; return null; }
    for (;;) {
      const nested = readValue(trace);
      if (nested) return nested;
      skipWs();
      if (source[index] === ',') { index += 1; continue; }
      if (source[index] === ']') { index += 1; return null; }
      return `array_end_at_${index}`;
    }
  };
  skipWs();
  const error = readValue([]);
  return error || null;
}

// 指示書から deploy_targets の台帳ブロックを取り出す。
export function extractDeployTargets(text) {
  const blocks = extractJsonBlocks(text, { requireKey: 'deploy_targets' });
  const out = [];
  for (const block of blocks) {
    const duplicate = findDuplicateJsonKey(block.text);
    if (duplicate) { out.push({ parseError: duplicate, line: block.line }); continue; }
    let parsed;
    try {
      parsed = JSON.parse(block.text);
    } catch (error) {
      out.push({ parseError: `invalid_json(${error.message})`, line: block.line });
      continue;
    }
    if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'deploy_targets')) {
      out.push({ value: parsed.deploy_targets, line: block.line });
    }
  }
  return out;
}

function headingLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) out.push(match[2].trim());
  }
  return out;
}

function sectionLines(text, headingRe) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[index]);
    if (match && headingRe.test(match[2])) {
      start = index + 1;
      level = match[1].length;
      break;
    }
  }
  if (start < 0) return null;
  const out = [];
  for (let index = start; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[index]);
    if (match && match[1].length <= level) break;
    out.push(lines[index]);
  }
  return out;
}

export function frozenTargetsDigest(ledger) {
  const frozen = ledger && ledger.frozen;
  if (!frozen || !Array.isArray(frozen.targets)) return 'unfrozen';
  const canonical = frozen.targets.map((target) => ({
    id: String(target?.id ?? ''), path: String(target?.path ?? ''), sha256: String(target?.sha256 ?? ''),
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// --- 設計レビュー4点 ---------------------------------------------------------
export function designReview(text) {
  const points = [];
  const headings = headingLines(text);

  // ① 必須項目
  const fields = readHeaderFields(text);
  const missingFields = REQUIRED_HEADER_FIELDS.filter((key) => !fields[key]);
  const missingSections = REQUIRED_SECTION_HEADINGS
    .filter((section) => !headings.some((heading) => section.test.test(heading)))
    .map((section) => section.key);
  points.push({
    id: 'p1-required-fields',
    ok: missingFields.length === 0 && missingSections.length === 0,
    detail: [
      missingFields.length ? `先頭${HEADER_SCAN_LINES}行に無い欄: ${missingFields.join(', ')}` : '',
      missingSections.length ? `本文に無い見出し: ${missingSections.join(', ')}` : '',
    ].filter(Boolean).join(' / ') || '必須7欄と必須5見出しあり',
  });

  // ② 機械で確かめられる形（コードブロックと、禁止・反例として示した行は対象外）
  const vagueHits = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    if (VAGUE_EXEMPT_LINE_RE.test(line)) return;
    for (const phrase of VAGUE_PHRASES) {
      if (line.includes(phrase)) vagueHits.push(`${index + 1}行目:${phrase}`);
    }
  });
  const blocks = extractJsonBlocks(text);
  const hasCommandBlock = blocks.some((block) => /(?:^|\n)\s*(?:node|bash|python3|sh|npm|npx|git)\s+\S/.test(block.text))
    || /`(?:node|bash|python3|sh|npm|npx|git)\s+[^`]+`/.test(text);
  points.push({
    id: 'p2-measurable-form',
    ok: vagueHits.length === 0 && hasCommandBlock,
    detail: [
      vagueHits.length ? `測れない言い回し: ${vagueHits.slice(0, 8).join(', ')}` : '',
      hasCommandBlock ? '' : '実行できるコマンド（コードブロック内の node/bash/npm 等）が無い',
    ].filter(Boolean).join(' / ') || '測れない言い回しなし・実行コマンドあり',
  });

  // ③ 設置先の一覧（台帳）
  const found = extractDeployTargets(text);
  const warnings = [];
  let p3ok = false;
  let p3detail = '';
  const structural = validateLedger(found);
  if (structural.error) {
    p3ok = false;
    p3detail = structural.error;
  } else if (structural.notRequired) {
    p3ok = true;
    p3detail = `設置不要（理由: ${structural.notRequired}）`;
  } else {
    p3ok = structural.problems.length === 0;
    p3detail = structural.problems.slice(0, 8).join(' / ')
      || `設置先 ${structural.targets.length} 件（読み手・確認方法つき）`;
    warnings.push(...structural.warnings);
  }
  points.push({ id: 'p3-deploy-ledger', ok: p3ok, detail: p3detail });

  // ④ 合格条件が測れる（各項目にコマンドと期待値の両方が要る）
  const lines = sectionLines(text, /完了条件|合格条件/);
  let p4ok = false;
  let p4detail = '';
  if (!lines) {
    p4detail = '「完了条件」または「合格条件」の見出しが無い';
  } else {
    const items = lines.filter((line) => ITEM_LINE_RE.test(line)
      && !SECTION_SEPARATOR_RE.test(line.trim())
      && !TABLE_HEADER_ROW_RE.test(line));
    const unmeasurable = items.filter((line) => !(COMMAND_TOKEN_RE.test(line) && EXPECTATION_TOKEN_RE.test(line)));
    const hasCounterExample = /反例/.test(text);
    p4ok = items.length > 0 && unmeasurable.length === 0 && hasCounterExample;
    p4detail = [
      items.length === 0 ? '合格条件の項目が無い' : '',
      unmeasurable.length ? `コマンドか期待値が無い項目: ${unmeasurable.length}件（例: ${unmeasurable[0].trim().slice(0, 60)}）` : '',
      hasCounterExample ? '' : '反例（わざと壊すと落ちること）が書かれていない',
    ].filter(Boolean).join(' / ') || `合格条件 ${items.length} 件すべてにコマンドと期待値があり、反例もある`;
  }
  points.push({ id: 'p4-measurable-acceptance', ok: p4ok, detail: p4detail });

  return { ok: points.every((point) => point.ok), points, warnings };
}

// --- 台帳の構造検査 ---------------------------------------------------------
export function validateLedger(blocks) {
  const warnings = [];
  if (blocks.length === 0) {
    return { error: 'deploy_targets のJSONブロックが無い（設置不要なら deploy_required:false と理由を書く）' };
  }
  if (blocks.length > 1) {
    return { error: `deploy_targets のJSONブロックが ${blocks.length} 個ある（1個にまとめる）` };
  }
  if (blocks[0].parseError) {
    return { error: `deploy_targets のJSONを解析できない: ${blocks[0].parseError}` };
  }
  const ledger = blocks[0].value;
  if (ledger && ledger.deploy_required === false) {
    const reason = typeof ledger.reason === 'string' ? ledger.reason.trim() : '';
    const leftovers = [];
    if (Array.isArray(ledger.targets) && ledger.targets.length > 0) leftovers.push(`targets が ${ledger.targets.length} 件残っている`);
    if (ledger.frozen) leftovers.push('frozen が残っている');
    if (leftovers.length) {
      return { error: `deploy_required:false と設置先の併記は不正（${leftovers.join(' / ')}）。対象の検査を省略できない` };
    }
    if (reason.length < 4) return { error: '設置不要の理由が無い（未確認としてブロックする）', unverified: true };
    return { notRequired: reason, targets: [], problems: [], warnings };
  }
  if (!ledger || !Array.isArray(ledger.targets) || ledger.targets.length === 0) {
    return { error: 'deploy_targets.targets が空（設置先を1件以上書くか、設置不要を明記する）' };
  }
  const problems = [];
  for (const [index, target] of ledger.targets.entries()) {
    const label = target && target.id ? String(target.id) : `target#${index + 1}`;
    if (!target || typeof target !== 'object') { problems.push(`${label}: 対象がオブジェクトでない`); continue; }
    if (typeof target.path !== 'string' || !path.isAbsolute(target.path)) problems.push(`${label}: path が絶対パスでない`);
    if (typeof target.sha256 !== 'string' || !target.sha256.trim()) problems.push(`${label}: sha256 が無い`);
    else if (target.sha256.trim() === FREEZE_MARKER) warnings.push(`${label}: sha256 が ${FREEZE_MARKER}（--freeze で実測hashへ置き換える）`);
    else if (!SHA256_RE.test(target.sha256.trim())) problems.push(`${label}: sha256 が64桁hexでない`);
    if (!Array.isArray(target.readers) || target.readers.length === 0) problems.push(`${label}: readers（読み手）が空`);
    else target.readers.forEach((reader, rIndex) => {
      const rLabel = `${label}.readers[${rIndex}]`;
      if (!reader || typeof reader.path !== 'string' || !reader.path.trim()) { problems.push(`${rLabel}: path が無い`); return; }
      const hasContains = typeof reader.contains === 'string' && reader.contains.trim();
      const hasDir = typeof reader.dir_contains === 'string' && reader.dir_contains.trim();
      if (hasContains && hasDir) problems.push(`${rLabel}: contains と dir_contains は排他（併記しない）`);
      else if (!hasContains && !hasDir) problems.push(`${rLabel}: contains か dir_contains が無い`);
    });
    const probe = target.probe;
    if (!probe || typeof probe !== 'object') problems.push(`${label}: probe（確認方法）が無い`);
    else {
      if (!PROBE_KINDS.has(String(probe.kind || ''))) problems.push(`${label}: probe.kind が未対応（${PROBE_KINDS.size}種類の宣言的な probe だけ）`);
      if (typeof probe.expect_contains !== 'string' || !probe.expect_contains.trim()) problems.push(`${label}: probe.expect_contains（期待出力）が無い`);
      if (probe.cwd !== undefined) problems.push(`${label}: probe.cwd は未対応（実行場所は検査側で固定する）`);
    }
  }
  const frozen = ledger.frozen;
  if (!frozen || !Array.isArray(frozen.targets)) {
    warnings.push('frozen（凍結した対象一覧）が無い。--freeze で凍結するまで設置レビューは通らない');
  }
  return { ledger, targets: ledger.targets, problems, warnings };
}

// --- probe（宣言的・読み取りと構文解析だけ） --------------------------------
function runDeclaredProbe(probe) {
  const kind = String(probe.kind || '');
  const expect = typeof probe.expect_contains === 'string' ? probe.expect_contains.trim() : '';
  if (!PROBE_KINDS.has(kind)) return { status: 'MISMATCH', reason: `probe_kind_rejected(${kind})` };
  if (!expect) return { status: 'UNVERIFIED', reason: 'probe_expect_missing(exit 0 だけでは合格にしない)' };
  const finish = (code, output) => {
    if (code !== 0) return { status: 'MISMATCH', reason: `probe_failed(code=${code} 期待:${expect.slice(0, 40)})` };
    if (!output.includes(expect)) {
      return { status: 'MISMATCH', reason: `probe_output_mismatch(期待:${expect.slice(0, 40)} 実測:${output.trim().slice(0, 60).replace(/\s+/g, ' ')})` };
    }
    return { status: 'PASS', reason: `probe_ok(${expect.slice(0, 40)})` };
  };
  if (kind === 'self-version') return finish(0, VERSION);
  if (kind === 'file-first-line') {
    const file = requireAbsolute(probe.path);
    if (!file) return { status: 'MISMATCH', reason: 'probe_spec_invalid(path)' };
    const read = readRegularFile(file);
    if (read.error) return { status: 'UNVERIFIED', reason: `probe_${read.error}(${file})` };
    return finish(0, `PROBE_FIRST_LINE ${read.text.split(/\r?\n/)[0] || ''}`);
  }
  if (kind === 'file-contains') {
    const file = requireAbsolute(probe.path);
    const needle = typeof probe.needle === 'string' ? probe.needle : '';
    if (!file || !needle) return { status: 'MISMATCH', reason: 'probe_spec_invalid(path/needle)' };
    const read = readRegularFile(file);
    if (read.error) return { status: 'UNVERIFIED', reason: `probe_${read.error}(${file})` };
    return read.text.includes(needle) ? finish(0, 'PROBE_OK') : finish(0, 'PROBE_MISSING');
  }
  if (kind === 'dir-contains') {
    const dir = requireAbsolute(probe.path);
    const name = typeof probe.name === 'string' ? probe.name : '';
    if (!dir || !name) return { status: 'MISMATCH', reason: 'probe_spec_invalid(path/name)' };
    const stat = fs.statSync(dir, { throwIfNoEntry: false });
    if (!stat) return { status: 'UNVERIFIED', reason: `probe_dir_missing(${dir})` };
    if (!stat.isDirectory()) return { status: 'MISMATCH', reason: `probe_not_directory(${dir})` };
    try {
      return fs.readdirSync(dir).includes(name) ? finish(0, 'PROBE_OK') : finish(0, 'PROBE_MISSING');
    } catch (error) {
      return { status: 'UNVERIFIED', reason: `probe_unreadable(${error.code || error.message})` };
    }
  }
  if (kind === 'package-gate') {
    const name = typeof probe.name === 'string' && probe.name ? probe.name : 'install-review-check-test.sh';
    const read = readRegularFile(path.join(REPO_ROOT, 'package.json'));
    if (read.error) return { status: 'UNVERIFIED', reason: `probe_${read.error}(package.json)` };
    let testScript = '';
    try { testScript = JSON.parse(read.text).scripts?.test || ''; } catch (error) { return { status: 'MISMATCH', reason: `probe_package_unparsable(${error.message})` }; }
    return finish(0, testScript.includes(name) ? 'PROBE_OK' : 'PROBE_MISSING');
  }
  if (kind === 'bash-syntax' || kind === 'node-syntax') {
    const file = requireAbsolute(probe.path);
    if (!file) return { status: 'MISMATCH', reason: 'probe_spec_invalid(path)' };
    if (!fs.existsSync(file)) return { status: 'MISMATCH', reason: `probe_path_missing(${file})` };
    const argv = kind === 'bash-syntax' ? ['-n', file] : ['--check', file];
    const runner = kind === 'bash-syntax' ? 'bash' : 'node';
    let result;
    try {
      result = spawnSync(runner, argv, { cwd: REPO_ROOT, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    } catch (error) {
      return { status: 'UNVERIFIED', reason: `probe_spawn_error(${error.message})` };
    }
    if (result.error) return { status: 'UNVERIFIED', reason: `probe_spawn_error(${result.error.code || result.error.message})` };
    const marker = kind === 'bash-syntax' ? 'BASH_SYNTAX_OK' : 'NODE_SYNTAX_OK';
    return finish(result.status ?? 1, result.status === 0 ? marker : `${result.stderr || ''}`);
  }
  return { status: 'MISMATCH', reason: `probe_kind_rejected(${kind})` };
}

function requireAbsolute(value) {
  return typeof value === 'string' && path.isAbsolute(value) ? value : '';
}

// --- 設置台帳の検査 ---------------------------------------------------------
function resolveEvidencePath(evidence, instructionPath) {
  if (!evidence) return '';
  if (path.isAbsolute(evidence)) return evidence;
  return path.resolve(path.dirname(instructionPath), evidence);
}

export function checkLedger(text, { instructionPath = '' } = {}) {
  const results = [];
  const evidencePath = resolveEvidencePath(readFieldAnywhere(text, 'design_review_evidence'), instructionPath);
  const declared = readFieldAnywhere(text, 'design_review');

  // 設計証跡のゲート（不良・未確認は等しくブロックする）
  if (declared !== 'pass') {
    results.push({ id: 'design-review-gate', path: instructionPath, status: 'UNVERIFIED', reason: `design_review=pass が指示書にない（現在: ${declared || 'なし'}）` });
  } else {
    const read = evidencePath ? readRegularFile(evidencePath) : { error: 'missing' };
    if (read.error) {
      results.push({ id: 'design-review-gate', path: instructionPath, status: 'UNVERIFIED', reason: `design_review_evidence を読めない: ${evidencePath || '(空)'} (${read.error})` });
    } else {
      const parsed = parseEvidenceLine(read.text, text, instructionPath, { requireDigest: false });
      results.push(parsed.problems.length
        ? { id: 'design-review-gate', path: instructionPath, status: 'MISMATCH', reason: parsed.problems.join(' / ') }
        : { id: 'design-review-gate', path: instructionPath, status: 'PASS', reason: `design_review=pass evidence=${evidencePath}` });
    }
  }

  // 設計レビュー本文の再実行（合格後に本文が変わっていれば落ちる）
  const recheck = designReview(text);
  results.push({
    id: 'design-review-recheck',
    path: instructionPath,
    status: recheck.ok ? 'PASS' : 'MISMATCH',
    reason: recheck.ok ? '設計レビュー4点を再実行して合格' : recheck.points.filter((point) => !point.ok).map((point) => `${point.id}: ${point.detail}`).join(' / '),
  });

  const blocks = extractDeployTargets(text);
  const structural = validateLedger(blocks);
  if (structural.error) {
    results.push({ id: 'deploy-ledger', path: instructionPath, status: structural.unverified ? 'UNVERIFIED' : 'MISMATCH', reason: structural.error });
    return results;
  }
  for (const warning of structural.warnings) {
    results.push({ id: 'deploy-ledger', path: instructionPath, status: 'UNVERIFIED', reason: warning });
  }
  if (structural.problems && structural.problems.length) {
    results.push({ id: 'deploy-ledger', path: instructionPath, status: 'MISMATCH', reason: structural.problems.join(' / ') });
  }
  if (structural.notRequired) {
    results.push({ id: 'deploy-not-required', path: instructionPath, status: 'PASS', reason: `設置不要（理由: ${structural.notRequired}）` });
    return results;
  }
  const ledger = structural.ledger;

  // 証跡が凍結した台帳に結び付いているか
  const digest = frozenTargetsDigest(ledger);
  results.push((() => {
    if (digest === 'unfrozen') {
      return { id: 'design-review-binding', path: instructionPath, status: 'UNVERIFIED', reason: 'frozen（凍結した対象一覧）が無い。--freeze で凍結する' };
    }
    const read = evidencePath ? readRegularFile(evidencePath) : { error: 'missing' };
    if (read.error) return { id: 'design-review-binding', path: instructionPath, status: 'UNVERIFIED', reason: `証跡を読めない: ${evidencePath || '(空)'}` };
    const parsed = parseEvidenceLine(read.text, text, instructionPath, { requireDigest: true });
    return parsed.problems.length
      ? { id: 'design-review-binding', path: instructionPath, status: 'MISMATCH', reason: parsed.problems.join(' / ') }
      : { id: 'design-review-binding', path: instructionPath, status: 'PASS', reason: `証跡が凍結した台帳に一致(ledger_sha256=${digest.slice(0, 12)})` };
  })());

  // 凍結した対象一覧との照合（対象を1件消しただけでも落ちる）
  const frozen = ledger.frozen;
  const current = structural.targets.map((target) => ({
    id: String(target?.id ?? ''), path: String(target?.path ?? ''), sha256: String(target?.sha256 ?? ''),
  }));
  if (frozen && Array.isArray(frozen.targets)) {
    const frozenList = frozen.targets.map((target) => ({
      id: String(target?.id ?? ''), path: String(target?.path ?? ''), sha256: String(target?.sha256 ?? ''),
    }));
    const removed = frozenList.filter((entry) => !current.some((now) => now.id === entry.id && now.path === entry.path));
    const added = current.filter((now) => !frozenList.some((entry) => entry.id === entry.id && entry.path === now.path));
    const changed = current.filter((now) => {
      const before = frozenList.find((entry) => entry.id === now.id && entry.path === now.path);
      return before && before.sha256 !== now.sha256;
    });
    const problems = [];
    if (removed.length) problems.push(`凍結後に消えた対象: ${removed.map((entry) => entry.id).join(', ')}`);
    if (added.length) problems.push(`凍結後に増えた対象: ${added.map((entry) => entry.id).join(', ')}`);
    if (changed.length) problems.push(`凍結後にhashが変わった対象: ${changed.map((entry) => entry.id).join(', ')}（--freeze で凍結し直す）`);
    results.push({
      id: 'freeze-manifest',
      path: instructionPath,
      status: problems.length ? 'MISMATCH' : 'PASS',
      reason: problems.join(' / ') || `凍結した ${frozenList.length} 件と一致`,
    });
  }

  for (const [index, target] of structural.targets.entries()) {
    const id = target && target.id ? String(target.id) : `target#${index + 1}`;
    const record = { id, path: target && target.path ? String(target.path) : '' };
    const problems = [];
    const unverified = [];
    const targetPath = record.path;

    if (!targetPath || !path.isAbsolute(targetPath)) {
      results.push({ ...record, status: 'MISMATCH', reason: 'path が絶対パスでない' });
      continue;
    }
    const file = readRegularFile(targetPath);
    if (file.error === 'missing') problems.push(`path_missing(${targetPath})`);
    else if (file.error === 'symlink') problems.push(`path_symlink(${targetPath})`);
    else if (file.error === 'not_file') problems.push(`path_not_file(${targetPath})`);
    else if (file.error) unverified.push(`path_${file.error}`);

    const expectedHash = typeof target.sha256 === 'string' ? target.sha256.trim() : '';
    if (!expectedHash) unverified.push('sha256_missing');
    else if (expectedHash === FREEZE_MARKER) unverified.push('sha256_freeze_pending(--freeze で凍結する)');
    else if (!SHA256_RE.test(expectedHash)) unverified.push(`sha256_not_hex(${expectedHash.slice(0, 16)})`);
    else if (!file.error) {
      const actual = sha256File(targetPath);
      if (actual !== expectedHash) problems.push(`hash_mismatch(expected=${expectedHash.slice(0, 12)} actual=${actual.slice(0, 12)})`);
    }

    const readers = Array.isArray(target.readers) ? target.readers : [];
    for (const [rIndex, reader] of readers.entries()) {
      const label = `readers[${rIndex}]`;
      const readerPath = String(reader.path);
      if (typeof reader.dir_contains === 'string' && reader.dir_contains.trim()) {
        try {
          const stat = fs.statSync(readerPath, { throwIfNoEntry: false });
          if (!stat) { problems.push(`${label}_dir_missing(${readerPath})`); continue; }
          if (!stat.isDirectory()) { problems.push(`${label}_not_directory(${readerPath})`); continue; }
          if (!fs.readdirSync(readerPath).includes(reader.dir_contains)) problems.push(`${label}_entry_missing(${reader.dir_contains} in ${readerPath})`);
        } catch (error) {
          unverified.push(`${label}_unreadable(${error.code || error.message})`);
        }
        continue;
      }
      const needle = typeof reader.contains === 'string' ? reader.contains : '';
      const readerFile = readRegularFile(readerPath);
      if (readerFile.error === 'missing') problems.push(`${label}_missing(${readerPath})`);
      else if (readerFile.error) unverified.push(`${label}_${readerFile.error}`);
      else if (!readerFile.text.includes(needle)) problems.push(`${label}_reference_missing(${needle} in ${readerPath})`);
    }

    const probeResult = runDeclaredProbe(target.probe || {});
    if (probeResult.status === 'MISMATCH') problems.push(probeResult.reason);
    else if (probeResult.status === 'UNVERIFIED') unverified.push(probeResult.reason);

    results.push({
      ...record,
      status: problems.length ? 'MISMATCH' : (unverified.length ? 'UNVERIFIED' : 'PASS'),
      reason: [...problems, ...unverified].join(' / ') || `ok hash=${expectedHash.slice(0, 12)} readers=${readers.length}`,
    });
  }
  return results;
}

// --- 凍結（--freeze） -------------------------------------------------------
export function freezeInstruction(file) {
  const read = readRegularFile(file);
  if (read.error) return { error: `${file}: ${read.error}` };
  const text = read.text;
  const blocks = extractJsonBlocks(text, { requireKey: 'deploy_targets' });
  if (blocks.length !== 1) return { error: `deploy_targets のJSONブロックが1個ではない（${blocks.length}個）` };
  const block = blocks[0];
  const duplicate = findDuplicateJsonKey(block.text);
  if (duplicate) return { error: `台帳のJSONに重複キー: ${duplicate}` };
  let parsed;
  try { parsed = JSON.parse(block.text); } catch (error) { return { error: `台帳のJSONを解析できない: ${error.message}` }; }
  const ledger = parsed.deploy_targets;
  if (!ledger || ledger.deploy_required === false) return { error: 'deploy_required:false の台帳は凍結しない（対象0件）' };
  if (!Array.isArray(ledger.targets) || ledger.targets.length === 0) return { error: 'targets が空' };
  const problems = [];
  const targets = ledger.targets.map((target, index) => {
    const label = target && target.id ? String(target.id) : `target#${index + 1}`;
    const targetPath = String(target?.path ?? '');
    if (!path.isAbsolute(targetPath)) { problems.push(`${label}: path が絶対パスでない`); return target; }
    const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
    if (!stat) { problems.push(`${label}: path_missing(${targetPath})`); return target; }
    if (stat.isSymbolicLink() || !stat.isFile()) { problems.push(`${label}: 通常ファイルでない(${targetPath})`); return target; }
    return { ...target, sha256: sha256File(targetPath) };
  });
  if (problems.length) return { error: `凍結できない: ${problems.join(' / ')}` };
  ledger.targets = targets;
  ledger.frozen = {
    checker: VERSION,
    frozen_at: new Date().toISOString(),
    targets: targets.map((target) => ({ id: String(target.id ?? ''), path: String(target.path ?? ''), sha256: String(target.sha256 ?? '') })),
  };
  const newBlock = JSON.stringify(parsed, null, 2);
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  // 行単位でフェンスを辿り、対象ブロックの中身だけを差し替える。
  let inFence = false;
  let lang = '';
  let start = -1;
  let bodyStart = -1;
  let bodyEnd = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^\s*```(.*)$/.exec(lines[index]);
    if (!inFence) {
      if (open) { inFence = true; lang = open[1].trim().toLowerCase(); start = index; }
      continue;
    }
    if (/^\s*```\s*$/.test(lines[index])) {
      inFence = false;
      if ((lang === 'json' || lang === '') && start + 1 === block.line) { bodyStart = start + 1; bodyEnd = index; break; }
      start = -1;
    }
  }
  if (bodyStart < 0 || bodyEnd < 0) return { error: '台帳ブロックの位置を特定できない' };
  const out = [...lines.slice(0, bodyStart), ...newBlock.split('\n'), ...lines.slice(bodyEnd)];
  fs.writeFileSync(file, `${out.join('\n')}\n`);
  return { targets, digest: frozenTargetsDigest(ledger) };
}

// 証跡行（DESIGN_REVIEW_EVIDENCE）を厳密に解析する。必須項目が1つでも欠ければ不合格にする。
function parseEvidenceLine(evidenceText, instructionText, instructionPath, { requireDigest = true } = {}) {
  const line = evidenceText.split(/\r?\n/).find((candidate) => candidate.startsWith('DESIGN_REVIEW_EVIDENCE ')) || '';
  const problems = [];
  if (!line) return { problems: ['DESIGN_REVIEW_EVIDENCE 行が無い（この検査器が書いた証跡ではない）'] };
  const expectFile = path.basename(instructionPath);
  const file = /(?:^|\s)file=(\S+)/.exec(line)?.[1] || '';
  const result = /(?:^|\s)result=(\S+)/.exec(line)?.[1] || '';
  const checker = /(?:^|\s)checker=(\S+)/.exec(line)?.[1] || '';
  const digest = /(?:^|\s)ledger_sha256=(\S+)/.exec(line)?.[1] || '';
  if (!file) problems.push('file= が無い');
  else if (file !== expectFile) problems.push(`別の指示書の証跡(file=${file})`);
  if (!result) problems.push('result= が無い');
  else if (result !== 'pass') problems.push(`合格していない(result=${result})`);
  if (!checker) problems.push('checker= が無い');
  else if (checker !== VERSION_ID) problems.push(`検査器の版が違う(checker=${checker})`);
  if (!digest) problems.push('ledger_sha256= が無い');
  else if (!(SHA256_RE.test(digest) || digest === 'unfrozen')) problems.push(`ledger_sha256= の形式が不正(${digest.slice(0, 16)})`);
  else if (requireDigest) {
    const blocks = extractDeployTargets(instructionText);
    const structural = validateLedger(blocks);
    const expected = structural.error || structural.notRequired ? 'unfrozen' : frozenTargetsDigest(structural.ledger);
    if (digest !== expected) problems.push(`証跡が凍結した台帳と食い違う(証跡=${digest.slice(0, 12)} 現在=${expected.slice(0, 12)})。--design-review --log で取り直す`);
  }
  return { file, result, checker, digest, problems };
}

// --- 発注前の設計ゲート（check-instruction から呼ばれる） --------------------
// 台帳を書いた指示書だけを対象にする（書いていない指示書＝他の稼働中の発注は止めない）。
export function instructionDesignGate(text, instructionPath = '') {
  const blocks = extractDeployTargets(text);
  if (blocks.length === 0) return { applies: false, problems: [] };
  const structural = validateLedger(blocks);
  if (structural.notRequired) return { applies: true, problems: [] };
  const problems = [];
  if (structural.error) problems.push(`設置台帳が不正: ${structural.error}`);
  for (const problem of structural.problems || []) problems.push(`設置台帳が不正: ${problem}`);
  const review = designReview(text);
  if (!review.ok) {
    problems.push(`設計レビュー4点が不合格: ${review.points.filter((point) => !point.ok).map((point) => `${point.id}=${point.detail}`).join(' / ')}`);
  }
  const declared = readFieldAnywhere(text, 'design_review');
  if (declared !== 'pass') problems.push(`design_review が pass ではない（現在: ${declared || 'なし'}）`);
  const evidence = resolveEvidencePath(readFieldAnywhere(text, 'design_review_evidence'), instructionPath);
  const read = evidence ? readRegularFile(evidence) : { error: 'missing' };
  if (read.error) problems.push(`design_review_evidence を読めない: ${evidence || '(空)'} (${read.error})`);
  else {
    // 発注前は未凍結（digest=unfrozen）を許すが、行の必須項目と版・対象指示書は厳密に見る。
    const parsed = parseEvidenceLine(read.text, text, instructionPath, { requireDigest: false });
    for (const problem of parsed.problems) problems.push(`設計証跡: ${problem}`);
  }
  return { applies: true, problems };
}

// --- 出力 -------------------------------------------------------------------
function formatResults(title, rows) {
  const lines = rows.map((row) => `${row.status}\t${row.id}\t${row.path || ''}\t${row.reason}`);
  const mismatch = rows.filter((row) => row.status === 'MISMATCH').length;
  const unverified = rows.filter((row) => row.status === 'UNVERIFIED').length;
  const passed = mismatch === 0 && unverified === 0;
  lines.push('');
  lines.push(passed
    ? `${title}_PASSED targets=${rows.length} mismatch=0 unverified=0 version=${VERSION}`
    : `${title}_BLOCKED targets=${rows.length} mismatch=${mismatch} unverified=${unverified} version=${VERSION}`);
  return { text: lines.join('\n'), passed, mismatch, unverified };
}

function usage() {
  return [
    'usage: node scripts/install-review-check.mjs <mode>',
    '  --version',
    '  --self-check',
    '  --design-review <指示書.md> [--log <証跡.md>] [--json]',
    '  --freeze <指示書.md>',
    '  --ledger <指示書.md> [--json]',
    '  --sweep [<指示書ディレクトリ>] [--repo <ルート>] [--block] [--json]',
    '  --probe-reader <file> <needle>',
    '  --probe-package-gate [<name>]',
  ].join('\n');
}

function designReport(file, text) {
  const review = designReview(text);
  const lines = review.points.map((point) => `${point.ok ? 'PASS' : 'BLOCK'}\t${point.id}\t${point.detail}`);
  for (const warning of review.warnings) lines.push(`WARN\t${warning}`);
  lines.push('');
  lines.push(review.ok ? `DESIGN_REVIEW_PASSED points=4 warnings=${review.warnings.length} file=${file}` : `DESIGN_REVIEW_BLOCKED file=${file}`);
  return { review, text: lines.join('\n') };
}

function ledgerRows(file, text) {
  return checkLedger(text, { instructionPath: file });
}

function main(argv) {
  const mode = argv[0];
  const json = argv.includes('--json');
  if (mode === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (mode === '--self-check') {
    process.stdout.write(`INSTALL_REVIEW_SELFCHECK_OK version=${VERSION} repo=${REPO_ROOT} probe_kinds=${PROBE_KINDS.size}\n`);
    return 0;
  }
  if (mode === '--probe-reader') {
    const file = argv[1];
    const needle = argv[2];
    if (!file || !needle) { process.stderr.write('PROBE_USAGE: --probe-reader <file> <needle>\n'); return 2; }
    const target = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    const read = readRegularFile(target);
    if (read.error) { process.stdout.write(`PROBE_MISSING file=${file} reason=${read.error}\n`); return 1; }
    if (read.text.includes(needle)) { process.stdout.write(`PROBE_OK file=${file} needle=${needle}\n`); return 0; }
    process.stdout.write(`PROBE_MISSING file=${file} needle=${needle}\n`);
    return 1;
  }
  if (mode === '--probe-package-gate') {
    const name = argv[1] || 'install-review-check-test.sh';
    const read = readRegularFile(path.join(REPO_ROOT, 'package.json'));
    if (read.error) { process.stdout.write(`PROBE_MISSING file=package.json reason=${read.error}\n`); return 1; }
    try {
      const testScript = JSON.parse(read.text).scripts?.test || '';
      if (testScript.includes(name)) { process.stdout.write(`PROBE_OK file=package.json gate=${name}\n`); return 0; }
    } catch (error) {
      process.stdout.write(`PROBE_MISSING file=package.json reason=${error.message}\n`);
      return 1;
    }
    process.stdout.write(`PROBE_MISSING file=package.json gate=${name}\n`);
    return 1;
  }
  if (mode === '--design-review') {
    const file = argv[1];
    const read = file ? readRegularFile(file) : { error: 'usage' };
    if (read.error) { process.stderr.write(`INSTALL_REVIEW_UNCHECKED: ${file || '(なし)'}: ${read.error}\n${usage()}\n`); return 2; }
    const report = designReport(file, read.text);
    const logIndex = argv.indexOf('--log');
    const logPath = logIndex >= 0 ? argv[logIndex + 1] : '';
    if (json) {
      process.stdout.write(`${JSON.stringify({ mode: 'design-review', file, ...report.review }, null, 2)}\n`);
    } else {
      process.stdout.write(`${report.text}\n`);
    }
    if (logPath) {
      const blocks = extractDeployTargets(read.text);
      const structural = validateLedger(blocks);
      const digest = structural.error || structural.notRequired ? 'unfrozen' : frozenTargetsDigest(structural.ledger);
      const evidence = [
        report.text,
        '',
        `DESIGN_REVIEW_EVIDENCE file=${path.basename(file)} result=${report.review.ok ? 'pass' : 'blocked'} checker=${VERSION_ID} ledger_sha256=${digest}`,
        '',
      ].join('\n');
      fs.mkdirSync(path.dirname(path.resolve(logPath)), { recursive: true });
      fs.writeFileSync(logPath, evidence);
      process.stdout.write(`DESIGN_REVIEW_LOG ${logPath} ledger_sha256=${digest}\n`);
    }
    return report.review.ok ? 0 : 1;
  }
  if (mode === '--freeze') {
    const file = argv[1];
    if (!file) { process.stderr.write(`INSTALL_REVIEW_UNCHECKED: --freeze には指示書のパスが要る\n${usage()}\n`); return 2; }
    const result = freezeInstruction(file);
    if (result.error) { process.stdout.write(`INSTALL_REVIEW_FREEZE_BLOCKED ${file} reason=${result.error}\n`); return 1; }
    process.stdout.write(`INSTALL_REVIEW_FROZEN targets=${result.targets.length} ledger_sha256=${result.digest} file=${file}\n`);
    return 0;
  }
  if (mode === '--ledger') {
    const file = argv[1];
    const read = file ? readRegularFile(file) : { error: 'usage' };
    if (read.error) { process.stderr.write(`INSTALL_REVIEW_UNCHECKED: ${file || '(なし)'}: ${read.error}\n${usage()}\n`); return 2; }
    const rows = ledgerRows(file, read.text);
    if (json) {
      const mismatch = rows.filter((row) => row.status === 'MISMATCH').length;
      const unverified = rows.filter((row) => row.status === 'UNVERIFIED').length;
      process.stdout.write(`${JSON.stringify({ mode: 'ledger', file, passed: mismatch === 0 && unverified === 0, mismatch, unverified, results: rows }, null, 2)}\n`);
      return mismatch === 0 && unverified === 0 ? 0 : 1;
    }
    const formatted = formatResults('INSTALL_REVIEW', rows);
    process.stdout.write(`${formatted.text}\n`);
    return formatted.passed ? 0 : 1;
  }
  if (mode === '--sweep') {
    const dir = (argv[1] && !argv[1].startsWith('--')) ? argv[1] : DEFAULT_INSTRUCTIONS_DIR;
    const repoIndex = argv.indexOf('--repo');
    const repoRoot = repoIndex >= 0 && argv[repoIndex + 1] ? path.resolve(argv[repoIndex + 1]) : REPO_ROOT;
    const stat = fs.statSync(dir, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) {
      process.stdout.write(`INSTALL_REVIEW_SWEEP_SKIP dir=${dir} reason=指示書ディレクトリが無い\n`);
      return 0;
    }
    const rows = [];
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.md') || name.startsWith('_')) continue;
      const file = path.join(dir, name);
      const read = readRegularFile(file);
      if (read.error) continue;
      const blocks = extractDeployTargets(read.text);
      if (blocks.length === 0) continue;
      const structural = validateLedger(blocks);
      if (structural.error) { rows.push({ file, status: 'BLOCKED', reason: structural.error }); continue; }
      if (structural.notRequired) { rows.push({ file, status: 'NOT_REQUIRED', reason: structural.notRequired }); continue; }
      const inRepo = structural.targets.some((target) => String(target?.path || '').startsWith(`${repoRoot}/`));
      if (!inRepo) { rows.push({ file, status: 'SKIP_OUT_OF_REPO', reason: 'このリポジトリ内に設置先が無い' }); continue; }
      const results = checkLedger(read.text, { instructionPath: file });
      const mismatch = results.filter((row) => row.status === 'MISMATCH');
      const unverified = results.filter((row) => row.status === 'UNVERIFIED');
      rows.push({
        file,
        status: mismatch.length ? 'BLOCKED' : (unverified.length ? 'UNVERIFIED' : 'PASSED'),
        reason: [...mismatch, ...unverified].map((row) => `${row.id}: ${row.reason}`).join(' / ') || 'ok',
      });
    }
    if (json) {
      process.stdout.write(`${JSON.stringify({ mode: 'sweep', dir, repo: repoRoot, rows }, null, 2)}\n`);
    } else {
      for (const row of rows) process.stdout.write(`${row.status}\t${row.file}\t${row.reason}\n`);
    }
    const blocked = rows.filter((row) => row.status === 'BLOCKED' || row.status === 'UNVERIFIED');
    process.stdout.write(`INSTALL_REVIEW_SWEEP ledger_bearing=${rows.length} blocked=${blocked.length} block_mode=${argv.includes('--block') ? 'on' : 'off'} repo=${repoRoot}\n`);
    if (argv.includes('--block') && blocked.length) return 1;
    return 0;
  }
  process.stderr.write(`${usage()}\n`);
  return 2;
}

const cliEntry = (() => {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (cliEntry) process.exitCode = main(process.argv.slice(2));
