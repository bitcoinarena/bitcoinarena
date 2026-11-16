// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2623: Bug Bounty Season 2 - the payout by the rules page (half for code-only, 1,000 for a follow-up, +50/+25/+75 % community bonus),
// the 100,000 sat pot per season (past it a report waits), the node bounty for the first 3 nodes of a season, the one-time link codes, the stored
// membership reads, the draw's entries, the live verifiers' answers and the public open-issues list (areas and ticket numbers only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBountySeason, seasonPayout, bonusPct, seasonAt, SEASON_MS, openIssueAreas, cleanOpenIssues, CHECK_FRESH_MS, LINK_CODE_MS, NODE_BOT_EXCLUDED_FROM_MS } from '../src/bounty-season.js';
import { telegramVerifier, discordVerifier, xVerifier, postsOf } from '../src/bounty-verify.js';
import { linkFromText } from '../tools/bounty-link-bot.mjs';

const K = (n) => String(n).repeat(64).slice(0, 64);
const rep = (n, pubkey = K(1)) => ({ id: String(n).padStart(64, '0'), pubkey });

test('#2623 #2784 the payout: the full level only for a played round by a proven human (a verified X account only - kanban #2788), else 15 % (was 25 %); 1,000 for a follow-up; bonus +50 / +25 / +75 %; node 10,000 flat', () => {
  assert.equal(bonusPct({}), 0); assert.equal(bonusPct({ telegram: true }), 50); assert.equal(bonusPct({ discord: true }), 50);
  assert.equal(bonusPct({ x: true }), 25); assert.equal(bonusPct({ telegram: true, discord: true, x: true }), 75);
  assert.equal(seasonPayout({ level: 'high', flags: { telegram: true, x: true } }).sats, 8750, 'the page: "a high bug then pays 8,750"');
  assert.equal(seasonPayout({ level: 'high' }).sats, 750, 'played, no verified account: counts as a bot, 15 %');
  assert.equal(seasonPayout({ level: 'high', flags: { x: true } }).sats, 6250, 'played and a verified X account: the full level (+25 % X bonus)');
  // kanban #2788 (the owner 2026-11-15): only X proves a human; Telegram, Discord and Armada stay a bonus
  for (const f of [{ telegram: true }, { discord: true }, { armada: true }, { telegram: true, discord: true, armada: true }]) {
    const p = seasonPayout({ level: 'high', flags: f });
    assert.equal(p.human, false, JSON.stringify(f)); assert.equal(p.quarter, true, JSON.stringify(f)); assert.equal(p.baseSats, 750, JSON.stringify(f)); }
  assert.equal(seasonPayout({ level: 'high', flags: { telegram: true }, played: false }).sats, 1125, 'a human who played no round: 15 % (+50 %)');
  assert.equal(seasonPayout({ level: 'high', codeOnly: true }).sats, 750);
  assert.equal(seasonPayout({ level: 'critical', codeOnly: true, flags: { discord: true } }).sats, 2250);
  assert.equal(seasonPayout({ level: 'high', followUp: true }).sats, 150);
  assert.equal(seasonPayout({ level: 'medium', followUp: true, flags: { x: true } }).sats, 1250);
  assert.equal(seasonPayout({ level: 'useful', codeOnly: true }).sats, 75);
  assert.deepEqual(seasonPayout({ level: 'node', codeOnly: true, flags: { telegram: true, x: true } }).sats, 10000);
  assert.equal(seasonPayout({ level: 'huge' }).ok, false);
  assert.equal(seasonAt(5, null), 2); assert.equal(seasonAt(1000, 2000), 2); assert.equal(seasonAt(2000 + SEASON_MS, 2000), 3);
});

