// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// DONATIONS IN THE FEDERATION, THE FORMATS (2026-10-03, FEDERATION.md "Donations in the federation"): a donation
// set of recipient keys and shares, and an Entry Contract that names where its lock transaction paid each key. Every set
// and every entry already published keeps its bytes and its id.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeDonationSet, decodeDonationSet, donationSetId, donationSetStands, splitDonation, donationSetPaysKeys,
  donationOutputsExpected, RECIPIENT_LABEL_MAX,
} from '../src/donation.js';
import { encodeDonationSetBody, decodeDonationSetBody, donationSetBodyId } from '../src/authority.js';
import { encodeEntryContract, decodeEntryContract, entryId } from '../src/contracts.js';
import { TESTNET4_DONATION_SET } from '../src/testnet4-donation-set.js';
import { TEST_DONATION_SET_TESTNET4 } from '../src/test-donation-sets.js';
import { TYPE_DONATION_SET_KEYS } from '../src/constants.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const key = (prefix, fill) => Uint8Array.of(prefix, ...new Uint8Array(32).fill(fill));
const DEVS = [
  { recipientPk: key(0x02, 0xa1), shareBps: 6667, label: 'dev a' },
  { recipientPk: key(0x03, 0xb2), shareBps: 3333, label: 'dev b' },
];

test('a set of keys encodes under its own type byte, decodes to the same keys, shares and labels, in order', () => {
  const bytes = encodeDonationSet(DEVS);
  assert.equal(bytes[0], TYPE_DONATION_SET_KEYS);
  const back = decodeDonationSet(bytes);
  assert.deepEqual(back.map((r) => [toHex(r.recipientPk), r.shareBps, r.label]), DEVS.map((r) => [toHex(r.recipientPk), r.shareBps, r.label]));
  assert.ok(donationSetPaysKeys(back));
  // the order is the set (the remainder goes to the first): reordered is another set
  assert.notEqual(toHex(donationSetId(DEVS)), toHex(donationSetId([DEVS[1], DEVS[0]])));
});

test('every LNURL set already published keeps its id', () => {
  assert.equal(toHex(donationSetId(TESTNET4_DONATION_SET.recipients)).slice(0, 16), '1229dee8e05404b3');
  assert.equal(toHex(donationSetId(TEST_DONATION_SET_TESTNET4.recipients)).slice(0, 16), 'efffd27fc7437061');
  assert.equal(donationSetPaysKeys(TESTNET4_DONATION_SET.recipients), false);
});

test('a set of keys that does not stand is refused, by name', () => {
  const refused = (rs, why) => { const s = donationSetStands(rs); assert.equal(s.ok, false); assert.match(s.why, why); assert.throws(() => encodeDonationSet(rs)); };
  refused([DEVS[0], { lnurl: 'lnurl1abc', shareBps: 3333 }], /never both/);
  refused([{ ...DEVS[0], recipientPk: key(0x04, 1) }, DEVS[1]], /compressed secp256k1/);
  refused([{ ...DEVS[0], recipientPk: new Uint8Array(32).fill(2) }, DEVS[1]], /compressed secp256k1/);
  refused([DEVS[0], { ...DEVS[1], recipientPk: DEVS[0].recipientPk }], /listed twice/);
  refused([DEVS[0], { ...DEVS[1], shareBps: 3332 }], /sum to 9999/);
  refused([{ ...DEVS[0], label: 'x'.repeat(RECIPIENT_LABEL_MAX + 1) }, DEVS[1]], /label/);
  refused([{ ...DEVS[0], label: undefined }, DEVS[1]], /label/);
});

test('bytes of a set of keys that does not stand do not decode', () => {
  const bytes = encodeDonationSet(DEVS);
  const bad = bytes.slice(); bad[5] = 0x04;                      // the first key's prefix
  assert.throws(() => decodeDonationSet(bad), /compressed secp256k1/);
  assert.throws(() => decodeDonationSet(Uint8Array.of(...bytes, 0)), /trailing bytes/);
});

test('the signed publication carries a set of keys like a set of LNURLs', () => {
  const body = { networkId: b32(0x4e), serial: 3n, validFrom: 155000, recipients: DEVS };
  const back = decodeDonationSetBody(encodeDonationSetBody(body));
  assert.equal(back.serial, 3n);
  assert.deepEqual(back.recipients.map((r) => r.label), ['dev a', 'dev b']);
  assert.equal(toHex(donationSetBodyId(back)), toHex(donationSetBodyId(body)));
});

test('a donation splits over the keys exactly: 2000 msat is 1334 + 666, the remainder to the first', () => {
  const s = splitDonation({ donationMsat: 2000n, recipients: DEVS });
  assert.equal(s.owed, true);
  assert.deepEqual(s.shares.map((sh) => [toHex(sh.recipientPk).slice(0, 4), sh.label, sh.amountMsat]), [['02a1', 'dev a', 1334n], ['03b2', 'dev b', 666n]]);
  assert.equal(s.shares[0].lnurl, undefined);
});

