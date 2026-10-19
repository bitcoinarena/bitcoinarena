// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DONATION LINES THE PLAYER READS - donation-pay.js on its own (surface 1 of "The player's money lines",
// plan comment 202, accepted 2026-10-05): every state of a donation as the page paints it (index.html: the wallet panel's
// #arena-donation, and the line read back from the tab's notes after a reload), by its exact words.
//
// Measured before this file, on today's module: a donation paid INSIDE THE STAKE LOCK - every key-set round, testnet4 -
// is state 'paid', inLock, with no Lightning shares, and the line read "Donation not paid: paid in the federation, in the
// same transaction as the stake". The player read "not paid" for money that was paid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { donationRecipientsLine, donationPaidState, donationPaidLine, donationNotedState, notedDonationForLink, noteDonationShare, donationPaidKey } from '../src/donation-pay.js';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';
import { playerFor, TAB_SEED_KEY } from '../src/join.js';
import * as curve from '../src/page-curve.js';

const IN_LOCK = 'paid in the federation, in the same transaction as the stake';
const A = lnurlFor('https://a.example/lnurlp/dev'), B = lnurlFor('https://b.example/lnurlp/ops'), C = lnurlFor('https://c.example/lnurlp/x');
const SET = { recipients: [{ lnurl: A, shareBps: 6667 }, { lnurl: B, shareBps: 3333 }] };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };

// THE FIRST CHECK (plan 202): a donation paid in the stake lock reads as paid, with its amount.
test('a donation paid inside the stake lock reads as paid, naming its 2 sat - not "Donation not paid"', () => {
  const p = donationPaidState(SET, { inLock: true, paidMsat: 2000n, why: IN_LOCK });
  const line = donationPaidLine(p);
  assert.doesNotMatch(line, /^Donation not paid/, `the player reads: ${line}`);
  assert.match(line, /2 sat/);
  assert.match(line, /\bpaid\b/);
  assert.equal(line, `Donation: 2 sat paid, ${IN_LOCK}`);
  assert.equal(donationPaidLine(donationPaidState(SET, { inLock: true, paidMsat: 1500n, why: IN_LOCK })), `Donation: 1500 msat paid, ${IN_LOCK}`);
});

test('every state\'s line by its words: none, paying, paid, part, unpaid, unknown, error', () => {
  assert.equal(donationPaidLine(null), '');
  assert.equal(donationPaidLine({ state: 'none' }), '');
  assert.equal(donationPaidLine({ state: 'paying' }), 'Donation: paying each recipient its share…');
  assert.equal(donationPaidState(SET, null), null);
  const paid = donationPaidState(SET, { ok: true, paid: [{ lnurl: A, amountMsat: 1334n }, { lnurl: B, amountMsat: 666n }] });
  assert.deepEqual({ state: paid.state, paid: paid.paidMsat, unpaid: paid.unpaidMsat, unknown: paid.unknownMsat }, { state: 'paid', paid: 2000n, unpaid: 0n, unknown: 0n });
  assert.equal(donationPaidLine(paid), 'Donation: 1334 msat paid to https://a.example/lnurlp/dev · 666 msat paid to https://b.example/lnurlp/ops');
  const part = donationPaidState(SET, { ok: false, paid: [{ lnurl: A, amountMsat: 1334n }], failed: [{ lnurl: B, amountMsat: 666n, why: 'no route' }] });
  assert.equal(part.state, 'part');
  assert.equal(donationPaidLine(part), 'Donation: 1334 msat paid to https://a.example/lnurlp/dev · 666 msat UNPAID to https://b.example/lnurlp/ops (no route) · 666 msat unpaid stays in your wallet, sent nowhere else');
  const unpaid = donationPaidState(SET, { ok: false, failed: [{ lnurl: A, amountMsat: 2000n, why: 'invoice refused' }] });
  assert.equal(unpaid.state, 'unpaid');
  assert.equal(donationPaidLine(unpaid), 'Donation: 2 sat UNPAID to https://a.example/lnurlp/dev (invoice refused) · 2 sat unpaid stays in your wallet, sent nowhere else');
  const unknown = donationPaidState(SET, { ok: false, unknown: [{ lnurl: B, amountMsat: 666n, why: 'the wallet never answered' }] });
  assert.deepEqual({ state: unknown.state, unknownMsat: unknown.unknownMsat }, { state: 'unknown', unknownMsat: 666n });
  assert.equal(donationPaidLine(unknown), 'Donation: 666 msat outcome unknown to https://b.example/lnurlp/ops (the wallet never answered)');
  const none = donationPaidState(SET, { ok: true, why: 'a 0% donor pays nothing' });
  assert.equal(none.state, 'none');
  assert.equal(donationPaidLine(none), '');
  const error = donationPaidState(SET, { ok: false, why: 'the set could not be read' });
  assert.equal(error.state, 'error');
  assert.equal(donationPaidLine(error), 'Donation not paid: the set could not be read');
  assert.equal(donationPaidLine({ state: 'error' }), 'Donation not paid: no answer');
});

