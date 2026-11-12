// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 11, skeptic 2 (fix #1605 + #2136, 5e87adad0): THE RESUME PATH - A LOCKED, UNENTERED STAKE LOSES ITS RETURN.
// A page dealt the round's handout at every seat and locked its stake; its entry never landed (a seat restart, or test -1: a stranger
// pushed the handout out before the entry). Its return goes through POST /refused-lock (§23.2 REFUSED, kanban #593), which a seat keeps
// only against a handout it still holds; the page re-hands its kept handout bytes first (page-lock.js refusedReturn) on every reload.
// Since #2136 a stranger's free junk (CAP posts per seat, no entry, no lock) pushes that loose handout out while the round is offered,
// and once the round is refused the re-hand itself is refused at the door (offerRefusal): the seat holds no handout, the lock is
// refused "no stake of that round", and the stake stays locked until its expiry - the loss #593 / §23.2 REFUSED exist to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const CAP = 256, PAR = 16;

const deal = (w, key) => { const e = rand(32); return dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: key,
  ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
  needed: w.needed, curve: feldmanGroup }); };

test('#1489-a44-11-s2-x (#593 closed round) a stranger\'s junk handouts do not cost a locked, unentered player the unentered (#593) return of its stake', { timeout: 280000 }, async () => {
  const refusing = { why: null };
  const w = await lockRound({ endMs: testNow() + 120000, serveOpts: { unenteredGraceMs: 600000 } });
  try {
    const base = (d) => `http://127.0.0.1:${d.port}`;
    // THE PLAYER: handout at every seat, stake locked; its entry never landed
    const key = rand(32);
    const dealt = await deal(w, key);
    assert.equal(dealt.ok, true, dealt.why);
    const handoutBody = encodeHandout(dealt.handout);
    for (const d of w.nodes) assert.equal((await fetch(`${base(d)}/handout`, { method: 'POST', body: handoutBody })).status, 201);
    const outpoint = { txid: rand(32), outIdx: 0n };
    const fields = { paymentImage: { kind: 'point', bytes: dealt.handout.commitments[0] }, amountMsat: 98000n, claimPk: w.claimPk,
      refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
    await w.port.put(outpoint, fields);
    // THE STRANGER: CAP free junk handouts per seat while the round is offered
    const flood = [];
    for (const d of w.nodes) {
      const bodies = []; for (let i = 0; i < CAP; i++) bodies.push(encodeHandout((await deal(w, rand(32))).handout));
      let taken = 0;
      for (let i = 0; i < bodies.length; i += PAR)
        await Promise.all(bodies.slice(i, i + PAR).map(async (b) => { const x = await fetch(`${base(d)}/handout`, { method: 'POST', body: b }); await x.arrayBuffer(); if (x.status === 201) taken++; }));
      flood.push(taken);
    }
    // THE ROUND IS REFUSED; THE PAGE (reloaded) RE-HANDS ITS KEPT HANDOUT, THEN ITS LOCK (page-lock.js refusedReturn)
    skipTo(Number(w.c.entryCloseMs) + 600000 + 1000);
    const rehand = [], kept = [];
    for (const d of w.nodes) {
      const h = await fetch(`${base(d)}/handout`, { method: 'POST', body: handoutBody }); rehand.push([h.status, (await h.text()).slice(0, 80)]);
      const r = await fetch(`${base(d)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST', body: JSON.stringify({ outpoint: `${toHex(outpoint.txid)}:0`, fields: lockFieldsToJson(fields) }) });
      kept.push([r.status, (await r.text()).slice(0, 120)]);
    }
    console.log('  FACTS #1489-a44-11-s2-2:', JSON.stringify({ flood, rehand, kept }));
    for (const [s, why] of kept) assert.equal(s, 201, `the locked, unentered stake is not kept for its unentered (#593) return after a stranger's junk: ${why}`);
  } finally { await w.close(); }
});
