#!/usr/bin/env node
// check-instruction-substance.mjs — 指示書の**中身**を見る（未記入の雛形・見出しだけ・合格条件なしを拒否）
//
// なぜ必要か（2026-10-27 T1-ENTRY-SUBSTANCE）:
//   既存の check-instruction-items.mjs は「項目の見出しに語があるか」だけを見るため、
//   knowledge/templates/parent-instruction.md の**未記入の雛形**（{見積り円} 等の {…} が残ったまま）でも
//   exit 0（13項目すべて中身あり）になった（2026-10-27 実測）。受入表チェック（check-acceptance-table.mjs）は
//   期待する結果・確認方法の空欄を拒否するが、雛形の {…} は「中身がある」と数えてしまう。
//   この判定は、指示書が**実質**を持つか（プレースホルダでない本文・13項目の本文・受入表の期待/確認）を
//   機械で見る。既存の2つは変更しない（発注入口への接続は親／T4 の担当）。
//
// 13項目の定義（既定の雛形の見出し。12の番号付き項目＋受入表）:
//   1 ゴールと完成条件 / 2 案件に合わせたタスク分解 / 3 役割分担 / 3-2 最新状態の実測 /
//   3-3 着手・完了の証拠 / 4 並列とサブエージェント / 5 次工程への接続 / 6 親の照合義務 /
//   7 承認・予算・上限の事前洗い出し / 8 不足情報は質問 / 9 著者と進行管理 /
//   10 完了後の記録と片付け / 受入表
//   MMM読了・追補などの追加節は判定しない（MMM読了は完了関所の mmm ゲートが見る）。
//
// 使い方: node check-instruction-substance.mjs <指示書.md> [--json]
// 終了コード: 0=合格（中身あり） / 1=不合格（中身が無い） / 2=使い方の誤り・読めない・空
// 出力:
//   INSTRUCTION_SUBSTANCE_OK instruction=<abspath> items=13 acceptance_rows=<n>
//   INSTRUCTION_SUBSTANCE_REJECT instruction=<abspath> reason=<code[+code...]> detail=<text>
//   終了コード2のときは stderr に reason=usage / unreadable / empty_input と理由を出す。
// 不合格の reason:
//   placeholder                         … 雛形の未記入 {…} が残っている（コードブロック・インラインコード内は除く）
//                                        対象は日本語の雛形項目・{REPO} 等の識別子・{…}/{...} 記号。
//                                        既存指示書の @{u}・正規表現 {4}・コード片 {} は未記入としない（誤検知対策）。
//   item_missing:<項目>                 … 13項目の見出しが無い
//   item_empty:<項目>                   … 見出しはあるが本文が4文字未満／キーワードだけ／未定などの空欄
//   acceptance_missing                  … 受入表が無い（見出しも表も無い）
//   acceptance_table_missing            … 受入表の見出しはあるが表（本文の行）が無い
//   acceptance_columns_missing          … 「期待する結果」「確認方法」の列が無い
//   acceptance_empty_expected:行N       … 期待する結果が空
//   acceptance_empty_check:行N          … 確認方法が空
//   acceptance_exempt_without_reason:行N … 対象外なのに理由が無い
// 限界（機械では見ないこと）:
//   - 本文の意味・妥当性は見ない（4文字以上でも無意味な文は通る）。内容は人／独立レビューが見る。
//   - 13項目は見出しの番号（1・2・3・3-2・3-3・4〜10）または雛形の題名（語）で対応付ける。
//     番号も題名も無い独自構成の指示書は「項目が無い」と判定する（雛形に従うのが既定）。
//   - コードブロック・インラインコードの中の {} は未記入としない（JSON例・コマンド例の誤検知を避ける）。
//   - {} の中身が日本語の雛形項目でも識別子でもないもの（@{u}・{4}・空の {}）は未記入としない
//     （既存の合格指示書を誤って止めないため。雛形の未記入項目は日本語か英字の語なので検出できる）。
//   - 受入表の「対象外の理由」列は、対象外でない行では空欄でよい（2026-10-27 追補）。
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ITEMS = [
  { id: '1', title: 'ゴールと完成条件', heads: ['ゴールと完成条件', '完成条件'] },
  { id: '2', title: '案件に合わせたタスク分解', heads: ['タスク分解'] },
  { id: '3', title: '役割分担', heads: ['役割分担'] },
  { id: '3-2', title: '最新状態の実測', heads: ['最新状態の実測'] },
  { id: '3-3', title: '着手・完了の証拠', heads: ['着手・完了の証拠', '着手・完了'] },
  { id: '4', title: '並列とサブエージェント', heads: ['並列とサブエージェント', '並列・サブエージェント'] },
  { id: '5', title: '次工程への接続', heads: ['次工程への接続'] },
  { id: '6', title: '親の照合義務', heads: ['親の照合義務'] },
  { id: '7', title: '承認・予算・上限の事前洗い出し', heads: ['承認・予算・上限'] },
  { id: '8', title: '不足情報は質問', heads: ['不足情報は質問'] },
  { id: '9', title: '著者と進行管理', heads: ['著者と進行管理'] },
  { id: '10', title: '完了後の記録と片付け', heads: ['完了後の記録と片付け'] },
];
const ACCEPT_ID = '受入表';

