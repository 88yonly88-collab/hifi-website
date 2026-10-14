// 会社組織フロー（副社長→統括→部隊→統括検収→副社長）の機械検査と記録。
// 正本: templates/scripts/org-flow.mjs（このファイルは本体側の実体）。
// 方針: 欄欠落・改ざん・対象不在・未確認の合格読み替えを fail-closed で拒否する。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const INBOX_DIR = ['.ai', 'org-inbox'];
export const OUTBOX_DIR = ['.ai', 'org-outbox'];
export const CHECKLIST_MIN = 9;

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readNumberField(text, key) {
  const m = text.match(new RegExp(`^${key}\\s*:\\s*(\\d+)\\s*$`, 'm'));
  return m ? Number(m[1]) : null;
}

// 指示書の必須欄とチェック項目を検査する（読み取りのみ・書き込みしない）
export function checkInstruction(instructionPath) {
  const errors = [];
  if (!instructionPath || !isAbsolute(instructionPath)) errors.push('指示書の絶対パスが必要です');
  if (errors.length) return { ok: false, errors, fields: null, sha256: null };
  if (!existsSync(instructionPath)) {
    return { ok: false, errors: [`指示書がありません: ${instructionPath}`], fields: null, sha256: null };
  }
  if (!statSync(instructionPath).isFile()) {
    return { ok: false, errors: [`指示書が通常ファイルではありません: ${instructionPath}`], fields: null, sha256: null };
  }
  const text = readFileSync(instructionPath, 'utf8');
  const estimate = readNumberField(text, 'cost_estimate_yen');
  const cap = readNumberField(text, 'cost_cap_yen');
  const rounds = readNumberField(text, 'review_rounds');
  if (estimate === null || estimate <= 0) errors.push('cost_estimate_yen（見積り円）が必要です');
  if (cap === null || cap <= 0) errors.push('cost_cap_yen（上限円）が必要です');
  if (estimate !== null && cap !== null && cap < estimate * 3) {
    errors.push(`cost_cap_yen は見積りの3倍以上が必要です（見積り${estimate} / 上限${cap}）`);
  }
  if (rounds === null || rounds < 1 || rounds > 2) errors.push('review_rounds は 1〜2 が必要です');
  const checklist = (text.match(/^□/gm) || []).length;
  if (checklist < CHECKLIST_MIN) {
    errors.push(`9項目チェック（□行）が ${CHECKLIST_MIN} 件以上必要です（実測 ${checklist} 件）`);
  }
  return {
    ok: errors.length === 0,
    errors,
    fields: { costEstimateYen: estimate, costCapYen: cap, reviewRounds: rounds, checklistCount: checklist },
    sha256: sha256Text(text),
  };
}

function resolveRepo(repoPath) {
  if (!repoPath || !isAbsolute(repoPath)) return { error: 'リポジトリの絶対パスが必要です' };
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) return { error: `リポジトリがありません: ${repoPath}` };
  if (!existsSync(join(repoPath, '.ai'))) return { error: `.ai がありません（レーン未設定の可能性）: ${repoPath}` };
  return { root: repoPath };
}

