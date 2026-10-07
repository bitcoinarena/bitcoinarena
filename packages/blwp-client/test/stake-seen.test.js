// A STAKE OR A SETTLEMENT THAT IS NEVER SEEN - join.js stakeSeenBy, settlementBy and roundCoreHex on their own (kanban #147,
// surface 3 of "The player's money lines", plan comment 202, accepted 2026-10-05). The page asks every node it holds who it
// is (/identity) and, from the round's settlement signer nodes only, whether it saw this entry's stake (/stake) and where
// its settlement stands (/settlement). Every node here is a fake fetcher; no seat is reached. No defect was read from the
// source before this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stakeSeenBy, settlementBy, roundCoreHex, stakeSeenNeeded } from '../src/join.js';
import { NEXTBLOCK_GAME_ID } from '../../core/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const KEYS = Array.from({ length: 7 }, (_, i) => b32(0x11 + i));
const EID = b32(0xee);
const SEVEN = { settlementSlots: 7, nodes: KEYS };
const urls = KEYS.map((_, i) => `http://node-${i}.example/`);
// a node: who it is, and what it says about /stake and /settlement
const nodes = (behave) => async (url) => {
  const m = /^http:\/\/node-(\d+)\.example\/(\w+)/.exec(String(url));
  const i = Number(m[1]), path = m[2];
  const b = behave(i, path);
  if (b instanceof Error) throw b;
  if (b === undefined) throw new Error(`node ${i} did not answer`);
  if (b.bytes) return new Response(b.bytes, { status: b.status || 200 });
  return new Response(b.body === undefined ? '' : b.body, { status: b.status || 200 });
};
const identity = (i) => ({ bytes: KEYS[i] });

test('stakeSeenBy: 5 of 7 committed, 4 of 7 not; the per-node record says why', async () => {
  const seen = (n) => nodes((i, path) => (path === 'identity' ? identity(i) : i < n ? { body: '{"state":"ACCEPTED"}' } : { status: 404, body: 'no stake for that entry\n' }));
  const five = await stakeSeenBy({ entryId: EID, signerNodes: KEYS, nodes: urls, contract: SEVEN, fetcher: seen(5) });
  assert.deepEqual({ seen: five.seen, of: five.of, needed: five.needed, unanswered: five.unanswered, committed: five.committed }, { seen: 5, of: 7, needed: 5, unanswered: 0, committed: true });
  const four = await stakeSeenBy({ entryId: hex(EID), signerNodes: KEYS, nodes: urls, contract: SEVEN, fetcher: seen(4) });
  assert.deepEqual({ seen: four.seen, committed: four.committed }, { seen: 4, committed: false });
  assert.deepEqual(four.per[6], { node: urls[6], key: hex(KEYS[6]), seen: false, why: 'no stake for that entry' });
  assert.equal(stakeSeenNeeded(SEVEN), 5);
  assert.equal(stakeSeenNeeded({ nodes: KEYS.slice(0, 2) }), 2);
});

test('stakeSeenBy: no node answers, identity refused, a node off the committee, the same key twice - none counts', async () => {
  const silent = await stakeSeenBy({ entryId: EID, signerNodes: KEYS, nodes: urls, contract: SEVEN, fetcher: nodes(() => undefined) });
  assert.deepEqual({ seen: silent.seen, unanswered: silent.unanswered, committed: silent.committed }, { seen: 0, unanswered: 7, committed: false });
  assert.deepEqual(silent.per[0], { node: urls[0], why: 'node 0 did not answer' });
  const refused = await stakeSeenBy({ entryId: EID, signerNodes: KEYS, nodes: urls, contract: SEVEN, fetcher: nodes((i, p) => (p === 'identity' ? { status: 500, body: 'down' } : { body: '{}' })) });
  assert.deepEqual({ seen: refused.seen, unanswered: refused.unanswered }, { seen: 0, unanswered: 7 });
  assert.deepEqual(refused.per[3], { node: urls[3], why: 'identity answered 500' });
  // node 0 says it is a stranger; node 1 says it is node 2 as well; /stake throws at node 3
  const odd = await stakeSeenBy({ entryId: EID, signerNodes: KEYS, nodes: urls, contract: SEVEN, fetcher: nodes((i, p) => {
    if (p === 'identity') return i === 0 ? { bytes: b32(0x99) } : i === 1 ? identity(2) : identity(i);
    return i === 3 ? new Error('reset') : { body: '{}' };
  }) });
  assert.deepEqual({ seen: odd.seen, unanswered: odd.unanswered, committed: odd.committed }, { seen: 4, unanswered: 3, committed: false },
    'a stranger or one key twice was counted');   // keys 0 (a stranger answered), 1 (claimed by nobody) and 3 (its /stake threw)
  assert.deepEqual(odd.per.find((p) => p.node === urls[3]), { node: urls[3], key: hex(KEYS[3]), why: 'reset' });
  const nobody = await stakeSeenBy({ entryId: EID, contract: SEVEN, fetcher: nodes(() => undefined) });
  assert.deepEqual({ seen: nobody.seen, of: nobody.of, unanswered: nobody.unanswered, per: nobody.per }, { seen: 0, of: 0, unanswered: 0, per: [] });
});