const ACCEPT_RE = /受入表|受入条件表|受入基準表|受け入れ表/;
const HEADING_RE = /^(#{1,6})\s*(.*)$/;
const NUMBERED_RE = /^(\d+(?:-\d+)?)[.．、:：)]?\s*(.*)$/;
const BRACE_RE = /\{([^{}\n]*)\}|｛([^｛｝\n]*)｝/gu;
const EXEMPT_RE = /^(?:\*\*|__)?\s*(対象外|該当なし|該当しない|N\/A|n\/a)/i;
const GENERIC_BODY_RE = /^(?:未定|未記入|未記載|未着手|なし|無し|todo|tbd|n\/a|na|xxx|done|\.{2,}|…|-+|—+|－+|\?|？)$/i;
// 空欄とみなすセル（受入表の空欄判定。既存 check-acceptance-table.mjs と同じ語彙）
const EMPTY_CELLS = new Set(['', '-', '--', '---', '—', '−', 'n/a', 'N/A', 'tbd', 'TBD', 'todo', 'TODO', 'fixme', 'FIXME',
  'xxx', 'XXX', '?', '？', '未定', '未記入', '未記載', '未着手', '記入予定', 'あとで', 'あとで書く', '後で書く', 'これから書く',
  '検討中', '決めていない', '空', '(空)', 'なし', '特になし', '*', '…']);

function stripMd(value) {
  return String(value ?? '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`/g, '')
    .replace(/[ \t\u3000]/g, '')
    .trim();
}

function isBlankCell(value) {
  const text = stripMd(value);
  if (text.length === 0) return true;
  return EMPTY_CELLS.has(text);
}

// フェンス付きコードブロック（``` / ~~~）の中身は本文とみなさない。行数は変える（行番号を保つ）。
function maskFencedLines(lines) {
  let inFence = false;
  let marker = '';
  return lines.map((line) => {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!inFence) { inFence = true; marker = fence[1][0]; return ''; }
      if (fence[1][0] === marker) { inFence = false; marker = ''; return ''; }
    }
    return inFence ? '' : line;
  });
}

