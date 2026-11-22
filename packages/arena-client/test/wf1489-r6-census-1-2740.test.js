// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r6 census-1 (P5, P4): the page builds the committee itself (committee.js) and asks the round's seats for the census
// evidence, GET /census?round=, one after another. Each answer is read WHOLE (`await r.json()`): one seat of the round's list answers with
// a body of tens or hundreds of MiB, and the page holds all of it (as text, then the parse) before it moves on to the next seat - the
// tab's memory for every round that seat is asked for first. The same holds for the /committee (arrayBuffer) and /seating (text) reads.
// Safe behaviour: a seat's /census answer is read up to a bound and dropped past it; the census still comes from two honest providers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { censusEvidenceFor } from '../src/committee.js';

const MiB = 1 << 20;
const HUGE = 64 * MiB;          // what the evil seat sends; a census of 100 bonds is well under 1 MiB
const BOUND = 8 * MiB;          // anything near this is already far more than a census

test('wf1489 r6 census-1: one seat\'s huge GET /census answer is not read whole by the page', async () => {
  let pulled = 0;
  const chunk = new Uint8Array(MiB).fill(0x20);       // spaces: JSON whitespace, so a reader cannot tell early that it is junk
  const evilBody = () => new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{"entries":[')); },
    pull(c) { if (pulled >= HUGE) { c.enqueue(new TextEncoder().encode(']}x')); c.close(); return; } pulled += chunk.length; c.enqueue(chunk); },
  });
  const honest = { entries: [{ txid: 'aa'.repeat(32), vout: 0 }, { txid: 'bb'.repeat(32), vout: 1 }] };
  const fetcher = async (url) => {
    if (url.startsWith('https://evil.example/')) return new Response(evilBody(), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(honest), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const contract = { censusRoot: new Uint8Array(32).fill(0x5a) };
  const got = await censusEvidenceFor('11'.repeat(32), contract, ['https://evil.example/seat', 'https://h1.example', 'https://h2.example'], { fetcher });
  assert.equal(got.ok, true, `setup: the two honest providers hand the census (${got.why})`);
  assert.ok(pulled <= BOUND, `the page read ${(pulled / MiB).toFixed(0)} MiB of one seat's /census answer before going on (bound ${BOUND / MiB} MiB)`);
});
