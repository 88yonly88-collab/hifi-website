/**
 * four-stage-check.mjs — 完了を機械で確認する（fail-closed）
 *
 * 2つのモードを持つ。既定は既存の「完了の4段」モード（後方互換のため挙動を変えない）。
 *
 * ■ モード1: 4段モード（既定。--mode four-stage / 指定なし）
 * 正本ルール: templates/prompts/agent-rules.md の「完了の4段」（2026-10-26 利用者指示）
 *   1. 設置        … 作業側と本番の sha256 一致＋設置台帳と設置ログへの記録
 *   2. 安いAIレビュー … 安いモデルのレビュー結果ファイル最終行の INSTALL_REVIEW=OK
 *   3. 本番同等実行  … 実際と同じ実行コマンドの終了コード0と出力末尾
 *   4. 品質確認      … 次工程へ渡す生成物の実在＋品質確認コマンドの終了コード0
 *   5. 記録          … 全段の証拠を JSON レポートへ保存（保存できなければ不合格）
 *
 *   使い方:
 *     node scripts/four-stage-check.mjs \
 *       --task <ID> \
 *       --source <作業側のファイル> --prod <本番のファイル> \
 *       --cheap-review <安いAIモデルのレビュー結果ファイル> \
 *       --exec-cmd "<本番同等の実行コマンド>" \
 *       --artifact <生成物/次工程へ渡すファイル> \
 *       --quality-cmd "<品質確認コマンド>" \
 *       --report <出力JSON> \
 *       [--ledger <installs.json>] [--install-log <install-log.tsv>] \
 *       [--offline <fixture dir>] [--timeout-ms <ミリ秒>]
 *
 *   出力（1行だけ）:
 *     合格: FOUR_STAGE=OK task=<ID> stages=5
 *     不合格: FOUR_STAGE=NG task=<ID> ng=<stage,...> reason=<stage:code|stage:code>
 *     stage は install / review / exec / quality / record のいずれか。
 *     引数不備だけは ng=args、理由は reason=args:missing_<name> 等。
 *     終了コード: 合格 0 / 不合格 1 / --help 0。
 *
 * ■ モード2: 3条件モード（--mode completion3。T2-COMPLETION-3-20261027 で追加）
 * 正本: 2026-10-27 設計書 notes/hybrid-ops-20261027/WORKFLOW.md（完了3条件）
 * 証拠一式（実行ログ・生成物・引継ぎ記録）を読み、次の3条件を機械で判定する。
 *   ①指示書ゴール達成（goal）  : --exec-log の各行（受入表1行=1レコード）が実在し、
 *                                確認コマンドの exit が期待値と一致する。
 *   ②生成物の安定品質（stable）: --quality-cmd を同一入力で2回実行し、両方 exit 0 かつ
 *                                --artifact の sha256 が2回一致する。
 *   ③次工程への円滑引継ぎ（handoff）: --handoff に「次工程の担当・入力パス・再開手順」の
 *                                3項目が記載されている（空・プレースホルダは不合格）。
 *   3条件すべて揃えば COMPLETION_3=OK exit 0、1つでも欠ければ
 *   COMPLETION_3=NG ng=<条件,...> reason=<条件:code|...> exit 1（fail-closed）。
 *   引数不備（必須引数なし・不正引数・--offline 併用）は exit 2（4段モードは従来どおり exit 1）。
 *
 *   使い方:
 *     node scripts/four-stage-check.mjs --mode completion3 \
 *       --task <ID> --exec-log <file> --artifact <path> --handoff <file> \
 *       --quality-cmd "<cmd>" --report <json> [--timeout-ms <ミリ秒>]
 *
 *   証拠形式（--exec-log は JSON Lines。空行と # 始まりの行は無視する）:
 *     {"row":"受入表の行ID","cmd":"確認コマンド","expected_exit":0,"exit":0,"log":"任意:生ログのパス"}
 *     - row/cmd は空でない文字列、expected_exit/exit は整数で必須。exit は expected_exit と一致必須。
 *     - log を書いた場合は実在する空でないファイルでなければ不合格。
 *     - 受入表の全行を網羅しているかは、この証拠を作る呼び出し側の責任（機械では指示書本文と照合しない）。
 *   --handoff は Markdown/テキスト。行頭ラベル形式（`- 次工程の担当: 部長`）または
 *     見出し形式（`## 次工程の担当` の次行に値）のどちらでもよい。
 *     ラベルは 次工程の担当 / 入力パス / 再開手順（入力ファイル・再開方法・次工程担当も可）。
 *   --quality-cmd は2回実行される（副作用があるコマンドは使わない。fixture/検証専用）。
 *
 * 安全:
 *   - ネットワーク・外部送信はしない（http/https/net/tls/dns を import しない）。
 *   - 秘密値は読まない。コマンド文字列と出力末尾は token/password/api_key 等の
 *     既知の形だけ伏字にする。
 *   - --offline <dir> を渡すと、ledger/install-log/exec/quality を fixture 内へ差し替える。
 *     <dir>/installs.json・<dir>/install-log.tsv・<dir>/exec.sh・<dir>/quality.sh を使う。
 *     試験専用（本番では使わない）。
 *
 * 限界（未確認にすること）:
 *   - --cheap-review のファイルが「実装より安いモデルのレビュー」であることまでは機械で判定できない。
 *     最終行の INSTALL_REVIEW=OK という受領証の有無だけを確認する。
 *   - 実行コマンドの妥当性（本当に本番と同じ道か）は呼び出し側が保証する。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const VERSION = '1.1.0';
const TOOL = 'four-stage-check';
const MODES = new Set(['four-stage', 'completion3']);
const DEFAULT_LEDGER = '/home/dev/projects/chat/vice-president/notes/audit/installs.json';
const DEFAULT_INSTALL_LOG = '/home/dev/dsh-vps/gate/install-log.tsv';
const DEFAULT_TIMEOUT_MS = 120_000;
const TAIL_CHARS = 2000;
const MAX_BUFFER = 10 * 1024 * 1024;
const STAGE_ORDER = ['install', 'review', 'exec', 'quality', 'record'];
const STAGE_LABEL = {
  install: '段1 設置',
  review: '段2 安いAIレビュー',
  exec: '段3 本番同等実行',
  quality: '段4 品質確認',
  record: '段5 記録',
  args: '引数',
};
/** 3条件モードの判定順（この順で ng= と reason= を組み立てる）。 */
const CONDITION_ORDER = ['goal', 'stable', 'handoff'];
const CONDITION_LABEL = {
  goal: '①指示書ゴール達成',
  stable: '②生成物の安定品質',
  handoff: '③次工程への円滑引継ぎ',
  record: '記録',
  args: '引数',
};
const VALUE_OPTIONS = new Set([
  'mode',
  'task',
  'source',
  'prod',
  'cheap-review',
  'exec-cmd',
  'exec-log',
  'artifact',
  'handoff',
  'quality-cmd',
  'report',
  'ledger',
  'install-log',
  'offline',
  'timeout-ms',
]);

