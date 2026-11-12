// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r5-settle-1: POST /settle-taken VERIFIES EVERY RECORD OF A PADDED CERTIFICATE.
// The door is public (no seat signature). settlement.js takeCertificate splits the body into 128-byte records and
// countPlanTaken runs checkPlanTaken - a BIP-340 verify - on every record before the "one per seat" check, with no cap at the
// round's seat count. A stranger reads the plan (GET /settle-sends) or the certificate (GET /settle-taken) of any settled round,
// repeats one real record up to the 8 MiB body limit (65 535 records) and the seat runs 65 535 schnorr verifies on its event
// loop, synchronously: every other door of that seat waits, for each such request. Safe: a certificate of more records than
// the round has seats is refused before any signature is checked, and the seat keeps answering.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitCertificate } from '../src/plan-taken.js';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, proposerOf, standing } from './lock-round-fixture.js';
import { LOSER, wait } from './window-fixture.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const WALKER = { ...LOSER, name: 'walker', key: new Uint8Array(32).fill(0x21) };

test('wf1489 r5-settle-1: a stranger\'s padded POST /settle-taken does not stall the seat', async () => {
  const port = lockPort();
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 500, donationSets: [TEST_DONATION_SET_REGTEST] } });
  const asker = proposerOf(w);
  const other = asker === w.a ? w.b : w.a;
  try {
    await lockAndPlay(w, WALKER, { noMarks: true });
    await closeRound(w);
    let held = null;
    for (const stop = Date.now() + 60000; Date.now() < stop; await wait(250)) {
      const r = await fetch(`http://127.0.0.1:${other.port}/settle-taken?round=${toHex(w.rid)}`);
      if (r.status === 200) { held = await r.json(); break; }
      await r.arrayBuffer();
    }
    assert.ok(held, 'the other seat never held a certificate (fixture)');
    const recs = splitCertificate(fromHex(held.certificate));
    // the stranger: one real record repeated up to the body limit
    const N = Math.floor((8 * 1024 * 1024 - 32) / 128);
    const body = Buffer.alloc(32 + N * 128);
    Buffer.from(fromHex(held.planId)).copy(body, 0);
    for (let i = 0; i < N; i++) Buffer.from(recs[i % recs.length]).copy(body, 32 + i * 128);
    const t0 = Date.now();
    const padded = fetch(`http://127.0.0.1:${other.port}/settle-taken?round=${toHex(w.rid)}`, { method: 'POST', body });
    // an honest read of the same seat while the padded certificate is checked
    await wait(300);
    const t1 = Date.now();
    const probe = await fetch(`http://127.0.0.1:${other.port}/settle-taken?round=${toHex(w.rid)}`);
    await probe.arrayBuffer();
    const probeMs = Date.now() - t1;
    const r = await padded;
    const txt = await r.text();
    const paddedMs = Date.now() - t0;
    console.log(`  FACTS: ${N} records; padded POST answered ${r.status} "${txt.trim().slice(0, 80)}" in ${paddedMs} ms; an honest GET waited ${probeMs} ms`);
    assert.ok(probeMs < 1000, `the seat stalled ${probeMs} ms for every other request while one stranger's certificate was checked`);
    assert.ok(paddedMs < 2000, `one padded certificate held the seat ${paddedMs} ms`);
    assert.notEqual(r.status, 201, 'a certificate of more records than the round has seats was kept');
  } finally { await w.close(); }
});
