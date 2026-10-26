// Validate provider receipts and the exact reviewed files; never infer a review from a flag.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {homedir, userInfo} from 'node:os';
import {createRequire} from 'node:module';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// 証跡検査が1ファイルとして読む上限(prompt/manifest/結果、manifest 上の各ファイル、削除ファイルの基準版)。
// 送信前の判定(deepseek-primary-review.mjs)も同じ値を使い、送った後に証跡検査で止まる版を先に拒否する。
export const EVIDENCE_FILE_MAX_BYTES=4*1024*1024;
export function regular(file) {
  const st=fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > EVIDENCE_FILE_MAX_BYTES) throw Error('unsafe evidence file');
  return fs.readFileSync(file);
}
function artifact(base, name, hash) {
  if (typeof name !== 'string' || path.isAbsolute(name) || name.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/.test(hash || '')) throw Error('invalid evidence reference');
  const file=path.resolve(base,name);
  if (!fs.realpathSync(file).startsWith(fs.realpathSync(base)+path.sep)) throw Error('evidence escapes root');
  const bytes=regular(file);
  if (sha(bytes)!==hash) throw Error('evidence hash mismatch');
  return bytes;
}
export function verifyManifest(root, manifest, {current=true}={}) {
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw Error('empty review manifest');
  const seen=new Set();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || seen.has(entry.path) || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..') || (entry.after!==null && !/^[a-f0-9]{64}$/.test(entry.after || '')) || (entry.after===null && !/^[a-f0-9]{64}$/.test(entry.before || ''))) throw Error('invalid/duplicate manifest entry');
    seen.add(entry.path);
    if (current && entry.after!==null) artifact(root,entry.path,entry.after);
    if (current && entry.after===null) {
      const deleted=path.resolve(root,entry.path);
      if (!deleted.startsWith(path.resolve(root)+path.sep)) throw Error('deleted path escapes root');
      try {fs.lstatSync(deleted);throw Error('reviewed deletion no longer absent');} catch(error) {if(error.code!=='ENOENT')throw error;}
    }
  }
  return seen;
}
export function verifyChangedScope(root, paths, base) {
  if (!/^[a-f0-9]{40,64}$/.test(base || '') || spawnSync('git',['-C',root,'merge-base','--is-ancestor',base,'HEAD']).status!==0) throw Error('invalid review base commit');
  // The changed paths outside the .ai/ exemption, exactly as the worktree is. Returned so
  // a caller can hash the real reviewed+changed scope instead of restating it. Everything
  // outside .ai/ must be named by the manifest; .ai/ is exempt and stays out of the hash.
  const changed=new Set();
  for (const args of [['diff','--name-only','--no-renames','-z',base],['ls-files','--others','--exclude-standard','-z']]) {
    const run=spawnSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:4*1024*1024});
    if (run.status!==0) throw Error('cannot verify review worktree scope');
    for (const file of run.stdout.split('\0').filter(Boolean)) {
      if (!file.startsWith('.ai/') && !paths.has(file)) throw Error(`unreviewed changed file: ${file}`);
      if (!file.startsWith('.ai/')) changed.add(file);
    }
  }
  return [...changed].sort();
}
export function verifyDeletedBase(root,manifest,base) {
  for (const entry of manifest.files.filter(e=>e.after===null)) {
    const original=spawnSync('git',['-C',root,'show',base+':'+entry.path],{maxBuffer:EVIDENCE_FILE_MAX_BYTES});
    if (original.status!==0 || sha(original.stdout)!==entry.before) throw Error('deleted file differs from official base content');
  }
}
// R3(2026-09-19) F3-3: 過去の往復で見たファイルを基点の内容へ戻すと、最終の manifest からは
// 消える。戻したことを実物で確かめる。基点との差分が無く、かつ作業場に未追跡として
// 残っていないこと(ignore された未追跡も含む)を要求する。戻していない変更は残るので止まる。
// R3fix(2026-09-19) G-3: 往復の間に基点が動いた場合は、呼び出し側が「往復の基点」と
// 「最終の基点」の両方を試す(戻した先が動く前の基点とは限らない)。
function restoredToBase(root, base, relative) {
  const diff=spawnSync('git',['-C',root,'diff','--quiet','--no-ext-diff',base,'--',relative],{encoding:'utf8'});
  if (diff.status!==0) return false;
  const untracked=spawnSync('git',['-C',root,'ls-files','--others','--',relative],{encoding:'utf8'});
  return untracked.status===0 && !untracked.stdout.trim();
}
// 2026-09-23: 独立レビューは Opus 5.5(claude-opus-5-5)。旧 claude-opus-5 を許してよいのは
// 「その往復の対象 commit の日時が切替より前」のときだけにする。往復番号とは切り離す
// (番号で決めると、切替後に始めた往復の1・2往復目が旧5でも通り、切替前に旧5で終えた
// 保存済みの3往復目だけが落ちる、と両方向に誤る)。日時が取れない・壊れているときは旧版を
// 許さない(安全側)。1往復 = 1モデルも要求する(5.5 と 5 の混在は途中で版が入れ替わった
// 状態なので通さない)。
export const OPUS_MODEL_SWITCH_AT = '2026-09-23T00:00:00+09:00';
export const ACCEPTED_CURRENT_OPUS_MODELS = ['claude-opus-5-5'];
export const ACCEPTED_LEGACY_OPUS_MODELS = ['claude-opus-5-5', 'claude-opus-5'];
// 旧 claude-opus-5 を許してよいか。review-evidence-gate.mjs の方式切替(chainSwitchAt)と同じ形で、
// 往復の対象 commit の committer日時(%ct)を切替時刻と比べる。commit を読めない・日時を
// 読めない場合は許さない(安全側)。
export function opusLegacyAllowed(root, commit) {
  if (typeof commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(commit)) return false;
  const run=spawnSync('git',['-C',root,'show','-s','--format=%ct',commit],{encoding:'utf8'});
  if (run.status!==0) return false;
  const epoch=Number(String(run.stdout).trim());
  const switchMs=Date.parse(OPUS_MODEL_SWITCH_AT);
  return Number.isFinite(epoch) && epoch > 0 && Number.isFinite(switchMs) && epoch*1000 < switchMs;
}
// 2026-10-13: 一次確認(DeepSeek)の effort は採用表(config/accepted-model-decisions.json)から引く。
// 表が無いrepo・読めないrepoでは 'max' を既定にする(利用者決定 2026-10-12「レビューだけMax」。
// 実装=highのまま)。送信側(deepseek-primary-review.mjs)とこの検査側が同じ1か所を読むことで、
// 「宣言=max・実際=high」のような食い違いを作らない。
export const PRIMARY_REVIEW_DEFAULT_EFFORT = 'max';
// 2026-10-12 の採用決定より前に作られた一次確認の証跡は high のまま残る。履歴の検査(current:false)だけが
// 当時の値を1つ受け入れる。新しい往復(current:true)は採用表の値だけを受け入れる。
export const PRIMARY_REVIEW_LEGACY_EFFORTS = ['high'];
export function primaryReviewEffort(root) {
  try {
    const efforts = JSON.parse(regular(path.join(root, 'config/accepted-model-decisions.json')))?.roles?.review_primary?.efforts;
    if (Array.isArray(efforts) && efforts.length
      && efforts.every(value => typeof value === 'string' && /^[a-z]+$/.test(value))) return efforts[0];
  } catch { /* 採用表が無い/読めない repo は既定値へ */ }
  return PRIMARY_REVIEW_DEFAULT_EFFORT;
}
// current(いまの作業場と証跡が一致することの要求)と allowLegacyOpus(旧 claude-opus-5 を許すか)は
// 別の引数にする。1つの真偽値に2つの意味を持たせると、往復番号で日時を代用する形へ戻ってしまう。
export function verifyProviderEvidence(root, base, ref, kind, {current=true, allowLegacyOpus=false}={}) {
  const result=JSON.parse(artifact(base,ref.result,ref.resultHash));
  const diagnostic=JSON.parse(artifact(base,ref.diagnostic,ref.diagnosticHash));
  const prompt=artifact(base,ref.prompt,ref.promptHash);
  const manifestBytes=artifact(base,ref.manifest,ref.manifestHash);
  const manifest=JSON.parse(manifestBytes);
  verifyManifest(root,manifest,{current});
  if (result.promptHash!==sha(prompt) || result.manifestHash!==sha(manifestBytes) || !prompt.toString('utf8').includes(ref.manifestHash)) throw Error('review input binding mismatch');
  if (!['pass','findings'].includes(result.verdict) || !Array.isArray(result.findings) || !Array.isArray(result.unverified) || (result.verdict==='pass')!==(result.findings.length===0)) throw Error('invalid review result');
  // 2026-10-13: 一次確認(deepseek)の effort は採用表の値。Opus 独立レビューは従来どおり high のまま。
  // 決定前に作られた証跡は当時の high を履歴検査(current:false)でだけ受け入れる。
  const expectedEffort = kind==='deepseek' ? primaryReviewEffort(root) : 'high';
  const actualEffort = String(result.actual?.effort || '');
  if (actualEffort!==expectedEffort
    && !(kind==='deepseek' && !current && PRIMARY_REVIEW_LEGACY_EFFORTS.includes(actualEffort))) {
    throw Error(`review effort mismatch: expected=${expectedEffort} actual=${actualEffort||'(none)'}`);
  }
  let body;
  let model;
  if (kind==='deepseek') {
    if (!['deepseek-flash','deepseek-v4.1-flash'].includes(diagnostic.model) || diagnostic.finish_reason!=='stop' || diagnostic.model!==result.actual.model) throw Error('incomplete/wrong DeepSeek runtime');
    const usage=diagnostic.usage;
    if (!Number.isInteger(usage?.prompt_tokens) || !Number.isInteger(usage?.completion_tokens) || usage.prompt_tokens<0 || usage.completion_tokens<=0 || JSON.stringify(usage)!==JSON.stringify(result.actual.usage)) throw Error('missing/mismatched DeepSeek usage');
    model=diagnostic.model;
    body=diagnostic.body;
  } else if (kind==='opus') {
    if (diagnostic.subtype!=='success' || diagnostic.is_error || !Object.keys(diagnostic.modelUsage || {}).length || JSON.stringify(diagnostic.modelUsage)!==JSON.stringify(result.actual.modelUsage)) throw Error('incomplete/wrong Opus runtime');
    const models=Object.keys(diagnostic.modelUsage);
    if (models.length!==1) throw Error(`incomplete/wrong Opus runtime: mixed modelUsage ${models.join('+')}; one round must use exactly one model`);
    const accepted=allowLegacyOpus?ACCEPTED_LEGACY_OPUS_MODELS:ACCEPTED_CURRENT_OPUS_MODELS;
    if (!accepted.includes(models[0])) throw Error(!allowLegacyOpus && ACCEPTED_LEGACY_OPUS_MODELS.includes(models[0])
      ? `incomplete/wrong Opus runtime: stale model ${models[0]}; the current round must run ${ACCEPTED_CURRENT_OPUS_MODELS[0]}`
      : `incomplete/wrong Opus runtime: unsupported model ${models[0]}`);
    model=models[0];
    if (!Number.isFinite(diagnostic.total_cost_usd) || diagnostic.total_cost_usd<0 || diagnostic.total_cost_usd!==result.actual.costUsd) throw Error('missing/mismatched Opus usage');
    body=diagnostic.result;
  } else throw Error('unsupported reviewer');
  const parsed=JSON.parse(String(body).trim().replace(/^```(?:json)?\s*|\s*```$/g,''));
  for (const key of ['verdict','findings','unverified']) if (JSON.stringify(parsed[key])!==JSON.stringify(result[key])) throw Error('result differs from provider response');
  // model は証跡が実際に走らせた明示ID(deepseek は diagnostic.model、opus は modelUsage の唯一のキー)。
  // 論理名 'opus' しか残らない記録からでも、後から「この往復はどちらの版だったか」を名指しできるよう返す。
  return {result,manifest,manifestHash:ref.manifestHash,kind,prompt:prompt.toString('utf8'),model};
}
// 分割計画の1呼出しぶんの証跡を、版全体のレビュー完了として受け付けない。
// 分割版の結果を合わせて検証する経路ができるまでは、1回で版全体を覆った証跡だけを認める。
// 一次レビュー(primaryEvidence)と外部集計(externalReviewSummary)の両方がこの同じ判定を使う。
export function assertWholeVersionCoverage(coverage) {
  if (['total','index','chunks','unverified'].some(key=>Object.hasOwn(coverage,key))
    && (coverage.total!==1 || coverage.index!==0 || !Array.isArray(coverage.unverified) || coverage.unverified.length
      || !Array.isArray(coverage.chunks) || !coverage.chunks.length || coverage.chunks.some(chunk=>chunk?.whole!==true))) {
    throw Error('review evidence covers only part of the version; one call covering the whole version is required');
  }
}
const lensTags={spec:'Round lens: User specification',user_path:'Round lens: User/CLI path',edge:'Round lens: Edge cases'};
// current:true(既定)は送信時の検査で、いまの作業場と証跡が一致することを要求する。
// current:false は往復の記録時の検査。証跡そのもの(task/round/lens/観点/依頼記録との
// 結び付き)は検証するが、記録までに作業場が次の版へ進んでいても止めない(R2 F2-6)。
// allowLegacyOpus は旧 claude-opus-5 を許すか(既定 false = 5.5 だけ)。呼び出し側が
// 往復の対象 commit の日時から opusLegacyAllowed で決める。
export function primaryEvidence(root, file, {task, round, lens, current=true}) {
  const receipt=JSON.parse(regular(file));
  if (receipt.taskId!==task.taskId || receipt.taskFingerprint!==task.taskFingerprint || receipt.round!==round || receipt.lens!==lens) throw Error('primary review task/round/lens mismatch');
  const verified=verifyProviderEvidence(root,path.dirname(file),receipt,'deepseek',{current});
  if (verified.result.verdict!=='pass' || verified.result.unverified.length) throw Error('primary review has unresolved findings/unverified items');
  assertWholeVersionCoverage(verified.manifest);
  if (current) {
    verifyChangedScope(root,new Set(verified.manifest.files.map(entry=>entry.path)),receipt.reviewBaseCommit);
    verifyDeletedBase(root,verified.manifest,receipt.reviewBaseCommit);
  }
  if (!lensTags[lens] || !verified.prompt.includes(lensTags[lens])) throw Error('primary review prompt lens mismatch');
  if (current) {
    const head=spawnSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'});
    if (head.status!==0 || receipt.reviewHeadCommit!==head.stdout.trim() || receipt.approvalHash!==sha(regular(path.join(root,'.ai/approval.json')))) throw Error('primary review HEAD/approval mismatch');
  }
  const binding=JSON.stringify({taskId:task.taskId,taskFingerprint:task.taskFingerprint,round,lens,reviewBaseCommit:receipt.reviewBaseCommit,reviewHeadCommit:receipt.reviewHeadCommit,approvalHash:receipt.approvalHash,manifestHash:receipt.manifestHash});
  if (!verified.prompt.includes('Review binding: '+binding)) throw Error('primary review input does not bind task/approval/version');
  return {status:'completed',model:verified.result.actual.model,effort:String(verified.result.actual.effort),round,lens,reviewChainVersion:'deepseek-opus-v1',evidencePath:path.resolve(file),evidenceHash:sha(regular(file)),manifestHash:verified.manifestHash,reviewBaseCommit:receipt.reviewBaseCommit,reviewHeadCommit:receipt.reviewHeadCommit,approvalHash:receipt.approvalHash,verdict:verified.result.verdict};
}

