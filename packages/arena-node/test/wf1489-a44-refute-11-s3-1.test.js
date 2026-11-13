// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2415, #2481 (the #1489 a44 refute of #2136): PAST THE HANDOUT->ENTRY GRACE A STRANGER'S JUNK STILL PUSHES A NEVER-ENTERED HANDOUT
// OUT (the cap must bound the store) - and the refused-round return still finds it: the page re-hands its kept handout WITH ITS STAKE LOCK
// (page-lock.js refusedReturn, x-arena-stake-lock), the seat takes it back although it refuses the round (the federation holds that lock), pins
// it, and POST /refused-lock keeps the lock. The same re-hand without the lock is refused, as any new handout of a refused round is. And a
// handout shown with its lock is never pushed out again, however much junk follows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { STAKE_LOCK_HEADER } from '../src/server.js';
import { rand, secretScalar } from './window-fixture.js';
import { testNow, skipBy } from './test-clock.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const CAP = 256, PAR = 16, GRACE = 60000;

const deal = (w, key) => { const e = rand(32); return dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: key,
  ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
  needed: w.needed, curve: feldmanGroup }); };

async function flood(w, d, n) {
  const bodies = []; for (let i = 0; i < n; i++) bodies.push(encodeHandout((await deal(w, rand(32))).handout));
  let taken = 0;
  for (let i = 0; i < bodies.length; i += PAR)
    await Promise.all(bodies.slice(i, i + PAR).map(async (b) => { const x = await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: b }); await x.arrayBuffer(); if (x.status === 201) taken++; }));
  return taken;
}

test('#2415 past the grace junk pushes a loose handout out; its re-hand with the stake lock is taken back on a refused round, pinned, and the lock kept', { timeout: 280000 }, async () => {
  const refusing = { why: null };
  const w = await lockRound({ endMs: testNow() + 600000, serveOpts: { refusedFor: () => refusing.why, unenteredGraceMs: 1e12 } });
  try {
    const base = (d) => `http://127.0.0.1:${d.port}`;
    const key = rand(32);
    const dealt = await deal(w, key);
    assert.equal(dealt.ok, true, dealt.why);
    const handoutBody = encodeHandout(dealt.handout), hid = handoutId(dealt.handout);
    for (const d of w.nodes) assert.equal((await fetch(`${base(d)}/handout`, { method: 'POST', body: handoutBody })).status, 201);
    const outpoint = { txid: rand(32), outIdx: 0n };
    const fields = { paymentImage: { kind: 'point', bytes: dealt.handout.commitments[0] }, amountMsat: 98000n, claimPk: w.claimPk,
      refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
    await w.port.put(outpoint, fields);
    const shown = { [STAKE_LOCK_HEADER]: JSON.stringify({ outpoint: `${toHex(outpoint.txid)}:0`, fields: lockFieldsToJson(fields) }) };
    // THE GRACE IS OVER (the player's entry never came); a stranger's CAP junk per seat now pushes the loose handout out - the store is bounded
    skipBy(GRACE + 1000);
    const taken = [], heldAfterFlood = [], stored = [];
    for (const d of w.nodes) { taken.push(await flood(w, d, CAP)); heldAfterFlood.push(!!d.round.handout(hid)); stored.push(d.round.handoutCount(w.rid)); }
    // THE ROUND IS REFUSED; a re-hand without the lock is refused, the page's re-hand with it is taken back
    refusing.why = 'test: this signer node refuses the round';
    const bare = [], rehand = [], kept = [];
    for (const d of w.nodes) {
      const b = await fetch(`${base(d)}/handout`, { method: 'POST', body: handoutBody }); bare.push(b.status); await b.arrayBuffer();
      const h = await fetch(`${base(d)}/handout`, { method: 'POST', body: handoutBody, headers: shown }); rehand.push(h.status); await h.arrayBuffer();
      const r = await fetch(`${base(d)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST', body: JSON.stringify({ outpoint: `${toHex(outpoint.txid)}:0`, fields: lockFieldsToJson(fields) }) });
      kept.push([r.status, (await r.text()).slice(0, 120)]);
    }
    // PINNED: the round offered again, CAP more junk per seat past the grace does not push it out
    refusing.why = null;
    skipBy(GRACE + 1000);
    const heldAfterSecond = [];
    for (const d of w.nodes) { await flood(w, d, CAP); heldAfterSecond.push(!!d.round.handout(hid)); }
    console.log('  FACTS #2415:', JSON.stringify({ taken, heldAfterFlood, stored, bare, rehand, kept, heldAfterSecond }));
    for (const t of taken) assert.equal(t, CAP, 'every junk handout is taken: a new one makes room');
    for (const s of stored) assert.ok(s <= CAP, `the store stays at the cap once the grace is over (${s})`);
    for (const h of heldAfterFlood) assert.equal(h, false, 'past its grace the oldest loose handout makes room');
    for (const s of bare) assert.equal(s, 409, 'a refused round takes no handout that shows no lock');
    for (const s of rehand) assert.equal(s, 201, 'the re-hand with its stake lock is taken back');
    for (const [s, why] of kept) assert.equal(s, 201, `the lock is kept for its refused-round return: ${why}`);
    for (const h of heldAfterSecond) assert.equal(h, true, 'a handout shown with its stake lock is never pushed out');
  } finally { await w.close(); }
});
