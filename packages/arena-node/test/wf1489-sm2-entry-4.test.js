// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2-entry-4 (state machine audit, entry): A POOL PICK WHOSE LOCKS REACHED ONLY SOME SEATS SPLITS THE MARKET'S SETTLEMENT FOR GOOD.
// The page counts a pick placed once ONE seat holds its entry and locks (market.js "PLACED ONCE ONE SEAT HOLDS IT") and hands the rest in the
// background - a tab closed or reloaded a few seconds later never hands them. Nothing on the seats carries a plain pick's locks on: the entry relay
// skips every attested round (server.js relayedRound: "an attested round's (a market's) orders are replayed by the order book"), and the order book
// replays orders only, never a pool's plain picks. So the seats that verified the pick's locks count it (stake seen), the others hold the entry
// unseen and leave it out (settlement.js #attestedPlan), each rebuilds another table and another settlement, and no threshold ever signs one:
// every stake and fee of the market waits for its lock's expiry and the winners are never paid.
// Safe behaviour: the seats still settle the market (one settlement ACCEPTED).
// Fixed (kanban #1790): the lock door hands a plain pick's locks on (entry relay), and at the close a seat asks its peers for a pick it holds unseen -
// the second test cuts the hand-on (seat a restarted before it ran: its peers unreachable then) and the close still fetches them.
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

test('#1489 sm2-entry-4 a pool pick whose locks reached one seat only does not stop the market settling', { timeout: 120000 }, async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    // two picks placed in full at both seats
    await lockAndPlay(w, player(0), { noMarks: true, pick: 0 });
    await lockAndPlay(w, player(1), { noMarks: true, pick: 1 });
    // a third: its entry reached both seats, its locks only seat a before the tab closed (the page said "placed" after that seat)
    const late = await lockAndPlay(w, player(2), { noMarks: true, pick: 0, only: [0] });
    // what the seats do on their own before the entries close: their background passes
    await wait(3000);
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
    const facts = { seenAtA: !!w.a.round.stakeSeen(late.eid), seenAtB: !!w.b.round.stakeSeen(late.eid), entryAtB: !!w.b.round.entry(late.eid),
      state: got.state, why: String(got.why || '').slice(0, 200), asked: asked && { state: asked.state, why: String(asked.why || '').slice(0, 300) } };
    console.log('  FACTS sm2-entry-4:', JSON.stringify(facts));
    assert.equal(got.state, 'ACCEPTED', `the market never settles: ${JSON.stringify(facts)}`);
  } finally { await w.close(); }
});

test('#1790 sm2-entry-4 a pool pick whose locks were never handed on is fetched at the close (the hand-on lost to a restart)', { timeout: 120000 }, async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    // two picks placed in full at both seats
    await lockAndPlay(w, player(0), { noMarks: true, pick: 0 });
    await lockAndPlay(w, player(1), { noMarks: true, pick: 1 });
    // a third: its entry reached both seats, its locks only seat a before the tab closed (the page said "placed" after that seat)
    // seat a's hand-on reaches nobody (it lives in memory: a restart before it ran loses it the same way)
    const peers = w.a.verifier.peers;
    w.a.verifier.peers = ['http://127.0.0.1:1'];
    const late = await lockAndPlay(w, player(2), { noMarks: true, pick: 0, only: [0] });
    await wait(3000);
    assert.equal(!!w.b.round.stakeSeen(late.eid), false, 'the hand-on was not cut');
    w.a.verifier.peers = peers;
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
    const facts = { seenAtA: !!w.a.round.stakeSeen(late.eid), seenAtB: !!w.b.round.stakeSeen(late.eid), entryAtB: !!w.b.round.entry(late.eid),
      state: got.state, why: String(got.why || '').slice(0, 200), asked: asked && { state: asked.state, why: String(asked.why || '').slice(0, 300) } };
    console.log('  FACTS sm2-entry-4 (no hand-on):', JSON.stringify(facts));
    assert.equal(got.state, 'ACCEPTED', `the market never settles: ${JSON.stringify(facts)}`);
  } finally { await w.close(); }
});