// 2026-10-14 (Sol 配線): 各巡の一次確認は DeepSeek と Sol の並列。Sol 側は ChatGPT サブスクの
// `codex exec` セッション(JSONL)で走るため、DeepSeek の API 診断(result/diagnostic)とは別形式になる。
// ここでは receipt が指す実 JSONL を読み、turn_context の model/effort と final_answer 本文を
// 実物から取り出して result.json と突き合わせる。宣言だけの記録・別 round/lens の流用・改変は通さない。
// 検証の厳しさは primaryEvidence(DeepSeek) と同じ(manifest 全体・変更範囲・HEAD/承認・binding)。
export const SOL_PRIMARY_KIND = 'parallel-primary-review-v1';
export const SOL_PRIMARY_MODEL = 'gpt-6.1-sol';
export const SOL_PRIMARY_EFFORT = 'high';
export const SOL_SESSION_SANDBOX = 'read-only';
function solAssistantContent(payload) {
  if (Array.isArray(payload.content)) {
    return payload.content.map((item) => (typeof item === 'string' ? item : item?.text || item?.output_text || '')).join('');
  }
  return String(payload.output_text || payload.content || payload.text || '');
}
// 実測(2026-10-14, codex-cli 0.160.0。tests/fixtures/sol-codex-exec/ 参照)の保存セッションログは
//   session_meta / event_msg task_started(turn_id) / response_item message(role,content) /
//   turn_context(turn_id,model,effort,cwd,sandbox_policy) / event_msg task_complete(turn_id)
// の並びで、assistant の最終回答は role='assistant' かつ phase='final_answer'。
// 1つの task_complete をその回合の境界として、その turn_id の turn_context と、その窓の内側の
// 入力・回答だけを採る。加えて、回答の明示的な所属(item_completed の AgentMessage の turn_id)・
// task_complete.last_agent_message・context の位置・途中のターン境界・入力の順序を照合する。
// さらに「信頼済み保存元(~/.codex/sessions)の実ファイルと一致すること」を検証する。
export const SOL_SESSION_HOME_ENV = 'SOL_CODEX_HOME';
// 受理側の錨は「受理プロセスの実効ユーザーのホーム」から導いた固定ルートだけにする(OPEN-ITEMS §10, 2026-10-15)。
// 提出側は同じユーザーとして環境変数を設定できるため、SOL_CODEX_HOME も $HOME も錨に使わない。
//   - os.homedir() は POSIX では $HOME に従うため、HOME を差し替えるだけで錨が動いてしまう。
//   - os.userInfo().homedir は passwd エントリ由来で、環境変数では変わらない。こちらを使う。
// これで「ストアごと差し替えた合成ログ」は、受理時に保存元の外として拒否される。
export function acceptSessionHome() {
  let info = null;
  try {
    info = userInfo();
  } catch (error) {
    // ここで homedir()($HOME 依存)へ落とすと、userInfo() が失敗する環境では提出側が HOME で錨を動かせる。
    // 錨を確定できないなら、受理せずに停止する(fail-closed)。独立レビュー 2026-10-15 の Major 指摘。
    throw Error(`SOL_ACCEPT_HOME_UNRESOLVED: 実行ユーザーのホームを passwd から決められません (${(error && error.message) || error})`);
  }
  const home = info && typeof info.homedir === 'string' ? info.homedir : '';
  if (!home) {
    throw Error('SOL_ACCEPT_HOME_UNRESOLVED: 実行ユーザーのホームが空です。受理の錨を確定できないため停止します');
  }
  return home;
}
// テスト専用の差し替え経路。ここの `home` 引数(と後方互換の SOL_CODEX_HOME)を尊重するが、
// 本番の受理は solPrimaryEvidenceAccepted だけを使い、注入された値を一切受け取らない。
function solTrustedSessionRoot(home) {
  return trustedCodexSessionRoot(home || process.env[SOL_SESSION_HOME_ENV] || acceptSessionHome());
}
// 本番の受理の入口で、提出側が設定した SOL_CODEX_HOME を無効化する(OPEN-ITEMS §10, 2026-10-15)。
// これを呼んだ後は、錨は acceptSessionHome() の固定ルートだけになる。
// テストは受理の入口を通さずに検証関数を直接呼ぶので、この封印の影響を受けない(差し替え経路の分離)。
export function sealSubmitterSessionHome() {
  const requested = process.env[SOL_SESSION_HOME_ENV];
  delete process.env[SOL_SESSION_HOME_ENV];
  return typeof requested === 'string' ? requested : '';
}
export function verifySolSession(base, ref, {home = ''}={}) {
  const bytes = artifact(base, ref.session, ref.sessionHash);
  const text = bytes.toString('utf8');
  if (text.includes('\u0000')) throw Error('sol session binary');
  const records = [];
  let ordinal = -1;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    ordinal += 1;
    records.push({ordinal, obj});
  }
  const payloadOf = (record) => (record.obj && typeof record.obj.payload === 'object' && record.obj.payload ? record.obj.payload : record.obj);
  const eventOf = (record, name) => record.obj?.type === 'event_msg' && payloadOf(record)?.type === name;
  // 実測では thread_id(--json の thread.started と保存ログのファイル名/session_meta.id)と
  // turn_id(turn_context/task_complete の回合)は**別の値**。混同しない。
  const sessionMeta = records.find((record) => record.obj?.type === 'session_meta');
  const threadId = String(payloadOf(sessionMeta)?.id || '');
  if (!threadId) throw Error('sol session thread id missing');
  const completions = records.filter((record) => eventOf(record, 'task_complete'));
  if (completions.length !== 1) throw Error(`sol session task_complete count invalid: ${completions.length}`);
  const completion = completions[0];
  const turnId = String(payloadOf(completion)?.turn_id || '');
  if (!turnId) throw Error('sol session turn id missing');
  const ownContexts = records.filter((record) => record.obj?.type === 'turn_context' && String(payloadOf(record)?.turn_id || '') === turnId);
  if (ownContexts.length !== 1) throw Error(`sol session turn_context count invalid: ${ownContexts.length}`);
  const context = ownContexts[0];
  const started = records.find((record) => eventOf(record, 'task_started') && String(payloadOf(record)?.turn_id || '') === turnId);
  const start = started ? started.ordinal : context.ordinal;
  const end = completion.ordinal;
  if (end <= start) throw Error('sol session window invalid');
  // ③ その回合の turn_context は task_complete より前にあること。
  if (context.ordinal <= start || context.ordinal >= end) throw Error('sol session turn_context outside the turn window');
  // ④ 窓の内側に別ターンの境界(turn_context / task_started / task_complete)を跨がないこと。
  const foreignContexts = records.filter((record) => record.ordinal > start && record.ordinal < end
    && record.obj?.type === 'turn_context' && record.ordinal !== context.ordinal);
  const foreignStarts = records.filter((record) => record.ordinal > start && record.ordinal < end && eventOf(record, 'task_started'));
  const foreignCompletes = records.filter((record) => record.ordinal > start && record.ordinal < end && eventOf(record, 'task_complete'));
  if (foreignContexts.length) throw Error('sol session foreign turn_context inside the turn window');
  if (foreignStarts.length || foreignCompletes.length) throw Error('sol session foreign turn boundary inside the turn window');
  const inWindow = records.filter((record) => record.ordinal > start && record.ordinal < end
    && record.obj?.type === 'response_item' && payloadOf(record)?.type === 'message');
  const prompts = inWindow.filter((record) => payloadOf(record)?.role === 'user');
  const finals = inWindow.filter((record) => payloadOf(record)?.role === 'assistant'
    && String(payloadOf(record)?.phase || '').toLowerCase() === 'final_answer');
  if (!prompts.length) throw Error('sol session prompt missing');
  if (finals.length !== 1) throw Error(`sol session final answer count invalid: ${finals.length}`);
  // ② 対象入力はすべて回答より前にあること。
  if (!prompts.every((record) => record.ordinal < finals[0].ordinal)) throw Error('sol session prompt after the final answer');
  // ① 回答の明示的な所属: 同じ item.id の item_completed(AgentMessage) がこのターンを指し、
  //    task_complete.last_agent_message がこの回答と一致すること。
  const finalPayload = payloadOf(finals[0]);
  const finalId = String(finalPayload?.id || '');
  if (!finalId) throw Error('sol session final answer id missing');
  const answerEvents = records.filter((record) => eventOf(record, 'item_completed')
    && payloadOf(record)?.item?.type === 'AgentMessage' && String(payloadOf(record)?.item?.id || '') === finalId);
  if (answerEvents.length !== 1) throw Error(`sol session final answer item_completed count invalid: ${answerEvents.length}`);
  if (String(payloadOf(answerEvents[0])?.turn_id || '') !== turnId) throw Error('sol session final answer turn mismatch');
  if (answerEvents[0].ordinal <= start || answerEvents[0].ordinal >= end) throw Error('sol session final answer item_completed outside the turn window');
  const finalText = solAssistantContent(finalPayload);
  if (String(payloadOf(completion)?.last_agent_message ?? '') !== finalText) throw Error('sol session task_complete last_agent_message mismatch');
  const contextPayload = payloadOf(context);
  const model = String(contextPayload?.model || '');
  const effort = String(contextPayload?.effort || contextPayload?.reasoning_effort || '');
  const sandbox = String(contextPayload?.sandbox_policy?.type || contextPayload?.sandbox || '');
  if (!model) throw Error('sol session model missing');
  if (!effort) throw Error('sol session effort missing');
  if (sandbox !== SOL_SESSION_SANDBOX) throw Error(`sol session sandbox mismatch: ${sandbox || '(none)'}`);
  const promptText = prompts.map((record) => solAssistantContent(payloadOf(record))).join('\n');
  if (!promptText.trim()) throw Error('sol session prompt missing');
  if (!finalText.trim()) throw Error('sol session final answer missing');
  if (model !== SOL_PRIMARY_MODEL) throw Error(`sol session model mismatch: ${model || '(none)'}`);
  if (effort !== SOL_PRIMARY_EFFORT) throw Error(`sol session effort mismatch: ${effort || '(none)'}`);
  // 受理側でも「信頼済み保存元の実ファイルに由来すること」を確かめる。receipt 配下のコピーだけを
  // 合成しても通らない。保存元が消えている/読めない/別の実体なら未確認として止める。
  const source = String(ref.sessionSource || '');
  if (!path.isAbsolute(source)) throw Error('sol session source must be an absolute path in the trusted store');
  let sourceRoot = '';
  try { sourceRoot = fs.realpathSync(solTrustedSessionRoot(home)); } catch { throw Error('sol session trusted store is unreadable'); }
  let realSource = '';
  try { realSource = fs.realpathSync(source); } catch { throw Error(`SOL_SESSION_SOURCE_UNREADABLE: ${source}`); }
  if (!(realSource === sourceRoot || realSource.startsWith(sourceRoot + path.sep))) throw Error('sol session source is outside the trusted store');
  if (!path.basename(realSource).endsWith(`-${threadId}.jsonl`)) throw Error('sol session source name does not carry the thread id');
  const sourceBytes = fs.readFileSync(realSource);
  if (sha(sourceBytes) !== String(ref.sessionSourceHash || '')) throw Error('sol session source hash mismatch');
  if (!sourceBytes.equals(bytes)) throw Error('sol session copy differs from the trusted store file');
  return {model, effort, sandbox, threadId, turnId, finalText, promptText};
}
export function solPrimaryEvidence(root, file, {task, round, lens, current=true, home=''}={}) {
  const receipt=JSON.parse(regular(file));
  if (receipt.kind!==SOL_PRIMARY_KIND || receipt.schemaVersion!==1) throw Error('sol primary evidence kind/schema mismatch');
  if (receipt.reviewer!=='sol' || receipt.model!==SOL_PRIMARY_MODEL || receipt.effort!==SOL_PRIMARY_EFFORT) throw Error('sol primary evidence reviewer/model mismatch');
  if (receipt.taskId!==task.taskId || receipt.taskFingerprint!==task.taskFingerprint || receipt.round!==round || receipt.lens!==lens) throw Error('sol primary review task/round/lens mismatch');
  const base=path.dirname(file);
  const turn=verifySolSession(base,receipt,{home});
  const result=JSON.parse(artifact(base,receipt.result,receipt.resultHash));
  if (!['pass','findings'].includes(result.verdict) || !Array.isArray(result.findings) || !Array.isArray(result.unverified) || (result.verdict==='pass')!==(result.findings.length===0)) throw Error('invalid sol review result');
  if (result.promptHash!==receipt.promptHash || result.manifestHash!==receipt.manifestHash) throw Error('sol review input binding mismatch');
  if (String(result.actual?.model||'')!==turn.model || String(result.actual?.effort||'')!==turn.effort) throw Error('sol result differs from session runtime');
  const parsed=JSON.parse(String(turn.finalText).trim().replace(/^```(?:json)?\s*|\s*```$/g,''));
  for (const key of ['verdict','findings','unverified']) if (JSON.stringify(parsed[key])!==JSON.stringify(result[key])) throw Error('sol result differs from provider response');
  const prompt=artifact(base,receipt.prompt,receipt.promptHash);
  const promptText=prompt.toString('utf8');
  if (!turn.promptText.includes(promptText)) throw Error('sol session prompt does not contain the reviewed prompt');
  // 実測の `--json` 標準出力と保存ログを結び付ける。同じ thread_id で、stdout の最終 agent_message が
  // 保存ログの最終回答(=result)と一致すること。片方だけ差し替えた receipt を通さない。
  if (typeof receipt.codexStdout !== 'string' || !receipt.codexStdout) throw Error('sol primary evidence is missing the codex stdout transcript');
  const stdoutText = artifact(base, receipt.codexStdout, receipt.codexStdoutHash).toString('utf8');
  let stdoutThread = '';
  let agentText = null;
  for (const line of stdoutText.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj?.type === 'thread.started' && typeof obj.thread_id === 'string') stdoutThread = obj.thread_id;
    if (obj?.type === 'item.completed' && obj.item?.type === 'agent_message' && typeof obj.item.text === 'string') agentText = obj.item.text;
  }
  if (!stdoutThread || stdoutThread !== turn.threadId) throw Error('sol codex stdout thread does not match the saved session');
  if (agentText === null) throw Error('sol codex stdout has no agent_message');
  let agentParsed;
  try { agentParsed = JSON.parse(String(agentText).trim().replace(/^```(?:json)?\s*|\s*```$/g,'')); }
  catch (error) { throw Error(`sol codex stdout agent_message is not JSON: ${error.message}`); }
  for (const key of ['verdict','findings','unverified']) if (JSON.stringify(agentParsed[key])!==JSON.stringify(result[key])) throw Error('sol codex stdout differs from the saved session answer');
  const manifestBytes=artifact(base,receipt.manifest,receipt.manifestHash);
  const manifest=JSON.parse(manifestBytes);
  verifyManifest(root,manifest,{current});
  if (!promptText.includes(receipt.manifestHash)) throw Error('sol review input binding mismatch');
  if (!lensTags[lens] || !promptText.includes(lensTags[lens])) throw Error('sol primary review prompt lens mismatch');
  if (result.verdict!=='pass' || result.unverified.length) throw Error('sol primary review has unresolved findings/unverified items');
  assertWholeVersionCoverage(manifest);
  if (current) {
    verifyChangedScope(root,new Set(manifest.files.map(entry=>entry.path)),receipt.reviewBaseCommit);
    verifyDeletedBase(root,manifest,receipt.reviewBaseCommit);
    const head=spawnSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'});
    if (head.status!==0 || receipt.reviewHeadCommit!==head.stdout.trim() || receipt.approvalHash!==sha(regular(path.join(root,'.ai/approval.json')))) throw Error('sol primary review HEAD/approval mismatch');
  }
  const binding=JSON.stringify({taskId:task.taskId,taskFingerprint:task.taskFingerprint,round,lens,reviewBaseCommit:receipt.reviewBaseCommit,reviewHeadCommit:receipt.reviewHeadCommit,approvalHash:receipt.approvalHash,manifestHash:receipt.manifestHash});
  if (!promptText.includes('Review binding: '+binding)) throw Error('sol primary review input does not bind task/approval/version');
  return {status:'completed',reviewer:'sol',model:turn.model,effort:turn.effort,round,lens,evidencePath:path.resolve(file),evidenceHash:sha(regular(file)),manifestHash:receipt.manifestHash,reviewBaseCommit:receipt.reviewBaseCommit,reviewHeadCommit:receipt.reviewHeadCommit,approvalHash:receipt.approvalHash,verdict:result.verdict};
}

