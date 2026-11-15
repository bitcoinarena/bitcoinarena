#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE PAID ROUND OF EVERY LIVE GAME ON TESTNET4 (kanban #2642, the owner 2026-11-14: "Teste bezahlte Runden alle Spiele ob alles geht, Teil der
// Regression"). Separate from the devnet suite (run.mjs): this plays against the real testnet4 seats with the headless tools the release
// checks use - the page's own wasm lock client in Node, each entry bot-marked with the admin code (tools/mark-bot.mjs) - and reads each
// step's time and the settlement from their JSON lines. Testnet4 sats only; never mainnet.
//
//   NODES=<seat urls> INVITE_FILE=<testnet4 federation invite> WASM_PKG=<dir with blwp_lock_client.js> GATEWAY=<gateway url>
//   LNCLI=<lncli> PAYER_DIR=<testnet4 lnd dir> PAYER_RPC=<host:port> [FEDERATION=<hex prefix>] [E2E_OUT=<dir>]
//     node e2e/live-paid.mjs [nextblock] [rps] [updown]
//
//   nextblock  tools/tn4-live-run.mjs: deposit, stake + fee locked, a driven run, the settlement read until accepted, the payout withdrawn
//   rps        tools/tn4-rps-paid.mjs: two paid players at one table, both reveal, the settlement read until FINAL
//   updown     tools/market-bot.mjs with one order (MAX_ORDERS=1, one loop): a paid prediction in an open 15-minute window
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_PKG = resolve(HERE, '..', 'packages', 'arena-node');
const env = process.env;
const OUT = resolve(env.E2E_OUT || join(HERE, 'out-live'));
mkdirSync(OUT, { recursive: true });
for (const k of ['NODES', 'INVITE_FILE', 'WASM_PKG', 'LNCLI', 'PAYER_DIR', 'PAYER_RPC']) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
if (/mainnet|bitcoin\/mainnet|:8332\b/i.test(`${env.PAYER_DIR} ${env.PAYER_RPC}`)) { console.error('a mainnet payer: refused'); process.exit(2); }
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

function run(name, tool, extra, ms) {
  const lines = [];
  const log = createWriteStream(join(OUT, `${name}.log`));
  const t0 = Date.now();
  return new Promise((done) => {
    const c = spawn(process.execPath, [join(NODE_PKG, 'tools', tool)], { cwd: NODE_PKG, env: { ...env, ARENA_TN4_NETWORK: 'testnet4', ...extra } });
    let buf = '';
    c.stdout.on('data', (d) => { log.write(d); buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const j = JSON.parse(l); j.tMs = Date.now() - t0; lines.push(j); } catch { /* text */ } } });
    c.stderr.on('data', (d) => log.write(d));
    const kill = setTimeout(() => c.kill('SIGTERM'), ms);
    c.on('exit', (code) => { clearTimeout(kill); done({ code, lines, seconds: Math.round((Date.now() - t0) / 1000) }); });
  });
}
const steps = (lines) => { const seen = new Map(); for (const l of lines) if (l.step && !seen.has(l.step)) seen.set(l.step, Math.round(l.tMs / 1000)); return Object.fromEntries(seen); };
const last = (lines, s) => lines.filter((l) => l.step === s).pop();

const GAMES = {
  async nextblock() {
    const r = await run('nextblock', 'tn4-live-run.mjs', { COLLECT_MS: String(40 * 60000), WITHDRAW: '1', KEYS_FILE: join(OUT, 'nextblock-keys.jsonl') }, 60 * 60000);
    const dep = last(r.lines, 'deposit'), lock = last(r.lines, 'locked'), round = last(r.lines, 'round'), handed = last(r.lines, 'handed over');
    const settle = r.lines.filter((l) => /settle|payout|collect|withdr/i.test(l.step || '')).pop();
    return { pass: r.code === 0, exit: r.code, round: round && round.id, depositMsat: dep && dep.msat, lockedMsat: lock && lock.msat,
      seatsTook: handed ? handed.signerNodes.filter((x) => x.entry === 201).length : 0, last: settle && { step: settle.step, ...(settle.why ? { why: String(settle.why).slice(0, 200) } : {}) },
      stepsAtSeconds: steps(r.lines), seconds: r.seconds };
  },
  async rps() {
    // a table whose entry closes more than 270 s ahead is needed; the grid posts them every few minutes - asked again for up to 15 min
    let r;
    for (let i = 0; i < 15; i++) {
      r = await run('rps', 'tn4-rps-paid.mjs', { KEYS_FILE: join(OUT, 'rps-keys.jsonl'), RPS_GAME_ID: env.RPS_GAME_ID || 'listed', ...(env.RPS_OPPONENT ? { OPPONENT: env.RPS_OPPONENT } : {}) }, 60 * 60000);
      if (!(r.code !== 0 && r.lines.some((l) => /no RPS round held/.test(String(l.why || ''))))) break;
      await new Promise((ok) => setTimeout(ok, 60000));
    }
    const fin = r.lines.filter((l) => /settle|final|result|reveal/i.test(l.step || '')).slice(-3);
    return { pass: r.code === 0, exit: r.code, round: (last(r.lines, 'round') || {}).id || null, last: fin.map((l) => ({ step: l.step, ...(l.why ? { why: String(l.why).slice(0, 160) } : {}) })), stepsAtSeconds: steps(r.lines), seconds: r.seconds };
  },
  async updown() {
    const bot = join(OUT, 'updown-bot');
    mkdirSync(bot, { recursive: true });
    const r = await run('updown', 'market-bot.mjs', { BOT_DIR: bot, BOT_NAME: 'e2e2642', MAX_ORDERS: '1', LEVELS: '1', SHARES: '100', LOOP_S: '60',
      BOOK_BOT: env.BOOK_BOT || resolve(HERE, '..', 'packages', 'btc-updown', 'page', 'book-bot.js') }, 25 * 60000);
    const placed = r.lines.filter((l) => l.step === 'order'), collected = r.lines.filter((l) => l.step === 'collected');
    return { pass: placed.length > 0, exit: r.code, orders: placed.map((o) => ({ round: o.round, side: o.side, priceCents: o.priceCents, stakeMsat: o.stakeMsat, took: o.took })), collected: collected.map((c) => ({ round: c.round, payoutMsat: c.payoutMsat, stakeMsat: c.stakeMsat, refundMsat: c.refundMsat, creditedMsat: c.creditedMsat })), last: r.lines.slice(-3).map((l) => ({ step: l.step, ...(l.why ? { why: String(l.why).slice(0, 160) } : {}) })), stepsAtSeconds: steps(r.lines), seconds: r.seconds };
  },
};

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(GAMES);
const report = { suite: 'bitcoin-arena live paid rounds, testnet4 (kanban #2642)', started: new Date().toISOString(), games: {} };
for (const g of want) {
  if (!GAMES[g]) { say({ game: g, skipped: 'no such game here' }); continue; }
  say({ game: g, start: true });
  try { report.games[g] = await GAMES[g](); } catch (e) { report.games[g] = { pass: false, why: e.message }; }
  say({ game: g, ...report.games[g] });
  writeFileSync(join(OUT, 'live-report.json'), JSON.stringify(report, null, 1) + '\n');
}