/** 使い方に載せる説明。 */
function usage() {
  return [
    'four-stage-check — 完了を機械で確認する（fail-closed）',
    '',
    'モード:',
    '  --mode four-stage  （既定）完了の4段（設置・安いAIレビュー・本番同等実行・品質確認・記録）',
    '  --mode completion3 完了3条件（指示書ゴール達成・生成物の安定品質・次工程への円滑引継ぎ）',
    '',
    '使い方（4段モード・既定）:',
    '  node scripts/four-stage-check.mjs \\',
    '    --task <ID> \\',
    '    --source <作業側のファイル> --prod <本番のファイル> \\',
    '    --cheap-review <安いAIモデルのレビュー結果ファイル> \\',
    '    --exec-cmd "<本番同等の実行コマンド>" \\',
    '    --artifact <生成物/次工程へ渡すファイル> \\',
    '    --quality-cmd "<品質確認コマンド>" \\',
    '    --report <出力JSON> \\',
    '    [--ledger <installs.json>] [--install-log <install-log.tsv>] \\',
    '    [--offline <fixture dir>] [--timeout-ms <ミリ秒>]',
    '',
    '使い方（3条件モード）:',
    '  node scripts/four-stage-check.mjs --mode completion3 \\',
    '    --task <ID> --exec-log <file> --artifact <path> --handoff <file> \\',
    '    --quality-cmd "<cmd>" --report <json> [--timeout-ms <ミリ秒>]',
    '',
    '段と判定（4段モード）:',
    '  段1 設置        : source と prod の sha256 一致＋ledger に source/target の組＋install-log に設置行',
    '  段2 安いAIレビュー: --cheap-review の最終行が INSTALL_REVIEW=OK（無ければ不合格）',
    '  段3 本番同等実行  : --exec-cmd の終了コード0',
    '  段4 品質確認      : --artifact の実在＋--quality-cmd の終了コード0',
    '  段5 記録          : --report へ全段の証拠をJSON保存（保存できなければ不合格）',
    '',
    '  出力: FOUR_STAGE=OK task=<ID> stages=5',
    '        FOUR_STAGE=NG task=<ID> ng=<stage,...> reason=<stage:code|...>',
    '  終了コード: 合格 0 / 不合格 1',
    '',
    '条件と判定（3条件モード）:',
    '  ①指示書ゴール達成（goal）  : --exec-log の各行の exit が expected_exit と一致し、',
    '                              row/cmd が埋まっている（log を書いた場合は実在する生ログ）',
    '  ②生成物の安定品質（stable）: --quality-cmd を2回実行し、両方 exit 0・--artifact の sha256 が2回一致',
    '  ③次工程への円滑引継ぎ（handoff）: --handoff に 次工程の担当・入力パス・再開手順 の3項目',
    '',
    '  出力: COMPLETION_3=OK task=<ID> conditions=3',
    '        COMPLETION_3=NG ng=<goal|stable|handoff[,...]> reason=<条件:code|...> task=<ID>',
    '  終了コード: 合格 0 / 証拠の欠落・不合格 1 / 引数不備 2',
    '',
    '--exec-log の形式（JSON Lines。空行と # 始まりの行は無視）:',
    '  {"row":"①初回・重複","cmd":"node --test test/x.test.mjs","expected_exit":0,"exit":0}',
    '  {"row":"②途中失敗","cmd":"node scripts/x.mjs","expected_exit":1,"exit":1,"log":"logs/02.log"}',
    '  - row と cmd は空でない文字列、expected_exit と exit は整数で必須。exit != expected_exit は不合格。',
    '  - 受入表の全行を網羅しているかは、この証拠を作る呼び出し側の責任（機械では指示書本文と照合しない）。',
    '',
    '--handoff の形式（Markdown/テキスト。行頭ラベル形式か見出し形式）:',
    '  - 次工程の担当: 部長（dsh-vp）',
    '  - 入力パス: /home/dev/projects/ai-dev-tool/scripts/four-stage-check.mjs',
    '  - 再開手順: node --test test/four-stage-check.test.mjs を実行して exit 0 を確認する',
    '  ## 再開手順 のように見出しにして、次の行へ値を書いてもよい（次工程担当・入力ファイル・再開方法も可）。',
    '',
    '--offline <dir> の fixture 構成（4段モードの試験用。3条件モードでは使わない）:',
    '  <dir>/installs.json   {"installs":[{"source":"...","target":"...", ...}]}',
    '  <dir>/install-log.tsv 時刻<TAB>レーン<TAB>セッション<TAB>source<TAB>target<TAB>sha<TAB>sha',
    '  <dir>/exec.sh         bash で実行する本番同等実行の代役',
    '  <dir>/quality.sh      bash で実行する品質確認の代役',
  ].join('\n');
}

