// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2-find-h2h 1: A HEAD-TO-HEAD ENTRY WHOSE STAKE NEVER COUNTED IS PLAYED, AND THE SETTLEMENT LEAVES IT OUT.
// The seating rule (round.js seatedEntriesOf, #1437) counts an entry whose stake lock is verified and still waits for its fee lock
// ("waitsForFeeLock": no stake_seen row). The head-to-head close decides over that same set (verify.js #headToHeadClose), so such an
// entry is played and signed WIN / LOSS. The settlement takes only entries whose stake was seen (settlement.js entriesOnRecord), so it is
// not in the table: a player who hands his stake lock and withholds his fee lock is played for free - when he wins, the honest
// opponent is booked FAILED against nobody; when he loses, nothing of his is claimed.
// Invariant: an entry is played (signed DELIVERED/FAILED) only if this seat counts its stake (stake_seen) - otherwise VOID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { sha256 } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const SLACK_MS = 25000;
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => {
  const p = decodePlayerResult(splitSignedResult(r.bytes).body);
  return `${p.outcome} ${p.score}`;
}));
const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) });
  return r.status;
}));

test('#1489 a44-refute-7-s2-1: one committee seat serves a held-back fee lock after the moves are public - the honest seats pull it and play the entry', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + SLACK_MS });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const sb = salt();
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true, only: [] });
    for (const d of w.nodes) {
      const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(b.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(b.fields)) });
      assert.equal(r.status, 201);
    }
    for (const d of w.nodes) assert.equal(!!d.round.stakeSeen(b.eid), false, 'precondition: b waits for its fee lock everywhere');
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, ROCK, sa);
    // B sees A's rock on GET /reveals, and only now - paper wins - hands its fee lock (made in the federation before the close, never handed)
    const feeFields = { ...b.fields, paymentImage: { kind: 'hash', bytes: sha256(b.entry.feePreimage) }, amountMsat: b.entry.feeMsat };
    const own = [];
    for (const d of w.nodes) {
      const r = await fetch(`http://127.0.0.1:${d.port}/fee-lock?entry=${toHex(b.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      own.push(`${r.status} ${(await r.text()).slice(0, 60)}`);
    }
    // every honest door refuses it (kanban #1598) - so B gives it to ONE colluding seat of the committee, which keeps it as if verified before the close
    const bad = w.nodes[0];
    bad.round.putFeeLock({ entryId: b.eid, roundId: w.rid, outpoint: b.feeOutpoint, fields: lockFieldsToJson(feeFields), contractId: 'x' });
    bad.round.putStakeSeen({ entryId: b.eid, paidMsat: b.fields.amountMsat });
    await reveal(w, b, PAPER, sb);
    await closeRound(w);
    const settled = await untilSettled(w, 15000);
    const got = { a: results(w, a.eid), b: results(w, b.eid) };
    const seen = w.nodes.map((d) => !!d.round.stakeSeen(b.eid));
    console.log('  FACTS (a44-refute-7-s2-1):', JSON.stringify({ own, seen, state: settled && settled.state, why: settled && settled.why, results: got }));
    // the honest seats (1..) must not play an entry whose fee lock reached them only from a peer after the moves were public. Each seat
    // also holds the colluding seat's own signed result, which no honest seat controls - what is asserted is what each honest seat signs
    // itself, and that no outcome other than VOID gathers the round's quorum (kanban #2225)
    const signedBy = (d, eid) => d.round.results(w.rid, eid).filter((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey))
      .map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; });
    for (const d of w.nodes.slice(1)) {
      assert.deepEqual(signedBy(d, b.eid), ['VOID 0'], `an entry that locked its fee only after seeing the opponent's move was played: ${JSON.stringify(got)}`);
      assert.ok(signedBy(d, a.eid).every((x) => x !== 'FAILED 0'), `the honest player lost to a fee lock handed after the moves were public: ${JSON.stringify(got)}`);
    }
    for (const per of got.b) assert.ok(per.filter((x) => x !== 'VOID 0').length < w.nodes.length, `the late entry's play gathered every seat: ${JSON.stringify(got)}`);
    assert.notEqual(settled && settled.state, 'ACCEPTED', `a settlement claimed the honest player's lock: ${JSON.stringify(settled)}`);
  } finally { await w.close(); }
});
