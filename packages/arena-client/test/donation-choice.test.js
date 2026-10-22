// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLAYER'S DONATION, CHOSEN ON THE PAGE AND WRITTEN INTO THE ENTRY (M3.2
// item 6e, commit 2; §22A, ruled 2026-09-13).
//
// Measured before this: `entryFor` took no donation and wrote `donationMsat:
// 0n` on every entry; the page had no donation prompt and no confirm; its lock
// amount assumed 0 (98000 msat for a 2% donor, where the signer node's check wants
// 96000). The signer node's door already took a 2% donor's entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { entryFor } from '../src/join.js';
import { lockAmountMsat } from '../src/page-lock.js';
import { donationChoice, chooseDonation, DONATION_CONFIRM_BPS } from '../src/donation-choice.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { feeMatchesEntry, entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { TRUCK_68E2_HASH } from '../../nextblock/plugin/truck-cores.js';   // the truck versions 1-4 name (kanban #523: the tree now builds a5c5766a)

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const STAKE = 100000n;
// THE NET OF A STAKE WITH NO DONATION: the stake less the node fee (5%, §0A.8) - every net below is this, less
// the donation
const NET0 = STAKE - entryFeeMsat(STAKE);
const paying = { id: b32(0x21), stakeMsat: STAKE, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: fromHex(TRUCK_68E2_HASH), federationId: TEST_FEDERATION_ID };
const free = { id: b32(0x22), stakeMsat: 0n, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1) };
// A PAYING ROUND NAMES ITS FEDERATION, AND ITS ENTRY ITS LOCK (RULED 2026-09-24, the enum slice's fifth cut, as
// join.test's fixtures): this paying fixture used to be hold-shaped - a stake and no federation - and entryFor now refuses
// that shape. It keeps measuring what it measured, on a real FEDERATION entry: an attested claim key and a stake lock with
// a non-zero outpoint, paying to the dealt stake's point where one is dealt.
const lockedFor = (stakePoint = Uint8Array.of(2, ...new Uint8Array(32).fill(0x6c))) => ({
  claimKey: { ok: true, ref: new Uint8Array(32).fill(0x9a) },
  stakeLock: { outpoint: { txid: new Uint8Array(32).fill(0xd8), outIdx: 0 }, fields: { paymentImage: { kind: 'point', bytes: stakePoint } } },
});
const seed = b32(0x5e);
const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
const counted = (answer) => { const f = (msg) => { f.asked.push(msg); return answer; }; f.asked = []; return f; };

test('nothing typed, a cancel or 0 donates nothing', () => {
  for (const typed of [null, undefined, '', '  ', '0', '0%']) {
    const c = donationChoice({ typed, stakeMsat: STAKE });
    assert.equal(c.ok, true, String(typed));
    assert.equal(c.donationMsat, 0n);
    assert.equal(c.netMsat, NET0);
  }
});

test('a percent of the stake, out of it and not on top', () => {
  const two = donationChoice({ typed: '2', stakeMsat: STAKE });
  assert.deepEqual([two.bps, two.donationMsat, two.netMsat], [200, 2000n, NET0 - 2000n]);
  assert.equal(donationChoice({ typed: '2.5%', stakeMsat: STAKE }).donationMsat, 2500n);
  assert.equal(donationChoice({ typed: '0,5', stakeMsat: STAKE }).donationMsat, 500n);
  const five = counted(false);
  const atCap = donationChoice({ typed: '5', stakeMsat: STAKE, confirm: five });
  assert.equal(atCap.donationMsat, 5000n);
  assert.equal(five.asked.length, 0, '5% itself is not asked a second time');
});

test('above 5% needs a second confirmation; one answer never writes more than 5%', () => {
  assert.equal(DONATION_CONFIRM_BPS, 500);
  const no = counted(false);
  const refused = donationChoice({ typed: '6', stakeMsat: STAKE, confirm: no });
  assert.equal(refused.ok, false);
  assert.equal(refused.donationMsat, undefined, 'nothing is written');
  assert.equal(no.asked.length, 1);
  assert.match(no.asked[0], /more than 5%/);
  const yes = counted(true);
  const confirmed = donationChoice({ typed: '6', stakeMsat: STAKE, confirm: yes });
  assert.deepEqual([confirmed.ok, confirmed.donationMsat], [true, 6000n]);
  // EVERY PERCENT FROM 5.01 TO 98: without the second yes, none stands
  let stood = 0;
  for (let bps = 501; bps <= 9800; bps += 7) {
    const typed = `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}`;
    if (donationChoice({ typed, stakeMsat: STAKE }).ok) stood++;
    if (donationChoice({ typed, stakeMsat: STAKE, confirm: () => false }).ok) stood++;
  }
  assert.equal(stood, 0, `${stood} answers above 5% stood without a second confirmation`);
});

