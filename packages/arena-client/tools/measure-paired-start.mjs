// CAN THIS HOST START TWO PLAYERS AT ONCE, AND WHEN IT CANNOT, WHAT IS THE ONE THAT DIED HOLDING?
//
// the owner 2026-09-18 08:55: one of two clients stopped at "90 % - 20.1 / 22.3 MB - Could not start", and that is why
// no ghost label has been read out of a browser on this host. This counts the failure over N paired starts and prints
// what the failing tab holds rather than guessing: the loading screen's own stall record (`BLWP_LOAD_STALLED`, set by
// the page's watchdog after 90 s on one line), the stage and percentage it stopped on, that browser's resident memory,
// what the host had free at that moment, and any WebGL context loss or out-of-memory the browser reported.
//
// It loads the PAGE only - no round, no PLAY - because what is being measured is whether two 22.3 MB players can be
// brought up beside each other at all.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const PAGE = arg('page', 'https://btc-logistics-core.pages.dev/');
const PAIRS = Number(arg('pairs', 4));
const PATIENCE_S = Number(arg('patience', 240));
const CHROME = arg('chrome', '/home/operator/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (l) => console.log(`${new Date().toISOString().slice(11, 19)}  ${l}`);

/** What the host has left, in MB, from the kernel's own figure. */
const hostFreeMb = () => {
  const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
  return m ? Math.round(Number(m[1]) / 1024) : -1;
};
/** Resident memory of a process and every child of it, in MB - a browser is a tree. */
const treeRssMb = (root) => {
  let total = 0;
  const kids = (pid) => {
    try { return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean); }
    catch { return []; }
  };
  const walk = (pid) => {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = /VmRSS:\s+(\d+) kB/.exec(status);
      if (m) total += Number(m[1]) / 1024;
    } catch {}
    for (const k of kids(pid)) walk(k);
  };
  walk(root);
  return Math.round(total);
};

async function tab(name, port) {
  const dir = mkdtempSync(join(tmpdir(), `blwp-${name}-`));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--no-sandbox', `--user-data-dir=${dir}`,
    '--window-size=1280,800', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', PAGE,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const trouble = [];
  proc.stderr.on('data', (b) => {
    const s = String(b);
    if (/context lost|Out of memory|oom|allocation failed|crash/i.test(s)) trouble.push(s.trim().slice(0, 160));
  });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await wait(1000);
    const l = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
    target = l.find((t) => t.type === 'page' && t.url.startsWith('http'));
  }
  if (!target) return { name, proc, dead: 'chrome never opened the page', trouble, close: () => proc.kill('SIGKILL') };
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 32 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') {
      const line = m.params.args.map((x) => x.value ?? x.description ?? '').join(' ');
      if (/stalled|context lost|out of memory|abort/i.test(line)) trouble.push(`console: ${line.slice(0, 160)}`);
    }
  });
  const send = (method, params = {}) => new Promise((r) => {
    const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Runtime.enable');
  const evaluate = async (e) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }), wait(15000).then(() => null)]);
    if (!r) return 'TIMED OUT';
    return r.result?.exceptionDetails ? `THREW ${r.result.exceptionDetails.text}` : r.result?.result?.value;
  };
  return { name, proc, ws, evaluate, trouble, close: () => { try { ws.close(); } catch {} try { proc.kill('SIGKILL'); } catch {} } };
}

// WHAT THE LOADING SCREEN SAYS ABOUT ITSELF, in its own words.
const LOADING = `(function () {
  var stage = document.getElementById('stage');
  var pct = document.getElementById('pct');
  return {
    up: !!window.unityInstance,
    stage: stage ? stage.textContent : '(no stage)',
    pct: pct ? pct.textContent.replace(/\\s+/g, ' ').trim() : '',
    stalled: window.BLWP_LOAD_STALLED ? (window.BLWP_LOAD_STALLED.stage + ' at ' + window.BLWP_LOAD_STALLED.pct) : '',
    heapMb: (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1),
    limitMb: (performance.memory ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : -1)
  };
})()`;

const results = [];
say(`${PAIRS} paired starts of ${PAGE}, ${PATIENCE_S} s of patience each; host free ${hostFreeMb()} MB at the start`);
for (let pair = 1; pair <= PAIRS; pair++) {
  const a = await tab('tabA', 9361);
  const b = await tab('tabB', 9362);
  const both = [a, b];
  const done = { tabA: 0, tabB: 0 };
  const end = { tabA: null, tabB: null };
  const began = Date.now();
  while (Date.now() - began < PATIENCE_S * 1000 && (!end.tabA || !end.tabB)) {
    for (const t of both) {
      if (end[t.name] || !t.evaluate) { if (!t.evaluate && !end[t.name]) end[t.name] = { how: t.dead }; continue; }
      const s = await t.evaluate(LOADING);
      if (!s || typeof s === 'string') continue;
      if (s.up) { end[t.name] = { how: 'started', afterS: Math.round((Date.now() - began) / 1000), heapMb: s.heapMb }; continue; }
      if (s.stalled) {
        end[t.name] = {
          how: 'STALLED', at: s.stalled, afterS: Math.round((Date.now() - began) / 1000),
          rssMb: treeRssMb(t.proc.pid), freeMb: hostFreeMb(), heapMb: s.heapMb, limitMb: s.limitMb,
        };
      }
      done[t.name] = s.pct;
    }
    await wait(3000);
  }
  for (const t of both) if (!end[t.name]) end[t.name] = { how: 'still loading when patience ran out', at: done[t.name], rssMb: treeRssMb(t.proc.pid), freeMb: hostFreeMb() };
  const line = (t) => `${t.name} ${end[t.name].how}`
    + (end[t.name].afterS !== undefined ? ` after ${end[t.name].afterS} s` : '')
    + (end[t.name].at ? ` [${end[t.name].at}]` : '')
    + (end[t.name].rssMb ? `, that browser ${end[t.name].rssMb} MB resident, host had ${end[t.name].freeMb} MB free` : '')
    + (end[t.name].heapMb > 0 ? `, js heap ${end[t.name].heapMb}/${end[t.name].limitMb} MB` : '');
  say(`pair ${pair}: ${line(a)}`);
  say(`pair ${pair}: ${line(b)}`);
  for (const t of both) if (t.trouble.length) say(`pair ${pair} ${t.name} said: ${[...new Set(t.trouble)].slice(0, 3).join(' | ')}`);
  results.push({ pair, a: end.tabA, b: end.tabB });
  for (const t of both) t.close();
  await wait(4000);
}

const bothUp = results.filter((r) => r.a.how === 'started' && r.b.how === 'started').length;
const stalls = results.flatMap((r) => [['tabA', r.a], ['tabB', r.b]]).filter(([, e]) => e.how !== 'started');
console.log(`\n# ${bothUp} of ${results.length} paired starts had BOTH players up`);
for (const [who, e] of stalls) console.log(`  ${who}: ${e.how}${e.at ? ` [${e.at}]` : ''}`
  + `${e.rssMb ? `, ${e.rssMb} MB resident, ${e.freeMb} MB free on the host` : ''}`);
const ups = results.flatMap((r) => [r.a, r.b]).filter((e) => e.how === 'started').map((e) => e.afterS);
console.log(ups.length ? `players that did start took ${Math.min(...ups)}-${Math.max(...ups)} s` : 'no player started at all');
console.log(`host free now ${hostFreeMb()} MB`);
process.exit(0);
