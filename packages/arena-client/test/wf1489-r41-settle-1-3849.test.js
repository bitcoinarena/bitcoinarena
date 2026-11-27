// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 attack audit r41 (settle-1): ONE badge seat of the board decides which badges a player shows on the season board.
// The weekly top-3 badge is ranked server-side from the network's agreed (signed) season so that "no single seat can hand a place to
// a round key or take one away" - but the page's mergeBadgeAwards keeps every (d, scope) the FIRST seat names, unsigned, with no
// agreement of other seats and no check of the award event's signature or issuer. A single seat (role b) answers GET /badges with
// invented 'arena-season-top-3' awards for any player (itself included) over made-up week scopes: the board shows "Season top 3 x40"
// and "Your badges: 40" while the six other badge seats award nothing.
// SAFE: an award only one seat of the board hands in, while the other badge seats answer for that player without it, is not shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBadgeAwards, yourBadgesLine } from '../src/badges-view.js';

const key = (n) => n.toString(16).padStart(2, '0').repeat(32);
const P = key(0x11);
const award = (d, game, scope, player = P, issuer = key(9)) => ({ d, game, scope, evidence: {}, awardedMs: 1, publishedMs: null,
  event: { kind: 8, pubkey: issuer, id: '00'.repeat(32), sig: '00'.repeat(64), tags: [['a', `30009:${issuer}:${d}`], ['p', player], ['t', game]] } });

test('r41-settle-1: one seat alone cannot put 40 "Season top 3" badges on a player the other six badge seats never awarded', () => {
  const forged = { player: P, on: true, definitions: [],
    awards: Array.from({ length: 40 }, (_, i) => award('arena-season-top-3', 'nextblock', `nextblock@2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + i).padStart(2, '0')}`)) };
  const honest = { player: P, on: true, definitions: [], awards: [] };
  const answers = [{ seat: 'https://evil.example', answer: forged },
    ...[1, 2, 3, 4, 5, 6].map((i) => ({ seat: `https://seat-${i}.example`, answer: honest }))];
  const m = mergeBadgeAwards(answers, { player: P, game: 'nextblock' });
  assert.equal(m.count, 0, `one seat of seven set the player's badges: count ${m.count}, shown ${JSON.stringify(m.badges.map((b) => [b.d, b.count]))}`);
  assert.equal(yourBadgesLine(m), null);
});
