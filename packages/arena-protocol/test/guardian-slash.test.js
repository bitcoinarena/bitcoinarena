// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GONE GUARDIAN: SLASHED OR DEPARTED, AND WHO ITS BOND PAYS (§23A.5, FEDERATION.md rehearsal 14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardianSlashStands, guardianSlashPayees } from '../src/federation-slash.js';
import { escrowSplitSpend } from '../src/arbitration-tx.js';

const k = (n) => Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 0));
const peer = Uint8Array.from({ length: 33 }, (_, i) => (i === 0 ? 2 : 9));
const proof = { ok: true, peerKey: peer, sinceHeight: 500, signers: 3 };

test('an absence with no notice is abandonment, and is slashed', () => {
  const s = guardianSlashStands({ proof });
  assert.deepEqual([s.ok, s.slash, s.kind], [true, true, 'ABANDONED']);
});

test('gone at or after a standing notice\'s leave_after is the departure: not slashed; stopping before it is abandonment', () => {
  const at = guardianSlashStands({ proof, departure: { ok: true, peerKey: peer, leaveAfterHeight: 500 } });
  assert.deepEqual([at.slash, at.kind], [false, 'DEPARTED']);
  const early = guardianSlashStands({ proof, departure: { ok: true, peerKey: peer, leaveAfterHeight: 501 } });
  assert.deepEqual([early.slash, early.kind], [true, 'ABANDONED']);
  // a notice that does not stand (too short, unsigned) protects nobody
  assert.equal(guardianSlashStands({ proof, departure: { ok: false, why: 'short' } }).slash, true);
  assert.equal(guardianSlashStands({ proof: { ok: false, why: '2 guardian(s) attest the absence, the threshold is 3' } }).ok, false);
  assert.equal(guardianSlashStands({ proof, departure: { ok: true, peerKey: new Uint8Array(33), leaveAfterHeight: 1 } }).ok, false);
});

test('75 % evenly to the census less the federation\'s guardians, 25 % to the donation set, summing to the amount', () => {
  const record = { guardians: [1, 2, 3, 4].map((n) => ({ nodePubkey: k(n) })) };
  const p = guardianSlashPayees({ amountSats: 99_997_000n, censusNodes: [1, 2, 3, 4, 5, 6, 7].map(k), record });
  assert.equal(p.ok, true);
  assert.equal(p.nodes.length, 3, 'the four guardians are left out of seven');
  assert.equal(p.developers, 99_997_000n - (99_997_000n * 75n) / 100n);
  assert.equal(p.nodes.reduce((a, n) => a + n.sats, 0n) + p.developers, 99_997_000n);
  assert.ok(p.nodes.every((n) => !['01', '02', '03', '04'].includes(n.key.slice(0, 2))));
  assert.equal(guardianSlashPayees({ amountSats: 1000n, censusNodes: [1, 2].map(k), record }).ok, false);
});

test('the escrow split spends exactly the escrow, less the fee, and refuses dust', () => {
  const escrow = { txid: new Uint8Array(32), vout: 0, value: 10_000n, script: new Uint8Array(34) };
  const s = new Uint8Array(34).fill(1);
  assert.equal(escrowSplitSpend({ escrow, payees: [{ script: s, sats: 6000n }, { script: s, sats: 3000n }], feeSats: 1000n }).ok, true);
  assert.equal(escrowSplitSpend({ escrow, payees: [{ script: s, sats: 6000n }, { script: s, sats: 3001n }], feeSats: 1000n }).ok, false);
  assert.equal(escrowSplitSpend({ escrow, payees: [{ script: s, sats: 8800n }, { script: s, sats: 200n }], feeSats: 1000n }).ok, false);
});

test('a liquidation remainder: 75 % evenly to the census less the slashed and the federation\'s guardians, 25 % by share_bps, summing to it', async () => {
  const { liquidationRemainderPayees } = await import('../src/federation-slash.js');
  const record = { guardians: [1, 2, 3, 4].map((n) => ({ nodePubkey: k(n) })) };
  const donation = [{ recipientPk: k(20), shareBps: 7000 }, { recipientPk: k(21), shareBps: 3000 }];
  const r = liquidationRemainderPayees({ msat: 1_232_000n, censusNodes: [1, 2, 3, 4, 5, 6, 7, 8].map(k), slashed: [k(8)], record, donation });
  assert.equal(r.ok, true, r.why);
  const nodes = r.payees.filter((p) => p.part === 'node'), dev = r.payees.filter((p) => p.part === 'donation');
  assert.equal(nodes.length, 3, 'n5-n7: the four guardians and the slashed n8 left out');
  assert.equal(nodes.reduce((a, p) => a + p.msat, 0n), 924_000n);
  assert.deepEqual(dev.map((p) => p.msat), [215_600n, 92_400n]);
  assert.equal(r.payees.reduce((a, p) => a + p.msat, 0n), 1_232_000n);
  assert.equal(liquidationRemainderPayees({ msat: 1000n, censusNodes: [5, 6].map(k), record, donation: [{ recipientPk: k(20), shareBps: 5000 }] }).ok, false);
});
