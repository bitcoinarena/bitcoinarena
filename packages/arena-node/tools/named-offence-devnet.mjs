#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NAMED CLAIM'S OFFENCES, FILED AND SLASHED ON SEVEN REAL SEATS (§5A.3 rows (a), (b), protocol 27, kanban #1044 B1 phase 4). Regtest only, on a devnet that slashes
// (DEVNET_SLASH=1 ARENA_PROTOCOL_VERSION=27 DEVNET_KEEPER=0 devnet.mjs up, then its liquidity step). A paid round of two entries, played by tools/tn4-live-run.mjs,
// and five seats armed with the regtest test fault (test-named-offence.js, census/offence-<n>.txt) - the first five of the round's settlement seats in seat order:
//
//   SCENARIO=off-table     (a) the five sign a claim paying OFF_TABLE_KEY in place of the largest payout; the honest seats file it, census key 0's holders start the slash
//   SCENARIO=forfeit-lost  (b) both players ask for their stake lock's forfeit at once (EARLY_FORFEIT); the five sign it for the entry they signed lost, before the settlement
//   SCENARIO=honest        nothing armed: the gate - no seat files anything
//   SCENARIO=stock         a round below ARENA_TEST_NAMED_CLAIM_HEIGHT (the devnet started with it): stock LNv2 locks, settled as before
//
// Every state read is printed with its time from the round's end, once per change; at the end the filed proofs (GET /slashes namedSlashes) and the slash starts
// (GET /slash-releases) of every seat. Settings as tools/devnet.mjs (DEVNET_DIR, DEVNET_BASE_PORT), PAYER_DIR, INVITE_FILE, WASM_PKG and LNCLI as tn4-live-run.mjs takes.
import { spawn } from 'node:child_process';
// THE HONEST SEATS STEP OUT OF THE SIGNING (off-table): an honest asker's session over the honest body and a faulty asker's over the off-table one take each
// other's partials as bad and drop each other until no signer set is left (measured 2026-11-05, round e868dfb6: "no signer set is left"). So the two honest
// seats' node processes (their guardians keep running) are stopped STOP_AFTER_S after the round's end - every result signed, before the window closes -
// and sent SIGCONT once an armed seat holds the settlement accepted, or at the limit. They then read the claim like any seat that never acked
import { readFileSync, writeFileSync, openSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devnetPorts } from './devnet-plan.mjs';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const D = resolve(env.DEVNET_DIR || 'devnet-data');
const PLAN = devnetPorts(Number(env.DEVNET_BASE_PORT || 24000));
const SEATS = PLAN.nodes.map((p) => `http://127.0.0.1:${p}`);
const SCENARIO = env.SCENARIO || 'honest';
const LIMIT = Number(env.LIMIT_S || 1500);
if (!['off-table', 'forfeit-lost', 'honest', 'stock'].includes(SCENARIO)) { console.error('SCENARIO is off-table, forfeit-lost, honest or stock'); process.exit(2); }
const say = (o) => console.log(`#1044 ${JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...o })}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (url, ms = 6000) => fetch(url, { signal: AbortSignal.timeout(ms) });
const offenceFile = (k) => join(D, 'census', `offence-${k + 1}.txt`);
const pidOf = (k) => JSON.parse(readFileSync(join(D, 'pids', `node-${k + 1}.pid`), 'utf8')).pid;
const stopped = new Set();
const backIn = (k) => { if (!stopped.has(k)) return; try { process.kill(pidOf(k), 'SIGCONT'); } catch { /* gone */ } stopped.delete(k); say({ step: 'seat back', seat: k + 1, t: at() }); };
for (let k = 0; k < SEATS.length; k++) writeFileSync(offenceFile(k), '');

for (const stop = Date.now() + 600000; Date.now() < stop; await wait(5000)) {
  const named = await Promise.all(SEATS.map(async (s) => { try { const f = (await (await get(`${s}/reserves`)).json()).federations; return !!(f && f[0] && (f[0].key || f[0].reserveKey)); } catch { return false; } }));
  if (named.filter(Boolean).length === SEATS.length) break;
}
const opened = await (await fetch(`http://127.0.0.1:${PLAN.control}/open-paid?stakeMsat=${env.STAKE_MSAT || 100000000}&windowMs=${env.WINDOW_MS || 420000}`, { method: 'POST' })).json();
if (!opened.id) throw new Error(`no round opened: ${JSON.stringify(opened)}`);
const ROUND = opened.id;
const contract = decodeRoundContract(new Uint8Array(await (await get(`${SEATS[0]}/round?id=${ROUND}`)).arrayBuffer()));
const END = Number(windowsOf(contract).openMs);
const at = () => Math.round((Date.now() - END) / 1000);
const height = async () => { try { return (await (await get(`${SEATS[0]}/chain-tip`)).json()).height; } catch { return null; } };
// THE SEAT ORDER: the contract's nodes, each one's devnet node by its /identity
const ids = await Promise.all(SEATS.map(async (s) => toHex(new Uint8Array(await (await get(`${s}/identity`)).arrayBuffer()))));
const order = contract.nodes.map((k) => ids.indexOf(toHex(k)));
// ARMED_N (default 6): the claim is signed by the threshold (5), but with only 5 seats up one failed session of a body leaves no signer set at all
// (measured 2026-11-05, round a8e68cb6: two armed askers at once, each seat's pair spent on the first list it saw); a sixth gives the signing its slack
const armed = order.slice(0, Number(env.ARMED_N || 6));
say({ step: 'round', scenario: SCENARIO, round: ROUND, version: contract.protocolVersion, censusHeight: contract.censusHeight, end: new Date(END).toISOString(),
  seatOrder: order.map((k) => k + 1), armed: SCENARIO === 'off-table' || SCENARIO === 'forfeit-lost' ? armed.map((k) => k + 1) : [] });
if (SCENARIO === 'off-table') for (const k of armed) writeFileSync(offenceFile(k), `off-table ${ROUND}\n`);

// THE FEDERATION'S HEIGHT CATCHES UP FIRST (measured 2026-11-05 on s27b/s27c: an opening mines its blocks at once, the guardians' consensus height trailed the
// chain by 15 and every seat refused the locks made then as "more than 12 blocks below the height it is verified at")
await wait(Number(env.WAIT_AFTER_OPEN_S || 90) * 1000);
const keysFile = join(D, `keys-${SCENARIO}-${ROUND.slice(0, 8)}.jsonl`);
const players = [0, 1].map((i) => {
  const log = join(D, `player-${SCENARIO}-${ROUND.slice(0, 8)}-${i}.log`);
  const fd = openSync(log, 'a');
  const child = spawn(process.execPath, [join(HERE, 'tn4-live-run.mjs')], { detached: true, stdio: ['ignore', fd, fd],
    env: { ...env, ARENA_TN4_NETWORK: 'regtest', ARENA_REGTEST_CENSUS_KEY_0: join(D, 'census', 'key0.json'), ROUND, PORTS: PLAN.nodes.join(','), KEYS_FILE: keysFile, COLLECT_MS: String(env.COLLECT_MS || 900000),
      ...(i === 0 ? { SEARCH: '1' } : SCENARIO === 'forfeit-lost' ? { LOSE: '1' } : {}), ...(SCENARIO === 'forfeit-lost' ? { EARLY_FORFEIT: '1' } : {}) } });
  return { i, log, child };
});
const lines = (p) => { try { return readFileSync(p.log, 'utf8').split('\n'); } catch { return []; } };
const said = (p, step) => lines(p).filter((l) => l.includes(`"step":"${step}"`));
const entries = () => { const out = []; try { for (const l of readFileSync(keysFile, 'utf8').trim().split('\n')) { const x = JSON.parse(l); if (x.round === ROUND && x.entry && !out.includes(x.entry)) out.push(x.entry); } } catch { /* not yet */ } return out; };
for (const stop = END - 15000; Date.now() < stop && !players.every((p) => said(p, 'published').length); await wait(2000));
const E = entries();
for (const p of players) say({ step: 'player', i: p.i, published: said(p, 'published').length > 0, handed: (said(p, 'handed over')[0] || '').slice(0, 160) });
if (!E.length) throw new Error('no entry was played');
if (SCENARIO === 'forfeit-lost') for (const k of armed) writeFileSync(offenceFile(k), E.map((e) => `forfeit-lost ${e}`).join('\n') + '\n');
say({ step: 'entries', entries: E, armedLines: SCENARIO === 'forfeit-lost' ? E.length : SCENARIO === 'off-table' ? 1 : 0 });

const honestSeats = SEATS.map((_, k) => k).filter((k) => !armed.includes(k));
const stopAt = END + Number(env.STOP_AFTER_S || 60) * 1000;
process.on('exit', () => { for (const k of [...stopped]) { try { process.kill(pidOf(k), 'SIGCONT'); } catch { /* gone */ } } });
const last = new Map();
const seen = (key, value) => { if (last.get(key) === value) return; last.set(key, value); say({ t: at(), [key]: value }); };
let filedAt = null;
for (;;) {
  if (SCENARIO === 'off-table' && !stopped.size && !last.get('honest stopped') && Date.now() >= stopAt) {
    for (const k of honestSeats) { process.kill(pidOf(k), 'SIGSTOP'); stopped.add(k); }
    last.set('honest stopped', true);
    say({ step: 'honest seats stopped', seats: honestSeats.map((k) => k + 1), t: at() });
  }
  if (stopped.size && (armed.some((k) => /^ACCEPTED/.test(last.get(`seat${k + 1} settlement`) || '')) || at() >= LIMIT - 300)) for (const k of [...stopped]) backIn(k);
  for (let k = 0; k < SEATS.length; k++) {
    if (stopped.has(k)) continue;
    try { const l = await (await get(`${SEATS[k]}/lock-settlement?round=${ROUND}`)).json(); seen(`seat${k + 1} settlement`, `${l.state || l.why || 'none'}${l.txid ? ` ${String(l.txid).slice(0, 16)}` : ''}`.slice(0, 200)); } catch { /* next pass */ }
    try {
      const s = await (await get(`${SEATS[k]}/slashes`)).json();
      const mine = (s.namedSlashes || []).filter((r) => r.round === ROUND);
      seen(`seat${k + 1} filed`, mine.map((r) => `row${r.row}:${r.node.slice(0, 8)}:${r.proof.slice(0, 12)}`).sort().join(' ') || 'none');
      if (mine.length && filedAt === null) filedAt = Date.now();
    } catch { /* next pass */ }
    try { const r = await (await get(`${SEATS[k]}/slash-releases`)).json(); seen(`seat${k + 1} starts`, JSON.stringify((r.starts || []).map((x) => ({ s: x.state || x.status, txid: String(x.startTxid || x.txid || '').slice(0, 16), bond: String(x.bond || x.outpoint || '').slice(0, 20) }))).slice(0, 400)); } catch { /* not a holder */ }
  }
  for (const p of players) for (const step of ['early forfeit', 'collected', 'stopped', 'settled', 'no early forfeit: the settlement came first']) if (said(p, step).length) seen(`player${p.i} ${step}`, said(p, step)[0].slice(0, 400));
  if (at() >= LIMIT) break;
  if (filedAt && Date.now() - filedAt > Number(env.AFTER_FILED_S || 600) * 1000) break;
  if (SCENARIO === 'honest' || SCENARIO === 'stock') { if (players.every((p) => p.child.exitCode !== null || said(p, 'collected').length) && at() > 300) break; }
  await wait(10000);
}
// AT THE END: every seat's proofs of this round, and every slash start, whole
for (let k = 0; k < SEATS.length; k++) {
  try {
    const s = await (await get(`${SEATS[k]}/slashes`, 20000)).json();
    const r = await (await get(`${SEATS[k]}/slash-releases`, 20000)).json().catch(() => ({ starts: [] }));
    say({ step: 'end', seat: k + 1, named: (s.namedSlashes || []).filter((x) => x.round === ROUND), starts: r.starts || [] });
  } catch (e) { say({ step: 'end', seat: k + 1, noAnswer: e.message }); }
}
for (const k of armed) writeFileSync(offenceFile(k), '');
for (const p of players) { try { process.kill(-p.child.pid, 'SIGTERM'); } catch { /* it ended */ } }
say({ step: 'done', scenario: SCENARIO, round: ROUND, t: at(), height: await height() });
process.exit(0);
