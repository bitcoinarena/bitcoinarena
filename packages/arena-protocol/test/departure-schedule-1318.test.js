// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1318 (RULED #1288, line #1343): a guardian's bond maturity is a standing notice, posted at bond_maturity - departure_notice. Gone, or the bond
// spent, from that maturity on is DEPARTED on schedule; before it nothing changes. A notice the guardian posted itself is still read first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardianSlashStands, scheduledDeparture } from '../src/federation-slash.js';

const PEER = new Uint8Array(33).fill(2);
const absent = (sinceHeight) => ({ ok: true, peerKey: PEER, sinceHeight, signers: 5, id: new Uint8Array(32).fill(1) });
const spent = (sinceHeight) => ({ ...absent(sinceHeight), bondSpent: true });

test('#1318 the schedule: the latest output\'s maturity is the leave_after, posted departure_notice before it', () => {
  assert.deepEqual(scheduledDeparture({ outputs: [{ maturity: 160000 }, { maturity: 170000 }], departureNotice: 432 }), { leaveAfterHeight: 170000, postedAt: 169568 });
  assert.deepEqual(scheduledDeparture({ maturity: 5000 }), { leaveAfterHeight: 5000, postedAt: null });
  assert.equal(scheduledDeparture({ outputs: [{ maturity: null }] }), null, 'no maturity known: no schedule');
});

test('#1318 gone or spent at or after the maturity: DEPARTED, no slash; a block before: ABANDONED as before', () => {
  const sch = scheduledDeparture({ maturity: 170000 });
  const rows = {
    absentAtMaturity: guardianSlashStands({ proof: absent(170000), scheduled: sch }),
    spentAtMaturity: guardianSlashStands({ proof: spent(170000), scheduled: sch }),
    absentBefore: guardianSlashStands({ proof: absent(169999), scheduled: sch }),
    spentBefore: guardianSlashStands({ proof: spent(169999), scheduled: sch }),
    noSchedule: guardianSlashStands({ proof: absent(170000) }),
    // a notice the guardian posted wins over the schedule: one that stopped before its own leave_after is still abandonment
    earlyOnNotice: guardianSlashStands({ proof: absent(170000), departure: { ok: true, peerKey: PEER, leaveAfterHeight: 170500 }, scheduled: sch }),
  };
  console.log('  FACTS #1318:', JSON.stringify(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, `${v.kind}${v.slash ? ' slash' : ''}`]))));
  assert.deepEqual([rows.absentAtMaturity.kind, rows.absentAtMaturity.slash, rows.absentAtMaturity.onSchedule], ['DEPARTED', false, true]);
  assert.deepEqual([rows.spentAtMaturity.kind, rows.spentAtMaturity.slash], ['DEPARTED', false]);
  assert.deepEqual([rows.absentBefore.kind, rows.absentBefore.slash], ['ABANDONED', true]);
  assert.deepEqual([rows.spentBefore.kind, rows.spentBefore.slash], ['ABANDONED', true]);
  assert.deepEqual([rows.noSchedule.kind, rows.noSchedule.slash], ['ABANDONED', true], 'without the lock on, nothing changes');
  assert.deepEqual([rows.earlyOnNotice.kind, rows.earlyOnNotice.slash], ['ABANDONED', true]);
});

// ---- the owner page warns a season ahead, and names where the seat ends; founding takes no bond that leaves inside its first season ----
import { bondLapseOf } from '../src/federation-slash.js';
import { drawGuardians } from '../src/guardian-founding.js';

test('#1318 the lapse is warned a season ahead (never less than drain_blocks), and the seat ends at the latest maturity', () => {
  const outputs = [{ bondSats: 60000n, maturity: 200000 }, { bondSats: 60000n, maturity: 190000 }];
  const at = (tip, warnBlocks) => bondLapseOf({ outputs, drainBlocks: 4032, bondMinGuardian: 50000n, tip, warnBlocks });
  // lapses at 200000 - 4032 = 195968: a season (12960) ahead is from 183008, drain_blocks ahead from 191936
  const rows = { seasonAhead: at(183008, 12960), seasonBefore: at(183007, 12960), drainOnly: at(183008, 0), testnet4Season: at(191936, 144) };
  console.log('  FACTS #1318 warn:', JSON.stringify(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, { warn: v.warn, blocksLeft: v.blocksLeft, warnBlocks: v.warnBlocks, departsAt: v.departsAt }]))));
  assert.deepEqual([rows.seasonAhead.warn, rows.seasonAhead.lapsesAt, rows.seasonAhead.departsAt], [true, 195968, 200000]);
  assert.equal(rows.seasonBefore.warn, false);
  assert.equal(rows.drainOnly.warn, false, 'without a season, drain_blocks ahead as before');
  assert.deepEqual([rows.testnet4Season.warn, rows.testnet4Season.warnBlocks], [true, 4032], 'a season shorter than drain_blocks never shortens the warning');
});

const b32 = (n) => new Uint8Array(32).fill(n);
const candidate = (n, maturity) => ({ pubkey: b32(n), txid: b32(0x40 + n), vout: 0, bondSats: 1000000n,
  advert: { operatorId: `op${n}`, guardianCapable: true, guardianEndpoint: `wss://g${n}`, bondMaturityHeight: maturity } });

test('#1318 founding: a bond that matures inside the first season is no candidate; without the season every bond counts as before', () => {
  // ten candidates for a federation of 7; three of them mature at 160500, inside a season (12960) from the trigger at 150000
  const entries = [...Array.from({ length: 7 }, (_, i) => candidate(i + 1, 900000)), candidate(20, 160500), candidate(21, 160500), candidate(22, 162960)];
  const seed = b32(0x77);
  const plain = drawGuardians({ entries, seed, height: 150000, nominal: 7, bondMinGuardian: 500000n });
  const seasoned = drawGuardians({ entries, seed, height: 150000, nominal: 7, bondMinGuardian: 500000n, firstSeasonEnds: 150000 + 12960 });
  const ops = (d) => [...d.drawn, ...d.alternates].map((e) => e.advert.operatorId);
  console.log('  FACTS #1318 founding:', JSON.stringify({ plain: { eligible: plain.eligible, ops: ops(plain) }, seasoned: { eligible: seasoned.eligible, ops: ops(seasoned) } }));
  assert.equal(plain.eligible, 10);
  assert.equal(seasoned.eligible, 7, 'the three bonds that leave inside the first season (one exactly at its end) counted');
  assert.ok(!ops(seasoned).some((o) => ['op20', 'op21', 'op22'].includes(o)));
  assert.deepEqual(plain.drawn.map((e) => e.advert.operatorId).length, 7);
});
