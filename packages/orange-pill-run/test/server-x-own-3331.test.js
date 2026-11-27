// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3331 (owner playtest 2026-11-22): the game keeps its own X link per game key, never tied to feedback reports. The inline check answered "that
// account is linked to another report key - not saved" for the owner's own handle, linked to his feedback key in the Season 2 book.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { world, openRound, keypair, signIn, logOf, proveX, MIN } from './server-helpers.mjs';
import { DEFAULTS } from '../server/opr-service.mjs';

const xWorld = (o = {}) => world({ start: '2026-11-23T01:00:00Z', xAccounts: new Map([['georgeprime', '111'], ['alice', '222'], ['botty', '333']]), ...o,
  cfg: { entrySats: DEFAULTS.entrySats, ...(o.cfg || {}) } });
const play = async (w, kp, r, n) => {
  const s = await w.opr.startAttempt(kp.pk, { round: r.id });
  assert.equal(s.ok, true, s.why);
  w.clock.add(60000);
  const out = await w.opr.submitChecked(kp.pk, { attempt: s.attempt, token: s.token, log: logOf(n) }, {});
  assert.equal(out.ok, true, out.why);
};
const gap = (w) => w.clock.add(16000);

test('#3331 a handle linked to a feedback key in the Season 2 book saves for a fresh game key; the feedback link does not count', async () => {
  const w = xWorld(); await openRound(w);
  const feedbackKey = keypair(), game = keypair();
  // kanban #3892 (2.0): 2.0's bounty book has no typed-name link (claimName, bounty-social.js, #2641 Week 2), so the book's link here is a code link
  assert.equal(proveX(w.s2, feedbackKey.pk, { userId: '111', username: 'georgeprime', nowMs: w.clock.now() }).ok, true);
  w.s2.record(feedbackKey.pk, 'x', { member: true, nowMs: w.clock.now() });
  const r = await w.opr.saveX(game.pk, '@GeorgePrime');
  assert.deepEqual(r, { ok: true, x: { username: 'GeorgePrime', follows: true } });
  assert.equal(w.s2.links(game.pk).length, 0, 'nothing written into the bug bounty book');
  assert.equal(w.s2.links(feedbackKey.pk)[0].userId, '111', 'the feedback link stays as it was');
  const x = w.opr.xOf(game.pk);
  assert.equal(x.placed, true, x.why); assert.equal(x.x.proof, 'game');
  // the feedback key's Season 2 link never places in the game (#3381)
  assert.equal(w.opr.xOf(feedbackKey.pk).placed, false);
});

test('#3331 a made-up handle is refused, nothing saved; the same handle on a second key moves (#3382); a bad name is not looked up', async () => {
  const w = xWorld(); await openRound(w);
  const a = keypair(), b = keypair();
  const no = await w.opr.saveX(a.pk, 'nosuchhandle_zz');
  assert.equal(no.ok, false); assert.equal(no.code, 404); assert.equal(no.why, 'no such X account');
  assert.equal(w.opr.xOf(a.pk).x, null);
  gap(w);
  assert.equal((await w.opr.saveX(a.pk, 'alice')).ok, true);
  // #3382: a has no attempt in the running round - the account moves to b (it was refused here before)
  const moved = await w.opr.saveX(b.pk, 'https://x.com/Alice');
  assert.equal(moved.ok, true, moved.why);
  assert.equal(w.opr.xOf(b.pk).x.userId, '222'); assert.equal(w.opr.xOf(a.pk).x, null);
  const n = w.xAsked.length;
  assert.equal((await w.opr.saveX(b.pk, 'bad name!')).why, 'Not an X username');
  assert.equal(w.xAsked.length, n);
});

test('#3331 one check every 15 s per key; X not reachable -> not saved, said plainly', async () => {
  const w = xWorld(); await openRound(w);
  const a = keypair();
  assert.equal((await w.opr.saveX(a.pk, 'nosuch1')).ok, false);
  const fast = await w.opr.saveX(a.pk, 'alice');
  assert.equal(fast.code, 429);
  gap(w); w.xs.set('*', 'down');
  const down = await w.opr.saveX(a.pk, 'alice');
  assert.equal(down.ok, false); assert.equal(down.code, 503); assert.match(down.why, /could not be checked/);
  w.xs.delete('*'); gap(w);
  assert.equal((await w.opr.saveX(a.pk, 'alice')).ok, true);
});

