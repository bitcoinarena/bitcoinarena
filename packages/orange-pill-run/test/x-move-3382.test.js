// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3382 (owner 2026-11-23, his own second device refused "@x is already used by another player"): an X account moves to a new game key while the
// key holding it has no attempt in the running round; refused while it has one. A finished round's list keeps its rows; one account places one
// key per round, however often it moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, openRound, keypair, logOf, MIN } from './server-helpers.mjs';
import { DEFAULTS } from '../server/opr-service.mjs';

const xWorld = () => world({ start: '2026-11-23T01:00:00Z', xAccounts: new Map([['georgeprime', '111'], ['alice', '222']]), cfg: { entrySats: DEFAULTS.entrySats } });
const gap = (w) => w.clock.add(16000);
const start = async (w, kp, r) => { const s = await w.opr.startAttempt(kp.pk, { round: r.id }); assert.equal(s.ok, true, s.why); return s; };
const play = async (w, kp, r, n) => {
  const s = await start(w, kp, r); w.clock.add(60000);
  const out = await w.opr.submitChecked(kp.pk, { attempt: s.attempt, token: s.token, log: logOf(n) }, {});
  assert.equal(out.ok, true, out.why);
};
const save = async (w, kp, h) => { gap(w); return w.opr.saveX(kp.pk, h); };
const row = (w, pk) => w.opr.db.prepare('SELECT * FROM x_links WHERE pubkey = ?').get(pk);

test('#3382 the key holding the account has not played the running round: the account moves, the old row is kept released, the move recorded', async () => {
  const w = xWorld(); const r = await openRound(w);
  const a = keypair(), b = keypair();
  assert.equal((await save(w, a, 'alice')).ok, true);
  const t = w.clock.now() + 16000;
  const m = await save(w, b, '@Alice');
  assert.deepEqual(m, { ok: true, x: { username: 'Alice', follows: true } });
  assert.equal(w.opr.xOf(a.pk).x, null); assert.equal(w.opr.xOf(a.pk).why, 'no X account linked');
  assert.equal(w.opr.xOf(b.pk, r).placed, true);
  assert.equal(row(w, b.pk).linked_ms, t);
  assert.match(row(w, a.pk).user_id, /^released-/, 'a\'s row is kept, released');
  const mv = w.opr.db.prepare('SELECT * FROM x_link_moves').all();
  assert.equal(mv.length, 1); assert.equal(mv[0].from_pubkey, a.pk); assert.equal(mv[0].to_pubkey, b.pk); assert.equal(mv[0].user_id, '222');
  assert.ok(w.lines.some((l) => /moved from/.test(l)));
});

test('#3382 the holder has an attempt in the running round (started, not yet played out, too): refused, saying why; nothing changes', async () => {
  const w = xWorld(); const r = await openRound(w);
  const a = keypair(), b = keypair();
  assert.equal((await save(w, a, 'alice')).ok, true);
  await start(w, a, r);
  const no = await save(w, b, 'alice');
  assert.equal(no.ok, false); assert.equal(no.code, 409);
  assert.equal(no.why, "@alice already played today's round on another device - try again after the round ends");
  assert.ok(no.why.length <= 100, 'the page shows the first 100 characters');
  assert.equal(w.opr.xOf(b.pk).x, null); assert.equal(w.opr.xOf(a.pk).x.userId, '222');
  assert.equal(w.opr.db.prepare('SELECT COUNT(*) AS n FROM x_link_moves').get().n, 0);
});

