// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536 (kanban #2281): 1.9 refuses no valid lock as "full" (#1588), so B's lock is kept at seat 0 (201) instead of losing
// the race there; the seats are the lowest entry ids among the lock-backed entries (#2538). The invariant is the card's: C, voided as no
// member at seat 0, takes no seat there, and the members A and B are the seats.
// STATE MACHINE AUDIT round 9, area entry (kanban #1489): AN ENTRY THE MEMBERSHIP LOOK VOIDED STILL TAKES A HEAD-TO-HEAD SEAT.
//
// Two locks race for the last seat of a paying head-to-head round: at seat 0 C's lock lands first, at seat 1 B's. The relay of C's entry is
// refused at seat 1 (its seats are full), so seat 1 never holds C. At its close seat 0 looks at the members (entry-relay.js lookAtMembers): C is
// lacked by more seats than the round can spare, so it is no member - ENTRY_VOID "below-threshold" at seat 0 - and B, which seat 0 holds, is a
// member. Seat 0 then takes B's lock (takeEntryParts -> takeStakeLock, the same verifyStakeLock as POST /lock). But round.seatedEntriesOf counts
// every entry with a stake lock, ENTRY_VOID or not, so headToHeadFull still sees A and C seated and refuses B's lock: seat 0 waits until the result
// window and signs nothing, and it never holds the lock the round's settlement claims. Invariant: an entry this seat decided is no member
// (ENTRY_VOID) takes no seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { lookAtMembers, seatView } from '../src/entry-relay.js';
import { receiptsNeeded as roundThreshold } from '../../arena-protocol/src/genesis.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const SLACK_MS = 25000;
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const post = async (d, door, eid, fields) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/${door}?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
  return { status: r.status, why: (await r.text()).slice(0, 200) };
};
const feeFieldsOf = (w, who, played) => ({ paymentImage: { kind: 'hash', bytes: sha256(played.entry.feePreimage) }, amountMsat: played.entry.feeMsat,
  claimPk: w.claimPk, refundPk: refundKeyOf(who.key), expiration: played.fields.expiration });

async function attempt(tryN) {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + SLACK_MS });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const [s0, s1] = w.nodes;
    const pa = mk(3 + 3 * tryN), pb = mk(4 + 3 * tryN), pc = mk(5 + 3 * tryN);
    // A: entered and locked at both seats
    const a = await lockAndPlay(w, pa, { hidden: { move: ROCK, salt: salt() }, noMarks: true });
    // B: its entry at both seats, its locks not yet handed anywhere
    const b = await lockAndPlay(w, pb, { hidden: { move: SCISSORS, salt: salt() }, noMarks: true, only: [] });
    // C: entry and locks at seat 0 only - seat 0 seats A and C
    const c = await lockAndPlay(w, pc, { hidden: { move: PAPER, salt: salt() }, noMarks: true, unreached: [1] });
    // the case that matters: C's entry id is NOT the highest of the three, so seating by entry id would seat C if a voided entry still counted
    if (toHex(c.eid) > toHex(a.eid) && toHex(c.eid) > toHex(b.eid)) return 'again';
    // B's locks land at seat 1 first (seat 1 seats A and B); at seat 0 they lose the race
    const b1 = [await post(s1, 'lock', b.eid, b.fields), await post(s1, 'fee-lock', b.eid, feeFieldsOf(w, pb, b))];
    const b0 = await post(s0, 'lock', b.eid, b.fields);
    console.log('  FACTS (race):', JSON.stringify({ seat1: b1.map((x) => x.status), seat0: b0 }));
    assert.deepEqual(b1.map((x) => x.status), [201, 201], JSON.stringify(b1));
    // 1.9 keeps every valid lock (#1588): B's lock is kept at seat 0 too - which entries SEAT is decided by entry id among the lock-backed
    assert.equal(b0.status, 201, b0.why);
    // the relay of C's entry is refused at seat 1 (its seats are full): seat 1 never holds C
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(s1.round.entry(c.eid), null, 'seat 1 took C\'s entry after all - the race did not split');
    // SEAT 0's MEMBERSHIP LOOK, the server's own: C is lacked by seat 1 (room 0 of a 2-of-2), so it is ENTRY_VOID "below-threshold" at seat 0
    const held = new Set(s0.round.entriesOf(w.rid).map(({ entryId: e }) => toHex(e)));
    const look = await lookAtMembers({ roundId: w.rid, roundHex: toHex(w.rid), peers: [`http://127.0.0.1:${s1.port}`], slots: w.c.settlementSlots,
      needed: roundThreshold(w.c.settlementSlots), players: 2, held, viewOf: seatView((...x) => fetch(...x)), take: async () => ({ ok: false, why: 'not used' }),
      voidEntry: (r, e) => s0.round.putEntryVoid({ entryId: fromHex(e), roundId: r, firstMark: new Uint8Array(0), evidenceKind: 'below-threshold',
        why: 'fewer seats than the round\'s threshold took this entry, so it is no member (§17)' }) });
    console.log('  FACTS (members at seat 0):', JSON.stringify({ voided: look.voided.map((x) => x.slice(0, 16)), c: toHex(c.eid).slice(0, 16), a: toHex(a.eid).slice(0, 16), b: toHex(b.eid).slice(0, 16) }));
    assert.deepEqual(look.voided, [toHex(c.eid)], 'the look did not void C at seat 0');
    assert.ok(s0.round.entryVoid(c.eid), 'C is not ENTRY_VOID at seat 0');
    // B is a member and seat 0 holds its entry: takeEntryParts hands its locks to verifyStakeLock again
    const again = await post(s0, 'lock', b.eid, b.fields);
    const seated = s0.round.seatedEntriesOf(w.rid, w.c.stakeMsat).map(({ entryId: e }) => toHex(e).slice(0, 16));
    console.log('  FACTS (B again at seat 0):', JSON.stringify({ again, seated }));
    assert.ok(!seated.includes(toHex(c.eid).slice(0, 16)), `an ENTRY_VOID entry (no member) still takes a seat at seat 0: ${JSON.stringify(seated)}`);
    assert.equal(again.status, 201, `the member's lock is refused at seat 0 because the voided entry still takes its seat: ${again.why}`);
    assert.ok(seated.includes(toHex(b.eid).slice(0, 16)) && seated.includes(toHex(a.eid).slice(0, 16)), `the members A and B are not the seats at seat 0: ${JSON.stringify(seated)}`);
  } finally { await w.close(); }
  return 'done';
}

test('#2281 (1.9): an entry voided as no member (below threshold) no longer takes a seat: the member whose lock lost the race is seated at that seat', { timeout: 110000 }, async () => {
  let got = 'again', n = 0;
  for (; n < 8 && got === 'again'; n++) got = await attempt(n);
  console.log('  FACTS tries:', n);
  assert.equal(got, 'done', 'C\'s entry id was the highest in every try');
});
