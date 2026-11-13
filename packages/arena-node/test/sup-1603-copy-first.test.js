// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4-find-entry 1: THE #1501 FIX ("a lock stakes the entry that named it first") IS BYPASSED BY POSTING THE COPY FIRST.
// The page posts its entry to its home seat and waits for the answer before it posts to the other seats (client.js join: postEntry to
// this.base, then peerJoins). An entry carries no player signature, so the home seat (role b, one seat of seven) - or anybody who reads
// the entry first - posts a copy under its own session key to every other seat before the player's entry gets there, and hands the
// player's own lock fields (all derivable from the entry) for it. At those seats the copy now "named the outpoint first": the copy's
// lock is verified and the player's own lock is refused - the player's stake backs an entry whose session key the attacker holds.
// Adapted to 1.9 by #2536: the #1603 fix (a player signature on every entry, 403 for a copy) did not reach 1.9 - there a copy is taken, and the
// lock is bound to its entry by the player's lock claim (#2069/#2088, the stake point signs the entry id; #1897). The page sends the claim
// with its entry, so the home seat keeps it too. What must hold is unchanged: the copy's lock is never verified and the player's lock is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo } from './test-clock.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { encodeEntryContract, decodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

test('#1603 (1.9): a copy posted before the player\'s entry reaches a seat cannot take the player\'s stake lock there', async () => {
  const w = await lockRound({ n: 3 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the victim's entry and locks are built (lock in the federation), and are on their way: no seat has them yet
    // THE HOME SEAT IS THE ATTACKER (role b): the page posts its handout and entry there first and waits for the answer. Played here by a
    // fetch that stands in for seat 0's port: it keeps the bytes, answers as a seat does, and relays nothing.
    const home = w.nodes[0].port, kept = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = new URL(String(url));
      if (Number(u.port) === home && opts.method === 'POST' && (u.pathname === '/handout' || u.pathname === '/entry' || u.pathname === '/lock-claim')) {
        kept[u.pathname] = new Uint8Array(opts.body);
        const body = u.pathname === '/lock-claim' ? Buffer.from('kept') : u.pathname === '/entry' ? Buffer.from(entryId(decodeEntryContract(kept['/entry']))) : Buffer.alloc(32);
        return new Response(body, { status: 201 });
      }
      return realFetch(url, opts);
    };
    let victim;
    try { victim = await lockAndPlay(w, player('victim', 0x61), { only: [], noMarks: true, unreached: [1, 2] }); }
    finally { globalThis.fetch = realFetch; }
    const others = w.nodes.slice(1);
    // the handout goes on (the attacker's own copy needs it, and so does the player's entry)
    for (const d of others) assert.equal((await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: kept['/handout'] })).status, 201);
    const attackerSession = ed25519.utils.randomSecretKey();
    const copy = { ...victim.entry, sessionPubkey: ed25519.getPublicKey(attackerSession) };
    const copyId = entryId(copy);
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(victim.entry.feePreimage) }, amountMsat: victim.entry.feeMsat,
      claimPk: victim.fields.claimPk, refundPk: victim.fields.refundPk, expiration: victim.fields.expiration };
    const atk = [];
    for (const d of others) {
      const base = `http://127.0.0.1:${d.port}`;
      const e = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(copy) });
      const l = await fetch(`${base}/lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
      const f = await fetch(`${base}/fee-lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      atk.push({ entry: e.status, lock: l.status, fee: f.status, why: (await e.text()).trim().slice(0, 100) }); await l.text(); await f.text();
    }
    // the player's own entry and locks arrive a moment later
    const mine = [];
    for (const d of others) {
      const base = `http://127.0.0.1:${d.port}`;
      const e = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(victim.entry) });
      const c = kept['/lock-claim'] ? await fetch(`${base}/lock-claim?entry=${toHex(victim.eid)}`, { method: 'POST', body: kept['/lock-claim'] }) : null;
      if (c) await c.text();
      const l = await fetch(`${base}/lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
      const lw = (await l.text()).slice(0, 140);
      const f = await fetch(`${base}/fee-lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      mine.push({ entry: e.status, lock: l.status, fee: f.status, why: lw, feeWhy: (await f.text()).slice(0, 140) }); await e.text();
    }
    const seen = others.map((d) => ({ victim: !!d.round.stakeSeen(victim.eid), copyLock: !!d.round.stakeLock(copyId) }));
    console.log('  FACTS #1489-r4-1:', JSON.stringify({ attacker: atk, victim: mine, seen }));
    // with no claim anywhere yet the copy's lock is verified at first; the player's claimed lock takes it back
    for (const s of seen) assert.equal(s.copyLock, false, 'the player\'s stake lock now stakes the copy, whose session key the attacker holds');
    for (const m of mine) assert.equal(m.lock, 201, `the player's own lock was refused: ${m.why}`);
    for (const m of mine) assert.equal(m.fee, 201, `the player's own fee lock was refused: ${m.feeWhy}`);
    for (const s of seen) assert.equal(s.victim, true, 'the player\'s stake is not seen');
  } finally { await w.close(); }
});
