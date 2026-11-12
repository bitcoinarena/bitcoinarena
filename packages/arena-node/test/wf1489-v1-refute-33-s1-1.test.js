// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
import { cancelId } from '../../arena-protocol/src/order-book.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { MARKET } from './plugins/market/index.js';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const STAKE = 1_000_000n;
const ROUND = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
const [A0, , A2] = MARKET.attestors;
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32(0x40 + n), worldSecret: b32(0) });
const signedBy = (body, by) => ({ ...body, signatures: by.map((a) => attestorSign(a, body)) });
const post = async (d, rid, a) => { const r = await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`, { method: 'POST', body: encodeAttestation(a) }); return `${r.status} ${(await r.text()).trim()}`; };
const outcome = async (d, rid) => (await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`)).json();
const attestBoth = async (w, outcomeIx) => Promise.all(w.nodes.map((d) => post(d, w.rid, signedBy({ roundId: w.rid, outcome: outcomeIx, observedAtMs: w.c.entryCloseMs + 1n }, [A0, A2]))));
const signCancel = (w, e) => ed25519.sign(cancelId({ roundId: w.rid, entryId: e.eid }), e.session);
async function settledBySweep(w, ms = 20000) {
  let got;
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(250)) {
    got = await standing(w.a, w);
    if (got.state === 'ACCEPTED') return got;
  }
  return got;
}
const marketLockRound = () => lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000,
  serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });

// kanban #1489 v1-refute-33 (#1520 grace vs #1435): ONE COLLUDING SEAT REOPENS THE LATE CANCEL. The grace after the close takes a handed-on
// cancel when "another seat of the round already lists it" - but a seat's GET /cancels is only its word: a colluding seat that lists a cancel
// it took (or wrote) AFTER the close makes every honest seat take the player's post-close cancel, marked x-arena-relayed, for 5 s. A grid
// market's outcome is the price at its entry close (marketWindowOf: window.endMs === entryCloseMs), so in those 5 s the loser is known -
// the #1435 attack (a loser cancelled after the outcome through one colluding seat), for the grace's length.
// Safe behaviour: an honest seat refuses a cancel that no seat took before the close.
test('a cancel a colluding seat wrote after the close is not taken by an honest seat in the grace', async () => {
  const w = await marketLockRound();
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const played = [await lockAndPlay(w, player(40), { noMarks: true, pick: 0 }), await lockAndPlay(w, player(41), { noMarks: true, pick: 1 })];
    skipTo(Number(w.c.entryCloseMs) + 1000);   // after the close: the price at the close (a grid window's end) is out
    const sig = signCancel(w, played[1]);
    // the colluding seat lists the loser's cancel it got after the close (its own door refuses it; it writes it to its store)
    const ownDoor = await fetch(`http://127.0.0.1:${w.a.port}/cancel?entry=${toHex(played[1].eid)}`, { method: 'POST', body: sig }).then((r) => r.status);
    w.a.round.putCancel({ roundId: w.rid, entryId: played[1].eid, signature: sig, receivedMs: testNow() });
    const atHonest = await fetch(`http://127.0.0.1:${w.b.port}/cancel?entry=${toHex(played[1].eid)}`,
      { method: 'POST', body: sig, headers: { 'x-arena-relayed': '1' } }).then((r) => r.status);
    console.log('  v1-refute-33-s1-1:', JSON.stringify({ ownDoor, atHonest, cancelledAtHonest: w.b.round.cancelled(played[1].eid) }));
    assert.equal(ownDoor, 409);
    assert.equal(atHonest, 409, 'an honest seat took a cancel posted 1 s after the close because one seat listed it');
    assert.equal(w.b.round.cancelled(played[1].eid), false);
  } finally { await w.close(); }
});

// kanban #1702: the grace is the long one only where the outcome comes at least that long after the close
test('a market whose outcome is out at the close has only the short grace; one resolving later keeps the long one', async () => {
  const { cancelHandOnGraceMs, CANCEL_HANDON_GRACE_MS, CANCEL_HANDON_KNOWN_GRACE_MS } = await import('../src/server.js');
  const c = { entryCloseMs: 1_800_000n };
  const terms = (after) => ({ marketTerms: { resolveAfterCloseMs: after, deadlineAfterResolveMs: 60000n } });
  assert.equal(cancelHandOnGraceMs(c, { roundPeriodMs: 0n }), CANCEL_HANDON_KNOWN_GRACE_MS, 'no terms: attested at the close');
  assert.equal(cancelHandOnGraceMs(c, { roundPeriodMs: 900_000n, ...terms(600_000n) }), CANCEL_HANDON_KNOWN_GRACE_MS, 'a grid window ends at the close');
  assert.equal(cancelHandOnGraceMs(c, { roundPeriodMs: 0n, ...terms(4999n) }), CANCEL_HANDON_KNOWN_GRACE_MS);
  assert.equal(cancelHandOnGraceMs(c, { roundPeriodMs: 0n, ...terms(5000n) }), CANCEL_HANDON_GRACE_MS);
  assert.equal(cancelHandOnGraceMs(c, { roundPeriodMs: 0n, ...terms(3_600_000n) }), CANCEL_HANDON_GRACE_MS);
  assert.ok(CANCEL_HANDON_KNOWN_GRACE_MS < 1000);
});
