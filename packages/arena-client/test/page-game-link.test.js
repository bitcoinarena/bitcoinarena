// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GAME LINK STILL READS THE SEATS FROM daily.json ("?game=<name> still reads the seat list (today any
// parameter skips daily.json)"). index.html's dailySearch is lifted out of the page by its text and run as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
import { readFileSync } from 'node:fs';
const TEXT = readFileSync(PAGE, 'utf8');
const SRC = `    const VIEW_ONLY_PARAMS = ['rps-demo', 'game'];`;
const FN = (() => { const at = TEXT.indexOf('    async function dailySearch() {'); return TEXT.slice(at, TEXT.indexOf('\n    }\n', at) + 6); })();
const lift = (search, daily = { nodes: ['https://a.example'] }) => {
  let asked = 0;
  const location = { search };
  const fetch = async (u) => { asked++; assert.equal(u, 'daily.json'); return { ok: true, json: async () => daily }; };
  const BLWPCLIENT = { dailyLobbySearch: (d) => `?nodes=${d.nodes.join(',')}` };
  const body = pageFunction(PAGE, ['location', 'fetch', 'BLWPCLIENT'], [SRC, FN], ' return dailySearch;');
  return { run: () => body(location, fetch, BLWPCLIENT)(), asked: () => asked };
};

test('?game=<name> reads daily.json, as the bare root and ?rps-demo do; a link naming its own lobby does not', async () => {
  for (const q of ['', '?game=rock-paper-scissors', '?game=672415c8', '?rps-demo=all']) {
    const l = lift(q);
    assert.equal(await l.run(), '?nodes=https://a.example', q || '(bare)');
    assert.equal(l.asked(), 1);
  }
  const own = lift('?nodes=https://b.example&game=nextblock');
  assert.equal(await own.run(), null, 'a link that names its nodes is its own lobby');
  assert.equal(own.asked(), 0);
});
