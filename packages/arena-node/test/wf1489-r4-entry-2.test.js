// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4-find-entry 2: THE #1498 FIX ("one lock per handout, the first kept") LETS THE ATTACKER BE FIRST. POST /refused-lock keeps
// one lock per handout and refuses every later one. The handout's A0, the player's refund key and the round's claim key are public to any
// seat the player dealt to (and the handout is served by GET /handout), and the amount is not checked. So one seat (role b) - or anybody
// holding the handout - makes a 1 sat lock in the federation with that image, refund key and claim key and hands it to every seat the
// moment the round's unentered return opens, before the player's page does. The player's real stake is then refused at every seat
// ("already keeps another lock for that handout"): the forfeit returns the attacker's 1 sat, and the player's stake waits for its expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar } from './window-fixture.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('#1489-r4-2 a 1 sat lock handed to /refused-lock BEFORE the player\'s does not shut the player\'s stake out of its return', { timeout: 120000 }, async () => {
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
    // THE ATTACKER: the same public image, refund key and claim key, 1000 msat of its own - its lock made and handed first
    const tiny = { txid: rand(32), outIdx: 0n };
    const tinyFields = { ...fields, amountMsat: 1000n };
    await w.port.put(tiny, tinyFields);
    refusing.why = 'test: this signer node refuses the round';
    const first = [];
    for (const d of w.nodes) { const r = await hand(d, tinyFields, tiny); first.push([r.status, (await r.text()).slice(0, 90)]); }
    // THE PLAYER'S OWN 98 000 msat stake, handed a moment later
    const mine = [];
    for (const d of w.nodes) { const r = await hand(d, fields, outpoint); mine.push([r.status, (await r.text()).slice(0, 140)]); }
    const kept = w.nodes.map((d) => [...d.round.refusedLocksFor(w.rid, toHex(refundKeyOf(key)))].map((x) => x.outpoint || x));
    console.log('  FACTS #1489-r4-2:', JSON.stringify({ attacker: first, player: mine, keptForReturn: kept, playerOutpoint: `${toHex(outpoint.txid)}:0` }));
    for (const [s, why] of mine) assert.equal(s, 201, `the player's own stake lock is refused for its return - it waits for its expiry: ${why}`);
    // kanban #1604: the forfeit the seats sign under the id they named returns the player's own stake, at once
    const listed = await (await fetch(`${base(w.a)}/stake-lock?round=${toHex(w.rid)}&refund=${toHex(refundKeyOf(key))}`)).json();
    const row = listed.find((l) => l.outpoint === `${toHex(outpoint.txid)}:0`);
    assert.ok(row, 'the player\'s stake lock is not listed by its refund key');
    const f = await fetch(`${base(w.a)}/forfeit?round=${toHex(w.rid)}&entry=${row.entryId}`);
    const fj = f.status === 200 ? await f.json() : { why: await f.text() };
    assert.equal(f.status, 200, fj.why);
    assert.equal(listed.filter((l) => l.outpoint === row.outpoint).length, 1, 'the player\'s lock is listed twice');
  } finally { await w.close(); }
});
