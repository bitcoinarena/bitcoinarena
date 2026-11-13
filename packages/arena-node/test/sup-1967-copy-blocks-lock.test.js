// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 c1603-refute-0 1: THE #1603 FIX (every entry signed by its player key) DOES NOT STOP THE HOME SEAT BLOCKING THE PLAYER'S OWN LOCK.
// The home seat reads the player's entry first (as in wf1489-r4-entry-1), and posts to every other seat an entry of ITS OWN player key - signed
// by that key, so the #1603 check passes - naming the player's stake lock outpoint and fee lock outpoint and the player's stake point and handout
// (vssSharesRef: stakePointIsTheHandouts checks only A0, not the handout's player). At those seats that entry now "named the outpoint first"
// (#1501 firstEntryNamingLock counts every entry, also one whose refund key can never match the lock), so the player's own lock is refused:
// the player is shut out of the round at every seat but the attacker's, its stake idle until expiry. The fix's own reason names this effect
// ("or block the player's own lock").
// Adapted to 1.9 by #2536: signEntry (the #1603 fix's) is not in 1.9 - its entries carry no player signature, and a lock is bound to its entry
// by the lock claim (#2069/#2088: a signature by the stake point over the entry id). The same copy under the attacker's own keys, unsigned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo } from './test-clock.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { encodeEntryContract, decodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

test('#1967 (1.9): an entry under the attacker\'s own keys naming the player\'s lock outpoints does not block the player\'s lock at the other seats', async () => {
  const w = await lockRound({ n: 3 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
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
    for (const d of others) assert.equal((await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: kept['/handout'] })).status, 201);
    // THE ATTACKER'S OWN PLAYER KEY: it signs its own entry, as #1603 asks
    const atkKey = { key: b32(0x77) };
    const { playerSig: _s, ...plain } = victim.entry;
    const mine = { ...plain, playerPubkey: atkKey.key, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()) };
    const signed = mine;   // 1.9 entries carry no player signature (#1603's signEntry did not reach 1.9; the lock claim of #2069/#2088 binds the lock)
    const atk = [];
    for (const d of others) {
      const e = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(signed) });
      atk.push({ entry: e.status, why: (await e.text()).trim().slice(0, 120) });
    }
    // the player's own entry and locks arrive a moment later
    const got = [];
    for (const d of others) {
      const base = `http://127.0.0.1:${d.port}`;
      const e = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(victim.entry) });
      // the page's claim on its locks goes with its entry (kanban #1897, #1938)
      const c = kept['/lock-claim'] ? await fetch(`${base}/lock-claim?entry=${toHex(victim.eid)}`, { method: 'POST', body: kept['/lock-claim'] }) : null;
      if (c) await c.text();
      const l = await fetch(`${base}/lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
      got.push({ entry: e.status, lock: l.status, why: (await l.text()).slice(0, 160) }); await e.text();
    }
    console.log('  FACTS #1489-c1603-refute-0-s1-1:', JSON.stringify({ attacker: atk, victim: got }));
    for (const m of got) assert.equal(m.lock, 201, `the player's own lock was refused (attacker's entry ${JSON.stringify(atk)}): ${m.why}`);
  } finally { await w.close(); }
});
