// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND'S PUBLICATION COMES AT LEAST min_publication_lead BEFORE ITS COMMITTEE (5A.5, kanban #1015).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicationLeadHolds, headerTimeMs } from '../src/publication.js';
import { MIN_PUBLICATION_LEAD_MS } from '../src/constants.js';

test('the reference lead is five minutes', () => assert.equal(MIN_PUBLICATION_LEAD_MS, 300000n));

test('a committee exactly at the lead stands, one millisecond sooner is refused and says by how much', () => {
  assert.deepEqual(publicationLeadHolds({ committeeTimeMs: 1300000n, publishedAtMs: 1000000n }), { ok: true });
  const r = publicationLeadHolds({ committeeTimeMs: 1299999n, publishedAtMs: 1000000n });
  assert.equal(r.ok, false);
  assert.match(r.why, /299999 ms after its publication/);
});

test('regtest mines on demand and is not held to it; a missing time never passes elsewhere', () => {
  assert.deepEqual(publicationLeadHolds({ committeeTimeMs: 1n, publishedAtMs: 1000000n, network: 'regtest' }), { ok: true });
  assert.equal(publicationLeadHolds({ committeeTimeMs: 1n, publishedAtMs: undefined, network: 'testnet4' }).ok, false);
});

test('the time of a header is its four bytes at offset 68, little endian', () => {
  const h = new Uint8Array(80); new DataView(h.buffer).setUint32(68, 1700000000, true);
  assert.equal(headerTimeMs(h), 1700000000000n);
  assert.equal(headerTimeMs(Buffer.from(h).toString('hex')), 1700000000000n);
});
