// Audit (opr r2): the page telemetry `client` of a SCORED run is stored as sent; one field that is an object with its own "toString"
// (valid JSON) makes deviceOf / scoreRun throw in botsOf at list time, so the round's payout lists are never written and /admin/runs fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, openRound, keypair, logOf, MIN } from './server-helpers.mjs';

test('a scored run with a hostile telemetry object does not stop the payout lists of its round', async () => {
  const w = world({ cfg: { entrySats: 0 } });
  const r = await openRound(w);
  assert.equal(r.id, '2026-11-23');
  const honest = keypair(), attacker = keypair();
  w.link(honest.pk, true);
  w.clock.add(MIN);
  const h = await w.opr.startAttempt(honest.pk, { round: r.id });
  assert.ok(h.ok, h.why);
  w.clock.add(2 * MIN);
  const hs = w.opr.submit(honest.pk, { attempt: h.attempt, token: h.token, log: logOf(20), client: { ua: 'Mozilla/5.0 (iPhone)', w: 375, h: 559 } });
  assert.ok(hs.ok, hs.why);
  await w.opr.saveLnAddress(honest.pk, 'honest@wallet.example');

  // the attacker's own run, sent as JSON over POST /submit: the telemetry's ua is an object whose toString is not a function
  const a = await w.opr.startAttempt(attacker.pk, { round: r.id });
  assert.ok(a.ok, a.why);
  w.clock.add(2 * MIN);
  // (logOf(15), not 3: since the strong-run hold (suspiciously strong) a lone 20 far above every other run waits for the owner, kanban #3310)
  const body = JSON.parse(JSON.stringify({ attempt: a.attempt, token: a.token, log: logOf(15), client: { ua: { toString: 1, valueOf: 1 } } }));
  const as = w.opr.submit(attacker.pk, body);
  assert.ok(as.ok, `the hostile run is accepted and scored: ${as.why}`);

  // round end + the verify grace: the lists are made on the tick
  w.clock.set(r.end_ms + w.opr.cfg.verifyGraceMs + MIN);
  let err = null;
  try { await w.opr.tick(); } catch (e) { err = e; }
  assert.equal(err, null, `tick threw at list time: ${err && err.message}`);
  const lists = w.opr.listsOf(r.id);
  const bounty = lists.find((l) => l.kind === 'bounty');
  assert.ok(bounty, 'the bounty list of the round is written');
  assert.equal(bounty.rows[0] && bounty.rows[0].player, honest.pk, 'the honest placed player gets the bounty row');
});
