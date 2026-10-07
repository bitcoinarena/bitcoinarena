#!/usr/bin/env node
// THE LOAD TEST (M4; PRIORITIES 2026-09-29 item 4, in the repo only; IMPLEMENTATION.md "Synthetic clients driving 100
// and 1,000 concurrent runs against a seven-node local committee: receipt latency, replay lag, WebSocket buffer
// growth, SQLite write throughput").
//
// Seven signer-node daemons (five-of-seven-fixture's committee, a paying FEDERATION round over the lock fixture - no
// money moves) and PLAYERS synthetic clients. Each joins as a paid entry does (handout, entry, stake and fee locks at
// all seven), then streams its run the way the page does: every BLOCK ticks one input batch and one signed checkpoint
// mark, chained, on ONE WebSocket per signer node, paced at the game's 60 ticks a second. Then the round is closed and
// the replay lag is the time until all seven hold a signed result for every entry.
//
//   PLAYERS=100 TICKS=1320 node tools/load-test.mjs            (from packages/blwp-node)
//
// Printed, one JSON line each: join latency, batch-ack and receipt latency (p50/p95/p99/max over every message),
// the largest WebSocket buffer a client saw, the stored rows and their write rate, the close-to-results lag at each
// node, and this process's memory. THE CLIENTS AND THE SEVEN DAEMONS SHARE THIS ONE PROCESS (replay runs in the
// daemons' worker pools): the numbers are an upper bound on the latency a separate machine per node would see.
import { WebSocket } from 'ws';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sevenSignerNodes } from '../test/five-of-seven-fixture.js';
import { rand, wordsAt, secretScalar, STAKE, GENESIS_HASH, WINNER } from '../test/window-fixture.js';
import { assumeStakeSeen } from '../test/assignment.js';
import { feldmanGroup } from '../src/curve.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

const PLAYERS = Number(process.env.PLAYERS || 100);
const TICKS = Number(process.env.TICKS || 1320);
const BLOCK = 60;
const JOIN_CONCURRENCY = Number(process.env.JOIN_CONCURRENCY || 16);
const out = (o) => console.log(JSON.stringify(o));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : null; };
const stats = (xs) => ({ n: xs.length, p50: q(xs, 0.5), p95: q(xs, 0.95), p99: q(xs, 0.99), max: xs.length ? Math.round(Math.max(...xs)) : null });

const w = await sevenSignerNodes('lock');
const nodes = w.signerNodes;
const t0 = Date.now();
out({ step: 'committee', nodes: nodes.length, round: toHex(w.rid).slice(0, 16), players: PLAYERS, ticks: TICKS });

/** One persistent socket to a node's /play: each message answered in order, its round trip timed. */
function socket(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
  const waiting = [];
  let maxBuffered = 0;
  ws.on('message', (d, bin) => { const next = waiting.shift(); if (next) next(bin ? new Uint8Array(d) : d.toString()); });
  const opened = new Promise((r, f) => { ws.once('open', r); ws.once('error', f); });
  return {
    opened,
    ask: (bytes) => new Promise((resolve) => { const at = performance.now(); waiting.push((answer) => resolve({ answer, ms: performance.now() - at })); ws.send(bytes); maxBuffered = Math.max(maxBuffered, ws.bufferedAmount); }),
    get maxBuffered() { return maxBuffered; },
    close: () => ws.close(),
  };
}

const joinMs = [], batchMs = [], receiptMs = [];
let refused = 0, maxBuffered = 0;
const players = [];

async function join(i) {
  const secret = schnorr.utils.randomSecretKey();
  const who = { key: schnorr.getPublicKey(secret), worldSecret: rand(32) };
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: who.key, ephemeralSecret: e,
    ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: 4 }, () => scalarFrom32(rand(32)) % FIELD), needed: 5, curve: feldmanGroup });
  const feeSecret = rand(32);
  const entry = { roundId: w.rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(preimage),
    stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n, joinTick: 0, worldSecret: who.worldSecret, vssSharesRef: handoutId(dealt.handout),
    stakePoint: dealt.handout.commitments[0], feePreimage: feeSecret, stakeLockOutpoint: { txid: rand(32), outIdx: 0n },
    feeLockOutpoint: { txid: rand(32), outIdx: 1n }, claimKeyAttestationRef: new Uint8Array(32) };
  const claimPk = new Uint8Array(33).fill(2);
  await w.locks.put(entry.stakeLockOutpoint, { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry),
    claimPk, refundPk: refundKeyOf(who.key), expiration: w.locks.height + 200 });
  await w.locks.put(entry.feeLockOutpoint, { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat,
    claimPk, refundPk: refundKeyOf(who.key), expiration: w.locks.height + 200 });
  const eid = entryId(entry);
  const at = performance.now();
  for (const d of nodes) {
    const h = await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    const j = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    if (h.status !== 201 || j.status !== 201) { refused++; if (refused < 4) out({ step: 'join refused', i, handout: h.status, entry: j.status, why: (await j.text()).slice(0, 160) }); return; }
    assumeStakeSeen(d.round, entry);
  }
  joinMs.push(performance.now() - at);
  players.push({ i, entry, eid, session, sockets: nodes.map((d) => socket(d.port)) });
}

