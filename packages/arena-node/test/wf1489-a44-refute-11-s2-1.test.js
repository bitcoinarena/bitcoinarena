// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 11, skeptic 2 (fix #1605 + #2136, 5e87adad0): A STRANGER PUSHES AN HONEST PLAYER'S HANDOUT OUT BETWEEN HIS
// POST /handout AND HIS POST /entry. Since #2136 a new handout past the cap takes the row of the round's OLDEST loose handout - and the
// oldest loose one is exactly the honest handout whose entry is still on its way (the page posts the handout, locks the stake - 2-20 s,
// measured - and only then posts the entry). The stranger's junk is free (no entry, no lock, fresh random keys); 256 posts per seat in
// that gap push the honest handout out, POST /entry is then refused "publish the handout first", and the client's retry (client.js
// postEntry, 16 x 500 ms) only re-posts the entry, never the handout: the join ends with the stake (and fee) already locked.
// The stranger floods at each seat while the player's handout -> entry gap is open (modelled here: the flood runs when the honest
// POST /handout has been answered, before the entry goes out). The entry POST is retried as postEntry retries it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar, LOSER } from './window-fixture.js';
import { testNow } from './test-clock.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';

const CAP = 256, PAR = 16;

async function junk(w) {
  const e = rand(32);
  const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: rand(32),
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
    needed: w.needed, curve: feldmanGroup });
  return encodeHandout(dealt.handout);
}

for (const lockFirst of [false, true]) {
  test(`#1489-a44-11-s2 a stranger's junk handouts, posted in the honest ${lockFirst ? 'lock-first client' : 'page'}'s handout->entry gap, do not refuse its entry`, { timeout: 280000 }, async () => {
    const w = await lockRound({ endMs: testNow() + 120000 });
    const real = globalThis.fetch;
    // the stranger's bytes, dealt before (dealing is the stranger's own CPU, not the seat's)
    const bodies = [];
    for (let i = 0; i < CAP * w.nodes.length; i++) bodies.push(await junk(w));
    const facts = { lockFirst, flood: [], entry: [] };
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (init.method === 'POST' && /\/handout$/.test(u)) {
        const r = await real(url, init);
        // THE GAP: the honest handout was answered; the stranger posts CAP junk handouts at that seat, PAR at a time
        const base = u.replace(/\/handout$/, '');
        const mine = bodies.splice(0, CAP);
        const t0 = Date.now(); let taken = 0;
        for (let i = 0; i < mine.length; i += PAR)
          await Promise.all(mine.slice(i, i + PAR).map(async (b) => { const x = await real(`${base}/handout`, { method: 'POST', body: b }); await x.arrayBuffer(); if (x.status === 201) taken++; }));
        facts.flood.push({ taken, ms: Date.now() - t0 });
        return r;
      }
      if (init.method === 'POST' && /\/entry$/.test(u)) {
        // client.js postEntry: asked again 16 x 500 ms while the seat says "publish the handout first"; the handout is never posted again
        let r, said = '';
        for (let n = 0; n < 16; n++) {
          r = await real(url, init);
          if (r.status === 201) return r;
          said = (await r.text()).trim();
          if (!/publish the handout first|that round is not seated yet/.test(said)) break;
          await new Promise((res) => setTimeout(res, 500));
        }
        facts.entry.push({ status: r.status, said: said.slice(0, 160) });
        return new Response(said, { status: r.status });
      }
      return real(url, init);
    };
    let why = null;
    try {
      try { await lockAndPlay(w, LOSER, { lockFirst }); } catch (e) { why = String(e.message).slice(0, 300); }
    } finally { globalThis.fetch = real; }
    try {
      console.log('  FACTS #1489-a44-11-s2:', JSON.stringify({ ...facts, honest: why || 'entered' }));
      assert.equal(why, null, `an honest player's entry was refused after a stranger's free junk pushed its handout out (${lockFirst ? 'its stake and fee already locked' : 'the page then locks for nothing'}): ${why}`);
    } finally { await w.close(); }
  });
}