/** 引数不備を表す例外（fail-closed の NG 行にする）。 */
class ArgError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ArgError';
    this.code = code;
  }
}

/** その他の想定内の不合格理由。 */
class FailError extends Error {
  constructor(code) {
    super(code);
    this.name = 'FailError';
    this.code = code;
  }
}

/** --opt value / --opt=value の両方を受ける。 */
function parseArgs(argv) {
  const opts = {};
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (!token.startsWith('--')) throw new ArgError(`unexpected_argument:${token}`);
    let name = token.slice(2);
    let value;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    } else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new ArgError(`missing_value:${name}`);
      i += 1;
    }
    if (!VALUE_OPTIONS.has(name)) throw new ArgError(`unknown_option:${name}`);
    if (opts[name] !== undefined) throw new ArgError(`duplicate_option:${name}`);
    opts[name] = value;
  }
  if (help) return { help: true };
  if (opts.mode !== undefined && !MODES.has(opts.mode)) throw new ArgError('bad_mode');
  if (opts['timeout-ms'] !== undefined) {
    const timeout = Number(opts['timeout-ms']);
    if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout <= 0) {
      throw new ArgError('bad_timeout_ms');
    }
    opts.timeoutMs = timeout;
  } else {
    opts.timeoutMs = DEFAULT_TIMEOUT_MS;
  }
  return opts;
}

/**
 * 引数不備でも「3条件モードを指定しようとしたか」を判定する（exit コードの振り分け用）。
 * 4段モードの引数不備は後方互換のため exit 1、3条件モードは受入表の指定どおり exit 2 にする。
 */
function intendedModeFromArgv(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--mode' && argv[i + 1] === 'completion3') return 'completion3';
    if (token.startsWith('--mode=') && token.slice('--mode='.length) === 'completion3') return 'completion3';
  }
  return 'four-stage';
}

/** 絶対パスへ正規化する（台帳・設置ログの組合わせ用）。 */
function normPath(p) {
  return resolve(String(p));
}

