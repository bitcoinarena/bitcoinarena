// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 refute (fix:entry:1, skeptic 2, after 05194518e): ONE DISHONEST SEAT ROBS, not only refuses. 05194518e says "a dishonest seat
// of the round can still claim an earlier copy and refuse the player (refused, not robbed)". But an honest seat takes a peer's GET /lock-namer
// joinedMs as given (only the bytes are checked, never the time), and the copy is an entry of the player's own key naming the player's lock -
// exactly what that check lets through. Seat 1 (the dishonest one) says its copy was taken at joinedMs 1; the honest seat 0 then hands the
// player's lock to the copy (whose session key and payout the attacker holds) and refuses the player's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

test('#1489 refute-9-s2-2: one dishonest seat backdates a copy at GET /lock-namer and the honest seat stakes the copy', async () => {
  const w = await lockRound({ endMs: Math.max(testNow(), Date.now()) + 600000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the honest page: its entry to both seats, as joinOn does
    const victim = await lockAndPlay(w, player('victim', 0x61), { only: [], noMarks: true });
    const s0 = `http://127.0.0.1:${w.nodes[0].port}`, s1 = `http://127.0.0.1:${w.nodes[1].port}`;
    const copy = { ...victim.entry, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()) };
    const copyId = entryId(copy);
    for (const base of [s1, s0]) { const e = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(copy) }); assert.equal(e.status, 201, await e.text()); }
    // THE DISHONEST SEAT 1: its own store says it took the copy at 1 ms (what its GET /lock-namer then answers)
    w.nodes[1].round.db.prepare('UPDATE entry_lock_names SET joined_ms = 1 WHERE entry_id = ?').run(Buffer.from(copyId));
    w.nodes[1].round.db.prepare('UPDATE entries SET joined_ms = 1 WHERE entry_id = ?').run(Buffer.from(copyId));
    const said = await (await fetch(`${s1}/lock-namer?kind=stake&outpoint=${toHex(victim.entry.stakeLockOutpoint.txid)}:0&player=${toHex(victim.entry.playerPubkey)}`)).json();
    assert.equal(said.entry, toHex(copyId));
    // the attacker hands the player's own lock fields for the copy at the HONEST seat 0
    const l = await fetch(`${s0}/lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
    const attacker = { lock: l.status, why: (await l.text()).slice(0, 140) };
    const r = await fetch(`${s0}/lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
    const mine = { status: r.status, why: (await r.text()).slice(0, 140) };
    const honest = { victimLock: !!w.nodes[0].round.stakeLock(victim.eid), copyLock: !!w.nodes[0].round.stakeLock(copyId) };
    console.log('  FACTS refute-9-s2-2:', JSON.stringify({ attacker, mine, honest }));
    assert.equal(honest.copyLock, false, 'the honest seat staked the dishonest seat\'s backdated copy with the player\'s lock (robbed, not refused)');
    assert.equal(mine.status, 201, `the player's own lock was refused at the honest seat: ${mine.why}`);
  } finally { await w.close(); }
});
