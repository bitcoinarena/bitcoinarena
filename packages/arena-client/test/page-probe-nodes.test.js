// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE STRIP'S NODE PROBE ASKS ONLY A AND B, EVERY 30 S, ONE PROBE AT A TIME (2026-10-16: "Lower the amount of concurrent
// connections and network load"; measured on preview UI 156 during one run: 1036 of 1050 GET /identity came from probeNodes - every
// node= of the page's address, 14 seats in a round, every 2 s, for a line that names A and B only). The page's own probeNodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../nextblock/page/unity-page.js', import.meta.url);   // the run's line is Tick Tock's page part (kanban #521)
const unity = readFileSync(PAGE, 'utf8');
const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');   // the lobby's paint loop is the page's
const at = unity.indexOf('    async function probeNodes() {');
const src = unity.slice(at, unity.indexOf('\n    }\n', at) + 6);

test('fourteen node= seats: two are asked, and a probe still running is not doubled', async () => {
  const seats = Array.from({ length: 14 }, (_, i) => `https://tn4.example/guardian-${i + 1}`);
  const location = { search: '?node=' + seats.join(',') };
  const asked = [];
  const fetch = async (u) => { asked.push(u); await new Promise((r) => setTimeout(r, 30)); return { ok: true, status: 200 }; };
  const nodeHealth = {};
  const probe = pageFunction(PAGE, ['location', 'fetch', 'nodeHealth', 'nodeLetter'], src, '; return probeNodes;')(location, fetch, nodeHealth, (i) => (i === 0 ? 'A' : i === 1 ? 'B' : String(i + 1)));
  await Promise.all([probe(), probe()]);
  assert.deepEqual(asked, ['https://tn4.example/guardian-1/identity', 'https://tn4.example/guardian-2/identity']);
  assert.deepEqual(nodeHealth, { A: 'ok', B: 'ok' });
});

test('the probe runs every 30 s, not every 2 s', () => {
  assert.match(unity, /\n    probeNodes\(\);\n    setInterval\(probeNodes, 30000\);/);
});

// THE LOBBY READS EVERY 30 S WHILE A RUN HIDES IT (measured on live UI 160: every seat's /rounds about every 10 s - 238
// in 3 min - while the player drove): the paint loop skips while joined with Unity's lobby down, until LOBBY_IN_RUN_MS since the last
test('the lobby paint waits 30 s while the player is in a run', () => {
  assert.match(html, /const LOBBY_IN_RUN_MS = 30000;/);
  assert.match(html, /const inRun = \(\) => !!\(window\.BLWP_JOIN && window\.BLWP_JOIN\.state === 'joined' && window\.BLWP_UNITY_LOBBY && window\.BLWP_UNITY_LOBBY\.showing === false\);/);
  assert.match(html, /setInterval\(\(\) => \{ if \(painting\) return; if \(inRun\(\) && Date\.now\(\) - \(window\.ARENA_LOBBY_PAINTED_AT \|\| 0\) < LOBBY_IN_RUN_MS\) return;/);
});