test('#2623 link codes: one use, 24 hours, one key per account; reads stored with their time, stale reads give no bonus', async () => {
  const s = openBountySeason();
  const t0 = 1_800_000_000_000;
  const c = s.makeCode(K(1), { nowMs: t0 });
  assert.match(c.code, /^BA-[A-Z2-9]{8}$/);
  assert.equal(s.redeem('/link nope', { platform: 'telegram', userId: '7', nowMs: t0 }).ok, false);
  assert.equal(s.redeem(`/link ${c.code.toLowerCase()}`, { platform: 'telegram', userId: '7', username: '@ann', nowMs: t0 + 1 }).ok, true, 'case does not matter');
  assert.match(s.redeem(c.code, { platform: 'telegram', userId: '7', nowMs: t0 + 2 }).why, /used/);
  const late = s.makeCode(K(1), { nowMs: t0 });
  assert.match(s.redeem(late.code, { platform: 'discord', userId: '9', nowMs: t0 + LINK_CODE_MS + 1 }).why, /expired/);
  const other = s.makeCode(K(2), { nowMs: t0 });
  assert.match(s.redeem(other.code, { platform: 'telegram', userId: '7', nowMs: t0 + 3 }).why, /another report key/);
  assert.deepEqual(s.flagsOf(K(1), { nowMs: t0 + 5 }), { telegram: false, discord: false, x: false }, 'linked is not yet a member');
  let calls = 0;
  const flags = await s.verify(K(1), { telegram: async (l) => { calls++; assert.equal(l.userId, '7'); return { member: true }; } }, { nowMs: () => t0 + 10 });
  assert.equal(calls, 1); assert.equal(flags.telegram, true);
  assert.equal(s.links(K(1))[0].checkedMs, t0 + 10);
  assert.equal(s.flagsOf(K(1), { nowMs: t0 + 10 + CHECK_FRESH_MS + 1 }).telegram, false, 'a read older than a day does not count');
  await s.verify(K(1), { telegram: async () => { throw new Error('down'); } }, { nowMs: () => t0 + 20 });
  assert.equal(s.flagsOf(K(1), { nowMs: t0 + 20 }).telegram, false, 'a failed read is no bonus');
});

test('#2623 #2787 the pot: 100,000 sat a season, past it no bounty; the node bounty only for the first 3 nodes of a season', () => {
  const s = openBountySeason(':memory:', { startMs: 0 });
  const now = 10;
  let n = 0;
  // the reporters are proven humans (kanban #2784: otherwise every report pays 25 %)
  const human = (k, id, at) => { const c = s.makeCode(k, { nowMs: at }); s.redeem(c.code, { platform: 'x', userId: id, nowMs: at }); s.record(k, 'x', { member: true, nowMs: at }); };   // an X follow: +25 %, each critical 12,500
  human(K(3), '33', now); human(K(4), '44', now);
  for (let i = 0; i < 7; i++) { const r = rep(++n, K(3)); const p = s.plan(r, { level: 'critical', nowMs: now }); assert.equal(p.fits, true); s.commit(r, p, { nowMs: now }); }
  assert.equal(s.pot(2).usedSats, 87500);
  const big = rep(++n, K(3)); const pb = s.plan(big, { level: 'critical', nowMs: now }); s.commit(big, pb, { nowMs: now });
  // past the pot: no bounty, nothing waits for the next season (kanban #2787, the owner 2026-11-15: "wenn der Pot voll ist, ist er voll")
  const over = rep(++n, K(4)); const po = s.plan(over, { level: 'low', nowMs: now });
  assert.equal(po.waits, false); assert.equal(po.noBounty, true, 'the pot is used up: no bounty');
  assert.equal(s.pot(2).waiting.n, 0);
  s.record(K(4), 'x', { member: true, nowMs: SEASON_MS + 4 });   // a fresh read in the next season
  const fresh = rep(++n, K(4)); const next = s.plan(fresh, { level: 'low', nowMs: SEASON_MS + 5 });
  assert.equal(next.season, 3); assert.equal(next.fits, true, 'the next season has its own pot');
  s.commit(fresh, next, { nowMs: SEASON_MS + 5 });
  assert.equal(s.approval(fresh.id).state, 'approved'); assert.equal(s.pot(3).usedSats, 1250);
  for (let i = 0; i < 3; i++) { const r = rep(++n, K(5 + i)); const p = s.plan(r, { level: 'node', nowMs: SEASON_MS + 6 }); assert.equal(p.sats, 10000); s.commit(r, p, { nowMs: SEASON_MS + 6 }); }
  const fourth = s.plan(rep(++n, K(9)), { level: 'node', nowMs: SEASON_MS + 7 });
  assert.equal(fourth.ok, false); assert.match(fourth.why, /first 3 nodes/);
  assert.equal(s.plan(rep(1, K(3)), { level: 'low', nowMs: now }).ok, false, 'an approved report is not approved twice');
});

