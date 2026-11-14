// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2641: Week 2's social bonus - X +25 %, 2 of Telegram / Discord / Armada +25 % - and the social screen's live check of typed names:
// Discord member search, the Telegram seen-map and the user account reader (read-only), name claims, and the check itself with fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBountySeason, bonusPct, seasonPayout, COMMUNITIES } from '../src/bounty-season.js';
import { discordSearch, telegramByName, xByName, discordName, telegramName } from '../src/bounty-verify.js';
import { socialCheck } from '../src/bounty-social.js';
import { telegramUserbot, readOnly, READ_CALLS, userbotFromEnv } from '../src/telegram-userbot.js';
import { seeTelegramUpdate } from '../tools/bounty-link-bot.mjs';

const K = (n) => n.toString(16).padStart(64, '0');

test('#2641 bonusPct: every combination of X, Telegram, Discord, Armada', () => {
  const ps = ['x', ...COMMUNITIES];
  for (let m = 0; m < 16; m++) {
    const f = Object.fromEntries(ps.map((p, i) => [p, !!(m & (1 << i))]));
    const n = COMMUNITIES.filter((p) => f[p]).length;
    assert.equal(bonusPct(f), (f.x ? 25 : 0) + (n >= 2 ? 25 : 0), JSON.stringify(f));
  }
  assert.equal(bonusPct({ x: 'yes', telegram: 1, discord: 1 }), 0, 'only true counts');
  assert.equal(seasonPayout({ level: 'high', flags: { x: true, telegram: true, discord: true, armada: true } }).sats, 7500, 'at most +50 %');
  assert.equal(seasonPayout({ level: 'medium', flags: { discord: true, armada: true } }).sats, 2500);
});

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('#2641 Discord: member search by exact username, not a prefix or a nickname, pending is no member', async () => {
  let asked = null;
  const list = [{ user: { id: '1', username: 'annabel' }, nick: 'ann' }, { user: { id: '2', username: 'ann' }, pending: false }, { user: { id: '3', username: 'bob' }, pending: true }];
  const f = async (url, o) => { asked = { url, auth: o.headers.authorization }; return jsonRes(200, list); };
  const s = discordSearch({ token: 'T', guildId: 'G', fetchFn: f });
  const a = await s('@Ann');
  assert.deepEqual({ id: a.userId, m: a.member }, { id: '2', m: true });
  assert.match(asked.url, /\/guilds\/G\/members\/search\?query=ann&limit=100$/); assert.equal(asked.auth, 'Bot T');
  assert.equal((await s('bob')).member, false, 'screening pending');
  const none = await s('carl'); assert.equal(none.userId, null); assert.equal(none.member, false);
  assert.equal((await s('a b')).member, null, 'not a username');
  assert.equal((await discordSearch({ token: 'T', guildId: 'G', fetchFn: async () => jsonRes(403, {}) })('ann')).member, null);
  assert.equal((await discordSearch({ token: 'T', guildId: 'G', fetchFn: async () => { throw new Error('down'); } })('ann')).member, null);
  assert.equal(discordName('Ann#0'), 'ann'); assert.equal(telegramName('https://t.me/Ann_Bee'), 'ann_bee');
});

test('#2641 Telegram: the seen-map from the bot\'s updates; a seen name read live, an unseen one told to write once', async () => {
  const s = openBountySeason();
  assert.equal(seeTelegramUpdate(s, { message: { from: { id: 11, username: 'Ann_Bee' }, chat: { id: -1 } } }), 1);
  seeTelegramUpdate(s, { chat_member: { from: { id: 99, username: 'adminx', is_bot: false }, new_chat_member: { user: { id: 12, username: 'carlos' }, status: 'member' } } });
  seeTelegramUpdate(s, { message: { from: { id: 13, username: 'dora' }, new_chat_members: [{ id: 14, username: 'evan' }, { id: 15, username: 'somebot', is_bot: true }] } });
  assert.equal(s.telegramIdOf('@ann_bee'), '11'); assert.equal(s.telegramIdOf('CARLOS'), '12'); assert.equal(s.telegramIdOf('evan'), '14');
  assert.equal(s.telegramIdOf('somebot'), null, 'bots are not kept'); assert.equal(s.telegramIdOf('nobody'), null);
  seeTelegramUpdate(s, { message: { from: { id: 21, username: 'ann_bee' } } });
  assert.equal(s.telegramIdOf('ann_bee'), '21', 'a username that moved to another account follows it');
  const read = [];
  const t = telegramByName({ idOf: (n) => s.telegramIdOf(n), verify: async (l) => { read.push(l.userId); return { member: l.userId === '21', why: 'member' }; } });
  const a = await t('@Ann_Bee'); assert.deepEqual({ id: a.userId, m: a.member }, { id: '21', m: true });
  assert.equal((await t('carlos')).member, false);
  const u = await t('nobody'); assert.equal(u.member, null); assert.equal(u.unseen, true); assert.match(u.why, /write one message/);
  assert.deepEqual(read, ['21', '12'], 'getChatMember only for seen names');
});

