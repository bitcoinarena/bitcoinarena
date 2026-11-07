// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1342 slice 1: player feedback kept for review. A report is a Nostr event the player's key signs; the store takes it once, scrubbed of keys;
// "My feedback" answers only a NIP-98 sign-in by that key; a human moves the state by the table, and the store survives a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, networkPlayers, FEEDBACK_KIND, HTTP_AUTH_KIND, STATES } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, { kind = FEEDBACK_KIND, tags = [], content = '', created_at = Math.floor(Date.now() / 1000) } = {}) => {
  const e = { pubkey: k.pubkey, created_at, kind, tags, content };
  e.id = eventId(e);
  e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret));
  return e;
};
const report = (k, happened, more = {}) => signed(k, { tags: [['t', more.type || 'bug'], ['game', 'rock-paper-scissors'], ['round', 'ab'.repeat(32)], ['build', 'UI 577']],
  content: JSON.stringify({ happened, expected: more.expected || 'it to work' }), ...(more.created_at ? { created_at: more.created_at } : {}) });
const URL_MINE = 'https://faucet.example/feedback/mine';
const auth = (k, over = {}) => signed(k, { kind: HTTP_AUTH_KIND, tags: [['u', over.u || URL_MINE], ['method', over.method || 'GET']], created_at: over.created_at || Math.floor(Date.now() / 1000) });

