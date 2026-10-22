// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY DONATION IN EUR / USD / CHF / GBP AT ITS OWN HISTORIC RATE (kanban #578): recorded rates kept, the rest fetched once per span and
// cached by outpoint, the sums per period, the price now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillFiatRates, fiatSummary, ratesNow, FIATS } from '../src/fiat-rates.js';

const H = 3600000, T0 = Date.parse('2026-10-20T12:00:00Z');
const rows = [
  { outpoint: 'a:1', amountMsat: '100000000000', verifiedMs: T0, usdPerBtc: 80000, eurPerBtc: 70000 },     // 1 BTC with USD+EUR recorded
  { outpoint: 'b:1', amountMsat: '50000000000', verifiedMs: T0 + 2 * H },                                    // 0.5 BTC, nothing recorded
];
const price = { eur: 71000, usd: 81000, chf: 66000, gbp: 61000 };

test('a row keeps its recorded rates; the rest come from one range request per currency, the closest point, cached by outpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiat-'));
  const asked = [];
  const fetcher = async (url) => { asked.push(url); const c = /vs_currency=(\w+)/.exec(url)[1];
    return { ok: true, json: async () => ({ prices: [[T0 - H, price[c] - 500], [T0 + 2 * H + 60000, price[c]], [T0 + 9 * H, price[c] + 900]] }) }; };
  const r = await fillFiatRates(dir, rows, { fetcher });
  assert.deepEqual(r['a:1'], { eur: 70000, usd: 80000, chf: 65500, gbp: 60500 }, 'recorded USD/EUR kept; CHF/GBP the closest point');
  assert.deepEqual(r['b:1'], { eur: 71000, usd: 81000, chf: 66000, gbp: 61000 });
  assert.equal(asked.length, 4, 'one request per currency for both rows');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'fiat-rates.json'), 'utf8'))).sort(), ['a:1', 'b:1']);
  const again = []; await fillFiatRates(dir, rows, { fetcher: async (u) => { again.push(u); throw new Error('not asked'); } });
  assert.equal(again.length, 0, 'a rate is fetched once, never again');
  const s = fiatSummary(rows, r, { nowMs: T0 + 3 * H });
  assert.deepEqual(s.totals.all, { eur: 105500, usd: 120500, chf: 98500, gbp: 91000 }, '1 BTC at its rate + 0.5 BTC at its own');
  assert.equal(s.totals.day.eur, 105500, 'both today (UTC)');
  assert.deepEqual(s.values['b:1'], { eur: 35500, usd: 40500, chf: 33000, gbp: 30500 });
});

test('a provider that does not answer leaves those rows unrated in that currency; the price now is kept 5 minutes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiat-'));
  const r = await fillFiatRates(dir, [rows[1]], { fetcher: async () => ({ ok: false, status: 429 }) });
  const s = fiatSummary([rows[1]], r);
  assert.deepEqual(s.unrated, Object.fromEntries(FIATS.map((c) => [c, 1])));
  let n = 0;
  const now = await ratesNow({ nowMs: 1e12, fetcher: async () => { n++; return { ok: true, json: async () => ({ bitcoin: price }) }; } });
  assert.equal(now.chf, 66000);
  await ratesNow({ nowMs: 1e12 + 60000, fetcher: async () => { n++; throw new Error('kept'); } });
  assert.equal(n, 1, 'kept for 5 minutes');
});
