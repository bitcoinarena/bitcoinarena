// FEE PROPOSALS ON THE PAGE (kanban #462 slice 3): the form reads the fees in force as the nodes agree on them, builds any subset of
// changes, and signs only what the seats' own rule takes - the same limits and sums, so a proposal the form signs a seat keeps and one
// the form refuses a seat refuses with the same words; and a join pays the fees in force at its round's census height (GET /fees?height=),
// not today's default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { fetchFees, feeChangesFrom, signedFeeProposal, earliestActivation, roundFeesLine, marketFeesLine, marketFeeBpsOf } from '../src/fee-proposal-page.js';
import { reservesDonationForRound } from '../src/reserves-page.js';
import { feeBpsForRound } from '../src/join.js';
import { FEES_TODAY, encodeFeeProposal, feeProposalId } from '../../arena-protocol/src/fee-proposal.js';
import { FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { RESERVES_VERSION } from '../../arena-protocol/src/constants.js';
import { createFundingBook } from '../../arena-node/src/funding-book.js';
import { openStore } from '../../arena-node/src/store.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const curve = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };
const KEY = (() => { const k = new Uint8Array(32); k[0] = 9; k[31] = 1; return k; })();
const S = FUNDING_SCHEDULES.spec;
const NEW = Object.freeze({ ...FEES_TODAY, roundNodeBps: 350, roundDonationBps: 450, marketReserveBps: 30 });
// seven nodes: six name the same set, one another; each answers ?height= with the set in force there
function nodes(setAt = () => FEES_TODAY, odd = 6) {
  const asked = [];
  const fetcher = async (u) => {
    asked.push(u);
    const i = Number(/n(\d)\.example/.exec(u)[1]);
    const h = /[?&]height=(\d+)/.exec(u);
    const set = i === odd ? { ...FEES_TODAY, websitePct: 33 } : setAt(h ? Number(h[1]) : null);
    return new Response(JSON.stringify({ tip: 157000, inForce: set, ...(h ? { height: Number(h[1]), atHeight: set } : {}), schedule: S,
      limits: { marketDonationBps: { min: 10, max: 100 } }, sums: { roundMaxBps: 1000, itemPct: 100, marketMaxBps: 200 }, proposals: [] }), { status: 200 });
  };
  return { list: Array.from({ length: 7 }, (_, i) => `https://n${i}.example`), fetcher, asked };
}

test('the form reads the fees most nodes name; builds any subset of changes; signs only what a seat keeps, and a seat refuses what it refuses', async () => {
  const n = nodes();
  const r = await fetchFees({ nodes: n.list, fetcher: n.fetcher });
  assert.deepEqual([r.ok, r.agreeing, r.asked, r.tip], [true, 6, 7, 157000]);
  assert.deepEqual(r.fees, FEES_TODAY);
  assert.equal((await fetchFees({ nodes: n.list.slice(0, 3), fetcher: n.fetcher, needed: 5 })).ok, true, 'three of three agree: as many as were asked');
  const split = nodes(() => FEES_TODAY, -1); let k = 0; const two = async (u) => { k++; return k % 2 ? split.fetcher(u) : new Response(JSON.stringify({ inForce: NEW }), { status: 200 }); };
  assert.match((await fetchFees({ nodes: n.list, fetcher: two })).why, /only 4 of 7 nodes agree/);

  // the typed form: three fees from three areas; an empty or unchanged field is no change
  const ch = feeChangesFrom(FEES_TODAY, { roundNodeBps: '350', marketReserveBps: '30', roundDonationBps: '450', marketNodeBps: '40', websitePct: '' });
  assert.deepEqual(ch, [{ fee: 'roundNodeBps', value: 350 }, { fee: 'roundDonationBps', value: 450 }, { fee: 'marketReserveBps', value: 30 }]);
  assert.throws(() => feeChangesFrom(FEES_TODAY, { roundNodeBps: '3.5' }), /whole number/);

  const at = earliestActivation(157000, S);
  assert.equal(at, 157000 + 1008 + 2016 + 6);
  const signed = signedFeeProposal({ secretKey: KEY, networkId: '07'.repeat(32), publishedHeight: 157000, activationHeight: at, changes: ch, purpose: 'three areas', schedule: S, curve });
  assert.equal(signed.ok, true, signed.why);
  assert.deepEqual(signed.donations, ['roundDonationBps']);
  // a seat keeps exactly that
  const book = createFundingBook({ db: openStore(':memory:'), verify: (s, m, k2) => schnorr.verify(s, m, k2), tip: async () => 157000, isBonded: () => true, activeAt: async () => ({ ok: false }) });
  const kept = await book.add('fee', signed.hex);
  assert.deepEqual([kept.ok, kept.id], [true, signed.id]);

  // the same rule refuses on both sides, with the same words: a market donation of 0, a round above 10 %, too early an activation
  for (const [changes, activation, why] of [
    [[{ fee: 'marketDonationBps', value: 0 }], at, /marketDonationBps is 0, outside its limit 10\.\.100/],
    [[{ fee: 'roundNodeBps', value: 600 }, { fee: 'roundDonationBps', value: 300 }, { fee: 'roundReserveBps', value: 200 }], at, /1100 bps, above the 1000 bps/],
    [[{ fee: 'roundNodeBps', value: 350 }], 157100, /at the earliest, after its signal and its vote/]]) {
    const f = signedFeeProposal({ secretKey: KEY, networkId: '07'.repeat(32), publishedHeight: 157000, activationHeight: activation, changes, schedule: S, curve });
    assert.equal(f.ok, false); assert.match(f.why, why);
    const p = { networkId: new Uint8Array(32).fill(7), author: schnorr.getPublicKey(KEY), publishedHeight: 157000, activationHeight: activation, changes, purpose: '' };
    const seat = await book.add('fee', toHex(Uint8Array.from([...encodeFeeProposal(p), ...schnorr.sign(feeProposalId(p), KEY)])));
    assert.deepEqual([seat.ok, seat.status], [false, 422]); assert.match(seat.why, why);
  }
  assert.equal(signedFeeProposal({ secretKey: KEY, networkId: '07'.repeat(32), publishedHeight: 157000, activationHeight: at, changes: [], schedule: S, curve }).why, 'change at least one fee');
});

test('a join pays the fees in force at its round\'s census height: read with ?height=, then its entry split and node fee from that set', async () => {
  const ACT = 160000;
  const n = nodes((h) => (h !== null && h >= ACT ? NEW : FEES_TODAY));
  const before = await fetchFees({ nodes: n.list, fetcher: n.fetcher, height: ACT - 1 });
  const after = await fetchFees({ nodes: n.list, fetcher: n.fetcher, height: ACT });
  assert.ok(n.asked.some((u) => u.endsWith(`/fees?height=${ACT}`)));
  assert.deepEqual([before.fees.roundNodeBps, after.fees.roundNodeBps, after.fees.roundDonationBps, after.fees.marketReserveBps], [400, 350, 450, 30]);
  const round = (feeSet) => ({ protocolVersion: RESERVES_VERSION, stakeMsat: 1000000n, gameId: new Uint8Array(32).fill(0xee), censusHeight: ACT, ...(feeSet ? { feeSet } : {}) });
  // the node fee and the developers' + reserves' part of a protocol-11 entry
  assert.equal(feeBpsForRound(round(before.fees)), 400);
  assert.equal(feeBpsForRound(round(after.fees)), 350);
  assert.deepEqual(reservesDonationForRound(round(after.fees)), { bps: 650, donationMsat: 65000n, reserveMsat: 20000n, mandatory: true });
  assert.deepEqual(reservesDonationForRound(round(null)), { bps: 600, donationMsat: 60000n, reserveMsat: 20000n, mandatory: true }, 'no set read: today\'s');
  // what the settlement strip shows, and a reserve-paying market's fee lock rate
  assert.equal(roundFeesLine(after.fees), 'nodes 3.5 % · developers 4.5 % · reserves 2 %');
  assert.equal(marketFeesLine(after.fees), 'nodes 0.4 % · developers 0.4 % · reserves 0.3 %');
  assert.deepEqual([marketFeeBpsOf(before.fees), marketFeeBpsOf(after.fees)], [100, 110]);
});
