// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SIGNER NODE CHECKS AN ENTRY'S DONATION OUTPUTS WITH THE FEDERATION AND INDEXES THEM BY KEY (2026-10-03,
// FEDERATION.md "Donations in the federation"): each output is the payout contract to its recipient key for exactly its
// share, held by the federation at the outpoint the entry names, and one output pays for one entry; GET /donations?key=
// lists what a key was given.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyDonationOutputs, donationContractFields } from '../src/stake-lock-signer-node.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TESTNET4_DONATION_SET } from '../../arena-protocol/src/testnet4-donation-set.js';
import { b32 } from './window-fixture.js';
import { joinedWithLock, CLAIM } from './lock-fixture.js';

const key = (prefix, fill) => Uint8Array.of(prefix, ...new Uint8Array(32).fill(fill));
const DEVS = [
  { recipientPk: key(0x02, 0xa1), shareBps: 6667, label: 'dev a' },
  { recipientPk: key(0x03, 0xb2), shareBps: 3333, label: 'dev b' },
];
const OUT = [{ txid: b32(0x08), outIdx: 2n }, { txid: b32(0x08), outIdx: 3n }];
const at = (o) => `${toHex(o.txid)}:${o.outIdx}`;
// THE CONTRACT'S ID, as the stock client would hash it: here every field written out, so another amount or key is another id
const idOf = (f) => [f.paymentImage.kind, toHex(f.paymentImage.bytes), f.amountMsat, toHex(f.claimPk), toHex(f.refundPk), f.expiration].join('|');

/** A federation that holds the contracts it is given, by outpoint, and counts every ask. */
function federation(held = {}) {
  const port = { asked: 0, held: new Map(Object.entries(held)),
    async status(o) { port.asked++; const id = port.held.get(at(o)); return { blockCount: 155000, stored: id ? { contractId: id, blocksLeft: 0 } : null }; },
    async contractId(f) { port.asked++; return idOf(f); } };
  return port;
}
const paysBoth = () => federation({
  [at(OUT[0])]: idOf(donationContractFields({ recipientPk: DEVS[0].recipientPk, amountMsat: 1334n })),
  [at(OUT[1])]: idOf(donationContractFields({ recipientPk: DEVS[1].recipientPk, amountMsat: 666n })),
});
const round = (taken = new Map()) => ({ donationOutputAt: (o) => taken.get(at(o)) || null });
const entry = (more = {}) => ({ roundId: b32(0x01), donationMsat: 2000n, donationOutpoints: OUT, ...more });
const ME = b32(0xee);
const check = (more = {}) => verifyDonationOutputs({ round: round(), port: paysBoth(), entry: entry(), entryIdBytes: ME, recipients: DEVS, federationId: b32(0xfe), ...more });

test('the payout contract a donation output is: zero hash image, expired from the start, claim and refund key the recipient\'s', () => {
  const f = donationContractFields({ recipientPk: DEVS[0].recipientPk, amountMsat: 1334n });
  assert.deepEqual([f.paymentImage.kind, toHex(f.paymentImage.bytes), f.amountMsat, toHex(f.claimPk), toHex(f.refundPk), f.expiration],
    ['hash', '00'.repeat(32), 1334n, toHex(DEVS[0].recipientPk), toHex(DEVS[0].recipientPk), 0]);
});

test('an entry whose federation holds each share for its key is taken, and the rows to index name key, amount, round and federation', async () => {
  const port = paysBoth();
  const r = await verifyDonationOutputs({ round: round(), port, entry: entry(), entryIdBytes: ME, recipients: DEVS, federationId: b32(0xfe) });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.rows.map((x) => [x.outpoint.outIdx, toHex(x.recipientPk).slice(0, 4), x.amountMsat, toHex(x.federationId).slice(0, 4)]),
    [[2n, '02a1', 1334n, 'fefe'], [3n, '03b2', 666n, 'fefe']]);
  assert.equal(port.asked, 4, 'the federation is asked for each output, status and id');
});

test('a wrong or missing donation output is refused by name', async () => {
  const cases = [
    ['the outputs swapped', { entry: entry({ donationOutpoints: [OUT[1], OUT[0]] }) }, /is not 1334 msat to key 02a1/],
    ['nothing at an outpoint', { port: federation({ [at(OUT[0])]: idOf(donationContractFields({ recipientPk: DEVS[0].recipientPk, amountMsat: 1334n })) }) }, /holds nothing at/],
    ['one msat short', { port: federation({ [at(OUT[0])]: idOf(donationContractFields({ recipientPk: DEVS[0].recipientPk, amountMsat: 1333n })), [at(OUT[1])]: 'x' }) }, /is not 1334 msat/],
    ['one output missing from the entry', { entry: entry({ donationOutpoints: [OUT[0]] }) }, /names 1 donation output\(s\) and .* owes 2/],
    ['no outputs named', { entry: entry({ donationOutpoints: undefined }) }, /names 0 donation output/],
    ['an output already paying for another entry', { round: round(new Map([[at(OUT[1]), { entryId: b32(0xdd) }]])) }, /already pays for another entry/],
    ['outputs in an LNURL round', { recipients: TESTNET4_DONATION_SET.recipients }, /pays LNURLs/],
    ['outputs where this node holds no set', { recipients: null }, /holds no donation set/],
  ];
  for (const [name, more, why] of cases) {
    const r = await check(more);
    assert.equal(r.ok, false, `${name}: taken`);
    assert.match(r.why, why, `${name}: refused for another reason (${r.why})`);
  }
});

