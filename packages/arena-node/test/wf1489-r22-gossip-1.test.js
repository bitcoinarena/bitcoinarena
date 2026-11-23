// wf1489 r22: one peer listing each made-up id several times in its GET /series is still ONE peer (kanban #2424): its ids must not
// sort ahead of an id two honest peers list, nor escape its solo share, so the real series is still pulled in the same pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeriesPull } from '../src/series-pull.js';

const REAL = 'a'.repeat(64);
const fake = (i) => (i.toString(16).padStart(2, '0') + 'f'.repeat(62));
const parse = (line) => ({ id: line });
const idOf = (t) => t.id;

test('a peer repeating its own made-up ids in /series does not crowd out the series honest peers hold', async () => {
  const fakes = Array.from({ length: 40 }, (_, i) => fake(i));
  const fetchFn = async (u) => {
    const m = /^(https?:\/\/[^/]+)(\/.*)$/.exec(u); const root = m[1], path = m[2];
    if (path === '/series') {
      if (root === 'https://evil') return { ok: true, json: async () => ({ series: fakes.flatMap((id) => [1, 2, 3, 4].map(() => ({ series: id, ahead: 9 }))) }) };
      return { ok: true, json: async () => ({ series: [{ series: REAL, ahead: 9 }] }) };
    }
    if (root === 'https://evil') return { ok: false, text: async () => '' };   // never serves a line
    return { ok: true, text: async () => REAL };
  };
  const taken = [];
  const p = createSeriesPull({ peers: () => ['https://evil', 'https://h1', 'https://h2'], held: () => taken, parse, idOf, fetchFn,
    take: async (t) => { taken.push(t.id); return { ok: true }; } });
  const r = await p.pass();
  assert.ok(taken.includes(REAL), `the real series is pulled (took ${r.took}, refused ${r.refused.length} made-up ids)`);
});
