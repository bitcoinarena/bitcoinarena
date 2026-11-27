// AUDIT opr r2 #1: a stranger's late game X link (POST /x) to a Season 2 fallback winner's public handle takes that winner off a past round's
// waiting bounty list after the 1-hour grace - the #3286 rule ("a late link cannot change the waiting bounty list") holds only for the
// linking key itself. SAFE: a link made after r.end_ms + verifyGraceMs never changes who is placed in r.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, openRound, keypair, logOf, MIN } from './server-helpers.mjs';
import { DEFAULTS } from '../server/opr-service.mjs';

test('AUDIT a stranger linking a S2-fallback winner\'s X handle 2 h after the round does not move the bounty', async () => {
  const xs = new Map([['user1', 'x1'], ['attackerx', '999']]);
  const w = world({ start: '2026-11-23T01:00:00Z', xAccounts: xs, cfg: { entrySats: DEFAULTS.entrySats } });
  const r = await openRound(w);
  const victim = keypair(), rival = keypair(), stranger = keypair();
  w.link(victim.pk);   // x1 / user1, proven in the Season 2 book before #3331 (the fallback)
  assert.equal((await w.opr.saveX(rival.pk, 'attackerx')).ok, true);
  for (const k of [victim, rival]) assert.equal((await w.opr.saveLnAddress(k.pk, `p${k.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
  const play = async (kp, n) => { const s = await w.opr.startAttempt(kp.pk, { round: r.id }); assert.equal(s.ok, true, s.why); w.clock.add(MIN);
    const o = await w.opr.submitChecked(kp.pk, { attempt: s.attempt, token: s.token, log: logOf(n) }, {}); assert.equal(o.ok, true, o.why); };
  await play(victim, 40); await play(rival, 20);
  w.clock.set(r.end_ms); await w.opr.tick(); w.clock.add(60 * MIN); await w.opr.tick();
  const before = w.opr.listsOf(r.id).find((x) => x.kind === 'bounty');
  assert.equal(before.rows[0].player, victim.pk, 'the victim wins the bounty at list time');
  // 2 hours after the round: a fresh key links the victim's public handle as its own game X link
  w.clock.add(60 * MIN);
  assert.equal((await w.opr.saveX(stranger.pk, '@user1')).ok, true);
  // any refresh of the waiting list (here the rival re-saving its address) rebuilds it
  w.clock.add(10000);
  assert.equal((await w.opr.saveLnAddress(rival.pk, `q${rival.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
  const after = w.opr.listsOf(r.id).find((x) => x.kind === 'bounty');
  assert.notEqual(after.rows[0] && after.rows[0].player, rival.pk, `a stranger's link made 2 h after the round moved the waiting bounty row to the rival (victim: ${w.opr.xOf(victim.pk, r).why})`);
  assert.equal(after.rows[0] && after.rows[0].player, victim.pk, 'a link made after the grace moved the waiting bounty row');
});
