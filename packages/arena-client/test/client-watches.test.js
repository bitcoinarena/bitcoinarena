// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLIENT'S STAKE AND SETTLEMENT WATCHES - client.js watchStake, watchSettlement and stakeSeen (kanban #147, surface 4 of
// "The player's money lines", plan comment 209; the end rule (a), Go 2026-10-05). Every node is a fake fetcher and the watches
// poll every few ms; no socket and no seat is reached.
//
// Read from the source before this file, and measured here first: watchSettlement ended only on `s.hold` in SETTLEMENT_OVER,
// and nothing answers a hold any more - settlementBy returns none, and a node's /settlement says stake FREE/SEEN/UNSEEN and
// its finality (the hold went with §23.6). So once a stake was committed the page asked every settlement signer node every
// 5 s until the tab closed, long after the run was FINAL or VOID. Rule (a): the watch ends once the run is decided at the
// nodes that answer - all FINAL, or a decided outcome (VOID or FORFEIT) from all of them - or every one says the stake is FREE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client.js';
import { settlementDecided } from '../src/join.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const KEYS = Array.from({ length: 7 }, (_, i) => b32(0x11 + i));
const URLS = KEYS.map((_, i) => `http://node-${i}.example/`);
const CONTRACT = { settlementSlots: 7, nodes: KEYS };
const EID = b32(0xee);
const nodes = (behave) => async (url) => {
  const m = /^http:\/\/node-(\d+)\.example\/(\w+)/.exec(String(url));
  const i = Number(m[1]), path = m[2];
  if (path === 'identity') return new Response(KEYS[i]);
  const b = behave(i, path);
  if (b instanceof Error) throw b;
  return new Response(b.body, { status: b.status || 200 });
};
const client = () => {
  const c = new Client({ base: 'http://127.0.0.1:9', core: {}, sign: async () => new Uint8Array(64), verify: () => true });
  c.where = { entryId: hex(EID) };
  return c;
};
const settlement = (answer) => nodes((i, path) => (path === 'stake' ? { body: '{"state":"SEEN"}' } : { body: JSON.stringify(answer(i)) }));
const watch = (c, fetcher, o = {}) => c.watchSettlement({ signerNodes: KEYS, nodes: URLS, everyMs: 5, fetcher, ...o });
// resolves with what the watch said, or 'still polling' once `ms` pass
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('still polling'), ms))]);

// THE FIRST CHECK (plan 209): with every settlement signer node saying FINAL, the watch ends on its own.
test('the settlement watch ends on its own once every answering node says FINAL', async () => {
  const c = client();
  const got = await within(watch(c, settlement(() => ({ stake: 'SEEN', finality: 'FINAL' }))), 400);
  try {
    assert.notEqual(got, 'still polling', `the watch kept polling: ${c.settlementPolls} polls`);
    assert.equal(c.settlementOver, true);
    assert.equal(got.finality, 'FINAL');
    assert.ok(c.settlementPolls <= 2, `${c.settlementPolls} polls for a decided run`);
  } finally { c.close(); }
});

test('rule (a): decided when all say FINAL, or a decided outcome (VOID or FORFEIT) from all, or all say the stake is FREE', async () => {
  for (const [name, answer] of [
    ['VOID', () => ({ stake: 'SEEN', finality: 'VOID' })],
    ['FORFEIT', () => ({ stake: 'SEEN', finality: 'FORFEIT' })],
    ['FREE', () => ({ stake: 'FREE', finality: null })],
    ['FINAL and VOID mixed', (i) => ({ stake: 'SEEN', finality: i < 3 ? 'FINAL' : 'VOID' })],
  ]) {
    const c = client();
    const got = await within(watch(c, settlement(answer)), 400);
    c.close();
    assert.notEqual(got, 'still polling', `${name}: the watch kept polling`);
    assert.equal(c.settlementOver, true, name);
  }
  // NOT decided: one node still provisional, one suspended, nothing said, nobody answering
  for (const [name, f] of [
    ['one PROVISIONALLY_FINAL', settlement((i) => ({ stake: 'SEEN', finality: i === 4 ? 'PROVISIONALLY_FINAL' : 'FINAL' }))],
    ['one SUSPENDED', settlement((i) => ({ stake: 'SEEN', finality: i === 0 ? 'SUSPENDED' : 'FINAL' }))],
    ['nothing decided yet', settlement(() => ({ stake: 'SEEN', finality: null }))],
    ['nobody answering', nodes(() => new Error('down'))],
  ]) {
    const c = client();
    const got = await within(watch(c, f), 150);
    assert.equal(got, 'still polling', `${name}: the watch ended`);
    assert.equal(c.settlementOver, false, name);
    assert.ok(c.settlementPolls >= 3, `${name}: only ${c.settlementPolls} polls`);
    c.close();
    await within(c.settlementWatch || Promise.resolve(), 200);
  }
  // the rule itself, from settlementBy's answer
  const per = (list) => ({ answered: list.length, per: list.map((x, i) => ({ node: URLS[i], key: hex(KEYS[i]), ...x })) });
  assert.equal(settlementDecided(per([{ finality: 'FINAL' }, { finality: 'FINAL' }])), true);
  assert.equal(settlementDecided(per([{ finality: 'FINAL' }, { finality: 'PROVISIONALLY_FINAL' }])), false);
  assert.equal(settlementDecided(per([{ stake: 'FREE', finality: null }])), true);
  assert.equal(settlementDecided({ answered: 0, per: [{ node: URLS[0], why: 'down' }] }), false);
  assert.equal(settlementDecided(null), false);
});

