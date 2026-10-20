// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PICK'S RESULT FROM THE SEAT THAT HOLDS ITS ROW (measured live 2026-10-17 18:05Z): a seat outside the round's committee
// answers GET /outcome ATTESTED with an empty table marked refunded; the page kept the first answer, so a won and a lost order read
// "your pick is not in the signer nodes' table" and stayed "waiting for the result". The page's own readMarketOutcomes, on fake seats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../btc-updown/page/market-page.js', import.meta.url);   // Up/Down's page part (kanban #521)
const HTML = readFileSync(PAGE, 'utf8');
const from = HTML.indexOf('    async function readMarketOutcomes() {');
const SRC = HTML.slice(from, HTML.indexOf('\n    setInterval(() => { readMarketOutcomes', from));

const R = 'f9'.repeat(32), UP = 'aa'.repeat(32), DOWN = 'bb'.repeat(32);
const answer = (rows, refunded) => ({ round: R, state: 'ATTESTED', outcome: 0, label: 'Up', final: true, attestation: '1d', table: { refunded, rows } });
const SEATS = {
  'https://s1': answer([], true),                                                              // not in the committee: no rows
  'https://s2': answer([{ entryId: UP, won: true, netMsat: '60390', payoutMsat: '120780' }, { entryId: DOWN, won: false, netMsat: '60390', payoutMsat: '0' }], false),
};

function run(picks, outcomes = new Map()) {
  const asked = [];
  const fetch = async (url) => { const base = url.split('/outcome')[0]; asked.push(base); const a = SEATS[base]; return { ok: !!a, json: async () => JSON.parse(JSON.stringify(a)) }; };
  const ARENACLIENT = { checkMarketOutcome: async () => ({ verified: true, why: 'signed by 2 of 3' }), checkAttestation: async () => ({ verified: true }) };
  // OUTCOMES_READ: the rounds whose outcome the page has asked for once
  const fn = pageFunction(PAGE, ['readPicks', 'MARKET_OUTCOMES', 'marketOfPick', 'ARENACLIENT', 'window', 'fetch', 'AbortSignal', 'OUTCOMES_READ'], [SRC], 'return readMarketOutcomes;');
  const read = fn(() => picks, outcomes, () => ({ name: 'btc-updown-15m' }), ARENACLIENT, { ARENA_CURVE: {} }, fetch, { timeout: () => undefined }, new Set());
  return { read, outcomes, asked };
}

test('the answer holding the pick\'s entry is kept, not the first seat\'s empty "refunded" table', async () => {
  const picks = [{ roundIdHex: R, entryIdHex: UP, entryCloseMs: '1', nodes: ['https://s1', 'https://s2'] }, { roundIdHex: R, entryIdHex: DOWN, entryCloseMs: '1', nodes: ['https://s1', 'https://s2'] }];
  const { read, outcomes } = run(picks);
  await read();
  const o = outcomes.get(R);
  assert.equal(o.table.refunded, false);
  assert.deepEqual(o.table.rows.map((r) => [r.entryId.slice(0, 2), r.won]), [['aa', true], ['bb', false]]);
});

test('a final verified answer without the pick\'s row is asked again; with it, it is kept for good', async () => {
  const picks = [{ roundIdHex: R, entryIdHex: UP, entryCloseMs: '1', nodes: ['https://s1', 'https://s2'] }];
  const stale = new Map([[R, { ...answer([], true), check: { verified: true } }]]);
  const a = run(picks, stale); await a.read();
  assert.equal(a.asked.length, 2, 'the stale one is read again');
  assert.equal(a.outcomes.get(R).table.rows.length, 2);
  const b = run(picks, a.outcomes); await b.read();
  assert.equal(b.asked.length, 0, 'held with its row: not asked again');
});
