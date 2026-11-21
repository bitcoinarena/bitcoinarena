// kanban #3018: the card's test (audit faucet r1-1 of 2026-11-19)
// Audit faucet r1-1 (2026-11-19, gap in #3003's fix): the link bot's X search reads ONE page of the newest 40 posts naming the account and "BA-"
// (xSearch count 40, no cursor), every 3 minutes. #3003 sorts that page oldest first - but a stranger who sees a reporter's public BA- code posts
// his copy and then 39 more "@bitcoinarena_io BA-..." posts before the next poll: the reporter's own post falls off the page, the copy is the
// oldest post the bot sees and is redeemed, and the stranger's X account is linked to the reporter's key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBountySeason } from '../src/bounty-season.js';
import { xSearch } from '../src/bounty-verify.js';
import { linkFromText } from '../tools/bounty-link-bot.mjs';

const tweet = (id, text, userId, name) => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: { rest_id: id, legacy: { full_text: text }, core: { user_results: { result: { rest_id: userId, core: { screen_name: name } } } } } } } } });
const cursor = (value) => ({ entryId: `cursor-bottom-${value}`, content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value } });

test('a reporter\'s X link code is not taken by a copy followed by a flood of posts within one poll', async () => {
  const S2 = openBountySeason(':memory:', { startMs: 0 });
  const victim = 'a'.repeat(64);
  const { code } = S2.makeCode(victim);
  // X, newest first: the reporter's post 1000, the stranger's copy 1001, then 39 filler posts of the stranger (1002..1040)
  const all = [tweet('1000', `@bitcoinarena_io linking my report key ${code}`, '42', 'reporter'), tweet('1001', `@bitcoinarena_io ${code}`, '666', 'stranger')];
  for (let i = 2; i <= 40; i++) all.push(tweet(String(1000 + i), `@bitcoinarena_io BA- how do I link? ${i}`, '666', 'stranger'));
  all.reverse();
  // a SearchTimeline that pages like X's: `count` posts and a bottom cursor to the next page
  const fetchFn = async (_url, init) => {
    const v = JSON.parse(init.body).variables;
    const from = v.cursor ? Number(v.cursor) : 0, n = v.count || 20;
    const entries = all.slice(from, from + n);
    if (from + n < all.length) entries.push(cursor(String(from + n)));
    return { status: 200, json: async () => ({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } } }) };
  };
  const posts = await xSearch('@bitcoinarena_io BA-', { session: async () => ({ ct0: 'x', cookie: 'x' }), fetchFn });
  // xLoop's body (tools/bounty-link-bot.mjs:107-112)
  const seen = new Set();
  for (const p of posts) {
    if (seen.has(p.id)) continue; seen.add(p.id);
    await linkFromText(S2, {}, { platform: 'x', userId: p.userId, username: p.name, text: p.text });
  }
  const x = S2.links(victim).find((l) => l.platform === 'x');
  assert.ok(x, 'the reporter\'s key has an X link');
  assert.equal(x.userId, '42', `the reporter's own X account (42) is linked to his key, not the copier's (${x.userId})`);
});

