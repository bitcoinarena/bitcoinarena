#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * §10'S REQUIRED WINDOW FOR THE RUN'S LAST MARK, ON A TWO-OF-TWO (ruled 2026-09-23), measured on the code as it stands.
 *
 *   BUNDLE=<arena-client.js built from this tree> [PORT_A=31250]  node packages/arena-client/tools/last-mark-window-probe.mjs
 *
 * A PAYING two-of-two FEDERATION round cannot be stood up: stock Fedimint 0.12.0 refuses a federation of 2 ("Federation
 * size must be 1 or at least 4"), one guardian is single custody (ruled out), and at 4 guardians §23.6 wants three
 * distinct vouching signer nodes. So this is the page's own bridge and bundle on the Daily's own two-of-two shape
 * (`standUpRound`: two bonded signer nodes, a published round, no stake): the same result signing, the same client
 * finish, the same tick clock. Signer node B stops the moment the page's core says DELIVERED - the finish's last batch
 * and final mark still on their way - and is served again 7 s later. Printed: when the page's tick clock closed (if
 * ever) and last posted; each node's held checkpoints for the entry, sampled every 500 ms, so whether the final mark
 * ever reached B; and each node's signed result - DELIVERED or FAILED, and at what score.
 * It prints what it measured and decides nothing. Nothing here moves money.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

import { standUpRound } from '../../arena-node/tools/round-2of2.mjs';
import { say as tell } from '../../arena-node/test/window-fixture.js';
import { pageCurve } from '../src/page-curve.js';
import { init, step } from '../../nextblock/src/sim.js';
import { CORE } from '../../nextblock/src/adapter.js';
import { O_SCORE, S_STATE, S_DELIVERED } from '../../nextblock/src/state.js';
import { GATE_X, RUN_LIVE, RUN_DELIVERED } from '../../nextblock/src/rules/gate.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { decodePlayerResult, splitSignedResult, SIGNED_RESULT_BYTES } from '../../arena-protocol/src/result.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
if (!env.BUNDLE) { console.error('BUNDLE is needed'); process.exit(2); }
const require = createRequire(import.meta.url);
const CLIENT = require(env.BUNDLE);
const coreDist = require('../../nextblock/dist/blwp-core.js');
const say_ = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const random = (n) => new Uint8Array(randomBytes(n));
const BASE = Number(env.PORT_A || 31250);
const steer = (st) => {
  const p = CORE.picture(st); const x = p.x / 65536, z = p.z / 65536, h = p.heading / 65536;
  let off = Math.atan2(GATE_X / 65536 + 20 - x, -z) / (2 * Math.PI) - h; off -= Math.round(off);
  return [65536, Math.max(-65536, Math.min(65536, Math.round(off * 6 * 65536))), 0, 0, 0];
};

const round = await standUpRound({ host: '127.0.0.1', portA: BASE, portB: BASE + 1, objectionWindowMs: 3000n });
const nodeUrl = (d) => `http://127.0.0.1:${d.port}`;
const TAB = new Map();
const tab = { getItem: (k) => (TAB.has(k) ? TAB.get(k) : null), setItem: (k, v) => TAB.set(k, String(v)),
  get length() { return TAB.size; }, key: (i) => [...TAB.keys()][i] ?? null };