// 本番の受理専用の入口(OPEN-ITEMS §10, 2026-10-15)。差し替え(注入)の引数を**持たない**。
// 受理側の設定である acceptSessionHome() からだけ錨を導くので、提出側が SOL_CODEX_HOME や HOME を
// 設定しても受理の保存元は動かない。テストで差し替えたいときは solPrimaryEvidence を `home` 付きで使う
// (それが分離された「テスト経路」)。
export function solPrimaryEvidenceAccepted(root, file, {task, round, lens, current=true}={}) {
  // 受理の入口であることをここで確定させてから照合する。提出側が設定した差し替えの指定は無効化する。
  sealSubmitterSessionHome();
  const home = acceptSessionHome();
  // acceptSessionHome() が空を返す環境では、環境変数へ落ちて錨が動き得る。黙って進めない(fail-closed)。
  if (!home) throw Error('SOL_ACCEPT_HOME_UNRESOLVED: 受理側の保存元の錨を実行ユーザーのホームから決められません');
  return solPrimaryEvidence(root, file, {task, round, lens, current, home});
}

export function primarySplitEvidence(root, aggregate, {task, round, lens, plan, current=true}={}) {
  const data = typeof aggregate === 'string' ? JSON.parse(regular(aggregate)) : aggregate;
  if (!data || data.kind !== 'primary-review-split-aggregate-v1' || data.schemaVersion !== 1) throw Error('split aggregate invalid');
  if (data.taskId !== task.taskId || data.taskFingerprint !== task.taskFingerprint || data.round !== round || data.lens !== lens) throw Error('split aggregate task/round/lens mismatch');
  if (!/^[a-f0-9]{64}$/u.test(String(data.planHash || '')) || !Number.isSafeInteger(data.total) || data.total <= 0) throw Error('split aggregate plan invalid');
  if (!plan || plan.planHash !== data.planHash || plan.total !== data.total || !Array.isArray(plan.parts) || plan.parts.length !== data.total) throw Error('split aggregate plan mismatch');
  if (!Array.isArray(plan.unverified) || plan.unverified.length || !Array.isArray(plan.evidenceIssues) || plan.evidenceIssues.length) throw Error('split aggregate plan unverified/evidence issues');
  if (!Array.isArray(data.parts) || data.parts.length !== data.total) throw Error('split aggregate parts invalid');
  const byIndex = new Map();
  const receiptHashes = new Set();
  const partResults = [];
  for (const part of plan.parts) {
    if (!part || part.over) throw Error('split aggregate over part rejected');
    if (byIndex.has(part.index)) throw Error('split aggregate duplicate planned index');
    const entry = data.parts.find((x) => x && x.index === part.index);
    if (!entry) throw Error('split aggregate missing part');
    if (entry.manifestHash !== part.manifestHash) throw Error('split aggregate manifest mismatch');
    if (!entry.receiptRef || typeof entry.receiptRef.path !== 'string' || !/^[a-f0-9]{64}$/u.test(String(entry.receiptRef.sha256 || ''))) throw Error('split aggregate receipt ref invalid');
    const receiptAbs = path.resolve(root, entry.receiptRef.path);
    if (!receiptAbs.startsWith(path.resolve(root) + path.sep)) throw Error('split aggregate receipt path escapes root');
    const receiptBytes = regular(receiptAbs);
    if (sha(receiptBytes) !== entry.receiptRef.sha256) throw Error('split aggregate receipt hash mismatch');
    if (receiptHashes.has(entry.receiptRef.sha256)) throw Error('split aggregate duplicate receipt');
    receiptHashes.add(entry.receiptRef.sha256);
    const receipt = JSON.parse(receiptBytes);
    if (receipt.taskId !== task.taskId || receipt.taskFingerprint !== task.taskFingerprint || receipt.round !== round || receipt.lens !== lens) throw Error('split aggregate receipt task/round/lens mismatch');
    const verified = verifyProviderEvidence(root, path.dirname(receiptAbs), receipt, 'deepseek', {current});
    if (verified.manifestHash !== part.manifestHash) throw Error('split aggregate verified manifest mismatch');
    if (verified.manifest.planHash !== data.planHash || verified.manifest.index !== part.index || verified.manifest.total !== data.total) throw Error('split aggregate verified manifest plan/index/total mismatch');
    const expected = JSON.parse(part.manifest);
    if (JSON.stringify(expected.chunks) !== JSON.stringify(verified.manifest.chunks)) throw Error('split aggregate chunk mismatch');
    if (verified.result.verdict !== 'pass' || (Array.isArray(verified.result.findings) && verified.result.findings.length) || (Array.isArray(verified.result.unverified) && verified.result.unverified.length)) throw Error('split aggregate unresolved part');
    if (current) {
      verifyChangedScope(root, new Set(verified.manifest.files.map((entryFile) => entryFile.path)), receipt.reviewBaseCommit);
      verifyDeletedBase(root, verified.manifest, receipt.reviewBaseCommit);
      const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'});
      if (head.status !== 0 || receipt.reviewHeadCommit !== head.stdout.trim() || receipt.approvalHash !== sha(regular(path.join(root, '.ai/approval.json')))) throw Error('split aggregate HEAD/approval mismatch');
    }
    byIndex.set(part.index, entry);
    partResults.push({index: part.index, manifestHash: part.manifestHash, receiptHash: entry.receiptRef.sha256, receiptPath: entry.receiptRef.path});
  }
  for (const entry of data.parts) {
    if (!Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= data.total || !byIndex.has(entry.index)) throw Error('split aggregate index invalid');
  }
  return {status:'completed', verdict:'pass', planHash:data.planHash, total:data.total, parts:partResults.sort((a,b)=>a.index-b.index), evidenceHash:sha(JSON.stringify(data))};
}

// 完了ゲートが受理する外部経路の「終了」状態。未確認事項は記録して完了させ、
// 検証そのものが成立していない状態(unavailable / 途中)だけを止める。通常経路の
// codeReviewClosed と同じ扱いに揃える（R1 F1-2）。
export const EXTERNAL_REVIEW_SETTLED_OUTCOMES = ['passed_clean', 'passed_with_unverified'];
export function externalReviewSettled(outcome) {
  return EXTERNAL_REVIEW_SETTLED_OUTCOMES.includes(outcome);
}
// 2026-09-28 (T1-T5 review gate R1): native CLI session evidence is a separate type from
// the direct-API provider receipts (verifyProviderEvidence / primaryEvidence). The reason
// is that a native CLI JSONL does not carry the provider-attested finish_reason; turning
// task_complete into finish_reason 'stop' would fabricate a raw API receipt. This path
// therefore rejects any finish_reason / finishReason field anywhere, and a round verified
// here may not claim the deepseek-opus-v1 chain.
export const NATIVE_REVIEW_EVIDENCE = 'native-cli-session-v1';
export const NATIVE_ACCEPTED_MODELS = ['deepseek-flash', 'deepseek-v4.1-flash'];
export const NATIVE_EFFORT = 'high';
export const NATIVE_SANDBOX = 'read-only';
export const NATIVE_REVIEWER_ROLES = ['independent_reviewer'];
// 2026-09-28 (native dual-review acceptance): the severity vocabulary of a DeepSeek primary
// finding. P0/P1 block a clean round; P2/P3 stay as non-blocking records. A finding whose
// severity or evidence is missing is never silently downgraded to P2/P3: it is held as an
// important unknown so the acceptance gate can never call the round clean.
export const NATIVE_FINDING_SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
// 2026-09-29 (CMGB native focused CALLER): the focused recheck targets are a request-owned list
// (nativeFocusedTargets + nativeFocusedTargetsHash). The pinned hash line and every target's original
// text must have reached the real reviewer turn's user content, and the reviewer's final answer must
// carry exactly one decision per pinned key. These pins are trusted caller inputs and are never read
// from the receipt, so a receipt cannot invent, drop or rename a target. A caller that passes no pins
// keeps the previous behaviour unchanged.
export const NATIVE_FOCUSED_TARGET_LIMIT = 200;
export const NATIVE_FOCUSED_DECISIONS = ['resolved', 'nonblocking', 'open'];
const NATIVE_FINAL_PHASE = 'final_answer';
const NATIVE_SESSION_MAX_BYTES = 512 * 1024 * 1024;

