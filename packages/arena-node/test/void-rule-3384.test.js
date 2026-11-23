// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #3384: the batch void rule - honest void and equivocating decline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { bookBatchId, batchDeclineId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-void3384', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const player = (n) => ({ ...LOSER, name: `v3384-${n}`, key: b32(0xc0 + n), worldSecret: b32(0) });



const setup = async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  return w;
};
const base = (d) => `http://127.0.0.1:${d.port}`;
const post = async (d, path, body) => { const r = await fetch(`${base(d)}${path}`, { method: 'POST', body: JSON.stringify(body) }); const t = await r.text(); return { status: r.status, t }; };
const untilCutoff = async (k, extra = 20) => { while (testNow() < (k + 1) * B + extra) await wait(5); };

test('#3384 honest void: k\'s set never reached anyone, the threshold of seats that signed nothing decline it - VOID at every seat', { timeout: 170000 }, async () => {
  const w = await setup();
  const rid = toHex(w.rid);
  try {
    const R = await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 70000n } });
    const S = await lockAndPlay(w, player(4), { noMarks: true, pick: NO, order: { price: 35000n } });
    const k = Math.floor(testNow() / B) + 1;
    await untilCutoff(k + 1);
    // k's leader signed its set but every POST /batch was lost: no seat signed it, all six others decline the leader's void ask
    const L = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const others = w.nodes.filter((d) => d !== L);
    const ids = [toHex(R.eid), toHex(S.eid)].sort();
    const id = bookBatchId({ roundId: w.rid, k: BigInt(k), orderIds: ids });
    const record = { k: String(k), orders: ids, cancels: [], sells: [], leader: toHex(L.round.pubkey), leaderSig: toHex(schnorr.sign(id, L.round.identity.secret)) };
    const ask = L.orderBook.voidAskFor(w.rid, k, record);
    const declines = [];
    for (const d of others) {
      const r = await post(d, `/batch-void-ask?round=${rid}&k=${k}`, ask);
      const j = JSON.parse(r.t);
      if (j.declined) declines.push({ seat: j.seat, signature: j.declined });
    }
    assert.ok(declines.length >= w.needed, `only ${declines.length} seats declined`);
    const short = await post(others[0], `/batch-void?round=${rid}`, { k: String(k), declines: declines.slice(0, w.needed - 1) });
    assert.equal(short.status, 403, short.t);
    for (const d of w.nodes) { const r = await post(d, `/batch-void?round=${rid}`, { k: String(k), declines }); assert.equal(r.status < 300, true, r.t); }
    for (const d of w.nodes) assert.equal(d.orderBook.batchState(w.rid, k), 'VOID');
  } finally { await w.close(); }
});

test('#3384 a signer\'s decline is equivocation: refused, kept as evidence (signed set + signed decline), never counted', { timeout: 170000 }, async () => {
  const w = await setup();
  const rid = toHex(w.rid);
  try {
    const R = await lockAndPlay(w, player(2), { noMarks: true, pick: YES, order: { price: 70000n } });
    const S = await lockAndPlay(w, player(3), { noMarks: true, pick: NO, order: { price: 35000n } });
    const k = Math.floor(testNow() / B) + 1;
    await untilCutoff(k);
    const L = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const others = w.nodes.filter((d) => d !== L);
    const F = others[0], J = others[5];       // F signs the set; J (the judge) never sees it
    const ids = [toHex(R.eid), toHex(S.eid)].sort();
    const id = bookBatchId({ roundId: w.rid, k: BigInt(k), orderIds: ids });
    const record = { k: String(k), orders: ids, cancels: [], sells: [], leader: toHex(L.round.pubkey), leaderSig: toHex(schnorr.sign(id, L.round.identity.secret)) };
    const r = await post(F, `/batch?round=${rid}`, record);
    assert.equal(r.status, 201, r.t);
    const fsig = JSON.parse(r.t);
    await untilCutoff(k + 1);
    const ask = F.orderBook.voidAskFor(w.rid, k, record);
    const declines = [];
    for (const d of others.slice(1)) {
      const a = await post(d, `/batch-void-ask?round=${rid}&k=${k}`, ask);
      const j = JSON.parse(a.t); if (j.declined) declines.push({ seat: j.seat, signature: j.declined });
    }
    // four seats that signed nothing, and F's decline beside its own signed set: 4 count, F's is equivocation
    const Fhex = toHex(F.round.pubkey);
    const fdecl = toHex(schnorr.sign(batchDeclineId({ roundId: w.rid, k: BigInt(k) }), F.round.identity.secret));
    const sets = [{ batchId: toHex(id), ids, sigs: [{ seat: fsig.seat, signature: fsig.signature }] }];
    const v = await post(J, `/batch-void?round=${rid}`, { k: String(k), declines: [...declines.slice(0, w.needed - 1), { seat: Fhex, signature: fdecl }], sets });
    assert.equal(v.status, 403, v.t);
    assert.match(v.t, /equivocation/);
    const ev = J.orderBook.db.prepare('SELECT seat, decline_sig, batch_id, set_sig FROM market_batch_equivocations WHERE k = ?').all(k);
    assert.deepEqual(ev.map((e) => [e.seat, e.decline_sig, e.batch_id, e.set_sig]), [[Fhex, fdecl, toHex(id), fsig.signature]]);
    assert.notEqual(J.orderBook.batchState(w.rid, k), 'VOID');
    // a set of k with its own certificate is final: named in a void, the void is refused
  } finally { await w.close(); }
});
