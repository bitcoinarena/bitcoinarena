// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3534 (owner 2026-11-23 ~18:10Z "X folgen Pflicht ab sofort"): a player is placed for the daily bounty only while the linked X account follows
// @bitcoinarena_io - from the running round on. The save keeps the link either way (a later Check finds the follow); the lists ask X again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { world, openRound, keypair, signIn, logOf, MIN } from './server-helpers.mjs';
import { DEFAULTS } from '../server/opr-service.mjs';

const xWorld = (start = '2026-11-23T18:20:00Z', cfg = {}) => world({ start, xAccounts: new Map([['alice', '111'], ['bob', '222'], ['carol', '333']]), cfg: { entrySats: DEFAULTS.entrySats, ...cfg } });
const gap = (w) => w.clock.add(16000);
async function play(w, r, kp, n) {
  assert.equal((await w.opr.saveLnAddress(kp.pk, `p${kp.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
  const s = await w.opr.startAttempt(kp.pk, { round: r.id }); assert.equal(s.ok, true, s.why); w.clock.add(60000);
  assert.equal((await w.opr.submitChecked(kp.pk, { attempt: s.attempt, token: s.token, log: logOf(n) }, {})).ok, true);
}

test('#3534 a handle that does not follow is saved with follows false and the follow message; not placed; Check again after following places it', async () => {
  const w = xWorld(); const r = await openRound(w);
  const a = keypair();
  w.xNot.add('alice');
  const s = await w.opr.saveX(a.pk, '@alice');
  assert.equal(s.ok, true); assert.deepEqual(s.x, { username: 'alice', follows: false });
  assert.equal(s.follow, '@alice does not follow @bitcoinarena_io yet - follow, then press Check again'); assert.equal(s.followUrl, 'https://x.com/bitcoinarena_io');
  let x = w.opr.xOf(a.pk, r);
  assert.equal(x.placed, false); assert.match(x.why, /does not follow @bitcoinarena_io/); assert.equal(x.x.follows, false);
  w.xNot.delete('alice'); gap(w);
  const s2 = await w.opr.saveX(a.pk, 'alice');
  assert.deepEqual([s2.ok, s2.x.follows, s2.follow], [true, true, undefined]);
  x = w.opr.xOf(a.pk, r); assert.equal(x.placed, true, x.why);
  // the link time is unchanged by the re-check (it still counts from before the first run)
  w.xNot.add('alice'); gap(w);
  assert.equal((await w.opr.saveX(a.pk, 'alice')).x.follows, false);
  assert.equal(w.opr.xOf(a.pk, r).placed, false, 'an unfollow seen at a Check loses the place');
});

test('#3534 the re-check is rate-limited like the save; X not answering keeps the last answer', async () => {
  const w = xWorld(); await openRound(w);
  const a = keypair();
  assert.equal((await w.opr.saveX(a.pk, 'alice')).x.follows, true);
  const again = await w.opr.saveX(a.pk, 'alice');
  assert.deepEqual([again.ok, again.code], [false, 429]);
  gap(w); w.xs.set('*', 'down');
  assert.equal((await w.opr.saveX(a.pk, 'alice')).code, 503);
  w.xs.delete('*');
  assert.equal(w.opr.xOf(a.pk).placed, true);
});

test('#3534 a link never asked about (saved before the rule) is not placed until asked; recheckUnchecked asks each once', async () => {
  const w = xWorld(); const r = await openRound(w);
  const a = keypair(), b = keypair();
  const ins = w.opr.db.prepare('INSERT INTO x_links (pubkey, user_id, username, linked_ms, checked_ms) VALUES (?, ?, ?, ?, ?)');
  ins.run(a.pk, '111', 'alice', w.clock.now() - 1000, w.clock.now()); ins.run(b.pk, '222', 'bob', w.clock.now() - 1000, w.clock.now());
  assert.match(w.opr.xOf(a.pk, r).why, /not checked yet whether @alice follows/);
  w.xNot.add('bob');
  const res = await w.opr.recheckUnchecked();
  assert.deepEqual([res.asked, res.follows, res.not, res.unread], [2, 1, 1, 0]);
  assert.equal(w.opr.xOf(a.pk, r).placed, true); assert.equal(w.opr.xOf(b.pk, r).placed, false);
  assert.equal((await w.opr.recheckUnchecked()).asked, 0, 'asked once');
});

test('#3534 a round that ended before the rule is not changed by it', async () => {
  const w = xWorld('2026-11-23T12:00:00Z', { followSince: '2026-11-24T00:00:00Z' }); const r = await openRound(w);   // the rule from the round's end on
  const a = keypair(); w.xNot.add('alice');
  await w.opr.saveX(a.pk, 'alice');
  assert.equal(r.end_ms, Date.parse('2026-11-24T00:00:00Z'));
  assert.equal(w.opr.xOf(a.pk, r).placed, true, 'round 5 and earlier: following was not asked');
  assert.equal(w.opr.xOf(a.pk).placed, false, '/me now: it is');
});

test('#3534 the list re-asks X at end+1h: the following key is placed, the one that unfollowed is not; a waiting list is re-asked later', async () => {
  const w = xWorld(); const r = await openRound(w);
  const a = keypair(), b = keypair(), c = keypair();
  for (const [k, h] of [[a, 'alice'], [b, 'bob'], [c, 'carol']]) { assert.equal((await w.opr.saveX(k.pk, h)).x.follows, true); gap(w); }
  await play(w, r, a, 34); await play(w, r, b, 32); await play(w, r, c, 30);
  w.xNot.add('alice');   // the best player unfollows before the list
  w.clock.set(r.end_ms); await w.opr.tick(); w.clock.add(60 * MIN); await w.opr.tick();
  let rows = w.opr.listsOf(r.id).find((l) => l.kind === 'bounty').rows;
  assert.deepEqual(rows.map((x) => x.player), [b.pk], 'alice no longer follows: bob wins');
  assert.equal(w.opr.xOf(a.pk, r).placed, false);
  // bob unfollows while the list waits: the next re-check (followEveryMs) moves carol up
  w.xNot.add('bob'); w.clock.add(DEFAULTS.followEveryMs + 1000);
  await w.opr.tick(); await new Promise((ok) => setTimeout(ok, 50)); await w.opr.tick();
  rows = w.opr.listsOf(r.id).find((l) => l.kind === 'bounty').rows;
  assert.deepEqual(rows.map((x) => x.player), [c.pk]);
  assert.ok(w.lines.some((l) => /#3534 re-check/.test(l)));
});

test('#3534 GET /me and POST /x over HTTP carry follows; the board marks a non-follower not placed', async () => {
  const w = xWorld(); const r = await openRound(w);
  const kp = keypair(); w.xNot.add('alice');
  const srv = createServer((q, s) => w.opr.handle(q, s)); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port;
  try {
    const body = JSON.stringify({ x: '@alice' });
    const p = await fetch(`http://127.0.0.1:${port}/api/opr/x`, { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: signIn(kp, { path: '/x', method: 'POST', body, createdAt: Math.floor(w.clock.now() / 1000) }) } });
    const pj = await p.json();
    assert.equal(p.status, 200); assert.deepEqual(pj.x, { username: 'alice', follows: false }); assert.match(pj.follow, /does not follow @bitcoinarena_io yet/);
    const me = await fetch(`http://127.0.0.1:${port}/api/opr/me`, { headers: { authorization: signIn(kp, { path: '/me', createdAt: Math.floor(w.clock.now() / 1000) }) } }).then((x) => x.json());
    assert.deepEqual(me.x, { username: 'alice', follows: false }); assert.equal(me.placed, false); assert.match(me.placedWhy, /follow, then press Check again/);
    await play(w, r, kp, 20);
    assert.equal(w.opr.publicBoard(r.id).find((b) => b.player === kp.pk).placed, false);
  } finally { srv.close(); }
});
