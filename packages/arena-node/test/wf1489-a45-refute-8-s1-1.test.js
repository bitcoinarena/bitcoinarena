// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45 refute 8 (fix #1818 d1df710da): the fix bounds the chain census reads one guardian's GET /federations answer makes
// the MIRRORING seat do. The same effect has another door: GET /federation-record?federation=<any 64 hex>&height=<n> (server.js) calls
// fedRecords.mySignature(fid, n) -> chainReady(n), which, when no held round has census height n, awaits censusAt(n) - in the seat
// ballot.censusEntriesAt -> chainCensusKept: a census derived from ~2,017 bitcoind blocks and kept as a census_kept row for 3 days.
// No guardian status, no signature, no federation the seat knows: any stranger names 2,000 heights below the tip and the seat derives
// 2,000 chain censuses (chainCensus is evicted at 8 entries, so even repeating heights reads again). Safe behaviour: a stranger's named
// height is not a chain census read per request (only a federation this seat guards, a bounded number of new heights, near the tip).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationRecords } from '../src/federation-records.js';

const NET = new Uint8Array(32).fill(0x10);

test('a stranger naming 2000 census heights at GET /federation-record does not cost 2000 chain census reads', async () => {
  const me = { secret: new Uint8Array(32).fill(0x58) }; me.pubkey = schnorr.getPublicKey(me.secret);
  const census = { ok: true, entries: [] };
  let reads = 0; const asked = new Set();
  const o = federationRecords({ round: { pubkey: me.pubkey, identity: { secret: me.secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => null, networkId: NET,
    censusAt: async (h) => { reads++; asked.add(h); return [{ pubkey: me.pubkey, advert: {} }]; } });
  // the stranger: a federation id nobody guards, 2000 made-up heights (what the server door passes: /^[0-9]{1,10}$/)
  const fid = 'ab'.repeat(32);
  for (let i = 0; i < 2000; i++) await o.mySignature(fid, 100000 + i, null);
  console.log(`GET /federation-record x2000 from a stranger: chain census reads ${reads} at ${asked.size} distinct heights`);
  assert.ok(asked.size <= 8, `a stranger's named heights made the seat read the chain's census at ${asked.size} heights`);
});

// kanban #2270: a federation this seat guards still bounds the reads - only near the tip, and only a few new heights a minute
test('a guarded federation named at made-up heights: none read far below or above the tip, and at most a burst near it', async () => {
  const me = { secret: new Uint8Array(32).fill(0x59) }; me.pubkey = schnorr.getPublicKey(me.secret);
  let reads = 0; let now = 1_000_000;
  const o = federationRecords({ round: { pubkey: me.pubkey, identity: { secret: me.secret } }, newest: () => null, roster: { censusFor: () => ({ ok: false }) },
    inviteFor: (fid) => `fed:${fid}`, networkId: NET, nowMs: () => now, chainTip: async () => 157092,
    censusAt: async () => { reads++; return [{ pubkey: me.pubkey, advert: {} }]; } });
  const fid = 'cd'.repeat(32);
  for (let i = 0; i < 500; i++) await o.mySignature(fid, 100000 + i, null);     // far below the tip
  for (let i = 1; i <= 50; i++) await o.mySignature(fid, 157092 + i, null);      // above the tip
  assert.equal(reads, 0, `heights off the tip window were read ${reads} times`);
  for (let i = 0; i < 200; i++) await o.mySignature(fid, 156900 + i, null);      // near the tip, all at once
  assert.ok(reads <= 8, `near the tip ${reads} reads at once`);
  now += 60_000; const before = reads;
  for (let i = 0; i < 200; i++) await o.mySignature(fid, 156800 + i, null);
  assert.ok(reads - before <= 4, `a minute later ${reads - before} more reads`);
});
