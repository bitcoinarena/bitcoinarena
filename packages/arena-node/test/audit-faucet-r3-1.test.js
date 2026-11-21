// Audit faucet r3-1: a link code posted on X is public; a stranger who copies it into his own X post links HIS X account to the reporter's key.
// X's SearchTimeline (product Latest) lists the newest post first, and the link bot's xLoop redeems the posts of one search in that order
// (tools/bounty-link-bot.mjs:107-112), so the copy - posted seconds after the reporter's, inside the 3-minute poll - is redeemed first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBountySeason } from '../src/bounty-season.js';
import { postsOf } from '../src/bounty-verify.js';
import { linkFromText } from '../tools/bounty-link-bot.mjs';

const tweet = (id, text, userId, name) => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: { rest_id: id, legacy: { full_text: text }, core: { user_results: { result: { rest_id: userId, core: { screen_name: name } } } } } } } } });

test('a copied X link code does not link the copier\'s X account to the reporter\'s key', async () => {
  const S2 = openBountySeason(':memory:', { startMs: 0 });
  const victim = 'a'.repeat(64);
  const { code } = S2.makeCode(victim);
  // one Latest search answer: newest first - the stranger's copy (id 1001, 20 s later) above the reporter's own post (id 1000)
  const body = { data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
    tweet('1001', `@bitcoinarena_io ${code}`, '666', 'stranger'),
    tweet('1000', `@bitcoinarena_io linking my report key ${code}`, '42', 'reporter'),
  ] }] } } } } };
  // xLoop's body (tools/bounty-link-bot.mjs:107-112), the posts in the order the search answered them
  const seen = new Set();
  for (const p of postsOf(body)) {
    if (seen.has(p.id)) continue; seen.add(p.id);
    await linkFromText(S2, {}, { platform: 'x', userId: p.userId, username: p.name, text: p.text });
  }
  const x = S2.links(victim).find((l) => l.platform === 'x');
  assert.ok(x, 'the reporter\'s key has an X link');
  assert.equal(x.userId, '42', `the reporter's own X account (42) is linked to his key, not the copier's (${x.userId})`);
});

