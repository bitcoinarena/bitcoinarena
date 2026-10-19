// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET'S PROTOCOL RESERVE (2026-10-17: "Prediction markers brauchen auch eine protocol reserve fee: 0.4%
// donation (50/50 protocol / market dev), 0.4% node, 0.2% protocol reserve fee"): the terms name it after their own marker, the
// whole fee stays node + donation (1 %), and the settlement pays 0.2 % of the stakes out of the donation's part to the reserve key
// of the federation each lock is in - the nodes' part and every player's out unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { encodeManifest, decodeManifest, encodeManifestBody, manifestBodyId, gameIdOf, RESULT_TYPE, PAYOUT_RULE, NO_PARENT, marketTermsFit,
  MARKET_RESERVE_MARKER, MARKET_RESERVE_BPS } from '../src/manifest.js';
import { reserveBpsOf, entryFeeBpsOf, feeBpsOf, donationBpsOf, entryFeeMsat } from '../src/fee.js';
import { bookLedger, bookSettlement } from '../src/book-ledger.js';
import { YES, NO } from '../src/order-book.js';
import { bookLockSettlement, RESERVE_LATER_PK } from '../src/lock-settlement.js';
import { splitByFederation } from '../src/federation-settlement.js';
import { splitTwoSets } from '../src/donation.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../src/test-donation-set-keys-regtest.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const key33 = (n) => { const k = new Uint8Array(33).fill(n); k[0] = 2; return k; };
const DEV = (() => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; })();
const BODY = {
  gameName: 'btc-up-down', gameDevPubkey: DEV.pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: b32(0xd0), outcomes: ['up', 'down'], attestors: [b32(0xa1)], attestThreshold: 1,
};
const TERMS = { nodeFeeBps: 40, donationBps: 60, question: 'Is BTC/USD higher at the resolution time than at entry close?',
  resolveAfterCloseMs: 900000n, deadlineAfterResolveMs: 600000n, sourceRule: 'median of the Binance, Coinbase and Kraken BTC/USD last trade' };
const signed = (b) => ({ ...b, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(b)), DEV.key)) });

test('the reserve rides after its own marker; terms without it keep their bytes and their id', () => {
  const plain = signed({ ...BODY, marketTerms: TERMS });
  const withReserve = signed({ ...BODY, marketTerms: { ...TERMS, reserveBps: MARKET_RESERVE_BPS } });
  const back = decodeManifest(encodeManifest(withReserve));
  assert.equal(back.marketTerms.reserveBps, 20);
  assert.deepEqual(encodeManifest(back), encodeManifest(withReserve));
  assert.equal(decodeManifest(encodeManifest(plain)).marketTerms.reserveBps, undefined);
  const plainBody = encodeManifestBody({ ...BODY, marketTerms: TERMS }), reserveBody = encodeManifestBody({ ...BODY, marketTerms: { ...TERMS, reserveBps: 20 } });
  assert.deepEqual(reserveBody.subarray(0, plainBody.length), plainBody, 'written after everything a market already writes');
  assert.equal(reserveBody.length, plainBody.length + 3);
  assert.equal(reserveBody[plainBody.length], MARKET_RESERVE_MARKER);
  assert.notDeepEqual(gameIdOf(withReserve), gameIdOf(plain));
});

test('0.4 % node, 0.6 % donation of which 0.2 % reserve: the whole fee stays 1 %; the reserve is 0.2 % exactly and inside the donation', () => {
  const m = { ...BODY, marketTerms: { ...TERMS, reserveBps: 20 } };
  assert.deepEqual([feeBpsOf(m), donationBpsOf(m), reserveBpsOf(m), entryFeeBpsOf(m)], [40, 60, 20, 100]);
  assert.equal(reserveBpsOf({ ...BODY, marketTerms: TERMS }), 0);
  assert.equal(marketTermsFit({ ...TERMS, reserveBps: 20 }).ok, true);
  assert.match(marketTermsFit({ ...TERMS, reserveBps: 10 }).why, /20 bps/);
  assert.match(marketTermsFit({ ...TERMS, donationBps: 10, reserveBps: 20 }).why, /part of its donation/);
});

// two orders of 10,000 sats, Up and Down at 50 ¢, Up wins: 200 sats of fees due
const STAKE = 10_000_000n;
const feeMsat = entryFeeMsat(STAKE, 100);
const id = (s) => s.padStart(64, '0');
const L = bookLedger({ batches: [{ k: 1, cutoffMs: 1000n, orders: [{ id: id('a'), outcome: YES, price: 50000n, stakeMsat: STAKE, feeMsat, expiryMs: 0n },
  { id: id('b'), outcome: NO, price: 50000n, stakeMsat: STAKE, feeMsat, expiryMs: 0n }] }], feeBps: 100 });
