// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r40-client-4: THE AUTOMATIC E-CASH EXCHANGE HANDS THE PLAYER'S NOTES TO ANY URL OF THE PAGE'S NODE LIST.
// ARENA_EXCHANGE_INTO (index.html, before every paid join whose round is in another federation, and ARENA_PREPARE_FUNDS before any press)
// passes the page's whole node list - daily.json's seats plus every endpoint a bond's census advert names (ARENA_LEARN_NODES ->
// censusEndpoints) - to exchangeEcashInto, which sends the stake's e-cash to the first URL whose unsigned GET /exchange claims enough of
// the round's federation. Nothing checks who answers there: no /identity proof, no project key, no bond. The seat side's own trust note
// (arena-node ecash-exchange.js: "The seat could keep them; seats are the project's own") does not hold on the page: one outside bonded
// node (or any URL that got into the list) offers, takes the notes, and answers 1 msat of e-cash - the page records it `short` ("kept as
// evidence") and the player is out the whole stake. The project's seats ahead of it in the list only need to hold too little of the
// round's federation (or be at their hourly cap) for the outsider to be the one asked.
// Safe behaviour: the page's notes go only to a counterparty it has checked can be trusted with them (a proven project seat), or the
// exchange is done so a counterparty cannot keep them; a stranger URL that answers short never leaves the player poorer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeRig, refusingSeat, payingSeat, A, B } from './ecash-1149-rig.js';

test('an outside node in the list offers, takes the stake\'s notes and answers 1 msat: the player must not lose the stake', async () => {
  const thief = { holds: { [B]: '5000000' }, post: async (b, { mint, take }) => {
    take(b.ecash);   // the player's notes, reissued into the thief's own wallet
    return { status: 200, body: { ok: true, msat: '1', ecash: mint(b.to, 1n), federation: b.to } };
  } };
  // the project's seat first in the list holds too little of B; the census-learned outsider comes after it
  const r = exchangeRig({ seats: { 'http://project-seat': refusingSeat({}), 'http://outsider-node': thief } });
  const before = r.bal.get(A) + r.bal.get(B);
  const said = await r.exchange({ to: B, needMsat: 100000n, nodes: ['http://project-seat', 'http://outsider-node'] });
  const after = r.bal.get(A) + r.bal.get(B);
  const handedTo = [...r.seen.values()].flat();
  assert.ok(after >= before,
    `the player held ${before} msat and holds ${after} msat after one exchange (${before - after} msat lost; notes handed to ${JSON.stringify(handedTo)}; `
    + `the page said: ${said.ok ? 'ok' : said.why}${said.short ? ' [short]' : ''}; kept as: ${r.kept().map((k) => k.state).join(',')})`);
});

// kanban #3873: the site's own seats (daily.json) still exchange - also one daily.json names that the round's list does not
test('kanban #3873: the outsider is never asked; a seat daily.json names pays in full', async () => {
  const thief = { holds: { [B]: '5000000' }, post: async () => { throw new Error('the outsider must not be handed notes'); } };
  const r = exchangeRig({ siteSeats: ['http://project-seat', 'http://site-seat-2'],
    seats: { 'http://project-seat': refusingSeat({}), 'http://outsider-node': thief, 'http://site-seat-2': payingSeat({ [B]: '500000' }) } });
  const said = await r.exchange({ to: B, needMsat: 100000n, nodes: ['http://project-seat', 'http://outsider-node'] });
  assert.equal(said.ok, true, said.why);
  assert.equal(said.seat, 'http://site-seat-2');
  assert.equal(r.bal.get(B), 100000n);
  assert.ok(![...r.seen.values()].flat().includes('http://outsider-node'));
});
