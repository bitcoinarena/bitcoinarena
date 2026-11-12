// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 wf1489-sm2-settle-2: A WALK-AWAY WHOSE DONATION SET ANSWERS SOME SEATS AND NOT OTHERS NEVER SETTLES (SM-8, the kept send plan).
// Hole 1 (a) (planSends' loop): a seat that cannot reach a donation recipient names it, the asker drops its plan and offers one with that
// recipient HELD. The seats that could reach it already keep the first plan, and give it up only for a plan whose planKey sorts LOWER
// (winnings-send.js check, adoptPeerPlan). planKey joins the payment hashes with ':' - a held row's hash is '' - so the all-held plan's
// key is ':', which sorts ABOVE any key whose lowest hash starts with a digit 0-9 (':' is 0x3a): about 86 % of the time. Then the seats
// that kept the first plan refuse the held one, the seats that cannot reach the set refuse the first one, neither reaches the 5 a
// signature needs, and on the next pass the asker re-adopts the lower first plan from its peers and the same split comes back. The
// round sits unsettled until every lock expires back: the walk-away's stake returns to the walker, the signer nodes' 75 % is never paid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, proposerOf, standing } from './lock-round-fixture.js';
import { LOSER, b32, wait } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';

test('wf1489 sm2-settle-2: 5 of 7, the donation set unreachable at three seats - the walk-away still settles with those shares HELD', async () => {
  const port = lockPort();
  const w = await lockRound({ n: 7, port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 500, donationSets: [TEST_DONATION_SET_REGTEST] } });
  try {
    const p = proposerOf(w);
    const others = w.nodes.filter((d) => d !== p);
    const down = others.slice(0, 3);
    // THREE SEATS CANNOT REACH THE SET (hole 1 (a)'s case); the proposer and the other three can
    for (const d of down) {
      const own = d.winnings.lnurlFetch;
      d.winnings.lnurlFetch = (url, o) => (new URL(url).pathname.startsWith('/lnurlp/') ? Promise.reject(new Error('connect ECONNREFUSED')) : own(url, o));
    }
    // THE PROPOSER'S INVOICES: any invoice the recipient's LNURL hands out; the ones whose payment hash starts with a digit (5 of 8 do) are taken
    { const own = p.winnings.lnurlFetch;
      p.winnings.lnurlFetch = async (url, o) => {
        if (new URL(url).pathname !== '/cb') return own(url, o);
        for (;;) { const r = await own(url, o); if (/^[0-9]/.test(w.lnurl.issued.at(-1).paymentHash)) return r; }
      }; }
    const walker = await lockAndPlay(w, { ...LOSER, name: 'walker', key: b32(0x21) }, { noMarks: true });
    for (const stop = Date.now() + 60000; Date.now() < stop && w.nodes.some((d) => !d.round.results(w.rid, walker.eid).length); await wait(250));
    await closeRound(w);
    let st;
    for (const stop = Date.now() + 75000; Date.now() < stop; await wait(500)) {
      st = await standing(p, w);
      if (st.state === 'ACCEPTED') break;
    }
    const kept = (d) => d.round.sendAttemptsOf(w.rid).filter((r) => r.attempt === 0 && r.donation).map((r) => (r.invoice ? r.paymentHash.slice(0, 6) : 'HELD')).join(',');
    const facts = { state: st && st.state, why: String(st && st.why).slice(0, 220), proposer: kept(p),
      reach: others.slice(3).map(kept), cannotReach: down.map(kept), settlementsSubmitted: port.settlements.length };
    console.log('  MEASURED wf1489-sm2-settle-2:', JSON.stringify(facts));
    assert.equal(facts.state, 'ACCEPTED', `the walk-away never settles: the seats split between the first plan and the held one (${facts.why})`);
  } finally { await w.close(); }
});
