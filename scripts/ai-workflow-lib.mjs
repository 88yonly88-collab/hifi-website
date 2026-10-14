import { execFileSync } from 'child_process';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve } from 'path';

export const LEGACY_PROFILE = 'legacy-claude-codex-v1';
export const GPT56_CLAUDE_PROFILE = 'gpt56-claude-v1';
export const IDENTIFIER_PATTERN = /^(?!.*\.\.)(?!.*[\r\n])(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** ai:* コマンド名として許可する文字種（案内文字列の組み立て専用）。 */
const AI_COMMAND_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 導入先が standalone（package.json が無い repo）かどうか。
 *
 * package.json が無い repo（Python 等）には npm scripts を配線できないため、
 * インストーラーは npm 配線をスキップして POSIX ラッパー scripts/ai だけを配る。
 * 判定基準は bin/install.mjs と同じ「導入先ルートの package.json の有無」。
 */
export function isStandaloneInstall(root = process.cwd()) {
  return !existsSync(join(root, 'package.json'));
}

/**
 * ユーザー向け案内に出す ai:* コマンド文字列を、実行コンテキストに合わせて組み立てる。
 *
 *   aiCmd('help')                                → npm run ai:help
 *                                                  bash scripts/ai help          （standalone）
 *   aiCmd('review-reply', '--message "x" --yes') → npm run ai:review-reply -- --message "x" --yes
 *                                                  bash scripts/ai review-reply --message "x" --yes
 *
 * npm 固有の `--` はここでだけ付ける。呼び出し側は package.json の有無を判定しない。
 */
export function aiCmd(name, args = '', { root = process.cwd() } = {}) {
  const command = String(name || '').trim();
  if (!AI_COMMAND_PATTERN.test(command)) throw new Error(`不正な ai コマンド名です: ${name}`);
  const rest = String(args || '').trim();
  if (isStandaloneInstall(root)) {
    return rest ? `bash scripts/ai ${command} ${rest}` : `bash scripts/ai ${command}`;
  }
  return rest ? `npm run ai:${command} -- ${rest}` : `npm run ai:${command}`;
}

export function repoKey(value) {
  if (!value) return '';
  return basename(String(value).trim().replace(/\/$/, ''));
}

export function workflowProfile(task) {
  return String(task?.workflowProfile || '').trim() || LEGACY_PROFILE;
}

export function agentId(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return String(value.id || value.agent || value.name || '').trim();
}

export function agmsgScriptsDir() {
  if (
    process.env.AGMSG_SCRIPTS_DIR &&
    (process.env.NODE_ENV === 'test' || process.env.AI_DEV_TOOL_ALLOW_AGMSG_SCRIPTS_DIR === '1')
  ) {
    return process.env.AGMSG_SCRIPTS_DIR;
  }
  return join(homedir(), '.agents', 'skills', 'agmsg', 'scripts');
}

/**
 * agmsgの公式スクリプトを実行する。
 *
 * maxBufferはNode既定の1MBでは足りない。レビュー返信1通が数十KBになることは普通で、
 * inbox.shの未読が溜まった時やhistory.shで数百件読む時に1MBを超え、ENOBUFSで
 * 「返信は存在するのに読めない」状態になる（2026-08-03に実データで発生）。
 * 出力はいずれもsqliteの1テーブル由来で青天井ではないため、上限は広く取る。
 * 目安: 実測でレビュー返信1通が平均11.4KB。history.shの上限5000件なら約57MBになるので、
 * 上限一杯で読んでも余裕が残る値にする（maxBufferは上限であって確保量ではない）。
 */
const AGMSG_MAX_BUFFER = 256 * 1024 * 1024;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

export function runAgmsgScript(script, args, options = {}) {
  const scriptPath = join(agmsgScriptsDir(), script);
  const execOptions = {
    cwd: options.cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: options.maxBuffer ?? AGMSG_MAX_BUFFER,
    timeout: options.timeout,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  };
  // Windowsは実行形式でない.shを直接spawnできない(spawn EFTYPE)ため、
  // その場合だけGit Bash経由でスクリプトを渡す。Linux/VPSは従来どおり直接起動する。
  if (process.platform === 'win32' && script.endsWith('.sh')) {
    return execFileSync('bash', [scriptPath, ...args], execOptions);
  }
  return execFileSync(scriptPath, args, execOptions);
}

// encoding は既定 'utf8'。'buffer' を渡すと生バイトのまま受け取れる。
// UTF-8 として壊れた出力を無言で置換文字へ潰さずに判定したい呼び出し側が使う。
export function gitOutput(args, options = {}) {
  const { _directCommand = 'git', ...execOptions } = options;
  const opts = {
    ...execOptions,
    encoding: execOptions.encoding ?? 'utf8',
    maxBuffer: execOptions.maxBuffer ?? GIT_MAX_BUFFER,
  };
  try {
    return execFileSync(_directCommand, args, opts);
  } catch (error) {
    if (
      typeof error?.code !== 'string' ||
      (typeof error?.status === 'number' && error.status !== 0)
    ) {
      throw error;
    }
    try {
      return execFileSync('bash', ['-c', 'git "$@"', 'git', ...args], opts);
    } catch (fallbackError) {
      // 一部sandboxは子プロセス完了後もspawnSync EPERMを付ける。実終了0だけ成功として回収する。
      if (fallbackError?.code === 'EPERM' && fallbackError.status === 0) {
        return fallbackError.stdout ?? '';
      }
      throw fallbackError;
    }
  }
}

export function ensureSafeDirectory(dirPath, { create = false } = {}) {
  const parentPath = dirname(dirPath);
  const parentStat = lstatSync(parentPath);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`${parentPath}はsymlinkではない実ディレクトリである必要があります`);
  }
  if (!existsSync(dirPath)) {
    if (!create) throw new Error(`${dirPath}がありません`);
    try {
      mkdirSync(dirPath, { mode: 0o700 });
    } catch (error) {
      // 同じ安全な保存先を並行準備した相手が先に作った場合は、下の検査で実体を確かめる。
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const dirStat = lstatSync(dirPath);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`${dirPath}はsymlinkではない実ディレクトリである必要があります`);
  }
  if (dirname(realpathSync(dirPath)) !== realpathSync(parentPath)) {
    throw new Error(`${dirPath}の実体が期待する親ディレクトリ直下ではありません`);
  }
}

