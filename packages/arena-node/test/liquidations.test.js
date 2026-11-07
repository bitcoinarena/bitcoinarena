// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// GET /liquidations AND POST /liquidations/spent-set (spec §23A.5 steps 1-2): what a seat mirrors of a halted
// federation - the halt it counts from, the clocks, and the guardians' newest spent-note set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createLiquidations } from '../src/liquidations.js';
import { signSpentSet, encodeSpentSet } from '../../arena-protocol/src/spent-set.js';
import { TESTNET_CLOCKS } from '../../arena-protocol/src/federation-slash.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FED = new Uint8Array(32).fill(0x37); const FID = toHex(FED);
const guardians = Array.from({ length: 7 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, nodePubkey: schnorr.getPublicKey(secret) }; });
const record = { federationId: FED, guardians: guardians.map(({ nodePubkey }) => ({ nodePubkey })) };
const nonce = (i) => Uint8Array.from([2, ...new Uint8Array(32).fill(i)]);
const said = (g, session, ids) => { const c = signSpentSet({ federationId: FED, session, nonces: ids.map(nonce), signer: g.nodePubkey }, (m) => schnorr.sign(m, g.secret));
  return { spentSet: toHex(encodeSpentSet(c)), signature: toHex(c.signature) }; };
const recordsAt = (status, halt) => ({ recordOf: (f) => (f === FID ? { record, status, height: 900 } : null),
  haltOf: (f) => (f === FID && halt ? { height: halt, bytes: Uint8Array.of(0xab) } : null), haltedFederations: () => (halt ? [FID] : []) });

test('a halted federation is listed with its halt, its clocks and the newest spent set its guardians sent', () => {
  const l = createLiquidations({ records: recordsAt('HALTED', 880), clocks: TESTNET_CLOCKS, verify });
  assert.deepEqual(l.list()[0].spentSet, null);
  assert.match(l.list()[0].why, /no guardian published/);
  assert.deepEqual([l.offer(said(guardians[0], 40, [1, 2])).kept, l.offer(said(guardians[1], 41, [1, 2, 3])).kept, l.offer(said(guardians[2], 41, [1, 2, 3])).kept], [true, true, true]);
  // a third guardian at 41: n - t + 1 = 3 of 7 reached it (kanban #1262)
  assert.equal(l.offer(said(guardians[3], 41, [1, 2, 3])).kept, true);
  assert.equal(l.offer(said(guardians[1], 40, [1])).kept, false, 'a guardian\'s older session is not taken over its newer one');
  const [x] = l.list();
  assert.deepEqual([x.federation, x.haltHeight, x.haltRecord, x.liquidatesAt, x.claimWindowCloses, x.lateClaimsUntil], [FID, 880, 'ab', 892, 1528, 1528], 'testnet4: 3 months from the halt at its short clocks, 648 blocks (kanban #1093 part 8)');
  assert.deepEqual([x.spentSet.session, x.spentSet.signers, x.spentSet.nonces, x.spentSet.copies.length], [41, 3, 3, 3]);
});

test('a copy for a federation that is not HALTED here, by a stranger, or forged is refused by name', () => {
  assert.match(createLiquidations({ records: recordsAt('OPEN', null), clocks: TESTNET_CLOCKS, verify }).offer(said(guardians[0], 1, [1])).why, /OPEN here, and no halt proof stands/);
  const l = createLiquidations({ records: recordsAt('HALTED', 880), clocks: TESTNET_CLOCKS, verify });
  const stranger = { secret: new Uint8Array(32).fill(0x99) }; stranger.nodePubkey = schnorr.getPublicKey(stranger.secret);
  assert.match(l.offer(said(stranger, 1, [1])).why, /not a guardian/);
  assert.match(l.offer({ ...said(guardians[0], 1, [1]), signature: '00'.repeat(64) }).why, /not signed/);
  assert.match(l.offer({ spentSet: 'zz' }).why, /./);
  assert.equal(l.list()[0].spentSet, null);
});

test('a mark of theft halts the federation for liquidation from the alarm\'s height; a record\'s halt still counts first (kanban #1093 part 2)', async () => {
  const { createReserveAlarms } = await import('../src/reserve-alarms.js');
  const alarms = createReserveAlarms();
  const open = createLiquidations({ records: recordsAt('OPEN', null), clocks: TESTNET_CLOCKS, verify, alarms });
  assert.deepEqual(open.list(), [], 'no alarm: nothing liquidated');
  alarms.raise({ federation: FID, kind: 'unbacked-spend', height: 158900, txid: 'ee'.repeat(32) });
  const [x] = open.list();
  assert.deepEqual([x.federation, x.haltHeight, x.liquidatesAt, x.claimWindowCloses, x.alarm.kind, x.alarm.txid], [FID, 158900, 158912, 158900 + 648, 'unbacked-spend', 'ee'.repeat(32)]);
  assert.equal(open.offer(said(guardians[0], 41, [1])).ok, true, 'its guardians\' spent-set copies are taken for it');
  const both = createLiquidations({ records: recordsAt('HALTED', 880), clocks: TESTNET_CLOCKS, verify, alarms });
  assert.equal(both.list()[0].haltHeight, 880, 'a signed HALTED record\'s height counts first');
});