test('#1342 a signed report is kept once, scrubbed of keys; a forged, old, wrong-kind or empty one is refused', () => {
  const s = openFeedbackStore();
  const alice = key(1);
  const e = report(alice, 'The withdraw button did nothing. My seed was abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const first = s.take(e), again = s.take(e);
  const forged = { ...e, content: JSON.stringify({ happened: 'changed after signing', expected: '' }) };
  const otherKey = { ...e, pubkey: key(2).pubkey };
  const old = report(alice, 'old report', { created_at: Math.floor(Date.now() / 1000) - 2 * 86400 });
  const note = signed(alice, { kind: 1, content: 'hello' });
  const empty = report(alice, '  ');
  const badType = signed(alice, { tags: [['t', 'praise']], content: JSON.stringify({ happened: 'nice game' }) });
  const refused = Object.fromEntries(Object.entries({ forged, otherKey, old, note, empty, badType }).map(([k, x]) => [k, s.take(x).why]));
  const kept = s.report(e.id);
  console.log('  FACTS #1342 intake:', JSON.stringify({ first, again, refused, keptText: kept.happened, state: kept.state }));
  assert.deepEqual([first.ok, first.kept, again.ok, again.kept], [true, true, true, false]);
  for (const [k, why] of Object.entries(refused)) assert.ok(why, `${k} was taken`);
  assert.match(kept.happened, /\[removed\]/, 'the seed phrase is not kept');
  assert.doesNotMatch(kept.happened, /abandon abandon/);
  assert.equal(kept.state, STATES.NEW);
  assert.deepEqual([kept.game, kept.round.length, kept.build], ['rock-paper-scissors', 64, 'UI 577']);
});

test('#1342 "My feedback" answers only a fresh NIP-98 sign-in by the reporter, for this address and method', () => {
  const s = openFeedbackStore();
  const alice = key(1), bob = key(2);
  s.take(report(alice, 'first thing broke')); s.take(report(alice, 'second thing broke')); s.take(report(bob, 'bob found something'));
  const own = s.mine(auth(alice), { url: URL_MINE });
  const tries = {
    otherUrl: s.mine(auth(alice, { u: 'https://faucet.example/feedback/all' }), { url: URL_MINE }).why,
    post: s.mine(auth(alice, { method: 'POST' }), { url: URL_MINE }).why,
    stale: s.mine(auth(alice, { created_at: Math.floor(Date.now() / 1000) - 300 }), { url: URL_MINE }).why,
    aReport: s.mine(report(alice, 'not a sign-in'), { url: URL_MINE }).why,
    tampered: s.mine({ ...auth(alice), pubkey: bob.pubkey }, { url: URL_MINE }).why,
  };
  console.log('  FACTS #1342 mine:', JSON.stringify({ aliceSees: own.reports.map((r) => r.happened), refused: tries }));
  assert.equal(own.ok, true);
  assert.deepEqual(own.reports.map((r) => r.pubkey === alice.pubkey), [true, true], 'only her own reports');
  for (const [k, why] of Object.entries(tries)) assert.ok(why, `${k} was let in`);
});

test('#1342 a human moves the state by the table: a rejection says why, a duplicate names the earlier report; nothing else moves', () => {
  const s = openFeedbackStore();
  const alice = key(1), bob = key(2);
  const a = report(alice, 'the lobby froze after join', { created_at: Math.floor(Date.now() / 1000) - 60 });
  const b = report(bob, 'the lobby froze after I joined');
  s.take(a, { nowMs: Date.now() - 60000 }); s.take(b);
  const steps = {
    rejectNoReason: s.move(a.id, STATES.REJECTED).why,
    dupOfLater: s.move(a.id, STATES.DUPLICATE, { duplicateOf: b.id }).why,
    dupOfSelf: s.move(b.id, STATES.DUPLICATE, { duplicateOf: b.id }).why,
    newToPaid: s.move(a.id, STATES.PAID).why,
    dup: s.move(b.id, STATES.DUPLICATE, { duplicateOf: a.id, by: 'admin' }).ok,
    dupAgain: s.move(b.id, STATES.ACCEPTED).why,
    acceptByMove: s.move(a.id, STATES.ACCEPTED).why,
    accept: s.approve(a.id, 1000, { played: () => true, by: 'admin' }).ok,
  };
  console.log('  FACTS #1342 moves:', JSON.stringify(steps));
  assert.ok(steps.rejectNoReason && steps.dupOfLater && steps.dupOfSelf && steps.newToPaid && steps.dupAgain && steps.acceptByMove);
  assert.deepEqual([steps.dup, steps.accept], [true, true]);
  assert.deepEqual([s.report(a.id).state, s.report(b.id).state, s.report(b.id).duplicateOf], [STATES.ACCEPTED, STATES.DUPLICATE, a.id]);
  assert.deepEqual(s.list({ state: 'accepted' }).map((r) => r.id), [a.id]);
});

test('#1342 the reports outlive a restart: the same file reopened holds them with their states', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-1342-'));
  try {
    const path = join(dir, 'feedback.db');
    const alice = key(1);
    const e = report(alice, 'kept across a restart');
    const s1 = openFeedbackStore(path); s1.take(e); s1.approve(e.id, 1000, { played: () => true, by: 'admin' }); s1.close();
    const s2 = openFeedbackStore(path);
    const r = s2.report(e.id);
    console.log('  FACTS #1342 restart:', JSON.stringify({ kept: !!r, state: r && r.state }));
    assert.deepEqual([r.happened, r.state], ['kept across a restart', STATES.ACCEPTED]);
    s2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- slice 2: only real feedback from real players gets money ----
test('#1342 approval for money: a player who finished a round, not ours, not a duplicate, within the per-key and weekly caps and the amount range', () => {
  const s = openFeedbackStore();
  const player = key(1), stranger = key(2), bot = key(3), second = key(4);
  const played = (k) => [player.pubkey, bot.pubkey, second.pubkey].includes(k);
  const excluded = new Set([bot.pubkey]);
  const rules = { perKeyPerWeek: 3, weeklyBudgetSats: 11000, mostSats: 5000, leastSats: 100 };
  const take = (k, w) => { const e = report(k, w); s.take(e); return e.id; };
  const ids = { p1: take(player, 'bug one in the lobby'), p2: take(player, 'bug two in the lobby'), p3: take(player, 'bug three'), p4: take(player, 'bug four'),
    st: take(stranger, 'never played, wants sats'), bt: take(bot, 'our own bot reports'), s1: take(second, 'the same lobby bug'), s2: take(second, 'another real bug') };
  s.move(ids.s1, STATES.DUPLICATE, { duplicateOf: ids.p1 });
  const ask = (id, sats) => { const r = s.approve(id, sats, { played, excluded, rules }); return r.ok ? `ok ${r.report.amountSats}` : r.why; };
  const steps = {
    stranger: ask(ids.st, 1000), bot: ask(ids.bt, 1000), duplicate: ask(ids.s1, 1000), tooMuch: ask(ids.p1, 6000), tooLittle: ask(ids.p1, 10),
    p1: ask(ids.p1, 5000), p2: ask(ids.p2, 1000), p3: ask(ids.p3, 1000), p4: ask(ids.p4, 1000), again: ask(ids.p1, 1000),
    budget: ask(ids.s2, 5000), withinBudget: ask(ids.s2, 4000),
  };
  console.log('  FACTS #1342 approve:', JSON.stringify(steps));
  assert.match(steps.stranger, /not finished a round/);
  assert.match(steps.bot, /ours/);
  assert.match(steps.duplicate, /duplicate/);
  assert.match(steps.tooMuch, /100 to 5000 sat/);
  assert.match(steps.tooLittle, /100 to 5000 sat/);
  assert.deepEqual([steps.p1, steps.p2, steps.p3], ['ok 5000', 'ok 1000', 'ok 1000']);
  assert.match(steps.p4, /3 rewards this week: at most 3/);
  assert.match(steps.again, /an accepted report is not approved/);
  assert.match(steps.budget, /this week's budget: 7000 of 11000 sat approved, 5000 more does not fit/);
  assert.equal(steps.withinBudget, 'ok 4000', 'what fits the budget exactly is approved');
  assert.equal(s.report(ids.st).state, STATES.NEW, 'a refused approval moves nothing');
});

test('#1342 networkPlayers reads each game\'s network board from the first seat that answers: a key with rounds counts, one with 0 does not', async () => {
  const A = 'a1'.repeat(32), B = 'b2'.repeat(32), C = 'c3'.repeat(32);
  const asked = [];
  const fetcher = async (url) => { asked.push(url); if (url.startsWith('https://down')) throw new Error('down');
    const game = new URL(url).searchParams.get('game');
    return new Response(JSON.stringify({ rows: game === 'rock-paper-scissors' ? [{ player: A, rounds: 3 }, { player: C, rounds: 0 }] : [{ player: B.toUpperCase(), rounds: 1 }] }), { status: 200 }); };
  const np = networkPlayers({ seats: ['https://down.example', 'https://seat.example/'], games: ['rock-paper-scissors', 'nextblock'], fetcher });
  const n = await np.fresh();
  console.log('  FACTS #1342 players:', JSON.stringify({ n, A: np.played(A), B: np.played(B), C: np.played(C), asked: asked.length }));
  assert.equal(n, 2);
  assert.deepEqual([np.played(A), np.played(B), np.played(C)], [true, true, false]);
  assert.match(asked[1], /scope=network&game=rock-paper-scissors&days=90/);
});