test('the fee must still fit, and a typo is not a number', () => {
  // with the 5% fee, 95% is the most a donation may be: 96% and the fee come to more than the stake
  const tooMuch = donationChoice({ typed: '96', stakeMsat: STAKE, confirm: () => true });
  assert.equal(tooMuch.ok, false);
  assert.match(tooMuch.why, /cannot come to more than it/);
  assert.equal(donationChoice({ typed: '95', stakeMsat: STAKE, confirm: () => true }).donationMsat, NET0);
  for (const typed of ['abc', '-1', '101', '2.555', '1e2']) assert.equal(donationChoice({ typed, stakeMsat: STAKE, confirm: () => true }).ok, false, typed);
});

test('chosen once per round and kept, so a reload writes the same donation', () => {
  const storage = memory();
  const ask = counted('2');
  const first = chooseDonation({ roundIdHex: 'aa', stakeMsat: STAKE, ask, confirm: () => false, storage });
  assert.deepEqual([first.ok, first.bps, first.donationMsat], [true, 200, 2000n]);
  assert.equal(ask.asked.length, 1);
  const again = chooseDonation({ roundIdHex: 'aa', stakeMsat: STAKE, ask, confirm: () => false, storage });
  assert.deepEqual([again.donationMsat, again.kept], [2000n, true]);
  assert.equal(ask.asked.length, 1, 'a kept choice is not asked again');
  // another round asks again; a cancel is none, and is kept too
  const cancel = counted(null);
  assert.equal(chooseDonation({ roundIdHex: 'bb', stakeMsat: STAKE, ask: cancel, storage }).donationMsat, 0n);
  assert.equal(storage.m.get('arena.donation.bb'), '0');
});

test('an unconfirmed answer above 5% is asked again, and three that do not stand are none', () => {
  let n = 0;
  const answers = ['7', '2'];
  const ask = () => answers[n++];
  const c = chooseDonation({ roundIdHex: 'cc', stakeMsat: STAKE, ask, confirm: () => false, storage: memory() });
  assert.deepEqual([c.bps, c.donationMsat], [200, 2000n]);
  const junk = counted('abc');
  const none = chooseDonation({ roundIdHex: 'dd', stakeMsat: STAKE, ask: junk, storage: memory() });
  assert.deepEqual([none.donationMsat, junk.asked.length], [0n, 3]);
});

test('the entry carries the donation into the field the payout table reads, and the lock holds the net', () => {
  const before = entryFor(paying, { seed, curve: feldmanGroup, random: rand, ...lockedFor() });
  assert.equal(before.donationMsat, 0n, 'no donation chosen is 0, as before');
  const donor = entryFor(paying, { seed, curve: feldmanGroup, random: rand, donationMsat: 2000n, ...lockedFor() });
  assert.equal(donor.donationMsat, 2000n);
  assert.equal(donor.feeMsat, entryFeeMsat(STAKE));
  assert.equal(feeMatchesEntry(donor).ok, true, 'the signer node s own rule takes it');
  assert.equal(netStakeMsat(donor), NET0 - 2000n);
  assert.equal(lockAmountMsat(paying, donor.donationMsat), NET0 - 2000n, 'a donor s lock holds the net the signer node wants');
  assert.equal(lockAmountMsat(paying), NET0);
  assert.throws(() => entryFor(paying, { seed, curve: feldmanGroup, random: rand, donationMsat: NET0 + 1n, ...lockedFor() }), /cannot come to more than it/);
  assert.throws(() => entryFor(paying, { seed, curve: feldmanGroup, random: rand, donationMsat: 2000, ...lockedFor() }), /BigInt/);
  assert.throws(() => entryFor(free, { seed, curve: feldmanGroup, random: rand, donationMsat: 1n }), /cannot come to more than it/,
    'a free round has nothing to donate out of');
});