/** sha256 を返す。 */
function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** stat を安全に取る（無ければ null）。 */
function safeStat(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** テキストを安全に読む（無ければ exists=false）。 */
function readTextFile(p) {
  if (!p) return { exists: false, text: null, error: null };
  try {
    return { exists: true, text: readFileSync(p, 'utf8'), error: null };
  } catch (error) {
    const missing = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
    return { exists: !missing, text: null, error: missing ? null : String(error.code || error.message) };
  }
}

/** JSON を安全に読む。 */
function readJsonFile(p) {
  const read = readTextFile(p);
  if (!read.exists) return { exists: false, data: null, error: null };
  if (read.error) return { exists: true, data: null, error: read.error };
  try {
    return { exists: true, data: JSON.parse(read.text), error: null };
  } catch {
    return { exists: true, data: null, error: 'invalid_json' };
  }
}

/** 出力末尾を採取する（長すぎるときは末尾だけ残す）。 */
function tailText(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (text.length <= TAIL_CHARS) return text;
  return `[...先頭${text.length - TAIL_CHARS}文字を省略...]\n${text.slice(-TAIL_CHARS)}`;
}

const SECRET_PATTERNS = [
  /((?:--?)?(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization)\s*[=:]\s*)([^\s'"]+)/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
];

/** 秘密値らしき部分だけ伏字にする（証拠は残す）。 */
function redact(text) {
  let out = text === null || text === undefined ? '' : String(text);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (_all, prefix) => `${prefix}<redacted>`);
  return out;
}

/** 1行に収まる機械可読なトークンへ整える。 */
function token(value, fallback = '-') {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = text.replace(/[^A-Za-z0-9._:@/+=-]/g, '_').slice(0, 200);
  return safe === '' ? fallback : safe;
}

/** shell 用に単一引用符でくくる。 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** コマンドを実行し、終了コード・出力末尾・実行時刻を採取する。 */
function runCommand(command, timeoutMs) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let result;
  try {
    result = spawnSync(command, {
      shell: true,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      env: process.env,
    });
  } catch (error) {
    return {
      command,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: String(error && error.message ? error.message : error),
      stdoutTail: '',
      stderrTail: '',
      stdoutLines: 0,
      stderrLines: 0,
    };
  }
  const errorCode = result.error && result.error.code ? String(result.error.code) : null;
  const timedOut = errorCode === 'ETIMEDOUT';
  const stdout = result.stdout === null || result.stdout === undefined ? '' : String(result.stdout);
  const stderr = result.stderr === null || result.stderr === undefined ? '' : String(result.stderr);
  return {
    command,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal || null,
    timedOut,
    spawnError: result.error && !timedOut ? String(result.error.message || errorCode) : null,
    stdoutTail: redact(tailText(stdout)),
    stderrTail: redact(tailText(stderr)),
    stdoutLines: stdout === '' ? 0 : stdout.split('\n').length - (stdout.endsWith('\n') ? 1 : 0),
    stderrLines: stderr === '' ? 0 : stderr.split('\n').length - (stderr.endsWith('\n') ? 1 : 0),
  };
}

/** --offline <dir> のとき、ledger/install-log/exec/quality を fixture へ差し替える。 */
function applyOffline(opts) {
  if (opts.offline === undefined) {
    return {
      opts,
      overrides: { ledger: false, installLog: false, execCmd: false, qualityCmd: false },
      offlinePaths: null,
    };
  }
  if (opts.offline === '') throw new ArgError('offline_dir_missing');
  const dir = resolve(opts.offline);
  const stat = safeStat(dir);
  if (!stat || !stat.isDirectory()) throw new ArgError('offline_dir_missing');
  const execScript = join(dir, 'exec.sh');
  const qualityScript = join(dir, 'quality.sh');
  return {
    opts: {
      ...opts,
      ledger: join(dir, 'installs.json'),
      'install-log': join(dir, 'install-log.tsv'),
      execCmd: `bash ${shellQuote(execScript)}`,
      qualityCmd: `bash ${shellQuote(qualityScript)}`,
    },
    overrides: { ledger: true, installLog: true, execCmd: true, qualityCmd: true },
    offlinePaths: { dir, execScript, qualityScript },
  };
}

/** 段1 設置: sha一致・台帳の組・設置ログの行。 */
function checkInstall(opts) {
  const reasons = [];
  const evidence = {
    source: opts.source ? normPath(opts.source) : null,
    prod: opts.prod ? normPath(opts.prod) : null,
    ledger: opts.ledger ? normPath(opts.ledger) : null,
    installLog: opts['install-log'] ? normPath(opts['install-log']) : null,
    sourceSize: null,
    prodSize: null,
    sourceSha256: null,
    prodSha256: null,
    shaMatch: false,
    ledgerExists: false,
    ledgerEntry: null,
    installLogExists: false,
    installLogRows: 0,
    installLogRow: null,
  };

  for (const key of ['source', 'prod']) {
    const path = evidence[key];
    if (!path) {
      reasons.push(`${key}_arg_missing`);
      continue;
    }
    const stat = safeStat(path);
    if (!stat) {
      reasons.push(`${key}_missing`);
      continue;
    }
    if (!stat.isFile()) {
      reasons.push(`${key}_not_file`);
      continue;
    }
    evidence[`${key}Size`] = stat.size;
    if (stat.size === 0) reasons.push(`${key}_empty`);
    try {
      evidence[`${key}Sha256`] = sha256File(path);
    } catch {
      reasons.push(`${key}_unreadable`);
    }
  }
  evidence.shaMatch = Boolean(
    evidence.sourceSha256 && evidence.prodSha256 && evidence.sourceSha256 === evidence.prodSha256
  );
  if (evidence.sourceSha256 && evidence.prodSha256 && !evidence.shaMatch) reasons.push('sha_mismatch');

  const ledger = readJsonFile(evidence.ledger);
  evidence.ledgerExists = ledger.exists;
  if (!ledger.exists) reasons.push('ledger_missing');
  else if (ledger.error) reasons.push('ledger_unreadable');
  else {
    const installs = Array.isArray(ledger.data)
      ? ledger.data
      : ledger.data && Array.isArray(ledger.data.installs)
        ? ledger.data.installs
        : null;
    if (!installs) reasons.push('ledger_format');
    else {
      const entry = installs.find((item) => {
        if (!item || typeof item !== 'object') return false;
        if (typeof item.source !== 'string' || typeof item.target !== 'string') return false;
        return normPath(item.source) === evidence.source && normPath(item.target) === evidence.prod;
      });
      evidence.ledgerEntry = entry || null;
      if (!entry) reasons.push('ledger_entry_missing');
    }
  }

  const installLog = readTextFile(evidence.installLog);
  evidence.installLogExists = installLog.exists;
  if (!installLog.exists) reasons.push('install_log_missing');
  else if (installLog.error) reasons.push('install_log_unreadable');
  else {
    const rows = installLog.text
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    evidence.installLogRows = rows.length;
    const row = rows.find((line) => {
      const cols = line.split('\t');
      if (cols.length < 5) return false;
      return normPath(cols[3]) === evidence.source && normPath(cols[4]) === evidence.prod;
    });
    evidence.installLogRow = row || null;
    if (!row) reasons.push('install_log_entry_missing');
  }

  return { ok: reasons.length === 0, reasons, evidence };
}

/** 段2 安いAIレビュー: --cheap-review の最終行が INSTALL_REVIEW=OK。 */
function checkReview(opts) {
  const reasons = [];
  const evidence = {
    cheapReview: opts['cheap-review'] ? normPath(opts['cheap-review']) : null,
    exists: false,
    lastLine: null,
    ok: false,
  };
  if (!evidence.cheapReview) {
    reasons.push('arg_missing');
    return { ok: false, reasons, evidence };
  }
  const read = readTextFile(evidence.cheapReview);
  evidence.exists = read.exists;
  if (!read.exists) {
    reasons.push('file_missing');
    return { ok: false, reasons, evidence };
  }
  if (read.error) {
    reasons.push('file_unreadable');
    return { ok: false, reasons, evidence };
  }
  const lines = read.text
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trimEnd())
    .filter((line) => line.trim() !== '');
  evidence.lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
  evidence.ok = /^INSTALL_REVIEW=OK(?:\s|$)/.test(evidence.lastLine);
  if (!evidence.ok) reasons.push(evidence.lastLine === '' ? 'empty' : 'not_ok');
  return { ok: evidence.ok, reasons, evidence };
}

/** 段3 本番同等実行: --exec-cmd の終了コード0。 */
function checkExec(opts, offlinePaths) {
  const evidence = {
    source: opts.offline ? 'offline_fixture' : 'cli',
    command: redact(opts.execCmd || ''),
  };
  if (!opts.execCmd) return { ok: false, reasons: ['arg_missing'], evidence };
  if (offlinePaths && !existsSync(offlinePaths.execScript)) {
    return { ok: false, reasons: ['fixture_missing'], evidence };
  }
  const result = runCommand(opts.execCmd, opts.timeoutMs);
  Object.assign(evidence, result);
  const reasons = [];
  if (result.spawnError) reasons.push('spawn_error');
  if (result.timedOut) reasons.push('timeout');
  if (result.exitCode !== 0) reasons.push(`exit_${result.exitCode === null ? 'null' : result.exitCode}`);
  return { ok: reasons.length === 0, reasons, evidence };
}

