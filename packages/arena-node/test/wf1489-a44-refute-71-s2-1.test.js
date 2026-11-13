// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 71 skeptic 2 (fixes #1757 + #2176): A PLAYER AND ONE PEER SEAT TOGETHER STILL MAKE A NEVER-SETTLED ROUND "COMBINED".
// #2176 lets a peer's ACCEPTED answer count when its transaction parts (`tx`) claim at least ONE stake or fee lock this seat verified for an
// entry of THIS round and rebuild to the signed message. "Lock outpoints are per round" holds only network-wide: stake_locks / fee_locks
// are each seat's own table, and a lock is refused for a second entry only where that seat already counted it. A player hands his round-1
// lock X to the seats that settle round 1 (not to seat B), and names the same X (same player key, same stake point, same amount, same
// committee claim key - lockMatchesEntry passes) in his round-2 entry at B before round 1 settles: B, holding no row for X, verifies it.
// Round 1 settles and claims X. Now one peer seat answers B's GET /lock-settlement?round=<round 2>&tx=1 with round 1's public ACCEPTED row
// and its tx: it verifies under the committee's claim key, claims X (in B's round-2 set), rebuilds to the signed message - "combined".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lockRound, openLockRound, lockAndPlay, closeRound, untilSettled, nameAddress, standing } from './lock-round-fixture.js';
import { WINNER, LOSER } from './window-fixture.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('a round-1 lock B verified for a round-2 entry lets one peer replay round 1\'s settlement as round 2 "combined elsewhere"', async () => {
  const w = await lockRound({});
  let stub;
  try {
    const won = await lockAndPlay(w, WINNER);
    await lockAndPlay(w, LOSER);
    await nameAddress([w.a, w.b], won);
    await closeRound(w);
    const st = await untilSettled(w, 90000);
    assert.equal(st.state, 'ACCEPTED', st.why);
    const old = await (await fetch(`http://127.0.0.1:${w.a.port}/lock-settlement?round=${toHex(w.rid)}&tx=1`)).json();
    assert.ok(old.signature && old.message && old.tx && old.tx.claims.length, 'round 1\'s public ACCEPTED row with its parts');
    // ROUND 2 OF THE SAME COMMITTEE: one entry, nothing settled
    const w2 = await openLockRound(w);
    assert.equal(toHex(w2.claimPk), toHex(w.claimPk), 'the same committee, the same claim key');
    await lockAndPlay(w2, LOSER);
    assert.notEqual((await standing(w.a, w2)).state, 'ACCEPTED');
    const b = w.b;
    const [mine] = b.round.entriesOf(w2.rid);
    assert.ok(mine, 'B holds the round-2 entry');
    // B's OWN STORE AS THE PLAYER LEFT IT: the round-2 entry's stake lock is X, a lock round 1's settlement claims (B was never handed X
    // for round 1, so its global one-lock-one-entry check had nothing to refuse it by; the federation still held X when B asked)
    // X: round 1's LOSER's stake lock, claimed in round 1's settlement (the same player enters round 2)
    const xs = old.tx.claims.map((c) => String(c.outpoint)).filter((op) => { const [tt, ii] = op.split(':'); return !!b.round.stakeLockAt({ txid: fromHex(tt), outIdx: BigInt(ii) }); });
    assert.equal(xs.length, 1, 'round 1 claims one loser stake lock');
    const [t, i] = xs[0].split(':');
    const was = b.round.stakeLock(mine.entryId);
    b.round.putStakeLock({ entryId: mine.entryId, roundId: w2.rid, outpoint: { txid: fromHex(t), outIdx: BigInt(i) }, fields: was.fields, contractId: was.contractId });
    // THE ATTACKER PEER: answers every GET /lock-settlement with round 1's public row and parts
    stub = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(old)); });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const peers = b.verifier.peers;
    b.verifier.peers = [`http://127.0.0.1:${stub.address().port}`];
    const said = await b.verifier.combinedElsewhere(w2.rid);
    b.verifier.peers = peers;
    console.log('  FACTS:', JSON.stringify({ round1: toHex(w.rid).slice(0, 16), round2: toHex(w2.rid).slice(0, 16), claimed: old.tx.claims.length, combinedElsewhere: said }));
    assert.equal(said, false, 'round 1\'s settlement, replayed by one peer, made never-settled round 2 "combined elsewhere" because it spends one lock B counted for round 2');
  } finally { if (stub) stub.close(); await w.close(); }
});