const table = bookSettlement({ positions: L.positions, outcome: YES });
const contract = { nodes: [b32(0x11), b32(0x22)] };
const player = { a: b32(0xa1), b: b32(0xb1) };
const op = (n) => ({ txid: b32(n), outIdx: BigInt(n) });
const entries = ['a', 'b'].map((x) => ({ entryId: id(x), pubkey: player[x] }));
const locks = new Map(['a', 'b'].map((x, i) => [toHex(player[x]), { outpoint: op(1 + i), amountMsat: STAKE - feeMsat, refundPk: new Uint8Array([2, ...player[x]]) }]));
const feeLocks = new Map(['a', 'b'].map((x, i) => [toHex(player[x]), { outpoint: op(5 + i), amountMsat: feeMsat, preimage: b32(9) }]));
const NO_FEES = { ppm: 0n, baseMsat: 0n };
const settle = (over) => bookLockSettlement({ roundId: b32(1), table, entries, locks, feeLocks, fees: NO_FEES, contract,
  donation: { recipients: TEST_DONATION_SET_KEYS_REGTEST.recipients }, ...over });
const sum = (s, kind) => s.payouts.filter((p) => p.kind === kind).reduce((t, p) => t + p.msat, 0n);

test('the settlement pays 0.4 % to the nodes, 0.4 % as donation and 0.2 % to the federation\'s reserve key; every player\'s out unchanged', () => {
  const before = settle({ nodeBps: 50, donationBps: 50 });
  const R = key33(0x77);
  const s = settle({ nodeBps: 40, donationBps: 60, reserveBps: 20, reserveKey: R });
  assert.equal(s.ok, true, s.why);
  assert.equal(table.feesDueMsat, 200000n);
  assert.deepEqual([sum(s, 'signer node'), sum(s, 'donation key'), sum(s, 'reserve')], [80000n, 80000n, 40000n]);
  assert.deepEqual([sum(before, 'signer node'), sum(before, 'donation key'), sum(before, 'reserve')], [100000n, 100000n, 0n]);
  const reserve = s.payouts.find((p) => p.kind === 'reserve');
  assert.equal(toHex(reserve.payoutPk), toHex(R));
  assert.equal(reserve.reserve, true);
  assert.equal(sum(s, 'qualifier'), sum(before, 'qualifier'), 'the players get what they got');
  assert.equal(s.book.reserveMsat, 40000n);
  // no reserve key: nothing is claimed - the locks expire back to their players
  assert.match(settle({ nodeBps: 40, donationBps: 60, reserveBps: 20 }).why, /no reserve key/);
});

test('the donation\'s 0.4 % is split 50/50 between the protocol devs and the market dev', () => {
  const k = (n) => ({ recipientPk: key33(n), shareBps: 10000, label: `dev ${n}` });
  const two = splitTwoSets({ donationMsat: 80000n, networkSet: [k(0x31)], gameSet: [k(0x32)] });
  assert.deepEqual([two.protocolMsat, two.gameMsat], [40000n, 40000n]);
});

test('a round in any federation: each federation\'s part of the reserve goes to that federation\'s own reserve key', () => {
  const plan = settle({ nodeBps: 40, donationBps: 60, reserveBps: 20, reserveKey: RESERVE_LATER_PK });
  assert.equal(plan.ok, true, plan.why);
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
  const fedOf = (o) => (Number(o.outIdx) % 2 ? A : B);    // a's locks in A, b's in B
  const keys = { [A]: key33(0x0a), [B]: key33(0x0b) };
  const got = splitByFederation(plan, { roundId: b32(1), federationOf: fedOf, feesOf: () => NO_FEES, reserveKeyOf: (f) => keys[f] || null });
  assert.equal(got.ok, true, got.why);
  for (const s of got.settlements) {
    const r = s.payouts.filter((p) => p.reserve);
    assert.equal(r.length, 1);
    assert.equal(toHex(r[0].payoutPk), toHex(keys[s.federation]));
  }
  // the split scales every line by the same fraction of each federation's pot: the reserve stays half the nodes' part
  const all = (pred) => got.settlements.reduce((t, s) => t + s.payouts.filter(pred).reduce((u, p) => u + p.msat, 0n), 0n);
  const r = all((p) => p.reserve), nodesPaid = all((p) => p.kind === 'signer node');
  assert.ok(r > 0n && (nodesPaid - 2n * r <= 8n && 2n * r - nodesPaid <= 8n), `reserve ${r}, nodes ${nodesPaid}`);
  // a federation with no reserve key: refused, by name
  const miss = splitByFederation(plan, { roundId: b32(1), federationOf: fedOf, feesOf: () => NO_FEES, reserveKeyOf: (f) => (f === A ? keys[A] : null) });
  assert.match(miss.why, /names no reserve key/);
});