// The trusted Codex session store. The producer command derives this from the running
// official home and only accepts a caller root that resolves inside it; the accepted value is
// never read from a receipt. `trustedCodexSessionRoot` is pure so a test can inject a
// separate home, and `resolveTrustedSessionRoot` is the single place a requested root is
// allowed through or rejected.
export const TRUSTED_SESSION_ROOT_SEGMENTS = ['.codex', 'sessions'];
export const NATIVE_IMPLEMENTER_SANDBOXES = ['read-only', 'workspace-write'];
export const IMPLEMENTER_SESSIONS_SCHEMA = 1;
export const NATIVE_IMPLEMENTER_CHAIN = 'deepseek-native-cli-v1';
export function trustedCodexSessionRoot(home) {
  const base = typeof home === 'string' && home ? home : homedir();
  return path.join(base, ...TRUSTED_SESSION_ROOT_SEGMENTS);
}
// 2026-09-29 (CMGB two-root acceptance): the CMGB T0-T5 recovery lane keeps its OLD implementer
// sessions on the C drive and must also keep its NEW DeepSeek reviewer sessions on the G drive,
// because the C drive ran out of room and the finished logs could not be freed. The second reviewer
// store is accepted only for this one exact task/fingerprint/repo, only at one exact G path, never
// through a symlink or junction, and it never becomes the place the implementer sessions are read
// from. Every value here is a caller-fixed constant of this module; it is never read from a receipt,
// a request body or the operator's --session-root value.
export const CMGB_NATIVE_REVIEW_IDENTITY = Object.freeze({
  taskId: 'cmgb-t0-t5-local-recovery-20260927',
  taskFingerprint: 'cmgb-local-recovery-20260927-t0-t5',
  repo: 'cmgb-recovery',
});
export const CMGB_NATIVE_REVIEWER_ROOT = path.join('G:\\', 'CMGB-Recovery', 'reports', 'cmg-workflow-supervisor-20260926', 'runtime', 'cmgb-native-deepseek', 'codex-home', 'sessions');
// Pure. The CMGB reviewer store is a fixed constant; `reviewerRoot` is an explicit injection point
// for a fixture and is never passed by the official command path, so a published run can only ever
// see the constant above. A task that is not the one CMGB recovery task has no second store at all.
export function cmgbNativeReviewTask(task) {
  const identity = CMGB_NATIVE_REVIEW_IDENTITY;
  return Boolean(task)
    && String(task.taskId ?? '').trim() === identity.taskId
    && String(task.taskFingerprint ?? '').trim() === identity.taskFingerprint
    && String(task.repo ?? '').trim() === identity.repo;
}
export function cmgbNativeReviewerRoot(task, reviewerRoot = '') {
  if (!cmgbNativeReviewTask(task)) return '';
  return typeof reviewerRoot === 'string' && reviewerRoot ? path.resolve(reviewerRoot) : CMGB_NATIVE_REVIEWER_ROOT;
}
// A junction or symlink above the store would make an exact-path acceptance point somewhere else, so
// the chain from the drive root down to the requested store must be made of real directories.
function nativeAssertRealParentChain(target) {
  const abs = path.resolve(target);
  const {root} = path.parse(abs);
  let current = root;
  for (const segment of abs.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch { nativeFail('NATIVE_SESSION_ROOT_UNREACHABLE', 'the requested reviewer session store cannot be walked'); }
    if (stat.isSymbolicLink()) nativeFail('NATIVE_SESSION_ROOT_REPARSE', 'the CMGB reviewer session store must not pass through a symlink or junction');
  }
}
// The implementer set is always re-verified from the running official Codex home, so selecting the
// CMGB reviewer store for the reviewer never moves, widens or re-points it.
export function nativeImplementerSessionRoot(task, reviewerRoot, {home = '', cmgbReviewerRoot = ''} = {}) {
  const cmgb = cmgbNativeReviewerRoot(task, cmgbReviewerRoot);
  if (!cmgb) return reviewerRoot;
  let reviewerReal = '';
  let fixedReal = '';
  try { reviewerReal = fs.realpathSync(reviewerRoot); } catch { return reviewerRoot; }
  try { fixedReal = fs.realpathSync(cmgb); } catch { return reviewerRoot; }
  return reviewerReal === fixedReal ? trustedCodexSessionRoot(home) : reviewerRoot;
}
// For the CMGB task the reviewer store must be the legacy Codex store derived from the running
// official home or the one fixed second store. This holds for every internal caller, including the
// receipt verifier, and is not a value a receipt can choose.
function nativeAssertReviewerRoot(task, sessionRoot, {home = '', cmgbReviewerRoot = ''} = {}) {
  if (!cmgbNativeReviewTask(task)) return;
  let reviewerReal = '';
  try { reviewerReal = fs.realpathSync(sessionRoot); } catch { nativeFail('NATIVE_SESSION_ROOT_UNREADABLE', 'sessionRoot'); }
  let legacyReal = '';
  try { legacyReal = fs.realpathSync(trustedCodexSessionRoot(home)); } catch { legacyReal = ''; }
  if (legacyReal && (reviewerReal === legacyReal || reviewerReal.startsWith(legacyReal + path.sep))) return;
  const cmgb = cmgbNativeReviewerRoot(task, cmgbReviewerRoot);
  let fixedReal = '';
  try { fixedReal = fs.realpathSync(cmgb); } catch { fixedReal = ''; }
  if (fixedReal && reviewerReal === fixedReal) { nativeAssertRealParentChain(sessionRoot); return; }
  nativeFail('NATIVE_SESSION_ROOT_UNTRUSTED', 'the CMGB reviewer store must be the legacy Codex session store or the fixed CMGB reviewer store');
}
export function resolveTrustedSessionRoot(trustedRoot, requestedRoot, {task = null, cmgbReviewerRoot = ''} = {}) {
  let trusted;
  try { trusted = fs.realpathSync(trustedRoot); } catch { nativeFail('NATIVE_SESSION_ROOT_UNREADABLE', 'the trusted session root cannot be read'); }
  if (requestedRoot === undefined || requestedRoot === null || requestedRoot === '') return trusted;
  let requested;
  try { requested = fs.realpathSync(requestedRoot); } catch { nativeFail('NATIVE_SESSION_ROOT_UNREADABLE', 'requestedRoot'); }
  if (requested === trusted || requested.startsWith(trusted + path.sep)) return requested;
  // 2026-09-29 (CMGB two-root acceptance): a second, task-locked reviewer store is accepted only when
  // the fixed CMGB store realpath is exactly the requested realpath and no symlink or junction sits
  // above the requested path. An arbitrary --session-root, a copy of the store, a differently named
  // task, a junction or a spoofed C path all stay rejected.
  const cmgb = cmgbNativeReviewerRoot(task, cmgbReviewerRoot);
  if (cmgb) {
    let fixed = '';
    try { fixed = fs.realpathSync(cmgb); } catch { fixed = ''; }
    if (fixed && requested === fixed) {
      nativeAssertRealParentChain(requestedRoot);
      return requested;
    }
  }
  nativeFail('NATIVE_SESSION_ROOT_UNTRUSTED', 'the session root must resolve inside the trusted Codex session store, or be the fixed CMGB reviewer store for the CMGB recovery task');
}

function nativeFail(code, detail) {
  throw Error(detail ? code + ': ' + detail : code);
}
function nativeWalk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) { for (const item of value) nativeWalk(item, visit); } else nativeWalk(value, visit);
  }
}
const nativeNorm = value => String(value === undefined || value === null ? '' : value).replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase();
function nativeMessageText(payload, allowed) {
  if (!Array.isArray(payload.content) || payload.content.length === 0) nativeFail('NATIVE_RESPONSE_ITEM_CONTENT_INVALID', 'empty');
  let text = '';
  for (const item of payload.content) {
    if (!item || item.type !== allowed || typeof item.text !== 'string') nativeFail('NATIVE_RESPONSE_ITEM_CONTENT_INVALID', 'type=' + String(item && item.type));
    text += item.text;
  }
  return text;
}

function nativeFocusedPins(expectedFocusedTargetsHash, expectedFocusedTargets) {
  if (expectedFocusedTargetsHash === undefined || expectedFocusedTargetsHash === null || expectedFocusedTargetsHash === '') return null;
  if (typeof expectedFocusedTargetsHash !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedFocusedTargetsHash)) {
    nativeFail('NATIVE_FOCUSED_TARGETS_HASH_INVALID', 'expectedFocusedTargetsHash is not a 64-hex digest');
  }
  if (!Array.isArray(expectedFocusedTargets)) nativeFail('NATIVE_FOCUSED_TARGETS_INVALID', 'expectedFocusedTargets must be an array');
  if (expectedFocusedTargets.length > NATIVE_FOCUSED_TARGET_LIMIT) {
    nativeFail('NATIVE_FOCUSED_TARGETS_LIMIT', 'count=' + expectedFocusedTargets.length);
  }
  const seen = new Set();
  const targets = expectedFocusedTargets.map((target, index) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) nativeFail('NATIVE_FOCUSED_TARGET_INVALID', 'index=' + index);
    const key = String(target.key || '');
    if (!/^[a-f0-9]{64}$/u.test(key)) nativeFail('NATIVE_FOCUSED_TARGET_KEY', 'index=' + index);
    if (seen.has(key)) nativeFail('NATIVE_FOCUSED_TARGET_DUPLICATE', key.slice(0, 120));
    seen.add(key);
    const originalText = typeof target.originalText === 'string' ? target.originalText : '';
    if (!originalText.trim()) nativeFail('NATIVE_FOCUSED_TARGET_TEXT', key.slice(0, 120));
    return {key, originalText};
  });
  return {hash: expectedFocusedTargetsHash, targets, keys: targets.map((target) => target.key)};
}