test('an entry that donates nothing, an LNURL round without outputs, a node with no set and no outputs: nothing to check', async () => {
  for (const more of [{ entry: entry({ donationMsat: 0n, donationOutpoints: undefined }) },
    { entry: entry({ donationOutpoints: undefined }), recipients: TESTNET4_DONATION_SET.recipients },
    { entry: entry({ donationOutpoints: undefined }), recipients: null }]) {
    const port = federation();
    const r = await check({ ...more, port });
    assert.equal(r.ok, true, r.why);
    assert.deepEqual(r.rows, []);
    assert.equal(port.asked, 0);
  }
});

test('GET /donations lists what a key was given, oldest first, from since; a key that is not a point is refused', async () => {
  const s = await joinedWithLock({ claimKeyFor: () => CLAIM });
  try {
    const r = s.d.round;
    r.putDonationOutputs([
      { outpoint: OUT[0], entryId: s.eid, roundId: s.entry.roundId, federationId: b32(0xfe), recipientPk: DEVS[0].recipientPk, amountMsat: 1334n, contractId: 'c0' },
      { outpoint: OUT[1], entryId: s.eid, roundId: s.entry.roundId, federationId: b32(0xfe), recipientPk: DEVS[1].recipientPk, amountMsat: 666n, contractId: 'c1' },
    ]);
    assert.equal(toHex(r.donationOutputAt(OUT[1]).entryId), toHex(s.eid));
    const ask = async (q) => { const res = await fetch(`http://127.0.0.1:${s.d.port}/donations?${q}`); return [res.status, res.status === 200 ? await res.json() : await res.text()]; };
    const [st, a] = await ask(`key=${toHex(DEVS[0].recipientPk)}`);
    assert.equal(st, 200);
    assert.deepEqual(a.donations.map((d) => [d.outpoint, d.amountMsat, d.federationId.slice(0, 4), d.roundId === toHex(s.entry.roundId), d.entryId === toHex(s.eid)]),
      [[at(OUT[0]), '1334', 'fefe', true, true]]);
    assert.equal((await ask(`key=${toHex(DEVS[1].recipientPk).toUpperCase()}`))[1].donations.length, 1, 'the key is read in either case');
    assert.equal((await ask(`key=${toHex(DEVS[0].recipientPk)}&since=${Date.now() + 60000}`))[1].donations.length, 0);
    assert.equal((await ask(`key=${'04' + 'aa'.repeat(32)}`))[0], 400);
    assert.equal((await ask('key=02abc'))[0], 400);
  } finally { await s.close(); }
});

// THE SENDER ON THE FEDIMINT DONATION (2026-10-05; measured on a regtest federation: the guardians store
// the contract with the key, and the dev redeems it at once): a donation output's payment image is the entry's own player key,
// or the zero image of pages already out. Any other image is refused - a donation that names somebody else is not this
// entry's - and the row says whether the sender's key is on the contract.
const PLAYER = b32(0x77);
const keyed = (recipientPk, amountMsat, image) => idOf(donationContractFields({ recipientPk, amountMsat, image }));
test('the payout contract can carry the sender: the image is the 32-byte key given, zeros when none', () => {
  const f = donationContractFields({ recipientPk: DEVS[0].recipientPk, amountMsat: 1334n, image: PLAYER });
  assert.deepEqual([f.paymentImage.kind, toHex(f.paymentImage.bytes), toHex(f.claimPk), toHex(f.refundPk), f.expiration], ['hash', '77'.repeat(32), toHex(DEVS[0].recipientPk), toHex(DEVS[0].recipientPk), 0]);
});
test('an output whose image is the entry\'s own player key is taken and marked; zeros are still taken; another key is refused', async () => {
  const withKey = federation({ [at(OUT[0])]: keyed(DEVS[0].recipientPk, 1334n, PLAYER), [at(OUT[1])]: keyed(DEVS[1].recipientPk, 666n, PLAYER) });
  const r = await check({ port: withKey, entry: entry({ playerPubkey: PLAYER }) });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.rows.map((x) => x.senderOnContract), [true, true]);
  const mixed = federation({ [at(OUT[0])]: keyed(DEVS[0].recipientPk, 1334n, PLAYER), [at(OUT[1])]: idOf(donationContractFields({ recipientPk: DEVS[1].recipientPk, amountMsat: 666n })) });
  const m = await check({ port: mixed, entry: entry({ playerPubkey: PLAYER }) });
  assert.equal(m.ok, true, m.why);
  assert.deepEqual(m.rows.map((x) => x.senderOnContract), [true, false]);
  const zeros = await check({ entry: entry({ playerPubkey: PLAYER }) });
  assert.equal(zeros.ok, true, zeros.why);
  assert.deepEqual(zeros.rows.map((x) => x.senderOnContract), [false, false]);
  const other = federation({ [at(OUT[0])]: keyed(DEVS[0].recipientPk, 1334n, b32(0x66)), [at(OUT[1])]: keyed(DEVS[1].recipientPk, 666n, PLAYER) });
  const o = await check({ port: other, entry: entry({ playerPubkey: PLAYER }) });
  assert.equal(o.ok, false, 'an output naming another sender was taken');
  assert.match(o.why, /is not 1334 msat to key 02a1/);
});
