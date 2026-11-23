// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT (find-only, lens: Sybil and identity) - failing tests for the Orange Pill Run round service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { world, openRound, keypair, signIn, logOf, MIN } from './server-helpers.mjs';
import { DEFAULTS } from '../server/opr-service.mjs';

const freeWorld = (o = {}) => world({ start: '2026-11-23T01:00:00Z', ...o, cfg: { entrySats: DEFAULTS.entrySats, ...(o.cfg || {}) } });
// a human-like log: n presses, uneven gaps and holds (a seeded stream, so the run is the same each time)
let seedX = 12345; const rnd = () => { seedX = (seedX * 1103515245 + 12345) % 2147483648; return seedX / 2147483648; };
const humanLog = (n) => { let d = 30; const presses = []; for (let i = 0; i < n; i++) { d += 20 + Math.floor(rnd() * 50); const h = 3 + Math.floor(rnd() * 12); presses.push([d, d + h]); d += h; } return { v: 'opr-test-1', presses }; };
const play = async (w, kp, r, n, ip = null, human = false) => {
  const s = await w.opr.startAttempt(kp.pk, { round: r.id, ip });
  assert.equal(s.ok, true, s.why);
  w.clock.add(60000);
  const out = await w.opr.submitChecked(kp.pk, { attempt: s.attempt, token: s.token, log: human ? humanLog(n) : logOf(n) }, { ip });
  assert.equal(out.ok, true, out.why);
  return out;
};
const bountyWinner = (w, r) => { const l = w.opr.listsOf(r.id).find((x) => x.kind === 'bounty'); return l && l.rows[0] ? l.rows[0].player : null; };

test('AUDIT X grace: an X account linked hours after the round (list already written) still takes the bounty on the next list refresh', async () => {
  const w = freeWorld(); const r = await openRound(w);
  const honest = keypair(), late = keypair();
  w.link(honest.pk);
  assert.equal((await w.opr.saveLnAddress(honest.pk, 'honest@walletofsatoshi.com')).ok, true);
  assert.equal((await w.opr.saveLnAddress(late.pk, 'late@walletofsatoshi.com')).ok, true);   // address in time, no X yet
  await play(w, honest, r, 20); await play(w, late, r, 30);
  w.clock.set(r.end_ms); await w.opr.tick(); w.clock.add(60 * MIN); await w.opr.tick();     // list written at end + 1 h
  assert.equal(bountyWinner(w, r), honest.pk, 'the honest placed player wins the written list');
  w.clock.add(3 * 60 * MIN);                                                                  // end + 4 h: past the X grace of #3250
  w.link(late.pk);                                                                            // X linked and verified now
  assert.equal((await w.opr.saveLnAddress(late.pk, 'late@walletofsatoshi.com')).ok, true);  // any address save rebuilds every waiting list
  assert.equal(bountyWinner(w, r), honest.pk, 'an X link made after end + 1 h must not place the player (#3250: verify until 1 hour after the round)');
});

test('AUDIT X typed name (#3279, then #3381 "Bounty und Spiel müssen unabhängig sein"): a typed bounty-book link neither shows nor places; the game\'s own link places, proof "game"; one X account stays on one key', async () => {
  const w = freeWorld({ xAccounts: new Map([['typedname', 'x-typed']]) }); const r = await openRound(w);
  const first = keypair(), other = keypair();
  // a handle typed in the Season 2 social form: claimName links it with proof 'name' - in the bounty book only
  assert.equal(w.s2.claimName(first.pk, 'x', { userId: 'x-typed', username: 'typedname' }).ok, true);
  w.s2.record(first.pk, 'x', { member: true, nowMs: w.clock.now() });
  assert.deepEqual([w.opr.xOf(first.pk, r).placed, w.opr.xOf(first.pk, r).x], [false, null]);
  // the same handle saved in the game: placed; a second key saving the same account is refused once the first has played the round (#3382)
  assert.equal((await w.opr.saveX(first.pk, 'typedname')).ok, true);
  assert.equal((await w.opr.saveLnAddress(first.pk, 'first@walletofsatoshi.com')).ok, true);
  await play(w, first, r, 30);
  w.clock.add(16000);
  assert.equal((await w.opr.saveX(other.pk, 'typedname')).code, 409);
  w.clock.set(r.end_ms); await w.opr.tick(); w.clock.add(60 * MIN); await w.opr.tick();
  const x = w.opr.xOf(first.pk, r);
  assert.equal(x.placed, true, x.why);
  assert.equal(x.x.proof, 'game');
  assert.equal(bountyWinner(w, r), first.pk);
  const row = w.opr.listsOf(r.id).find((l) => l.kind === 'bounty').rows[0];
  assert.equal(row.xProof, 'game');
});

test('AUDIT Sybil: one person, six fresh keys from six addresses, 30 runs; the best key links the one X account in the grace hour and is paid unheld', async () => {
  const w = freeWorld(); const r = await openRound(w);
  const keys = Array.from({ length: 6 }, () => keypair());
  let best = null, bestN = 0;
  for (const [k, kp] of keys.entries()) for (let i = 0; i < 5; i++) { const n = 10 + k * 5 + i; await play(w, kp, r, n, `198.51.100.${k + 1}`, true); if (n > bestN) { bestN = n; best = kp; } }
  w.clock.set(r.end_ms); await w.opr.tick();
  w.clock.add(30 * MIN);                                    // inside the grace hour: link the X account to whichever key scored best
  w.link(best.pk);
  assert.equal((await w.opr.saveLnAddress(best.pk, 'me@walletofsatoshi.com')).ok, true);
  w.clock.add(30 * MIN); await w.opr.tick();
  const l = w.opr.listsOf(r.id).find((x) => x.kind === 'bounty');
  console.log(JSON.stringify({ rows: l.rows.map((x) => ({ p: x.player.slice(0, 8), score: x.score, bot: x.bot })), held: l.held }));
  // 30 runs stand behind one X account (6 x the 5-attempt rule). Nothing in the round ties them: the winner is listed, not held
  assert.ok(!(l.rows[0] && l.rows[0].player === best.pk), 'a key whose X link was made after all its runs (and after the round) should at least be held, not listed for payout');
});

test('AUDIT names: a player may take another player\'s exact name, or another key\'s default "player <8 hex>" name; the page marks rows as "me" by name', async () => {
  const w = freeWorld(); const r = await openRound(w);
  const victim = keypair(), copy = keypair();
  const srv = createServer((q, s) => w.opr.handle(q, s)); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port;
  const post = async (kp, path, b) => { const body = JSON.stringify(b);
    const res = await fetch(`http://127.0.0.1:${port}/api/opr${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: signIn(kp, { path, method: 'POST', body, createdAt: Math.floor(w.clock.now() / 1000) }) } });
    return res.json(); };
  try {
    const took = await post(copy, '/name', { name: `player ${victim.pk.slice(0, 8)}` });   // #3280: the default form is kept for players without a name
    assert.equal(took.ok, false, 'a key took another key\'s default name');
    await play(w, victim, r, 20); await play(w, copy, r, 20);
    const names = w.opr.publicBoard(r.id).map((b) => b.name);
    assert.equal(new Set(names).size, names.length, `two board rows show the same name: ${names.join(' | ')}`);
  } finally { srv.close(); }
});