test('settlementBy: SUSPENDED wins; FINAL only when every answer is FINAL; else PROVISIONALLY_FINAL; nothing said is null', async () => {
  const say = (states, ends = []) => nodes((i, p) => (p === 'identity' ? identity(i)
    : states[i] === undefined ? { status: 404, body: 'not held here\n' }
      : { body: JSON.stringify({ finality: states[i], windowClosesAtMs: ends[i] === undefined ? null : ends[i] }) }));
  const ask = (f) => settlementBy({ entryId: EID, signerNodes: KEYS, nodes: urls, fetcher: f });
  const all = await ask(say(Array(7).fill('FINAL'), [1000, 3000, 2000]));
  assert.deepEqual({ of: all.of, answered: all.answered, finality: all.finality, ends: all.windowClosesAtMs }, { of: 7, answered: 7, finality: 'FINAL', ends: 3000 });
  assert.equal((await ask(say(['FINAL', 'FINAL', 'SUSPENDED', 'FINAL']))).finality, 'SUSPENDED');
  assert.equal((await ask(say(['FINAL', 'PROVISIONALLY_FINAL', 'FINAL']))).finality, 'PROVISIONALLY_FINAL');
  assert.equal((await ask(say(['PROVISIONALLY_FINAL', null]))).finality, 'PROVISIONALLY_FINAL');
  const none = await ask(say([null, null]));
  assert.deepEqual({ answered: none.answered, finality: none.finality, ends: none.windowClosesAtMs }, { answered: 2, finality: null, ends: null });
  const held = await ask(say([]));
  assert.deepEqual({ answered: held.answered, finality: held.finality }, { answered: 0, finality: null });
  assert.deepEqual(held.per[0], { node: urls[0], key: hex(KEYS[0]), why: 'not held here' });
});

test('settlementBy: a settlement answer that is not JSON, no node answering, identity refused, a stranger - none counts', async () => {
  const notJson = await settlementBy({ entryId: hex(EID), signerNodes: KEYS, nodes: urls, fetcher: nodes((i, p) => (p === 'identity' ? identity(i) : { body: i === 0 ? '<html>oops</html>' : '{"finality":"FINAL"}' })) });
  assert.deepEqual({ answered: notJson.answered, finality: notJson.finality }, { answered: 6, finality: 'FINAL' });
  const bad = notJson.per.find((p) => p.node === urls[0]);
  assert.equal(bad.key, hex(KEYS[0]));
  assert.match(bad.why, /JSON/);
  const silent = await settlementBy({ entryId: EID, signerNodes: KEYS, nodes: urls, fetcher: nodes(() => undefined) });
  assert.deepEqual({ answered: silent.answered, finality: silent.finality, per0: silent.per[0] }, { answered: 0, finality: null, per0: { node: urls[0], why: 'node 0 did not answer' } });
  const refused = await settlementBy({ entryId: EID, signerNodes: KEYS, nodes: urls, fetcher: nodes((i, p) => (p === 'identity' ? { status: 503, body: '' } : { body: '{}' })) });
  assert.deepEqual(refused.per[1], { node: urls[1], why: 'identity answered 503' });
  const odd = await settlementBy({ entryId: EID, signerNodes: KEYS, nodes: urls, fetcher: nodes((i, p) => (p === 'identity' ? (i < 2 ? identity(0) : { bytes: b32(0x99) }) : { body: '{"finality":"FINAL"}' })) });
  assert.equal(odd.answered, 1, 'a stranger or one key twice was counted');
  const nobody = await settlementBy({ entryId: EID, fetcher: nodes(() => undefined) });
  assert.deepEqual({ of: nobody.of, answered: nobody.answered, finality: nobody.finality }, { of: 0, answered: 0, finality: null });
});

test('roundCoreHex: the 32-byte core a round names, as hex; anything else is empty', () => {
  assert.equal(roundCoreHex({ gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(0xab) }), 'ab'.repeat(32));
  assert.equal(roundCoreHex({ gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(0xab).subarray(0, 31) }), '');
  assert.equal(roundCoreHex({ gameId: NEXTBLOCK_GAME_ID, simCoreHash: 'ab'.repeat(32) }), '');
  assert.equal(roundCoreHex(null), '');
  assert.equal(roundCoreHex(undefined), '');
});
