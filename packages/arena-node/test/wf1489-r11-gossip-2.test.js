// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r11 (gossip): ONE PEER'S /series LISTING STARVES THE SERIES PULL. A pass takes at most PULL_PER_PASS (40) missing ids, in
// the order the asked peers' answers arrived, and every id costs a GET /series-template at the peers that listed it. One census seat
// answering GET /series first with 40 made-up ids (ahead > 0, fresh ones every pass so RETRY_MS never skips them) uses the whole
// budget: the day's real series, listed by an honest peer in the same pass, is not pulled - and with each made-up template read
// left hanging to its 15 s timeout the pass holds `busy` for 10 minutes, so no other pass runs either. A node drawn in those rounds
// cannot seat, sign PRESENT for or play them (kanban #757).
// Safe behaviour: the made-up ids of one peer do not keep a series an honest peer lists from being taken in that pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeriesPull, PULL_PER_PASS } from '../src/series-pull.js';

const hex = (n) => n.toString(16).padStart(64, '0');
const REAL = 'ab'.repeat(32);

test('one peer listing made-up series ids first does not keep the real series from being pulled', async () => {
  const junk = Array.from({ length: PULL_PER_PASS }, (_, i) => hex(i + 1));
  const asked = [];
  const fetchFn = async (u) => {
    asked.push(u);
    if (u === 'https://evil.example/series') return { ok: true, json: async () => ({ series: junk.map((s) => ({ series: s, ahead: 5 })) }) };
    if (u === 'https://good.example/series') { await new Promise((r) => setTimeout(r, 5)); return { ok: true, json: async () => ({ series: [{ series: REAL, ahead: 5 }] }) }; }
    if (u.startsWith('https://evil.example/series-template')) return { ok: false, status: 404, text: async () => '' };
    if (u === `https://good.example/series-template?id=${REAL}`) return { ok: true, text: async () => `line:${REAL}` };
    throw new Error(`unexpected ${u}`);
  };
  const taken = [];
  const pull = createSeriesPull({ peers: async () => ['https://evil.example', 'https://good.example'], held: () => [], fetchFn,
    parse: (line) => ({ id: line.slice(5) }), idOf: (t) => t.id, take: async (t) => { taken.push(t.id); return { ok: true }; } });
  const out = await pull.pass();
  assert.deepEqual(taken, [REAL], `the real series was not pulled: ${out.took} taken, ${out.refused.length} refused, ${asked.filter((u) => u.includes('series-template')).length} template reads`);
});