function recordPath(root, dirParts, id) {
  return join(root, ...dirParts, `${id}.json`);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// 副社長→統括: 検査を通った指示書を対象レーンの受信箱へ配達する
export function dispatchInstruction({ instruction, repo, dispatchedBy = 'dsh-vp', now = new Date().toISOString(), notify }) {
  const check = checkInstruction(instruction);
  if (!check.ok) return { ok: false, errors: check.errors };
  const target = resolveRepo(repo);
  if (target.error) return { ok: false, errors: [target.error] };
  const id = check.sha256;
  const path = recordPath(target.root, INBOX_DIR, id);
  if (existsSync(path)) {
    return { ok: true, duplicate: true, id, path, fields: check.fields };
  }
  const record = {
    schema: 'ai-dev-tool/org-dispatch@1',
    id,
    instructionPath: resolve(instruction),
    instructionSha256: check.sha256,
    dispatchedBy,
    dispatchedAt: now,
    cost: { estimateYen: check.fields.costEstimateYen, capYen: check.fields.costCapYen },
    reviewRounds: check.fields.reviewRounds,
    checklistCount: check.fields.checklistCount,
    status: 'dispatched',
  };
  if (notify) {
    record.notified = notifyLane({ repo: target.root, id, instruction: record.instructionPath, ...notify });
  }
  writeJson(path, record);
  return { ok: true, id, path, record };
}

// 統括→部隊: 受領を記録（受信箱の指示書shaを固定したまま状態だけ進める）
export function acceptInstruction({ repo, id, acceptedBy = 'lane-supervisor', now = new Date().toISOString() }) {
  const target = resolveRepo(repo);
  if (target.error) return { ok: false, errors: [target.error] };
  const inbox = recordPath(target.root, INBOX_DIR, id);
  if (!existsSync(inbox)) return { ok: false, errors: [`受信箱に指示書がありません: ${id}`] };
  const record = readJson(inbox);
  if (record.instructionSha256 !== id) return { ok: false, errors: ['受信箱の指示書sha256が id と一致しません'] };
  record.status = 'accepted';
  record.acceptedBy = acceptedBy;
  record.acceptedAt = now;
  writeJson(inbox, record);
  return { ok: true, id, path: inbox, record };
}

// 統括検収: 指示書shaとチェック項目数に紐づけた結果だけを記録する（未確認の合格を拒否）
export function verifyInstruction({ repo, id, verdict, note, verifiedBy = 'lane-supervisor', now = new Date().toISOString() }) {
  const errors = [];
  const target = resolveRepo(repo);
  if (target.error) errors.push(target.error);
  if (!['pass', 'fail'].includes(String(verdict || ''))) errors.push('verdict は pass か fail が必要です');
  if (!note || !String(note).trim()) errors.push('note（根拠）が必要です');
  const inbox = target.root ? recordPath(target.root, INBOX_DIR, id) : null;
  if (inbox && !existsSync(inbox)) errors.push(`受信箱に指示書がありません: ${id}`);
  if (errors.length) return { ok: false, errors };
  const dispatched = readJson(inbox);
  const record = {
    schema: 'ai-dev-tool/org-verify@1',
    id,
    instructionSha256: dispatched.instructionSha256,
    checklistCount: dispatched.checklistCount,
    verdict,
    note: String(note).trim(),
    verifiedBy,
    verifiedAt: now,
  };
  const path = recordPath(target.root, OUTBOX_DIR, id);
  writeJson(path, record);
  return { ok: true, id, path, record };
}

// 統括→副社長: 検収結果を副社長側の台帳へ戻す（受信箱のshaと一致する結果だけ受理）
export function collectResult({ repo, id, ledgerDir, now = new Date().toISOString() }) {
  const target = resolveRepo(repo);
  if (target.error) return { ok: false, errors: [target.error] };
  if (!ledgerDir || !isAbsolute(ledgerDir)) return { ok: false, errors: ['台帳の絶対パス（--ledger）が必要です'] };
  const outbox = recordPath(target.root, OUTBOX_DIR, id);
  const inbox = recordPath(target.root, INBOX_DIR, id);
  const errors = [];
  if (!existsSync(outbox)) errors.push(`検収結果がありません: ${id}`);
  if (!existsSync(inbox)) errors.push(`受信箱に指示書がありません: ${id}`);
  if (errors.length) return { ok: false, errors };
  const verified = readJson(outbox);
  const dispatched = readJson(inbox);
  if (verified.instructionSha256 !== dispatched.instructionSha256 || verified.id !== id) {
    return { ok: false, errors: ['検収結果と受信箱の指示書sha256が一致しません'] };
  }
  // 台帳はレーンごとに1件（同じ指示書idを複数レーンへ配るため、idだけでは衝突する）
  const ledgerPath = join(ledgerDir, `${id}__${basename(target.root)}.json`);
  const entry = {
    schema: 'ai-dev-tool/org-return@1',
    id,
    repo: target.root,
    instructionPath: dispatched.instructionPath,
    instructionSha256: dispatched.instructionSha256,
    cost: dispatched.cost,
    reviewRounds: dispatched.reviewRounds,
    checklistCount: dispatched.checklistCount,
    verdict: verified.verdict,
    note: verified.note,
    verifiedBy: verified.verifiedBy,
    verifiedAt: verified.verifiedAt,
    collectedAt: now,
  };
  writeJson(ledgerPath, entry);
  return { ok: true, id, path: ledgerPath, entry };
}

export function statusOf({ repo }) {
  const target = resolveRepo(repo);
  if (target.error) return { ok: false, errors: [target.error] };
  const list = (dirParts) => {
    const dir = join(target.root, ...dirParts);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, ''));
  };
  return { ok: true, repo: target.root, inbox: list(INBOX_DIR), outbox: list(OUTBOX_DIR) };
}

export const NOTIFY_LOG = ['.ai', 'org-notify.log'];
export const AGMSG_SEND = ['.agents', 'skills', 'agmsg', 'scripts', 'send.sh'];
// agmsgの実DBは skill 配下の db/messages.db（実測 2026-10-14）
export const AGMSG_DB = ['.agents', 'skills', 'agmsg', 'db', 'messages.db'];

