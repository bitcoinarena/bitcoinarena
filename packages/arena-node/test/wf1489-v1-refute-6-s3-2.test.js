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
// KANBAN #1489 (skeptic 3 of fix:entry:2 at d8e8818cc): GET /stake-lock lists a handout's ONLY lock under the bare handout id
// (the alias) and otherwise its 4 largest under their own ids. A stranger hands 4 locks 1 msat larger than the player's to ONE seat,
// after the player's lock was kept everywhere. That seat lists only the stranger's 4; the other lists the player's lock under the
// alias. The page never learns the player's own id, the alias names the stranger's lock at the flooded seat, and the stake waits.

test('#1489 s3: four larger stranger locks at one seat, after the player\'s, hide the player\'s own id from every listing', { timeout: 120000 }, async () => {
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
    const evils = [];
    for (let i = 0; i < 4; i++) { const at = { txid: rand(32), outIdx: 0n }; const f = { ...fields, amountMsat: fields.amountMsat + 1n, expiration: fields.expiration + 1 + i }; await w.port.put(at, f); evils.push([at, f]); }
    const hand = (d, at, f) => fetch(`${base(d)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST',
      body: JSON.stringify({ outpoint: `${toHex(at.txid)}:${at.outIdx}`, fields: lockFieldsToJson(f) }) });
    refusing.why = 'test: this signer node refuses the round';
    const op = `${toHex(outpoint.txid)}:0`;
    const contractId = String(await w.port.contractId(fields));
    const [h] = w.nodes[0].round.handoutsOf(w.rid);
    const said = [];
    // seat 1 is handed it after its own upgrade; the stranger hands a larger lock to seat 1 only; the page hands its lock again everywhere
    for (const d of w.nodes) { const r = await hand(d, outpoint, fields); said.push(['player', r.status]); }
    for (const [at, f] of evils) { const r = await hand(w.nodes[1], at, f); said.push(['stranger@1', r.status]); }
    for (const d of w.nodes) { const r = await hand(d, outpoint, fields); said.push(['player again', r.status]); }
    const ids = new Set();
    for (const d of w.nodes) {
      const l = await (await fetch(`${base(d)}/stake-lock?round=${toHex(w.rid)}&refund=${toHex(refundKeyOf(key))}`)).json();
      for (const x of l) if (x.outpoint === op) ids.add(x.entryId);
    }
    const ownId = toHex(sha256(new Uint8Array([...h.id, ...new TextEncoder().encode(`lock:${op}`)])));
    console.log('  own id listed by some seat:', ids.has(ownId));
    const tries = [];
    let got = false;
    for (const id of ids) for (const d of w.nodes) {
      const f = await fetch(`${base(d)}/forfeit?round=${toHex(w.rid)}&entry=${id}`);
      const j = f.status === 200 ? await f.json() : { why: await f.text() };
      const ok = !!j.signature && String(j.contractId) === contractId && schnorr.verify(fromHex(j.signature), fromHex(j.contractId), w.claimPk.subarray(1));
      tries.push([id.slice(0, 8), f.status, ok, String(j.why || '').slice(0, 90)]);
      if (ok) got = true;
    }
    console.log('  FACTS 4-larger@1:', JSON.stringify({ said, ids: [...ids].map((x) => x.slice(0, 8)), tries }));
    assert.equal(got, true, 'no seat gives a forfeit of the player\'s own lock under any id: its own id is listed by no seat');
  } finally { await w.close(); }
});