/** 段4 品質確認: --artifact の実在＋--quality-cmd の終了コード0。 */
function checkQuality(opts, offlinePaths) {
  const reasons = [];
  const evidence = {
    artifact: opts.artifact ? normPath(opts.artifact) : null,
    artifactExists: false,
    artifactSize: null,
    source: opts.offline ? 'offline_fixture' : 'cli',
    command: redact(opts.qualityCmd || ''),
  };
  if (!evidence.artifact) reasons.push('artifact_arg_missing');
  else {
    const stat = safeStat(evidence.artifact);
    evidence.artifactExists = Boolean(stat);
    if (!stat) reasons.push('artifact_missing');
    else if (!stat.isFile()) reasons.push('artifact_not_file');
    else {
      evidence.artifactSize = stat.size;
      if (stat.size === 0) reasons.push('artifact_empty');
    }
  }
  if (!opts.qualityCmd) reasons.push('arg_missing');
  else if (offlinePaths && !existsSync(offlinePaths.qualityScript)) reasons.push('fixture_missing');
  else {
    const result = runCommand(opts.qualityCmd, opts.timeoutMs);
    Object.assign(evidence, result);
    if (result.spawnError) reasons.push('spawn_error');
    if (result.timedOut) reasons.push('timeout');
    if (result.exitCode !== 0) reasons.push(`exit_${result.exitCode === null ? 'null' : result.exitCode}`);
  }
  return { ok: reasons.length === 0, reasons, evidence };
}

/** NG 理由を `stage:code+code` の形にまとめる。 */
function buildReasons(failures) {
  return STAGE_ORDER.filter((stage) => failures[stage] && failures[stage].reasons.length > 0).map(
    (stage) => `${stage}:${failures[stage].reasons.map((reason) => token(reason)).join('+')}`
  );
}

/* ---------------------------------------------------------------------------
 * 3条件モード（completion3）
 * ------------------------------------------------------------------------- */

/** 3条件モードの NG 理由を `条件:code+code` の形にまとめる。 */
function buildConditionReasons(failures) {
  const order = [...CONDITION_ORDER, 'record'];
  return order
    .filter((condition) => failures[condition] && failures[condition].reasons.length > 0)
    .map(
      (condition) =>
        `${condition}:${failures[condition].reasons.map((reason) => token(reason)).join('+')}`
    );
}

/** 正規表現用のエスケープ。 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 引継ぎ記録の必須3項目（表示名と、行頭ラベルとして許す別名）。 */
const HANDOFF_ITEMS = [
  { key: 'owner', label: '次工程の担当', aliases: ['次工程の担当', '次工程担当'] },
  { key: 'inputPath', label: '入力パス', aliases: ['入力パス', '入力ファイル'] },
  { key: 'restart', label: '再開手順', aliases: ['再開手順', '再開方法'] },
];

/** 引継ぎの値を整える。空・プレースホルダ（TODO/未定/なし/- 等）は「未記載」として null。 */
function cleanHandoffValue(raw) {
  const value = String(raw === null || raw === undefined ? '' : raw)
    .replace(/^\s*(?:[-*+>]\s*)+/, '')
    .replace(/\s+$/, '')
    .trim();
  if (value === '') return null;
  if (/^(?:todo|tbd|未定|なし|n\/a|na|-+|—+|…+|\.{2,})$/i.test(value)) return null;
  return value;
}

/**
 * 引継ぎ記録から1項目の値を探す。
 * `- 次工程の担当: 部長`（行頭ラベル）と、`## 次工程の担当` の次行に値（見出し）の両方を受ける。
 */
function findHandoffValue(lines, item) {
  const aliasPattern = item.aliases.map(escapeRegExp).join('|');
  const sameLine = new RegExp(
    `^\\s*(?:[-*+>]\\s*)*(?:#{1,6}\\s*)?(?:${aliasPattern})\\s*[:：]\\s*(.*)$`
  );
  const standalone = new RegExp(
    `^\\s*(?:[-*+>]\\s*)*(?:#{1,6}\\s*)?(?:${aliasPattern})\\s*[:：]?\\s*$`
  );
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const matched = line.match(sameLine);
    if (matched) {
      const value = cleanHandoffValue(matched[1]);
      if (value) return value;
    }
    if (standalone.test(line)) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() === '') continue;
        const value = cleanHandoffValue(lines[j]);
        if (value) return value;
        break;
      }
    }
  }
  return null;
}

/**
 * 条件① 指示書ゴール達成: --exec-log（JSON Lines）の各行が実在し、exit が期待値と一致する。
 * 受入表1行 = 1レコード。全行の網羅性は呼び出し側の責任（限界としてレポートに残す）。
 */
