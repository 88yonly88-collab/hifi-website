// agmsg → 各レーンのファイル受信箱 への橋渡し。
// ねらい: 待っていないレーンでも「気づける」ようにする。agmsgの未読を取り込み、
// 指示書idを含むメッセージは .ai/org-inbox/<id>.json として置く（org.mjs wait / inbox が拾える）。
//
// 宛先の解決（2026-10-20 H-6 修正）:
//   1) <root>/<lane>/.ai/current-task.json を持つディレクトリ（従来どおり）
//   2) このファイルの隣の lanes.json（wake.mjs と同じ台帳）。agent と aliases[] を cwd へ対応付ける。
//      例: dsh-vp / vice-president → /home/dev/projects/chat/vice-president
//      entry.bridge.messages=true  … 指示書idを含まない連絡も agmsg-<msgid>.json として受信箱へ置く
//      entry.bridge.markRead=false … 既読化しない（レーン自身が処理時に既読化する。check-vp-inbox.sh の①に残す）
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INBOX_DIR } from './org-flow.mjs';

export const TEAM_DEFAULT = 'dsh-lanes';
export const INBOX_SH = ['.agents', 'skills', 'agmsg', 'scripts', 'inbox.sh'];
export const LANES_JSON_NAME = 'lanes.json';
export const PROCESSED_DIR = 'processed';
export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// agmsgのDBは配置が変わり得るため、環境変数→既知の配置の順で解決する。
export function resolveAgmsgDb() {
  const candidates = [
    process.env.AGMSG_DB,
    join(homedir(), '.agents', 'skills', 'agmsg', 'db', 'messages.db'),
    join(homedir(), '.agents', 'agmsg', 'agmsg.db'),
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  return candidates[1];
}

const ID_RE = /id=([0-9a-f]{64})/gu;
const PATH_RE = /path=(\S+)/u;
const AGENT_RE = /^[A-Za-z0-9._:-]{1,64}$/u;

export function parseInstructionIds(text) {
  const ids = [];
  for (const m of String(text || '').matchAll(ID_RE)) ids.push(m[1]);
  const path = String(text || '').match(PATH_RE)?.[1] || null;
  return { ids: [...new Set(ids)], path };
}

// 1レーン分の未読を取り込み、受信箱へ置く（既にあれば何もしない）
export function bridgeLane({ repo, lane, team = TEAM_DEFAULT, inboxScript, runInbox, now = new Date().toISOString() }) {
  if (!existsSync(join(repo, '.ai'))) return { ok: false, lane, error: `.ai がありません: ${repo}` };
  const script = inboxScript || join(homedir(), ...INBOX_SH);
  if (!runInbox && !existsSync(script)) return { ok: false, lane, error: `inbox.sh がありません: ${script}` };
  let out = '';
  try {
    out = runInbox ? runInbox({ lane, team }) : execFileSync('bash', [script, team, lane], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    return { ok: false, lane, error: `受信に失敗: ${String(error?.message || error).slice(0, 120)}` };
  }
  const { ids, path } = parseInstructionIds(out);
  const bridged = [];
  for (const id of ids) {
    const target = join(repo, ...INBOX_DIR, `${id}.json`);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({
      schema: 'ai-dev-tool/org-dispatch@1',
      id,
      instructionPath: path || null,
      instructionSha256: id,
      dispatchedBy: 'agmsg-bridge',
      dispatchedAt: now,
      via: 'agmsg',
      status: 'dispatched',
    }, null, 2)}\n`, 'utf8');
    bridged.push(id);
  }
  return { ok: true, lane, unread: ids.length, bridged };
}

export function listLanes(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => existsSync(join(root, n, '.ai', 'current-task.json')))
    .sort();
}

// lanes.json（wake.mjs と同じ台帳）から agent/aliases → cwd の対応を読む。
// 壊れていても橋渡し全体は止めない（従来の current-task.json 方式だけで続ける）。
export function loadLaneAliases(lanesPath) {
  if (!lanesPath || !existsSync(lanesPath)) return { ok: true, entries: [], problems: [], path: lanesPath || null, missing: true };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(lanesPath, 'utf8'));
  } catch (error) {
    return { ok: false, entries: [], problems: [`lanes.json を読めません: ${String(error?.message || error).slice(0, 80)}`], path: lanesPath };
  }
  const list = Array.isArray(parsed?.lanes) ? parsed.lanes : [];
  const entries = [];
  const problems = [];
  list.forEach((raw, index) => {
    const at = `lanes[${index}]`;
    const agent = String(raw?.agent ?? '').trim();
    const cwd = String(raw?.cwd ?? '').trim();
    if (!AGENT_RE.test(agent)) { problems.push(`${at}.agent が不正`); return; }
    if (!isAbsolute(cwd)) { problems.push(`${at}.cwd が絶対パスでない`); return; }
    const aliases = Array.isArray(raw?.aliases) ? raw.aliases.map((a) => String(a).trim()).filter((a) => AGENT_RE.test(a)) : [];
    const bridge = raw?.bridge && typeof raw.bridge === 'object' ? raw.bridge : {};
    entries.push({
      agent,
      aliases,
      cwd: resolve(cwd),
      messages: bridge.messages === true,
      markRead: bridge.markRead !== false,
    });
  });
  return { ok: true, entries, problems, path: lanesPath };
}

// 宛先名 → { cwd, messages, markRead } の表を作る。
// 優先順: lanes.json の明示（agent/aliases）＞ <root>/<name> の自動検出。
export function buildLaneMap({ root, lanesPath, lanes = loadLaneAliases(lanesPath) }) {
  const map = new Map();
  for (const name of listLanes(root)) {
    map.set(name, { cwd: join(root, name), messages: false, markRead: true, source: 'root' });
  }
  for (const e of lanes.entries) {
    for (const name of [e.agent, ...e.aliases]) {
      map.set(name, { cwd: e.cwd, messages: e.messages, markRead: e.markRead, source: 'lanes.json' });
    }
  }
  return { map, lanes };
}

function alreadyDelivered(inboxDir, name) {
  return existsSync(join(inboxDir, name)) || existsSync(join(inboxDir, PROCESSED_DIR, name));
}

function writeRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

// DB直読モード: 1回のSQLで全レーンの未読をまとめて取り込む（タイマー向けに軽い）
export function bridgeFromDb({ root, team = TEAM_DEFAULT, dbPath, runSql, lanesPath = join(SCRIPT_DIR, LANES_JSON_NAME), now = new Date().toISOString() }) {
  const db = dbPath || resolveAgmsgDb();
  const sql = runSql || ((q) => execFileSync('sqlite3', ['-json', db, q], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }));
  let rows = [];
  try {
    const out = sql(`select id, to_agent, from_agent, created_at, body from messages where team='${team.replace(/'/gu, "''")}' and read_at is null;`);
    rows = out.trim() ? JSON.parse(out) : [];
  } catch (error) {
    return { ok: false, error: `DB読取に失敗: ${String(error?.message || error).slice(0, 120)}`, bridged: [] };
  }
  const { map, lanes } = buildLaneMap({ root, lanesPath });
  const bridged = [];
  const consumed = [];
  const unmatched = [];
  const kept = [];
  const selfSkipped = [];
  for (const row of rows) {
    const lane = String(row.to_agent || '');
    // 自己宛（from と to が同じ）は意味がなく、取り込むと wake のループになる（2026-10-27 実測: agmsg 125963）。
    // inbox を作らず read_at を付けて消費する（付けないと同じメッセージで wake が起き続ける）。
    if (String(row.from_agent || '') === lane) {
      selfSkipped.push({ lane, id: row.id });
      console.log(`self-skip id=${row.id} agent=${lane}`);
      continue;
    }
    const entry = map.get(lane);
    if (!entry) { unmatched.push({ lane, id: row.id, reason: 'lane-unknown' }); continue; }
    if (!existsSync(join(entry.cwd, '.ai'))) { unmatched.push({ lane, id: row.id, reason: `.ai なし: ${entry.cwd}` }); continue; }
    const inboxDir = join(entry.cwd, ...INBOX_DIR);
    if (entry.markRead) consumed.push(row.id); else kept.push(row.id);
    const { ids, path } = parseInstructionIds(row.body);
    for (const id of ids) {
      const name = `${id}.json`;
      if (alreadyDelivered(inboxDir, name)) continue;
      writeRecord(join(inboxDir, name), {
        schema: 'ai-dev-tool/org-dispatch@1', id,
        instructionPath: path || null, instructionSha256: id,
        dispatchedBy: 'agmsg-bridge', dispatchedAt: now, via: 'agmsg', status: 'dispatched',
        agmsg: { messageId: row.id, from: row.from_agent ?? null, to: lane, createdAt: row.created_at ?? null },
      });
      bridged.push({ lane, id, kind: 'instruction' });
    }
    if (entry.messages && ids.length === 0) {
      const id = `agmsg-${row.id}`;
      const name = `${id}.json`;
      if (alreadyDelivered(inboxDir, name)) continue;
      writeRecord(join(inboxDir, name), {
        schema: 'ai-dev-tool/org-message@1', id,
        messageId: row.id, team, from: row.from_agent ?? null, to: lane, createdAt: row.created_at ?? null,
        body: String(row.body ?? ''),
        dispatchedBy: 'agmsg-bridge', dispatchedAt: now, via: 'agmsg', status: 'unread',
        note: '処理したら processed/ へ移し、DBの read_at を更新する（markRead=false のレーン）',
      });
      bridged.push({ lane, id, kind: 'message' });
    }
  }
  // 自己宛も read_at を付けて消費する（inbox は作らない）。
  const toConsume = [...consumed, ...selfSkipped.map((entry) => entry.id)];
  if (toConsume.length) {
    try { sql(`update messages set read_at=datetime('now') where id in (${toConsume.join(',')});`); } catch { /* 既読化に失敗しても取り込みは成立させる */ }
  }
  return { ok: true, scanned: rows.length, bridged, unmatched, kept, selfSkipped, lanesProblems: lanes.problems, lanesPath: lanes.path };
}

