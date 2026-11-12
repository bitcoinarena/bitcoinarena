// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1897, #1938 (#1489 refute of 05194518e): the player's claim on its entry's locks (protocol lock-claim.js) is what binds a lock to its
// entry. (a) Nobody but the holder of the stake preimage can make one: a claim for a copy signed by any other key, or the player's own claim
// moved onto the copy, is refused at POST /lock-claim. (b) A page that sends no claim: a dishonest seat that backdates a copy at GET
// /lock-namer can at most refuse the player at an honest seat - the honest seat never stakes the copy (a peer's time never picks the winner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { lockClaimDigest } from '../../arena-protocol/src/lock-claim.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

test('#1897 #1938 a: a claim for a copy is refused unless the stake point signed it', async () => {
  const w = await lockRound({ endMs: Math.max(testNow(), Date.now()) + 600000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const victim = await lockAndPlay(w, player('victim', 0x61), { only: [], noMarks: true });
    const s0 = `http://127.0.0.1:${w.nodes[0].port}`;
    const copy = { ...victim.entry, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()) };
    const copyId = entryId(copy);
    assert.equal((await fetch(`${s0}/entry`, { method: 'POST', body: encodeEntryContract(copy) })).status, 201);
    const forged = await fetch(`${s0}/lock-claim?entry=${toHex(copyId)}`, { method: 'POST', body: schnorr.sign(lockClaimDigest(copyId), schnorr.utils.randomSecretKey()) });
    const forgedWhy = await forged.text();
    const mine = await (await fetch(`${s0}/lock-claim?entry=${toHex(victim.eid)}`)).arrayBuffer();
    assert.equal(mine.byteLength, 64, 'the player\'s claim is kept');
    const moved = await fetch(`${s0}/lock-claim?entry=${toHex(copyId)}`, { method: 'POST', body: new Uint8Array(mine) });
    const movedWhy = await moved.text();
    const l = await fetch(`${s0}/lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
    const lockWhy = await l.text();
    console.log('  FACTS refute-9-s2-3a:', JSON.stringify({ forged: [forged.status, forgedWhy.slice(0, 90)], moved: [moved.status, movedWhy.slice(0, 90)], copyLock: [l.status, lockWhy.slice(0, 90)] }));
    assert.equal(forged.status, 400);
    assert.equal(moved.status, 400);
    assert.equal(l.status, 409);
    assert.equal(w.nodes[0].round.lockClaim(copyId), null);
    const r = await fetch(`${s0}/lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
    assert.equal(r.status, 201, await r.text());
  } finally { await w.close(); }
});

test('#1897 #1938 b: no claim sent - a dishonest seat\'s backdated copy is never staked at an honest seat', async () => {
  const w = await lockRound({ endMs: Math.max(testNow(), Date.now()) + 600000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const victim = await lockAndPlay(w, player('victim', 0x61), { only: [], noMarks: true, lockClaim: false });
    const s0 = `http://127.0.0.1:${w.nodes[0].port}`, s1 = `http://127.0.0.1:${w.nodes[1].port}`;
    const copy = { ...victim.entry, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()) };
    const copyId = entryId(copy);
    for (const base of [s1, s0]) assert.equal((await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(copy) })).status, 201);
    w.nodes[1].round.db.prepare('UPDATE entry_lock_names SET joined_ms = 1 WHERE entry_id = ?').run(Buffer.from(copyId));
    w.nodes[1].round.db.prepare('UPDATE entries SET joined_ms = 1 WHERE entry_id = ?').run(Buffer.from(copyId));
    const l = await fetch(`${s0}/lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
    const attacker = { lock: l.status, why: (await l.text()).slice(0, 100) };
    const r = await fetch(`${s0}/lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
    const mine = { status: r.status, why: (await r.text()).slice(0, 100) };
    const honest = { victimLock: !!w.nodes[0].round.stakeLock(victim.eid), copyLock: !!w.nodes[0].round.stakeLock(copyId) };
    console.log('  FACTS refute-9-s2-3b:', JSON.stringify({ attacker, mine, honest }));
    assert.equal(attacker.lock, 409);
    assert.equal(honest.copyLock, false, 'the honest seat staked the backdated copy');
  } finally { await w.close(); }
});