export function appendSecureLog(filePath, content) {
  ensureSafeDirectory(dirname(filePath), { create: true });
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_APPEND |
    fsConstants.O_CREAT |
    (fsConstants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = openSync(filePath, flags, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${filePath}はregular fileではありません`);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, String(content), 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** worktreeではroot登録が無い場合だけ、本体repo（git common-dirの親）をidentity候補にする。 */
export function identityProjectCandidates(root) {
  const candidates = [root];
  try {
    const commonDir = gitOutput(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const commonRoot = commonDir ? dirname(commonDir) : '';
    const commonKey = identityPathKey(commonRoot);
    if (commonRoot && !candidates.some((candidate) => identityPathKey(candidate) === commonKey)) {
      candidates.push(commonRoot);
    }
  } catch {
    // 通常repoのroot照合は継続できる。fallback候補を追加しない。
  }
  return candidates;
}

/**
 * target の表記差(Windows のドライブ文字大小・区切り文字 \ と /)だけで同一ディレクトリを
 * 指すかを比較する正規化キー。win32 以外は入力をそのまま返し、Linux/VPS の判定を変えない。
 */
export function identityPathKey(value) {
  if (process.platform !== 'win32') return value;
  if (typeof value !== 'string' || value === '') return '';
  if (!isAbsolute(value)) return value;
  return resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function resolveWhoami(root, kind, team) {
  if (!IDENTIFIER_PATTERN.test(String(kind || '')) || !IDENTIFIER_PATTERN.test(String(team || ''))) {
    return { agent: '', projectPath: '' };
  }

  let teamOutput;
  function resolveFromTeam(projectPath) {
    if (teamOutput === undefined) {
      try {
        teamOutput = runAgmsgScript('team.sh', [team], { cwd: root });
      } catch {
        teamOutput = null;
      }
    }
    if (teamOutput === null) return null;
    const agent = resolveTeamIdentity(teamOutput, team, kind, projectPath);
    return agent ? { agent, projectPath } : null;
  }

  function tryProject(projectPath) {
    try {
      const identity = runAgmsgScript('whoami.sh', [projectPath, kind], { cwd: root });
      const agent = singularWhoamiAgent(identity, team);
      if (agent) {
        return { agent, projectPath };
      }
    } catch {
      return null;
    }
    // agents=とteams=は独立に重複排除されるため、位置対応せずteam.shで再解決する。
    return resolveFromTeam(projectPath);
  }

  const direct = tryProject(root);
  if (direct) return direct;
  // root未登録/未解決の時だけgit common-dir親を計算する。
  for (const projectPath of identityProjectCandidates(root).slice(1)) {
    const fallback = tryProject(projectPath);
    if (fallback) return fallback;
  }
  return { agent: '', projectPath: '' };
}

export function singularWhoamiAgent(output, team) {
  if (!IDENTIFIER_PATTERN.test(String(team || ''))) return '';
  const text = String(output || '');
  if (text.match(/(?:^|\s)multiple=([^\s]+)/)?.[1] === 'true') return '';
  const agents = [...text.matchAll(/(?:^|\s)agent=([^\s]+)/g)].map((match) => match[1]);
  const teamFields = [...text.matchAll(/(?:^|\s)teams=([^\s]+)/g)].map((match) => match[1]);
  if (agents.length !== 1 || teamFields.length !== 1) return '';
  const teams = teamFields[0].split(',');
  if (teams.length === 0 || teams.some((entry) => !IDENTIFIER_PATTERN.test(entry))) return '';
  return IDENTIFIER_PATTERN.test(agents[0]) && teams.includes(team) ? agents[0] : '';
}

export function parseTeamRegistrations(output) {
  const text = String(output || '');
  const headers = [...text.matchAll(/^Team:\s*(.*)$/gm)].map((match) => match[1].trim());
  const registrations = [];
  let invalid = headers.length !== 1 || !IDENTIFIER_PATTERN.test(headers[0] || '');
  for (const line of text.split('\n')) {
    if (!/^\s{2,}\S/.test(line)) continue;
    if (/^\s*\d+\s+member\(s\)\s*$/.test(line)) continue; // team.sh の末尾集計行はmember行ではない
    const match = line.match(/^\s{2,}([^\s(]+)\s+\(([^)]*)\)\s+—\s+(.+?)(?:\s+\(\+(\d+)\s+more\))?\s*$/);
    if (!match) {
      invalid = true;
      continue;
    }
    const agent = match[1];
    const types = match[2].split(',').map((value) => value.trim()).filter(Boolean);
    const projectPath = match[3].trim();
    const additionalRegistrations = Number(match[4] || 0);
    const exactRegistration = match[4] === undefined;
    if (
      !IDENTIFIER_PATTERN.test(agent) ||
      types.length === 0 ||
      types.some((type) => !IDENTIFIER_PATTERN.test(type)) ||
      !projectPath
    ) {
      invalid = true;
      continue;
    }
    registrations.push({
      agent,
      types,
      projectPath,
      additionalRegistrations,
      exactRegistration,
    });
  }
  return { team: headers.length === 1 ? headers[0] : '', registrations, invalid };
}

export function resolveTeamIdentity(output, team, kind, projectPath) {
  if (
    !IDENTIFIER_PATTERN.test(String(team || '')) ||
    !IDENTIFIER_PATTERN.test(String(kind || '')) ||
    !projectPath
  ) {
    return '';
  }
  const parsed = parseTeamRegistrations(output);
  if (parsed.team !== team || parsed.invalid) return '';
  const matches = parsed.registrations.filter(
    (member) =>
      member.exactRegistration &&
      member.types.includes(kind) &&
      identityPathKey(member.projectPath) === identityPathKey(projectPath),
  );
  return matches.length === 1 ? matches[0].agent : '';
}

// implementer と reviewer がどちらも Claude Code の場合、whoami.sh は同じ
// (project, kind) に2人を返す。current-task が指定した本人の登録を作業場所まで
// 完全一致で確認し、roleごとの固有名を取り違えずに解決する。
export function resolveExpectedTeamIdentity(output, team, kind, expectedAgent, root) {
  if (
    !IDENTIFIER_PATTERN.test(String(team || '')) ||
    !IDENTIFIER_PATTERN.test(String(kind || '')) ||
    !IDENTIFIER_PATTERN.test(String(expectedAgent || ''))
  ) {
    return '';
  }
  const parsed = parseTeamRegistrations(output);
  if (parsed.team !== team || parsed.invalid) return '';
  for (const projectPath of identityProjectCandidates(root)) {
    const projectKey = identityPathKey(projectPath);
    const matches = parsed.registrations.filter(
      (member) =>
        member.exactRegistration &&
        member.agent === expectedAgent &&
        member.types.includes(kind) &&
        identityPathKey(member.projectPath) === projectKey,
    );
    if (matches.length === 1) return matches[0].agent;
    if (matches.length > 1) return '';
  }
  return '';
}

export function parseTeamMembers(output) {
  const parsed = parseTeamRegistrations(output);
  return {
    members: [...new Set(parsed.registrations.map((member) => member.agent))],
    invalid: parsed.invalid,
  };
}

export function resolveMember(members, requested, role) {
  if (!requested) return { error: `${role} が空です` };
  if (!IDENTIFIER_PATTERN.test(requested)) return { error: `${role} '${requested}' の文字種が不正です` };
  if (members.includes(requested)) return { id: requested };

  const suffixMatches = members.filter((member) => member.endsWith(`-${requested}`));
  if (suffixMatches.length === 1) return { id: suffixMatches[0] };
  if (suffixMatches.length > 1) {
    return {
      error: `${role} '${requested}' のsuffix一致が複数あります: ${suffixMatches.join(', ')}`,
    };
  }
  return { error: `${role} '${requested}' はteamメンバーに完全一致・一意suffix一致しません` };
}

/**
 * current-task の team/implementer/reviewerを厳密に解決し、指定role本人のidentityを検証する。
 * legacy task で implementer が無い場合はclaude-code whoamiを正本にする。
 */
export function resolveLane(task, root, role = 'implementer') {
  const team = String(task?.team || '').trim();
  const profile = workflowProfile(task);
  const errors = [];
  if (!['implementer', 'reviewer'].includes(role)) errors.push(`未対応のroleです: ${role}`);
  if (![LEGACY_PROFILE, GPT56_CLAUDE_PROFILE].includes(profile)) {
    errors.push(`未対応のworkflowProfileです: ${profile}`);
  }
  if (team && !IDENTIFIER_PATTERN.test(team)) errors.push(`team '${team}' の文字種が不正です`);
  if (!team) return { profile, team, errors: [...errors, 'team が空です'], members: [] };
  if (errors.length > 0) return { profile, team, role, errors, members: [] };

  let output = '';
  try {
    output = runAgmsgScript('team.sh', [team], { cwd: root });
  } catch (error) {
    return {
      profile,
      team,
      errors: [`team.sh ${team} の実行に失敗しました: ${error.message}`],
      members: [],
    };
  }

  const reportedTeam = String(output).match(/^Team:\s*(.+)$/m)?.[1]?.trim();
  if (!reportedTeam) {
    errors.push('team.sh の応答にTeamヘッダーがありません');
  } else if (reportedTeam !== team) {
    errors.push(`team.sh の応答teamが不一致です（要求='${team}' / 応答='${reportedTeam}'）`);
  }
  const parsedMembers = parseTeamMembers(output);
  const members = parsedMembers.members;
  if (members.length === 0) errors.push(`team '${team}' のメンバーを解決できません`);
  if (parsedMembers.invalid) errors.push('team.sh の応答にmalformedまたは文字種不正のmember行があります');

  const reviewerRequested = agentId(task?.reviewer);
  const reviewer = resolveMember(members, reviewerRequested, 'reviewer');
  if (reviewer.error) errors.push(reviewer.error);

  let implementerRequested = agentId(task?.implementer) || String(process.env.AGMSG_AGENT || '').trim();
  const implementerKind = String(task?.implementer?.kind || (profile === LEGACY_PROFILE ? 'claude-code' : 'codex'));
  const reviewerKind = String(task?.reviewer?.kind || (profile === LEGACY_PROFILE ? 'codex' : 'claude-code'));
  const supportedKinds = ['codex', 'claude-code'];
  if (!supportedKinds.includes(implementerKind)) errors.push(`implementer.kind '${implementerKind}' は未対応です`);
  if (!supportedKinds.includes(reviewerKind)) errors.push(`reviewer.kind '${reviewerKind}' は未対応です`);

  let implementerIdentity = '';
  let implementerIdentityResolved = false;
  try {
    if (!supportedKinds.includes(implementerKind)) throw new Error('unsupported kind');
    const identity = resolveWhoami(root, implementerKind, team);
    if (identity.agent) {
      implementerIdentity = identity.agent;
      implementerIdentityResolved = true;
    }
  } catch {
    implementerIdentityResolved = false;
  }
  if (!implementerRequested && profile === LEGACY_PROFILE && implementerIdentityResolved) {
    implementerRequested = implementerIdentity;
  }
  if (!implementerRequested && profile === LEGACY_PROFILE && reviewer.id) {
    const candidates = members.filter((member) => member !== reviewer.id);
    errors.push(
      `legacy task のimplementerを解決できません。implementer.idまたはAGMSG_AGENTを設定してください（候補: ${candidates.join(', ') || 'なし'}）`,
    );
  }
  const implementer = implementerRequested
    ? resolveMember(members, implementerRequested, 'implementer')
    : { error: 'implementer が空です' };
  if (implementer.error && !errors.some((entry) => entry.startsWith('legacy task のimplementer'))) {
    errors.push(implementer.error);
  }
  if (implementer.id && reviewer.id && implementer.id === reviewer.id) {
    errors.push('implementer と reviewer は別のteamメンバーである必要があります');
  }
  let activeIdentity = implementerIdentity;
  let activeIdentityResolved = implementerIdentityResolved;
  const activeKind = role === 'reviewer' ? reviewerKind : implementerKind;
  if (role === 'reviewer') {
    try {
      if (!supportedKinds.includes(reviewerKind)) throw new Error('unsupported kind');
      const identity = resolveWhoami(root, reviewerKind, team);
      activeIdentity = identity.agent;
      activeIdentityResolved = Boolean(activeIdentity);
    } catch {
      activeIdentity = '';
      activeIdentityResolved = false;
    }
  }
  const expectedIdentity = role === 'reviewer' ? reviewer.id : implementer.id;
  // 同じkindの実装者とレビュアーが同居する場合だけ、roleの固有名と作業場所を
  // team登録へ完全一致させる。異種構成は従来のwhoami検査を維持する。
  if (expectedIdentity && implementerKind === reviewerKind) {
    activeIdentity = resolveExpectedTeamIdentity(output, team, activeKind, expectedIdentity, root);
    activeIdentityResolved = Boolean(activeIdentity);
  }
  if (!activeIdentityResolved) {
    errors.push(`whoami.shで${role}(${activeKind})をteam '${team}' に一意解決できません`);
  } else if (expectedIdentity && activeIdentity !== expectedIdentity) {
    errors.push(`現在の${role} identity '${activeIdentity}' は設定 '${expectedIdentity}' と一致しません`);
  }

  return {
    profile,
    team,
    role,
    implementer: implementer.id || '',
    reviewer: reviewer.id || '',
    from: role === 'reviewer' ? reviewer.id || '' : implementer.id || '',
    to: role === 'reviewer' ? implementer.id || '' : reviewer.id || '',
    inbox: role === 'reviewer' ? reviewer.id || '' : implementer.id || '',
    members,
    errors,
  };
}

export function extractMessageFields(body) {
  const fields = {};
  for (const part of String(body || '').split('\\n')) {
    const match = part.match(/^\s*(Project|Repo|Branch|Task|Team|Request-ID)\s*:\s*(.*)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase() === 'request-id' ? 'requestId' : match[1].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(fields, key)) fields[key] = match[2].trim();
  }
  return fields;
}

export function parseInboxLine(line) {
  // inbox.shは本文中の改行をliteralな2文字「\\n」として1行にescapeする契約。
  // 呼び出し側はこの1行形式をparse後、必要な保存時だけ実改行へ戻す。
  const match = line.match(/^\s*\[([^\]]+)\]\s+(.*)$/);
  if (!match) return null;
  const separator = match[2].indexOf(': ');
  if (separator < 0) return null;
  return {
    ts: match[1],
    from: match[2].slice(0, separator),
    body: match[2].slice(separator + 2),
  };
}

/**
 * history.shの1行をparseする。
 *
 * history.shはinbox.shと違い既読・未読の両方を出し、read_atを打たない。
 * inbox.shが既読化した後でも返信本文を読み直せる唯一の公式経路なので、
 * 「wait-reply.shが受信時に既読化 → 後続のreview-checkが未読0件で証跡を取れない」
 * の回収に使う（2026-08-02に2度再発）。
 *
 * 行形式: "  ○ [created_at] from → to: body"（●=未読 / ○=既読）
 * 本文のescape契約（改行→literalな2文字「\\n」）はinbox.shと同じ。
 * inbox.shはSQLでto_agentを絞るがhistory.shは絞らない（from/to両方向を返す）ため、
 * 宛先の限定は呼び出し側がtoを検査して行う。
 */
export function parseHistoryLine(line) {
  const match = String(line ?? '').match(/^\s*([●○])\s+\[([^\]]+)\]\s+(\S+)\s+→\s+(.*)$/);
  if (!match) return null;
  const rest = match[4];
  const separator = rest.indexOf(': ');
  if (separator < 0) return null;
  const to = rest.slice(0, separator);
  if (!to || /\s/.test(to)) return null;
  return {
    unread: match[1] === '●',
    ts: match[2],
    from: match[3],
    to,
    body: rest.slice(separator + 2),
  };
}