test('#3382 after the round ends the account moves; the finished round keeps the old key placed, its list keeps its rows, the new key is not placed there', async () => {
  const w = xWorld(); const r = await openRound(w);
  const a = keypair(), b = keypair();
  assert.equal((await save(w, a, 'alice')).ok, true);
  for (const k of [a, b]) assert.equal((await w.opr.saveLnAddress(k.pk, `p${k.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
  await play(w, a, r, 10); await play(w, b, r, 30);
  assert.equal((await save(w, b, 'alice')).ok, false, 'refused while the round runs');
  w.clock.set(r.end_ms); await w.opr.tick();
  assert.equal((await save(w, b, 'alice')).ok, true, 'moves once the round has ended');
  assert.equal(w.opr.xOf(a.pk, r).placed, true, 'a made every run of r while holding it');
  assert.match(w.opr.xOf(b.pk, r).why, /after your first run/);
  w.clock.add(60 * MIN); await w.opr.tick();
  const list = () => w.opr.listsOf(r.id).find((x) => x.kind === 'bounty');
  assert.deepEqual(list().rows.map((x) => x.player), [a.pk]);
  // a move after the list is made changes nothing either (any save rebuilds a waiting list)
  const c = keypair();
  assert.equal((await save(w, c, 'alice')).ok, true);
  assert.equal((await w.opr.saveLnAddress(b.pk, `q${b.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
  assert.deepEqual(list().rows.map((x) => x.player), [a.pk]);
  assert.equal(w.opr.xOf(a.pk).x, null, 'from the move on a shows no link');
});

test('#3382 abuse: one account moving back and forth within one round places at most one key in it', async () => {
  const w = xWorld(); const r = await openRound(w);
  const a = keypair(), b = keypair(), c = keypair();
  for (const k of [a, b, c]) assert.equal((await w.opr.saveLnAddress(k.pk, `p${k.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
  assert.equal((await save(w, a, 'alice')).ok, true);
  assert.equal((await save(w, b, 'alice')).ok, true);   // a has not played: moves
  assert.equal((await save(w, a, 'alice')).ok, true);   // b has not played: back to a
  await play(w, a, r, 10);
  assert.equal((await save(w, b, 'alice')).ok, false);  // a has played: locked for the round
  assert.equal((await save(w, c, 'alice')).ok, false);
  await play(w, b, r, 30); await play(w, c, r, 40);
  // the other way round: b takes it before playing, plays; then neither a nor c can take it back
  const d = keypair(), e = keypair();
  assert.equal((await save(w, d, 'georgeprime')).ok, true);
  assert.equal((await save(w, e, 'georgeprime')).ok, true);
  await play(w, e, r, 20);
  assert.equal((await save(w, d, 'georgeprime')).ok, false);
  await play(w, d, r, 50);
  const placed = (who) => who.filter((k) => w.opr.xOf(k.pk, r).placed).map((k) => k.pk);
  assert.deepEqual(placed([a, b, c]), [a.pk]);
  assert.deepEqual(placed([d, e]), [e.pk]);
  w.clock.set(r.end_ms); await w.opr.tick();
  // after the end: moves again, and still one key per account in r
  assert.equal((await save(w, b, 'alice')).ok, true);
  assert.equal((await save(w, d, 'georgeprime')).ok, true);
  assert.deepEqual(placed([a, b, c]), [a.pk]);
  assert.deepEqual(placed([d, e]), [e.pk]);
  w.clock.add(60 * MIN); await w.opr.tick();
  // every row of the lists is a placed key: a or e (b, c, d scored higher than a but hold no account for r)
  const lists = w.opr.listsOf(r.id);
  assert.ok(lists.reduce((n, l) => n + l.rows.length, 0) >= 1, 'a list has rows');
  for (const l of lists) for (const x of l.rows) assert.ok([a.pk, e.pk].includes(x.player), `${l.kind} row ${x.player.slice(0, 8)} is not placed`);
});

test('#3382 a row released by hand (user_id "released-...", username renamed) is no link and does not break a save', async () => {
  const w = xWorld(); await openRound(w);
  const old = keypair(), b = keypair();
  w.opr.db.prepare('INSERT INTO x_links (pubkey, user_id, username, linked_ms, checked_ms) VALUES (?, ?, ?, ?, ?)')
    .run(old.pk, 'released-111', 'released-owner-20261123-georgeprime', w.clock.now() - 3600000, w.clock.now() - 3600000);
  assert.equal(w.opr.xOf(old.pk).x, null);
  assert.equal((await save(w, b, 'georgeprime')).ok, true);
  assert.equal(w.opr.xOf(b.pk).x.userId, '111');
  assert.equal((await save(w, old, 'georgeprime')).ok, true, 'b has not played: it moves to the old key again');
  assert.equal(w.opr.xOf(old.pk).x.username, 'georgeprime');
});