let Module = null;
let code = 0;
try {
  const named = await CLIENT.joinFromQuery(new URL(round.url).search);
  const rid = CLIENT.fromHex(named.roundIdHex);
  const withId = { ...named.round, id: rid };
  const seed = CLIENT.tabSeed({ storage: tab, random });
  const player = CLIENT.playerFor(withId, { seed, curve: pageCurve });
  const beacon = await CLIENT.fetchRandomness(named.roundIdHex, named.nodes);
  // A WORLD THE CORE DELIVERS IN under a player steering at the gate, rolled before the join (a lucky roll).
  let worldSecret = null; let expected = null;
  for (let tries = 0; tries < 400 && !worldSecret; tries++) {
    const ws = random(32);
    const st = init(seedWordForEntry({ playerPubkey: player.pubkey, worldSecret: ws, joinTick: 0 }, beacon.randomness));
    let t = 0; for (; t < 1320; t++) { step(st, ...steer(st)); if (st.i32[O_SCORE + S_STATE] !== RUN_LIVE) break; }
    if (st.i32[O_SCORE + S_STATE] === RUN_DELIVERED && st.i32[O_SCORE + S_DELIVERED] >= Number(named.round.minScore)) {
      worldSecret = ws; expected = { tick: t, score: st.i32[O_SCORE + S_DELIVERED] };
    }
  }
  if (!worldSecret) throw new Error('no delivering world rolled');
  // A FREE ROUND'S ENTRY rolls its stake commitment first, then its world.
  let rolls = 0;
  const pageRandom = (n) => { if (n === 32) { rolls++; if (rolls === 2) return worldSecret; } return random(n); };
  const ARENA_ENTRY = CLIENT.entryFor(withId, { seed, curve: pageCurve, playerPubkey: player.pubkey, random: pageRandom });
  if (toHex(ARENA_ENTRY.worldSecret) !== toHex(worldSecret)) throw new Error('the page did not take the rolled world');
  say_({ step: 'round', round: named.roundIdHex.slice(0, 16), nodes: named.nodes, expected });

  // index.html's wrapper of Client.at: every node the round named, for delivery.
  const at = CLIENT.Client.at.bind(CLIENT.Client);
  CLIENT.Client.at = (discovery, opts) => at({ ...discovery, nodes: discovery.nodes || named.nodes },
    { ...opts, verify: (sig, msg, key) => !!pageCurve.verify(sig, msg, key) });
  let deliveredAt = null; let bBackAt = null;
  const hookCalls = [];
  const win = { location: { search: new URL(round.url).search }, ARENA_RUN_OVER: (word) => {
    hookCalls.push({ word: String(word), ms: Date.now() });
    if (deliveredAt === null) {
      deliveredAt = Date.now(); round.b.close();
      setTimeout(() => { round.restartB().then(() => { bBackAt = Date.now(); }); }, 7000);
    }
  } };
  const heap = new Int32Array(64);
  Module = { HEAPU8: new Uint8Array(heap.buffer), blwpNet: null };
  const src = readFileSync(new URL('../../../.apps/arena-app-next-block/unity/Assets/Plugins/WebGL/blwp.jslib', import.meta.url), 'utf8');
  const globals = { Module, HEAP32: heap, UTF8ToString: () => named.nodes[0], window: win, console, crypto, BLWP: coreDist,
    ARENACLIENT: CLIENT, ARENA_CURVE: pageCurve, ARENA_ROUND: named.round, ARENA_ENTRY, ARENA_NODES: named.nodes,
    ARENA_CHAIN: named.chain, ARENA_ADVERT: named.advert };
  const names = Object.keys(globals);
  const load = (helpers) => { let lib = null; const hn = Object.keys(helpers);
    new Function('mergeInto', 'LibraryManager', ...hn, ...names, src)((_t, obj) => { lib = obj; }, { library: {} },
      ...hn.map((n) => helpers[n]), ...names.map((n) => globals[n])); return lib; };
  const first = load({}); const helpers = {};
  for (const k of Object.keys(first)) if (k.startsWith('$')) helpers[k.slice(1)] = first[k];
  const library = load(helpers);
  library.BlwpInit(0x5eed1234);
  if (library.BlwpNetStart(0, 6, 60) !== 1) throw new Error('the bridge would not start');
  for (let i = 0; i < 600 && !(Module.blwpNet.client && Module.blwpNet.client.where); i++) await wait(50);
  if (!Module.blwpNet.client) throw new Error(`the session never opened: ${Module.blwpNet.error}`);
  const eidHex = toHex(Module.blwpNet.where.entryId);
  const clockSeen = { closedAt: null, lastPostAt: null, lastPostTick: null };
  if (Module.blwpTickClock) {
    const c0 = Module.blwpTickClock.close.bind(Module.blwpTickClock); const p0 = Module.blwpTickClock.post.bind(Module.blwpTickClock);
    Module.blwpTickClock.close = () => { if (clockSeen.closedAt === null) clockSeen.closedAt = Date.now(); return c0(); };
    Module.blwpTickClock.post = (e, t, ms) => { clockSeen.lastPostAt = Date.now(); clockSeen.lastPostTick = t; return p0(e, t, ms); };
  }
  const nodesNow = () => [round.a, round.b];
  const heldMarks = async () => Promise.all(nodesNow().map(async (d) => {
    try { const r = await fetch(`${nodeUrl(d)}/checkpoints?round=${named.roundIdHex}&entry=${eidHex}`); return Number(r.headers.get('x-checkpoints')); }
    catch { return 'down'; } }));
  // AND EACH NODE'S HELD INPUT TICKS (its transcript's x-ticks): a mark counts only over the inputs it commits to.
  const heldTicks = async () => Promise.all(nodesNow().map(async (d) => {
    try { const r = await fetch(`${nodeUrl(d)}/transcript?round=${named.roundIdHex}&entry=${eidHex}`); return Number(r.headers.get('x-ticks')); }
    catch { return 'down'; } }));
  const trace = [];
  const sampler = setInterval(async () => { trace.push({ ms: Date.now(), held: await heldMarks(), ticks: await heldTicks() }); }, 500);

  // DRIVE, at the page's pace, off the bridge's own core.
  let ticks = 0;
  while (ticks < 1320 && !hookCalls.length) { library.BlwpStep(...steer(Module.blwp.st)); ticks++; if (ticks % 4 === 0) await wait(16); }
  for (let i = 0; i < 80 && bBackAt === null; i++) await wait(250);
  // THE CLOSE, CLOSE_AFTER_BACK_MS after B is back (default 5000; 0 closes at once, as the Daily's short window can).
  await wait(Number(env.CLOSE_AFTER_BACK_MS ?? 5000));
  const rel = (t) => (t === null || deliveredAt === null ? null : t - deliveredAt);
  // CLOSE, AND EACH NODE'S SIGNED RESULTS FOR THE ENTRY.
  const closedMs = Date.now();
  await Promise.all(nodesNow().map((d) => tell(d.port, `close ${named.roundIdHex}`).catch((x) => x.message)));
  let results = null;
  for (const stop = Date.now() + 90000; Date.now() < stop; await wait(1000)) {
    results = await Promise.all(nodesNow().map(async (d) => {
      const r = await fetch(`${nodeUrl(d)}/results?round=${named.roundIdHex}&entry=${eidHex}`);
      const b = new Uint8Array(await r.arrayBuffer());
      const out = [];
      for (let i = 0; i + SIGNED_RESULT_BYTES <= b.length; i += SIGNED_RESULT_BYTES) {
        const x = decodePlayerResult(splitSignedResult(b.subarray(i, i + SIGNED_RESULT_BYTES)).body);
        out.push(`${toHex(x.nodePubkey).slice(0, 8)} ${x.outcome} ${x.score} transcript ${toHex(x.transcriptHash).slice(0, 12)}`);
      }
      return { node: toHex(d.round.pubkey).slice(0, 8), holds: out, noQuorum: r.headers.get('x-no-quorum') };
    }));
    if (results.every((x) => x.holds.length >= 2 || x.noQuorum)) break;
  }
  clearInterval(sampler);
  // THE CLIENT'S OWN VIEW: what finish came to, where each peer's input feed stands, and any mark still pending.
  const cl = Module.blwpNet.client;
  let fin = null; try { fin = cl.finishing ? await cl.finishing : null; } catch (e) { fin = { error: e.message }; }
  const clientView = { finish: fin && { unsent: fin.unsent, mark: fin.mark && { tick: fin.mark.tick, answer: fin.mark.answer, live: fin.mark.live,
      timedOut: !!fin.mark.timedOut, skippedForLink: !!fin.mark.skippedForLink, behind: fin.mark.behind } },
    nextTick: cl.nextTick, published: cl.published.length, peers: cl.peerBatches(), pendingLink: cl.pendingLink && { tick: cl.pendingLink.tick },
    marksRelinked: cl.marksRelinked, ending: cl.endingLine(),
    finalLink: cl.finalLink ? { tick: cl.finalLink.tick, witnessed: cl.witnessed(cl.finalLink.id), of: cl.nodes.length } : null,
    finalRelinks: cl.finalRelinks || 0, finalCatchUp: cl.finalCatchUp || (cl.catchingUp ? 'still running' : null) };
  const finalCount = Math.max(...trace.flatMap((x) => x.held.filter(Number.isInteger)));
  const bReached = trace.find((x) => x.held[1] === finalCount);
  say_({ step: 'window', ticks, expected, core: { word: Module.blwp.st.i32[18 + 5], score: Module.blwp.st.i32[18 + 4] },
    hookCalls: hookCalls.map((h) => ({ word: h.word.slice(0, 50), ms: rel(h.ms) })),
    bDownMs: 7000, bBackMs: rel(bBackAt), closeSentMs: rel(closedMs),
    tickClock: { closedMs: rel(clockSeen.closedAt), lastPostMs: rel(clockSeen.lastPostAt), lastPostTick: clockSeen.lastPostTick },
    finalMarkCount: finalCount, bReachedFinalMs: bReached ? rel(bReached.ms) : null,
    heldAtB: (trace.find((x) => bBackAt && x.ms >= bBackAt + 500) || {}).held || null, heldAtEnd: (trace.at(-1) || {}).held || null,
    ticksAtDelivered: (trace.find((x) => deliveredAt && x.ms >= deliveredAt) || {}).ticks || null,
    ticksAtEnd: (trace.at(-1) || {}).ticks || null,
    results, clientView });
} catch (e) {
  say_({ step: 'error', why: e.message, stack: String(e.stack).split('\n').slice(0, 4) });
  code = 1;
} finally {
  try { const cl = Module && Module.blwpNet && Module.blwpNet.client; if (cl) { cl.ended = true; cl.close(); } if (Module && Module.blwpTickClock) Module.blwpTickClock.close(); } catch { /* gone */ }
  await round.close().catch(() => {});
}
process.exit(code);
