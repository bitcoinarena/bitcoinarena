// Audit opr a7-1-1: #3367/#3382 bypass. A finished round keeps a moved-away key placed (heldFor), but that key's "follows @bitcoinarena_io"
// (#3534) is read from whatever x_links row holds the account's user id NOW. A stranger moves the winner's account to a throwaway key after
// the round, then links the throwaway key to another X account: no row holds the user id any more, follows reads null, and the winner drops
// off the waiting bounty list at the next rebuild (any board player's POST /lnaddress).
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, openRound, keypair, logOf, MIN } from './server-helpers.mjs';
import { DEFAULTS } from '../server/opr-service.mjs';

const gap = (w) => w.clock.add(16000);
const save = async (w, kp, h) => { gap(w); return w.opr.saveX(kp.pk, h); };
const play = async (w, kp, r, n) => {
  const s = await w.opr.startAttempt(kp.pk, { round: r.id }); assert.equal(s.ok, true, s.why); w.clock.add(60000);
  const out = await w.opr.submitChecked(kp.pk, { attempt: s.attempt, token: s.token, log: logOf(n) }, {});
  assert.equal(out.ok, true, out.why);
};

test('a stranger\'s move-and-relink after the round does not take the honest winner off the waiting bounty list', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z', xAccounts: new Map([['alice', '222'], ['bob', '333'], ['carol', '444']]), cfg: { entrySats: DEFAULTS.entrySats } });
  const r = await openRound(w);
  const winner = keypair(), rival = keypair(), stranger = keypair();
  assert.equal((await save(w, winner, 'alice')).ok, true);
  assert.equal((await save(w, rival, 'bob')).ok, true);
  for (const k of [winner, rival]) assert.equal((await w.opr.saveLnAddress(k.pk, `p${k.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
  await play(w, winner, r, 30); await play(w, rival, r, 28);
  w.clock.set(r.end_ms); await w.opr.tick();
  w.clock.add(61 * MIN); await w.opr.tick();
  const bounty = () => w.opr.listsOf(r.id).find((x) => x.kind === 'bounty');
  assert.deepEqual(bounty().rows.map((x) => x.player), [winner.pk], `the winner holds the bounty row (${JSON.stringify(bounty().waiting)} ${JSON.stringify(bounty().held)})`);
  // the stranger: two POST /x calls, the winner's public handle, then any other account
  assert.equal((await save(w, stranger, 'alice')).ok, true, 'the account moves (winner not playing now)');
  assert.equal((await save(w, stranger, 'carol')).ok, true, 'the stranger links another account');
  // any board player's address save rebuilds the waiting list
  gap(w); assert.equal((await w.opr.saveLnAddress(rival.pk, `q${rival.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
  const x = w.opr.xOf(winner.pk, r);
  assert.deepEqual(bounty().rows.map((y) => y.player === winner.pk ? 'winner' : y.player === rival.pk ? 'rival' : y.player), ['winner'], `the bounty row stays with the winner (winner: ${x.why})`);
  assert.equal(x.placed, true, `the winner is still placed in the finished round (got: ${x.why})`);
});
