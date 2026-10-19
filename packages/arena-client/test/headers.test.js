// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TWO PROVIDERS, OR NO ANSWER.
//
// Section 25.1 is normative about where a client's chain comes from: "block
// headers from several independent sources, most work wins", and then "a list
// provider can OMIT but not FORGE, and omission is answered by asking a second
// one. This is the difference between using a provider and trusting one."
//
// Forging is already impossible - a header that does not follow the one before
// it is not a chain, and the work is arithmetic over bytes nobody chooses.
// Omission is not: a provider that leaves out the block a bond is in looks
// exactly like one that never had it. So the thing measured here is what a
// client does with SEVERAL answers, including answers that conflict.
//
// REAL HTTP, LOCAL ONLY. The providers are `node:http` servers on 127.0.0.1,
// the way the receipt tests stub a lying node. Nothing in this file reaches the
// internet, and the headers it serves are real mainnet bytes written down once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import {
  blockHashOf, workOf, meetsTarget, HEADER_BYTES, BITCOIN_MAINNET_GENESIS,
} from '../../arena-protocol/src/chain.js';
import { hash256 } from '../../arena-protocol/src/tx.js';
import { blockOf } from '../../arena-protocol/tools/bond.js';
import { agreedChain, headersOverHttp, httpProvider } from '../src/headers.js';

// mainnet 499998, 499999 and 500000, fetched once and written down. Each names
// the one before it, which is the only thing that makes three headers a chain.
const MAINNET = [
  '00000020c61dd21dd5f1c3d2e556d83f74ece599a256f658947434000000000000000000'
  + 'c11119defe5057e0b57a56e02ed4249746085414f4111daeeb7838a079aaf843bf09385a'
  + '45960018151b5421',
  '00000020ecf348128755dbeea5deb8eddf64566d9d4e59bc65d485000000000000000000'
  + '901f0d92a66ee7dcefd02fa282ca63ce85288bab628253da31ef259b24abe8a0470a385a'
  + '45960018e8d672f8',
  '000000201929eb850a74427d0440cf6b518308837566cd6d0662790000000000000000001f'
  + '6231ed3de07345b607ec2a39b2d01bec2fe10dfb7f516ba4958a42691c95316d0a385a45'
  + '9600185599fc5c',
].map(fromHex);

// THE ANCHOR THESE TESTS USE. Real mainnet 499998, which is in the fixture
// chain below - a deployment would anchor on genesis or on a later block it
// ships, and either way the client brings it rather than the page.
const ANCHOR = () => blockHashOf(MAINNET[0]);

