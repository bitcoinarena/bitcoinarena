// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// DAILY VESTING (§27A.4.12026-10-16: "a new person gets 10% in 12 months ... While a new donation dev is vesting
// the old configuration still applies ... the other old devs get the reminder proportionally"; "it can also mean that an existing
// stakeholder can get additional shares by adding vesting"; "vesting is daily").
import test from 'node:test';
import assert from 'node:assert/strict';
import { vestedShares, VESTING_DAY_BLOCKS, encodeDonationSet, decodeDonationSet, donationSetId, donationSetStands } from '../src/donation.js';

const key = (n) => Uint8Array.from([0x02, ...new Uint8Array(32).fill(n)]);
const START = 160000;
const NEWCOMER = [{ recipientPk: key(1), shareBps: 6000, label: 'dev a' }, { recipientPk: key(2), shareBps: 4000, label: 'dev b' },
  { recipientPk: key(3), shareBps: 0, label: 'dev c', vesting: { targetBps: 1000, startHeight: START, days: 365 } }];
const at = (day) => vestedShares(NEWCOMER, START + day * VESTING_DAY_BLOCKS).map((r) => r.shareBps);

test('a newcomer vesting to 10 % over a year: nothing before its start, a step each day, 10 % at the end; the old 60:40 split the rest', () => {
  assert.deepEqual(at(-1), [6000, 4000, 0]);
  assert.deepEqual(at(0), [6000, 4000, 0]);
  assert.deepEqual(at(1), [5999, 3999, 2], 'day one: 1000 / 365 = 2 bps');
  assert.deepEqual(at(30), [5951, 3967, 82], 'about a month: ~0.82 %, the others 60:40 of the rest');
  assert.deepEqual(at(365), [5400, 3600, 1000], 'a year: 10 %, the others 54 / 36 (60:40 of 90 %)');
  assert.deepEqual(at(800), [5400, 3600, 1000], 'and no further');
  for (const d of [1, 30, 182, 365]) assert.equal(at(d).reduce((t, x) => t + x, 0), 10000);
});

test('an existing developer vesting upward: 20 % to 30 % over 12 months, the other keeps the rest', () => {
  const up = [{ recipientPk: key(1), shareBps: 8000, label: 'dev a' }, { recipientPk: key(2), shareBps: 2000, label: 'dev b', vesting: { targetBps: 3000, startHeight: START, days: 365 } }];
  assert.deepEqual(vestedShares(up, START + 365 * VESTING_DAY_BLOCKS).map((r) => r.shareBps), [7000, 3000]);
  assert.deepEqual(vestedShares(up, START + 73 * VESTING_DAY_BLOCKS).map((r) => r.shareBps), [7800, 2200]);
});

test('a vesting set has its own bytes and id; a set without vesting keeps its id; a set that cannot vest does not stand', () => {
  const plain = NEWCOMER.slice(0, 2);
  const bytes = encodeDonationSet(NEWCOMER);
  assert.deepEqual(decodeDonationSet(bytes)[2].vesting, { targetBps: 1000, startHeight: START, days: 365 });
  assert.notEqual(Buffer.from(donationSetId(NEWCOMER)).toString('hex'), Buffer.from(donationSetId(plain)).toString('hex'));
  assert.equal(decodeDonationSet(encodeDonationSet(plain))[0].vesting, undefined);
  assert.equal(vestedShares(plain, 1), plain, 'no vesting: the set as it is');
  assert.equal(donationSetStands([{ recipientPk: key(1), shareBps: 10000, label: 'a', vesting: { targetBps: 5000, startHeight: 1, days: 10 } }]).ok, false,
    'no one else to hand the rest to');
  assert.equal(donationSetStands([...NEWCOMER.slice(0, 2), { ...NEWCOMER[2], vesting: { targetBps: 1000, startHeight: START, days: 0 } }]).ok, false);
});

test('a vesting split approved by the developers is the set in force, and pays its day\'s shares', async () => {
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const { donationProposalId, donationApprovalDigest, approvedDonationSets } = await import('../src/donation-vote.js');
  const { donationSetInForce } = await import('../src/authority.js');
  const sk = (n) => { const b = new Uint8Array(32); b[31] = n; b[0] = 4; return b; };
  const pk = (n) => secp256k1.getPublicKey(sk(n), true);
  const NET = new Uint8Array(32).fill(6);
  const parent = [{ recipientPk: pk(1), shareBps: 6000, label: 'dev a' }, { recipientPk: pk(2), shareBps: 4000, label: 'dev b' }];
  const recipients = [...parent, { recipientPk: pk(3), shareBps: 0, label: 'dev c', vesting: { targetBps: 1000, startHeight: START, days: 365 } }];
  const p0 = { networkId: NET, serial: 4n, parentSetId: donationSetId(parent), proposer: pk(1), recipients };
  const p = { ...p0, signature: secp256k1.sign(donationProposalId(p0), sk(1)) };
  const a0 = { proposalId: donationProposalId(p0), atHeight: START - 10, accept: true, signer: pk(1) };
  const a = { ...a0, signature: secp256k1.sign(donationApprovalDigest(a0), sk(1)) };
  const { sets } = await approvedDonationSets({ networkId: NET, known: [{ networkId: NET, serial: 3n, validFrom: 1, recipients: parent }], ballots: [{ proposal: p, approvals: [a] }],
    verifySecp256k1: (s, d, k) => secp256k1.verify(s, d, k) });
  const f = donationSetInForce({ networkId: NET, authority: new Uint8Array(32), recovery: new Uint8Array(32).fill(1), sets: [], height: START + 30 * VESTING_DAY_BLOCKS, verify: () => false, approved: sets });
  assert.equal(f.ok, true);
  assert.deepEqual(vestedShares(f.recipients, START + 30 * VESTING_DAY_BLOCKS).map((r) => r.shareBps), [5951, 3967, 82]);
});
