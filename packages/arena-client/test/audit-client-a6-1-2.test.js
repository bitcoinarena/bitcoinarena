// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-22b client r1 #2 (P4, P8, P1; the #3307 / #2652 class at a door they do not cover: the round's randomness):
// fetchRandomness counts one vote per seatKey - the URL's origin AND WHOLE PATH (kanban #2046) - so a lobby or round link that names a
// round's 7 committee seats plus 8 junk paths of one box (https://evil.example/a .. /h) gives that box 8 voters of 15. joinQuery keeps the
// node= list as given, lobbyJoinSearch carries it into every round joined from the page, and worldSeedFor (contract.nodes = 7 seats) asks
// exactly that list. 8 of 15 is "more than half of the named nodes", so the box's own 32 bytes become the round's randomness: the player's
// world seed (seed.js worldSeedWord) is one the committee never replays - the stake is already locked by then.
// SAFE: the round's randomness is the beacon its committee seats name; one box answering under several paths is one voice and cannot
// outvote seven seats (the answer is the honest value, or a refusal by name).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRandomness } from '../src/join.js';

const GOOD = new Uint8Array(32).fill(0x42);
const BAD = new Uint8Array(32).fill(0x66);
const SEATS = [1, 2, 3, 4, 5, 6, 7].map((n) => `https://tn4.example/guardian-${n}`);
const JUNK = 'abcdefgh'.split('').map((p) => `https://evil.example/${p}`);
const ok = (b) => ({ ok: true, status: 200, headers: { get: () => '1000' }, arrayBuffer: async () => b.buffer.slice(0), text: async () => '' });
const fetcher = async (url) => (String(url).startsWith('https://evil.example/') ? ok(BAD) : ok(GOOD));

test('audit client r1 #2: junk paths of one box in the link do not pick the round\'s randomness over its seven committee seats', async () => {
  let got = null, why = null;
  try { got = await fetchRandomness('ef'.repeat(32), [...SEATS, ...JUNK], { fetcher, committee: SEATS.length }); } catch (e) { why = e.message; }
  const facts = { took: got ? Buffer.from(got.randomness).toString('hex').slice(0, 8) : null, agreed: got && got.agreed, refused: why && why.slice(0, 80) };
  console.log('  FACTS audit client r1 #2:', JSON.stringify(facts));
  assert.ok(!got || Buffer.from(got.randomness).equals(Buffer.from(GOOD)),
    `one box under ${JUNK.length} paths set the round's randomness to its own bytes (${facts.took}..) over the ${SEATS.length} committee seats' beacon`);
});