// インラインコード（`...`）の中身を消す。コード例の中の {} を未記入と誤判定しないため。
function maskInlineCode(line) {
  return String(line).replace(/`[^`\n]*`/g, ' ');
}

// 波括弧の中身が「雛形の未記入項目」らしいか。
// 何でも {} を未記入にすると、正しい指示書のコマンド例（@{u}）・正規表現（{4}）・コード片（{}）を
// 誤検知する（2026-10-27 の既存指示書スイープで実測）。日本語の雛形項目か、識別子らしい英数字だけを対象にする。
function isPlaceholderToken(content) {
  const token = String(content).trim();
  if (!token) return false; // {} はコード片（空オブジェクト等）として扱う
  if (/^(?:…|\.{2,}|···)$/u.test(token)) return true; // {…} というプレースホルダ記号そのもの
  if (/[\u3041-\u3096\u30a1-\u30fa\u30fc\u4e00-\u9fff]/u.test(token)) return true; // 日本語の雛形項目
  if (/^[A-Za-z][A-Za-z0-9_-]{1,39}$/u.test(token)) return true; // {REPO} / {repo_name} 等の識別子
  return false;
}

// 行の中の未記入プレースホルダを1つ返す（無ければ null）。
function findPlaceholder(line) {
  for (const match of line.matchAll(BRACE_RE)) {
    const content = match[1] ?? match[2] ?? '';
    if (isPlaceholderToken(content)) return match[0];
  }
  return null;
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isSeparatorRow(line) {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line) && (line.match(/-/g) || []).length >= 3;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

// 文書中の markdown 表を、行番号（1始まり）つきで拾う。from〜to は 0始まりの行 index。
function parseTables(lines, from, to) {
  const tables = [];
  for (let i = from; i < to - 1; i += 1) {
    if (!isTableRow(lines[i]) || !isSeparatorRow(lines[i + 1])) continue;
    const headers = splitRow(lines[i]);
    const rows = [];
    let j = i + 2;
    for (; j < to; j += 1) {
      if (!isTableRow(lines[j]) || isSeparatorRow(lines[j])) break;
      rows.push({ line: j + 1, cells: splitRow(lines[j]) });
    }
    tables.push({ startLine: i + 1, headers, rows });
    i = j - 1;
  }
  return tables;
}

// 本文の実質文字数（空白・markdown記号・表の区切り行・箇条書き記号・チェック欄を除いて数える）。
function substanceLength(bodyText) {
  return bodyText
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')
    .replace(/^\s*(?:[-*+]|\d+(?:-\d+)?[.)])\s+/gm, '')
    .replace(/[`*_~#>|]/g, '')
    .replace(/[□☑☐]/g, '')
    .replace(/[\s\u3000]/g, '')
    .length;
}