// ---- joins, JOIN_CONCURRENCY at a time
const joinStart = Date.now();
for (let i = 0; i < PLAYERS; i += JOIN_CONCURRENCY)
  await Promise.all(Array.from({ length: Math.min(JOIN_CONCURRENCY, PLAYERS - i) }, (_, k) => join(i + k)));
out({ step: 'joined', players: players.length, refused, seconds: (Date.now() - joinStart) / 1000, joinMs: stats(joinMs) });
for (const p of players) await Promise.all(p.sockets.map((s) => s.opened));

// ---- the runs, all at once, paced at 60 ticks a second: each block one batch and one mark to every node
async function play(p) {
  const st = init(seedWordForEntry(p.entry, w.randomness));
  let prevBatch = GENESIS_HASH, prevMark = NO_PREVIOUS;
  const start = performance.now();
  for (let from = 0; from < TICKS; from += BLOCK) {
    const to = Math.min(TICKS, from + BLOCK);
    const words = Array.from({ length: to - from }, (_, t) => wordsAt(from + t));
    for (const x of words) step(st, ...x);
    const b = { roundId: w.rid, entryId: p.eid, previousHash: prevBatch, firstTick: from, ticks: words, liquidations: [] };
    const m = { roundId: w.rid, entryId: p.eid, tick: to, stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
      inputChainHash: batchId(b), previousHash: prevMark, sessionPubkey: p.entry.sessionPubkey };
    const signed = joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), p.session));
    // THE PACE: this block's inputs are sent once the game would have played them.
    const due = start + (to * 1000) / 60 - performance.now();
    if (due > 0) await wait(due);
    await Promise.all(p.sockets.map(async (s) => {
      const bt = await s.ask(encodeInputBatch(b)); batchMs.push(bt.ms);
      const rc = await s.ask(signed); receiptMs.push(rc.ms);
      if (!(rc.answer instanceof Uint8Array) || rc.answer.length !== SIGNED_RECEIPT_BYTES) refused++;
    }));
    prevBatch = batchId(b); prevMark = checkpointId(m);
  }
}
const playStart = Date.now();
const rss0 = process.memoryUsage().rss;
await Promise.all(players.map(play));
const playSeconds = (Date.now() - playStart) / 1000;
for (const p of players) for (const s of p.sockets) { maxBuffered = Math.max(maxBuffered, s.maxBuffered); s.close(); }
const rows = nodes.map((d) => {
  const n = (table) => { try { return d.round.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } catch { return null; } };
  return { ticks: n('ticks'), checkpoints: n('checkpoints'), receipts: n('receipts') };
});
out({ step: 'played', players: players.length, seconds: playSeconds, runSeconds: TICKS / 60, messages: batchMs.length + receiptMs.length,
  batchAckMs: stats(batchMs), receiptMs: stats(receiptMs), refusedOrShort: refused, maxWsBufferedBytes: maxBuffered,
  rowsPerNode: rows[0], writesPerSecondPerNode: rows[0].ticks != null ? Math.round((rows[0].ticks + (rows[0].checkpoints || 0)) / playSeconds) : null,
  rssMB: { before: Math.round(rss0 / 1e6), after: Math.round(process.memoryUsage().rss / 1e6) } });

// ---- the close, and the replay lag: until every node holds a signed result for every entry
const closeAt = Date.now();
await Promise.all(nodes.map((d) => new Promise((r) => { const s = new WebSocket(`ws://127.0.0.1:${d.port}/play`); s.on('open', () => s.send(`close ${toHex(w.rid)}`)); s.on('message', () => { s.close(); r(); }); s.on('error', r); })));
const lag = nodes.map(() => null);
let held = nodes.map(() => 0), lastReport = Date.now();
for (const stop = Date.now() + Number(process.env.RESULT_WAIT_MS || 600000); Date.now() < stop && lag.some((x) => x === null); await wait(500)) {
  held = nodes.map((d) => players.filter((p) => d.round.results(w.rid, p.eid).length > 0).length);
  held.forEach((n, i) => { if (lag[i] === null && n === players.length) lag[i] = (Date.now() - closeAt) / 1000; });
  // PROGRESS every 30 s: how many entries each node holds a signed result for, so a stall is told from a slow replay.
  if (Date.now() - lastReport > 30000) { lastReport = Date.now(); out({ step: 'replaying', seconds: (Date.now() - closeAt) / 1000, resultsHeld: held }); }
}
out({ step: 'results', closeToAllResultsSeconds: lag, resultsHeld: held, entries: players.length, rssMB: Math.round(process.memoryUsage().rss / 1e6),
  totalSeconds: (Date.now() - t0) / 1000 });
await w.close();
process.exit(0);
