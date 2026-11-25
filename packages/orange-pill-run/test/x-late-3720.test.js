// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3720 (owner 2026-11-25 "Ja"): an X account saved after the player's first run counts for that round when it is saved before the round ends
// (the bounty box shows only after a run). #3281 stays covered: such a row is held ('late-x') until the owner clears its run; #3382, #3392, #3534 hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, openRound, keypair, logOf, MIN } from './server-helpers.mjs';
import { DEFAULTS } from '../server/opr-service.mjs';

const xWorld = () => world({ start: '2026-11-23T01:00:00Z', xAccounts: new Map([['alice', '222'], ['newbie', '444'], ['bitcoinarena_io', '999']]), cfg: { entrySats: DEFAULTS.entrySats } });
const play = async (w, kp, r, n) => {
  const s = await w.opr.startAttempt(kp.pk, { round: r.id });
  assert.equal(s.ok, true, s.why);
  w.clock.add(60000);
  const out = await w.opr.submitChecked(kp.pk, { attempt: s.attempt, token: s.token, log: logOf(n) }, {});
  assert.equal(out.ok, true, out.why);
};
const gap = (w) => w.clock.add(16000);
const bounty = (w, r) => w.opr.listsOf(r.id).find((x) => x.kind === 'bounty');

test('#3720 a new player saves X after its first run, before the round ends: placed in that round; its row is held until the owner clears the run, then paid', async () => {
  const w = xWorld(); const r = await openRound(w);
  const newbie = keypair(), early = keypair();
  assert.equal((await w.opr.saveX(early.pk, 'alice')).ok, true);
  for (const k of [newbie, early]) assert.equal((await w.opr.saveLnAddress(k.pk, `p${k.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
  await play(w, early, r, 10); await play(w, newbie, r, 12);   // close scores: no 'strong' flag (#3332)
  gap(w);
  assert.equal((await w.opr.saveX(newbie.pk, 'newbie')).ok, true);   // after its run: the box
  const x = w.opr.xOf(newbie.pk, r);
  assert.equal(x.placed, true, x.why);
  assert.ok(x.late, 'a link newer than the first run is marked late');
  w.clock.set(r.end_ms); await w.opr.tick(); w.clock.add(60 * MIN); await w.opr.tick();
  let l = bounty(w, r);
  assert.equal(l.rows.length, 0, 'nobody below the held late row moves up before the decision');
  assert.ok(l.waiting, 'the list waits for the owner');
  const h = l.held.find((y) => y.player === newbie.pk);
  assert.equal(h.flag, 'late-x'); assert.match(h.why, /saved \d+ min after this key's first run/);
  const best = w.opr.boardOf(r.id).find((b) => b.player === newbie.pk);
  assert.equal(w.opr.review({ attempt: best.attempt, action: 'clear', by: 'owner' }).ok, true);
  l = bounty(w, r);
  assert.equal(l.rows[0].player, newbie.pk, JSON.stringify(l));
  assert.equal(l.rows[0].xAccount, 'newbie');
});

test('#3720 an X account saved at or after the round\'s end does not count; one saved before the first run is not held', async () => {
  const w = xWorld(); const r = await openRound(w);
  const early = keypair(), after = keypair();
  assert.equal((await w.opr.saveX(early.pk, 'alice')).ok, true);
  await play(w, early, r, 10); await play(w, after, r, 30);
  w.clock.set(r.end_ms);
  assert.equal((await w.opr.saveX(after.pk, 'newbie')).ok, true);
  assert.equal(w.opr.xOf(after.pk, r).placed, false); assert.match(w.opr.xOf(after.pk, r).why, /after the round ended/);
  assert.equal(w.opr.xOf(early.pk, r).placed, true); assert.equal(w.opr.xOf(early.pk, r).late, undefined);
});

test('#3720 keeps #3382 and #3392: an account linked to a key with runs in the running round does not move to another key; the house account is refused', async () => {
  const w = xWorld(); const r = await openRound(w);
  const a = keypair(), b = keypair();
  await play(w, a, r, 20); await play(w, b, r, 25);
  assert.equal((await w.opr.saveX(a.pk, 'newbie')).ok, true);
  gap(w);
  const mv = await w.opr.saveX(b.pk, 'newbie');
  assert.equal(mv.code, 409); assert.match(mv.why, /already played today's round on another device/);
  assert.equal(w.opr.xOf(b.pk, r).placed, false);
  gap(w);
  const house = await w.opr.saveX(b.pk, '@bitcoinarena_io');
  assert.equal(house.code, 409); assert.match(house.why, /Bitcoin Arena account/);
});

test('#3720 keeps #3534: a late X account that does not follow is not placed (and so not flagged)', async () => {
  const w = xWorld(); const r = await openRound(w);
  const k = keypair();
  await play(w, k, r, 20);
  w.xNot.add('newbie');
  assert.equal((await w.opr.saveX(k.pk, 'newbie')).ok, true);
  const x = w.opr.xOf(k.pk, r);
  assert.equal(x.placed, false); assert.match(x.why, /does not follow/);
});
