// kanban #3027: the card's test (audit faucet r2-1 of 2026-11-19)
// Audit faucet r2-1 (gap in #3003): the X link bot reads X once every 180 s, while the Telegram and Discord bots redeem a posted code at once.
// A reporter's BA- code posted on X is public; a stranger who reads the same search (@bitcoinarena_io BA-) and DMs the code to the Discord bot
// (or /link's it in Telegram) before the next X poll redeems it first. The code is one-time across all platforms (link_codes.used_ms), so the
// reporter's X post is then refused "that code was used already" - the oldest-first sort of #3003 only orders the posts of one X search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBountySeason } from '../src/bounty-season.js';
import { postsOf } from '../src/bounty-verify.js';
import { linkFromText } from '../tools/bounty-link-bot.mjs';

const tweet = (id, text, userId, name) => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: { rest_id: id, legacy: { full_text: text }, core: { user_results: { result: { rest_id: userId, core: { screen_name: name } } } } } } } } });

test('a reporter\'s X code copied to the Discord bot before the X poll does not keep the reporter\'s X account from linking', async () => {
  const S2 = openBountySeason(':memory:', { startMs: 0 });
  const victim = 'a'.repeat(64);
  const t0 = 1_800_000_000_000;
  const { code } = S2.makeCode(victim, { nowMs: t0 });
  // t0 + 5 s: the reporter's post is on X. t0 + 20 s: the stranger DMs the code to the Discord bot (discordLoop MESSAGE_CREATE, redeemed at once)
  const dm = await linkFromText(S2, {}, { platform: 'discord', userId: '9999', username: 'stranger', text: code, nowMs: t0 + 20_000 });
  // t0 + 180 s: xLoop's next search answers the reporter's post (tools/bounty-link-bot.mjs:107-112)
  const body = { data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
    tweet('1000', `@bitcoinarena_io linking my report key ${code}`, '42', 'reporter'),
  ] }] } } } } };
  const seen = new Set(); const outs = [];
  for (const p of postsOf(body)) {
    if (seen.has(p.id)) continue; seen.add(p.id);
    outs.push(await linkFromText(S2, {}, { platform: 'x', userId: p.userId, username: p.name, text: p.text, nowMs: t0 + 180_000 }));
  }
  const links = S2.links(victim);
  const x = links.find((l) => l.platform === 'x');
  assert.ok(x && x.userId === '42', `the reporter's own X account (42) is linked to his key; got links ${JSON.stringify(links.map((l) => [l.platform, l.userId]))}, discord dm: ${dm && dm.reply}, x post: ${outs.map((o) => o && o.reply).join(' | ')}`);
});

