// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 r41-nostr-1: the relay host's standing (kanban #2847, #3034) is read by tools/nostr-relay.mjs readStanding from
// ARENA_RELAY_STANDING_SEATS - and it stops at the FIRST seat that answers ("one seat that answered is enough for this game").
// A seat's GET /season-rounds holds only the rounds of the committees it sat on (nostr-badges.js: "about half of them on 14
// seats"), so every identity that staked and settled only in rounds that first seat did not sit on gets no standing. Those
// players' profiles, relay lists and wallet info are then evictable by a stranger's fresh-key flood (nostr-relay.js
// oldestUnstanding), the lock-out #2847 was meant to end for them. And whichever single seat answers first decides alone.
// SAFE: readStanding counts the staked, settled identities every listed seat serves (the union), not the first seat's only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// the host relay tool's own readStanding, taken from its source (importing the tool would start a relay on its port)
const src = readFileSync(new URL('../tools/nostr-relay.mjs', import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('export async function readStanding'), src.indexOf('\nconst refresh'));
const readStanding = new Function(`return (${fn.replace('export ', '')});`)();

const hex = (b) => b.toString(16).padStart(2, '0').repeat(32);
const ALICE = hex(0xa1), ALICE_ROUND_KEY = hex(0xa2);   // staked and settled in a round seat A sat on
const BOB = hex(0xb1), BOB_ROUND_KEY = hex(0xb2);       // staked and settled in a round only seat B sat on

const entry = (player, roundKey) => ({ player, roundKey, stakeMsat: '100000', payoutMsat: '190000', outcome: 'WON', score: 3 });
const answers = {
  'https://seat-a.example': { node: hex(0x01), rounds: [{ roundId: hex(0x11), entries: [entry(ALICE, ALICE_ROUND_KEY)] }], next: null },
  'https://seat-b.example': { node: hex(0x02), rounds: [{ roundId: hex(0x12), entries: [entry(BOB, BOB_ROUND_KEY)] }], next: null },
};
const fetcher = async (url) => {
  const base = Object.keys(answers).find((b) => String(url).startsWith(b));
  return { ok: true, status: 200, json: async () => answers[base] };
};

test('r41-nostr-1: relay standing is read from every listed seat, not the first one that answers', async () => {
  const got = await readStanding(Object.keys(answers), ['rock-paper-scissors'], fetcher);
  assert.ok(got.has(ALICE), 'the first seat\'s staked identity has standing');
  assert.ok(got.has(BOB), 'an identity that staked and settled in a round the second listed seat holds (and the first does not) has standing too');
});