function checkGoal(execLogPath) {
  const reasons = [];
  const evidence = {
    execLog: execLogPath ? normPath(execLogPath) : null,
    exists: false,
    size: null,
    rows: 0,
    rowResults: [],
  };
  if (!evidence.execLog) return { ok: false, reasons: ['arg_missing'], evidence };
  const stat = safeStat(evidence.execLog);
  if (!stat) return { ok: false, reasons: ['file_missing'], evidence };
  evidence.exists = true;
  if (!stat.isFile()) return { ok: false, reasons: ['not_file'], evidence };
  evidence.size = stat.size;
  if (stat.size === 0) return { ok: false, reasons: ['empty'], evidence };

  const read = readTextFile(evidence.execLog);
  if (read.error) return { ok: false, reasons: ['file_unreadable'], evidence };
  const lines = read.text.split('\n').map((line) => line.replace(/\r$/, ''));
  let dataLines = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    dataLines += 1;
    const no = dataLines;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      reasons.push(`invalid_json_line_${no}`);
      continue;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      reasons.push(`invalid_record_line_${no}`);
      continue;
    }
    const rowId = typeof record.row === 'string' ? record.row.trim() : '';
    const command = typeof record.cmd === 'string' ? record.cmd.trim() : '';
    const expectedExit = Number.isInteger(record.expected_exit) ? record.expected_exit : null;
    const exit = Number.isInteger(record.exit) ? record.exit : null;
    const reasonsBefore = reasons.length;
    if (!rowId) reasons.push(`row_missing_line_${no}`);
    if (!command) reasons.push(`cmd_missing_line_${no}`);
    if (expectedExit === null) reasons.push(`expected_exit_invalid_line_${no}`);
    if (exit === null) reasons.push(`exit_invalid_line_${no}`);
    if (expectedExit !== null && exit !== null && exit !== expectedExit) {
      reasons.push(`exit_mismatch_line_${no}`);
    }
    let rawLogPath = null;
    let rawLogOk = null;
    if (record.log !== undefined && record.log !== null) {
      if (typeof record.log !== 'string' || record.log.trim() === '') {
        reasons.push(`log_path_invalid_line_${no}`);
        rawLogOk = false;
      } else {
        rawLogPath = isAbsolute(record.log)
          ? resolve(record.log)
          : resolve(dirname(evidence.execLog), record.log);
        const logStat = safeStat(rawLogPath);
        if (!logStat) {
          reasons.push(`log_missing_line_${no}`);
          rawLogOk = false;
        } else if (!logStat.isFile() || logStat.size === 0) {
          reasons.push(`log_empty_line_${no}`);
          rawLogOk = false;
        } else {
          rawLogOk = true;
        }
      }
    }
    evidence.rowResults.push({
      row: rowId || null,
      cmd: command ? redact(command).slice(0, 200) : null,
      expectedExit,
      exit,
      log: rawLogPath,
      logExists: rawLogOk,
      ok: reasons.length === reasonsBefore,
    });
  }
  evidence.rows = dataLines;
  if (dataLines === 0) reasons.push('no_rows');
  return { ok: reasons.length === 0, reasons, evidence };
}

/**
 * 条件② 生成物の安定品質: --quality-cmd を同一入力で2回実行し、両方 exit 0 かつ
 * --artifact の sha256 が2回一致することを確認する。
 */
function checkStable(artifactPath, qualityCmd, timeoutMs) {
  const reasons = [];
  const evidence = {
    artifact: artifactPath ? normPath(artifactPath) : null,
    command: redact(qualityCmd || ''),
    existsBefore: false,
    sizeBefore: null,
    sha256Before: null,
    runs: [],
    sha256First: null,
    sha256Second: null,
    shaMatch: false,
  };
  if (!evidence.artifact) reasons.push('artifact_arg_missing');
  else {
    const stat = safeStat(evidence.artifact);
    evidence.existsBefore = Boolean(stat);
    if (!stat) reasons.push('artifact_missing');
    else if (!stat.isFile()) reasons.push('artifact_not_file');
    else {
      evidence.sizeBefore = stat.size;
      if (stat.size === 0) reasons.push('artifact_empty');
      try {
        evidence.sha256Before = sha256File(evidence.artifact);
      } catch {
        reasons.push('artifact_unreadable');
      }
    }
  }
  if (!qualityCmd) reasons.push('arg_missing');
  // 生成物・コマンドのどちらかが欠けているときは実行しない（推測で2回実行しない）。
  if (reasons.length > 0) return { ok: false, reasons, evidence };

  for (let run = 1; run <= 2; run += 1) {
    const result = runCommand(qualityCmd, timeoutMs);
    const afterStat = safeStat(evidence.artifact);
    const entry = {
      run,
      ...result,
      artifactExists: Boolean(afterStat),
      artifactSize: afterStat ? afterStat.size : null,
      sha256: null,
    };
    if (!afterStat) reasons.push(`artifact_missing_run${run}`);
    else if (!afterStat.isFile()) reasons.push(`artifact_not_file_run${run}`);
    else {
      if (afterStat.size === 0) reasons.push(`artifact_empty_run${run}`);
      try {
        entry.sha256 = sha256File(evidence.artifact);
      } catch {
        reasons.push(`artifact_unreadable_run${run}`);
      }
    }
    if (result.spawnError) reasons.push(`spawn_error_run${run}`);
    if (result.timedOut) reasons.push(`timeout_run${run}`);
    if (result.exitCode !== 0) {
      reasons.push(`exit_${result.exitCode === null ? 'null' : result.exitCode}_run${run}`);
    }
    evidence.runs.push(entry);
  }
  evidence.sha256First = evidence.runs[0].sha256;
  evidence.sha256Second = evidence.runs[1].sha256;
  evidence.shaMatch = Boolean(
    evidence.sha256First && evidence.sha256Second && evidence.sha256First === evidence.sha256Second
  );
  if (evidence.sha256First && evidence.sha256Second && !evidence.shaMatch) {
    reasons.push('sha_mismatch');
  }
  return { ok: reasons.length === 0, reasons, evidence };
}

/**
 * 条件③ 次工程への円滑引継ぎ: --handoff に「次工程の担当・入力パス・再開手順」が
 * 記載されていること。空・プレースホルダ・欠落は不合格。
 */