test('#2641 the Telegram user account reader: member, not a member, no username, errors to null; only read calls reach the client', async () => {
  const calls = [];
  const fake = {
    connect: async () => { calls.push('connect'); },
    getEntity: async (id) => { calls.push(`getEntity:${id}`); throw new Error('not cached'); },
    getDialogs: async () => { calls.push('getDialogs'); return [{ id: -5, entity: { id: 5 } }, { id: -7, entity: { id: 7 } }]; },
    getParticipants: async (e) => { calls.push(`getParticipants:${e.id}`); return [{ id: 1, username: 'Annie' }, { id: 2, usernames: [{ username: 'beebee', active: true }, { username: 'oldname', active: false }] }, { id: 3 }, { id: 4, username: 'gonegone', deleted: true }]; },
    disconnect: async () => { calls.push('disconnect'); },
    sendMessage: async () => { calls.push('sendMessage'); }, invoke: async () => { calls.push('invoke'); }, joinChat: async () => { calls.push('join'); },
  };
  let now = 0;
  const r = telegramUserbot({ client: fake, chatId: '-7', cacheMs: 1000, nowMs: () => now });
  assert.deepEqual(await r('@annie'), { member: true, userId: '1', why: 'in the group (member list)' });
  assert.equal((await r('beebee')).member, true, 'a collectible username');
  assert.equal((await r('oldname')).member, false, 'an inactive username is not one');
  assert.equal((await r('gonegone')).member, false, 'a deleted account');
  assert.equal((await r('nobody')).member, false);
  assert.equal((await r('')).member, null, 'no username given');
  assert.deepEqual(calls, ['connect', 'getEntity:-7', 'getDialogs', 'getParticipants:7'], 'one read serves the checks within the cache time');
  now = 2000; await r('annie'); assert.equal(calls.filter((c) => c.startsWith('getParticipants')).length, 2);
  for (const c of calls) assert.ok(READ_CALLS.includes(c.split(':')[0]), c);
  const ro = readOnly(fake);
  for (const k of ['sendMessage', 'invoke', 'joinChat', 'editMessage', 'deleteMessages', 'kickParticipant']) assert.throws(() => ro[k], /read-only/, k);
  assert.equal(calls.includes('sendMessage') || calls.includes('invoke') || calls.includes('join'), false);
  const direct = [];
  const byEntity = telegramUserbot({ client: { ...fake, getEntity: async (id) => { direct.push(id); return { id: 7 }; }, getDialogs: async () => { throw new Error('not needed'); } }, chatId: '-7' });
  assert.equal((await byEntity('annie')).member, true); assert.deepEqual(direct, [-7], 'the group found by its id');
  const notIn = telegramUserbot({ client: { ...fake, getDialogs: async () => [] }, chatId: '-7' });
  const x = await notIn('annie'); assert.equal(x.member, null); assert.match(x.why, /not in the group/);
  const broken = telegramUserbot({ client: { ...fake, getParticipants: async () => { throw new Error('FLOOD_WAIT_30'); } }, chatId: '-7' });
  assert.deepEqual(await broken('annie'), { member: null, why: 'FLOOD_WAIT_30' });
  // off without credentials or without the package; the bot's path runs then
  assert.equal(await userbotFromEnv({ FAUCET_BOUNTY_TG_USERBOT_API_ID_FILE: '/nonexistent/a', FAUCET_BOUNTY_TG_USERBOT_API_HASH_FILE: '/nonexistent/b', FAUCET_BOUNTY_TG_USERBOT_SESSION_FILE: '/nonexistent/c' }), null);
  // the userbot answer goes before the seen-map
  const t = telegramByName({ idOf: () => null, verify: async () => ({ member: false }), userbot: r });
  const a = await t('annie'); assert.deepEqual({ id: a.userId, m: a.member }, { id: '1', m: true });
});