function parse(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { flags[key] = true; continue; }
      flags[key] = v; i += 1;
    }
  }
  return flags;
}

function summarizeUnmatched(unmatched) {
  const byLane = new Map();
  for (const u of unmatched) byLane.set(u.lane, (byLane.get(u.lane) || 0) + 1);
  return [...byLane.entries()].sort((a, b) => b[1] - a[1]).map(([lane, n]) => `${lane}×${n}`).join(' ');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = parse(process.argv.slice(2));
  const root = flags.root || '/home/dev/projects';
  const team = flags.team || TEAM_DEFAULT;
  if ((flags.via || 'db') === 'db') {
    const lanesPath = flags.lanes || process.env.AGMSG_BRIDGE_LANES || join(SCRIPT_DIR, LANES_JSON_NAME);
    const r = bridgeFromDb({ root, team, lanesPath });
    if (!r.ok) { console.error(`✗ ${r.error}`); process.exit(2); }
    const byLane = r.bridged.map((b) => `${b.lane}${b.kind === 'message' ? '(連絡)' : ''}`);
    console.log(`橋渡し(DB): 未読${r.scanned}件 / 新規取り込み${r.bridged.length}件${byLane.length ? ` — ${byLane.join(' ')}` : ''}`);
    if (r.kept?.length) console.log(`  ・既読にせず残した ${r.kept.length}件（markRead=false のレーン宛。レーン自身が処理時に既読化）`);
    if (r.lanesProblems?.length) console.log(`  ⚠ lanes.json の不正な定義 ${r.lanesProblems.length}件: ${r.lanesProblems.join(' / ')}`);
    if (r.unmatched?.length) {
      console.log(`  ⚠ 対象外レーン宛の未読 ${r.unmatched.length}件（レーン未設定のため取り込まず・既読にもしない）: ${summarizeUnmatched(r.unmatched)}`);
    }
    process.exit(0);
  }
  const lanes = flags.lane ? [flags.lane] : listLanes(root);
  let total = 0;
  const bridgedLanes = [];
  for (const lane of lanes) {
    const r = bridgeLane({ repo: join(root, lane), lane, team });
    if (!r.ok) { console.error(`✗ ${lane}: ${r.error}`); continue; }
    if (r.bridged.length) { total += r.bridged.length; bridgedLanes.push(`${lane}(${r.bridged.length})`); }
  }
  console.log(`橋渡し: レーン${lanes.length}件 / 新規取り込み${total}件${bridgedLanes.length ? ` — ${bridgedLanes.join(' ')}` : ''}`);
}
