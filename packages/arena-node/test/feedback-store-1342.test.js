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
import { openFeedbackStore, networkPlayers, FEEDBACK_KIND, HTTP_AUTH_KIND, STATES, REWARD_LEVELS, NODE_BOUNTY_BASE_SATS } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, { kind = FEEDBACK_KIND, tags = [], content = '', created_at = Math.floor(Date.now() / 1000) } = {}) => {
  const e = { pubkey: k.pubkey, created_at, kind, tags, content };
  e.id = eventId(e);
  e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret));
  return e;
};
// A REPORT SAYS ENOUGH (at least 50 characters, Daniel 2026-11-07): every test text gets its steps; an empty one stays empty
const STEPS = ' Steps: opened the lobby, joined a round, watched the screen.';
const report = (k, happened, more = {}) => signed(k, { tags: [['t', more.type || 'bug'], ['game', 'rock-paper-scissors'], ['round', 'ab'.repeat(32)], ['build', 'UI 577'], ...(more.tags || [])],
  content: JSON.stringify({ happened: happened.trim() ? happened + STEPS : happened, expected: more.expected || 'it to work' }), ...(more.created_at ? { created_at: more.created_at } : {}) });
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
    assert.deepEqual([r.happened.startsWith('kept across a restart'), r.state], [true, STATES.ACCEPTED]);
    s2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- slice 2: only real feedback from real players gets money ----