/** A provider that serves headers back to back, as a real one would. */
async function serving(headers) {
  const body = Buffer.concat(headers.map((h) => Buffer.from(h)));
  const s = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(body);
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/`;
  return { server: s, url, bytes: body.length, get: () => headersOverHttp(url) };
}

/** A linked run of synthetic headers, for the cases mainnet cannot supply. */
function run(n, { previous = new Uint8Array(32), seed = 1 } = {}) {
  const out = [];
  let prev = previous;
  for (let i = 0; i < n; i++) {
    const { header } = blockOf(hash256, [new Uint8Array(32).fill(seed + i)], { previous: prev });
    out.push(header);
    prev = blockHashOf(header);
  }
  return out;
}

test('two providers that agree give a chain, and it is the real one', async () => {
  const a = await serving(MAINNET);
  const b = await serving(MAINNET);
  try {
    assert.equal(a.bytes, 3 * HEADER_BYTES);
    const seen = await agreedChain([a.get, b.get], { anchor: ANCHOR() });
    assert.equal(seen.ok, true, seen.why);
    assert.equal(seen.headers.length, 3);
    assert.equal(seen.agreed, 2);
    assert.deepEqual(seen.refused, []);
    // the tip is block 500000, and the work is the sum of three real headers
    assert.equal(toHex(blockHashOf(seen.headers[2]).reverse()),
      '00000000000000000024fb37364cbf81fd49cc2d51c09c75c35433c3a1945d04');
    assert.equal(seen.work, MAINNET.reduce((w, h) => w + workOf(h), 0n));
  } finally { a.server.close(); b.server.close(); }
});

/**
 * OMISSION IS THE EXPECTED CASE, not a disagreement. A provider that is behind,
 * or that leaves blocks out, has said nothing untrue - it has said less - and
 * the one with more work simply carries it. Refusing here would mean a client
 * stopped whenever one of its sources lagged, which is every day.
 */
test('a provider that leaves blocks out is carried, not refused', async () => {
  const whole = await serving(MAINNET);
  const short = await serving(MAINNET.slice(0, 2));
  try {
    const seen = await agreedChain([short.get, whole.get], { anchor: ANCHOR() });
    assert.equal(seen.ok, true, seen.why);
    assert.equal(seen.headers.length, 3);
    assert.equal(seen.from, 1);
    assert.equal(seen.agreed, 2);
  } finally { whole.server.close(); short.server.close(); }
});

/**
 * A FORK IS REFUSED RATHER THAN RESOLVED. Most work is Bitcoin's rule for a
 * node holding the whole chain; here two providers forking means at least one
 * is lying or broken, and taking the heavier one would be guessing which.
 */
test('providers that fork deeper than a tip split are refused, and the stray block is named', async () => {
  const left = run(16, { seed: 1 });
  const right = [left[0], ...run(15, { previous: blockHashOf(left[0]), seed: 90 })];
  const a = await serving(left);
  const b = await serving(right);
  try {
    // both hold the block this client is anchored to, and diverge after it
    const seen = await agreedChain([a.get, b.get], { anchor: blockHashOf(left[0]) });
    assert.equal(seen.ok, false);
    assert.match(seen.why, /do not agree on the chain/);
    // the named block is one the winner does not hold
    const winner = new Set(left.concat(right).map((h) => toHex(blockHashOf(h))));
    assert.ok(winner.has(seen.why.split(': ')[1].split(' ')[0]));
  } finally { a.server.close(); b.server.close(); }
});

// A SPLIT AT THE TIP (measured on testnet4 2026-10-14: two bitcoinds at one height and one chainwork, six blocks apart): the
// providers agree on everything below it, and the chain answered stops at the last block both hold
test('providers split only at the tip agree on the blocks they share, and the chain stops there', async () => {
  const { TIP_SPLIT_BLOCKS } = await import('../src/headers.js');
  const left = run(10, { seed: 1 });
  const right = [...left.slice(0, 6), ...run(4, { previous: blockHashOf(left[5]), seed: 90 })];
  const a = await serving(left);
  const b = await serving(right);
  try {
    const seen = await agreedChain([a.get, b.get], { anchor: blockHashOf(left[0]) });
    assert.equal(seen.ok, true, seen.why);
    assert.equal(seen.headers.length, 6, 'up to the last block both hold');
    assert.equal(toHex(blockHashOf(seen.headers[5])), toHex(blockHashOf(left[5])));
    assert.equal(seen.split, 4);
    assert.equal(TIP_SPLIT_BLOCKS, 12);
  } finally { a.server.close(); b.server.close(); }
});

/**
 * ONE SOURCE IS NOT A SOURCE. Not because it is probably lying, but because
 * nothing it says can be weighed: a short chain from one provider and a short
 * chain from a provider that is hiding a block are the same bytes.
 */
test('one provider is refused however good the chain looks', async () => {
  const only = await serving(MAINNET);
  try {
    // AND NOBODY IS ASKED. A list too short to weigh is refused before a
    // request goes out - measured after a mutant survived on the verdict
    // alone, because the later count refuses it too. Asking anyway would tell
    // a provider which round a player is looking at, for an answer that was
    // never going to be used.
    let calls = 0;
    const counted = () => { calls++; return only.get(); };
    const alone = await agreedChain([counted], { anchor: ANCHOR() });
    assert.equal(alone.ok, false);
    assert.match(alone.why, /1 providers is fewer than the 2 it takes/);
    assert.equal(calls, 0);

    // and the same chain from two DIFFERENT servers is fine, so it is the
    // count of sources that decides and not the chain
    const elsewhere = await serving(MAINNET);
    try {
      const two = await agreedChain([httpProvider(only.url), httpProvider(elsewhere.url)], { anchor: ANCHOR() });
      assert.equal(two.ok, true, two.why);
    } finally { elsewhere.server.close(); }

    // ONE SERVER LISTED TWICE IS ONE SOURCE. This used to read as success -
    // agreed 2, from a single machine - which is the worst kind of wrong,
    // because it looks exactly like the thing it is not.
    let asked = 0;
    const p = httpProvider(only.url);
    const counting = (...a) => { asked++; return p(...a); };
    counting.tag = p.tag;
    const same = await agreedChain([p, counting], { anchor: ANCHOR() });
    assert.equal(same.ok, false);
    assert.match(same.why, /providers 0 and 1 are the same source, http:\/\/127.0.0.1:/);
    assert.equal(asked, 0);
  } finally { only.server.close(); }
});

test('a chain that does not link is discarded, and it is named', async () => {
  const good = await serving(MAINNET);
  const broken = await serving([MAINNET[2], MAINNET[0], MAINNET[1]]);
  const alsoGood = await serving(MAINNET);
  try {
    // two good and one broken: the broken one is named and the answer stands
    const seen = await agreedChain([good.get, broken.get, alsoGood.get], { anchor: ANCHOR() });
    assert.equal(seen.ok, true, seen.why);
    assert.equal(seen.agreed, 2);
    assert.equal(seen.refused.length, 1);
    assert.match(seen.refused[0], /provider 1: this header does not follow the one before it/);

    // one good and one broken is one source, and one source is refused
    const no = await agreedChain([good.get, broken.get], { anchor: ANCHOR() });
    assert.equal(no.ok, false);
    assert.match(no.why, /only 1 of 2 providers gave a chain/);
    assert.match(no.refused, /does not follow the one before it/);
  } finally { good.server.close(); broken.server.close(); alsoGood.server.close(); }
});

test('a provider that errors or never answers is counted, not waited for', async () => {
  const good = await serving(MAINNET);
  const alsoGood = await serving(MAINNET);
  const angry = createServer((req, res) => { res.writeHead(500); res.end('no'); });
  await new Promise((r) => angry.listen(0, '127.0.0.1', r));
  const angryUrl = `http://127.0.0.1:${angry.address().port}/`;
  const silent = () => new Promise(() => {});          // answers never
  try {
    const seen = await agreedChain(
      [good.get, () => headersOverHttp(angryUrl), silent, alsoGood.get],
      { timeoutMs: 50, anchor: ANCHOR() });
    assert.equal(seen.ok, true, seen.why);
    assert.equal(seen.agreed, 2);
    assert.equal(seen.refused.length, 2);
    assert.match(seen.refused[0], /provider 1: the provider answered 500/);
    assert.match(seen.refused[1], /provider 2: no answer in 50 ms/);
  } finally { good.server.close(); alsoGood.server.close(); angry.close(); }
});

