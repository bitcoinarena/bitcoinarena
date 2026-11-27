// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3248 pot split, #3250 X placement, bounty, sign-off; #3249 disqualify recalculates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, openRound, paidAttempt, keypair, logOf, at, MIN } from './server-helpers.mjs';
import { shares, splitFor } from '../server/opr-payout.mjs';

/** A round with players of the given press counts (score = 10 x presses); placed[i] links a verified X account; ln[i] saves a Lightning address (#3250). */
async function played(counts, placed = counts.map(() => true), { extraAttempts = 0, ln = placed.map((x) => x === true) } = {}) {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w);
  const ps = counts.map(() => keypair());
  for (const [i, p] of ps.entries()) {
    if (placed[i] === true) w.link(p.pk); else if (placed[i] === 'unverified') w.link(p.pk, false);
    if (ln[i]) assert.equal((await w.opr.saveLnAddress(p.pk, `player${i}@walletofsatoshi.com`)).ok, true);
    const a = await paidAttempt(w, p.pk, r.id); w.clock.add(60000);
    assert.equal(w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(counts[i], undefined, 37 + i) }).ok, true);
  }
  for (let k = 0; k < extraAttempts; k++) await paidAttempt(w, ps[0].pk, r.id);
  return { w, r, ps };
}
const endRound = async (w, r) => { w.clock.set(r.end_ms); await w.opr.tick(); w.clock.add(60 * MIN); await w.opr.tick(); };
const rowsOf = (w, r, kind) => (w.opr.listsOf(r.id).find((l) => l.kind === kind) || { rows: null }).rows;

test('#3248 split rules: 1 -> 100, 2 -> 60/40, 3+ -> 50/30/20; whole sats, the remainder to rank 1', () => {
  assert.deepEqual(splitFor(1), [100]); assert.deepEqual(splitFor(2), [60, 40]); assert.deepEqual(splitFor(7), [50, 30, 20]);
  assert.deepEqual(shares(700, [50, 30, 20]), [350, 210, 140]);
  assert.deepEqual(shares(333, [50, 30, 20]), [168, 99, 66]);
  assert.deepEqual(shares(101, [60, 40]), [61, 40]);
});

test('#3248 #3250 payout lists for 1, 2, 3 and 10 placed players; the bounty to rank 1', async () => {
  for (const [n, want] of [[1, [100]], [2, [120, 80]], [3, [150, 90, 60]], [10, [500, 300, 200]]]) {
    const counts = Array.from({ length: n }, (_, i) => 20 - i);
    const { w, r, ps } = await played(counts);
    await endRound(w, r);
    const pot = rowsOf(w, r, 'pot');
    assert.deepEqual(pot.map((x) => x.sats), want, `${n} players`);
    assert.deepEqual(pot.map((x) => x.player), ps.slice(0, Math.min(3, n)).map((p) => p.pk));
    assert.ok(pot.every((x) => x.xAccount && x.replay && x.flags && x.score > 0));
    assert.deepEqual(rowsOf(w, r, 'bounty').map((x) => [x.player, x.sats]), [[ps[0].pk, 2500]]);
    assert.ok(w.opr.listsOf(r.id).every((l) => l.state === 'waiting'));
  }
});

test('#3250 nobody without a verified X account is on a list: skipped, the next moves up; entries stay in the pot', async () => {
  const { w, r, ps } = await played([30, 25, 20, 15, 10], [false, 'unverified', true, true, true]);
  await endRound(w, r);
  const pot = rowsOf(w, r, 'pot');
  assert.deepEqual(pot.map((x) => [x.player, x.rank, x.place, x.sats]), [[ps[2].pk, 3, 1, 250], [ps[3].pk, 4, 2, 150], [ps[4].pk, 5, 3, 100]]);
  assert.equal(rowsOf(w, r, 'bounty')[0].player, ps[2].pk);
  const board = w.opr.publicBoard(r.id);
  assert.deepEqual(board.map((x) => x.placed), [false, false, true, true, true]);   // "not placed" on the board
});

test('#3248 none placed: the pot carries over to the next round', async () => {
  const { w, r } = await played([10, 9], [false, false]);
  await endRound(w, r);
  const pot = w.opr.listsOf(r.id).find((l) => l.kind === 'pot');
  assert.deepEqual(pot.rows, []); assert.equal(pot.carrySats, 200);
  assert.deepEqual(rowsOf(w, r, 'bounty'), []);
  const next = w.opr.roundRow('2026-11-24');
  assert.equal(w.opr.potOf(next.id), 0);   // #3266 not while the list waits: it could still be rebuilt to pay the pot
  assert.equal(w.opr.decideList({ round: r.id, kind: 'pot', action: 'approve', by: 'admin', version: (w.opr.listsOf(r.id).find((l) => l.kind === 'pot') || {}).version }).ok, true);
  assert.equal(w.opr.potOf(next.id), 200);
});

test('#3250 a bot on the bounty\'s list is not placed', async () => {
  const { w, r, ps } = await played([10, 9]);
  // the known-bot list (FAUCET_BOT_X_HANDLES; this world's list: every handle starting with "bot") against the game's own link (#3381)
  w.opr.db.prepare('UPDATE x_links SET username = ? WHERE pubkey = ?').run('bot_ps0', ps[0].pk); w.xs.set('bot_ps0', 'id-bot');
  await endRound(w, r);
  assert.equal(w.opr.xOf(ps[0].pk, r).why, 'a known bot account');
  assert.deepEqual(rowsOf(w, r, 'pot').map((x) => x.player), [ps[1].pk]);
});

