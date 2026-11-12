// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r8 attacker audit (client): ONE SEAT'S /names (or presence) ANSWER IMPOSES AN UNBOUNDED NUMBER OF
// SIGNATURE CHECKS ON THE HONEST PLAYER'S LOBBY (pattern P5, no limits).
//
// identity.js checkedNames() does one BIP-340 verify() per element of the list it is handed, BEFORE any dedup, with
// no cap on the list length. lobby.js builds every lobby row with
//     names: checkedNames(counts.flatMap((c) => c.names), id, verify)
// where each seat's c.names is kept whole from that seat's GET /rounds answer (lobby.js:271,
//     names: Array.isArray(x.names) ? x.names : []  -- no length cap),
// and identity.js namesOf() keeps every seat's GET /names answer whole (items.push(...body.names)) and runs
// checkedNames over the lot. lobby.js already learned (kanban #573) that the per-listing signature check is "the
// costly part" and gated it to only the listings that could count - but the names check has no such gate and no cap.
//
// So ONE seat of a round can list that round with names: [ 50k forged records ], and the honest page's SYNCHRONOUS
// lobby render runs 50k verify() calls on the main thread, every paint (the lobby re-reads every few seconds). The
// page freezes; a player who cannot reach the pick sheet or the reveal before their open round's entry close / reveal
// deadline forfeits the stake they already locked. The records need not even verify - they are dropped AFTER the
// (costly) verify, so a forgery with any signature still costs the check.
//
// Safe behaviour: one seat's listing cannot make the honest page run an unbounded number of signature checks. A real
// lobby round holds a handful of players; the names a single seat contributes to one round's render must be bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedNames, namesOf } from '../src/identity.js';
import { encodeLobbyName } from '../../arena-protocol/src/lobby-name.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ROUND_ID = b32(0x5a);
const ROUND_HEX = toHex(ROUND_ID);

// One well-formed lobby-name record for THIS round - it decodes, so checkedNames reaches the verify() call for it.
const ONE_RECORD = toHex(encodeLobbyName({
  roundId: ROUND_ID, playerPubkey: b32(0x11), identityPubkey: b32(0x22), name: 'x', atMs: 1000n,
}));
// A junk signature: verify() will be called on it (that is the cost) and return false, so the record is dropped -
// but the main thread has already paid for the check.
const junkItem = { record: ONE_RECORD, sig: '00'.repeat(64) };

const FLOOD = 50000;   // what one seat lists for one round; a real round holds a handful of players

test('wf1489-r8-1: checkedNames does not run an unbounded number of verifies for one seat\'s name list', () => {
  let verifyCalls = 0;
  const verify = () => { verifyCalls += 1; return false; };   // a forgery: dropped after the check

  const items = new Array(FLOOD).fill(junkItem);
  const out = checkedNames(items, ROUND_HEX, verify);
  console.log(`  FACTS: checkedNames ran ${verifyCalls} BIP-340 verify() calls for a one-seat list of ${FLOOD} names; shown rows ${out.length}`);

  // A single seat's answer must not impose thousands of signature checks on every lobby paint.
  assert.ok(verifyCalls <= 1000,
    `one seat's name list of ${FLOOD} forced ${verifyCalls} verify() calls on the honest page's lobby render (no cap)`);
});

test('wf1489-r8-1b: namesOf (GET /names) bounds the checks one seat can impose', async () => {
  let verifyCalls = 0;
  const verify = () => { verifyCalls += 1; return false; };
  const names = new Array(FLOOD).fill(junkItem);
  const fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname !== '/names') return new Response('no', { status: 404 });
    return new Response(JSON.stringify({ names }), { status: 200 });
  };
  await namesOf({ roundId: ROUND_ID, nodes: ['http://evil'], fetcher, verify });
  console.log(`  FACTS: one seat's GET /names of ${FLOOD} records cost ${verifyCalls} verify() calls`);
  assert.ok(verifyCalls <= 1000,
    `one seat's GET /names of ${FLOOD} forced ${verifyCalls} verify() calls (no cap)`);
});
