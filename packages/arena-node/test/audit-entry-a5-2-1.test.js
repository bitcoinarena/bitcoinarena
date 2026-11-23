// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-22 entry r2-1: A POOL PICK WHOSE LOCKS ONE PLAYER HANDS TO SOME SEATS ONLY, IN THE LAST SECOND BEFORE THE CLOSE, SPLITS THE
// MARKET'S SETTLEMENT FOR GOOD (gap between the #1790 hand-on / close pull and the #2529 "each seat verifies itself" rule).
// #1790 made a pool pick's locks reach every seat: the lock door hands them on (entry-relay lockTaken, LOCK_AFTER_MS 1500 + up to 500 ms, with
// no close margin for a pick: closeMs is passed only for head-to-head rounds), and pullPickLocks fetches them from peers at the close. Since
// #2529 the pull takes a pick's lock only while this seat's OWN lock door would still take it (lockAfterCloseRefusal: no grace for an attested
// round), and the hand-on goes through the same door. So a player who posts his pick's locks to some seats only, less than ~1.5 s before the
// entry close, leaves the other seats with the entry and no lock for good: the seats that verified it count the pick, the others leave it out,
// each builds another pari-mutuel table and no threshold ever signs a settlement - every stake and fee of the market waits for its lock's expiry.
// Safe behaviour: the market still settles (one settlement ACCEPTED), as it does when the same lock lands a few seconds earlier (#1790's test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay, closeRound, standing } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { attestorSign } from './plugins/sign.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { MARKET } from './plugins/market/index.js';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const STAKE = 1_000_000n;
const ROUND = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
const [A0, , A2] = MARKET.attestors;
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32(0x40 + n), worldSecret: b32(0) });
const signedBy = (body, by) => ({ ...body, signatures: by.map((a) => attestorSign(a, body)) });
const post = async (d, rid, a) => { const r = await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`, { method: 'POST', body: encodeAttestation(a) }); return r.status; };
const outcome = async (d, rid) => (await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`)).json();

test('audit entry r2-1: a pool pick locked at one seat in the last second before the close does not stop the market settling', { timeout: 150000 }, async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], entryCloseGraceMs: 15000 } });   // every live seat's (main.js ENTRY_CLOSE_GRACE_MS)
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    // two picks placed in full at both seats, well before the close
    await lockAndPlay(w, player(0), { noMarks: true, pick: 0 });
    await lockAndPlay(w, player(1), { noMarks: true, pick: 1 });
    // the attacker's pick: entry (and handout) to both seats, its locks to seat a only, 1.2 s before the entry close - in time at seat a's door
    skipTo(Number(w.c.entryCloseMs) - 1200);
    const t0 = testNow();
    const late = await lockAndPlay(w, player(2), { noMarks: true, pick: 0, only: [0] });
    const lockedBeforeCloseMs = Number(w.c.entryCloseMs) - testNow();
    // the seats' own background passes: seat a's hand-on (1.5-2 s later) and the close pull
    await wait(4000);
    await closeRound(w);
    const at = w.c.entryCloseMs + 1n;
    await Promise.all(w.nodes.map((d) => post(d, w.rid, signedBy({ roundId: w.rid, outcome: 0, observedAtMs: at }, [A0, A2]))));
    skipTo(Number((await outcome(w.a, w.rid)).finalAtMs) + 100);
    let got;
    for (const stop = Date.now() + 25000; Date.now() < stop; await wait(250)) {
      got = await standing(w.a, w);
      if (got.state === 'ACCEPTED') break;
    }
    const asked = got.state === 'ACCEPTED' ? null : await w.a.settlements.settle(w.rid);
    const facts = { tookMs: testNow() - t0, lockedBeforeCloseMs, seenAtA: !!w.a.round.stakeSeen(late.eid), seenAtB: !!w.b.round.stakeSeen(late.eid),
      entryAtB: !!w.b.round.entry(late.eid), state: got.state, why: String(got.why || '').slice(0, 200),
      asked: asked && { state: asked.state, why: String(asked.why || '').slice(0, 300) } };
    console.log('  FACTS audit entry r2-1:', JSON.stringify(facts));
    assert.equal(got.state, 'ACCEPTED', `the market never settles: ${JSON.stringify(facts)}`);
  } finally { await w.close(); }
});