test('#1342 approval for money (#2621: no round needed): not ours, not a duplicate, within the per-key and weekly caps and the amount range', () => {
  const s = openFeedbackStore();
  const player = key(1), stranger = key(2), bot = key(3), second = key(4);
  const played = (k) => [player.pubkey, bot.pubkey, second.pubkey].includes(k);
  const excluded = new Set([bot.pubkey]);
  const rules = { perKeyPerWeek: 3, weeklyBudgetSats: 12000, mostSats: 5000, leastSats: 100 };   // #2621: the stranger's 1,000 counts too
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
  assert.equal(steps.stranger, 'ok 1000');   // kanban #2621: no round needed
  assert.match(steps.bot, /ours/);
  assert.match(steps.duplicate, /duplicate/);
  assert.match(steps.tooMuch, /100 to 5000 sat/);
  assert.match(steps.tooLittle, /100 to 5000 sat/);
  assert.deepEqual([steps.p1, steps.p2, steps.p3], ['ok 5000', 'ok 1000', 'ok 1000']);
  assert.match(steps.p4, /3 rewards this week: at most 3/);
  assert.match(steps.again, /an accepted report is not approved/);
  assert.match(steps.budget, /this week's budget: 8000 of 12000 sat approved, 5000 more does not fit/);
  assert.equal(steps.withinBudget, 'ok 4000', 'what fits the budget exactly is approved');
  assert.equal(s.report(ids.bt).state, STATES.NEW, 'a refused approval moves nothing');   // kanban #2621: the stranger is approved now, the bot is the refused one
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
  // the games are read in parallel since kanban #1484: each went past the seat that is down to the one that answers
  for (const g of ['rock-paper-scissors', 'nextblock']) assert.ok(asked.includes(`https://seat.example/season?scope=network&game=${g}&days=90`), JSON.stringify(asked));
});

// kanban #2565 (measured 2026-11-12: a refresh while no seat answered emptied the list - every reward refused "not finished a round")
test('#2565 a refresh no seat answers keeps the players last read; a game that is read again replaces its own', async () => {
  const A = 'a1'.repeat(32), B = 'b2'.repeat(32), D = 'd4'.repeat(32);
  let mode = 'up';
  const fetcher = async (url) => { if (mode === 'down') throw new Error('down');
    const game = new URL(url).searchParams.get('game');
    if (mode === 'rps-only' && game !== 'rock-paper-scissors') throw new Error('down');
    const rows = game === 'rock-paper-scissors' ? (mode === 'rps-only' ? [{ player: D, rounds: 1 }] : [{ player: A, rounds: 3 }]) : [{ player: B, rounds: 1 }];
    return new Response(JSON.stringify({ rows }), { status: 200 }); };
  const np = networkPlayers({ seats: ['https://seat.example'], games: ['rock-paper-scissors', 'nextblock'], fetcher });
  assert.equal(await np.refresh(), 2);
  mode = 'down';
  assert.equal(await np.refresh(), 2, 'a refresh no seat answered emptied the list');
  assert.deepEqual([np.played(A), np.played(B)], [true, true]);
  assert.equal(np.history(A).rounds, 3);
  mode = 'rps-only';
  await np.refresh();
  assert.deepEqual([np.played(A), np.played(B), np.played(D)], [false, true, true], 'the game read again replaces its own; the other keeps its last');
});

// ---- slice 3: one LNURL-withdraw per approved report, exact amount, single use, never expiring ----
const BASE = 'https://testnet.example/api/faucet';
const approved = (s, k, words, sats) => { const e = report(k, words); s.take(e); assert.equal(s.approve(e.id, sats, { played: () => true }).ok, true); return e.id; };

test('#1342 a reward link is made once, for an approved report only, and asks a wallet for exactly its amount (testnet sats, no value)', () => {
  const s = openFeedbackStore();
  const alice = key(1);
  const fresh = report(alice, 'not approved yet'); s.take(fresh);
  const early = s.createReward(fresh.id);
  const id = approved(s, alice, 'the reveal hangs', 2000);
  const a = s.createReward(id), b = s.createReward(id);
  const req = s.withdrawRequest(a.reward.k1, { base: BASE });
  const link = s.lnurlOf(a.reward.k1, { base: BASE });
  console.log('  FACTS #1342 link:', JSON.stringify({ early: early.why, made: a.made, again: b.made, sameK1: a.reward.k1 === b.reward.k1, req, link: link.slice(0, 20) + '…' }));
  assert.ok(early.why);
  assert.deepEqual([a.made, b.made, a.reward.k1 === b.reward.k1], [true, false, true]);
  assert.deepEqual([req.tag, req.minWithdrawable, req.maxWithdrawable, req.callback], ['withdrawRequest', 2000000, 2000000, `${BASE}/lnurlw/${a.reward.k1}/callback`]);
  assert.match(req.defaultDescription, /testnet sats, no value/);
  assert.match(link, /^lnurl1/);
  assert.equal(s.withdrawRequest('ff'.repeat(32), { base: BASE }).status, 'ERROR');
});

test('#1342 a claim pays once: wrong amounts refused, two claims at once pay one, a sure failure opens the link again, an unknown waits for settle()', async () => {
  const s = openFeedbackStore();
  const alice = key(1);
  const decode = async (inv) => ({ ok: true, amountSats: Number(inv.split(':')[1]), paymentHash: `h-${inv}` });
  let pays = 0;
  const slowPay = () => new Promise((r) => { pays++; setTimeout(() => r({ ok: true, paymentHash: 'paid-hash' }), 50); });
  const k1 = s.createReward(approved(s, alice, 'bug for the double claim', 1500)).reward.k1;
  const wrong = await s.claim(k1, 'inv:1400', { decode, pay: slowPay });
  const [c1, c2] = await Promise.all([s.claim(k1, 'inv:1500', { decode, pay: slowPay }), s.claim(k1, 'inv:1500', { decode, pay: slowPay })]);
  const after = s.reward(k1);
  const third = await s.claim(k1, 'inv:1500', { decode, pay: slowPay });
  // a failing payer: the link opens again; an unknown one: it stays paying until settle reads the payer
  const k2 = s.createReward(approved(s, alice, 'bug for the failure', 1000)).reward.k1;
  const failed = await s.claim(k2, 'inv:1000', { decode, pay: async () => ({ ok: false, failed: true, why: 'no route' }) });
  const reopened = s.reward(k2).state;
  const unknown = await s.claim(k2, 'inv:1000', { decode, pay: async () => ({ ok: false, why: 'timeout' }) });
  const stuck = s.reward(k2).state;
  const blocked = await s.claim(k2, 'inv:1000', { decode, pay: slowPay });
  // a payment tried just now is left alone (audit 5 #1402: lnd may not know it yet); read three minutes later it is settled
  const tooSoon = await s.settle({ status: async () => 'failed' });
  assert.deepEqual([tooSoon.length, tooSoon[0].fresh, s.reward(k2).state], [1, true, 'paying'], 'a fresh payment read as failed reopened the link');
  const settled = await s.settle({ status: async () => 'paid', nowMs: Date.now() + 181000 });
  const facts = { wrong: wrong.reason, claims: [c1.status, c2.status], pays, after: [after.state, after.paymentHash], third: third.reason, report: s.report(after.report).state,
    failed: failed.reason, reopened, unknown: unknown.reason, stuck, blocked: blocked.reason, settled, k2: s.reward(k2).state };
  console.log('  FACTS #1342 claim:', JSON.stringify(facts));
  assert.match(wrong.reason, /exactly 1500 sat/);
  assert.deepEqual([c1.status, c2.status].sort(), ['ERROR', 'OK']);
  assert.equal(pays, 1, 'two claims at once paid twice');
  assert.deepEqual([after.state, after.paymentHash, facts.report], ['paid', 'paid-hash', 'paid']);
  assert.match(third.reason, /claimed/);
  assert.deepEqual([reopened, stuck, s.reward(k2).state], ['open', 'paying', 'paid']);
  assert.match(blocked.reason, /being paid/);
});

test('#1342 the link outlives a restart and a week: the same file reopened answers the same k1 and pays it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reward-1342-'));
  try {
    const path = join(dir, 'feedback.db');
    const s1 = openFeedbackStore(path);
    const k1 = s1.createReward(approved(s1, key(1), 'kept for a week', 3000)).reward.k1;
    s1.close();
    const s2 = openFeedbackStore(path);
    const weekLater = Date.now() + 8 * 24 * 3600 * 1000;
    const req = s2.withdrawRequest(k1, { base: BASE });
    const paid = await s2.claim(k1, 'inv:3000', { decode: async () => ({ ok: true, amountSats: 3000, paymentHash: 'h' }), pay: async () => ({ ok: true, paymentHash: 'h' }), nowMs: weekLater });
    console.log('  FACTS #1342 week:', JSON.stringify({ tag: req.tag, max: req.maxWithdrawable, claimed: paid.status, state: s2.reward(k1).state }));
    assert.deepEqual([req.tag, req.maxWithdrawable, paid.status, s2.reward(k1).state], ['withdrawRequest', 3000000, 'OK', 'paid']);
    s2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Daniel 2026-11-07: categories bug / improvement, at least 50 characters, frontend or node, a screenshot ----
test('#1342 a report: bug or improvement, at least 50 characters, from the frontend or a named node, with a screenshot only if it was uploaded', () => {
  const s = openFeedbackStore();
  const alice = key(1), NODE = 'cd'.repeat(32), SHOT = 'ef'.repeat(32);
  const raw = (text, tags) => signed(alice, { tags, content: JSON.stringify({ happened: text }) });
  const long = 'The deposit window closed before the invoice was paid, twice now.';
  const tries = {
    short: s.take(raw('Too short to say anything useful.', [['t', 'bug']])).why,
    oldType: s.take(raw(long, [['t', 'idea']])).why,
    improvement: s.take(raw(long + ' A', [['t', 'improvement']])).ok,
    nodeNoKey: s.take(raw(long + ' B', [['t', 'bug'], ['source', 'node']])).why,
    node: s.take(raw(long + ' C', [['t', 'bug'], ['source', 'node'], ['node', NODE]])).ok,
    otherSource: s.take(raw(long + ' D', [['t', 'bug'], ['source', 'phone']])).why,
    shotNotHere: s.take(raw(long + ' E', [['t', 'bug'], ['screenshot', SHOT]]), { hasShot: () => false }).why,
    shotHere: s.take(raw(long + ' F', [['t', 'bug'], ['screenshot', SHOT]]), { hasShot: (h) => h === SHOT }).ok,
  };
  const rows = s.list();
  console.log('  FACTS #1342 rules:', JSON.stringify({ tries, kept: rows.map((r) => [r.type, r.source, r.node && r.node.slice(0, 4), r.screenshot && r.screenshot.slice(0, 4)]) }));
  assert.match(tries.short, /at least 50 characters \(33 so far\)/);
  assert.match(tries.oldType, /bug, improvement/);
  assert.equal(tries.improvement, true);
  assert.match(tries.nodeNoKey, /names the node/);
  assert.equal(tries.node, true);
  assert.match(tries.otherSource, /frontend or node/);
  assert.match(tries.shotNotHere, /not uploaded here/);
  assert.equal(tries.shotHere, true);
  assert.deepEqual(rows.map((r) => r.source).sort(), ['frontend', 'frontend', 'node']);
  assert.ok(s.csv().split('\n')[0].includes('source,node'), 'the CSV says where each came from');
  assert.deepEqual([...s.shotsInUse()], [SHOT]);
});

// THE REWARD LEVELS (Daniel 2026-11-08, final): one table the form shows and approve pays from
test('#1342 levels 500 / 1,000 / 2,000 / 5,000 / 10,000: an approval by level pays its amount; a critical one is outside the weekly budget', () => {
  assert.deepEqual(REWARD_LEVELS.map((l) => [l.level, l.sats]), [['useful', 500], ['low', 1000], ['medium', 2000], ['high', 5000], ['critical', 10000]]);
  assert.equal(NODE_BOUNTY_BASE_SATS, 10000);
  const s = openFeedbackStore();
  const rules = { perKeyPerWeek: 3, weeklyBudgetSats: 3000, mostSats: 20000, leastSats: 100 };
  const one = (n, sev) => { const e = report(key(n), `Report ${n} about the ${sev} level of a bug in the lobby.`); s.take(e); return s.approve(e.id, null, { played: () => true, rules, severity: sev }); };
  const medium = one(11, 'medium'), critical = one(12, 'critical'), low = one(13, 'low'), more = one(14, 'low');
  const bar = s.budget ? s.budget({ rules }) : null;
  console.log('  MEASURED #1342 levels:', JSON.stringify({ medium: medium.ok && medium.report.amountSats, critical: critical.ok && critical.report.amountSats, low: low.ok && low.report.amountSats, more: more.ok ? 'ok' : more.why, week: bar && bar.weekApprovedSats }));
  assert.equal(medium.report.amountSats, 2000);
  assert.equal(critical.ok, true, 'critical: 10,000 though the week\'s budget is 3,000');
  assert.equal(critical.report.amountSats, 10000);
  assert.equal(low.report.amountSats, 1000, '2,000 + 1,000 fill the 3,000 budget; the critical one is not in it');
  assert.match(more.why, /this week's budget: 3000 of 3000/);
});

// THE NODE BOUNTY (Daniel 2026-11-08; 10,000 since 2026-11-10): sats, its own pot, one per person, a node report only; its checklist is the faucet's (node-bounty-check)
test('#1342 a node bounty: 10,000 from its own pot for a node report; one per person; a frontend report cannot take it; a node operator need not have played', () => {
  const s = openFeedbackStore();
  const rules = { perKeyPerWeek: 3, weeklyBudgetSats: 1000, mostSats: 20000, leastSats: 100 };
  const nodeReport = (n, text) => { const e = report(key(n), text, { type: 'bug', tags: [['source', 'node'], ['node', 'ee'.repeat(32)]] }); s.take(e); return e.id; };
  const a = nodeReport(21, 'The installer stopped at the bond step on Ubuntu and I had to restart it twice.');
  const b = nodeReport(21, 'After the update the owner page did not show the federation of my guardian.');
  const f = report(key(22), 'The lobby froze after the second round of rock paper scissors in a row.'); s.take(f);
  const first = s.approve(a, null, { played: () => false, rules, severity: 'node' });
  const again = s.approve(b, null, { played: () => false, rules, severity: 'node' });
  const front = s.approve(f.id, null, { played: () => true, rules, severity: 'node' });
  const bar = s.budget({ rules });
  console.log('  MEASURED #1342 node bounty:', JSON.stringify({ first: first.ok && first.report.amountSats, again: again.why, front: front.why, weekBudgetUsed: bar.weekApprovedSats }));
  assert.equal(first.ok, true, first.why); assert.equal(first.report.amountSats, 10000);
  assert.match(again.why, /one node bounty per person/);
  assert.match(front.why, /for a node report/);
  assert.equal(bar.weekApprovedSats, 10000, 'the week\'s figure counts every approval of the week (Daniel 2026-11-12: "Überall muss 56000 stehen")');
  assert.equal(bar.weekOutsideBudgetSats, 10000, 'and it is shown as approved this week outside the budget (Daniel 2026-11-12: 46,000 beside 56,000)');
});

// AUDIT 5 (kanban #1402, reproduced): approve, make the reward link, reject - the link still paid, outside the week's budget; and one node re-claimed
// under new keys took a node bounty per key
test('#1402 a rejected report\'s reward link no longer pays, a paid one blocks the rejection, and one node gets one node bounty', async () => {
  const s = openFeedbackStore();
  const alice = key(1);
  const decode = async (inv) => ({ ok: true, amountSats: Number(inv.split(':')[1]), paymentHash: `h-${inv}` });
  let pays = 0; const pay = async () => { pays++; return { ok: true, paymentHash: 'p' }; };
  const id = approved(s, alice, 'bug that gets rejected after the link', 1000);
  const k1 = s.createReward(id).reward.k1;
  const rejected = s.move(id, 'rejected', { reason: 'not reproducible' });
  assert.equal(rejected.ok, true);
  assert.equal(s.reward(k1).state, 'void');
  assert.match(s.withdrawRequest(k1, { base: 'https://x' }).reason, /withdrawn/);
  const claimed = await s.claim(k1, 'inv:1000', { decode, pay });
  assert.equal(claimed.status, 'ERROR'); assert.equal(pays, 0, 'a rejected report was paid');
  // a paid reward keeps its report: the rejection is refused
  const id2 = approved(s, alice, 'bug paid before anyone rejects it', 1000);
  const k2 = s.createReward(id2).reward.k1;
  assert.equal((await s.claim(k2, 'inv:1000', { decode, pay })).status, 'OK');
  assert.equal(s.move(id2, 'rejected', { reason: 'too late' }).ok, false);
});

test('#1402 one node bounty per node: the same node reported under a second key is refused', () => {
  const s = openFeedbackStore();
  const rules = { perKeyPerWeek: 3, weeklyBudgetSats: 1000, mostSats: 20000, leastSats: 100 };
  const nodeReport = (n, text) => { const e = report(key(n), text, { type: 'bug', tags: [['source', 'node'], ['node', 'ab'.repeat(32)]] }); s.take(e); return e.id; };
  const first = s.approve(nodeReport(31, 'My node ran the whole week and the owner page showed every round it served.'), null, { played: () => false, rules, severity: 'node' });
  const second = s.approve(nodeReport(32, 'Same node, a new owner key after a reset: the installer asked for the bond again.'), null, { played: () => false, rules, severity: 'node' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.why, /one node bounty per node/);
});

// AUDIT 5 (kanban #1402): /feedback/node-check was gated by the Origin header alone; each new (node, npub) pair asked every seat (~136 requests)
test('#1402 the faucet\'s node check runs one at a time and at most 10 an hour per address', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../tools/faucet.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('const NODE_CHECKS_PER_HOUR = 10; let NODE_CHECK_BUSY = false;'));
  assert.ok(src.includes("if (NODE_CHECK_BUSY) return send(429, { ok: false, why: 'a node check is running: try again in a minute' });"));
  assert.ok(src.includes("const who = ipKey(ip) || ip;"), 'an IPv6 address counted per /64 (ipKey since #1405: the split missed compressed addresses)');
});

// Daniel 2026-11-10 (#1342): "Die lnd addresse muss validiert werden ob die funktioniert" and "ein Budget von 100000 sats pro Woche"
test('#1342 a bounty Lightning address works only when its wallet answers a pay request; the weekly budget is 100,000', async () => {
  const { lnAddressWorks, REWARD_DEFAULTS } = await import('../src/feedback-store.js');
  assert.equal(REWARD_DEFAULTS.weeklyBudgetSats, 100000);
  const asked = [];
  // kanban #2045, #2064: a wallet's name is resolved before it is asked; these stand-in wallets answer on a public address
  const lookupFn = async () => [{ address: '93.184.215.14', family: 4 }];
  const wallet = (answer, status = 200) => async (url) => { asked.push(url); if (answer instanceof Error) throw answer; return { ok: status === 200, status, json: async () => answer }; };
  const good = await lnAddressWorks('Alice@Wallet.Example.com', { lookupFn, fetchFn: wallet({ tag: 'payRequest', callback: 'https://wallet.example.com/cb', minSendable: 1000, maxSendable: 100000000 }) });
  assert.deepEqual([good.ok, asked[0]], [true, 'https://wallet.example.com/.well-known/lnurlp/alice']);
  assert.match((await lnAddressWorks('bob@nowhere.example', { lookupFn, fetchFn: wallet(new TypeError('fetch failed')) })).why, /could not be reached/);
  assert.match((await lnAddressWorks('bob@w.example', { lookupFn, fetchFn: wallet({ status: 'ERROR', reason: 'unknown user' }) })).why, /unknown user/);
  assert.match((await lnAddressWorks('bob@w.example', { lookupFn, fetchFn: wallet({}, 404) })).why, /answered 404/);
  assert.match((await lnAddressWorks('bob@w.example', { lookupFn, fetchFn: wallet({ tag: 'withdrawRequest', callback: 'https://w/cb' }) })).why, /does not take payments/);
  assert.equal((await lnAddressWorks('not an address')).ok, false);
});

test('#1342 the faucet asks the bounty address of a signed and of an unsigned report before it keeps or posts either', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../tools/faucet.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('if (words.lnAddress) { const w = await lnAddressWorks(words.lnAddress);'), 'signed');
  assert.ok(src.includes("if (!b0.event) { const m = /\\nBounty address: (\\S+)/.exec(String(b0.text || '')); if (m) { const w = await lnAddressWorks(m[1]);"), 'unsigned');
  assert.ok(src.indexOf('if (!b0.event) { const m =') < src.indexOf("const key = readFileSync(env.FAUCET_CHAT_TOKEN_FILE, 'utf8').trim();"), 'before the chat post');
});