test('a closed client stops the settlement watch; a second call returns the same watch; no entry is refused by name', async () => {
  const c = client();
  const f = settlement(() => ({ stake: 'SEEN', finality: null }));
  const one = watch(c, f), two = watch(c, f);
  assert.equal(one, two, 'a second watch was started');
  await new Promise((r) => setTimeout(r, 30));
  c.close();
  const s = await within(one, 200);
  assert.notEqual(s, 'still polling', 'close() did not stop the watch');
  assert.equal(c.settlementOver, false);
  assert.equal(await watch(c, f), c.settlement, 'a stopped client started a new watch');
  const none = new Client({ base: 'http://127.0.0.1:9', core: {}, sign: async () => new Uint8Array(64), verify: () => true });
  await assert.rejects(none.watchSettlement({ signerNodes: KEYS, nodes: URLS, fetcher: f }), { message: 'there is no entry to ask about: join first' });
});

test('the stake watch: never seen keeps polling until close; committed starts the settlement watch once; no entry refused', async () => {
  const c = client();
  const never = nodes(() => ({ status: 404, body: 'no stake for that entry' }));
  const w = c.watchStake({ signerNodes: KEYS, nodes: URLS, contract: CONTRACT, everyMs: 5, fetcher: never });
  assert.equal(c.watchStake({ signerNodes: KEYS, nodes: URLS, contract: CONTRACT, everyMs: 5, fetcher: never }), w, 'a second stake watch was started');
  assert.equal(await within(w, 120), 'still polling');
  assert.ok(c.stakePolls >= 3, `only ${c.stakePolls} polls`);
  assert.deepEqual({ seen: c.stakeCount.seen, committed: c.stakeCommitted }, { seen: 0, committed: false });
  c.close();
  const last = await within(w, 200);
  assert.notEqual(last, 'still polling', 'close() did not stop the stake watch');
  assert.equal(await c.watchStake({ signerNodes: KEYS, nodes: URLS, contract: CONTRACT, fetcher: never }), c.stakeCount, 'a stopped client watched again');
  // committed: five seen, and the settlement watch starts, once, and ends on FINAL
  const d = client();
  let settlementAsks = 0;
  const five = nodes((i, path) => (path === 'stake' ? (i < 5 ? { body: '{"state":"SEEN"}' } : { status: 404, body: 'no' })
    : (settlementAsks++, { body: JSON.stringify({ stake: 'SEEN', finality: 'FINAL' }) })));
  const s = await d.watchStake({ signerNodes: KEYS, nodes: URLS, contract: CONTRACT, everyMs: 5, settlementEveryMs: 5, fetcher: five });
  assert.deepEqual({ seen: s.seen, committed: s.committed }, { seen: 5, committed: true });
  await within(d.settlementWatch || Promise.resolve(), 300);
  assert.equal(d.settlementOver, true);
  assert.equal(d.stakeCount.settlement.finality, 'FINAL');
  assert.equal(settlementAsks, 7, `the settlement was asked ${settlementAsks} times for one decided poll of 7 nodes`);
  assert.equal(await d.watchStake({ signerNodes: KEYS, nodes: URLS, contract: CONTRACT, fetcher: five }), d.stakeCount, 'a committed stake was watched again');
  d.close();
  const none = new Client({ base: 'http://127.0.0.1:9', core: {}, sign: async () => new Uint8Array(64), verify: () => true });
  await assert.rejects(none.watchStake({ signerNodes: KEYS, nodes: URLS, contract: CONTRACT, fetcher: never }), { message: 'there is no entry to count: join first' });
});

test('stakeSeen answers and never throws: seen, a 404 by its words, a throw or an answer that is not JSON by name', async () => {
  const c = client();
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{"state":"SEEN","paidMsat":"96000"}');
    assert.deepEqual(await c.stakeSeen(EID), { ok: true, state: 'SEEN', paidMsat: 96000n });
    globalThis.fetch = async () => new Response('no stake for that entry\n', { status: 404 });
    assert.deepEqual(await c.stakeSeen(EID), { ok: false, status: 404, why: 'no stake for that entry' });
    globalThis.fetch = async () => { throw new Error('connection refused'); };
    assert.deepEqual(await c.stakeSeen(EID), { ok: false, why: 'the node would not say whether it saw the stake: connection refused' });
    globalThis.fetch = async () => new Response('<html>');
    const bad = await c.stakeSeen(EID);
    assert.equal(bad.ok, false);
    assert.match(bad.why, /^the node would not say whether it saw the stake: /);
  } finally { globalThis.fetch = real; c.close(); }
});
