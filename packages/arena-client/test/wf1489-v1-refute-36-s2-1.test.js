// kanban #1489 / #1531 skeptic 2: findLock's round-robin cap counts SEATS by the node list's exact strings (new Set(nodes)), while the
// fetch strips trailing slashes. One seat named 64 times in the node list (a join/lobby link's `node=` is not deduplicated:
// "http://evil", "http://evil/", "http://evil//", ...) answers 64 times; each spelling's first made-up lock fills a slot of round 0
// before the honest seats' first, and LOCKS_FOUND_MAX (64) drops the player's real lock. The kept record keeps that node list, so every
// reload's lookOwed / refundStake / redeemStake reads the same list. Before #1531 the real lock was always kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLock } from '../src/page-lock.js';

const fields = (b) => ({ paymentImage: { kind: 'hash', bytes: '11'.repeat(32) }, amountMsat: '1000', claimPk: '02' + b.repeat(32), refundPk: '02' + '33'.repeat(32), expiration: 100 });
const real = { outpoint: `${'ab'.repeat(32)}:0`, entryId: 'cd'.repeat(32), fields: fields('22') };

test('one seat named under 64 spellings of its URL does not push the honest seats\' lock off the list', async () => {
  const roundId = new Uint8Array(32).fill(3);
  let n = 0;
  const fetcher = async (url) => {
    const evil = url.startsWith('http://evil/');
    const body = evil ? Array.from({ length: 8 }, () => { n++; return { outpoint: `${n.toString(16).padStart(64, '0')}:0`, entryId: n.toString(16).padStart(64, '0'), fields: fields('44') }; }) : [real];
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  };
  const spellings = Array.from({ length: 64 }, (_, i) => 'http://evil' + '/'.repeat(i));
  const got = await findLock({ roundId, playerPubkey: new Uint8Array(33).fill(2), nodes: [...spellings, 'http://a', 'http://b'], fetcher });
  const has = got.some((l) => Buffer.from(l.outpoint.txid).toString('hex') === 'ab'.repeat(32));
  assert.ok(has, `the real lock both honest seats name is gone; ${got.length} locks kept, all one seat's`);
});
