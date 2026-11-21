// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 11 (fix #1605, 0c44e6f4c): THE CAP ON UNENTERED HANDOUTS IS ROUND-WIDE, SO A STRANGER FILLS IT AND NO HONEST PLAYER ENTERS.
// takeHandout refuses (429) any new handout once a round holds ARENA_HANDOUTS_UNENTERED_MAX (256) handouts beyond its entries. The junk
// handouts cost the stranger nothing (no entry, no lock, fresh random player keys, ~2 s), and the cap does not tell them from a player's:
// after 256 junk posts per seat every honest player's POST /handout is answered 429, so nobody can enter the round at that seat (the page
// posts its handout before /entry). A lock-first client (the RPS bot, lockFirst) has already locked its stake and fee when it is refused -
// the #1485 loss. The storage DoS became a free round-wide entry DoS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar, LOSER } from './window-fixture.js';
import { testNow } from './test-clock.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';

const CAP = 256;

async function flood(w, d) {
  const base = `http://127.0.0.1:${d.port}`;
  let taken = 0;
  for (let i = 0; i < CAP; i++) {
    const e = rand(32);
    const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: rand(32),
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      needed: w.needed, curve: feldmanGroup });
    const r = await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    await r.arrayBuffer();
    if (r.status === 201) taken++;
  }
  return taken;
}

for (const [lockFirst, junkOn] of [[false, false], [false, true], [true, true]]) {
  test(`[${junkOn ? 'flooded' : 'control, no junk'}] #1489-a44-11 a stranger's ${CAP} junk handouts do not lock an honest player (${lockFirst ? 'lock-first client' : 'page, handout first'}) out of the round`, { timeout: 280000 }, async () => {
    const w = await lockRound({ endMs: testNow() + 60000 });
    try {
      const junk = [];
      if (junkOn) for (const d of w.nodes) junk.push(await flood(w, d));
      let why = null;
      try { await lockAndPlay(w, LOSER, { lockFirst }); } catch (e) { why = String(e.message).slice(0, 300); }
      console.log('  FACTS #1489-a44-11:', JSON.stringify({ lockFirst, junkTakenPerSeat: junk, honest: why || 'entered' }));
      assert.equal(why, null, `an honest player could not enter after a stranger's free junk handouts: ${why}`);
    } finally { await w.close(); }
  });
}