test('#3250 no payout without an approval record: who and when; an approved list is never rewritten', async () => {
  const { w, r, ps } = await played([10, 9, 8]);
  await endRound(w, r);
  assert.deepEqual(w.opr.payable(), []);
  assert.equal(w.opr.decideList({ round: r.id, kind: 'pot', action: 'approve' }).ok, false);   // no "by"
  const ok = w.opr.decideList({ round: r.id, kind: 'pot', action: 'approve', by: 'owner', version: (w.opr.listsOf(r.id).find((l) => l.kind === 'pot') || {}).version });
  assert.equal(ok.ok, true);
  const pay = w.opr.payable();
  assert.equal(pay.length, 1); assert.equal(pay[0].kind, 'pot'); assert.equal(pay[0].approval.by, 'owner'); assert.equal(pay[0].approval.atMs, w.clock.now());
  assert.equal(w.opr.decideList({ round: r.id, kind: 'pot', action: 'reject', by: 'owner' }).ok, false);
  w.opr.disqualify({ round: r.id, player: ps[0].pk, why: 'late finding' });
  assert.equal(rowsOf(w, r, 'pot')[0].player, ps[0].pk);   // approved: frozen
  w.opr.decideList({ round: r.id, kind: 'bounty', action: 'reject', by: 'owner', why: 'test' });
  assert.deepEqual(w.opr.payable().map((l) => l.kind), ['pot']);
});

test('#3249 #3250 disqualify recalculates the waiting lists; a rejected row moves the next up; under review is held', async () => {
  const { w, r, ps } = await played([10, 9, 8, 7]);
  await endRound(w, r);
  assert.equal(w.opr.disqualify({ round: r.id, player: ps[0].pk }).ok, false);   // a reason is needed
  w.opr.disqualify({ round: r.id, player: ps[0].pk, why: 'exploit', by: 'owner' });
  assert.deepEqual(rowsOf(w, r, 'pot').map((x) => [x.player, x.sats]), [[ps[1].pk, 200], [ps[2].pk, 120], [ps[3].pk, 80]]);
  assert.equal(rowsOf(w, r, 'bounty')[0].player, ps[1].pk);
  assert.ok(!w.opr.boardOf(r.id).some((b) => b.player === ps[0].pk));
  w.opr.rejectRow({ round: r.id, kind: 'bounty', player: ps[1].pk, why: 'no proof', by: 'owner' });
  assert.equal(rowsOf(w, r, 'bounty')[0].player, ps[2].pk);
  assert.equal(rowsOf(w, r, 'pot')[0].player, ps[1].pk);   // a bounty row rejected leaves the pot list alone
  const best = w.opr.boardOf(r.id).find((b) => b.player === ps[2].pk);
  w.opr.review({ attempt: best.attempt, action: 'hold' });
  assert.deepEqual(rowsOf(w, r, 'pot').map((x) => x.player), [ps[1].pk, ps[3].pk]);
  w.opr.review({ attempt: best.attempt, action: 'clear' });
  assert.deepEqual(rowsOf(w, r, 'pot').map((x) => x.player), [ps[1].pk, ps[2].pk, ps[3].pk]);
});

// #3281 #3288 #3381: the X account is the game's own link (POST /x, checked on X at save time - no member read since #3381), made before the
// player's first run of the round; the lists are written 1 hour after the round. A key with no game link is not placed
test('#3250 the lists are written 1 hour after the round; only keys with the game\'s own X link are placed', async () => {
  const { w, r, ps } = await played([10, 9, 8], [true, 'unverified', 'unverified']);
  w.clock.set(r.end_ms); await w.opr.tick();
  assert.deepEqual(w.opr.listsOf(r.id), []);
  w.clock.add(60 * MIN); await w.opr.tick();
  assert.deepEqual(rowsOf(w, r, 'pot').map((x) => x.player), [ps[0].pk]);
  assert.equal(w.opr.xOf(ps[2].pk, r).why, 'no X account linked');
});

test('#3281 #3288 #3720 an X account linked after the key\'s first run of the round places it there, held for the owner (late-x)', async () => {
  const { w, r, ps } = await played([10, 9], [false, true]);
  w.link(ps[0].pk);   // proven and verified now, after its run
  await endRound(w, r);
  assert.deepEqual(rowsOf(w, r, 'pot').map((x) => x.player), []);   // the held late row above stops the list (#3332)
  assert.equal(w.opr.listsOf(r.id).find((l) => l.kind === 'pot').held[0].flag, 'late-x');
  assert.ok(w.opr.xOf(ps[0].pk, r).placed && w.opr.xOf(ps[0].pk, r).late);
  assert.equal(w.opr.xOf(ps[0].pk).placed, true);   // from the next round on
});

test('#3250 the bounty winner confirms the claim to the saved Lightning address within 7 days; nobody else can, no other address', async () => {
  const { w, r, ps } = await played([10, 9]);
  await endRound(w, r);
  assert.equal(w.opr.claimBounty(ps[1].pk, { round: r.id, lnAddress: 'a@b.io' }).ok, false);
  assert.match(w.opr.claimBounty(ps[0].pk, { round: r.id, lnAddress: 'other@walletofsatoshi.com' }).why, /not your saved Lightning address/);
  const c = w.opr.claimBounty(ps[0].pk, { round: r.id });   // the stored address is the default
  assert.equal(c.ok, true); assert.equal(c.lnAddress, 'player0@walletofsatoshi.com');
  assert.equal(w.opr.claimBounty(ps[0].pk, { round: r.id, lnAddress: 'Player0@walletofsatoshi.com' }).ok, true);
  w.clock.set(r.end_ms + 7 * 24 * 60 * MIN + 1);
  assert.match(w.opr.claimBounty(ps[0].pk, { round: r.id }).why, /expired/);
  void at;
});
