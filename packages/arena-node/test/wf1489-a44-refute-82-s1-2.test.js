// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-82: tries to refute #1790 (a pool pick whose locks reached one seat still settles at every seat)
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

test("#1489 a44-refute-82-s1-2 the seat holding the locks unreachable for 15 s across the close: the pull gives up after 4 passes and nothing pulls again", { timeout: 150000 }, async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const realFetch = globalThis.fetch;
  try {
    await lockAndPlay(w, player(0), { noMarks: true, pick: 0 });
    await lockAndPlay(w, player(1), { noMarks: true, pick: 1 });
    // the hand-on lost (seat a restarted before it ran), as in #1790's own second test
    const peers = w.a.verifier.peers;
    w.a.verifier.peers = ['http://127.0.0.1:1'];
    const late = await lockAndPlay(w, player(2), { noMarks: true, pick: 0, only: [0] });
    await wait(3000);
    assert.equal(!!w.b.round.stakeSeen(late.eid), false, 'the hand-on was not cut');
    w.a.verifier.peers = peers;
    // seat a down for a restart across the close: its /order-locks answers nobody for 15 s (the pull runs 4 passes over ~12 s, once per close)
    const downUntil = Date.now() + 15000;
    globalThis.fetch = (u, ...r) => (String(u).includes('/order-locks') && Date.now() < downUntil ? Promise.reject(new Error('ECONNREFUSED (seat restarting)')) : realFetch(u, ...r));
    await closeRound(w);
    await wait(Math.max(0, downUntil - Date.now()) + 1000);
    globalThis.fetch = realFetch;
    const at = w.c.entryCloseMs + 1n;
    await Promise.all(w.nodes.map((d) => post(d, w.rid, signedBy({ roundId: w.rid, outcome: 0, observedAtMs: at }, [A0, A2]))));
    skipTo(Number((await outcome(w.a, w.rid)).finalAtMs) + 100);
    let got;
    for (const stop = Date.now() + 25000; Date.now() < stop; await wait(250)) {
      got = await standing(w.a, w);
      if (got.state === 'ACCEPTED') break;
    }
    const facts = { seenAtA: !!w.a.round.stakeSeen(late.eid), seenAtB: !!w.b.round.stakeSeen(late.eid), state: got.state, why: String(got.why || '').slice(0, 200) };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.equal(got.state, 'ACCEPTED', `the market never settles: ${JSON.stringify(facts)}`);
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