test('bytes that are not whole headers are not headers', async () => {
  const ragged = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(120));
  });
  await new Promise((r) => ragged.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${ragged.address().port}/`;
  try {
    await assert.rejects(headersOverHttp(url), /120 bytes is not a whole number of headers/);
    const seen = await agreedChain([() => headersOverHttp(url), () => headersOverHttp(url)], { anchor: ANCHOR() });
    assert.equal(seen.ok, false);
    assert.match(seen.why, /only 0 of 2 providers gave a chain/);
  } finally { ragged.close(); }
});

/** A header nobody mined, linked onto a chain, claiming a target of 1. */
function unmined(previous) {
  const h = new Uint8Array(80);
  h.set([0x00, 0x00, 0x00, 0x20], 0);
  h.set(previous, 4);
  h.set(new Uint8Array(32).fill(0xbb), 36);      // a merkle root of his choosing
  h[72] = 0x01; h[75] = 0x03;
  return h;
}

/**
 * THE ATTACK THIS CUT EXISTS FOR, and the fork rule did not stop it.
 *
 * A provider who serves the HONEST chain plus one header of his own on the end
 * is a superset: every honest provider's blocks are in his, so there is no
 * stray and nothing to disagree about. He then wins on work, because the work
 * was four bytes he wrote down. Measured before the hash was checked:
 *
 *   accepted: true, from provider 1, headers 4
 *   the winning chain ended in 803e37e6...  merkle root bbbb...bbbb
 *   honest work   24135148547246749491129
 *   claimed work  57896044618658097711785492504343953926634992332820282043...
 *
 * That merkle root is what a bond proof would have been checked against.
 */
test('honest chain plus one fabricated header does not win', async () => {
  const honest = MAINNET;
  const attacker = [...honest, unmined(blockHashOf(honest[2]))];
  assert.equal(meetsTarget(attacker[3]), false);
  // he still CLAIMS more work than the whole honest chain, by far
  assert.ok(attacker.reduce((w, h) => w + workOf(h), 0n)
    > honest.reduce((w, h) => w + workOf(h), 0n) * 10n ** 30n);

  const a = await serving(honest);
  const b = await serving(attacker);
  try {
    // two providers, one of them the attacker: his chain is not a chain, so
    // one source is left, and one source is refused
    const two = await agreedChain([a.get, b.get], { anchor: ANCHOR() });
    assert.equal(two.ok, false);
    assert.match(two.why, /only 1 of 2 providers gave a chain/);
    assert.match(two.refused, /provider 1: this header was not mined/);

    // and with two honest providers he is simply discarded, not obeyed
    const also = await serving(honest);
    try {
      const three = await agreedChain([a.get, b.get, also.get], { anchor: ANCHOR() });
      assert.equal(three.ok, true, three.why);
      assert.equal(three.headers.length, 3, 'the fabricated header must not be in the chain');
      assert.equal(three.agreed, 2);
      assert.match(three.refused[0], /provider 1: this header was not mined/);
      assert.equal(three.work, honest.reduce((w, h) => w + workOf(h), 0n));
    } finally { also.server.close(); }
  } finally { a.server.close(); b.server.close(); }
});

test('a chain of pure invention is refused for being unmined, not for forking', async () => {
  const fake = [unmined(new Uint8Array(32))];
  const a = await serving(MAINNET);
  const b = await serving(fake);
  try {
    const seen = await agreedChain([a.get, b.get], { anchor: ANCHOR() });
    assert.equal(seen.ok, false);
    // the REASON matters: before the hash was checked this was refused as a
    // disagreement, which is the right answer for the wrong reason and would
    // have let the superset above through
    assert.match(seen.why, /only 1 of 2 providers gave a chain/);
    assert.doesNotMatch(seen.why, /do not agree on the chain/);
    assert.match(seen.refused, /was not mined/);
  } finally { a.server.close(); b.server.close(); }
});

/**
 * INDEPENDENCE IS NOT CHECKABLE, ONLY THE OBVIOUS CASE IS. Two hostnames can be
 * one machine and nothing here can tell, so a tag catches a mistake and never
 * proves a thing. Untagged providers are counted as distinct because there is
 * nothing else to do with them - said out loud rather than left implied.
 */
test('providers with no address to compare are taken at their word', async () => {
  const a = await serving(MAINNET);
  try {
    const bare = () => a.get();
    assert.equal(bare.tag, undefined);
    const seen = await agreedChain([bare, bare], { anchor: ANCHOR() });
    assert.equal(seen.ok, true, seen.why);
  } finally { a.server.close(); }
});

/**
 * A RANGE IS A QUESTION, AND TWO HONEST PROVIDERS CAN ANSWER DIFFERENT ONES.
 * Before this, chains that shared no block were refused as a fork - the same
 * word used for a provider that is lying. They are told apart now, and the ask
 * is handed to the provider so an honest pair can be asked the same thing.
 */
/**
 * A RANGE THAT DOES NOT REACH THE ANCHOR IS NOT AN ANSWER.
 *
 * This used to be told apart from a fork - two honest providers whose answers
 * shared no block were refused with a different name. The anchor made that
 * branch unreachable: every chain that gets weighed contains the anchor, so any
 * two of them share at least that block. The same fact is said earlier now, per
 * source, and the branch was deleted rather than left where nothing could reach
 * it.
 */
test('a chain that does not reach the anchor is refused, by name', async () => {
  const early = MAINNET;
  const late = run(3, { seed: 40 });                 // links and is mined, but not ours
  const a = await serving(early);
  const b = await serving(late);
  try {
    const seen = await agreedChain([a.get, b.get], { anchor: ANCHOR() });
    assert.equal(seen.ok, false);
    assert.match(seen.why, /only 1 of 2 providers gave a chain/);
    assert.match(seen.refused, /provider 1: this chain does not contain .*, the block this client is anchored to/);
  } finally { a.server.close(); b.server.close(); }

  // and the question still reaches the provider
  const asked = [];
  const one = (q) => { asked.push(q); return MAINNET; };
  const two = (q) => { asked.push(q); return MAINNET; };
  const seen = await agreedChain([one, two],
    { ask: { from: 499998, count: 3 }, anchor: ANCHOR() });
  assert.equal(seen.ok, true, seen.why);
  assert.deepEqual(asked, [{ from: 499998, count: 3 }, { from: 499998, count: 3 }]);
});

/**
 * THE REST OF THE CHAIN SOURCE. Agreement and mining together prove only that
 * a set of headers is a chain of SOMETHING, and mining a short easy chain costs
 * almost nothing. A client whose whole provider list is one operator would take
 * that operator's fork by default, because there is nothing heavier to weigh it
 * against. The anchor is what makes the winner have to be Bitcoin's chain.
 */
test('two agreeing providers serving a cheap fork are refused without the anchor', async () => {
  // A fork that is entirely his: linked, mined, self-consistent, and served by
  // two providers that agree with each other perfectly.
  const his = run(4, { seed: 200 });
  assert.equal(his.every(meetsTarget), true, 'his chain really is mined');

  const a = await serving(his);
  const b = await serving(his);
  try {
    // without an anchor there is nothing to refuse him with, and that is why
    // the anchor is required rather than optional
    const none = await agreedChain([a.get, b.get], {});
    assert.equal(none.ok, false);
    assert.match(none.why, /no anchor: a chain of headers that link and are mined is still only a chain of something/);

    // with one, his chain is not weighed at all - it is an answer to another
    // question - and both of his providers are named
    const anchored = await agreedChain([httpProvider(a.url), httpProvider(b.url)],
      { anchor: ANCHOR() });
    assert.equal(anchored.ok, false);
    assert.match(anchored.why, /only 0 of 2 providers gave a chain/);
    assert.match(anchored.refused, /provider 0: this chain does not contain/);
    assert.match(anchored.refused, /provider 1: this chain does not contain/);
  } finally { a.server.close(); b.server.close(); }

  // and the honest chain, which does contain it, is accepted
  const honestOne = await serving(MAINNET);
  const honestTwo = await serving(MAINNET);
  try {
    const seen = await agreedChain([httpProvider(honestOne.url), httpProvider(honestTwo.url)],
      { anchor: ANCHOR() });
    assert.equal(seen.ok, true, seen.why);
    assert.equal(seen.headers.length, 3);
    assert.equal(seen.work, MAINNET.reduce((w, h) => w + workOf(h), 0n));
  } finally { honestOne.server.close(); honestTwo.server.close(); }
});

test('the anchor is a block the client brings, and genesis is one nobody can argue with', async () => {
  assert.equal(toHex(BITCOIN_MAINNET_GENESIS.slice().reverse()),
    '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
  assert.equal(BITCOIN_MAINNET_GENESIS.length, 32);

  // an anchor that is not 32 bytes is not an anchor
  const a = await serving(MAINNET);
  try {
    for (const bad of [undefined, null, 'a hex string', new Uint8Array(31)]) {
      const seen = await agreedChain([a.get, a.get], { anchor: bad });
      assert.equal(seen.ok, false, String(bad));
      assert.match(seen.why, /no anchor/);
    }
  } finally { a.server.close(); }
});

test('a body larger than the client reads is refused, not allocated', async () => {
  // 4001 headers offered where 4000 is the cap, in BOTH shapes a provider can
  // send them. The two are different refusals on purpose: one is caught on the
  // provider's own declaration, before a byte of body is pulled off the wire,
  // and the other is caught while reading, because that declaration is the
  // provider's word like everything else it says.
  const big = Buffer.alloc(4001 * HEADER_BYTES);

  const declared = createServer((q, r) => {
    r.writeHead(200, { 'content-length': String(big.length) });
    r.end(big);
  });
  await new Promise((r) => declared.listen(0, '127.0.0.1', r));

  const silentAboutLength = createServer((q, r) => {
    r.writeHead(200, { 'transfer-encoding': 'chunked' });
    r.write(big.subarray(0, 100000));
    r.write(big.subarray(100000));
    r.end();
  });
  await new Promise((r) => silentAboutLength.listen(0, '127.0.0.1', r));

  const at = (s) => `http://127.0.0.1:${s.address().port}/`;
  try {
    await assert.rejects(headersOverHttp(at(declared), { maxHeaders: 4000 }),
      /the provider offered 320080 bytes, more than the 320000 this client reads/);
    await assert.rejects(headersOverHttp(at(silentAboutLength), { maxHeaders: 4000 }),
      /the provider sent more than the 320000 bytes this client reads/);

    // and the same through the provider the client would actually build
    await assert.rejects(httpProvider(at(declared), { maxHeaders: 4000 })(),
      /more than the 320000/);

    // under the cap it is read as usual, both ways
    assert.equal((await headersOverHttp(at(declared), { maxHeaders: 4001 })).length, 4001);
    assert.equal((await headersOverHttp(at(silentAboutLength), { maxHeaders: 4001 })).length, 4001);
  } finally {
    declared.closeAllConnections(); declared.close();
    silentAboutLength.closeAllConnections(); silentAboutLength.close();
  }
});

test('a provider that never answers has its read aborted, not abandoned', async () => {
  let aborted = false;
  const hanging = createServer((req, res) => {
    req.on('aborted', () => { aborted = true; });
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    // headers sent, body never finished
  });
  await new Promise((r) => hanging.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${hanging.address().port}/`;
  const good = await serving(MAINNET);
  const alsoGood = await serving(MAINNET);
  try {
    const seen = await agreedChain(
      [good.get, httpProvider(url), alsoGood.get], { timeoutMs: 60, anchor: ANCHOR() });
    assert.equal(seen.ok, true, seen.why);
    assert.match(seen.refused[0], /provider 1: no answer in 60 ms/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(aborted, true, 'the socket was left open');
  } finally {
    good.server.close(); alsoGood.server.close();
    // The sockets are destroyed, not merely stopped from accepting new ones.
    // Without this the suite HANGS instead of failing when the abort is taken
    // out - and a hang is not a measurement, it is a test that cannot report.
    hanging.closeAllConnections();
    hanging.close();
  }
});
