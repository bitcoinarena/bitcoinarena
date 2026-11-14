#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE END-TO-END REGRESSION SUITE (kanban #2642): one runner that stands up a private regtest devnet (packages/arena-node/tools/devnet.mjs:
// a chain, a 5-of-7 federation, seven seats, two gateways on two lnds, a payee lnd), serves the real page built from this tree
// (tools/build-arena-page.mjs), drives it in a real headless Chrome, runs every flow of e2e/flows/*.mjs, and writes the report:
// <out>/report.json and <out>/REPORT.md (flow, pass / fail / not covered, evidence, time).
//
//   BITCOIN_BIN=... FEDIMINT_BIN=... LND_BIN=... DEVNET_DIR=... DEVNET_BASE_PORT=13000 E2E_PAGE_DIR=<built page> E2E_OUT=<dir> \
//     node e2e/run.mjs [--up] [--liquidity] [--only id,id|area] [--skip id,...]
//
//   --up         `devnet.mjs up` first (a no-op for parts already running)  --liquidity  `devnet.mjs liquidity` (channels, gateway e-cash, LNURL)
//   E2E_PAGE_PORT  where the page is served (default base + 9): with brotli .unityweb sent as content-encoding br, as the live site sends them
//   E2E_FAUCET_PORT the faucet service of tools/faucet.mjs the page's /api/faucet is proxied to (default base + 15; flows/faucet.mjs uses it to + 3)
// Regtest only. Nothing here reaches a live seat, the live page, the live faucet or a wallet with real money.
import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { devnetOf, flowDir, wait } from './lib/ctx.mjs';
import { launch } from './lib/cdp.mjs';
import { servePage } from './lib/page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const env = process.env;
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const OUT = resolve(env.E2E_OUT || join(HERE, 'out'));
const BASE = Number(env.DEVNET_BASE_PORT || 24000);
const DEVNET_DIR = resolve(env.DEVNET_DIR || 'devnet-data');
const PAGE_PORT = Number(env.E2E_PAGE_PORT || BASE + 9);
const FAUCET_PORT = Number(env.E2E_FAUCET_PORT || BASE + 15);   // base + 10 .. 12 is lnd A
mkdirSync(OUT, { recursive: true });
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
// THE MACHINE'S LOAD RULE (the MacBook carries a live node beside the suite: keep the load under 19): a headless Chrome running Unity on
// SwiftShader takes ~5 cores, so a browser is started only while the 1-minute load is under E2E_MAX_LOAD (default 14), waiting up to E2E_GATE_MS (default 2 min)
const MAX_LOAD = Number(env.E2E_MAX_LOAD || 14);
async function loadGate(tell) {
  const { loadavg } = await import('node:os');
  const t = Date.now();
  while (loadavg()[0] >= MAX_LOAD && Date.now() - t < Number(env.E2E_GATE_MS || 120000)) { if ((Date.now() - t) % 60000 < 5000) tell({ waitingForLoad: Math.round(loadavg()[0] * 10) / 10, under: MAX_LOAD }); await wait(5000); }
}

