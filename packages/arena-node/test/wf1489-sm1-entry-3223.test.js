// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1-find-entry 2 (state machine audit, entry, base e2cd512d8): A STAKE ALREADY PLAYED ON IS LET GO.
// Since #2477 the entry with the lowest entry id among a player key's lock-backed entries owns the key at every seat: a later lock of a
// LOWER entry of the same key makes round.yieldEntryLocks delete the higher entry's stake_locks, fee_locks, stake_seen and stake_seen_tick
// rows - "only while nothing was built on them". The guard reads lock fates, a lock settlement, a forfeit and this seat's own result, but
// not the run: an entry whose stake was seen, whose play gate opened on it and whose marks every seat receipted is still "yieldable".
// So a second entry of the key handed its locks while the first one's run is under way or done (the seed on a second device, a reload
// that PLAYs again, or anyone who deals a handout under the player's public key and locks to the player's refund key - neither carries a
// player signature) takes the stake from the run that was played: the winning run is no longer staked anywhere, it is not in the
// settlement, and its own lock has no early return (/forfeit: no stake lock verified; /refused-lock: "that player entered the round").
// Invariant: a stake whose run this seat has receipted marks for is never let go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, nameAddress } from './lock-round-fixture.js';
import { WINNER, LOSER, b32, wait } from './window-fixture.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const feeFieldsOf = (p) => ({ paymentImage: { kind: 'hash', bytes: sha256(p.entry.feePreimage) }, amountMsat: p.entry.feeMsat,
  claimPk: p.fields.claimPk, refundPk: p.fields.refundPk, expiration: p.fields.expiration });

test('#1489 sm1-entry-2 a lower entry of the same player key does not take the stake of a run already played and receipted', async () => {
  const port = lockPort();
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 500 } });
  try {
    const key = b32(0x33);
    // the player's run: staked, played and receipted at both seats - the winning run
    const played = await lockAndPlay(w, { ...WINNER, name: 'device-1', key });
    await nameAddress([w.a, w.b], played);
    await lockAndPlay(w, LOSER);   // another player who loses: the round has money to pay
    assert.ok(w.nodes.every((d) => d.round.stakeSeen(played.eid)), 'precondition: the played run is staked at both seats');
    // a second entry of the same player key (a second device on the seed), its entry and handout at both seats, no lock yet; dealt again
    // until its entry id is the lower one (every entry has a fresh session key, so its id is a coin flip)
    let second = null;
    for (let i = 0; i < 16 && !second; i++) {
      const p = await lockAndPlay(w, { ...LOSER, name: `device-2-${i}`, key }, { noMarks: true, only: [] });
      if (Buffer.compare(Buffer.from(p.eid), Buffer.from(played.eid)) < 0) second = p;
    }
    assert.ok(second, 'no lower entry id in 16 tries');
    const said = [];
    for (const d of w.nodes) {
      const base = `http://127.0.0.1:${d.port}`;
      const l = await fetch(`${base}/lock?entry=${toHex(second.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(second.fields)) });
      const f = await fetch(`${base}/fee-lock?entry=${toHex(second.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFieldsOf(second))) });
      said.push({ lock: [l.status, (await l.text()).slice(0, 90)], fee: [f.status, (await f.text()).slice(0, 90)] });
    }
    for (let i = 0; i < 10; i++) await wait(10);
    const at = w.nodes.map((d) => ({ playedSeen: !!d.round.stakeSeen(played.eid), playedLock: !!d.round.stakeLock(played.eid), secondSeen: !!d.round.stakeSeen(second.eid) }));
    await closeRound(w);
    const st = await untilSettled(w, 30000);
    const fo = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(played.eid)}`);
    console.log('  FACTS sm1-entry-2:', JSON.stringify({ said, at, settlement: st && st.state, playedForfeit: [fo.status, (await fo.text()).slice(0, 120)] }));
    for (const [i, s] of at.entries())
      assert.equal(s.playedSeen, true, `seat ${i} let go the stake of a run it had receipted (stake lock kept: ${s.playedLock}): the played run is no longer staked`);
  } finally { await w.close(); }
});
