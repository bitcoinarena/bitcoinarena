// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit 2026-11-25 entry r3 #1 (gap in #2547 / #1639): the round's claim key is the committee's DKG key, shared by every round of the same
// seats. POST /refused-lock?round=R2 keeps a lock that was made for a live round R1 (same claim key) once R2's entries are closed, against a
// forged R2 handout copying R1's public A0 and player key (POST /handout takes a non-h2h round's handout after its close). #2547 guards only
// the asked round's own entries during a drain, so a stranger who hands the in-flight R1 stake lock to one seat's R2 return door first has it
// kept there as a refused-round lock; returnedHere (#1639) then refuses it at POST /lock for R1 for good. One seat stakes the R1 entry,
// the other never can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, openLockRound, lockAndPlay } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar, b32 } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { encodeHandout, decodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { sealShare } from '../../arena-protocol/src/seal.js';
import { lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const modInv = (a, m) => { let [r0, r1, s0, s1] = [((a % m) + m) % m, m, 1n, 0n]; while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; } return ((s0 % m) + m) % m; };

// a handout for `roundId` with the player's A0 and player key, that opens at the seat with key `seatPk` only (as audit-entry-2986's)
async function forgeFor(player, roundId, seatPk) {
  const mine = player.shares.find((s) => toHex(s.signerNodePubkey) === toHex(seatPk));
  const x = BigInt(mine.signerNode);
  const s = scalarFrom32(rand(32)) % FIELD;
  const higher = Array.from({ length: player.needed - 2 }, () => feldmanGroup.pointFromScalar(scalarFrom32(rand(32)) % FIELD));
  const terms = [{ point: feldmanGroup.pointFromScalar(s), coefficient: 1n }, { point: player.commitments[0], coefficient: FIELD - 1n }];
  higher.forEach((C, k) => { let p = 1n; for (let j = 0; j < k + 2; j++) p = (p * x) % FIELD; terms.push({ point: C, coefficient: (FIELD - p) % FIELD }); });
  const D = feldmanGroup.combinePoints(terms);
  const C1 = feldmanGroup.combinePoints([{ point: D, coefficient: modInv(x, FIELD) }]);
  const e = secretScalar();
  const shares = [];
  for (const sh of player.shares) shares.push(toHex(sh.signerNodePubkey) === toHex(seatPk)
    ? { ...sh, sealed: await sealShare({ value: s, signerNode: sh.signerNode, signerNodePubkey: sh.signerNodePubkey, ephemeralSecret: e, curve: feldmanGroup }) }
    : sh);
  return { roundId, playerPubkey: player.playerPubkey, ephemeralPubkey: feldmanGroup.pointX(e), needed: player.needed,
    commitments: [player.commitments[0], C1, ...higher], shares };
}
const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

test('audit-entry-a8-3-1: a live round\'s in-flight stake lock handed to another round\'s return door still stakes the entry at that seat', { timeout: 180000 }, async () => {
  // R1: the live round the player enters. R2: an older round of the same two seats (same committee, same claim key), entries closed long ago
  const w = await lockRound({});
  try {
    const r2 = await openLockRound(w, { endMs: testNow() + 3000 - 400000 });
    const base = (d) => `http://127.0.0.1:${d.port}`;
    assert.equal(toHex(r2.claimPk), toHex(w.claimPk), 'the two rounds of one committee share the claim key');
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the player's entry is held at both seats, its stake lock not handed yet (the page's background hand-over in flight)
    const p = await lockAndPlay(w, player('p', 0x74), { only: [], noMarks: true });
    for (const d of w.nodes) assert.ok(d.round.entry(p.eid), 'the entry is held at every seat');
    // THE STRANGER: reads the player's handout (public GET /handout), forges an R2 handout with its A0 and player key that opens at seat b
    const hb = await fetch(`${base(w.a)}/handout?id=${toHex(p.entry.vssSharesRef)}`);
    assert.equal(hb.status, 200);
    const real = decodeHandout(new Uint8Array(await hb.arrayBuffer()));
    const forged = await forgeFor(real, r2.rid, w.b.round.pubkey);
    const fh = await fetch(`${base(w.b)}/handout`, { method: 'POST', body: encodeHandout(forged) });
    const fhText = (await fh.text()).slice(0, 160);
    // ...and hands the player's public R1 stake lock to seat b's return door for R2
    const op = `${toHex(p.outpoint.txid)}:${p.outpoint.outIdx}`;
    const ret = await fetch(`${base(w.b)}/refused-lock?round=${toHex(r2.rid)}`, { method: 'POST', body: JSON.stringify({ outpoint: op, fields: lockFieldsToJson(p.fields) }) });
    const retText = (await ret.text()).slice(0, 200);
    // then the page's hand-over reaches both seats
    const lockBody = JSON.stringify(lockFieldsToJson(p.fields));
    const atA = await fetch(`${base(w.a)}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: lockBody });
    const atAText = (await atA.text()).slice(0, 160);
    const atB = await fetch(`${base(w.b)}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: lockBody });
    const atBText = (await atB.text()).slice(0, 200);
    const facts = { forgedHandout: [fh.status, fhText], ret: [ret.status, retText], atA: [atA.status, atAText], atB: [atB.status, atBText],
      stakedA: !!w.a.round.stakeLock(p.eid), stakedB: !!w.b.round.stakeLock(p.eid), keptAsRefusedB: !!w.b.round.refusedLockAt(op) };
    console.log('  FACTS audit-entry-a8-3-1:', JSON.stringify(facts));
    assert.equal(atA.status, 201, `seat a takes the entry's lock: ${atAText}`);
    assert.equal(facts.stakedA, facts.stakedB,
      `seat a stakes the R1 entry with its lock, and seat b refused the same lock (${atBText}) after keeping it as round R2's refused-round lock (${retText}): the seats hold different entry sets`);
  } finally { await w.close(); }
});