function devnetCmd(cmd, ms) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [join(ROOT, 'packages/arena-node/tools/devnet.mjs'), ...cmd], { cwd: join(ROOT, 'packages/arena-node'), encoding: 'utf8', timeout: ms, env });
  writeFileSync(join(OUT, `devnet-${cmd[0]}.log`), `${r.stdout || ''}${r.stderr || ''}`);
  say({ devnet: cmd.join(' '), status: r.status, seconds: Math.round((Date.now() - t) / 1000) });
  if (r.status !== 0) throw new Error(`devnet ${cmd[0]} failed (${OUT}/devnet-${cmd[0]}.log): ${String(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  return r.stdout;
}

async function main() {
  const t0 = Date.now();
  if (args.includes('--up')) devnetCmd(['up'], 1200000);
  if (args.includes('--liquidity')) devnetCmd(['liquidity'], 1200000);
  const dn = devnetOf({ dir: DEVNET_DIR, base: BASE, btcBin: env.BITCOIN_BIN, lndBin: env.LND_BIN, fedBin: env.FEDIMINT_BIN });
  const st = dn.state();
  if (!st || st.status !== 'up') throw new Error(`the devnet in ${DEVNET_DIR} is not up (runner state: ${st ? st.status : 'none'}): run with --up`);
  // THE PAGE, served as the site serves it; /api/faucet goes to the suite's own faucet service (flows/faucet.mjs starts it)
  const pageDir = resolve(env.E2E_PAGE_DIR || env.DEVNET_PAGE_DIR || '');
  if (!pageDir || !existsSync(join(pageDir, 'index.html'))) throw new Error('E2E_PAGE_DIR names no built page (node tools/build-arena-page.mjs <out> --ui <n> --client <release>)');
  const page = await servePage(pageDir, PAGE_PORT, { faucet: `http://127.0.0.1:${FAUCET_PORT}`, anchor: dn.cli('getblockhash', '0') });
  const pageUrl = `http://127.0.0.1:${PAGE_PORT}`;
  const lobbyUrl = st.lobbyUrl.replace(/^https?:\/\/[^/?]+/, pageUrl);
  // THE FLOWS
  const only = (opt('only') || '').split(',').filter(Boolean), skipIds = (opt('skip') || '').split(',').filter(Boolean);
  const modules = readdirSync(join(HERE, 'flows')).filter((f) => f.endsWith('.mjs')).sort();
  const all = [];
  for (const f of modules) for (const fl of (await import(pathToFileURL(join(HERE, 'flows', f)).href)).flows) all.push({ ...fl, module: f });
  const chosen = all.filter((f) => (!only.length || only.some((o) => f.id === o || f.area === o || f.id.startsWith(`${o}.`))) && !skipIds.includes(f.id));
  // money first, then reach (the order the ticket asks for)
  chosen.sort((a, b) => (b.money - a.money) || (b.reach - a.reach) || (a.order ?? 50) - (b.order ?? 50));
  say({ flows: chosen.length, of: all.length, page: pageUrl, devnet: DEVNET_DIR });
  const shared = {};   // what one flow leaves for another (a funded wallet's words, a settled round)
  const results = [];
  const chromes = [];
  // A KILLED RUN TAKES ITS BROWSERS WITH IT (measured: two headless Chromes of a killed run kept drawing Unity on the MacBook)
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGALRM']) process.once(sig, async () => { for (const b of chromes.splice(0)) await b.close().catch(() => {}); process.exit(3); });
  const ctx = (f) => ({ env, out: OUT, dir: flowDir(OUT, f.id), dn, pageUrl, lobbyUrl, shared, root: ROOT, faucetUrl: `http://127.0.0.1:${FAUCET_PORT}`, page,
    async chrome(opts = {}) { const b = await launch({ dir: join(flowDir(OUT, f.id), `chrome-${chromes.length}`), ...opts }); chromes.push(b); return b; },
    say: (o) => say({ flow: f.id, ...o }) });
  // flows sharing state run in the order they name (after: [...]); the rest by priority
  const done = new Set();
  const queue = [...chosen];
  while (queue.length) {
    let i = queue.findIndex((f) => !(f.after || []).some((a) => queue.some((q) => q.id === a)));
    if (i < 0) i = 0;
    const [f] = queue.splice(i, 1);
    await loadGate((o) => say({ flow: f.id, ...o }));   // before the flow's clock starts
    const t = Date.now();
    let r;
    const c = ctx(f);
    try {
      const evidence = await Promise.race([f.run(c), wait(f.timeoutMs || 300000).then(() => { throw new Error(`timed out after ${Math.round((f.timeoutMs || 300000) / 1000)} s`); })]);
      r = { id: f.id, area: f.area, title: f.title, money: f.money, reach: f.reach, result: 'pass', evidence: evidence ?? {} };
    } catch (e) {
      r = { id: f.id, area: f.area, title: f.title, money: f.money, reach: f.reach, result: e.skip ? 'not covered' : 'fail', why: e.message, ...(e.evidence ? { evidence: e.evidence } : {}),
        ...(e.skip ? {} : { stack: String(e.stack || '').split('\n').slice(0, 4).join(' | ') }) };
    }
    for (const b of chromes.splice(0)) await b.close().catch(() => {});
    r.seconds = Math.round((Date.now() - t) / 100) / 10;
    r.dir = c.dir;
    results.push(r);
    done.add(f.id);
    say({ flow: f.id, result: r.result, seconds: r.seconds, ...(r.why ? { why: r.why.slice(0, 300) } : {}) });
    writeReport(results, t0, false);
  }
  writeReport(results, t0, true);
  page.close();
  return results;
}

function writeReport(results, t0, final) {
  const count = (x) => results.filter((r) => r.result === x).length;
  const head = { suite: 'bitcoin-arena e2e (kanban #2642)', final, started: new Date(t0).toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
    commit: (() => { try { return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || env.E2E_COMMIT || null; } catch { return env.E2E_COMMIT || null; } })() || env.E2E_COMMIT || null,
    pass: count('pass'), fail: count('fail'), notCovered: count('not covered') };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ ...head, results }, (k, v) => (typeof v === 'bigint' ? String(v) : v), 1) + '\n');
  const ev = (r) => (r.result === 'pass' ? JSON.stringify(r.evidence, (k, v) => (typeof v === 'bigint' ? String(v) : v)) : r.why || '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 260);
  const md = [`# E2E report (kanban #2642)`, '', `${head.started} · ${head.seconds} s · commit ${head.commit || '?'} · **${head.pass} pass, ${head.fail} fail, ${head.notCovered} not covered**${final ? '' : ' (running)'}`, '',
    '| flow | area | result | s | evidence / why |', '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.area} | ${r.result === 'pass' ? 'pass' : r.result === 'fail' ? '**FAIL**' : 'not covered'} | ${r.seconds} | ${ev(r)} |`), ''];
  writeFileSync(join(OUT, 'REPORT.md'), md.join('\n'));
}

main().then((r) => { say({ done: true, pass: r.filter((x) => x.result === 'pass').length, fail: r.filter((x) => x.result === 'fail').length, notCovered: r.filter((x) => x.result === 'not covered').length }); process.exit(0); },
  (e) => { console.error(e.stack || e.message); process.exit(2); });
