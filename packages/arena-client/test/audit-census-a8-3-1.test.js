// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT census-a8-3-1: the §25.1 / #1333 "two independent providers" rule for a paying client's bond list counts each URL path of one box
// as its own provider. A link that names the honest seats plus two paths of one box (https://liar/a, https://liar/b) gets the box's
// omitting list twice, fast, and the union of the box with itself is taken as the lock-grade census - the honest seat's list is never read.
// SAFE: two paths of one box are not two independent providers (the answer is look-only, or the honest list is in the union).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { censusEvidenceFor } from '../src/committee.js';

const bond = (n) => ({ txid: String(n).padStart(2, '0').repeat(32), vout: 0, pubkey: 'aa'.repeat(32) });
const FULL = [bond(1), bond(2), bond(3)], SUBSET = [bond(1), bond(2)];   // the box leaves the honest bond 3 out

test('audit census-a8-3-1: two paths of one box are not two independent census providers', async () => {
  const fetcher = async (url) => {
    const u = new URL(url);
    if (u.host === 'honest.example') { await new Promise((r) => setTimeout(r, 80)); return new Response(JSON.stringify({ entries: FULL }), { status: 200 }); }
    if (u.host === 'liar.example') return new Response(JSON.stringify({ entries: SUBSET }), { status: 200 });
    throw new Error('no answer');
  };
  const got = await censusEvidenceFor('ab'.repeat(32), { censusRoot: new Uint8Array(32).fill(0x31) },
    ['https://honest.example', 'https://liar.example/a', 'https://liar.example/b'], { fetcher });
  console.log('  MEASURED:', JSON.stringify({ ok: got.ok, lookOnly: !!got.lookOnly, entries: (got.entries || []).length, from: got.from }));
  const lockGrade = got.ok === true;
  const hasHonestBond = (got.entries || []).some((e) => e.txid === bond(3).txid);
  assert.ok(!lockGrade || hasHonestBond, `one box under two paths met the two-provider rule alone: ok=${got.ok} from ${got.from}, the honest seat's bond is left out`);
});