test('#2623 before payout the bonus is read again and never rises; the draw takes members with a confirmed report, one entry each', async () => {
  const s = openBountySeason();
  for (const [k, plat, id, name] of [[K(1), 'telegram', '11', '@ann'], [K(1), 'x', '12', 'ann_x'], [K(2), 'discord', '21', 'bob'], [K(3), 'x', '31', 'cat']]) {
    const c = s.makeCode(k); assert.equal(s.redeem(c.code, { platform: plat, userId: id, username: name }).ok, true); }
  const yes = { telegram: async () => ({ member: true }), discord: async () => ({ member: true }), x: async () => ({ member: true }) };
  for (const k of [K(1), K(2), K(3)]) await s.verify(k, yes);
  const r1 = rep(1, K(1)); const p1 = s.plan(r1, { level: 'high' }); assert.equal(p1.sats, 8750); s.commit(r1, p1);
  const r2 = rep(2, K(2)); s.commit(r2, s.plan(r2, { level: 'low' }));
  const r3 = rep(3, K(3)); s.commit(r3, s.plan(r3, { level: 'low' }));
  await s.verify(K(1), { telegram: async () => ({ member: false }), x: async () => ({ member: true }) });
  const pay = s.payable(r1.id);
  assert.equal(pay.payableSats, 6250, 'left the group since: +25 % only');
  assert.deepEqual(s.drawEntries(2), ['discord:bob'], 'K1 left Telegram, K3 is only an X follower');
});

test('#2623 the bot links from a posted code and reads the membership at once', async () => {
  const s = openBountySeason();
  const c = s.makeCode(K(7));
  assert.equal(await linkFromText(s, {}, { platform: 'telegram', userId: '1', username: '@a', text: '/link' }), null);
  const out = await linkFromText(s, { telegram: async () => ({ member: true }) }, { platform: 'telegram', userId: '1', username: '@a', text: `/link ${c.code}` });
  assert.equal(out.ok, true); assert.match(out.reply, /member/);
  assert.equal(s.flagsOf(K(7)).telegram, true);
});

test('#2623 the live verifiers: Telegram member / left, Discord 200 / 404, X follows and the account id must match', async () => {
  const tgAns = (status) => async () => new Response(JSON.stringify({ ok: true, result: { status } }));
  assert.equal((await telegramVerifier({ token: 't', chatId: '-1', fetchFn: tgAns('member') })({ userId: '1' })).member, true);
  assert.equal((await telegramVerifier({ token: 't', chatId: '-1', fetchFn: tgAns('left') })({ userId: '1' })).member, false);
  assert.equal((await telegramVerifier({ token: 't', chatId: '-1', fetchFn: async () => { throw new Error('bot123:SECRET down'); } })({ userId: '1' })).why.includes('SECRET'), false, 'no token in a why');
  assert.equal((await discordVerifier({ token: 't', guildId: 'g', fetchFn: async () => new Response('{}', { status: 200 }) })({ userId: '1' })).member, true);
  assert.equal((await discordVerifier({ token: 't', guildId: 'g', fetchFn: async () => new Response('{}', { status: 404 }) })({ userId: '1' })).member, false);
  const xAns = (following, id) => async () => new Response(JSON.stringify({ relationship: { target: { following, id_str: id } } }));
  const xv = (f) => xVerifier({ session: async () => ({ ct0: 'c', cookie: 'k' }), fetchFn: f, gap: async () => {} });
  assert.equal((await xv(xAns(true, '5'))({ userId: '5', username: 'ann' })).member, true);
  assert.equal((await xv(xAns(false, '5'))({ userId: '5', username: 'ann' })).member, false);
  assert.equal((await xv(xAns(true, '6'))({ userId: '5', username: 'ann' })).member, false, 'a name now held by another account');
  const posts = postsOf({ a: [{ rest_id: '99', legacy: { full_text: '@bitcoinarena_io BA-ABCDEFGH' }, core: { user_results: { result: { rest_id: '5', core: { screen_name: 'ann' } } } } }] });
  assert.deepEqual(posts, [{ id: '99', text: '@bitcoinarena_io BA-ABCDEFGH', userId: '5', name: 'ann' }]);
});

