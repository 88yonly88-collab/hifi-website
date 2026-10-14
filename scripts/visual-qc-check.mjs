#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import {
  atomicWriteJson,
  ensureRegularFile,
  readJson,
  resolveRepoPath,
} from './ai-e2e-lib.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 720 });
const STATUS_EXIT_CODES = Object.freeze({ clean: 0, findings: 1, skipped: 0, unavailable: 2 });
const MAX_SUMMARY_FINDINGS = 50;
const MAX_PAGES = 20;
const OVERALL_TIMEOUT_MS = 180_000;

const valueOptions = new Set(['--url', '--config', '--output']);
const unknownArgs = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (valueOptions.has(arg)) {
    if (!args[index + 1] || args[index + 1].startsWith('--')) unknownArgs.push(arg);
    else index += 1;
  } else {
    unknownArgs.push(arg);
  }
}
if (unknownArgs.length) {
  console.error(`VISUAL_QC_UNAVAILABLE: 不明または値が無いoptionです: ${unknownArgs.join(' ')}`);
  process.exit(2);
}

function option(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || '') : fallback;
}

function oneLine(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function allowedProtocols() {
  return process.env.VISUAL_QC_ALLOW_FILE_URL === '1' ? ['http:', 'https:', 'file:'] : ['http:', 'https:'];
}

function validTargetUrl(value) {
  try {
    const url = new URL(value);
    return allowedProtocols().includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function browserExecutable() {
  const requested = process.env.VISUAL_QC_BROWSER_BIN || process.env.E2E_BROWSER_BIN;
  const candidates = requested
    ? [requested]
    : ['chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable'];
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    for (const directory of String(process.env.PATH || '').split(delimiter).filter(Boolean)) {
      const path = join(directory, candidate);
      if (existsSync(path)) return path;
    }
  }
  return '';
}

function browserVersion(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('版の確認が10000msでtimeoutしました'));
    }, 10_000);
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (status) => {
      clearTimeout(timer);
      if (status === 0) resolve(output.trim() || 'unknown');
      else reject(new Error(`status=${status ?? 'spawn-error'} ${oneLine(output)}`));
    });
  });
}

function normalizeViewport(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('viewportはwidth/heightを持つobjectが必要です');
  }
  const width = Number(raw?.width ?? DEFAULT_VIEWPORT.width);
  const height = Number(raw?.height ?? DEFAULT_VIEWPORT.height);
  if (!Number.isInteger(width) || width < 320 || width > 7680) {
    throw new Error('viewport.widthは320〜7680の整数が必要です');
  }
  if (!Number.isInteger(height) || height < 240 || height > 4320) {
    throw new Error('viewport.heightは240〜4320の整数が必要です');
  }
  return { width, height };
}

function normalizePages(config, baseUrl) {
  const rawPages = Array.isArray(config) ? config : config?.pages;
  if (!Array.isArray(rawPages)) throw new Error('visual-qc.jsonにはpages配列が必要です');
  if (rawPages.length > MAX_PAGES) throw new Error(`pagesは${MAX_PAGES}件以下にしてください`);
  const base = new URL(baseUrl);
  const pages = rawPages.map((entry, index) => {
    const rawUrl = typeof entry === 'string' ? entry : entry?.url ?? entry?.path;
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      throw new Error(`pages[${index}]には文字列またはurl/pathが必要です`);
    }
    const url = new URL(rawUrl, base);
    if (!allowedProtocols().includes(url.protocol)) throw new Error(`pages[${index}]は許可されたURLではありません`);
    if (url.username || url.password) throw new Error(`pages[${index}]に認証情報を含むURLは指定できません`);
    if (url.origin !== base.origin) throw new Error(`pages[${index}]は--urlと同じoriginに限定されます`);
    return {
      url: url.href,
      label: oneLine(typeof entry === 'object' ? entry?.label : '') || url.pathname || '/',
    };
  });
  const seen = new Set();
  for (const page of pages) {
    if (seen.has(page.url)) throw new Error(`pagesに重複URLがあります: ${page.url}`);
    seen.add(page.url);
  }
  return pages;
}

function reportPath() {
  return resolveRepoPath(
    root,
    option('--output', join('.ai', 'e2e', 'visual-qc-report.json')),
    'visual QC出力',
  );
}

function configPath() {
  return resolveRepoPath(root, option('--config', join('.ai', 'visual-qc.json')), 'visual QC設定');
}

