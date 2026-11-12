// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 skeptic 2 of #1547 (after 61542ae8a): the leader still verifies, without bound, other signatures one seat's GET /batch-proposal hands it.
// (template header of wf1489-v1-refute-56-s1-2 follows)
// POST /sell (order-batch.js ask) keeps any sell its entry's session key signed - a fresh nonce is a fresh sell - with no bound per entry and
// no check that the entry holds a share. A sell of shares the entry does not hold is refused only inside the ledger, by the leader, and is
// LEFT OUT of the batch: it stays unbatched at every seat for ever (until the close). So every batch from then on, each seat's GET
// /batch-proposal hands the leader all of them, the leader checks each one's Ed25519 signature again for every proposal (#sellStands) and
// runs the ledger over them - and a batch that should be certified inside its 0.5 s interval takes seconds, every interval, for the whole
// market. It costs the player one small order and nothing per sell (no lock, no fee: a sell that never fills owes nothing).
// SAFE: the seats bound what one entry keeps pending (or refuse a sell its entry cannot back), so a batch still certifies inside its interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { randomBytes } from 'node:crypto';
import { cancelId, bookBatchId } from '../../arena-protocol/src/order-book.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { sellId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-wf1489-3', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const SELLS = 3000;
const player = (n) => ({ ...LOSER, name: `s${n}`, key: b32(0xc0 + n), worldSecret: b32(0) });
const STRANGER = b32(0x5e); // a key that is no entry's session key: the seat needs no player's help
const cents = (c) => ({ price: BigInt(c) * 1000n });



const FLOOD = 3000;
const rnd = () => new Uint8Array(randomBytes(32));

async function run(name, patch) {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const order = (n, outcome, c) => lockAndPlay(w, player(n), { noMarks: true, pick: outcome, order: cents(c) });
  const nextK = () => Math.floor(testNow() / B);
  const batch = async (k) => {
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const t0 = Date.now();
    const got = await w.nodes.find((d) => d.orderBook.leads(w.rid, k)).orderBook.lead(w.rid, k);
    return { k, ms: Date.now() - t0, ...got };
  };
  try {
    await order(1, YES, 60); await order(2, NO, 55);
    const base = await batch(nextK());
    assert.equal(base.certified, true, base.why);
    const A = await order(0, YES, 10);
    await batch(nextK());
    const results = [];
    for (let r = 0; r < 2; r++) {
      await order(10 + 2 * r, YES, 61); await order(11 + 2 * r, NO, 56);
      // k far enough ahead that building the flood (signing it, done before) is over before k's cutoff
      const k = nextK() + 16;
      const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
      const bad = w.nodes.find((d) => !d.orderBook.leads(w.rid, k));
      const extra = patch({ w, k, A, leaderHex: toHex(leader.orderBook.round.pubkey) });
      const orig = bad.orderBook.proposal.bind(bad.orderBook);
      // a modified seat: its GET /batch-proposal answers its honest proposal plus the extra items (built beforehand: answering is instant)
      bad.orderBook.proposal = (rid, kk) => { const p = orig(rid, kk); return { ...p, cancels: [...(p.cancels || []), ...(extra.cancels || [])], pending: [...(p.pending || []), ...(extra.pending || [])] }; };
      assert.ok(testNow() < k * B, 'the flood was built before batch k opened');
      try { results.push(await batch(k)); } finally { bad.orderBook.proposal = orig; }
    }
    console.log(`  MEASURED ${name}:`, JSON.stringify({ baselineLeadMs: base.ms, rounds: results.map((x) => ({ ms: x.ms, certified: x.certified, why: x.why })), intervalMs: B }));
    for (const x of results) {
      assert.equal(x.certified, true, `${name}: lead() took ${x.ms} ms (baseline ${base.ms} ms) and the batch was not certified: ${x.why}`);
      assert.ok(x.ms < B, `${name}: one seat's proposal held the batch ${x.ms} ms (interval ${B} ms; baseline ${base.ms} ms)`);
    }
  } finally { await w.close(); }
}

// VARIANT (one seat, cancels): #sellsWorthChecking bounds the sells of a proposal, but lead() still runs #cancelStands - an Ed25519 verify -
// on EVERY cancel a seat's proposal lists, unbounded and with no stop after a forged one. A cancel's id is fixed per order, so FLOOD
// cancels of one real order, each signed by a different stranger key, are FLOOD cache misses at verified.js.
test('wf1489-v1-refute-56-s2-1: one seat\'s proposal of forged cancels does not hold a batch past its interval', { timeout: 170000 }, async () => {
  await run('cancels', ({ w, A }) => {
    const id = cancelId({ roundId: w.rid, entryId: A.eid });
    return { cancels: Array.from({ length: FLOOD }, () => ({ entry: toHex(A.eid), signature: toHex(ed25519.sign(id, rnd())) })) };
  });
});