// agmsgが実際に格納したかを数える（表が無い/読めない場合は null＝未確認）
function agmsgMessageCount(dbPath) {
  try {
    const out = execFileSync('sqlite3', [dbPath, 'select count(*) from messages;'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function appendNotifyLog(root, line) {
  const path = join(root, ...NOTIFY_LOG);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`, 'utf8');
  return path;
}

// 配達を止めずに相手を起こす。agmsgが使えれば送り、使えなければ通知ログだけ残す。
export function notifyLane({ repo, id, instruction, team, from, to, sendScript, countMessages }) {
  const target = resolveRepo(repo);
  if (target.error) return { via: 'none', ok: false, detail: target.error };
  const script = sendScript || join(homedir(), ...AGMSG_SEND);
  const logLine = JSON.stringify({ at: new Date().toISOString(), event: 'dispatched', id, to: to || null });
  appendNotifyLog(target.root, logLine);
  if (!team || !from || !to) return { via: 'log', ok: true, confirmed: false, detail: '通知先(team/from/to)未指定のため記録のみ' };
  if (!existsSync(script)) return { via: 'log', ok: true, confirmed: false, detail: `agmsg送信scriptが無いため記録のみ: ${script}` };
  const dbPath = join(homedir(), ...AGMSG_DB);
  const count = countMessages || agmsgMessageCount;
  const before = count(dbPath);
  try {
    execFileSync('bash', [script, team, from, to, `指示書を配達しました id=${id} path=${instruction}`], { stdio: 'pipe', timeout: 30000 });
    const after = count(dbPath);
    const confirmed = before !== null && after !== null && after > before;
    if (confirmed) {
      appendNotifyLog(target.root, JSON.stringify({ at: new Date().toISOString(), event: 'notified', id, via: 'agmsg', to }));
      return { via: 'agmsg', ok: true, confirmed: true, detail: `${team}/${from}->${to}` };
    }
    // 送信コマンドが0で終わっても、格納を確認できなければ「記録のみ」として扱う（未確認を成功にしない）
    const detail = `agmsgの格納を確認できないため記録のみ（終了コードは成功 / before=${before} after=${after}）`;
    appendNotifyLog(target.root, JSON.stringify({ at: new Date().toISOString(), event: 'notify_unconfirmed', id, detail }));
    return { via: 'log', ok: true, confirmed: false, detail };
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 200);
    appendNotifyLog(target.root, JSON.stringify({ at: new Date().toISOString(), event: 'notify_failed', id, detail }));
    return { via: 'log', ok: true, confirmed: false, detail: `agmsg送信に失敗したため記録のみ: ${detail}` };
  }
}

// 受信箱を待ち受ける（届いた時点で返す／時間切れは失敗として返す）
export async function waitForInstruction({ repo, id, timeoutMs = 300000, intervalMs = 1000, sleep }) {
  const target = resolveRepo(repo);
  if (target.error) return { ok: false, errors: [target.error] };
  const path = recordPath(target.root, INBOX_DIR, id);
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  for (;;) {
    if (existsSync(path)) {
      return { ok: true, id, path, waitedMs: Date.now() - started, record: readJson(path) };
    }
    if (Date.now() - started >= timeoutMs) {
      return { ok: false, errors: [`待受が時間切れになりました（${timeoutMs}ms）: ${id}`], waitedMs: Date.now() - started };
    }
    await wait(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - started))));
  }
}

// 受信箱と検収結果を突き合わせて一覧にする（人が未処理を見つけられるようにする）
export function listInbox({ repo }) {
  const target = resolveRepo(repo);
  if (target.error) return { ok: false, errors: [target.error] };
  const inboxDir = join(target.root, ...INBOX_DIR);
  const ids = existsSync(inboxDir) ? readdirSync(inboxDir).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')) : [];
  const items = ids.map((id) => {
    const dispatched = readJson(recordPath(target.root, INBOX_DIR, id));
    const outbox = recordPath(target.root, OUTBOX_DIR, id);
    const verified = existsSync(outbox) ? readJson(outbox) : null;
    return {
      id,
      status: verified ? 'verified' : dispatched.status || 'dispatched',
      verdict: verified ? verified.verdict : null,
      note: verified ? verified.note : null,
      dispatchedAt: dispatched.dispatchedAt || null,
      instructionPath: dispatched.instructionPath || null,
      checklistCount: dispatched.checklistCount ?? null,
    };
  });
  return { ok: true, repo: target.root, items, unprocessed: items.filter((i) => i.status !== 'verified').length };
}
