// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute of #1632 (skeptic 2, the PLAYER's role): #1632 reads only the head of a peer's GET /equivocation
// (EQUIVOCATION_PAIRS_PER_PEER = 32 pairs) on the premise "a fork needs one pair". But an HONEST seat's answer is sorted by
// tick and carries every stale-head pair on paper (a page stuck on an old head: 63 refused marks measured live, each a
// "second child" that proves nothing - RULED 2026-10-05 (b)). A player that first sends 40 such stale marks pushes its
// real fork (two marks at one later tick, held by one seat) past pair 32 of that seat's answer: every other seat's pull
// (at its close, on POST /proof-pull, on a retry) reads only the 32 junk pairs and never sees the proof that, before
// #1632, it read and kept. Safe: a fork held by an honest peer is found by the other seat's pull whatever junk sorts first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, WINNER, wait } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeCheckpoint, joinSigned, checkpointId } from '../../arena-protocol/src/checkpoint.js';

const CHEAT = { name: 'cheat', key: b32(9), worldSecret: b32(0xc3), ticks: 1000 };

test('#1489-a44-refute-38-s2-1: a fork held by an honest seat is still pulled by the other seat when 40 stale-head pairs sort before it', async () => {
  const w = await lockRound();
  try {
    await lockAndPlay(w, WINNER, { address: true });
    const N = 40;
    const cheat = await lockAndPlay(w, CHEAT, { fork: 'stale', staleMarks: N });
    const eid = cheat.eid;
    // the real fork, at a tick after the stale marks: two different marks at one tick, both signed by the entry's session
    // key - held by seat A only (e.g. pulled at its close from a third seat now gone)
    const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), cheat.session));
    const base = { roundId: w.rid, entryId: eid, tick: CHEAT.ticks + 1, inputChainHash: new Uint8Array(32).fill(4),
      previousHash: new Uint8Array(32).fill(5), sessionPubkey: ed25519.getPublicKey(cheat.session) };
    const z1 = sign({ ...base, stateHash: new Uint8Array(32).fill(1) });
    const z2 = sign({ ...base, stateHash: new Uint8Array(32).fill(2) });
    assert.equal(w.a.round.putForkPair({ a: z1, b: z2 }), true, 'seat A did not keep the player\'s fork pair');
    assert.ok(w.a.round.provenEquivocation(w.rid, eid), 'seat A does not hold the proof: not the case the test names');
    assert.ok(!w.b.round.provenEquivocation(w.rid, eid), 'seat B held the proof before its pull: not the case the test names');
    const served = await fetch(`http://127.0.0.1:${w.a.port}/equivocation?round=${toHex(w.rid)}&entry=${toHex(eid)}`);
    const pairsServed = Number(served.headers.get('x-equivocations')); await served.arrayBuffer();
    // seat B's pull, as a stranger's POST /proof-pull asks it, then once more (the retry path)
    const asked = [];
    for (let i = 0; i < 2; i++) asked.push(await (await fetch(`http://127.0.0.1:${w.b.port}/proof-pull?round=${toHex(w.rid)}&entry=${toHex(eid)}`, { method: 'POST' })).text());
    const direct = await w.b.verifier.pullFirstMarkProof(w.rid, eid);
    const facts = { staleMarks: N, pairsServedByA: pairsServed, proofPullAtB: asked, directPullAtB: direct,
      provenAtB: w.b.round.provenEquivocation(w.rid, eid) };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.ok(pairsServed > 32, 'seat A served 32 pairs or fewer: not the case the test names');
    assert.equal(direct, true, `seat B's pull never found the fork seat A holds (A serves ${pairsServed} pairs, B reads 32)`);
    assert.ok(facts.provenAtB, 'seat B does not hold the fork after its pull');
  } finally { await Promise.race([w.close(), wait(5000)]); }
});
