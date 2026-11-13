// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 12 skeptic 2, variant 2 (fix #1604, #2137): the forged handout copies the player's key TOO, so the
// refund check passes - but seat b keeps the stake under H(forged id || ...) and seat a under the player's handout id, and the
// forfeit, which needs both seats under ONE entry id, is never signed. Below, the base attack: POST /refused-lock finds "the" handout of a stake lock as the FIRST handout of
// the round whose A0 is the lock's image, then 409s when that handout's player is not the lock's refund key. A handout carries no
// player signature and each seat checks only its own share against the commitments, so a stranger copies the player's public A0 and
// cuts, per seat, a polynomial whose C1 makes that seat's share open (C1 = (g^s - A0) / x), under the stranger's own player key.
// Where the stranger's handout is taken before the player's (the page's re-hand on resume, kanban #593: a seat that missed the
// handout mid-join; a lock-first client whose lock shows A0 before its handout), the player's real stake is refused at that seat
// ("that lock's refund key is not the handout player's") and its forfeit cannot gather the threshold: back only at its expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar } from './window-fixture.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { sealShare } from '../../arena-protocol/src/seal.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const modInv = (a, m) => { let [r0, r1, s0, s1] = [((a % m) + m) % m, m, 1n, 0n]; while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; } return ((s0 % m) + m) % m; };

// a handout with the player's A0, the stranger's own player key, that opens at the seat with key `seatPk` (number x) only
async function forgeFor(player, seatPk, strangerKey) {
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
  return { roundId: player.roundId, playerPubkey: strangerKey, ephemeralPubkey: feldmanGroup.pointX(e), needed: player.needed,
    commitments: [player.commitments[0], C1, ...higher], shares };
}

test('#1489-a44-refute-12-s2-2 a handout copying the player\'s A0 AND key, taken first at one seat, splits the stake\'s forfeit id across seats', { timeout: 120000 }, async () => {
  const refusing = { why: null };
  const w = await lockRound({ serveOpts: { refusedFor: () => refusing.why, unenteredGraceMs: 1e12 } });
  try {
    const base = (d) => `http://127.0.0.1:${d.port}`;
    const key = rand(32); const e = rand(32);
    const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: key,
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      needed: w.needed, curve: feldmanGroup });
    assert.equal(dealt.ok, true, dealt.why);
    // the player's order reaches seat a; seat b is cut off mid-join (kanban #593)
    assert.equal((await fetch(`${base(w.a)}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    // the stranger reads A0 (seat a's GET /handout, the lock's image) and is first at seat b with a handout of its own key
    const stranger = key;   // the player's own public key, copied
    const forged = await forgeFor(dealt.handout, w.b.round.pubkey, stranger);
    const forgedAt = (await fetch(`${base(w.b)}/handout`, { method: 'POST', body: encodeHandout(forged) })).status;
    // the page hands its handout again (refusedReturn's re-hand / the join's retry): taken at b too
    const replayed = (await fetch(`${base(w.b)}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status;
    const outpoint = { txid: rand(32), outIdx: 0n };
    const fields = { paymentImage: { kind: 'point', bytes: dealt.handout.commitments[0] }, amountMsat: 98000n, claimPk: w.claimPk,
      refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
    await w.port.put(outpoint, fields);
    refusing.why = 'test: this signer node refuses the round';
    const said = [];
    for (const d of w.nodes) {
      const r = await fetch(`${base(d)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST',
        body: JSON.stringify({ outpoint: `${toHex(outpoint.txid)}:0`, fields: lockFieldsToJson(fields) }) });
      said.push({ status: r.status, why: (await r.text()).slice(0, 240) });
    }
    console.log('  FACTS a44-refute-12-s2-2:', JSON.stringify({ forgedAt, replayed, said }));
    assert.equal(forgedAt, 201, 'the forged handout was not taken - the attack needs it');
    assert.equal(replayed, 201);
    for (const s of said) assert.equal(s.status, 201, `the player's 98 000 msat stake is refused at a seat: ${s.why}`);
    const ids = said.map((s) => (/entry=([0-9a-f]+)/.exec(s.why) || [])[1]);
    const listed = await (await fetch(`${base(w.a)}/stake-lock?round=${toHex(w.rid)}&refund=${toHex(refundKeyOf(key))}`)).json();
    const row = listed.find((l) => l.outpoint === `${toHex(outpoint.txid)}:0`);
    assert.ok(row, 'the player\'s stake lock is not listed by its refund key');
    const f = await fetch(`${base(w.a)}/forfeit?round=${toHex(w.rid)}&entry=${row.entryId}`);
    const fj = f.status === 200 ? await f.json() : { why: await f.text() };
    console.log('  FACTS a44-refute-12-s2-2 forfeit:', JSON.stringify({ ids, forfeit: f.status, why: String(fj.why || '').slice(0, 160) }));
    assert.equal(f.status, 200, `the player's stake is kept under different ids at the seats (${ids.join(' / ')}), so no forfeit gathers: ${fj.why}`);
  } finally { await w.close(); }
});