const lockedEntry = (more = {}) => ({
  roundId: b32(0x01), playerPubkey: b32(0x02), sessionPubkey: b32(0x03), stakeCommitment: b32(0x04),
  stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 2000n, joinTick: 0, worldSecret: b32(0x05),
  vssSharesRef: b32(0x06), stakePoint: new Uint8Array(33).fill(0x02),
  feePreimage: b32(0x07), stakeLockOutpoint: { txid: b32(0x08), outIdx: 0n },
  feeLockOutpoint: { txid: b32(0x08), outIdx: 1n }, claimKeyAttestationRef: b32(0x09), ...more,
});
const PAID = [{ txid: b32(0x08), outIdx: 2n }, { txid: b32(0x08), outIdx: 3n }];

test('an entry with no donation outpoints is the entry it always was: same bytes, same id', () => {
  const e = lockedEntry();
  assert.equal(toHex(encodeEntryContract({ ...e, donationOutpoints: [] })), toHex(encodeEntryContract(e)));
  const back = decodeEntryContract(encodeEntryContract(e));
  assert.equal(back.donationOutpoints, undefined);
  assert.equal(toHex(entryId(back)), toHex(entryId(e)));
});

test('an entry names its donation outpoints in its signed bytes: they round-trip and change its id', () => {
  const e = lockedEntry({ donationOutpoints: PAID });
  const back = decodeEntryContract(encodeEntryContract(e));
  assert.deepEqual(back.donationOutpoints.map((o) => [toHex(o.txid).slice(0, 4), o.outIdx]), [['0808', 2n], ['0808', 3n]]);
  assert.equal(toHex(encodeEntryContract(back)), toHex(encodeEntryContract(e)));
  assert.notEqual(toHex(entryId(e)), toHex(entryId(lockedEntry())));
  assert.notEqual(toHex(entryId(e)), toHex(entryId(lockedEntry({ donationOutpoints: [PAID[1], PAID[0]] }))));
  // an empty list written by hand is not the entry's one encoding
  assert.throws(() => decodeEntryContract(Uint8Array.of(...encodeEntryContract(lockedEntry()), 0, 0)), /empty list/);
});

test('the outputs an entry must name: one per share above 0 msat, in the set\'s order, each to its key for its share', () => {
  const ok = donationOutputsExpected(lockedEntry({ donationOutpoints: PAID }), DEVS);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.outputs.map((o) => [o.outpoint.outIdx, toHex(o.recipientPk).slice(0, 4), o.amountMsat]), [[2n, '02a1', 1334n], [3n, '03b2', 666n]]);
  assert.match(donationOutputsExpected(lockedEntry({ donationOutpoints: [PAID[0]] }), DEVS).why, /names 1 donation output\(s\) and .* owes 2/);
  assert.match(donationOutputsExpected(lockedEntry(), DEVS).why, /names 0 donation output/);
  // nothing donated: no output, and one named is refused
  assert.deepEqual(donationOutputsExpected(lockedEntry({ donationMsat: 0n }), DEVS).outputs, []);
  assert.equal(donationOutputsExpected(lockedEntry({ donationMsat: 0n, donationOutpoints: PAID }), DEVS).ok, false);
  // 1 msat: the second share is 0 and names no output
  const tiny = donationOutputsExpected(lockedEntry({ donationMsat: 1n, donationOutpoints: [PAID[0]] }), DEVS);
  assert.equal(tiny.ok, true); assert.deepEqual(tiny.outputs.map((o) => o.amountMsat), [1n]);
  // an LNURL round: donation outputs in the federation are not its set's
  assert.match(donationOutputsExpected(lockedEntry({ donationOutpoints: PAID }), TESTNET4_DONATION_SET.recipients).why, /pays LNURLs/);
  assert.equal(donationOutputsExpected(lockedEntry(), TESTNET4_DONATION_SET.recipients).ok, true);
});

test('testnet4\'s set of keys is signed by testnet4\'s donation authority, serial 3, two dev keys at 6667 / 3333', async () => {
  const { TESTNET4_DONATION_SET_KEYS: S } = await import('../src/testnet4-donation-set-keys.js');
  const { donationSetSignedBy } = await import('../src/authority.js');
  const { donationKeysForNetworkId } = await import('../src/donation-keys.js');
  const { NETWORK_ID_TESTNET4 } = await import('../src/genesis-ids.js');
  const { verify, createPublicKey } = await import('node:crypto');
  const keys = donationKeysForNetworkId(NETWORK_ID_TESTNET4);
  const ed = (sig, msg, k) => verify(null, msg, createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(k)]), format: 'der', type: 'spki' }), sig);
  assert.equal(donationSetSignedBy(S, { authority: keys.authority, verify: ed }).ok, true);
  assert.equal(S.serial, 3n);
  assert.equal(toHex(S.networkId), toHex(NETWORK_ID_TESTNET4));
  assert.deepEqual(S.recipients.map((r) => [r.label, r.shareBps, r.recipientPk.length]), [['dev a', 6667, 33], ['dev b', 3333, 33]]);
  assert.ok(donationSetPaysKeys(S.recipients));
});
