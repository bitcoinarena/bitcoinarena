// THE PAGE DEALS A STAKE AT THE ROUND'S THRESHOLD (M3.3-26, item 23 folded in).
//
// The page dealt `needed: settlementSlots` - 7 of 7 on seven seats, which the
// node's door now refuses by name - and posted the handout at the default 5 on
// a 2-of-2, where only 2 seats exist. The rule is one function, the one the
// door and the settle use: 2 of 2, 5 of 7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sharesNeededFor, stakeFor, postHandout, stakeSeenNeeded } from '../src/join.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const seatsOf = (n) => Array.from({ length: n }, () => schnorr.getPublicKey(rand(32)));
const deal = (round, seats, extra = {}) =>
  stakeFor(round, { seats, curve: feldmanGroup, random: rand, playerPubkey: b32(5), ...extra });

test('stakeFor deals at the round\'s threshold unless told otherwise, and refuses any other', async () => {
  // ITS DEFAULT WAS A FLAT 5, whatever the round. The page and the harness now
  // pass the round's number, but a default that contradicts a 2-of-2 is the
  // same player-chosen threshold the node's door refuses, one caller away.
  const two = { id: b32(0x11), stakeMsat: 100000n, settlementSlots: 2 };
  const seven = { id: b32(0x12), stakeMsat: 100000n, settlementSlots: 7 };
  assert.equal((await deal(two, seatsOf(2))).handout.needed, 2);
  assert.equal((await deal(seven, seatsOf(7))).handout.needed, 5);
  await assert.rejects(() => deal(two, seatsOf(2), { needed: 5 }), /this round's stakes open at 2 of 2/);
  await assert.rejects(() => deal(seven, seatsOf(7), { needed: 7 }), /this round's stakes open at 5 of 7/);
  await assert.rejects(() => deal({ id: b32(0x13), stakeMsat: 100000n }, seatsOf(7)),
    /names no settlement slots/);
});

test('postHandout counts against the threshold the stake was dealt at, not a flat 5', async () => {
  const two = { id: b32(0x11), stakeMsat: 100000n, settlementSlots: 2 };
  const stake = await deal(two, seatsOf(2), { needed: 2 });
  const took = async () => ({ ok: true, text: async () => '' });
  const put = await postHandout(stake, ['http://a', 'http://b'], { fetcher: took });
  assert.equal(put.needed, 2);
  assert.equal(put.ok, true, `both seats of a 2-of-2 took the handout and it still says: ${put.why}`);
});

test('"committed" counts against the same rule: stakeSeenNeeded is sharesNeededFor', () => {
  for (const slots of [2, 7]) assert.equal(stakeSeenNeeded({ settlementSlots: slots }), sharesNeededFor({ settlementSlots: slots }));
  assert.throws(() => stakeSeenNeeded({ settlementSlots: 3 }), /no committee threshold for 3 slots/,
    'the client counts a stake committed on a committee the node has no threshold for');
});

test('the round\'s stakes open at 2 of 2 and 5 of 7, and nothing else is a threshold', () => {
  assert.equal(sharesNeededFor({ settlementSlots: 2 }), 2);
  assert.equal(sharesNeededFor({ settlementSlots: 7 }), 5, 'seven seats are dealt all seven again');
  assert.throws(() => sharesNeededFor({ settlementSlots: 3 }), /no committee threshold for 3 slots/);
});

test('the bundle the page loads hands it that rule, and the template carries that bundle', async () => {
  // THE PAGE CALLS `BLWPCLIENT.sharesNeededFor`. The bundle's namespace is a
  // hand list, and the first build left the rule off it - the page would have
  // thrown at the deal. So the built file is loaded and asked.
  const { runInThisContext } = await import('node:vm');
  const dist = new URL('../dist/blwp-client.js', import.meta.url);
  const template = new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/blwp-client.js', import.meta.url);
  const bundle = readFileSync(dist, 'utf8');
  assert.equal(readFileSync(template, 'utf8'), bundle, 'the WebGL template carries a different bundle from dist');
  const B = runInThisContext(`${bundle}\n;BLWPCLIENT`, { filename: 'blwp-client.js' });
  assert.equal(typeof B.sharesNeededFor, 'function', 'the bundle the page loads has no BLWPCLIENT.sharesNeededFor');
  assert.equal(B.sharesNeededFor({ settlementSlots: 2 }), 2);
  assert.equal(B.sharesNeededFor({ settlementSlots: 7 }), 5);
});

test('the page deals and posts at that rule, not at its slot count or a default', () => {
  const page = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url), 'utf8');
  assert.ok(!/needed: named\.round\.settlementSlots/.test(page), 'the page still deals every seat a vote on its own stake');
  assert.match(page, /needed: BLWPCLIENT\.sharesNeededFor\(named\.round\),/, 'the page does not deal at the round\'s threshold');
  assert.match(page, /postHandout\(stake, named\.nodes, \{ needed: BLWPCLIENT\.sharesNeededFor\(named\.round\) \}\)/,
    'the page posts the handout at a default that is not this round\'s');
});