test('amounts read in sat when whole, in msat otherwise; shares in the set\'s order; a share for no recipient of the set is dropped', () => {
  const said = { ok: true, paid: [{ lnurl: B, amountMsat: 3000n }, { lnurl: C, amountMsat: 9000n }, { lnurl: A, amountMsat: 6001n }] };
  const p = donationPaidState(SET, said);
  assert.deepEqual(p.shares.map((s) => [s.url, s.shareBps, s.amountMsat]), [['https://a.example/lnurlp/dev', 6667, 6001n], ['https://b.example/lnurlp/ops', 3333, 3000n]]);
  assert.equal(p.paidMsat, 9001n, 'the dropped share was counted');
  assert.equal(donationPaidLine(p), 'Donation: 6001 msat paid to https://a.example/lnurlp/dev · 3 sat paid to https://b.example/lnurlp/ops');
  // an lnurl that is not bech32 is shown as it is
  const raw = donationPaidState({ recipients: [{ lnurl: 'not-an-lnurl', shareBps: 10000 }] }, { ok: true, paid: [{ lnurl: 'not-an-lnurl', amountMsat: 1000n }] });
  assert.equal(raw.shares[0].url, 'not-an-lnurl');
  assert.deepEqual(donationPaidState(undefined, { ok: true, paid: [{ lnurl: A, amountMsat: 1000n }] }).state, 'none');
});

test('the notes the tab saved read back after a reload: paid, unpaid, asked -> outcome unknown; unreadable notes skipped; nothing noted is null', () => {
  const storage = mem();
  const whose = { roundId: new Uint8Array(32).fill(1), playerPubkey: new Uint8Array(32).fill(2) };
  assert.equal(donationNotedState(storage, whose), null);
  assert.equal(noteDonationShare(storage, whose, A, { amountMsat: 1334n, state: 'paid' }), true);
  assert.equal(noteDonationShare(storage, whose, B, { amountMsat: 666n, state: 'asked' }), true);
  const p = donationNotedState(storage, whose);
  assert.deepEqual({ state: p.state, from: p.from, paid: p.paidMsat, unknown: p.unknownMsat }, { state: 'part', from: 'notes', paid: 1334n, unknown: 666n });
  assert.equal(donationPaidLine(p), 'Donation: 1334 msat paid to https://a.example/lnurlp/dev · 666 msat outcome unknown to https://b.example/lnurlp/ops '
    + '(this tab asked its wallet for it before a reload and never heard the answer, so it is not asked again)');
  noteDonationShare(storage, whose, B, { amountMsat: 666n, state: 'unpaid', why: 'no route' });
  assert.equal(donationNotedState(storage, whose).state, 'part');
  assert.match(donationPaidLine(donationNotedState(storage, whose)), /666 msat UNPAID to https:\/\/b\.example\/lnurlp\/ops \(no route\) · 666 msat unpaid stays in your wallet/);
  // an unpaid note without a reason, an unreadable amount and an unknown state are each handled
  noteDonationShare(storage, whose, B, { amountMsat: 666n, state: 'unpaid' });
  assert.match(donationPaidLine(donationNotedState(storage, whose)), /UNPAID to https:\/\/b\.example\/lnurlp\/ops \(unpaid\)/);
  const raw = JSON.parse(storage.getItem(donationPaidKey(whose)));
  raw.shares[C] = { amountMsat: 'x', state: 'paid' };
  raw.shares['lnurl-other'] = { amountMsat: '5', state: 'sideways' };
  storage.setItem(donationPaidKey(whose), JSON.stringify(raw));
  assert.equal(donationNotedState(storage, whose).shares.length, 2, 'an unreadable note was counted');
  // only unreadable notes: nothing to show
  storage.setItem(donationPaidKey(whose), JSON.stringify({ shares: { [C]: { amountMsat: 'x', state: 'paid' } } }));
  assert.equal(donationNotedState(storage, whose), null);
});

