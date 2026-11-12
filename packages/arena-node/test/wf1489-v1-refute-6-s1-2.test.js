// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1669, #1735 (refute of fix:entry:2): an attacker who MATCHES the player's amount and hands its lock first takes no
// slot from the player either. Both locks are kept, each under an id of its own that every seat derives the same way whatever
// order the locks came in; GET /stake-lock lists both, and the committee signs the forfeit of the player's own lock at once.
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

test('#1669 an equal-amount lock handed first does not block the player\'s; both kept and listed alike at every seat, the player\'s forfeit signed', { timeout: 120000 }, async () => {
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
    const twin = { txid: rand(32), outIdx: 0n };
    // the attacker's twin: the same amount, image, refund and claim key (a contract of its own: one block later)
    const twinFields = { ...fields, expiration: fields.expiration + 1 };
    await w.port.put(twin, twinFields);
    const hand = (d, at) => fetch(`${base(d)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST',
      body: JSON.stringify({ outpoint: `${toHex(at.txid)}:${at.outIdx}`, fields: lockFieldsToJson(at === twin ? twinFields : fields) }) });
    refusing.why = 'test: this signer node refuses the round';
    // seat a: the attacker's twin first; seat b: the player's first
    const said = [];
    for (const [d, order] of [[w.nodes[0], [twin, outpoint]], [w.nodes[1], [outpoint, twin]]])
      for (const at of order) { const r = await hand(d, at); said.push([r.status, (await r.text()).slice(0, 120)]); }
    const again = await hand(w.nodes[0], outpoint);
    const lists = [];
    for (const d of w.nodes) lists.push(await (await fetch(`${base(d)}/stake-lock?round=${toHex(w.rid)}&refund=${toHex(refundKeyOf(key))}`)).json());
    const op = `${toHex(outpoint.txid)}:0`;
    const ids = lists.map((l) => Object.fromEntries(l.map((x) => [x.outpoint, x.entryId])));
    const mineId = ids[0][op];
    const f = mineId ? await fetch(`${base(w.nodes[0])}/forfeit?round=${toHex(w.rid)}&entry=${mineId}`) : null;
    const fj = f && f.status === 200 ? await f.json() : { why: f ? await f.text() : 'not listed' };
    const verifies = !!fj.signature && schnorr.verify(fromHex(fj.signature), fromHex(fj.contractId), w.claimPk.subarray(1));
    const contractId = String(await w.port.contractId(fields));
    console.log('  FACTS #1669:', JSON.stringify({ said, again: again.status, ids, forfeit: [f && f.status, verifies, String(fj.why || '').slice(0, 120)] }));
    for (const [s, why] of said) assert.equal(s, 201, why);
    assert.equal(again.status, 201, 'the same lock handed again is not kept as it was');
    for (const l of lists) assert.equal(l.length, 2, 'both locks are not listed');
    assert.deepEqual(ids[0], ids[1], 'the seats keep the two locks under different ids: their forfeits would not combine');
    assert.equal(f && f.status, 200, fj.why); assert.equal(verifies, true, 'the player\'s lock\'s forfeit does not verify');
    assert.equal(String(fj.contractId), contractId);
  } finally { await w.close(); }
});
