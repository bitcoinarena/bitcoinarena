// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1333 (§25.1 RULED 2026-11-07, #1312): "a client that pays takes bond lists from at least two independent providers and uses the union ...
// A list that one provider serves alone is enough to look, not to lock." Measured: a single provider serving a subset is not enough to lock; two
// providers' union brings the omitted bond back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { censusEvidenceFor, unionOfEntries, CENSUS_PROVIDERS_TO_LOCK } from '../src/committee.js';

const bond = (n) => ({ txid: String(n).padStart(2, '0').repeat(32), vout: 0, pubkey: 'aa'.repeat(32) });
const FULL = [bond(1), bond(2), bond(3)], SUBSET = [bond(1), bond(2)];          // the omitting provider leaves bond 3 out
const contract = { censusRoot: new Uint8Array(32).fill(0x13) };
const fetcherOf = (answers) => async (url) => {
  const host = new URL(url).host; const a = answers[host];
  if (!a) throw new Error('no answer');
  return new Response(JSON.stringify({ entries: a }), { status: 200 });
};

test('#1333 one provider serving a subset is enough to look, not to lock; two providers lock on their union', async () => {
  const alone = await censusEvidenceFor('ab'.repeat(32), { censusRoot: new Uint8Array(32).fill(0x14) }, ['https://a.example', 'https://b.example'],
    { fetcher: fetcherOf({ 'a.example': SUBSET }) });
  const both = await censusEvidenceFor('ab'.repeat(32), contract, ['https://a.example', 'https://b.example'], { fetcher: fetcherOf({ 'a.example': SUBSET, 'b.example': FULL }) });
  const sameHost = await censusEvidenceFor('ab'.repeat(32), { censusRoot: new Uint8Array(32).fill(0x15) }, ['https://a.example', 'https://a.example/'],
    { fetcher: fetcherOf({ 'a.example': SUBSET }) });
  console.log('  MEASURED #1333:', JSON.stringify({ oneProvider: [alone.ok, alone.lookOnly, alone.entries.length], twoProviders: [both.ok, both.entries.length, both.from], sameNodeTwice: [sameHost.ok, sameHost.lookOnly] }));
  assert.equal(CENSUS_PROVIDERS_TO_LOCK, 2);
  assert.deepEqual([alone.ok, alone.lookOnly], [false, true], 'one provider\'s list was enough to lock');
  assert.match(alone.why, /enough to look, not to lock/);
  assert.equal(both.ok, true); assert.equal(both.entries.length, 3, 'the bond the first provider left out is not in the union');
  assert.deepEqual([sameHost.ok, sameHost.lookOnly], [false, true], 'one node asked twice counted as two providers');
  assert.equal(unionOfEntries([SUBSET, FULL, FULL]).length, 3);
});

test('#1333 the union keys a seat\'s evidence entries (transaction, position, branch) by their transaction, not by an absent txid:vout', async () => {
  const { unionOfEntries } = await import('../src/committee.js');
  const ev = (n) => ({ transaction: `02000000${n}`, position: String(n), branch: [], update: null });   // the evidence shape GET /census answers
  const a = [ev(1), ev(2), ev(3)], b = [ev(1), ev(3)];
  const u = unionOfEntries([b, a]);
  console.log('  MEASURED #1333 evidence shape:', JSON.stringify({ a: a.length, b: b.length, union: u.length }));
  assert.equal(u.length, 3);
  assert.equal(unionOfEntries([a, a]).length, 3);
});
