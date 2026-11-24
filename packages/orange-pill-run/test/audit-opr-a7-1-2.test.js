// Audit opr a7-1-2: the leader's best run is a public replay during the round (#3336). A stranger opens it, submits the same presses on a fresh
// key, and the service marks the ORIGINAL run sameLog with review 'pending' (#3249 identical-logs signal): the honest leader is held 'under
// review' and the waiting bounty row goes to the next placed player - the copier never had to play.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { world, openRound, keypair, logOf, MIN } from './server-helpers.mjs';
import { DEFAULTS } from '../server/opr-service.mjs';

const gap = (w) => w.clock.add(16000);
const run = async (w, kp, r, log) => {
  const s = await w.opr.startAttempt(kp.pk, { round: r.id }); assert.equal(s.ok, true, s.why); w.clock.add(60000);
  const out = await w.opr.submitChecked(kp.pk, { attempt: s.attempt, token: s.token, log }, {});
  assert.equal(out.ok, true, out.why); return s.attempt;
};

test('a stranger who resubmits the leader\'s public replay does not put the leader\'s own run under review', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z', xAccounts: new Map([['alice', '222'], ['bob', '333']]), cfg: { entrySats: DEFAULTS.entrySats } });
  const r = await openRound(w);
  const leader = keypair(), rival = keypair(), copier = keypair();
  gap(w); assert.equal((await w.opr.saveX(leader.pk, 'alice')).ok, true);
  gap(w); assert.equal((await w.opr.saveX(rival.pk, 'bob')).ok, true);
  for (const k of [leader, rival]) { gap(w); assert.equal((await w.opr.saveLnAddress(k.pk, `p${k.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true); }
  const best = await run(w, leader, r, logOf(30));
  await run(w, rival, r, logOf(28));
  // the stranger: GET /board, GET /replay/<leader's best> (no sign-in), the same presses submitted from a fresh key
  const srv = createServer((q, s) => w.opr.handle(q, s)); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  let copied;
  try {
    const board = await (await fetch(`http://127.0.0.1:${srv.address().port}/board?round=${r.id}`)).json();
    assert.equal(board.board[0].replay, `/replay/${best}`);
    copied = (await (await fetch(`http://127.0.0.1:${srv.address().port}${board.board[0].replay}`)).json()).log;
  } finally { srv.close(); }
  await run(w, copier, r, copied);
  const review = w.opr.db.prepare('SELECT review FROM attempts WHERE id = ?').get(best).review;
  w.clock.set(w.opr.roundRow(r.id).end_ms); await w.opr.tick();
  w.clock.add(61 * MIN); await w.opr.tick();
  const bounty = w.opr.listsOf(r.id).find((x) => x.kind === 'bounty');
  assert.deepEqual(bounty.rows.map((x) => (x.player === leader.pk ? 'leader' : x.player === rival.pk ? 'rival' : 'copier')), ['leader'], `bounty row (leader's original run review: ${review}; held: ${JSON.stringify(bounty.held.map((h) => h.why))})`);
  assert.notEqual(review, 'pending', 'the leader\'s earlier original run is not put under review by a later copy');
});