function nativeFocusedDecisions(value, expectedKeys) {
  if (!Array.isArray(value)) nativeFail('NATIVE_FOCUSED_DECISIONS_MISSING', 'recheckDecisions must be an array');
  const seen = new Map();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) nativeFail('NATIVE_FOCUSED_DECISION_INVALID', 'item');
    const key = String(item.key || '');
    if (!/^[a-f0-9]{64}$/u.test(key)) nativeFail('NATIVE_FOCUSED_DECISION_KEY', key.slice(0, 120));
    const decision = String(item.decision || '').trim().toLowerCase();
    if (!NATIVE_FOCUSED_DECISIONS.includes(decision)) nativeFail('NATIVE_FOCUSED_DECISION_VALUE', key.slice(0, 120));
    const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : '';
    if (!evidence) nativeFail('NATIVE_FOCUSED_DECISION_EVIDENCE', key.slice(0, 120));
    if (seen.has(key)) nativeFail('NATIVE_FOCUSED_DECISION_DUPLICATE', key.slice(0, 120));
    seen.set(key, {key, decision, evidence});
  }
  if (seen.size !== expectedKeys.length || expectedKeys.some((key) => !seen.has(key))) {
    nativeFail('NATIVE_FOCUSED_DECISION_SET', 'expected=' + expectedKeys.length + ' actual=' + seen.size);
  }
  return expectedKeys.map((key) => seen.get(key));
}
// The reviewer session file must be proven to come from the trusted session store. The
// trusted root is a caller input and must never be read from the receipt, otherwise a
// synthetic JSONL at an arbitrary path could pass as a real reviewer session. The file
// name must also carry the session id, so a renamed copy cannot stand in for it.
// Read the real bytes of one session file only after it is proven to live under the trusted
// session root. Returns the resolved path, the resolved root, the raw bytes and the lines so
// the caller can hash exactly what it verified.
function nativeSessionBytes(file, sessionRoot) {
  if (typeof sessionRoot !== 'string' || !sessionRoot) nativeFail('NATIVE_SESSION_ROOT_MISSING', 'the trusted session root is a caller input; it must never come from the receipt');
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) nativeFail('NATIVE_SESSION_PATH_INVALID');
  const real = fs.realpathSync(file);
  let rootReal;
  try { rootReal = fs.realpathSync(sessionRoot); } catch { nativeFail('NATIVE_SESSION_ROOT_UNREADABLE', 'sessionRoot=' + String(sessionRoot).length + 'ch'); }
  if (!(real === rootReal || real.startsWith(rootReal + path.sep))) nativeFail('NATIVE_SESSION_OUTSIDE_ROOT', 'the session file must live under the trusted session root');
  const stat = fs.lstatSync(real);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > NATIVE_SESSION_MAX_BYTES) nativeFail('NATIVE_SESSION_UNSAFE', 'bytes=' + stat.size);
  const bytes = fs.readFileSync(real);
  const text = bytes.toString('utf8');
  if (text.includes('\u0000')) nativeFail('NATIVE_SESSION_BINARY');
  return {real, rootReal, bytes, lines: text.split(/\r?\n/u).filter(Boolean)};
}
function nativeSnapshot(file, sessionRoot, sessionId) {
  const snapshot = nativeSessionBytes(file, sessionRoot);
  if (typeof sessionId !== 'string' || !sessionId || !path.basename(snapshot.real).toLowerCase().includes(sessionId.toLowerCase())) nativeFail('NATIVE_SESSION_FILENAME_MISMATCH', 'the session file name must carry the session id');
  return snapshot.lines;
}
// Bind exactly one turn of a native session JSONL. Returns counts, lengths, hashes and the
// measured values only; the message text goes back to the caller for the binding checks and
// is never logged here. The same turn may re-emit an identical turn_context and may emit
// segment-separated intermediate final answers; the terminal answer is the last one inside
// its own completed turn.
export function bindNativeTurn(lines, {turnId='', expectedCwd='', expectedSessionId='', allowedSandboxes=[NATIVE_SANDBOX]}={}) {
  if (!turnId) nativeFail('NATIVE_TURN_ID_MISSING');
  const records = lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  });
  let metaId = '';
  let metaCount = 0;
  let finishReason = 0;
  records.forEach(record => {
    if (!record) return;
    nativeWalk(record, node => { if (Object.hasOwn(node, 'finish_reason') || Object.hasOwn(node, 'finishReason')) finishReason += 1; });
    if (record.type === 'session_meta' && typeof record.payload?.id === 'string' && record.payload.id) { metaId = record.payload.id; metaCount += 1; }
  });
  if (metaCount !== 1) nativeFail('NATIVE_SESSION_META_ID_MISSING', 'count=' + metaCount);
  if (expectedSessionId && nativeNorm(metaId) !== nativeNorm(expectedSessionId)) nativeFail('NATIVE_SESSION_ID_MISMATCH', 'meta=' + metaId.length + 'ch');
  if (finishReason) nativeFail('NATIVE_FINISH_REASON_FORBIDDEN', 'count=' + finishReason);
  const contexts = [];
  const boundaries = [];
  const completions = [];
  records.forEach((record, ordinal) => {
    if (!record) return;
    if (record.type === 'turn_context') { contexts.push({ordinal, payload: record.payload || {}}); boundaries.push(ordinal); }
    else if (record.type === 'event_msg' && record.payload?.type === 'task_complete') {
      boundaries.push(ordinal);
      if (record.payload.turn_id === turnId) completions.push({ordinal, payload: record.payload});
    }
  });
  const selected = contexts.filter(item => item.payload.turn_id === turnId);
  if (selected.length === 0) nativeFail('NATIVE_TURN_CONTEXT_MISSING', 'contexts=' + contexts.length);
  if (completions.length === 0) nativeFail('NATIVE_TASK_COMPLETE_MISSING');
  if (completions.length > 1) nativeFail('NATIVE_TASK_COMPLETE_AMBIGUOUS', 'count=' + completions.length);
  const context = selected[0];
  const completion = completions[0];
  const ownContexts = new Set(selected.map(item => item.ordinal));
  const signature = item => [String(item.payload.model || ''), String(item.payload.effort || ''), String(item.payload.sandbox_policy?.type || ''), nativeNorm(item.payload.cwd)].join('|');
  for (const item of selected) if (signature(item) !== signature(context)) nativeFail('NATIVE_CONTEXT_INCONSISTENT', 'ordinal=' + item.ordinal);
  const model = String(context.payload.model || '');
  const effort = String(context.payload.effort || '');
  const sandbox = String(context.payload.sandbox_policy?.type || '');
  if (!NATIVE_ACCEPTED_MODELS.includes(model)) nativeFail('NATIVE_MODEL_NOT_ACCEPTED', 'model=' + model);
  if (effort !== NATIVE_EFFORT) nativeFail('NATIVE_EFFORT_MISMATCH', 'effort=' + effort);
  if (!allowedSandboxes.includes(sandbox)) nativeFail('NATIVE_SANDBOX_MISMATCH', 'sandbox=' + sandbox);
  if (expectedCwd && nativeNorm(context.payload.cwd) !== nativeNorm(expectedCwd)) nativeFail('NATIVE_CWD_MISMATCH', 'cwd=' + nativeNorm(context.payload.cwd));
  if (completion.ordinal <= context.ordinal) nativeFail('NATIVE_WINDOW_INVALID', 'context=' + context.ordinal + ' complete=' + completion.ordinal);
  const foreign = boundaries.filter(ordinal => ordinal > context.ordinal && ordinal < completion.ordinal && !ownContexts.has(ordinal));
  if (foreign.length) nativeFail('NATIVE_WINDOW_OVERLAPS_FOREIGN_TURN', 'count=' + foreign.length);
  const prompts = [];
  const finals = [];
  const usages = [];
  records.forEach((record, ordinal) => {
    if (!record || ordinal <= context.ordinal || ordinal > completion.ordinal) return;
    if (ordinal < completion.ordinal && record.type === 'response_item' && record.payload?.type === 'message') {
      if (record.payload.role === 'user') prompts.push({ordinal, payload: record.payload});
      else if (record.payload.role === 'assistant' && record.payload.phase === NATIVE_FINAL_PHASE) finals.push({ordinal, payload: record.payload});
    }
    if (record.type === 'event_msg' && record.payload?.type === 'token_count') usages.push(record.payload.info?.total_token_usage);
  });
  if (prompts.length === 0) nativeFail('NATIVE_PROMPT_MISSING');
  if (prompts.length > 1) nativeFail('NATIVE_PROMPT_AMBIGUOUS', 'count=' + prompts.length);
  if (finals.length === 0) nativeFail('NATIVE_FINAL_MISSING');
  for (let index = 0; index + 1 < finals.length; index += 1) {
    const segmentBreak = [...ownContexts].some(ordinal => ordinal > finals[index].ordinal && ordinal < finals[index + 1].ordinal);
    if (!segmentBreak) nativeFail('NATIVE_FINAL_AMBIGUOUS', 'count=' + finals.length + ' segment=' + finals[index].ordinal);
  }
  const promptItem = prompts[0];
  const finalItem = finals[finals.length - 1];
  if (finalItem.ordinal <= promptItem.ordinal) nativeFail('NATIVE_ORDER_INVALID', 'prompt=' + promptItem.ordinal + ' final=' + finalItem.ordinal);
  const usage = usages[usages.length - 1];
  if (!usage || !Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens) || !Number.isInteger(usage.total_tokens) || usage.input_tokens < 0 || usage.output_tokens <= 0 || usage.total_tokens !== usage.input_tokens + usage.output_tokens) nativeFail('NATIVE_USAGE_MISSING');
  const promptText = nativeMessageText(promptItem.payload, 'input_text');
  const finalText = nativeMessageText(finalItem.payload, 'output_text');
  return {turnId, model, effort, sandbox, cwd: String(context.payload.cwd || ''), turnContextCount: selected.length, promptText, finalText, promptSha256: sha(promptText), promptLength: promptText.length, finalSha256: sha(finalText), finalLength: finalText.length, usage: {inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens}, ordinals: {context: context.ordinal, prompt: promptItem.ordinal, finalAnswer: finalItem.ordinal, taskComplete: completion.ordinal}};
}
// A completed implementer turn is a multi-message context, not a reviewer's single prompt.
// Verify it from its own window only: its own turn_context(s), the messages between them and
// its own task_complete. Nothing is borrowed from another turn, and the reviewer binding
// (`bindNativeTurn`) is not relaxed: the only difference is that an implementer turn may carry
// several user/assistant messages plus segment-separated final answers, which is never more
// tolerance for a foreign, mixed, unfinished or mismatched turn.
function implementerTurnFacts(records, {turnId='', expectedCwd='', allowedSandboxes=NATIVE_IMPLEMENTER_SANDBOXES}={}) {
  if (!turnId) nativeFail('NATIVE_TURN_ID_MISSING', 'implementer turn');
  const contexts = [];
  const boundaries = [];
  const completions = [];
  records.forEach((record, ordinal) => {
    if (!record) return;
    if (record.type === 'turn_context') { contexts.push({ordinal, payload: record.payload || {}}); boundaries.push(ordinal); }
    else if (record.type === 'event_msg' && record.payload?.type === 'task_complete') {
      boundaries.push(ordinal);
      if (record.payload.turn_id === turnId) completions.push(ordinal);
    }
  });
  const selected = contexts.filter(item => item.payload.turn_id === turnId);
  if (selected.length === 0) nativeFail('NATIVE_TURN_CONTEXT_MISSING', 'implementer turn=' + turnId);
  if (completions.length === 0) nativeFail('NATIVE_TASK_COMPLETE_MISSING', 'implementer turn=' + turnId);
  if (completions.length > 1) nativeFail('NATIVE_TASK_COMPLETE_AMBIGUOUS', 'implementer turn=' + turnId + ' count=' + completions.length);
  const context = selected[0];
  const completion = completions[0];
  if (completion <= context.ordinal) nativeFail('NATIVE_WINDOW_INVALID', 'context=' + context.ordinal + ' complete=' + completion);
  const ownContexts = new Set(selected.map(item => item.ordinal));
  const foreign = boundaries.filter(ordinal => ordinal > context.ordinal && ordinal < completion && !ownContexts.has(ordinal));
  if (foreign.length) nativeFail('NATIVE_WINDOW_OVERLAPS_FOREIGN_TURN', 'count=' + foreign.length);
  let prompts = 0;
  let firstPrompt = -1;
  let finals = 0;
  let firstFinal = -1;
  for (let ordinal = context.ordinal + 1; ordinal < completion; ordinal += 1) {
    const record = records[ordinal];
    if (!record || record.type !== 'response_item' || record.payload?.type !== 'message') continue;
    if (record.payload.role === 'user') { prompts += 1; if (firstPrompt < 0) firstPrompt = ordinal; }
    else if (record.payload.role === 'assistant' && record.payload.phase === NATIVE_FINAL_PHASE) { finals += 1; if (firstFinal < 0) firstFinal = ordinal; }
  }
  if (prompts === 0) nativeFail('NATIVE_PROMPT_MISSING', 'implementer turn=' + turnId);
  if (finals === 0) nativeFail('NATIVE_FINAL_MISSING', 'implementer turn=' + turnId);
  if (firstFinal <= firstPrompt) nativeFail('NATIVE_ORDER_INVALID', 'prompt=' + firstPrompt + ' final=' + firstFinal);
  const model = String(context.payload.model || '');
  const effort = String(context.payload.effort || '');
  const sandbox = String(context.payload.sandbox_policy?.type || '');
  if (!NATIVE_ACCEPTED_MODELS.includes(model)) nativeFail('NATIVE_MODEL_NOT_ACCEPTED', 'model=' + model);
  if (effort !== NATIVE_EFFORT) nativeFail('NATIVE_EFFORT_MISMATCH', 'effort=' + effort);
  if (!allowedSandboxes.includes(sandbox)) nativeFail('NATIVE_SANDBOX_MISMATCH', 'sandbox=' + sandbox);
  if (expectedCwd && nativeNorm(context.payload.cwd) !== nativeNorm(expectedCwd)) nativeFail('NATIVE_CWD_MISMATCH', 'cwd=' + nativeNorm(context.payload.cwd));
  return {turnId, model, effort, sandbox, cwd: String(context.payload.cwd || ''), promptCount: prompts, finalCount: finals};
}
// An implementer session is verified as a *set* member, not as one reviewer turn. The T1-T5
// work was done across several real native sessions and one of them contains an unsafe
// stopped workspace-write turn before the official read-only resume. Every completed turn of a
// bound session is verified from its own evidence (`implementerTurnFacts`) and all completed
// turns must agree on model/effort/cwd. A turn_context without a task_complete is recorded as a
// stopped incident and is never counted as a completion, so a later task_complete cannot
// launder a stopped edit turn into an implementation completion.
export function bindImplementationSession(lines, {sessionId='', expectedCwd='', allowedSandboxes=NATIVE_IMPLEMENTER_SANDBOXES}={}) {
  if (typeof sessionId !== 'string' || !sessionId) nativeFail('NATIVE_SESSION_ID_MISSING');
  const records = lines.map(line => { try { return JSON.parse(line); } catch { return null; } });
  const metaIds = records.filter(record => record && record.type === 'session_meta' && typeof record.payload?.id === 'string' && record.payload.id).map(record => record.payload.id);
  if (metaIds.length !== 1) nativeFail('NATIVE_SESSION_META_ID_MISSING', 'count=' + metaIds.length);
  if (nativeNorm(metaIds[0]) !== nativeNorm(sessionId)) nativeFail('NATIVE_SESSION_ID_MISMATCH', 'session_meta.id does not match the evidence file name');
  for (const record of records) if (record) nativeWalk(record, node => { if (Object.hasOwn(node, 'finish_reason') || Object.hasOwn(node, 'finishReason')) nativeFail('NATIVE_FINISH_REASON_FORBIDDEN', 'implementer session'); });
  const turns = new Map();
  const order = [];
  const completions = new Map();
  for (const record of records) {
    if (!record) continue;
    if (record.type === 'turn_context') {
      const turnId = String(record.payload?.turn_id || '');
      if (!turnId) nativeFail('NATIVE_TURN_ID_MISSING', 'implementer turn_context');
      if (!turns.has(turnId)) { turns.set(turnId, []); order.push(turnId); }
      turns.get(turnId).push(record.payload || {});
    } else if (record.type === 'event_msg' && record.payload?.type === 'task_complete') {
      const turnId = String(record.payload.turn_id || '');
      completions.set(turnId, (completions.get(turnId) || 0) + 1);
    }
  }
  if (order.length === 0) nativeFail('NATIVE_TURN_CONTEXT_MISSING', 'the implementer session has no turn_context');
  // Within one turn every turn_context (including a re-emitted duplicate) must agree on
  // model/effort/cwd/sandbox; completed turns of the session must agree on model/effort/cwd.
  const turnContextSignature = payload => [String(payload.model || ''), String(payload.effort || ''), String(payload.sandbox_policy?.type || ''), nativeNorm(payload.cwd)].join('|');
  const turnIdentity = payload => [String(payload.model || ''), String(payload.effort || ''), nativeNorm(payload.cwd)].join('|');
  let identity = null;
  const completedTurnIds = [];
  const stoppedTurns = [];
  for (const turnId of order) {
    const payloads = turns.get(turnId);
    const own = turnContextSignature(payloads[0]);
    for (const payload of payloads) if (turnContextSignature(payload) !== own) nativeFail('NATIVE_CONTEXT_INCONSISTENT', 'implementer turn=' + turnId);
    if ((completions.get(turnId) || 0) === 0) { stoppedTurns.push({turnId, sandbox: String(payloads[0].sandbox_policy?.type || '')}); continue; }
    const turnOwn = turnIdentity(payloads[0]);
    if (identity === null) identity = turnOwn;
    else if (turnOwn !== identity) nativeFail('NATIVE_IMPLEMENTER_TURN_MIXED', 'turn=' + turnId);
    completedTurnIds.push(turnId);
  }
  if (completedTurnIds.length === 0) nativeFail('NATIVE_IMPLEMENTATION_TURN_MISSING', 'the bound implementer session has no completed turn');
  const readOnlyTurnIds = [];
  let model = '';
  let effort = '';
  let cwd = '';
  for (const turnId of completedTurnIds) {
    const turn = implementerTurnFacts(records, {turnId, expectedCwd, allowedSandboxes});
    if (!model) { model = turn.model; effort = turn.effort; cwd = turn.cwd; }
    if (turn.sandbox === NATIVE_SANDBOX) readOnlyTurnIds.push(turnId);
  }
  return {id: sessionId, model, effort, cwd, turnCount: order.length, completedTurnIds, readOnlyTurnIds, stoppedTurns};
}
// A session file is only trusted once it is proven to live under the trusted session root and
// its bytes hash to what a later acceptance step will re-check. `sessionRelativePath` is
// always relative to the resolved trusted root so the consumer re-opens exactly these bytes.
export function verifyImplementerSessionFile(file, {sessionRoot='', expectedCwd='', allowedSandboxes=NATIVE_IMPLEMENTER_SANDBOXES}={}) {
  const snapshot = nativeSessionBytes(file, sessionRoot);
  const records = snapshot.lines.map(line => { try { return JSON.parse(line); } catch { return null; } });
  const metaIds = records.filter(record => record && record.type === 'session_meta' && typeof record.payload?.id === 'string' && record.payload.id).map(record => record.payload.id);
  if (metaIds.length !== 1) nativeFail('NATIVE_SESSION_META_ID_MISSING', 'count=' + metaIds.length);
  const id = metaIds[0];
  if (!path.basename(snapshot.real).toLowerCase().includes(id.toLowerCase())) nativeFail('NATIVE_SESSION_FILENAME_MISMATCH', 'the session file name must carry the session id');
  const bound = bindImplementationSession(snapshot.lines, {sessionId: id, expectedCwd, allowedSandboxes});
  return {...bound, sessionRelativePath: path.relative(snapshot.rootReal, snapshot.real).split(path.sep).join('/'), sha256: sha(snapshot.bytes), metaIdHash: sha(nativeNorm(id))};
}
// Deterministic fingerprint of the verified implementer session set. Sorted key/value rows so
// a hand edit that reorders keys or adds/removes/renames a session changes the hash and fails
// closed at acceptance time.
export function implementerSessionsFingerprint(record) {
  const sessions = (Array.isArray(record?.sessions) ? record.sessions : []).map(session => [
    nativeNorm(session?.id),
    String(session?.sessionRelativePath || '').replace(/\\/g, '/'),
    String(session?.sha256 || ''),
    String(session?.metaIdHash || ''),
    String(session?.model || ''),
    String(session?.effort || ''),
    nativeNorm(session?.cwd),
    Number.isInteger(session?.turnCount) ? String(session.turnCount) : '',
    (Array.isArray(session?.completedTurnIds) ? session.completedTurnIds : []).map(nativeNorm).sort().join(','),
    (Array.isArray(session?.readOnlyTurnIds) ? session.readOnlyTurnIds : []).map(nativeNorm).sort().join(','),
    (Array.isArray(session?.stoppedTurns) ? session.stoppedTurns : []).map(turn => nativeNorm(turn?.turnId) + '@' + String(turn?.sandbox || '')).sort().join(','),
  ].join('\u0000')).sort();
  const header = [Number.isInteger(record?.schemaVersion) ? String(record.schemaVersion) : '', nativeNorm(record?.alias)];
  return sha([...header, ...sessions].join('\u0001'));
}
// Acceptance-time proof: a stored record is self-consistent JSON, not authority. These are the
// exact fields the official producer writes for each bound implementer session; anything extra
// or missing fails closed before a file is re-opened, and every stored field is then compared
// with a fresh re-verification of the real JSONL under the trusted root.
const IMPLEMENTER_SESSION_RECORD_FIELDS = ['schemaVersion', 'alias', 'sessions', 'hash'];
const IMPLEMENTER_SESSION_FIELDS = ['id', 'model', 'effort', 'cwd', 'turnCount', 'completedTurnIds', 'readOnlyTurnIds', 'stoppedTurns', 'sessionRelativePath', 'sha256', 'metaIdHash'];
const IMPLEMENTER_STOPPED_TURN_FIELDS = ['turnId', 'sandbox'];
function nativeExactFieldSet(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expected = [...fields].sort();
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
function nativeTurnIdSet(value) {
  if (!Array.isArray(value)) return '\u0000invalid';
  return value.map(item => nativeNorm(item)).sort().join('\u0000');
}
function nativeStoppedTurnSet(value) {
  if (!Array.isArray(value)) return '\u0000invalid';
  return value.map(turn => (
    nativeExactFieldSet(turn, IMPLEMENTER_STOPPED_TURN_FIELDS)
      ? nativeNorm(turn.turnId) + '@' + String(turn.sandbox || '')
      : '\u0000invalid'
  )).sort().join('\u0000');
}
// Compare every stored field that affects the binding claim with the freshly recomputed facts.
// Returns the first mismatching field name, or '' when the stored record still describes the
// real bytes.
function nativeImplementerSessionMismatch(stored, verified) {
  if (nativeNorm(stored?.id) !== nativeNorm(verified.id)) return 'id';
  if (String(stored?.sessionRelativePath || '') !== String(verified.sessionRelativePath || '')) return 'sessionRelativePath';
  if (String(stored?.sha256 || '') !== String(verified.sha256 || '')) return 'sha256';
  if (String(stored?.metaIdHash || '') !== String(verified.metaIdHash || '')) return 'metaIdHash';
  if (String(stored?.model || '') !== String(verified.model || '')) return 'model';
  if (String(stored?.effort || '') !== String(verified.effort || '')) return 'effort';
  if (nativeNorm(stored?.cwd) !== nativeNorm(verified.cwd)) return 'cwd';
  if (String(stored?.turnCount) !== String(verified.turnCount)) return 'turnCount';
  if (nativeTurnIdSet(stored?.completedTurnIds) !== nativeTurnIdSet(verified.completedTurnIds)) return 'completedTurnIds';
  if (nativeTurnIdSet(stored?.readOnlyTurnIds) !== nativeTurnIdSet(verified.readOnlyTurnIds)) return 'readOnlyTurnIds';
  if (nativeStoppedTurnSet(stored?.stoppedTurns) !== nativeStoppedTurnSet(verified.stoppedTurns)) return 'stoppedTurns';
  return '';
}
// Distinctness set for the deepseek-native-cli-v1 chain. The verified set is required because
// the legacy scalar alone cannot prove distinctness from every implementer session; every
// bound evidence file is re-opened under the trusted root and re-verified with
// `verifyImplementerSessionFile` against the actual worktree cwd, then compared field by field
// with the recomputed facts, so a forged or accidentally edited task cannot widen, narrow or
// shift the implementer set. Duplicates, stale bytes, moved/renamed files, unknown fields and
// a scalar that is not exactly `record.alias` all fail closed. The legacy chains keep the
// single scalar behaviour untouched.
export function boundImplementerSessionIds(task, {sessionRoot, expectedCwd=''}={}) {
  if (String(task?.reviewChainVersion || '').trim() !== NATIVE_IMPLEMENTER_CHAIN) {
    if (typeof task?.implementerSessionId !== 'string' || !task.implementerSessionId) nativeFail('NATIVE_IMPLEMENTER_SESSION_MISSING', 'the task binding has no implementer session id, so implementer/reviewer distinctness cannot be proven');
    return [task.implementerSessionId];
  }
  const record = task.implementerSessions;
  if (!record || typeof record !== 'object' || Array.isArray(record)) nativeFail('NATIVE_IMPLEMENTER_SESSIONS_MISSING', 'the deepseek-native-cli-v1 task has no verified implementer session set; the scalar id alone cannot prove distinctness');
  if (record.schemaVersion !== IMPLEMENTER_SESSIONS_SCHEMA) nativeFail('NATIVE_IMPLEMENTER_SESSIONS_SCHEMA', 'schemaVersion=' + String(record.schemaVersion));
  if (!nativeExactFieldSet(record, IMPLEMENTER_SESSION_RECORD_FIELDS)) nativeFail('NATIVE_IMPLEMENTER_SESSIONS_FIELDS', 'the verified implementer session record must contain exactly schemaVersion/alias/sessions/hash');
  const sessions = Array.isArray(record.sessions) ? record.sessions : [];
  if (sessions.length === 0) nativeFail('NATIVE_IMPLEMENTER_SESSIONS_EMPTY', 'the verified implementer session set is empty');
  if (typeof sessionRoot !== 'string' || !sessionRoot) nativeFail('NATIVE_SESSION_ROOT_MISSING', 'the trusted session root is a caller input; it must never come from the receipt');
  let rootReal;
  try { rootReal = fs.realpathSync(sessionRoot); } catch { nativeFail('NATIVE_SESSION_ROOT_UNREADABLE', 'sessionRoot'); }
  const ids = [];
  const files = [];
  const seen = new Set();
  for (const session of sessions) {
    if (!nativeExactFieldSet(session, IMPLEMENTER_SESSION_FIELDS)) nativeFail('NATIVE_IMPLEMENTER_SESSION_FIELDS', 'a bound implementer session must contain exactly id/model/effort/cwd/turnCount/completedTurnIds/readOnlyTurnIds/stoppedTurns/sessionRelativePath/sha256/metaIdHash');
    const id = String(session?.id || '');
    if (!id) nativeFail('NATIVE_IMPLEMENTER_SESSION_ID_MISSING');
    if (seen.has(nativeNorm(id))) nativeFail('NATIVE_IMPLEMENTER_SESSION_DUPLICATE', 'id=' + id);
    seen.add(nativeNorm(id));
    const relativePath = String(session?.sessionRelativePath || '');
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) nativeFail('NATIVE_IMPLEMENTER_EVIDENCE_PATH_INVALID');
    let real;
    try { real = fs.realpathSync(path.resolve(rootReal, relativePath)); } catch { nativeFail('NATIVE_IMPLEMENTER_EVIDENCE_MISSING', 'the bound implementer session file is gone'); }
    if (!(real === rootReal || real.startsWith(rootReal + path.sep))) nativeFail('NATIVE_IMPLEMENTER_EVIDENCE_OUTSIDE_ROOT');
    const stat = fs.lstatSync(real);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > NATIVE_SESSION_MAX_BYTES) nativeFail('NATIVE_IMPLEMENTER_EVIDENCE_UNSAFE', 'bytes=' + stat.size);
    if (sha(fs.readFileSync(real)) !== String(session?.sha256 || '')) nativeFail('NATIVE_IMPLEMENTER_EVIDENCE_DRIFT', 'the bound implementer session bytes changed: ' + id);
    ids.push(id);
    files.push({session, real, id});
  }
  if (!ids.some(id => nativeNorm(id) === nativeNorm(record.alias))) nativeFail('NATIVE_IMPLEMENTER_ALIAS_MISMATCH', 'the alias is not one of the verified implementer sessions');
  if (nativeNorm(task.implementerSessionId) !== nativeNorm(record.alias)) nativeFail('NATIVE_IMPLEMENTER_ALIAS_TASK_MISMATCH', 'implementerSessionId must equal implementerSessions.alias');
  if (!ids.some(id => nativeNorm(id) === nativeNorm(task.implementerSessionId))) nativeFail('NATIVE_IMPLEMENTER_ALIAS_TASK_MISMATCH', 'implementerSessionId is not one of the verified implementer sessions');
  if (implementerSessionsFingerprint(record) !== record.hash) nativeFail('NATIVE_IMPLEMENTER_SESSIONS_HASH', 'the verified implementer session set does not match its recorded fingerprint');
  for (const {session, real, id} of files) {
    const verified = verifyImplementerSessionFile(real, {sessionRoot, expectedCwd, allowedSandboxes: NATIVE_IMPLEMENTER_SANDBOXES});
    if (verified.model !== 'deepseek-flash') nativeFail('NATIVE_IMPLEMENTER_MODEL', 'the bound implementer session is not deepseek-flash: ' + verified.model);
    if (verified.effort !== NATIVE_EFFORT) nativeFail('NATIVE_IMPLEMENTER_EFFORT', 'the bound implementer session is not ' + NATIVE_EFFORT + ': ' + verified.effort);
    const mismatch = nativeImplementerSessionMismatch(session, verified);
    if (mismatch) nativeFail('NATIVE_IMPLEMENTER_SESSION_FACT_MISMATCH', 'the stored implementer session fields disagree with the re-verified session: id=' + id + ' field=' + mismatch);
  }
  return ids;
}
// The request-owned review-scope-v1 verifier for the explicit deepseek-native-cli-v1 chain.
// Every pin is a trusted caller input from the official send request and is never read from the
// receipt, so a receipt cannot self-pin or fall back to the legacy full-dirty hash. The scope
// module is loaded lazily: the legacy and direct-API paths keep working even where the
// review-scope distribution is not present, and a missing dependency fails this chain closed.
function verifyNativeReviewScope(root, {task, round, receipt, expectedScopeHash, scopeFile, reviewedManifestPaths, ignoredPathspecs}) {
  if (typeof scopeFile !== 'string' || !scopeFile) nativeFail('NATIVE_SCOPE_PIN_MISSING', 'the official send request must pin scopeFile for the deepseek-native-cli-v1 chain');
  if (typeof expectedScopeHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedScopeHash)) nativeFail('NATIVE_SCOPE_PIN_MISSING', 'the official send request must pin expectedScopeHash');
  if (!Array.isArray(reviewedManifestPaths)) nativeFail('NATIVE_SCOPE_PIN_MISSING', 'the official send request must pin the reviewed manifest path list');
  if (!Array.isArray(ignoredPathspecs)) nativeFail('NATIVE_SCOPE_PIN_MISSING', 'the official send request must pin the ignored-pathspec bound');
  let verifyReviewScopeAtRoot;
  try { ({verifyReviewScopeAtRoot} = createRequire(import.meta.url)('./review-scope.mjs')); }
  catch { nativeFail('NATIVE_SCOPE_DEPENDENCY_MISSING', 'review-scope.mjs is required for the deepseek-native-cli-v1 chain'); }
  if (typeof verifyReviewScopeAtRoot !== 'function') nativeFail('NATIVE_SCOPE_DEPENDENCY_MISSING', 'review-scope.mjs did not export verifyReviewScopeAtRoot');
  const scope = verifyReviewScopeAtRoot(root, scopeFile, {ignoredPathspecs, expectedScopeHash, reviewedManifestPaths, current: true});
  if (scope.taskId !== task.taskId || scope.taskFingerprint !== task.taskFingerprint || scope.round !== round) nativeFail('NATIVE_SCOPE_BINDING_MISMATCH', 'the review scope is not bound to this task/round');
  if (scope.base !== receipt.reviewBaseCommit || scope.head !== receipt.reviewHeadCommit || scope.approvalHash !== receipt.approvalHash) nativeFail('NATIVE_SCOPE_BINDING_MISMATCH', 'the review scope is not bound to the receipt base/head/approval');
  return scope;
}

