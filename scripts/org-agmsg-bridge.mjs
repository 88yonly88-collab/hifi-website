// agmsg → 各レーンのファイル受信箱 への橋渡し。
// ねらい: 待っていないレーンでも「気づける」ようにする。agmsgの未読を取り込み、
// 指示書idを含むメッセージは .ai/org-inbox/<id>.json として置く（org.mjs wait / inbox が拾える）。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { INBOX_DIR } from './org-flow.mjs';

export const TEAM_DEFAULT = 'dsh-lanes';
export const INBOX_SH = ['.agents', 'skills', 'agmsg', 'scripts', 'inbox.sh'];

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


// DB直読モード: 1回のSQLで全レーンの未読をまとめて取り込む（タイマー向けに軽い）
export function bridgeFromDb({ root, team = TEAM_DEFAULT, dbPath, runSql, now = new Date().toISOString() }) {
  const db = dbPath || resolveAgmsgDb();
  const sql = runSql || ((q) => execFileSync('sqlite3', ['-json', db, q], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }));
  let rows = [];
  try {
    const out = sql(`select id, to_agent, body from messages where team='${team.replace(/'/gu, "''")}' and read_at is null;`);
    rows = out.trim() ? JSON.parse(out) : [];
  } catch (error) {
    return { ok: false, error: `DB読取に失敗: ${String(error?.message || error).slice(0, 120)}`, bridged: [] };
  }
  const lanes = new Set(listLanes(root));
  const bridged = [];
  const consumed = [];
  const unmatched = [];
  for (const row of rows) {
    const lane = String(row.to_agent || '');
    if (!lanes.has(lane)) { unmatched.push({ lane, id: row.id }); continue; }
    consumed.push(row.id);
    const { ids, path } = parseInstructionIds(row.body);
    for (const id of ids) {
      const target = join(root, lane, ...INBOX_DIR, `${id}.json`);
      if (existsSync(target)) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify({
        schema: 'ai-dev-tool/org-dispatch@1', id,
        instructionPath: path || null, instructionSha256: id,
        dispatchedBy: 'agmsg-bridge', dispatchedAt: now, via: 'agmsg', status: 'dispatched',
      }, null, 2)}\n`, 'utf8');
      bridged.push({ lane, id });
    }
  }
  if (consumed.length) {
    try { sql(`update messages set read_at=datetime('now') where id in (${consumed.join(',')});`); } catch { /* 既読化に失敗しても取り込みは成立させる */ }
  }
  return { ok: true, scanned: rows.length, bridged, unmatched };
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = parse(process.argv.slice(2));
  const root = flags.root || '/home/dev/projects';
  const team = flags.team || TEAM_DEFAULT;
  if ((flags.via || 'db') === 'db') {
    const r = bridgeFromDb({ root, team });
    if (!r.ok) { console.error(`✗ ${r.error}`); process.exit(2); }
    const byLane = r.bridged.map((b) => b.lane);
    console.log(`橋渡し(DB): 未読${r.scanned}件 / 新規取り込み${r.bridged.length}件${byLane.length ? ` — ${byLane.join(' ')}` : ''}`);
    if (r.unmatched?.length) {
      console.log(`  ⚠ 対象外レーン宛の未読 ${r.unmatched.length}件（レーン未設定のため取り込まず・既読にもしない）`);
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
