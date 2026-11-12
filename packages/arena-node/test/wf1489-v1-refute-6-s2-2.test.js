// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1881 (the variant of wf1489-v1-refute-6-s2-1 with the stranger FIRST): at 7de31ce89 a lock smaller than one a seat
// already keeps for the handout was refused there - a stranger's larger lock handed to one seat before the player's page kept the
// player's own lock out of that seat, so with 2 of 2 its forfeit never combined.
// KANBAN #1489 (skeptic 2 of fix:entry:2 at 7de31ce89): the handout's own id names "its largest lock, the same at every seat
// whatever the order" - but only when every seat was handed the same SET of locks. A stranger hands its lock (as large as the
// player's, or equal with a lower outpoint) to ONE seat only. That seat moves the player's lock to H(handout||lock:op); the other
// keeps it under the handout's id. No id names the player's lock at enough seats, so the committee never signs its forfeit: the
// player's stake waits for its expiry while the page retries for ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar } from './window-fixture.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

async function split(label, attackerOf) {
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
    const txid = rand(32); txid[0] = 0x80 | txid[0];
    const outpoint = { txid, outIdx: 0n };
    const fields = { paymentImage: { kind: 'point', bytes: dealt.handout.commitments[0] }, amountMsat: 98000n, claimPk: w.claimPk,
      refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
    await w.port.put(outpoint, fields);
    const { at: evil, fields: evilFields } = attackerOf(fields);
    await w.port.put(evil, evilFields);
    const hand = (d, at, f) => fetch(`${base(d)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST',
      body: JSON.stringify({ outpoint: `${toHex(at.txid)}:${at.outIdx}`, fields: lockFieldsToJson(f) }) });
    refusing.why = 'test: this signer node refuses the round';
    const said = [];
    // the player's page hands its lock to every seat; the stranger hands its own to seat 0 only
    { const r = await hand(w.nodes[0], evil, evilFields); said.push(['stranger@0', r.status, (await r.text()).slice(0, 100)]); }
    for (const d of w.nodes) { const r = await hand(d, outpoint, fields); said.push(['player', r.status, (await r.text()).slice(0, 100)]); }
    // THE PAGE'S RETRY (refusedReturn): hand its own lock again, then ask every id any seat names for it, at every seat
    for (const d of w.nodes) { const r = await hand(d, outpoint, fields); said.push(['player again', r.status]); }
    const op = `${toHex(outpoint.txid)}:0`;
    const ids = new Set();
    for (const d of w.nodes) {
      const l = await (await fetch(`${base(d)}/stake-lock?round=${toHex(w.rid)}&refund=${toHex(refundKeyOf(key))}`)).json();
      for (const x of l) if (x.outpoint === op) ids.add(x.entryId);
    }
    const contractId = String(await w.port.contractId(fields));
    const tries = [];
    let got = false;
    for (const id of ids) for (const d of w.nodes) {
      const f = await fetch(`${base(d)}/forfeit?round=${toHex(w.rid)}&entry=${id}`);
      const j = f.status === 200 ? await f.json() : { why: await f.text() };
      const ok = !!j.signature && String(j.contractId) === contractId && schnorr.verify(fromHex(j.signature), fromHex(j.contractId), w.claimPk.subarray(1));
      tries.push([id.slice(0, 8), f.status, ok, String(j.why || '').slice(0, 90)]);
      if (ok) got = true;
    }
    console.log(`  FACTS ${label}:`, JSON.stringify({ said, ids: [...ids].map((x) => x.slice(0, 8)), tries }));
    assert.equal(got, true, `${label}: no seat gives a forfeit of the player's own lock under any id the seats name - it waits for its expiry`);
  } finally { await w.close(); }
}

test('#1881: a stranger\'s larger lock handed to one seat BEFORE the player\'s leaves the player\'s stake with no forfeit', { timeout: 120000 }, async () => {
  await split('larger@one-seat', (fields) => ({ at: { txid: rand(32), outIdx: 0n }, fields: { ...fields, amountMsat: fields.amountMsat + 1n, expiration: fields.expiration + 1 } }));
});

test('#1881: an equal lock with a lower outpoint handed to one seat BEFORE the player\'s leaves the player\'s stake with no forfeit', { timeout: 120000 }, async () => {
  await split('equal-lower@one-seat', (fields) => { const t = new Uint8Array(32); t[31] = 1; return { at: { txid: t, outIdx: 0n }, fields: { ...fields, expiration: fields.expiration + 1 } }; });
});
