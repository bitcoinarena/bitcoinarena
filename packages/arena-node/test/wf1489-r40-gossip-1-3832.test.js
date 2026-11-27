// wf1489 r40 gossip 1: ONE SEAT UNDER TWO ADDRESSES IS STILL ONE PEER IN THE SERIES PULL (bypass of #2424 / #2811).
// series-pull.js counts the peers that list an id by their root URL. server.js hands it everySeat(): the newest round's census endpoints
// (networkSeats) plus the chain's newest census endpoints - so a seat that moved its advert (or its address announcement) between the two
// censuses, or that is reached under two paths / spellings of its box, is two roots. Its made-up ids then each have two roots, are no
// longer "solo" (no share, no strikes), tie with the real series two honest peers list, and - answered first - take the whole pass budget.
// Safe behaviour: the real series two honest seats list is still pulled in the same pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeriesPull } from '../src/series-pull.js';

const REAL = 'a'.repeat(64);
const fake = (i) => (i.toString(16).padStart(2, '0') + 'f'.repeat(62));
const parse = (line) => ({ id: line });
const idOf = (t) => t.id;

test('a seat reached at two addresses does not crowd the real series out of the pull', async () => {
  const fakes = Array.from({ length: 40 }, (_, i) => fake(i));
  const evil = (root) => root === 'https://evil.example/a' || root === 'https://evil.example/b';
  const fetchFn = async (u) => {
    const m = /^(https?:\/\/[^/]+\/[ab]|https?:\/\/[^/]+)(\/series.*)$/.exec(u); const root = m[1], path = m[2];
    if (path === '/series') {
      // the box answers at once; the honest seats a moment later (their listing is larger)
      if (evil(root)) return { ok: true, json: async () => ({ series: fakes.map((id) => ({ series: id, ahead: 9 })) }) };
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, json: async () => ({ series: [{ series: REAL, ahead: 9 }] }) };
    }
    if (evil(root)) return { ok: false, text: async () => '' };   // never serves a line
    return { ok: true, text: async () => REAL };
  };
  const taken = [];
  const p = createSeriesPull({ peers: () => ['https://evil.example/a', 'https://evil.example/b', 'https://h1.example', 'https://h2.example'],
    held: () => taken, parse, idOf, fetchFn, take: async (t) => { taken.push(t.id); return { ok: true }; } });
  const r = await p.pass();
  assert.ok(taken.includes(REAL), `the real series two honest seats list is pulled (took ${r.took}, refused ${r.refused.length} made-up ids of one seat at two addresses)`);
});

// kanban #3832: the same seat at two different hosts (its advert in one census, its new address in the other) - folded by its census key
test('one census key at two hosts is one peer in the pull (seatOf)', async () => {
  const fakes = Array.from({ length: 40 }, (_, i) => fake(i));
  const evil = (root) => root === 'https://old.example' || root === 'https://new.example';
  const fetchFn = async (u) => {
    const m = /^(https?:\/\/[^/]+)(\/series.*)$/.exec(u); const root = m[1], path = m[2];
    if (path === '/series') {
      if (evil(root)) return { ok: true, json: async () => ({ series: fakes.map((id) => ({ series: id, ahead: 9 })) }) };
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, json: async () => ({ series: [{ series: REAL, ahead: 9 }] }) };
    }
    if (evil(root)) return { ok: false, text: async () => '' };
    return { ok: true, text: async () => REAL };
  };
  const taken = [];
  const keys = { 'https://old.example': 'ee'.repeat(32), 'https://new.example': 'ee'.repeat(32), 'https://h1.example': '11'.repeat(32), 'https://h2.example': '22'.repeat(32) };
  const p = createSeriesPull({ peers: () => Object.keys(keys), seatOf: (u) => keys[u] || null,
    held: () => taken, parse, idOf, fetchFn, take: async (t) => { taken.push(t.id); return { ok: true }; } });
  const r = await p.pass();
  assert.ok(taken.includes(REAL), `took ${r.took}, refused ${r.refused.length}`);
  assert.ok(r.refused.length <= 3, `the one seat's made-up ids stop at its strikes (refused ${r.refused.length})`);
});
