// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A REAL HEADLESS CHROME OVER CDP for the e2e suite (kanban #2642): no Puppeteer, only `ws` (the repo's own dependency), as
// packages/arena-installer/tools/wizard-drive.mjs and packages/arena-client/tools/lobby-page.mjs drive theirs.
//   const b = await launch({ chrome, dir });  const t = await b.tab(url);  await t.js('document.title');  await t.shot(file);  await b.close();
// Each tab records its console (errors apart), its uncaught exceptions and every request it made, for the report's evidence.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(process.env.E2E_DEPS ? `${process.env.E2E_DEPS}/` : import.meta.url);
const WebSocket = req('ws');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const DEFAULT_CHROME = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : '/usr/bin/google-chrome';

/** Start one headless Chrome with its own profile in `dir`. Answers { tab(url), close() }. */
export async function launch({ chrome = process.env.CHROME || DEFAULT_CHROME, dir, width = 1280, height = 860, extra = [] } = {}) {
  mkdirSync(dir, { recursive: true });
  const profile = join(dir, 'profile');
  mkdirSync(profile, { recursive: true });
  const port = 9400 + Math.floor(Math.random() * 400);
  // under nice -n 19 (the MacBook carries a live node; nice execs Chrome, so the pid is Chrome's)
  const proc = spawn('nice', ['-n', '19', chrome, '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', `--window-size=${width},${height}`, '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required',
    // the devnet's seats are http://127.0.0.1: the page is served from 127.0.0.1 too, so no private-network block applies
    ...extra, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
  let errOut = '';
  proc.stderr.on('data', (d) => { errOut = (errOut + d).slice(-4000); });
  let version = null;
  for (let i = 0; i < 80 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await wait(250); }
  }
  if (!version) { proc.kill('SIGKILL'); throw new Error(`chrome did not open its debugging port: ${errOut.slice(-300)}`); }
  const tabs = [];
  return {
    port,
    async tab(url, opts = {}) {
      const t = await openTab(port, url, opts);
      tabs.push(t);
      return t;
    },
    async close() {
      for (const t of tabs) { try { t.ws.close(); } catch { /* gone */ } }
      // Browser.close first: a SIGTERM'd Chrome loses what the page kept in IndexedDB since its last flush (measured: a wallet made
      // and checked in one run was gone in the next browser on the same profile), and a player's browser closes like this
      try {
        const bw = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
        await new Promise((ok, no) => { bw.once('open', ok); bw.once('error', no); });
        bw.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
        for (let i = 0; i < 50 && proc.exitCode === null; i++) await wait(200);
      } catch { /* fall through to the signal */ }
      if (proc.exitCode === null) proc.kill('SIGTERM');
      for (let i = 0; i < 20 && proc.exitCode === null; i++) await wait(150);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    },
  };
}

async function openTab(port, url, { viewport, allowExternal = false, noUnity = false } = {}) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); });
  let n = 0;
  const pending = new Map();
  const listeners = new Set();
  const log = { console: [], errors: [], requests: [], failed: [], dialogs: [] };
  ws.on('message', (m) => {
    const d = JSON.parse(m);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.no(new Error(`${p.method}: ${d.error.message}`)) : p.ok(d.result); return; }
    if (d.method === 'Runtime.consoleAPICalled') {
      const text = d.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 600);
      log.console.push({ type: d.params.type, text, at: Date.now() });
      if (log.console.length > 3000) log.console.splice(0, 1000);
    } else if (d.method === 'Runtime.exceptionThrown') {
      const e = d.params.exceptionDetails;
      log.errors.push({ text: (e.exception?.description || e.text || '').slice(0, 800), url: e.url, line: e.lineNumber, at: Date.now() });
    } else if (d.method === 'Network.requestWillBeSent') {
      log.requests.push({ id: d.params.requestId, method: d.params.request.method, url: d.params.request.url.slice(0, 400), at: Date.now() });
      if (log.requests.length > 6000) log.requests.splice(0, 2000);
    } else if (d.method === 'Network.responseReceived') {
      const r = log.requests.findLast?.((x) => x.id === d.params.requestId);
      if (r) r.status = d.params.response.status;
    } else if (d.method === 'Network.loadingFailed') {
      const r = log.requests.findLast?.((x) => x.id === d.params.requestId);
      log.failed.push({ url: r?.url, why: d.params.errorText, blocked: d.params.blockedReason, at: Date.now() });
    } else if (d.method === 'Page.javascriptDialogOpening') {
      log.dialogs.push({ type: d.params.type, message: d.params.message.slice(0, 400), at: Date.now() });
    }
    for (const f of listeners) { try { f(d); } catch { /* a listener's own fault */ } }
  });
  const call = (method, params = {}, ms = 60000) => new Promise((ok, no) => {
    const id = ++n;
    const timer = setTimeout(() => { pending.delete(id); no(new Error(`${method}: no answer in ${ms} ms`)); }, ms);
    pending.set(id, { method, ok: (v) => { clearTimeout(timer); ok(v); }, no: (e) => { clearTimeout(timer); no(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await call('Runtime.enable');
  await call('Network.enable');
  await call('Page.enable');
  // NOTHING LEAVES THE MACHINE: the devnet is all http on 127.0.0.1, so every https and wss request (the live site, public Nostr
  // relays, price feeds) is blocked and listed in log.failed - a flow never reaches a live service
  // noUnity: Next Block's WebGL client is not fetched (a flow about the wallet does not need it; Unity on SwiftShader costs ~5 cores)
  if (!allowExternal || noUnity) await call('Network.setBlockedURLs', { urls: [...(allowExternal ? [] : ['https://*', 'wss://*']), ...(noUnity ? ['*.unityweb'] : [])] });
  if (viewport) await call('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: !!viewport.mobile });
  const t = {
    ws, call, log, targetId: target.id,
    /** Evaluate an expression in the page (promises awaited); answers its value, or throws the page's exception. */
    async js(expression, ms = 60000) {
      const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, ms);
      if (r.exceptionDetails) throw new Error(`page threw: ${(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400)}`);
      return r.result.value;
    },
    async go(u, settleMs = 1500) {
      const loaded = new Promise((ok) => { const f = (d) => { if (d.method === 'Page.loadEventFired') { listeners.delete(f); ok(); } }; listeners.add(f); });
      await call('Page.navigate', { url: u });
      await Promise.race([loaded, wait(45000)]);
      await wait(settleMs);
    },
    /** Wait until `expression` is truthy in the page; answers its value or throws after `ms`. */
    async until(expression, ms = 30000, what = expression) {
      const end = Date.now() + ms;
      let last;
      while (Date.now() < end) {
        try { last = await t.js(expression, 15000); if (last) return last; } catch (e) { last = e.message; }
        await wait(400);
      }
      throw new Error(`not in ${Math.round(ms / 1000)} s: ${String(what).slice(0, 160)} (last: ${String(last).slice(0, 160)})`);
    },
    /** Click the first element matching a CSS selector, or whose visible text matches `text` (a regexp source). */
    async click(selector, text) {
      return t.js(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const re = ${text ? `new RegExp(${JSON.stringify(text)}, 'i')` : 'null'};
        const el = all.find((e) => (!re || re.test((e.innerText || e.value || e.getAttribute('aria-label') || '').trim())) && (e.offsetParent !== null || getComputedStyle(e).position === 'fixed'));
        if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
    },
    text: () => t.js('document.body ? document.body.innerText : ""'),
    async shot(file, full = false) {
      let clip;
      if (full) { const h = await t.js('Math.min(Math.max(document.documentElement.scrollHeight, 600), 6000)'); clip = { x: 0, y: 0, width: 1280, height: h, scale: 1 }; }
      const s = await call('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) }, 60000);
      writeFileSync(file, Buffer.from(s.data, 'base64'));
      return file;
    },
    async close() { try { await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`); } catch { /* gone */ } try { ws.close(); } catch { /* gone */ } },
  };
  if (url && url !== 'about:blank') await t.go(url);
  return t;
}

export { servePage as servePageDir } from './page.mjs';
