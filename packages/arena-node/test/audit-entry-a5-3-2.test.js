// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit 2026-11-22 entry r3-2: A LOSING FILLED ORDER IS LET GO AFTER THE OUTCOME, AND THE BOOK'S SETTLEMENT NEVER FORMS (gap in #2477/#3223).
// Since #2477 the lowest entry id among a player key's lock-backed entries owns the key: a lock of a LOWER entry of that key makes
// round.yieldEntryLocks delete the higher entry's stake_locks, fee_locks and stake_seen rows "only while nothing was built on them". The
// guard (yieldEntryLocks / yieldable) reads lock fates, a settlement row, a forfeit, this seat's own result and - since #3223 - a receipted
// mark. An order of an order book has none of these until the settlement: a fill in a CERTIFIED batch is not read. And an order's lock
// door has no close (lockAfterCloseRefusal answers null for any limit-price entry; a late one is only "not tradable").
// So the player of a filled order that lost (the outcome is attested; the objection window still runs, no settlement yet) posts, before the
// close, a second order of his own key whose id is lower (a fresh session key, a coin flip) and hands its lock after the outcome: every seat
// deletes the filled order's locks, bookLockSettlement refuses "a filled order's stake lock was never verified here", no settlement ever
// forms, and every lock - the loser's lost stake included - goes back to its player at expiry. The winner is never paid.
// (A stranger can do the same to anyone's filled order: an entry and a handout carry no player signature, and his lock refunds to the
// victim's key.)
// SAFE: a lock handed after the market's close for another order of the same key does not unstake a filled order; the book settles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay, closeRound, standing } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { UPDOWN, UPDOWN_TERMS, UPDOWN_PERIOD_MS } from './plugins/updown/index.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { testNow, skipTo } from './test-clock.js';
import { attestorSign } from './plugins/sign.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { YES, NO } from '../../arena-protocol/src/order-book.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const feeFieldsOf = (p) => ({ paymentImage: { kind: 'hash', bytes: sha256(p.entry.feePreimage) }, amountMsat: p.entry.feeMsat,
  claimPk: p.fields.claimPk, refundPk: p.fields.refundPk, expiration: p.fields.expiration });

test('audit entry r3-2: a lock handed after the outcome for a lower order of a filled loser\'s key does not stop the book\'s settlement', { timeout: 170000 }, async () => {
  const P = Number(UPDOWN_PERIOD_MS);
  const B = 500;
  const STAKE_B = 10_000_000n;
  const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
  const w = await lockRound({ n: 2, stakeMsat: STAKE_B, round: ROUND, endMs: testNow() + 1800000, alignCloseMs: P, stakeExpiryFor: (c) => marketExpiryBlocks(c, UPDOWN_TERMS).blocks,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  const base = (d) => `http://127.0.0.1:${d.port}`;
  try {
    for (const d of w.nodes) d.orderBook.intervalMs = B;
    const [A0, A1] = UPDOWN.attestors;
    skipTo(Math.max(Number(w.c.committeeTimeMs), Number(w.c.entryCloseMs) - P) + 100);
    const who = (n) => ({ name: `o${n}`, key: b32(0x60 + n), worldSecret: b32(0), ticks: 1, words: () => [0, 0, 0, 0, 0] });
    const yes = await lockAndPlay(w, who(1), { noMarks: true, pick: YES, order: { price: 50000n } });
    const no = await lockAndPlay(w, who(2), { noMarks: true, pick: NO, order: { price: 50000n } });
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const got = await leader.orderBook.lead(w.rid, k);
    assert.equal(got.certified, true, got.why);
    // before the close: a second order of the NO player's key, entered at both seats with no lock handed, its id below the filled one's
    let second = null;
    for (let i = 0; i < 16 && !second; i++) {
      const p = await lockAndPlay(w, { ...who(2), name: `second-${i}` }, { noMarks: true, pick: NO, order: { price: 1000n }, only: [] });
      if (Buffer.compare(Buffer.from(p.eid), Buffer.from(no.eid)) < 0) second = p;
    }
    assert.ok(second, 'no lower entry id in 16 tries');
    skipTo(Number(w.c.entryCloseMs) + 2 * B + 10);
    await closeRound(w, { window: false });
    // the outcome: YES - the NO order lost
    const body = { roundId: w.rid, outcome: YES, observedAtMs: w.c.entryCloseMs };
    const rid = toHex(w.rid);
    await Promise.all(w.nodes.map((d) => fetch(`${base(d)}/outcome?round=${rid}`, { method: 'POST', body: encodeAttestation({ ...body, signatures: [A0, A1].map((a) => attestorSign(a, body)) }) })));
    const o = await (await fetch(`${base(w.nodes[0])}/outcome?round=${rid}`)).json();
    // inside the outcome's window (no settlement yet): the loser hands the second order's locks to both seats
    const said = [];
    for (const d of w.nodes) {
      const l = await fetch(`${base(d)}/lock?entry=${toHex(second.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(second.fields)) });
      const f = await fetch(`${base(d)}/fee-lock?entry=${toHex(second.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFieldsOf(second))) });
      said.push({ lock: [l.status, (await l.text()).slice(0, 80)], fee: [f.status, (await f.text()).slice(0, 80)] });
    }
    const held = w.nodes.map((d) => ({ noLock: !!d.round.stakeLock(no.eid), noFee: !!d.round.feeLock(no.eid), noSeen: !!d.round.stakeSeen(no.eid) }));
    skipTo(Number(o.finalAtMs) + 100);
    let s;
    for (const stop = Date.now() + 30000; Date.now() < stop; await wait(250)) {
      s = await standing(w.a, w);
      if (s.state === 'ACCEPTED') break;
      await Promise.all(w.nodes.map((d) => d.settlements.settle(w.rid).catch(() => null)));
    }
    console.log('  FACTS entry r3-2:', JSON.stringify({ no: toHex(no.eid).slice(0, 16), second: toHex(second.eid).slice(0, 16), said, held, settlement: s && s.state, why: s && s.why }));
    assert.equal(s.state, 'ACCEPTED', `the book's settlement never forms once the filled losing order's locks were let go (${s && s.why}); held after the late lock: ${JSON.stringify(held)}`);
  } finally { await w.close(); }
});
