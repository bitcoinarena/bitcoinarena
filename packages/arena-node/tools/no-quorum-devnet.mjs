#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RE-RUN WINDOW BEFORE VOID, ON SEVEN REAL SEATS (§13A, §13C, kanban #1038, the labels ruled on #1045 and #1047). Regtest only, on a devnet started at protocol 22
// (ARENA_PROTOCOL_VERSION=22 DEVNET_KEEPER=0 devnet.mjs up, then its liquidity step). A paid round of two entries, played by tools/tn4-live-run.mjs, the page's lock client, and
// one fault, made with SIGSTOP on the seat's node process alone (its guardian keeps running) once the entries are published:
//
//   SCENARIO=honest            nothing stopped: FINAL and settled as ever, no re-run on record
//   SCENARIO=two-slow          the control, which cannot fail: seats 6 and 7 stopped; the other five reach the quorum
//   SCENARIO=one-back          seats 5, 6 and 7 stopped with their receipts unread and nobody handed them: nobody can sign. Seat 5 back inside the window, which is the case the rule is
//                              for (#1060); seats 6 and 7 back after + 1805 s
//   SCENARIO=three-silent      seats 5, 6 and 7 stopped the same way to the window's end: VOID, nobody paid, the lock left for its player
//   SCENARIO=no-mark           both players enter and send no mark; seats 5, 6 and 7 stopped before the start deadline: VOID at final_after, nothing waited for
//   SCENARIO=one-back-carried  one-back with the stopped seats' receipts handed to the other four first: what a seat that goes out just after answering the close's pull leaves behind
//
// Every state read is printed with its time from the round's end, once per change. Stopped seats are always sent SIGCONT at the end, by pid. Settings as tools/devnet.mjs
// (DEVNET_DIR, DEVNET_BASE_PORT), with PAYER_DIR, INVITE_FILE, WASM_PKG and LNCLI as tn4-live-run.mjs takes.
import { spawn } from 'node:child_process';
import { readFileSync, openSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { devnetPorts } from './devnet-plan.mjs';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const D = resolve(env.DEVNET_DIR || 'devnet-data');
const PLAN = devnetPorts(Number(env.DEVNET_BASE_PORT || 24000));
const SEATS = PLAN.nodes.map((p) => `http://127.0.0.1:${p}`);
const SCENARIO = env.SCENARIO || 'honest';
const PLANS = {
  honest: { stop: [], carry: false, limit: 760 },
  'two-slow': { stop: [5, 6], carry: false, limit: 760, backAt: { 5: 700, 6: 700 } },
  'one-back': { stop: [4, 5, 6], carry: false, limit: 1980, backAt: { 4: 800, 5: 1900, 6: 1900 } },
  'one-back-carried': { stop: [4, 5, 6], carry: true, limit: 1980, backAt: { 4: 800, 5: 1900, 6: 1900 } },
  'three-silent': { stop: [4, 5, 6], carry: false, limit: 1360 },
  'no-mark': { stop: [4, 5, 6], carry: false, limit: 760, noMarks: true },
};
const plan = PLANS[SCENARIO];
if (!plan) { console.error(`SCENARIO is one of ${Object.keys(PLANS).join(', ')}`); process.exit(2); }
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...o }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pidOf = (k) => JSON.parse(readFileSync(join(D, 'pids', `node-${k + 1}.pid`), 'utf8')).pid;
const get = async (url, ms = 4000) => { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r; };

// A PAID ENTRY NEEDS THE FEDERATION'S RESERVE KEY FROM 5 SEATS, which their own DKG makes a few minutes after the devnet is up
for (const stop = Date.now() + 600000; Date.now() < stop; await wait(5000)) {
  const named = await Promise.all(SEATS.map(async (s) => { try { const f = (await (await get(`${s}/reserves`)).json()).federations; return !!(f && f[0] && (f[0].key || f[0].reserveKey)); } catch { return false; } }));
  if (named.filter(Boolean).length === SEATS.length) break;
}
const opened = await (await fetch(`http://127.0.0.1:${PLAN.control}/open-paid?stakeMsat=${env.STAKE_MSAT || 100000000}&windowMs=${env.WINDOW_MS || 420000}`, { method: 'POST' })).json();
if (!opened.id) throw new Error(`no round opened: ${JSON.stringify(opened)}`);
const ROUND = opened.id;
const contract = decodeRoundContract(new Uint8Array(await (await get(`${SEATS[0]}/round?id=${ROUND}`)).arrayBuffer()));
const win = windowsOf(contract);
const END = Number(win.openMs);
const at = () => Math.round((Date.now() - END) / 1000);
say({ step: 'round', scenario: SCENARIO, round: ROUND.slice(0, 16), version: contract.protocolVersion, end: new Date(END).toISOString() });