function checkHandoff(handoffPath) {
  const reasons = [];
  const evidence = {
    handoff: handoffPath ? normPath(handoffPath) : null,
    exists: false,
    size: null,
    items: { owner: null, inputPath: null, restart: null },
  };
  if (!evidence.handoff) return { ok: false, reasons: ['arg_missing'], evidence };
  const stat = safeStat(evidence.handoff);
  if (!stat) return { ok: false, reasons: ['file_missing'], evidence };
  evidence.exists = true;
  if (!stat.isFile()) return { ok: false, reasons: ['not_file'], evidence };
  evidence.size = stat.size;
  if (stat.size === 0) return { ok: false, reasons: ['empty'], evidence };

  const read = readTextFile(evidence.handoff);
  if (read.error) return { ok: false, reasons: ['file_unreadable'], evidence };
  const lines = read.text.split('\n').map((line) => line.replace(/\r$/, ''));
  for (const item of HANDOFF_ITEMS) {
    const value = findHandoffValue(lines, item);
    evidence.items[item.key] = value;
    if (value === null) reasons.push(`${item.key}_missing`);
  }
  return { ok: reasons.length === 0, reasons, evidence };
}

/** 3条件モードの引数不備（受入表の指定どおり exit 2）。 */
function failCompletionArgs(codes) {
  const reason = codes.map((code) => `args:${token(code)}`).join('|');
  process.stdout.write(`COMPLETION_3=NG task=- ng=args reason=${reason}\n`);
  return 2;
}

/** 3条件モードの1行判定を出し、終了コードを返す。 */
function emitCompletionVerdict(task, ng, reasonList) {
  const taskToken = token(task, '-');
  if (ng.length === 0) {
    process.stdout.write(`COMPLETION_3=OK task=${taskToken} conditions=3\n`);
    return 0;
  }
  const reason = reasonList.length > 0 ? reasonList.join('|') : 'unknown';
  process.stdout.write(`COMPLETION_3=NG ng=${ng.join(',')} reason=${reason} task=${taskToken}\n`);
  return 1;
}

/** 3条件モードの本体。 */
function runCompletion3(opts) {
  const required = [
    ['task', 'missing_task'],
    ['exec-log', 'missing_exec_log'],
    ['artifact', 'missing_artifact'],
    ['handoff', 'missing_handoff'],
    ['quality-cmd', 'missing_quality_cmd'],
    ['report', 'missing_report'],
  ];
  const missing = required.filter(([key]) => !opts[key]).map(([, code]) => code);
  if (missing.length > 0) return failCompletionArgs(missing);
  // --offline は4段モードの fixture 差し替え専用。3条件モードでは黙って無視せず拒否する。
  if (opts.offline !== undefined) return failCompletionArgs(['offline_not_supported_in_completion3']);

  const task = opts.task;
  const checkedAt = new Date().toISOString();
  const failures = {
    goal: checkGoal(opts['exec-log']),
    stable: checkStable(opts.artifact, opts['quality-cmd'], opts.timeoutMs),
    handoff: checkHandoff(opts.handoff),
  };
  const ng = CONDITION_ORDER.filter((condition) => !failures[condition].ok);
  const report = {
    tool: TOOL,
    version: VERSION,
    mode: 'completion3',
    rule: 'notes/hybrid-ops-20261027/WORKFLOW.md#完了3条件',
    task,
    checkedAt,
    verdict: ng.length === 0 ? 'OK' : 'NG',
    conditions: 3,
    ng,
    reason: buildConditionReasons(failures),
    inputs: {
      execLog: normPath(opts['exec-log']),
      artifact: normPath(opts.artifact),
      handoff: normPath(opts.handoff),
      qualityCmd: redact(opts['quality-cmd']),
      report: normPath(opts.report),
      timeoutMs: opts.timeoutMs,
    },
    evidence: {
      goal: failures.goal.evidence,
      stable: failures.stable.evidence,
      handoff: failures.handoff.evidence,
      record: { path: normPath(opts.report), written: true, error: null },
    },
    conditionLabels: CONDITION_LABEL,
    limitations: [
      '①の受入表全行の網羅性は exec-log を作る呼び出し側の責任（指示書本文とは機械照合しない）',
      '②の「同一入力」は --quality-cmd の2回実行を同一環境で行うことを指す（入力データの同一性は呼び出し側の責任）',
      '③の3項目はラベルと値の有無だけを確認する（内容の妥当性は人/独立レビューが確認する）',
    ],
  };

  const record = writeReport(normPath(opts.report), report);
  report.evidence.record.written = record.written;
  report.evidence.record.error = record.error;
  if (!record.written) {
    failures.record = { ok: false, reasons: ['report_write_failed'], evidence: report.evidence.record };
    ng.push('record');
    report.verdict = 'NG';
  }
  report.ng = [...CONDITION_ORDER.filter((condition) => !failures[condition].ok), ...(failures.record ? ['record'] : [])];
  report.reason = buildConditionReasons(failures);
  return emitCompletionVerdict(task, report.ng, report.reason);
}