// The request-owned request binding: no other request can replay this receipt because the
// official send request owns requestId/inputHash and the receipt must echo them exactly.
function verifyNativeRequestBinding(receipt, {expectedRequestId, expectedInputHash}) {
  const requestId = typeof expectedRequestId === 'string' ? expectedRequestId.trim() : '';
  if (!requestId) nativeFail('NATIVE_REQUEST_PIN_MISSING', 'the official send request must pin expectedRequestId for the deepseek-native-cli-v1 chain');
  if (typeof expectedInputHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedInputHash)) nativeFail('NATIVE_INPUT_HASH_PIN_MISSING', 'the official send request must pin expectedInputHash');
  if (receipt.requestId !== requestId) nativeFail('NATIVE_REQUEST_ID_MISMATCH', 'the receipt requestId is not the request-owned value');
  if (receipt.inputHash !== expectedInputHash) nativeFail('NATIVE_INPUT_HASH_MISMATCH', 'the receipt inputHash is not the request-owned value');
  return {requestId, inputHash: expectedInputHash};
}
// 2026-09-28 (native dual-review acceptance): the DeepSeek primary review body must survive into
// the round record, not only its verdict. A finding is a real, severity-classified finding only
// when it carries one of the accepted severities and its own evidence; anything else (unknown
// severity, missing evidence) is held as an important unknown, so a fail-closed acceptance gate
// can never drop it and call the round clean.
function nativeFlat(value, max = 600) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return typeof text === 'string'
    ? text.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max)
    : '';
}
function nativeSeverity(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = text.match(/^\s*P([0-3])(?![0-9])/iu);
  return match ? 'P' + match[1] : '';
}
function nativeEvidence(value) {
  if (typeof value === 'string') return nativeFlat(value, 800);
  if (Array.isArray(value)) {
    const parts = value.map((item) => nativeFlat(item, 400)).filter(Boolean);
    return parts.length ? parts.join(' / ') : '';
  }
  return '';
}
export function classifyNativeFindings(raw) {
  const findings = [];
  const importantUnknowns = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const record = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
    const severity = record ? nativeSeverity(record.severity ?? record.severityLevel ?? record.level ?? record.priority) : '';
    const evidence = record ? nativeEvidence(record.evidence ?? record['根拠'] ?? record.proof) : '';
    if (!NATIVE_FINDING_SEVERITIES.includes(severity) || !evidence) {
      importantUnknowns.push(nativeFlat(record ? (record.summary ?? record.finding ?? record.title ?? record.note ?? record) : item, 500) || '判定不能なfindings項目');
      continue;
    }
    findings.push({
      severity,
      kind: nativeFlat(record.kind ?? record.findingKind, 40),
      summary: nativeFlat(record.summary ?? record.finding ?? record.title ?? record.note, 600),
      evidence,
    });
  }
  return { findings, importantUnknowns };
}