// THE TWO PLAYERS, EACH THE TOOL THE PAID RUNS USE
const players = [0, 1].map((i) => {
  const log = join(D, `player-${SCENARIO}-${i}.log`);
  const fd = openSync(log, 'a');
  const keys = join(D, `keys-${SCENARIO}.jsonl`);
  const child = spawn(process.execPath, [join(HERE, 'tn4-live-run.mjs')], { detached: true, stdio: ['ignore', fd, fd],
    // THE FIRST PLAYER SEARCHES FOR A DRIVE THAT DELIVERS, so the round has a winner to rescue; the second drives plainly
    env: { ...env, ARENA_TN4_NETWORK: 'regtest', ROUND, PORTS: PLAN.nodes.join(','), KEYS_FILE: keys, COLLECT_MS: '60000', ...(plan.noMarks ? { NO_MARKS: '1' } : i === 0 ? { SEARCH: '1' } : {}) } });
  return { i, log, child };
});
const lines = (p) => { try { return readFileSync(p.log, 'utf8').split('\n'); } catch { return []; } };
const said = (p, step) => lines(p).filter((l) => l.includes(`"step":"${step}"`) || l.includes(`"step":"${step} `));
const inRound = plan.noMarks ? 'no marks sent' : 'published';
for (const stop = END - 15000; Date.now() < stop && !players.every((p) => said(p, inRound).length); await wait(plan.noMarks ? 200 : 2000));
const entries = [];
try { for (const l of readFileSync(join(D, `keys-${SCENARIO}.jsonl`), 'utf8').trim().split('\n')) { const x = JSON.parse(l); if (x.round === ROUND && x.entry && !entries.includes(x.entry)) entries.push(x.entry); } } catch { /* the file says which entries there are */ }
for (const p of players) say({ step: 'player', i: p.i, published: said(p, inRound).length > 0, driven: (said(p, 'driven')[0] || '').slice(0, 170), last: lines(p).filter(Boolean).slice(-1)[0]?.slice(0, 200) });
if (!entries.length) throw new Error('no entry was played');

const stopped = new Set();
const backIn = (k) => { if (!stopped.has(k)) return; process.kill(pidOf(k), 'SIGCONT'); stopped.delete(k); say({ step: 'seat back', seat: k + 1, t: at() }); };
try {
  const up = SEATS.map((_, k) => k).filter((k) => !plan.stop.includes(k));
  if (plan.carry) {
    for (const entry of entries) for (const k of plan.stop) {
      const body = new Uint8Array(await (await get(`${SEATS[k]}/receipts?round=${ROUND}&entry=${entry}`, 20000)).arrayBuffer());
      for (const u of up) {
        const ws = new WebSocket(`ws://127.0.0.1:${PLAN.nodes[u]}/play`);
        await new Promise((ok, no) => { ws.on('open', ok); ws.on('error', no); });
        for (let i = 0; i + SIGNED_RECEIPT_BYTES <= body.length; i += SIGNED_RECEIPT_BYTES) {
          ws.send(body.slice(i, i + SIGNED_RECEIPT_BYTES));
          await new Promise((ok) => ws.once('message', ok));
        }
        ws.close();
      }
      say({ step: 'receipts carried', seat: k + 1, entry: entry.slice(0, 8), receipts: Math.floor(body.length / SIGNED_RECEIPT_BYTES) });
    }
  }
  for (const k of plan.stop) { process.kill(pidOf(k), 'SIGSTOP'); stopped.add(k); say({ step: 'seat stopped', seat: k + 1, t: at() }); }

  // WHAT EACH SEAT SAYS, ONCE PER CHANGE
  const last = new Map();
  const seen = (key, value) => { if (last.get(key) === value) return; last.set(key, value); say({ t: at(), [key]: value }); };
  for (;;) {
    for (const [k, atT] of Object.entries(plan.backAt || {})) if (at() >= atT) backIn(Number(k));
    for (let k = 0; k < SEATS.length; k++) {
      if (stopped.has(k)) continue;
      for (const entry of entries) {
        try {
          const s = await (await get(`${SEATS[k]}/standing?entry=${entry}`)).json();
          const reruns = (await get(`${SEATS[k]}/reruns?round=${ROUND}&entry=${entry}`)).headers.get('x-reruns');
          seen(`seat${k + 1} ${entry.slice(0, 8)}`, `${s.state} out=${s.outcome} pending=${s.pendingMsat} close+${s.windowCloseMs ? Math.round((Number(s.windowCloseMs) - END) / 1000) : '?'}${s.heldByNoQuorum ? ' held' : ''} reruns=${reruns}`);
        } catch (e) { seen(`seat${k + 1} ${entry.slice(0, 8)}`, `no answer: ${e.name}`); }
      }
      try { const l = await (await get(`${SEATS[k]}/lock-settlement?round=${ROUND}`)).json(); seen(`seat${k + 1} settlement`, `${l.state || l.why || 'none'}`); } catch { /* it says so above */ }
    }
    if (at() >= plan.limit) break;
    await wait(10000);
  }
} finally { for (const k of [...stopped]) backIn(k); }
await wait(20000);
// AT THE END, FROM EVERY SEAT: each entry's standing, and why, and what its forfeit door answers
for (let k = 0; k < SEATS.length; k++) for (const entry of entries) {
  try {
    const s = await (await get(`${SEATS[k]}/standing?entry=${entry}`, 15000)).json();
    const f = await get(`${SEATS[k]}/forfeit?round=${ROUND}&entry=${entry}`, 15000);
    say({ step: 'end', seat: k + 1, entry: entry.slice(0, 8), state: s.state, outcome: s.outcome, pending: s.pendingMsat, why: String(s.why || '').slice(0, 220), forfeit: f.status, forfeitSaid: f.status === 200 ? 'signed' : (await f.text()).slice(0, 160) });
  } catch (e) { say({ step: 'end', seat: k + 1, entry: entry.slice(0, 8), noAnswer: e.message }); }
}
for (const p of players) { try { process.kill(-p.child.pid, 'SIGTERM'); } catch { /* it ended */ } }
say({ step: 'done', scenario: SCENARIO, round: ROUND.slice(0, 16), t: at() });
process.exit(0);
