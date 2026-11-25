// Audit opr a8-2-1: the leader's best run is a public replay during the round (#3336). #3580 made an exact copy harmless (the later copy is
// flagged sameLog, review 'pending', held 'under review'). A stranger who instead takes the public log and changes it a little so that it
// scores just above the leader (here: the same presses plus one more - with the real sim, a small local search around the public run that
// avoids one hit or finishes a little sooner) is never held: its log hash differs (no sameLog, review 'none'), the near-copy signal
// (nearOther) adds 40 points, below HOLD_ABOVE 70, and a run only just above the leader is neither 'suspiciously strong' by the field ratio
// nor by the ceiling. The copier's key takes rank 1 and the waiting bounty row; the honest leader who played the run gets nothing.
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

test('a near copy of the leader\'s public replay, tweaked to score just above it, does not take the bounty row unheld', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z', xAccounts: new Map([['alice', '222'], ['bob', '333'], ['carol', '444']]), cfg: { entrySats: DEFAULTS.entrySats } });
  const r = await openRound(w);
  const leader = keypair(), rival = keypair(), copier = keypair();
  gap(w); assert.equal((await w.opr.saveX(leader.pk, 'alice')).ok, true);
  gap(w); assert.equal((await w.opr.saveX(rival.pk, 'bob')).ok, true);
  gap(w); assert.equal((await w.opr.saveX(copier.pk, 'carol')).ok, true);   // any following X account, linked before the copier's first run
  for (const k of [leader, rival, copier]) { gap(w); assert.equal((await w.opr.saveLnAddress(k.pk, `p${k.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true); }
  const best = await run(w, leader, r, logOf(30));
  await run(w, rival, r, logOf(28));
  // the stranger: GET /board, GET /replay/<leader's best> (no sign-in)
  const srv = createServer((q, s) => w.opr.handle(q, s)); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  let copied;
  try {
    const board = await (await fetch(`http://127.0.0.1:${srv.address().port}/board?round=${r.id}`)).json();
    assert.equal(board.board[0].replay, `/replay/${best}`);
    copied = (await (await fetch(`http://127.0.0.1:${srv.address().port}${board.board[0].replay}`)).json()).log;
  } finally { srv.close(); }
  // the copy, tweaked: the leader's presses and one more after the last (nearLogs: within the 5 % length window, every compared press equal)
  const last = copied.presses[copied.presses.length - 1];
  const tweaked = { v: copied.v, presses: [...copied.presses, [last[1] + 20, last[1] + 26]] };
  const cp = await run(w, copier, r, tweaked);
  const a = w.opr.db.prepare('SELECT review, flags, near_rep FROM attempts WHERE id = ?').get(cp);
  w.clock.set(w.opr.roundRow(r.id).end_ms); await w.opr.tick();
  w.clock.add(61 * MIN); await w.opr.tick();
  const bounty = w.opr.listsOf(r.id).find((x) => x.kind === 'bounty');
  const who = (p) => (p === leader.pk ? 'leader' : p === rival.pk ? 'rival' : 'copier');
  assert.notDeepEqual(bounty.rows.map((x) => who(x.player)), ['copier'],
    `the near copy of the leader's public run is paid unheld (copy review ${a.review}, flags ${a.flags}, near group of the leader's run: ${a.near_rep === best}; bot ${JSON.stringify(bounty.rows[0] && bounty.rows[0].bot)}; held ${JSON.stringify(bounty.held.map((h) => h.why))})`);
});

test('#3747 the near copy is held for the owner, never refused: the leader keeps the bounty row and its review, the owner can clear the copy', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z', xAccounts: new Map([['alice', '222'], ['bob', '333'], ['carol', '444']]), cfg: { entrySats: DEFAULTS.entrySats } });
  const r = await openRound(w);
  const leader = keypair(), rival = keypair(), copier = keypair();
  for (const [k, x] of [[leader, 'alice'], [rival, 'bob'], [copier, 'carol']]) { gap(w); assert.equal((await w.opr.saveX(k.pk, x)).ok, true); }
  for (const k of [leader, rival, copier]) { gap(w); assert.equal((await w.opr.saveLnAddress(k.pk, `p${k.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true); }
  const best = await run(w, leader, r, logOf(30));
  const rv = await run(w, rival, r, logOf(28));
  const lg = logOf(30), last = lg.presses[lg.presses.length - 1];
  const cp = await run(w, copier, r, { v: lg.v, presses: [...lg.presses, [last[1] + 20, last[1] + 26]] });
  const row = (id) => { const x = w.opr.db.prepare('SELECT state, review, flags FROM attempts WHERE id = ?').get(id); return { ...x, flags: JSON.parse(x.flags) }; };
  assert.equal(row(cp).state, 'scored', 'the copy is scored, not refused');
  assert.equal(row(cp).review, 'pending'); assert.equal(row(cp).flags.nearCopy, best);
  assert.equal(row(best).review, 'none', 'the original keeps its review'); assert.equal(row(best).flags.nearCopied, 1);
  assert.equal(row(rv).review, 'none', 'a run of its own is not flagged');
  w.clock.set(w.opr.roundRow(r.id).end_ms); await w.opr.tick();
  w.clock.add(61 * MIN); await w.opr.tick();
  const who = (p) => (p === leader.pk ? 'leader' : p === rival.pk ? 'rival' : 'copier');
  let bounty = w.opr.listsOf(r.id).find((x) => x.kind === 'bounty');
  assert.deepEqual(bounty.rows.map((x) => who(x.player)), ['leader']);
  assert.ok(bounty.held.some((h) => who(h.player) === 'copier' && /under review/.test(JSON.stringify(h))), JSON.stringify(bounty.held));
  // the owner looks at it and clears it (it was played): the copy counts again
  assert.equal(w.opr.review({ attempt: cp, action: 'clear' }).ok, true);
  bounty = w.opr.listsOf(r.id).find((x) => x.kind === 'bounty');
  assert.deepEqual(bounty.rows.map((x) => who(x.player)), ['copier']);
});
