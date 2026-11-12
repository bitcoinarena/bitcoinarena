// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4-find-entry 3: POST /handout KEEPS ANY STRANGER'S HANDOUTS WITHOUT BOUND. A handout needs no entry, no lock and no
// signature of anyone known: any well-formed dealing to the round's seats (a fresh random player key each time) is opened, stored in the
// handouts table (never pruned) and answered 201. One stranger fills a seat's disk round by round, and every POST /refused-lock of that
// round then decodes every stored handout of it (server.js loops round.handoutsOf(rid)) - the player's own return gets slower with each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar } from './window-fixture.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';

const CAP = 256;   // far above any honest round's players at one seat (a player deals one handout per join)
// NO HANDOUT->ENTRY GRACE HERE (kanban #2415, #2481): a loose handout younger than the grace (60 s) is not pushed out and young ones are kept
// past the cap up to its ceiling; this test is about the cap itself, the bound every handout falls under once its grace is over
process.env.ARENA_HANDOUT_ENTRY_GRACE_MS = '0';

test('#1489-r4-3 one stranger cannot store unbounded handouts for a round', { timeout: 240000 }, async () => {
  const w = await lockRound({});
  try {
    const d = w.nodes[0], base = `http://127.0.0.1:${d.port}`;
    let taken = 0;
    for (let i = 0; i < CAP + 64; i++) {
      const e = rand(32);
      const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: rand(32),
        ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
        needed: w.needed, curve: feldmanGroup });
      const r = await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
      await r.arrayBuffer();
      if (r.status === 201) taken++;
    }
    const stored = d.round.handoutsOf(w.rid).length;
    console.log('  FACTS #1489-r4-3:', JSON.stringify({ posted: CAP + 64, taken, stored }));
    assert.ok(stored <= CAP, `one stranger stored ${stored} handouts (no entry, no lock) for one round at one seat`);
  } finally { await w.close(); }
});
