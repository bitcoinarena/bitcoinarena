// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit 2026-11-22 h2h r3-1: A HEAD-TO-HEAD PLAYER WHO SEES HE LOSES VOIDS HIS OWN ENTRY AT n - k + 1 SEATS WITH TWO MARKS HE SIGNED HIMSELF.
// A head-to-head entry plays no run, but POST /first-mark takes a first mark of it (signed by its session key, stake seen) and answers a
// receipt without forwarding it. Later - after GET /reveals shows him the opponent's move - the same player posts that first mark to the
// other seats with the one receipt and a mark of his own past the start line as "evidence" (entryVoid { kind: 'mark' }): voidHere records
// ENTRY_VOID there (1 of 2 receipts, 1 "late" seat). #headToHeadClose drops every ENTRY_VOID entry from the decided list, so the honest
// winner is alone - fewer than the game's players - and is signed VOID at those seats: the round is VOID at the threshold, both stakes back.
// A free option: keep the win, void the loss. Safe behaviour: the honest revealer's win is signed at every seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, say, wait, bedFrom, GENESIS_HASH } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { LOCK_SET_VERSION } from '../../arena-protocol/src/constants.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const post = async (d, path, body) => { const r = await fetch(`http://127.0.0.1:${d.port}${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  let j; const t = await r.text(); try { j = JSON.parse(t); } catch { j = { text: t.slice(0, 120) }; } return { status: r.status, ...j }; };

async function attack(round, p28) {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, n: 3, round, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  const [s0, s1, s2] = w.nodes;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sh = salt(), sx = salt();
    const session = ed25519.utils.randomSecretKey();
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: PAPER, salt: sh }, noMarks: true });
    const cheat = await lockAndPlay(w, mk(2), { hidden: { move: ROCK, salt: sx }, noMarks: true, session });
    // BEFORE THE CLOSE: the cheat's own first mark, posted to seat 0 only (POST /first-mark answers a receipt and hands it on to nobody)
    const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
    const input = { roundId: w.rid, entryId: cheat.eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: [[0, 0, 0, 0, 0]], liquidations: [], loads: bedFrom(0) };
    const first = sign({ roundId: w.rid, entryId: cheat.eid, tick: 1, stateHash: new Uint8Array(randomBytes(32)), inputChainHash: batchId(input),
      previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) });
    const took = await post(s0, '/first-mark', { mark: toHex(first), batches: [toHex(encodeInputBatch(input))], signatures: [toHex(ed25519.sign(batchId(input), session))] });
    // and a mark of his own "past the start line", the evidence the void door reads
    const later = sign({ roundId: w.rid, entryId: cheat.eid, tick: START_DEADLINE + 5, stateHash: new Uint8Array(randomBytes(32)), inputChainHash: batchId(input),
      previousHash: checkpointId({ roundId: w.rid, entryId: cheat.eid, tick: 1, stateHash: new Uint8Array(32), inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) }),
      sessionPubkey: ed25519.getPublicKey(session) });
    skipTo(Number(w.c.entryCloseMs) + (p28 ? 50 : 500));
    if (p28) for (const stop = Date.now() + 6000; Date.now() < stop; await wait(50)) {
      const sets = await Promise.all(w.nodes.map(async (d) => (await fetch(`http://127.0.0.1:${d.port}/lock-set?round=${toHex(w.rid)}`)).json()));
      if (sets.every((x) => x.certificate)) break;
    }
    // the honest player reveals paper at every seat
    const said = await Promise.all(w.nodes.map(async (d) => (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(honest.eid)}`, { method: 'POST', body: JSON.stringify({ move: PAPER, salt: toHex(sh) }) })).status));
    // the cheat reads the honest move (public), sees his rock loses, and voids his entry at seats 1 and 2 instead of revealing
    const seen = await (await fetch(`http://127.0.0.1:${s1.port}/reveals?round=${toHex(w.rid)}`)).json();
    const voids = [];
    for (const d of [s1, s2]) voids.push(await post(d, '/first-mark', { mark: toHex(first), receipt: took.receipt, entryVoid: { kind: 'mark', evidence: toHex(later) } }));
    skipTo(Number(w.c.entryCloseMs) + SPAN_MS + 4500);
    await Promise.all(w.nodes.map((d) => say(d.port, `close ${toHex(w.rid)}`)));
    for (const d of w.nodes) for (const p of d.verifier.done || []) { try { await p; } catch { /* said itself */ } }
    await wait(3000);
    const own = (d, eid) => d.round.results(w.rid, eid).filter((r) => toHex(decodePlayerResult(splitSignedResult(r.bytes).body).nodePubkey) === toHex(d.round.pubkey))
      .map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; });
    const got = { firstMarkAtSeat0: { status: took.status, receipt: !!took.receipt, why: took.why }, revealed: said,
      shownMoves: (seen.reveals || []).map((r) => r.move), voidPosts: voids.map((v) => `${v.status} ${v.entryVoid ? 'ENTRY_VOID' : ''} ${String(v.why || '').slice(0, 60)}`),
      cheatVoid: w.nodes.map((d) => !!d.round.entryVoid(cheat.eid)), honest: w.nodes.map((d) => own(d, honest.eid)), cheat: w.nodes.map((d) => own(d, cheat.eid)) };
    console.log('  FACTS:', JSON.stringify(got));
    assert.deepEqual(got.cheatVoid, [false, false, false], `a head-to-head entry was voided at seats by its own player's marks: ${JSON.stringify(got)}`);
    for (let i = 0; i < 3; i++) assert.deepEqual(got.honest[i], ['DELIVERED 2'], `seat ${i} did not sign the honest winner's win: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
}

test('audit h2h r3-1: a losing head-to-head player voids his own entry with self-signed marks (below protocol 28)', { timeout: 110000 }, () => attack(ROUND, false));
test('audit h2h r3-1: a losing head-to-head player voids his own entry with self-signed marks (protocol 28, certified lock set)', { timeout: 110000 }, () => attack({ ...ROUND, protocolVersion: LOCK_SET_VERSION }, true));
