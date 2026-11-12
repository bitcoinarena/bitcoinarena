// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 refute of fix:entry:2 (bdbd37c62). The fix made the FIRST lock handed to POST /refused-lock stand. The lock's
// fields (A0, the player's refund key, the round's claim key) are still public, so the attacker no longer hands AFTER the player:
// it hands its 1 sat lock FIRST (it polls the door until the round is refused). The player's real stake then gets 409 at every
// seat, the kept row and GET /stake-lock name the attacker's lock, and the forfeit returns that one - same effect as before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar } from './window-fixture.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('#1489 refute-6-1 an attacker\'s 1 sat lock handed BEFORE the player\'s takes the handout slot; the player\'s stake is refused', { timeout: 120000 }, async () => {
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
    // THE PLAYER'S STAKE, locked in the federation (its fields are public there)
    const outpoint = { txid: rand(32), outIdx: 0n };
    const fields = { paymentImage: { kind: 'point', bytes: dealt.handout.commitments[0] }, amountMsat: 98000n, claimPk: w.claimPk,
      refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
    await w.port.put(outpoint, fields);
    // THE ATTACKER copies the public fields into a 1000 msat lock of its own
    const tiny = { txid: rand(32), outIdx: 0n };
    const tinyFields = { ...fields, amountMsat: 1000n };
    await w.port.put(tiny, tinyFields);
    const hand = (d, f, at) => fetch(`${base(d)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST',
      body: JSON.stringify({ outpoint: `${toHex(at.txid)}:${at.outIdx}`, fields: lockFieldsToJson(f) }) });
    refusing.why = 'test: this signer node refuses the round';
    // the attacker hands first (it polled the door), the player's page a moment later
    const attacker = [], player = [];
    for (const d of w.nodes) { const r = await hand(d, tinyFields, tiny); attacker.push([r.status, (await r.text()).slice(0, 90)]); }
    for (const d of w.nodes) { const r = await hand(d, fields, outpoint); player.push([r.status, (await r.text()).slice(0, 120)]); }
    const rows = w.nodes.map((d) => d.round.refusedLock(fromHex(hid)));
    const looks = [];
    for (const d of w.nodes) looks.push(await (await fetch(`${base(d)}/stake-lock?round=${toHex(w.rid)}&refund=${toHex(refundKeyOf(key))}`)).json());
    console.log('  FACTS refute-6-1:', JSON.stringify({ attacker, player, keptOutpoints: rows.map((r) => r && r.outpoint.slice(0, 16)),
      playerOutpoint: toHex(outpoint.txid).slice(0, 16), stakeLookAmounts: looks.map((l) => l.map((x) => x.fields.amountMsat)) }));
    for (const [s, why] of player) assert.equal(s, 201, `the player's real stake was refused at /refused-lock: ${why}`);
    for (const r of rows) assert.equal(r && r.outpoint, `${toHex(outpoint.txid)}:0`, 'the kept refused lock is the attacker\'s 1 sat lock: the forfeit returns that one, the player\'s stake waits for expiry');
  } finally { await w.close(); }
});

test('#1489 refute-6-2 the fee-lock slot (matched by refund key only, any hash image) is taken first by an attacker\'s lock', { timeout: 120000 }, async () => {
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
    // THE PLAYER'S FEE LOCK (image H(F))
    const feeAt = { txid: rand(32), outIdx: 1n };
    const feeFields = { paymentImage: { kind: 'hash', bytes: rand(32) }, amountMsat: 2000n, claimPk: w.claimPk,
      refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
    await w.port.put(feeAt, feeFields);
    // THE ATTACKER: any hash, the player's (public) refund key, the round's claim key, 1000 msat
    const tiny = { txid: rand(32), outIdx: 0n };
    const tinyFields = { ...feeFields, paymentImage: { kind: 'hash', bytes: rand(32) }, amountMsat: 1000n };
    await w.port.put(tiny, tinyFields);
    const hand = (d, f, at) => fetch(`${base(d)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST',
      body: JSON.stringify({ outpoint: `${toHex(at.txid)}:${at.outIdx}`, fields: lockFieldsToJson(f) }) });
    refusing.why = 'test: this signer node refuses the round';
    const attacker = [], player = [];
    for (const d of w.nodes) { const r = await hand(d, tinyFields, tiny); attacker.push([r.status, (await r.text()).slice(0, 90)]); }
    for (const d of w.nodes) { const r = await hand(d, feeFields, feeAt); player.push([r.status, (await r.text()).slice(0, 120)]); }
    console.log('  FACTS refute-6-2:', JSON.stringify({ attacker, player }));
    for (const [s, why] of player) assert.equal(s, 201, `the player's real fee lock was refused at /refused-lock: ${why}`);
  } finally { await w.close(); }
});