function writeReport(output, report) {
  atomicWriteJson(output, report);
  console.log(`VISUAL_QC_JSON: ${output}`);
  console.log(`VISUAL_QC_SUMMARY: status=${report.status} pages=${report.pages.length} findings=${report.findingCount}`);
  for (const warning of report.warnings || []) console.log(`VISUAL_QC_WARNING: ${oneLine(warning)}`);
  for (const finding of (report.findings || []).slice(0, MAX_SUMMARY_FINDINGS)) {
    console.log(`VISUAL_QC_FINDING: ${finding.page} ${finding.type} ${finding.selector}`);
  }
  if ((report.findings || []).length > MAX_SUMMARY_FINDINGS) {
    console.log(`VISUAL_QC_FINDING_MORE: ${report.findings.length - MAX_SUMMARY_FINDINGS}件（全件はJSON参照）`);
  }
}

function baseReport({ baseUrl, viewport }) {
  return {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    baseUrl,
    viewport,
    browser: { name: 'unavailable', version: 'unavailable' },
    status: 'unavailable',
    pages: [],
    findingCount: 0,
    findings: [],
    warnings: [],
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class CdpPipeClient {
  constructor(browser) {
    this.browser = browser;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    this.buffer = Buffer.alloc(0);
    this.input = browser.stdio[3];
    this.output = browser.stdio[4];
    this.output.on('data', (chunk) => this.handleData(chunk));
    this.input.on('error', (error) => this.rejectAll(error));
    this.output.on('error', (error) => this.rejectAll(error));
    browser.once('exit', () => this.rejectAll(new Error('Chromiumとの接続が閉じました')));
  }

  waiterKey(method, sessionId = '') {
    return `${sessionId}:${method}`;
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    let separator = this.buffer.indexOf(0);
    while (separator >= 0) {
      const frame = this.buffer.subarray(0, separator).toString('utf8');
      this.buffer = this.buffer.subarray(separator + 1);
      if (frame) this.handleMessage(frame);
      separator = this.buffer.indexOf(0);
    }
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'Chrome DevTools Protocol error'));
      else pending.resolve(message.result || {});
      return;
    }
    const key = this.waiterKey(message.method, message.sessionId || '');
    const waiters = this.waiters.get(key);
    if (!waiters?.length) return;
    const waiter = waiters.shift();
    if (!waiters.length) this.waiters.delete(key);
    clearTimeout(waiter.timer);
    waiter.resolve(message.params || {});
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
  }

  send(method, params = {}, sessionId = '', timeoutMs = 15_000) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}が${timeoutMs}msでtimeoutしました`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      this.input.write(`${JSON.stringify(message)}\0`, 'utf8', (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(error);
      });
    });
  }

  waitFor(method, sessionId = '', timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const key = this.waiterKey(method, sessionId);
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const waiters = this.waiters.get(key) || [];
          this.waiters.set(key, waiters.filter((candidate) => candidate !== waiter));
          reject(new Error(`${method}を${timeoutMs}ms以内に受信できませんでした`));
        }, timeoutMs),
      };
      const waiters = this.waiters.get(key) || [];
      waiters.push(waiter);
      this.waiters.set(key, waiters);
    });
  }

  cancelWaiters(method, sessionId = '', reason = '待機を取り消しました') {
    const key = this.waiterKey(method, sessionId);
    const waiters = this.waiters.get(key) || [];
    this.waiters.delete(key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
  }

  close() {
    if (!this.input.destroyed) this.input.end();
  }
}

function inspectionExpression() {
  return `(${function inspectVisualQuality() {
    const findings = [];
    const clippedElements = new WeakSet();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const all = [...document.querySelectorAll('*')];
    const roots = new Set([document.documentElement, document.body]);

    function visible(element) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    }

    function selector(element) {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
        let part = current.tagName.toLowerCase();
        const siblings = current.parentElement
          ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current.tagName)
          : [];
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        parts.unshift(part);
        current = current.parentElement;
        if (parts.length >= 5) break;
      }
      return parts.join(' > ') || element.tagName.toLowerCase();
    }

    function add(type, element, details = {}) {
      findings.push({ type, selector: selector(element), ...details });
    }

    function insideHorizontalScroller(element) {
      let current = element.parentElement;
      while (current && !roots.has(current)) {
        const style = getComputedStyle(current);
        if (['auto', 'scroll'].includes(style.overflowX) && current.scrollWidth > current.clientWidth + 1) {
          return true;
        }
        current = current.parentElement;
      }
      return false;
    }

    const documentWidth = Math.max(
      document.documentElement?.scrollWidth || 0,
      document.body?.scrollWidth || 0,
    );
    if (documentWidth > viewport.width + 1) {
      add('horizontal-overflow', document.documentElement, {
        viewportWidth: viewport.width,
        documentWidth,
      });
    }

    for (const element of all) {
      if (roots.has(element) || !visible(element)) continue;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const intersectsViewport = rect.right > 0 && rect.left < viewport.width && rect.bottom > 0 && rect.top < viewport.height;
      const horizontallyClipped =
        intersectsViewport &&
        !insideHorizontalScroller(element) &&
        (rect.left < -1 || rect.right > viewport.width + 1);
      const verticallyClipped =
        intersectsViewport &&
        ['fixed', 'sticky'].includes(style.position) &&
        (rect.top < -1 || rect.bottom > viewport.height + 1);
      if (horizontallyClipped || verticallyClipped) {
        clippedElements.add(element);
        add('viewport-clipping', element, {
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom),
          },
        });
      }
    }

    for (const element of all) {
      if (!visible(element) || clippedElements.has(element)) continue;
      const text = String(element.textContent || '').trim();
      if (!text) continue;
      const style = getComputedStyle(element);
      const clipsX = ['hidden', 'clip'].includes(style.overflowX) || style.textOverflow === 'ellipsis';
      const clipsY = ['hidden', 'clip'].includes(style.overflowY);
      const cutX = clipsX && element.scrollWidth > element.clientWidth + 1;
      const cutY = clipsY && element.scrollHeight > element.clientHeight + 1;
      if (cutX || cutY) {
        add('text-overflow', element, {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        });
      }
    }

    const clickableSelector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      '[role="button"]',
      '[onclick]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    for (const element of document.querySelectorAll(clickableSelector)) {
      if (!visible(element) || element.matches(':disabled') || getComputedStyle(element).pointerEvents === 'none') continue;
      const rect = element.getBoundingClientRect();
      const points = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + 2, rect.top + 2],
        [rect.right - 2, rect.top + 2],
        [rect.left + 2, rect.bottom - 2],
        [rect.right - 2, rect.bottom - 2],
      ].filter(([x, y]) => x >= 0 && x < viewport.width && y >= 0 && y < viewport.height);
      let covering = null;
      for (const [x, y] of points) {
        const top = document.elementFromPoint(x, y);
        if (top && top !== element && !element.contains(top) && !top.contains(element)) {
          covering = top;
          break;
        }
      }
      if (covering) add('clickable-covered', element, { coveredBy: selector(covering) });
    }

    return {
      title: document.title,
      viewport,
      documentWidth,
      findings,
    };
  }.toString()})()`;
}

async function inspectPage(client, page, viewport) {
  const target = await client.send('Target.createTarget', { url: 'about:blank' });
  if (!target.targetId) throw new Error('Chromiumの検品タブを作れません');
  const attached = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  if (!attached.sessionId) throw new Error('Chromiumの検品タブへ接続できません');
  const sessionId = attached.sessionId;
  try {
    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);
    const loaded = client.waitFor('Page.loadEventFired', sessionId);
    // Page.navigateが先に失敗した場合も、この待機Promiseを未処理のまま残さない。
    loaded.catch(() => {});
    try {
      const navigation = await client.send('Page.navigate', { url: page.url }, sessionId);
      if (navigation.errorText) throw new Error(`${page.url}を開けません: ${navigation.errorText}`);
      await loaded;
    } catch (error) {
      client.cancelWaiters('Page.loadEventFired', sessionId, 'ページ移動に失敗したため読み込み待機を終了しました');
      throw error;
    }
    await delay(150);
    const evaluated = await client.send('Runtime.evaluate', {
      expression: inspectionExpression(),
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);
    if (evaluated.exceptionDetails) {
      throw new Error(`画面内の検品処理に失敗しました: ${evaluated.exceptionDetails.text || 'evaluation error'}`);
    }
    return evaluated.result?.value;
  } finally {
    await client.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
  }
}

async function run() {
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  let output;
  try {
    output = reportPath();
  } catch (error) {
    console.error(`VISUAL_QC_UNAVAILABLE: ${error.message}`);
    process.exit(2);
  }
  const baseUrl = option('--url');
  const validBaseUrl = validTargetUrl(baseUrl);
  const report = baseReport({ baseUrl: validBaseUrl ? baseUrl : '', viewport: DEFAULT_VIEWPORT });
  if (!validBaseUrl) {
    report.warnings.push('--urlには認証情報を含まないhttp/https URLが必要です');
    writeReport(output, report);
    process.exit(2);
  }

  let config;
  let configFile;
  try {
    configFile = configPath();
    if (!existsSync(configFile)) {
      report.status = 'skipped';
      report.warnings.push('.ai/visual-qc.jsonが無いため、ページ検品は未実施です');
      writeReport(output, report);
      process.exit(0);
    }
    ensureRegularFile(configFile, 'visual QC設定');
    config = readJson(configFile);
    report.viewport = normalizeViewport(Array.isArray(config) ? null : config?.viewport);
    report.pages = normalizePages(config, baseUrl).map((page) => ({ ...page, status: 'pending', findings: [] }));
    if (!report.pages.length) {
      report.status = 'skipped';
      report.warnings.push('.ai/visual-qc.jsonのpagesが空のため、ページ検品は未実施です');
      writeReport(output, report);
      process.exit(0);
    }
  } catch (error) {
    report.warnings.push(`visual QC設定を読めません: ${error.message}`);
    writeReport(output, report);
    process.exit(2);
  }

  const executable = browserExecutable();
  if (!executable) {
    report.warnings.push('Chromium/Chrome実行ファイルが見つかりません');
    writeReport(output, report);
    process.exit(2);
  }
  try {
    const version = await browserVersion(executable);
    report.browser = { name: basename(executable), version: version || 'unknown' };
  } catch (error) {
    report.warnings.push(`Chromium/Chromeの版を確認できません: ${error.message}`);
    writeReport(output, report);
    process.exit(2);
  }

  const profileDir = mkdtempSync(join(tmpdir(), 'visual-qc-chromium-'));
  let stderr = '';
  const browser = spawn(executable, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--noerrdialogs',
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  browser.on('error', (error) => {
    stderr = `${stderr} ${error.message}`.slice(-12_000);
  });
  browser.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-12_000);
  });
  let overallTimedOut = false;
  const overallTimer = setTimeout(() => {
    overallTimedOut = true;
    if (browser.exitCode === null) browser.kill('SIGKILL');
  }, Math.max(1, deadline - Date.now()));
  let terminationRequested = false;
  const handleTermination = () => {
    terminationRequested = true;
    if (browser.exitCode === null) browser.kill('SIGTERM');
  };
  process.once('SIGTERM', handleTermination);

  try {
    const client = new CdpPipeClient(browser);
    let unavailablePages = 0;
    for (const page of report.pages) {
      try {
        if (Date.now() >= deadline) {
          throw new Error(`visual QC全体が${OVERALL_TIMEOUT_MS}msの上限を超えました`);
        }
        const result = await inspectPage(client, page, report.viewport);
        page.status = 'inspected';
        page.title = oneLine(result?.title);
        page.viewport = result?.viewport;
        page.documentWidth = result?.documentWidth;
        page.findings = (result?.findings || []).map((finding) => ({
          page: page.label,
          url: page.url,
          ...finding,
        }));
        report.findings.push(...page.findings);
      } catch (error) {
        page.status = 'unavailable';
        page.error = oneLine(error.message);
        unavailablePages += 1;
        report.warnings.push(`${page.label}: ${page.error}`);
      }
    }
    report.findingCount = report.findings.length;
    // 一部ページが読めなくても、既に見つけた不良を「実行不能」の陰へ隠さない。
    // 指摘が1件でもあれば自己修正経路へ進め、0件のときだけ unavailable にする。
    report.status = report.findingCount
      ? 'findings'
      : unavailablePages > 0
        ? 'unavailable'
        : 'clean';
    if (unavailablePages > 0 && stderr) report.warnings.push(oneLine(stderr));
    client.close();
  } catch (error) {
    report.status = 'unavailable';
    await delay(50);
    const message = overallTimedOut
      ? `visual QC全体が${OVERALL_TIMEOUT_MS}msの上限を超えました`
      : terminationRequested
        ? 'visual QCが外側の待ち時間上限により終了要求を受けました'
      : error.message;
    report.warnings.push(oneLine(`${message}${stderr ? `: ${stderr}` : ''}`));
  } finally {
    clearTimeout(overallTimer);
    process.removeListener('SIGTERM', handleTermination);
    if (browser.exitCode === null) browser.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => browser.once('exit', resolve)),
      delay(2_000),
    ]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
    rmSync(profileDir, { recursive: true, force: true });
  }

  writeReport(output, report);
  process.exit(terminationRequested ? 2 : STATUS_EXIT_CODES[report.status] ?? 2);
}

run().catch((error) => {
  console.error(`VISUAL_QC_UNAVAILABLE: ${oneLine(error.message)}`);
  process.exit(2);
});