// Verify one native CLI session receipt (type native-cli-session-v1). Every fact is
// recomputed from the real JSONL and the real worktree; nothing is taken on the receipt's
// word. `root` is the worktree being verified, so the turn cwd is compared with that real
// root and not with the receipt's own cwd claim, and `sessionRoot` must be supplied by the
// trusted caller (approval or harness config) and never read from the receipt.
// The request-owned requestId/inputHash pins are the same kind of trusted caller input: the
// official send request owns them and the receipt must echo them, so no other request can replay.
// FAIL-CLOSED DEPENDENCIES: distinctness for the deepseek-native-cli-v1 chain reads the
// verified implementer session set written by `approval bind-review-chain`; the legacy chains
// keep the single scalar task.implementerSessionId. The producer derives the trusted session
// root from the running official home and only accepts a root inside it, or - for the one CMGB
// recovery task - the fixed second reviewer store. The implementer set is always re-verified from
// the legacy Codex home (`home` injects that home for a test), so selecting a reviewer store never
// moves it. Native evidence is an acceptance path only, so current:false is not accepted and no
// partial mode exists.
export function nativeSessionEvidence(root, file, {task, round, lens, role, sessionRoot, home='', cmgbReviewerRoot='', current=true, expectedScopeHash, scopeFile, reviewedManifestPaths, ignoredPathspecs, expectedRequestId, expectedInputHash, expectedFocusedTargets=null, expectedFocusedTargetsHash=''}={}) {
  const receipt = JSON.parse(regular(file));
  const focusedPins = nativeFocusedPins(expectedFocusedTargetsHash, expectedFocusedTargets);
  if (receipt.type !== NATIVE_REVIEW_EVIDENCE || receipt.schemaVersion !== 1) nativeFail('NATIVE_EVIDENCE_TYPE_MISMATCH', 'a direct-API/provider receipt cannot be verified as native CLI evidence');
  if (current !== true) nativeFail('NATIVE_ACCEPTANCE_REQUIRES_CURRENT', 'native CLI evidence has no record-only mode; HEAD/approval/scope must be checked against the live worktree');
  if (receipt.taskId !== task.taskId || receipt.taskFingerprint !== task.taskFingerprint || receipt.round !== round || receipt.lens !== lens) nativeFail('NATIVE_TASK_MISMATCH');
  if (!role || !NATIVE_REVIEWER_ROLES.includes(role) || receipt.reviewerRole !== role) nativeFail('NATIVE_REVIEWER_ROLE_MISMATCH', 'role=' + String(receipt.reviewerRole));
  if (task.surfaceKind !== 'web_ui') nativeFail('NATIVE_SURFACE_MISMATCH', 'native CLI evidence is not a browser/visual verification substitute');
  nativeWalk(receipt, node => { if (Object.hasOwn(node, 'finish_reason') || Object.hasOwn(node, 'finishReason')) nativeFail('NATIVE_FINISH_REASON_FORBIDDEN', 'receipt'); });
  // A task explicitly bound to the deepseek-native-cli-v1 chain must prove its round against the
  // request-owned review-scope-v1, whose scopeHash is a different algorithm from the legacy
  // full-dirty manifest hash. The scope pins are trusted caller inputs from the official send
  // request and are never read from the receipt; a missing pin fails closed instead of silently
  // falling back to the legacy full-dirty comparison.
  const nativeChain = String(task?.reviewChainVersion || '').trim() === NATIVE_IMPLEMENTER_CHAIN;
  const nativeRequest = nativeChain ? verifyNativeRequestBinding(receipt, {expectedRequestId, expectedInputHash}) : null;
  nativeAssertReviewerRoot(task, sessionRoot, {home, cmgbReviewerRoot});
  const implementerSessionIds = boundImplementerSessionIds(task, {sessionRoot: nativeImplementerSessionRoot(task, sessionRoot, {home, cmgbReviewerRoot}), expectedCwd: root});
  const turn = bindNativeTurn(nativeSnapshot(receipt.sessionFile, sessionRoot, receipt.sessionId), {turnId: receipt.turnId, expectedCwd: root, expectedSessionId: receipt.sessionId});
  if (implementerSessionIds.some(id => nativeNorm(id) === nativeNorm(receipt.sessionId))) nativeFail('NATIVE_SAME_SESSION', 'the reviewer session equals one of the implementer sessions');
  if (receipt.model !== turn.model) nativeFail('NATIVE_MODEL_MISMATCH', 'model=' + String(receipt.model));
  if (receipt.effort !== turn.effort) nativeFail('NATIVE_EFFORT_MISMATCH', 'effort=' + String(receipt.effort));
  if (receipt.sandbox !== turn.sandbox) nativeFail('NATIVE_SANDBOX_MISMATCH', 'sandbox=' + String(receipt.sandbox));
  if (receipt.cwd !== turn.cwd) nativeFail('NATIVE_CWD_MISMATCH', 'cwd=' + String(receipt.cwd));
  if (receipt.promptSha256 !== turn.promptSha256 || receipt.promptLength !== turn.promptLength) nativeFail('NATIVE_PROMPT_MISMATCH');
  if (receipt.finalSha256 !== turn.finalSha256 || receipt.finalLength !== turn.finalLength) nativeFail('NATIVE_FINAL_MISMATCH');
  if (receipt.usage?.inputTokens !== turn.usage.inputTokens || receipt.usage?.outputTokens !== turn.usage.outputTokens || receipt.usage?.totalTokens !== turn.usage.totalTokens) nativeFail('NATIVE_USAGE_MISMATCH');
  const manifest = JSON.parse(artifact(root, receipt.manifest, receipt.manifestHash));
  const paths = verifyManifest(root, manifest, {current});
  const scope = nativeChain ? verifyNativeReviewScope(root, {task, round, receipt, expectedScopeHash, scopeFile, reviewedManifestPaths, ignoredPathspecs}) : null;
  if (current) {
    verifyDeletedBase(root, manifest, receipt.reviewBaseCommit);
    if (nativeChain) {
      if (scope.scopeHash !== receipt.changedScopeHash) nativeFail('NATIVE_SCOPE_HASH_MISMATCH', 'the receipt changedScopeHash is not the request-owned review-scope-v1 scopeHash');
      const reviewedScopePaths = scope.entries.filter(entry => entry.kind === 'reviewed').map(entry => entry.path).sort();
      const manifestPaths = [...paths].sort();
      if (reviewedScopePaths.length !== manifestPaths.length || reviewedScopePaths.some((rel, index) => rel !== manifestPaths[index])) nativeFail('NATIVE_SCOPE_MANIFEST_MISMATCH', 'the inline reviewed manifest must be exactly the review-scope-v1 reviewed paths, and never a protected/forward_frozen path');
    } else {
      const scopeHash = sha(verifyChangedScope(root, paths, receipt.reviewBaseCommit).join('\n'));
      if (scopeHash !== receipt.changedScopeHash) nativeFail('NATIVE_SCOPE_MISMATCH');
    }
    const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'});
    if (head.status !== 0 || receipt.reviewHeadCommit !== head.stdout.trim() || receipt.approvalHash !== sha(regular(path.join(root, '.ai/approval.json')))) nativeFail('NATIVE_HEAD_APPROVAL_MISMATCH');
  }
  if (!lensTags[lens] || !turn.promptText.includes(lensTags[lens])) nativeFail('NATIVE_LENS_MISMATCH');
  const binding = JSON.stringify(Object.assign({taskId: task.taskId, taskFingerprint: task.taskFingerprint, round, lens, reviewBaseCommit: receipt.reviewBaseCommit, reviewHeadCommit: receipt.reviewHeadCommit, approvalHash: receipt.approvalHash, manifestHash: receipt.manifestHash}, nativeChain ? {changedScopeHash: scope.scopeHash, requestId: nativeRequest.requestId, inputHash: nativeRequest.inputHash} : {}));
  if (!turn.promptText.includes('Review binding: ' + binding)) nativeFail('NATIVE_BINDING_MISMATCH', nativeChain ? 'the received prompt must contain "Review binding: " plus the one-line JSON of the 8 bound items followed by changedScopeHash, requestId and inputHash as the ninth, tenth and eleventh fields; the 8-field and 9-field forms are rejected for this chain' : 'the received prompt must contain "Review binding: " plus the one-line JSON of the 8 bound items');
  if (focusedPins) {
    if (!turn.promptText.includes('Native-Focused-Targets-SHA256: ' + focusedPins.hash)) {
      nativeFail('NATIVE_FOCUSED_TARGETS_HASH_MISSING', 'the reviewer turn did not receive the pinned Native-Focused-Targets-SHA256 line');
    }
    for (const target of focusedPins.targets) {
      if (!turn.promptText.includes(target.originalText)) {
        nativeFail('NATIVE_FOCUSED_TARGET_MISSING', 'the reviewer turn did not receive a pinned focused target original text');
      }
    }
  }
  const answer = JSON.parse(turn.finalText.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (!['pass', 'findings'].includes(answer.verdict) || !Array.isArray(answer.findings) || !Array.isArray(answer.unverified) || (answer.verdict === 'pass') !== (answer.findings.length === 0)) nativeFail('NATIVE_FINAL_INVALID');
  const classified = classifyNativeFindings(answer.findings);
  const recheckDecisions = focusedPins ? nativeFocusedDecisions(answer.recheckDecisions, focusedPins.keys) : null;
  return {status: 'completed', evidenceType: NATIVE_REVIEW_EVIDENCE, reviewChainVersion: 'deepseek-native-cli-v1', model: turn.model, effort: turn.effort, cwd: turn.cwd, sandbox: turn.sandbox, round, lens, reviewerRole: role, sessionIdHash: sha(nativeNorm(receipt.sessionId)), turnIdHash: sha(receipt.turnId), promptSha256: turn.promptSha256, promptLength: turn.promptLength, finalSha256: turn.finalSha256, finalLength: turn.finalLength, usage: turn.usage, manifestHash: receipt.manifestHash, changedScopeHash: receipt.changedScopeHash, reviewBaseCommit: receipt.reviewBaseCommit, reviewHeadCommit: receipt.reviewHeadCommit, approvalHash: receipt.approvalHash, verdict: answer.verdict, findings: classified.findings, importantUnknowns: classified.importantUnknowns, unverified: answer.unverified.map(item => typeof item === 'string' ? item : JSON.stringify(item)), evidencePath: path.resolve(file), evidenceHash: sha(regular(file)), ...(nativeChain ? {scopeHash: scope.scopeHash, scopeManifestHash: scope.manifestHash, requestId: nativeRequest.requestId, inputHash: nativeRequest.inputHash} : {}), ...(focusedPins ? {nativeFocusedTargetsHash: focusedPins.hash, recheckDecisions} : {})};
}

// R1 F1-4: 外部ランナー(親管理)のプロンプトは "## Round lens" の次の行が "N of 3: <lens>"。
// 観点の表示だけは両書式を受け付ける。binding の照合は緩めない。
function promptDeclaresLens(prompt, lens, round) {
  if (prompt.includes(lensTags[lens])) return true;
  return new RegExp(`^${round} of 3: ${lens}$`, 'm').test(prompt);
}

// DeepSeek 連鎖(deepseek-opus-v1)の対象レーン。ai-review-rounds-lib の
// deepseekReviewChainEligible と同じ条件を、循環 import を避けるためここにも書く
// (non_web/web_ui の DeepSeek Flash high だけ。native 連鎖の宣言済みレーンは対象外)。
export function deepseekDirectReviewEligible(task) {
  return String(task?.implementer?.model || '').trim().toLowerCase() === 'deepseek-flash'
    && String(task?.implementer?.effort || '').trim().toLowerCase() === 'high'
    && ['non_web', 'web_ui'].includes(String(task?.surfaceKind || '').trim())
    && String(task?.reviewChainVersion || '').trim() !== NATIVE_IMPLEMENTER_CHAIN;
}

// 外部集計(externalReviewSummary)が受理するレーン。上の DeepSeek 連鎖の条件とは web_ui の
// 扱いを意図的に分ける。non_web は実装者を問わず受理する(web_ui を受理する前からの既存挙動。
// ここを狭めると、DeepSeek 以外で実装した non_web レーンの有効な3往復が完了記録から消える回帰。
// 2026-10-02 R2 F2-1)。web_ui だけを DeepSeek Flash high の実装レーンに限る。
// どちらの surface でも native 連鎖(deepseek-native-cli-v1)の宣言済みレーンは拒否する。
// web_ui のブラウザ検証はこの集計ではなく E2E 証跡・ブラウザ往復が別途要求し続ける。
export function externalReviewSurfaceAccepted(task) {
  if (String(task?.reviewChainVersion || '').trim() === NATIVE_IMPLEMENTER_CHAIN) return false;
  const surfaceKind = String(task?.surfaceKind || '').trim();
  if (surfaceKind === 'non_web') return true;
  // web_ui は DeepSeek 連鎖の条件そのもの(実装者 deepseek-flash/high)。それ以外の surface は false。
  return deepseekDirectReviewEligible(task);
}

export function externalReviewSummary(root, task, indexFile, officialScope) {
  if (String(task?.reviewChainVersion || '').trim() === NATIVE_IMPLEMENTER_CHAIN) {
    throw Error('native 宣言済みレーンは external 集計の対象外');
  }
  if (!externalReviewSurfaceAccepted(task)) throw Error('external review summary requires a non_web lane or an adopted DeepSeek web_ui lane (non-native)');
  const index=JSON.parse(regular(indexFile));
  if (!officialScope?.baseCommit || index.reviewBaseCommit!==officialScope.baseCommit || index.gitHead!==officialScope.headCommit) throw Error('external review differs from official review base/HEAD');
  if (index.schemaVersion!==1 || index.taskId!==task.taskId || index.taskFingerprint!==task.taskFingerprint || index.branch!==task.branch || index.reviewChainVersion!=='deepseek-opus-v1' || index.rounds?.length!==3) throw Error('external review task/chain mismatch');
  const base=path.dirname(indexFile);
  const final=JSON.parse(artifact(base,index.finalManifest,index.finalManifestHash));
  const paths=verifyManifest(root,final);
  verifyChangedScope(root,paths,index.reviewBaseCommit);
  const git=spawnSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'});
  if (git.status!==0 || index.gitHead!==git.stdout.trim() || index.approvalHash!==sha(regular(path.join(root,'.ai/approval.json')))) throw Error('external review HEAD/approval mismatch');
  artifact(base,index.dispositions,index.dispositionsHash);
  const unverified=[];
  // 2026-09-23: 各往復が実際に使った独立レビューの明示IDを残す。記録側(review-rounds.json や
  // 完了証跡)には論理名 'opus' しか入らないため、後から「この往復は旧 5 だった」と名指しできない
  // 問題を、完了ゲートが保存するこの集計(`.ai/context/completion-verification-<taskId>.json`)で塞ぐ。
  // 証跡そのもの(result.actual.modelUsage)にも唯一のキーとして入っている(verifyProviderEvidence が照合する)。
  const independentReviewerModels=[];
  for (let i=0;i<3;i++) {
    const round=index.rounds[i];
    if (round.round!==i+1 || round.lens!==['spec','user_path','edge'][i]) throw Error('review round/lens mismatch');
    // R1 F1-3: 往復ごとの対象版。往復の間にも commit できるよう round.reviewHeadCommit を記録し、
    // それが最終レビュー版(index.gitHead=現在 HEAD)の祖先であることを確認する。未指定なら
    // 従来どおり index.gitHead を使う(古い index を壊さない)。binding 照合もこの値で行う。
    const roundHead=round.reviewHeadCommit ?? index.gitHead;
    if (!/^[a-f0-9]{40,64}$/.test(roundHead) || spawnSync('git',['-C',root,'merge-base','--is-ancestor',roundHead,index.gitHead]).status!==0) throw Error('review round head is not an ancestor of the final reviewed commit');
    if (i===2 && roundHead!==index.gitHead) throw Error('final review round head differs from the final reviewed commit');
    // R3(2026-09-19) F3-2: 往復の間にも基点は動く(例: R1 の後に master を取り込む)。往復ごとの
    // 基点を index.rounds[i].reviewBaseCommit へ記録し、binding と削除ファイルの照合にはその値を使う。
    // 未指定なら従来どおり最終の基点を使う(古い index を壊さない)。最終の往復だけは最終の基点で行う。
    const roundBase=round.reviewBaseCommit ?? index.reviewBaseCommit;
    if (!/^[a-f0-9]{40,64}$/.test(roundBase) || spawnSync('git',['-C',root,'merge-base','--is-ancestor',roundBase,index.reviewBaseCommit]).status!==0) throw Error('review round base is not an ancestor of the final review base');
    if (i===2 && roundBase!==index.reviewBaseCommit) throw Error('final review round base differs from the final review base');
    for (const kind of ['deepseek','opus']) {
      // 旧 claude-opus-5 を許すかは、その往復の対象 commit(reviewHeadCommit)の日時で決める。
      const item=verifyProviderEvidence(root,base,round[kind],kind,{current:i===2,allowLegacyOpus:opusLegacyAllowed(root,roundHead)});
      // R1(2026-10-05): 外部集計も、分割計画の1呼出しぶん(一部の範囲だけ)の証跡を往復の完了にしない。
      assertWholeVersionCoverage(item.manifest);
      if (kind==='opus') independentReviewerModels.push(item.model);
      verifyDeletedBase(root,item.manifest,roundBase);
      if (!promptDeclaresLens(item.prompt,round.lens,i+1)) throw Error('review prompt round mismatch');
      const binding=JSON.stringify({taskId:task.taskId,taskFingerprint:task.taskFingerprint,round:i+1,lens:round.lens,reviewBaseCommit:roundBase,reviewHeadCommit:roundHead,approvalHash:index.approvalHash,manifestHash:item.manifestHash});
      if (!item.prompt.includes('Review binding: '+binding)) throw Error('external prompt does not bind task/approval/version: 外部ランナーは "Review binding: " + 8項目(taskId/taskFingerprint/round/lens/reviewBaseCommit/reviewHeadCommit/approvalHash/manifestHash)の1行JSON を出す必要があります');
      // R3fix G-3(2026-09-19): 往復の間に基点が動く場合、過去の往復にだけあるファイルは
      // 「その往復の基点」と「最終の基点」のどちらかと一致していれば戻したとみなす
      // (最終基点の内容へ戻したものを、動く前の基点と比べて止めない)。
      const restored=entry=>restoredToBase(root,roundBase,entry.path)||(roundBase!==index.reviewBaseCommit&&restoredToBase(root,index.reviewBaseCommit,entry.path));
      if (item.manifest.files.some(entry=>!paths.has(entry.path)&&!restored(entry))) throw Error('historical review outside final scope');
      if (i===2) {
        if (item.manifestHash!==index.finalManifestHash || item.result.verdict!=='pass') throw Error('final reviewed version is not clean/current');
        unverified.push(...item.result.unverified.map(v=>typeof v==='string'?v:JSON.stringify(v)));
      }
    }
  }
  return {codeReviewRounds:3,codeReviewMaxRounds:3,codeReviewSizeClass:'external-manifest',codeReviewOutcome:unverified.length?'passed_with_unverified':'passed_clean',reviewChainVersion:'deepseek-opus-v1',codeReviewIndependentReviewerModels:independentReviewerModels,nextCandidates:[],unverified,visualQcOutcome:'not_applicable',visualQcAttempts:0,visualQcPreliminaryChecks:0,browserReviewOutcome:'not_applicable',browserReviewRounds:0,warnings:unverified.map(v=>'外部レビュー未確認: '+v),evidence:indexFile};
}
