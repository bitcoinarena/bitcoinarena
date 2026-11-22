// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit 2026-11-22 entry r3-1: A STRANGER UNSTAKES A HEAD-TO-HEAD PLAYER WITH A LOWER ENTRY UNDER HIS PUBLIC KEY (gap in the #3223 fix).
// Since #2477 the lowest entry id among a player key's lock-backed entries owns the key: a later lock of a LOWER entry of that key makes
// round.yieldEntryLocks delete the higher entry's stake_locks, fee_locks and stake_seen rows. #3223 stopped this only for a stake a run
// was played on (round.js stakePlayedOn: a mark of the run holding a receipt). A head-to-head round (Rock Paper Scissors) has no marks and
// no receipts at all, so its staked entries stay "yieldable" up to the close. A handout and an entry carry no player signature, so a
// stranger deals a handout under the honest player's PUBLIC key, posts an entry of it (a fresh session key until its id is the lower one,
// a coin flip per try) and locks a stake refunding to the player's refund key: every seat lets the honest player's stake go, his own
// locks are refused from then on ("another entry of that player key is already staked"), and the seat is the stranger's entry - whose
// session key, move and payout address the stranger holds.
// Invariant: a staked entry of a player key is not let go on a lock of an entry the player never made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const feeFieldsOf = (p) => ({ paymentImage: { kind: 'hash', bytes: sha256(p.entry.feePreimage) }, amountMsat: p.entry.feeMsat,
  claimPk: p.fields.claimPk, refundPk: p.fields.refundPk, expiration: p.fields.expiration });

test('audit entry r3-1: a stranger\'s lower entry under a head-to-head player\'s public key does not unstake him', { timeout: 120000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const base = (d) => `http://127.0.0.1:${d.port}`;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the honest player: handout, entry with its committed move, stake and fee lock at both seats
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: salt() }, noMarks: true });
    assert.ok(w.nodes.every((d) => d.round.stakeSeen(honest.eid)), 'precondition: the honest player is staked at both seats');
    // the stranger: a handout and an entry under the honest player's PUBLIC key (no signature of his), a fresh session key per try
    let copy = null;
    for (let i = 0; i < 16 && !copy; i++) {
      const p = await lockAndPlay(w, { ...mk(9), name: `stranger-${i}`, key: mk(1).key }, { hidden: { move: PAPER, salt: salt() }, noMarks: true, only: [] });
      if (Buffer.compare(Buffer.from(p.eid), Buffer.from(honest.eid)) < 0) copy = p;
    }
    assert.ok(copy, 'no lower entry id in 16 tries');
    // the stranger's own lock (refunding to the player's refund key) handed to both seats' ordinary lock doors, before the close
    const said = [];
    for (const d of w.nodes) {
      const l = await fetch(`${base(d)}/lock?entry=${toHex(copy.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(copy.fields)) });
      const f = await fetch(`${base(d)}/fee-lock?entry=${toHex(copy.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFieldsOf(copy))) });
      said.push({ lock: [l.status, (await l.text()).slice(0, 80)], fee: [f.status, (await f.text()).slice(0, 80)] });
    }
    for (let i = 0; i < 10; i++) await wait(10);
    // the honest player's page hands his locks again (its background hand-over): refused?
    const again = [];
    for (const d of w.nodes) {
      const l = await fetch(`${base(d)}/lock?entry=${toHex(honest.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(honest.fields)) });
      again.push([l.status, (await l.text()).slice(0, 90)]);
    }
    const at = w.nodes.map((d) => ({ honestSeen: !!d.round.stakeSeen(honest.eid), honestLock: !!d.round.stakeLock(honest.eid), copySeen: !!d.round.stakeSeen(copy.eid),
      seated: d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).map(({ entryId }) => toHex(entryId).slice(0, 16)) }));
    console.log('  FACTS entry r3-1:', JSON.stringify({ honest: toHex(honest.eid).slice(0, 16), copy: toHex(copy.eid).slice(0, 16), said, again, at }));
    for (const [i, s] of at.entries())
      assert.equal(s.honestSeen, true, `seat ${i} let go the honest head-to-head player's stake on a stranger's lower entry under his public key (stake lock kept: ${s.honestLock}; seated: ${s.seated.join(',')})`);
  } finally { await w.close(); }
});