test('#2623 the open-issues list names areas and ticket numbers, never a ticket\'s words', () => {
  const o = openIssueAreas([
    { id: 1155, status: 'waiting', tags: ['Bug'], title: 'State machine (slashing, critical): Census-key FROST signer secret detail' },
    { id: 2564, status: 'in_progress', tags: [], title: 'Feedback #019: the page derives a 6-node committee' },
    { id: 7, status: 'done', tags: ['Bug'], title: 'payout fixed' },
    { id: 8, status: 'waiting', tags: ['Protocol'], title: 'not a bug' },
  ], { nowMs: 0 });
  assert.deepEqual(o.areas, [{ area: 'Committees and bonds', tickets: ['#2564'] }, { area: 'Slashing', tickets: ['#1155'] }]);
  assert.doesNotMatch(JSON.stringify(o), /FROST|derives|secret/);
  assert.deepEqual(cleanOpenIssues({ updated: 'x', areas: [{ area: 'Evil<script>', tickets: ['#1', 'drop'] }] }).areas, [{ area: 'Evilscript', tickets: ['#1'] }]);
});

// kanban #2876 (the owner 2026-11-16 ~07:06Z): from 2026-11-16T07:06:38Z a node report from a reporter who is not proven human (a played round AND a
// verified X account) gets no flat 10,000 sat node bounty - approved as ordinary feedback at its level instead; one received before keeps the old rule
test('#2876 the node bounty after the cutoff only for a proven human; a bot\'s node report is refused as node and takes an ordinary level', async () => {
  const T = NODE_BOT_EXCLUDED_FROM_MS;
  // the rule itself
  assert.equal(seasonPayout({ level: 'node', receivedMs: T - 1 }).sats, 10000, 'before the cutoff: the old rule');
  const bot = seasonPayout({ level: 'node', receivedMs: T, flags: { telegram: true, discord: true } });
  assert.equal(bot.ok, false); assert.equal(bot.nodeNotHuman, true); assert.match(bot.why, /07:06 UTC.*ordinary feedback/);
  assert.equal(seasonPayout({ level: 'node', receivedMs: T, flags: { x: true }, played: false }).ok, false, 'X but no played round: not proven');
  assert.equal(seasonPayout({ level: 'node', receivedMs: T, flags: { x: true } }).sats, 10000, 'played and a verified X account: the node bounty');
  assert.equal(seasonPayout({ level: 'node' }).sats, 10000, 'an approval read again (no receivedMs) keeps its node amount');
  // plan(): the report's own receivedMs and its reporter's verified links
  const s = openBountySeason(':memory:', { startMs: T - 1000 });
  const now = T + 60000;
  const old = { id: '1'.repeat(64), pubkey: K(3), receivedMs: T - 1 }, botNew = { id: '2'.repeat(64), pubkey: K(4), receivedMs: T }, human = { id: '3'.repeat(64), pubkey: K(5), receivedMs: T + 5 };
  const c = s.makeCode(K(5), { nowMs: now }); assert.equal(s.redeem(c.code, { platform: 'x', userId: '55', username: '@h', nowMs: now }).ok, true);
  await s.verify(K(5), { x: async () => ({ member: true }) }, { nowMs: () => now });
  const pOld = s.plan(old, { level: 'node', nowMs: now }), pBot = s.plan(botNew, { level: 'node', nowMs: now }), pHuman = s.plan(human, { level: 'node', nowMs: now });
  const pBotPlayedNot = s.plan(human, { level: 'node', played: false, nowMs: now });
  const pBotHigh = s.plan(botNew, { level: 'high', nowMs: now });
  console.log('  FACTS #2876:', JSON.stringify({ old: pOld.sats, bot: [pBot.ok, pBot.why], human: pHuman.sats, humanNoRound: pBotPlayedNot.ok, botHigh: pBotHigh.sats }));
  assert.equal(pOld.sats, 10000);
  assert.equal(pBot.ok, false); assert.equal(pBot.nodeNotHuman, true);
  assert.equal(pHuman.sats, 10000);
  assert.equal(pBotPlayedNot.ok, false);
  assert.equal(pBotHigh.sats, 750, 'the same bot report as ordinary feedback: high at the bot share');
});
