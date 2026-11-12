// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2136 (the #1489 a44 refute of #1605): a new handout makes room by taking the row of the round's OLDEST LOOSE one (no entry
// names it, no kept refused-round lock stands on it). What that must never push out: the handout an entry names. A player enters, then a
// stranger posts CAP + 64 junk handouts at one seat - every one is taken (201), the store stays at CAP loose ones, the entered player's
// handout is still held, and the oldest junk ones are the ones gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar, LOSER } from './window-fixture.js';
import { testNow } from './test-clock.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';

const CAP = 256;
// NO HANDOUT->ENTRY GRACE HERE (kanban #2415, #2481): a loose handout younger than the grace (60 s) is not pushed out and young ones are kept
// past the cap up to its ceiling; this test is about the cap itself, the bound every handout falls under once its grace is over
process.env.ARENA_HANDOUT_ENTRY_GRACE_MS = '0';

test('#2136 junk handouts past the cap push out the oldest junk, never an entered player\'s handout', { timeout: 280000 }, async () => {
  const w = await lockRound({ endMs: testNow() + 60000 });
  try {
    await lockAndPlay(w, LOSER, { lockFirst: false });
    const d = w.nodes[0], base = `http://127.0.0.1:${d.port}`;
    const named = d.round.entriesOf(w.rid).map((e) => e.entry.vssSharesRef).filter((r) => r && !r.every((b) => b === 0));
    assert.ok(named.length >= 1, 'the honest entry names its handout');
    const ids = [];
    let taken = 0;
    for (let i = 0; i < CAP + 64; i++) {
      const e = rand(32);
      const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: rand(32),
        ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
        needed: w.needed, curve: feldmanGroup });
      const r = await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
      const body = new Uint8Array(await r.arrayBuffer());
      if (r.status === 201) { taken++; ids.push(body); }
    }
    const { loose } = d.round.looseHandouts(w.rid);
    const enteredHeld = named.every((ref) => !!d.round.handout(ref));
    const firstJunkHeld = !!d.round.handout(ids[0]), lastJunkHeld = !!d.round.handout(ids[ids.length - 1]);
    console.log('  FACTS #2136:', JSON.stringify({ posted: CAP + 64, taken, loose, stored: d.round.handoutCount(w.rid), enteredHeld, firstJunkHeld, lastJunkHeld }));
    assert.equal(taken, CAP + 64, 'every handout is taken: a new one makes room, it is not refused');
    assert.ok(loose <= CAP, `the round keeps at most ${CAP} loose handouts (${loose})`);
    assert.equal(enteredHeld, true, 'the handout an entry names is never pushed out');
    assert.equal(firstJunkHeld, false, 'the oldest junk made room');
    assert.equal(lastJunkHeld, true, 'the newest handout is held');
  } finally { await w.close(); }
});
