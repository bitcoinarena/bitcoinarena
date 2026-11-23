// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3381 (owner playtest 2026-11-23 ~06:07Z, phone, daily round 2026-11-23): the game screen said "✓ X @fexx_off" although the owner never linked an
// X account in the game - /me fell back to the bug bounty's Season 2 book, where that key held a typed X link. Owner decision: "Bounty und Spiel
// müssen unabhängig sein." The game reads and writes only its own x_links; a link in the bounty book neither shows nor places, even when a book
// is handed to the service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { world, openRound, keypair, signIn, logOf, proveX, MIN } from './server-helpers.mjs';
import { DEFAULTS } from '../server/opr-service.mjs';

const xWorld = () => world({ start: '2026-11-23T01:00:00Z', xAccounts: new Map([['fexx_off', '1507727616706584576'], ['alice', '222']]), cfg: { entrySats: DEFAULTS.entrySats } });

test('#3381 a key with only a bounty-book X link (typed or code, verified) shows no X and is not placed; a fresh key shows none; a game link shows and places', async () => {
  const w = xWorld(); const r = await openRound(w);
  const typed = keypair(), coded = keypair(), fresh = keypair(), game = keypair();
  assert.equal(w.s2.claimName(typed.pk, 'x', { userId: '1507727616706584576', username: 'fexx_off', nowMs: w.clock.now() }).ok, true);
  w.s2.record(typed.pk, 'x', { member: true, nowMs: w.clock.now() });
  assert.equal(proveX(w.s2, coded.pk, { userId: '999', username: 'coded', nowMs: w.clock.now() }).ok, true);
  w.s2.record(coded.pk, 'x', { member: true, nowMs: w.clock.now() });
  assert.equal((await w.opr.saveX(game.pk, '@alice')).ok, true);
  for (const k of [typed, coded, fresh]) {
    const x = w.opr.xOf(k.pk, r);
    assert.deepEqual([x.placed, x.x], [false, null], `the bounty book does not reach the game (${JSON.stringify(x)})`);
  }
  const g = w.opr.xOf(game.pk, r);
  assert.equal(g.placed, true, g.why); assert.equal(g.x.username, 'alice');

  const srv = createServer((q, s) => w.opr.handle(q, s)); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const me = (kp) => fetch(`http://127.0.0.1:${srv.address().port}/api/opr/me`, { headers: { authorization: signIn(kp, { path: '/me', createdAt: Math.floor(w.clock.now() / 1000) }) } }).then((x) => x.json());
    const t = await me(typed);
    assert.equal(t.pubkey, typed.pk); assert.equal(t.x, null, 'no "✓ X @fexx_off" on the game screen'); assert.equal(t.placed, false);
    assert.equal((await me(coded)).x, null);
    assert.equal((await me(fresh)).x, null);
    const m = await me(game); assert.deepEqual(m.x, { username: 'alice' }); assert.equal(m.placed, true);
  } finally { srv.close(); }

  // the payout list places only the game link
  for (const k of [typed, game]) {
    assert.equal((await w.opr.saveLnAddress(k.pk, `p${k.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
    const s = await w.opr.startAttempt(k.pk, { round: r.id }); assert.equal(s.ok, true, s.why); w.clock.add(60000);
    assert.equal((await w.opr.submitChecked(k.pk, { attempt: s.attempt, token: s.token, log: logOf(k === typed ? 40 : 10) }, {})).ok, true);
  }
  w.clock.set(r.end_ms); await w.opr.tick(); w.clock.add(60 * MIN); await w.opr.tick();
  const rows = w.opr.listsOf(r.id).find((l) => l.kind === 'bounty').rows;
  assert.deepEqual(rows.map((x) => x.player), [game.pk], 'the bounty-book key is not on the X bounty list');
});

test('#3381 a game handle whose X account a bounty-book key holds saves, and the book key is not placed by it', async () => {
  const w = xWorld(); const r = await openRound(w);
  const book = keypair(), game = keypair();
  assert.equal(w.s2.claimName(book.pk, 'x', { userId: '1507727616706584576', username: 'fexx_off', nowMs: w.clock.now() }).ok, true);
  w.s2.record(book.pk, 'x', { member: true, nowMs: w.clock.now() });
  assert.equal((await w.opr.saveX(game.pk, 'fexx_off')).ok, true);
  assert.equal(w.opr.xOf(game.pk, r).placed, true);
  assert.equal(w.opr.xOf(book.pk, r).x, null);
});
