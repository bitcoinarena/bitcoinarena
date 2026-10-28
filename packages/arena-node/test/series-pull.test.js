// A node fetches the series it does not hold from the nodes it knows (kanban #757): b36828fa, drawn in 67 of the day's rounds, held none -
// the push went to its stale advert address, and a push that reached it was refused as unfunded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeriesPull } from '../src/series-pull.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64);
// a "line" is the id itself; parse answers { id }, idOf reads it back - the pull does not look inside a line
const parse = (line) => { if (!/^[0-9a-f]{64}$/.test(line)) throw new Error('not a line'); return { id: line }; };
const idOf = (t) => t.id;
function peersServing(map, { lie = {} } = {}) {
  const asked = [];
  const fetchFn = async (u) => {
    asked.push(u);
    const m = /^(https?:\/\/[^/]+)(\/.*)$/.exec(u); const root = m[1], path = m[2];
    const held = map[root];
    if (!held) throw new Error('fetch failed');
    if (path === '/series') return { ok: true, json: async () => ({ series: held.map((x) => ({ series: x.id, ahead: x.ahead ?? 10 })) }) };
    const id = /id=([0-9a-f]{64})/.exec(path)[1];
    if (!held.some((x) => x.id === id)) return { ok: false, text: async () => 'no such series' };
    return { ok: true, text: async () => `${lie[root] || id}\n` };
  };
  return { fetchFn, asked };
}

test('every series a peer holds and this node does not is fetched and taken; held and finished ones are not asked for', async () => {
  const have = new Set([A]); const taken = [];
  const { fetchFn, asked } = peersServing({ 'https://s1': [{ id: A }, { id: B }, { id: D, ahead: 0 }], 'https://s2': [{ id: B }, { id: C }] });
  const p = createSeriesPull({ peers: () => ['https://s1', 'https://s2', 'https://dead', 'ws://not-http'], held: () => [...have], parse, idOf, fetchFn,
    take: async (t) => { taken.push(t.id); have.add(t.id); return { ok: true }; } });
  const r = await p.pass();
  assert.deepEqual(taken.sort(), [B, C]);
  assert.deepEqual([r.asked, r.answered, r.missing, r.took], [3, 2, 2, 2], 'the dead peer is asked and passed by; ws:// is no peer');
  assert.ok(!asked.some((u) => u.includes(`id=${A}`) || u.includes(`id=${D}`)), 'a held series and one with no round ahead are not fetched');
  const again = await p.pass();
  assert.equal(again.took, 0, 'the next pass finds nothing missing');
});

test('a line is believed only as its own id, and a refusal is asked again only after the retry time', async () => {
  let now = 1_000_000; const tries = [];
  const { fetchFn } = peersServing({ 'https://liar': [{ id: B }], 'https://s1': [{ id: C }] }, { lie: { 'https://liar': C } });
  const p = createSeriesPull({ peers: () => ['https://liar', 'https://s1'], held: () => [], parse, idOf, fetchFn, now: () => now, retryMs: 60000,
    take: async (t) => { tries.push(t.id); return tries.length === 1 ? { ok: false, why: 'this node\'s chain holds no confirmed publication of that series yet' } : { ok: true }; } });
  const r = await p.pass();
  assert.deepEqual(tries, [C], 'the liar\'s line for B hashes to C: never taken as B');
  assert.equal(r.took, 0);
  assert.deepEqual(r.refused.map((x) => x.why.slice(0, 30)).sort(), ['https://liar answered a line o', 'this node\'s chain holds no con']);
  now += 30000; await p.pass();
  assert.deepEqual(tries, [C], 'not asked again inside the retry time');
  now += 31000; const r3 = await p.pass();
  assert.deepEqual([tries, r3.took], [[C, C], 1], 'after it, the publication confirmed: taken');
});

test('a few peers a pass, in turn', async () => {
  const roots = ['https://p0', 'https://p1', 'https://p2', 'https://p3', 'https://p4', 'https://p5'];
  const { fetchFn, asked } = peersServing(Object.fromEntries(roots.map((r) => [r, []])));
  const p = createSeriesPull({ peers: () => roots, held: () => [], parse, idOf, fetchFn, take: async () => ({ ok: true }), askPeers: 4 });
  await p.pass(); await p.pass();
  assert.deepEqual(asked.map((u) => u.slice(8, 10)), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p0', 'p1']);
});
