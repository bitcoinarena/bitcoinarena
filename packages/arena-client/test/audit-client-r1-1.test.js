// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT client r1 #1 (P8, P1, P11 - a gap in the #2299 fix, reached by #3009's refund-only close): ONE SEAT'S /outcome TABLE THAT
// LEAVES THE LOSERS' ROWS OUT turns a verified winner into "nobody took the other side - refunded".
// readMarketOutcomes (btc-updown page) keeps the first answer in node order that holds the pick's row (answers.find(hasRow)); the
// seat copies the real, verifying attestation and serves a table of the player's row alone. marketLines rebuilds the table from the
// seat's own rows (#1615/#2299: "which entries a seat counts stays its word"), so the losing pool it derives is 0 and the line is
// 'refunded'. Since #3009, index.html refundOrderKeys() counts a 'refunded' line as a refund-only order, and the collect pass closes the
// order's record with "payout: none" once its stake (a winner's stake comes back by forfeit) is credited - the winnings are not collected.
// SAFE: one seat's table cannot make the verified winner's line a refund, nor put the order among the refund-only keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { marketLines } from '../src/market.js';

const PAGE = new URL('../../btc-updown/page/market-page.js', import.meta.url);
const TEXT = readFileSync(PAGE, 'utf8');
const from = TEXT.indexOf('    async function readMarketOutcomes() {');
const SRC = TEXT.slice(from, TEXT.indexOf('\n    setInterval(() => { readMarketOutcomes', from));
const INDEX = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(INDEX, 'utf8');
const kFrom = HTML.indexOf('    function refundOrderKeys() {');
const KSRC = HTML.slice(kFrom, HTML.indexOf('    const unfilledPickKeys', kFrom));

const R = 'f9'.repeat(32), ME = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
const row = (entryId, pick, won, payout) => ({ entryId, pick, won, stakeMsat: '100000', feeMsat: '0', donationMsat: '0', netMsat: '100000', payoutMsat: String(payout) });
// the honest table: the player's Up pick and two Down picks; Up won - the player is paid 300000 msat
const honestRows = [row(ME, 0, true, 300000), row(B, 1, false, 0), row(C, 1, false, 0)];
const ATT = '1d';   // the real attestation every seat serves (public); the stub check below verifies it as the real one would
const honest = { round: R, state: 'ATTESTED', outcome: 0, label: 'Up', final: true, attestation: ATT, table: { refunded: false, losingPoolMsat: '200000', rows: honestRows } };
// the one lying seat, listed first: the same attestation, and a table of the player's row alone, consistent with itself
const liar = { round: R, state: 'ATTESTED', outcome: 0, label: 'Up', final: true, attestation: ATT,
  table: { refunded: false, losingPoolMsat: '0', rows: [row(ME, 0, true, 100000)] } };
const SEATS = { 'https://s1': liar, 'https://s2': honest, 'https://s3': honest, 'https://s4': honest };

test('one seat\'s table without the losers\' rows does not turn a verified winner into a refund-only order', async () => {
  const market = { name: 'btc-updown-15m', outcomes: ['Up', 'Down'], attestors: ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)], threshold: 2,
    terms: { resolveAfterCloseMs: 0n, deadlineAfterResolveMs: 600000n } };
  const now = Date.now();
  const pick = { roundIdHex: R, entryIdHex: ME, pick: 0, stakeMsat: '100000', entryCloseMs: String(now - 120000), nodes: Object.keys(SEATS), order: { index: 0 } };
  const fetch = async (url) => { const a = SEATS[url.split('/outcome')[0]]; return { ok: !!a, json: async () => JSON.parse(JSON.stringify(a)) }; };
  const verified = async ({ outcome }) => (outcome.attestation === ATT ? { verified: true, outcome: 0, label: 'Up', window: 'checked' } : { verified: false, why: 'no' });
  const ARENACLIENT = { checkMarketOutcome: verified, checkAttestation: async () => ({ verified: true, outcome: 0, label: 'Up' }) };
  const outcomes = new Map();
  const fn = pageFunction(PAGE, ['readPicks', 'MARKET_OUTCOMES', 'marketOfPick', 'ARENACLIENT', 'window', 'fetch', 'AbortSignal', 'OUTCOMES_READ', 'rememberPick'], [SRC], 'return readMarketOutcomes;');
  const read = fn(() => [pick], outcomes, () => market, ARENACLIENT, { ARENA_CURVE: {} }, fetch, { timeout: () => undefined }, new Set(), () => {});
  await read();
  const [line] = marketLines({ picks: [{ ...pick, market }], outcomes, nowMs: now });
  console.log('  LINE:', JSON.stringify({ state: line.state, text: line.text }));

  assert.equal(line.state, 'won', `the verified winner (paid 300000 msat by the honest seats) reads '${line.state}': ${line.text}`);
  // the page's own refund-only keys (index.html, #3009), over this line - ON 2.0 the page has no refundOrderKeys (#3009 is a 1.9 page change):
  // the line above is the whole check there
  if (!HTML.includes("const refundOrderKeys") && !HTML.includes("function refundOrderKeys")) return;
  const storage = { getItem: (k) => (k === 'arena.market.picks' ? JSON.stringify([pick]) : null) };
  const keysFn = pageFunction(INDEX, ['window'], [KSRC], 'return refundOrderKeys;');
  const refundOrderKeys = keysFn({ sessionStorage: storage, ARENA_MARKET_LINES: () => [line] });
  const keys = refundOrderKeys();
  console.log('  REFUND-ONLY KEYS:', JSON.stringify([...keys]));

  assert.equal(line.state, 'won', `the verified winner (paid 300000 msat by the honest seats) reads '${line.state}': ${line.text}`);
  assert.equal(keys.size, 0, 'the winning order is among the refund-only orders whose record closes with "payout: none" once the stake is credited');
});