test('#3331 placement: linked before the first run of the round places; linked after it is held for the owner (#3720); a bot handle never; no follow asked', async () => {
  const w = xWorld(); const r = await openRound(w);
  const early = keypair(), late = keypair(), bot = keypair();
  assert.equal((await w.opr.saveX(early.pk, 'alice')).ok, true);
  assert.equal((await w.opr.saveX(bot.pk, 'botty')).ok, true);
  for (const k of [early, late, bot]) assert.equal((await w.opr.saveLnAddress(k.pk, `p${k.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
  await play(w, early, r, 10); await play(w, late, r, 30); await play(w, bot, r, 40);
  assert.equal((await w.opr.saveX(late.pk, 'georgeprime')).ok, true);
  assert.equal(w.opr.xOf(early.pk, r).placed, true);
  assert.ok(w.opr.xOf(late.pk, r).placed && w.opr.xOf(late.pk, r).late, '#3720: placed, marked late');
  assert.equal(w.opr.xOf(bot.pk, r).why, 'a known bot account');
  w.clock.set(r.end_ms); await w.opr.tick(); w.clock.add(60 * MIN); await w.opr.tick();
  const l = w.opr.listsOf(r.id).find((x) => x.kind === 'bounty');
  assert.equal(l.rows.length, 0); assert.ok(l.held.some((h) => h.player === late.pk && h.flag));   // #3720: the late row above waits for the owner
});

test('#3331 #3381 a key with a game link is placed (no Season 2 fallback since #3381); the same key re-saving its own handle keeps linked_ms', async () => {
  const w = xWorld(); const r = await openRound(w);
  const old = keypair(), mine = keypair();
  w.link(old.pk);   // the game's own link (#3381: the Season 2 book no longer counts)
  await play(w, old, r, 10);
  assert.equal(w.opr.xOf(old.pk, r).placed, true, w.opr.xOf(old.pk, r).why);
  assert.equal((await w.opr.saveX(mine.pk, 'alice')).ok, true);
  const t0 = w.opr.db.prepare('SELECT linked_ms FROM x_links WHERE pubkey = ?').get(mine.pk).linked_ms;
  await play(w, mine, r, 12); gap(w);
  assert.equal((await w.opr.saveX(mine.pk, '@ALICE')).ok, true);
  assert.equal(w.opr.db.prepare('SELECT linked_ms FROM x_links WHERE pubkey = ?').get(mine.pk).linked_ms, t0);
  assert.equal(w.opr.xOf(mine.pk, r).placed, true);
});

test('#3331 POST /x over HTTP: signed in, the answers as the page reads them', async () => {
  const w = xWorld(); await openRound(w);
  const srv = createServer((q, s) => w.opr.handle(q, s)); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const port = srv.address().port, kp = keypair();
    const post = async (body) => { const t = JSON.stringify(body);
      const r = await fetch(`http://127.0.0.1:${port}/api/opr/x`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: signIn(kp, { path: '/x', method: 'POST', body: t, createdAt: Math.floor(w.clock.now() / 1000) }) }, body: t });
      return [r.status, await r.json()]; };
    assert.deepEqual(await post({ x: 'nosuch' }), [404, { ok: false, why: 'no such X account', username: 'nosuch' }]);
    gap(w);
    assert.deepEqual(await post({ x: '@georgeprime' }), [200, { ok: true, x: { username: 'georgeprime', follows: true } }]);
    const me = await fetch(`http://127.0.0.1:${port}/api/opr/me`, { headers: { authorization: signIn(kp, { path: '/me', createdAt: Math.floor(w.clock.now() / 1000) }) } }).then((r) => r.json());
    assert.deepEqual(me.x, { username: 'georgeprime', follows: true }); assert.equal(me.placed, true);
  } finally { srv.close(); }
});