test('#2641 X by name: follows, does not follow, no such account; the stable id comes back', async () => {
  const f = (body, status = 200) => async () => jsonRes(status, body);
  const mk = (fetchFn) => xByName({ session: async () => ({ ct0: 'c', cookie: 'k' }), fetchFn, gap: async () => {} });
  const a = await mk(f({ relationship: { target: { id_str: '77', screen_name: 'Ann', following: true } } }))('https://x.com/Ann');
  assert.deepEqual({ id: a.userId, m: a.member }, { id: '77', m: true });
  assert.equal((await mk(f({ relationship: { target: { id_str: '78', following: false } } }))('@bob')).member, false);
  assert.equal((await mk(f({ errors: [{ code: 50 }] }, 404))('nobody')).member, false);
  assert.equal((await mk(f({}, 429))('ann')).member, null);
  assert.equal((await mk(f({}))('not a name!')).member, null);
});

test('#2641 the social check: members linked to the key with their reads, one key per account, a posted code wins over a typed name', async () => {
  const s = openBountySeason();
  const t0 = Date.now();
  const resolvers = {
    x: async (n) => (n === 'ann' ? { userId: '77', username: 'ann', member: true, why: 'follows' } : { userId: '78', member: false, why: 'does not follow' }),
    discord: async (n) => ({ userId: n === 'ann' ? '201' : null, username: n, member: n === 'ann', why: n === 'ann' ? 'member' : 'not in the server' }),
    telegram: async () => ({ userId: null, member: null, unseen: true, why: 'not seen yet: write one message' }),
    armada: async (n) => ({ userId: 'a'.repeat(64), username: n, member: true, why: 'member' }),
  };
  const a = await socialCheck(s, K(1), { x: 'ann', discord: 'ann', telegram: 'ann', armada: 'npub1ann', other: 'x' }, resolvers, { nowMs: () => t0 });
  assert.deepEqual(Object.fromEntries(Object.entries(a.results).map(([k, v]) => [k, v.member])), { telegram: null, discord: true, x: true, armada: true });
  assert.equal(a.results.telegram.unseen, true);
  assert.deepEqual(a.flags, { telegram: false, discord: true, x: true, armada: true }); assert.equal(a.bonusPct, 50);
  assert.equal(a.links.length, 3); assert.equal(a.links.every((l) => l.proof === 'name'), true);
  assert.equal(a.links.some((l) => 'userId' in l), false, 'no platform ids go back');
  // a non-member links nothing; empty names are not asked
  const b = await socialCheck(s, K(2), { x: 'bob', discord: '', armada: '   ' }, resolvers, { nowMs: () => t0 });
  assert.deepEqual(Object.keys(b.results), ['x']); assert.equal(b.links.length, 0); assert.equal(b.bonusPct, 0);
  // another key cannot take the same account by typing its name
  const c = await socialCheck(s, K(3), { x: 'ann' }, resolvers, { nowMs: () => t0 });
  assert.equal(c.results.x.member, null); assert.match(c.results.x.why, /another report key/); assert.equal(c.bonusPct, 0);
  // the account's owner posts a link code from it: the code proves the account, the typed claim of K1 gives way
  const code = s.makeCode(K(3), { nowMs: t0 });
  assert.equal(s.redeem(code.code, { platform: 'x', userId: '77', username: 'ann', nowMs: t0 }).ok, true);
  assert.equal(s.links(K(1)).some((l) => l.platform === 'x'), false);
  assert.equal(s.links(K(3)).find((l) => l.platform === 'x').proof, 'code');
  // and a code-proven account is not taken back by a typed name
  const d = await socialCheck(s, K(1), { x: 'ann' }, resolvers, { nowMs: () => t0 });
  assert.match(d.results.x.why, /another report key/);
  // a resolver that throws: no link, member null; a platform with no resolver says the check is not on
  const e = await socialCheck(s, K(4), { x: 'ann', discord: 'ann' }, { x: async () => { throw new Error('boom'); } }, { nowMs: () => t0 });
  assert.equal(e.results.x.member, null); assert.match(e.results.discord.why, /not on/);
  // a member answer without an account id links nothing
  const f = await socialCheck(s, K(5), { telegram: 'zed' }, { telegram: async () => ({ userId: null, member: true }) }, { nowMs: () => t0 });
  assert.equal(f.results.telegram.member, null); assert.equal(f.links.length, 0);
  // the old database file without the proof column opens and takes it
  s.close();
});