// 本文が見出しの語をなぞっただけ（キーワードだけ）かを判定するための正規化。
function normalizeForEcho(value) {
  return String(value ?? '')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')
    .replace(/^\s*(?:[-*+]|\d+(?:-\d+)?[.)])\s+/gm, '')
    .replace(/[`*_~#>|]/g, '')
    .replace(/[□☑☐\s\u3000]/g, '')
    .replace(/[。、，．,！!？?：:；;（）()「」『』【】\[\]]/g, '');
}

/**
 * 指示書テキストを判定する（CLI と将来の呼び出し側で共用できるよう export する）。
 * @param {string} text 指示書の全文
 * @returns {{ok:boolean, items:number, acceptanceRows:number, reasons:string[], details:string[]}}
 */
export function checkInstructionSubstance(text) {
  const rawLines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const maskedLines = maskFencedLines(rawLines);
  const reasons = [];
  const details = [];

  // ① 未記入の雛形: コードブロック・インラインコードの外に {…} が残っていないか
  for (let i = 0; i < maskedLines.length; i += 1) {
    const line = maskInlineCode(maskedLines[i]);
    const placeholder = findPlaceholder(line);
    if (placeholder) {
      const snippet = line.trim().replace(/\s+/g, ' ').slice(0, 60);
      reasons.push('placeholder');
      details.push(`line ${i + 1}: 未記入の {…} が残っている: ${snippet}`);
      break;
    }
  }

  // 見出しの収集（コードブロック内の見出しは数えない）
  const headings = [];
  for (let i = 0; i < maskedLines.length; i += 1) {
    const m = HEADING_RE.exec(maskedLines[i]);
    if (m) headings.push({ index: i, level: m[1].length, text: m[2].trim() });
  }

  // 13項目の見出しを対応付ける（番号 → 受入表 → 題名の語、の順。最初の一致だけ使う）
  const sections = new Map();
  for (const heading of headings) {
    let id = null;
    const numbered = NUMBERED_RE.exec(heading.text);
    if (numbered && ITEMS.some((item) => item.id === numbered[1])) id = numbered[1];
    if (!id && ACCEPT_RE.test(heading.text)) id = ACCEPT_ID;
    if (!id) {
      const byTitle = ITEMS.find((item) => !sections.has(item.id) && item.heads.some((word) => heading.text.includes(word)));
      if (byTitle) id = byTitle.id;
    }
    if (id && !sections.has(id)) sections.set(id, heading);
  }
  // 本文の終端 = 同じか上のレベルの次の見出し
  for (const [id, heading] of sections) {
    let end = rawLines.length;
    for (const next of headings) {
      if (next.index > heading.index && next.level <= heading.level) { end = next.index; break; }
    }
    sections.set(id, { ...heading, end });
  }

  // ② 13項目（12の番号付き項目）の本文が実質を持つか
  for (const item of ITEMS) {
    const section = sections.get(item.id);
    if (!section) {
      reasons.push(`item_missing:${item.id}`);
      details.push(`${item.id} ${item.title}: 見出しが無い`);
      continue;
    }
    const body = rawLines.slice(section.index + 1, section.end).join('\n');
    const normalized = normalizeForEcho(body);
    const headingEcho = normalized.length > 0 && normalizeForEcho(section.text).includes(normalized);
    if (substanceLength(body) < 4) {
      reasons.push(`item_empty:${item.id}`);
      details.push(`${item.id} ${item.title}: 本文が4文字未満（${section.index + 1}行目）`);
    } else if (GENERIC_BODY_RE.test(normalized)) {
      reasons.push(`item_empty:${item.id}`);
      details.push(`${item.id} ${item.title}: 本文が未定・空欄扱いの語だけ（${section.index + 1}行目）`);
    } else if (headingEcho) {
      reasons.push(`item_empty:${item.id}`);
      details.push(`${item.id} ${item.title}: 本文が見出しの語だけ（キーワードだけ。${section.index + 1}行目）`);
    }
  }

  // ③ 受入表（13項目の最後）の期待する結果・確認方法が空でないか
  let acceptanceRows = 0;
  const acceptSection = sections.get(ACCEPT_ID);
  let tables = [];
  if (acceptSection) {
    tables = parseTables(maskedLines, acceptSection.index + 1, acceptSection.end);
  }
  if (tables.length === 0) {
    // 見出しが無くても「期待」「確認」列のそろった表は受入表として扱う（書き方を1つに縛らない）
    tables = parseTables(maskedLines, 0, maskedLines.length).filter((table) => (
      table.headers.some((header) => /期待/.test(stripMd(header)))
      && table.headers.some((header) => /確認|検証|確かめ/.test(stripMd(header)))
    ));
  }
  if (!acceptSection && tables.length === 0) {
    reasons.push('acceptance_missing');
    details.push('受入表（期待する結果・確認方法の表）が無い');
  } else if (tables.length === 0) {
    reasons.push('acceptance_table_missing');
    details.push(`受入表の見出し（${acceptSection.index + 1}行目）はあるが表の行が無い`);
  } else {
    const usable = tables.filter((table) => (
      table.headers.some((header) => /期待/.test(stripMd(header)))
      && table.headers.some((header) => /確認|検証|確かめ/.test(stripMd(header)))
    ));
    if (usable.length === 0) {
      reasons.push('acceptance_columns_missing');
      details.push('受入表に「期待する結果」「確認方法」の列が無い');
    } else {
      for (const table of usable) {
        acceptanceRows += table.rows.length;
        const expectedIdx = table.headers.findIndex((header) => /期待/.test(stripMd(header)));
        const checkIdx = table.headers.findIndex((header) => /確認|検証|確かめ/.test(stripMd(header)));
        const conditionIdx = table.headers.findIndex((header) => /条件|状況|ケース|項目|場面|観点|入力|操作|テスト/.test(stripMd(header)));
        const reasonIdx = table.headers.findIndex((header) => /理由|根拠|備考|注記|対象外/.test(stripMd(header)));
        for (const row of table.rows) {
          const cell = (index) => (index >= 0 ? row.cells[index] : undefined);
          const condition = stripMd(cell(conditionIdx)) || stripMd(row.cells[0]);
          const expected = stripMd(cell(expectedIdx));
          const check = stripMd(cell(checkIdx));
          if (EXEMPT_RE.test(expected)) {
            const rest = expected.replace(EXEMPT_RE, '').replace(/^[（(【:：、,\s]+/, '').replace(/[）)】]+$/, '');
            const reasonExtra = stripMd(cell(reasonIdx));
            if (rest.length < 6 && reasonExtra.length < 6) {
              reasons.push(`acceptance_exempt_without_reason:${row.line}`);
              details.push(`行${row.line}: 対象外なのに理由が無い（${condition || '条件不明'}）`);
            }
            continue;
          }
          const expectedEcho = expected.length > 0 && expected === condition;
          const checkEcho = check.length > 0 && check === condition;
          if (isBlankCell(cell(expectedIdx)) || expectedEcho) {
            reasons.push(`acceptance_empty_expected:${row.line}`);
            details.push(`行${row.line}: 期待する結果が空（${condition || '条件不明'}）`);
          }
          if (isBlankCell(cell(checkIdx)) || checkEcho) {
            reasons.push(`acceptance_empty_check:${row.line}`);
            details.push(`行${row.line}: 確認方法が空（${condition || '条件不明'}）`);
          }
        }
      }
    }
  }

  return {
    ok: reasons.length === 0,
    items: ITEMS.length + 1,
    acceptanceRows,
    reasons,
    details,
  };
}

function emitError(json, shown, reason, detail) {
  if (json) {
    console.log(JSON.stringify({ ok: false, instruction: shown, reason, detail }));
  } else {
    console.error(`INSTRUCTION_SUBSTANCE_REJECT instruction=${shown} reason=${reason} detail=${detail}`);
  }
  process.exit(2);
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const file = args.find((arg) => !arg.startsWith('--'));
  if (!file) {
    if (json) console.log(JSON.stringify({ ok: false, reason: 'usage', detail: '指示書のパスが無い' }));
    else console.error('usage: node check-instruction-substance.mjs <instruction.md> [--json]');
    process.exit(2);
  }
  const shown = path.resolve(file);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    emitError(json, shown, 'unreadable', error.code || 'read_error');
  }
  if (!text.trim()) emitError(json, shown, 'empty_input', 'ファイルが空（0バイトまたは空白のみ）');

  const result = checkInstructionSubstance(text);
  if (json) {
    console.log(JSON.stringify({
      ok: result.ok,
      instruction: shown,
      items: result.items,
      acceptanceRows: result.acceptanceRows,
      reasons: result.reasons,
      details: result.details,
    }));
  } else if (result.ok) {
    console.log(`INSTRUCTION_SUBSTANCE_OK instruction=${shown} items=${result.items} acceptance_rows=${result.acceptanceRows}`);
  } else {
    const detail = result.details.map((line) => line.replace(/\s+/g, ' ')).join('; ');
    console.log(`INSTRUCTION_SUBSTANCE_REJECT instruction=${shown} reason=${result.reasons.join('+')} detail=${detail}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv);
}
