// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 refute (fix:entry:1, b995ac717): the fix hands a lock only to the entry that named its outpoint FIRST AT THIS SEAT. But the page
// (arena-client client.js join) posts its entry to its own seat first, awaits the answer, and only then to the other seats (joinOn); the seats'
// relay waits 700-1200 ms. In that window a stranger reads the entry at the first seat (GET /api/round-result lists its id, GET /entry and
// GET /handout serve its bytes - all public) and posts a copy under his own session key, the handout, and the player's own lock fields to every
// other seat. There the copy is "first", so the copy is staked with the player's money and the player's own lock is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { encodeEntryContract, decodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

test('#1489 refute-9-1: a copy posted to the seats the player has not reached yet still takes the player\'s stake lock', async () => {
  // a round whose entry close is a minute away, as a live round's is: the seats' relay then waits its 700-1200 ms
  const w = await lockRound({ endMs: Math.max(testNow(), Date.now()) + 600000 });
  console.log('  CLOSE-IN', Number(w.c.entryCloseMs) - Date.now());
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the page's join: handout + entry to its own seat (seat 0) first; the other seats come next
    const victim = await lockAndPlay(w, player('victim', 0x61), { only: [], noMarks: true, unreached: [1] });
    const s0 = `http://127.0.0.1:${w.nodes[0].port}`, s1 = `http://127.0.0.1:${w.nodes[1].port}`;
    // THE STRANGER: reads seat 0's public doors only
    const listed = await (await fetch(`${s0}/api/round-result?round=${toHex(w.rid)}`)).json();
    const ids = JSON.stringify(listed).match(/[0-9a-f]{64}/g) || [];
    assert.ok(ids.includes(toHex(victim.eid)), 'seat 0 lists the entry id publicly');
    const bytes = new Uint8Array(await (await fetch(`${s0}/entry?id=${toHex(victim.eid)}`)).arrayBuffer());
    const seen = decodeEntryContract(bytes);
    const handout = new Uint8Array(await (await fetch(`${s0}/handout?id=${toHex(seen.vssSharesRef)}`)).arrayBuffer());
    const attackerSession = ed25519.utils.randomSecretKey();
    const copy = { ...seen, sessionPubkey: ed25519.getPublicKey(attackerSession) };
    const copyId = entryId(copy);
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(seen.feePreimage) }, amountMsat: seen.feeMsat,
      claimPk: victim.fields.claimPk, refundPk: victim.fields.refundPk, expiration: victim.fields.expiration };
    const h = await fetch(`${s1}/handout`, { method: 'POST', body: handout }); await h.text();
    const e = await fetch(`${s1}/entry`, { method: 'POST', body: encodeEntryContract(copy) });
    const l = await fetch(`${s1}/lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
    const f = await fetch(`${s1}/fee-lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
    const attacker = { handout: h.status, entry: e.status, lock: l.status, lockWhy: (await l.text()).slice(0, 120), fee: f.status };
    await e.text(); await f.text();
    // the page goes on: its entry to seat 1 (joinOn), then its locks to every seat
    const join1 = await fetch(`${s1}/entry`, { method: 'POST', body: encodeEntryContract(victim.entry) }); await join1.text();
    const mine = [];
    for (const d of w.nodes) {
      const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
      mine.push({ status: r.status, why: (await r.text()).slice(0, 140) });
    }
    const stakedSeen = w.nodes.map((d) => ({ victimLock: !!d.round.stakeLock(victim.eid), copyLock: !!d.round.stakeLock(copyId), copySeen: !!d.round.stakeSeen(copyId) }));
    console.log('  FACTS refute-9-1:', JSON.stringify({ attacker, victimJoin1: join1.status, victimLock: mine, stakedSeen }));
    for (const s of stakedSeen) assert.equal(s.copyLock, false, 'the player\'s stake lock backs a copy whose session key the stranger holds');
    for (const m of mine) assert.equal(m.status, 201, `the player's own lock was refused: ${m.why}`);
  } finally { await w.close(); }
});
