// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar } from './window-fixture.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
// KANBAN #1489 (skeptic 3 of fix:entry:2 at d8e8818cc, lens: merge damage / the second copy of the store): d8e8818cc says
// "every lock is also found by its own id at every seat that keeps it". A row a seat wrote BEFORE the upgrade (85f803d70: kept
// under the bare handout id, of_handout NULL) is found only under the handout id, never under H(handout||"lock:"||outpoint).
// In a rolling upgrade one seat keeps the player's lock as such an old row, the other (handed the lock after its own upgrade -
// it was down, the page re-hands on every look) keeps it under its new id. A stranger hands a larger lock to that second seat.
// Asked by the handout id, the second seat's alias names the stranger's lock; asked by the new id, the first seat has none.
// No id gives the player's forfeit: the stake waits for its expiry.

test('#1489 s3: a seat\'s pre-upgrade row is never found by the lock\'s own id, and a stranger\'s larger lock elsewhere strands the stake', { timeout: 120000 }, async () => {
  const refusing = { why: null };
  const w = await lockRound({ serveOpts: { refusedFor: () => refusing.why, unenteredGraceMs: 1e12 } });
  try {
    const base = (d) => `http://127.0.0.1:${d.port}`;
    const key = rand(32); const e = rand(32);
    const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: key,
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      needed: w.needed, curve: feldmanGroup });
    assert.equal(dealt.ok, true, dealt.why);
    for (const d of w.nodes) assert.equal((await fetch(`${base(d)}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    const outpoint = { txid: rand(32), outIdx: 0n };
    const fields = { paymentImage: { kind: 'point', bytes: dealt.handout.commitments[0] }, amountMsat: 98000n, claimPk: w.claimPk,
      refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
    await w.port.put(outpoint, fields);
    const evil = { txid: rand(32), outIdx: 0n };
    const evilFields = { ...fields, amountMsat: fields.amountMsat + 1n, expiration: fields.expiration + 1 };
    await w.port.put(evil, evilFields);
    const hand = (d, at, f) => fetch(`${base(d)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST',
      body: JSON.stringify({ outpoint: `${toHex(at.txid)}:${at.outIdx}`, fields: lockFieldsToJson(f) }) });
    refusing.why = 'test: this signer node refuses the round';
    const op = `${toHex(outpoint.txid)}:0`;
    const contractId = String(await w.port.contractId(fields));
    // SEAT 0 KEPT THE PLAYER'S LOCK BEFORE ITS UPGRADE: the row 85f803d70's putRefusedLock wrote (handout id, no of_handout)
    const [h] = w.nodes[0].round.handoutsOf(w.rid);
    w.nodes[0].round.db.prepare('INSERT INTO refused_locks (handout_id, round_id, outpoint, fields, contract_id, kept_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(h.id), Buffer.from(w.rid), op, JSON.stringify(lockFieldsToJson(fields)), contractId, Date.now());
    const said = [];
    // seat 1 is handed it after its own upgrade; the stranger hands a larger lock to seat 1 only; the page hands its lock again everywhere
    { const r = await hand(w.nodes[1], outpoint, fields); said.push(['player@1', r.status]); }
    { const r = await hand(w.nodes[1], evil, evilFields); said.push(['stranger@1', r.status]); }
    for (const d of w.nodes) { const r = await hand(d, outpoint, fields); said.push(['player again', r.status]); }
    const ids = new Set();
    for (const d of w.nodes) {
      const l = await (await fetch(`${base(d)}/stake-lock?round=${toHex(w.rid)}&refund=${toHex(refundKeyOf(key))}`)).json();
      for (const x of l) if (x.outpoint === op) ids.add(x.entryId);
    }
    // and the lock's own id, as the 201 answer names it
    ids.add(toHex(sha256(new Uint8Array([...h.id, ...new TextEncoder().encode(`lock:${op}`)]))));
    const tries = [];
    let got = false;
    for (const id of ids) for (const d of w.nodes) {
      const f = await fetch(`${base(d)}/forfeit?round=${toHex(w.rid)}&entry=${id}`);
      const j = f.status === 200 ? await f.json() : { why: await f.text() };
      const ok = !!j.signature && String(j.contractId) === contractId && schnorr.verify(fromHex(j.signature), fromHex(j.contractId), w.claimPk.subarray(1));
      tries.push([id.slice(0, 8), f.status, ok, String(j.why || '').slice(0, 90)]);
      if (ok) got = true;
    }
    console.log('  FACTS old-row@0 stranger@1:', JSON.stringify({ said, ids: [...ids].map((x) => x.slice(0, 8)), tries }));
    assert.equal(got, true, 'no seat gives a forfeit of the player\'s own lock under any id: the pre-upgrade row is not found by the lock\'s own id');
  } finally { await w.close(); }
});
