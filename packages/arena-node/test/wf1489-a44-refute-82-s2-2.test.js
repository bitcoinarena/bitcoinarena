// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-82-s2-2: tries to refute #1790 / #2198 / #2293 (a pool pick whose locks reached one seat still settles at every seat).
// THE OTHER SEAT RESTARTING WHILE THE PAGE PLACED THE PICK: the page posts the entry to every seat at once and the locks only to the seats that
// took the entry (market.js: handTo(took)), and counts the pick placed once ONE seat holds entry and locks. A seat that was restarting then holds
// neither. Nothing carries the entry on: entryTaken (the only path that hands an entry) runs for relayedRound only, which leaves every market out;
// the lock hand-on (#1790, entry-relay handLocks) posts locks only, and a seat without the entry answers 404 to them; the close pull and its retry
// (pullPickLocks, pickResync) walk only the entries the seat itself holds. So the seats' pari-mutuel tables differ for good and nothing is signed.

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

test("#1489 a44-refute-82-s2-2 a pick whose entry and locks reached one seat only (the other restarting): no path hands the entry on, the market never settles", { timeout: 150000 }, async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    await lockAndPlay(w, player(0), { noMarks: true, pick: 0 });
    await lockAndPlay(w, player(1), { noMarks: true, pick: 1 });
    // seat b restarting while the page posted: the entry and locks reached seat a only (no hand-on cut, no seat down later)
    const late = await lockAndPlay(w, player(2), { noMarks: true, pick: 0, unreached: [1] });
    await wait(3000);
    await closeRound(w);
    const at = w.c.entryCloseMs + 1n;
    await Promise.all(w.nodes.map((d) => post(d, w.rid, signedBy({ roundId: w.rid, outcome: 0, observedAtMs: at }, [A0, A2]))));
    skipTo(Number((await outcome(w.a, w.rid)).finalAtMs) + 100);
    let got;
    for (const stop = Date.now() + 45000; Date.now() < stop; await wait(250)) {
      got = await standing(w.a, w);
      if (got.state === 'ACCEPTED') break;
    }
    const facts = { entryAtB: !!w.b.round.entry(late.eid), seenAtA: !!w.a.round.stakeSeen(late.eid), seenAtB: !!w.b.round.stakeSeen(late.eid), state: got.state, why: String(got.why || '').slice(0, 200) };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.equal(got.state, 'ACCEPTED', `the market never settles: ${JSON.stringify(facts)}`);
  } finally { await w.close(); }
});