test('notedDonationForLink: a ?round= link with this tab\'s seed finds the notes; a bad link, no seed or no storage is null', () => {
  const storage = mem();
  const seed = new Uint8Array(32).fill(7);
  const round = new Uint8Array(32).fill(0x31);
  const hexOf = (b) => Buffer.from(b).toString('hex');
  storage.setItem(TAB_SEED_KEY, hexOf(seed));
  const me = playerFor({ id: round }, { seed, curve });
  noteDonationShare(storage, { roundId: me.roundId, playerPubkey: me.pubkey }, A, { amountMsat: 2000n, state: 'paid' });
  const got = notedDonationForLink(`?round=${hexOf(round)}&play=1`, { storage, curve });
  assert.deepEqual({ state: got.state, paid: got.paidMsat, from: got.from }, { state: 'paid', paid: 2000n, from: 'notes' });
  assert.equal(notedDonationForLink(`?round=${hexOf(round).toUpperCase()}`, { storage, curve }).state, 'paid', 'an upper-case link');
  assert.equal(notedDonationForLink(`?round=${hexOf(new Uint8Array(32).fill(0x32))}`, { storage, curve }), null, 'another round found these notes');
  assert.equal(notedDonationForLink('?round=1234', { storage, curve }), null);
  assert.equal(notedDonationForLink('', { storage, curve }), null);
  assert.equal(notedDonationForLink(`?round=${hexOf(round)}`, { storage: null, curve }), null);
  assert.equal(notedDonationForLink(`?round=${hexOf(round)}`, { storage: mem(), curve }), null, 'no seed');
  assert.equal(notedDonationForLink(`?round=${hexOf(round)}`, { storage, curve: undefined }), null, 'no curve');
  assert.equal(notedDonationForLink(`?round=${hexOf(round)}`, { storage: { getItem: () => { throw new Error('blocked'); } }, curve }), null);
});

test('the recipients line: each share in percent to its URL, a key in the federation by label and key, no set named', () => {
  assert.equal(donationRecipientsLine(SET), 'Recipients: 66.67% to https://a.example/lnurlp/dev, 33.33% to https://b.example/lnurlp/ops');
  const keys = { recipients: [{ recipientPk: new Uint8Array(32).fill(0xab), shareBps: 5000, label: 'dev A' }, { recipientPk: new Uint8Array(32).fill(0xcd), shareBps: 5000 },
    { lnurl: 'not-an-lnurl', shareBps: 0 }] };
  assert.equal(donationRecipientsLine(keys), "Recipients: 50.00% to dev A (key abababababab…, in the round's federation), "
    + "50.00% to a dev (key cdcdcdcdcdcd…, in the round's federation), 0.00% to not-an-lnurl");
  assert.equal(donationRecipientsLine(undefined), 'no donation set');
  assert.equal(donationRecipientsLine({}), 'no donation set');
});