/** 段5 記録: 全段の証拠を JSON へ書く。書けなければ false。 */
function writeReport(reportPath, report) {
  const tempPath = `${reportPath}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    // 途中まで書けた JSON を残さないため、一時ファイルへ書いてから置き換える。
    writeFileSync(tempPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    renameSync(tempPath, reportPath);
    return { written: true, error: null };
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // 一時ファイルの後始末失敗は判定に影響させない。
    }
    return { written: false, error: String(error && error.code ? error.code : error) };
  }
}

/** 1行の判定を出す。 */
function emitVerdict(task, ng, reasonList) {
  const taskToken = token(task, '-');
  if (ng.length === 0) {
    process.stdout.write(`FOUR_STAGE=OK task=${taskToken} stages=5\n`);
    return 0;
  }
  const reason = reasonList.length > 0 ? reasonList.join('|') : 'unknown';
  process.stdout.write(`FOUR_STAGE=NG task=${taskToken} ng=${ng.join(',')} reason=${reason}\n`);
  return 1;
}

/** 引数不備の早期不合格（レポートは書かない）。 */
function failArgs(task, codes) {
  const reasons = codes.map((code) => `args:${token(code)}`);
  return emitVerdict(task, ['args'], reasons);
}

function main() {
  const argv = process.argv.slice(2);
  const intendedMode = intendedModeFromArgv(argv);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (error instanceof ArgError) {
      // 3条件モードは受入表の指定どおり引数不備を exit 2 にする（4段モードは従来どおり exit 1）。
      if (intendedMode === 'completion3') return failCompletionArgs([error.code]);
      return failArgs('-', [error.code]);
    }
    throw error;
  }
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (opts.mode === 'completion3') {
    try {
      return runCompletion3(opts);
    } catch (error) {
      // 途中で例外停止しない（fail-closed）。スタックトレースや秘密値は出さない。
      return failCompletionArgs([error && error.code ? token(error.code) : 'internal_error']);
    }
  }

  const task = opts.task || '';
  const missing = [];
  if (!task) missing.push('missing_task');
  if (!opts.source) missing.push('missing_source');
  if (!opts.prod) missing.push('missing_prod');
  if (!opts.artifact) missing.push('missing_artifact');
  if (!opts.report) missing.push('missing_report');
  if (missing.length > 0) return failArgs(task, missing);

  let applied;
  try {
    applied = applyOffline(opts);
  } catch (error) {
    if (error instanceof ArgError) return failArgs(task, [error.code]);
    throw error;
  }
  const runOpts = applied.opts;
  // 2026-10-28 実測で発見: 引数パーサは kebab（--exec-cmd / --quality-cmd）で受けるが、
  // 4段モードの検証は camelCase（execCmd / qualityCmd）を読むため、実引数が常に「欠落」扱いになり
  // 4段モードが動かなかった（offline fixture 時だけ補われるためテストは通っていた）。ここで正規化する。
  if (runOpts.execCmd === undefined && runOpts['exec-cmd'] !== undefined) runOpts.execCmd = runOpts['exec-cmd'];
  if (runOpts.qualityCmd === undefined && runOpts['quality-cmd'] !== undefined) runOpts.qualityCmd = runOpts['quality-cmd'];
  runOpts.ledger = runOpts.ledger || DEFAULT_LEDGER;
  runOpts['install-log'] = runOpts['install-log'] || DEFAULT_INSTALL_LOG;
  // 引数なしの exec-cmd / quality-cmd は offline 時だけ fixture から補う。
  const missingCmds = [];
  if (!runOpts.execCmd) missingCmds.push('missing_exec_cmd');
  if (!runOpts.qualityCmd) missingCmds.push('missing_quality_cmd');
  if (missingCmds.length > 0) return failArgs(task, missingCmds);

  const checkedAt = new Date().toISOString();
  const failures = {};
  const check = (stage, result) => {
    failures[stage] = result;
    return result;
  };

  check('install', checkInstall(runOpts));
  check('review', checkReview(runOpts));
  check('exec', checkExec(runOpts, applied.offlinePaths));
  check('quality', checkQuality(runOpts, applied.offlinePaths));

  const ng = STAGE_ORDER.filter((stage) => stage !== 'record' && failures[stage] && !failures[stage].ok);
  const report = {
    tool: TOOL,
    version: VERSION,
    rule: 'templates/prompts/agent-rules.md#完了の4段',
    task,
    checkedAt,
    verdict: ng.length === 0 ? 'OK' : 'NG',
    stages: 5,
    ng,
    reason: buildReasons(failures),
    offline: Boolean(runOpts.offline),
    overrides: applied.overrides,
    defaults: { ledger: DEFAULT_LEDGER, installLog: DEFAULT_INSTALL_LOG },
    inputs: {
      source: runOpts.source,
      prod: runOpts.prod,
      cheapReview: runOpts['cheap-review'] || null,
      execCmd: redact(runOpts.execCmd || ''),
      artifact: runOpts.artifact,
      qualityCmd: redact(runOpts.qualityCmd || ''),
      report: runOpts.report,
      ledger: runOpts.ledger,
      installLog: runOpts['install-log'],
    },
    evidence: {
      install: failures.install.evidence,
      review: failures.review.evidence,
      exec: failures.exec.evidence,
      quality: failures.quality.evidence,
      record: { path: normPath(runOpts.report), written: true, error: null },
    },
    stageLabels: STAGE_LABEL,
  };

  const record = writeReport(normPath(runOpts.report), report);
  report.evidence.record.written = record.written;
  report.evidence.record.error = record.error;
  if (!record.written) {
    ng.push('record');
    report.verdict = 'NG';
    failures.record = { ok: false, reasons: ['report_write_failed'], evidence: report.evidence.record };
  }
  report.ng = STAGE_ORDER.filter((stage) => ng.includes(stage));
  report.reason = buildReasons(failures);

  return emitVerdict(task, report.ng, report.reason);
}

let exitCode = 1;
try {
  exitCode = main();
} catch (error) {
  // 途中で例外停止しない（fail-closed）。スタックトレースや秘密値は出さない。
  const code = error && error.code ? token(error.code) : 'internal_error';
  exitCode = failArgs('-', [code]);
}
// process.exit() はパイプ出力を取りこぼすことがあるため、終了コードだけ設定する。
process.exitCode = exitCode;
