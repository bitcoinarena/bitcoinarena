// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 (attack audit, refused-lock door): POST /refused-lock keeps a lock under its handout's id with INSERT OR REPLACE, and checks
// nothing about its amount. The handout's A0, the player's refund key, the round's claim key are all public - so anyone can make a 1 sat lock
// in the federation with that image, that refund key and that claim key, hand it over after the player did, and replace the player's kept
// lock. The forfeit the committee then signs returns the attacker's 1 sat lock; the player's real stake stays locked until its expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar } from './window-fixture.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('#1489-2 a 1 sat lock handed to /refused-lock after the player\'s does not replace the player\'s kept stake', { timeout: 120000 }, async () => {
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
    const hid = toHex(handoutId(dealt.handout));
    // THE PLAYER'S STAKE: 98 000 msat
    const outpoint = { txid: rand(32), outIdx: 0n };
    const fields = { paymentImage: { kind: 'point', bytes: dealt.handout.commitments[0] }, amountMsat: 98000n, claimPk: w.claimPk,
      refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
    await w.port.put(outpoint, fields);
    const hand = (d, f, at) => fetch(`${base(d)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST',
      body: JSON.stringify({ outpoint: `${toHex(at.txid)}:${at.outIdx}`, fields: lockFieldsToJson(f) }) });
    refusing.why = 'test: this signer node refuses the round';
    const kept = [];
    for (const d of w.nodes) { const r = await hand(d, fields, outpoint); kept.push([r.status, (await r.text()).slice(0, 200)]); }
    // THE ATTACKER: the same public image, refund key and claim key, 1000 msat of its own
    const tiny = { txid: rand(32), outIdx: 0n };
    const tinyFields = { ...fields, amountMsat: 1000n };
    await w.port.put(tiny, tinyFields);
    const replaced = [];
    for (const d of w.nodes) { const r = await hand(d, tinyFields, tiny); replaced.push([r.status, (await r.text()).slice(0, 200)]); }
    const rows = w.nodes.map((d) => d.round.refusedLock(fromHex(hid)));
    console.log('  FACTS #1489-2:', JSON.stringify({ kept, attacker: replaced, keptOutpoints: rows.map((r) => r && r.outpoint.slice(0, 16)), player: `${toHex(outpoint.txid).slice(0, 16)}` }));
    for (const [s, why] of kept) assert.equal(s, 201, why);
    // kanban #1881: the attacker's other lock may be kept BESIDE the player's, under an id of its own (H(handout || "lock:" || outpoint)) -
    // never in the player's place: refused, or kept under another id than the player's
    const entryOf = (why) => (String(why).match(/entry=([0-9a-f]{64})/) || [])[1];
    for (const [s, why] of replaced) assert.ok(s === 409 || (s === 201 && entryOf(why) && entryOf(why) !== entryOf(kept[0][1])), `the attacker's other lock took the player's id: ${why}`);
    for (const r of rows) assert.equal(r && r.outpoint, `${toHex(outpoint.txid)}:0`, 'the player\'s kept stake lock was replaced by the attacker\'s 1 sat lock: the forfeit now returns that one');
  } finally { await w.close(); }
});
