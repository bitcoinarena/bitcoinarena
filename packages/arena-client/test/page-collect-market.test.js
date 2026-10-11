// EVERY COLLECT OF A MARKET ROUND CARRIES ITS MARKET'S TERMS (kanban #336, measured 2026-10-11 by the bots on the regtest
// Up/Down market: a filled order's payout and an unfilled order's return were never collected - "owed: no stake is locked
// to this round: that round names stake_expiry_blocks 34770 where §23.1 rules 144"). The page's own roundAsk (page-script.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const from = '    function withMarketTerms(round) {';
const at = HTML.indexOf(from); assert.ok(at > 0);
const SLICE = HTML.slice(at, HTML.indexOf('\n    }\n', HTML.indexOf('function roundAsk(r, LockClient) {', at)) + '\n    }\n'.length);

const ask = (marketTerms) => pageFunction(PAGE, ['BLWPCLIENT', 'window', 'vault'], SLICE, 'return roundAsk;')(
  { marketForRound: (r) => (r.market ? { terms: marketTerms } : null), fromHex: (h) => h }, { BLWP_CURVE: {} }, () => ({}));

test('a market round\'s collect asks with its market\'s terms; a game round\'s with its contract as it is', () => {
  const terms = { resolveAfterCloseMs: 0n };
  const roundAsk = ask(terms);
  const market = roundAsk({ round: { market: true, stakeExpiryBlocks: 34770 }, roundIdHex: 'ab', invite: 'i', seed: 's', nodes: [], order: 2 }, 'LC');
  assert.equal(market.round.marketTerms, terms, 'the terms the lock span is checked by');
  assert.equal(market.round.stakeExpiryBlocks, 34770);
  assert.equal(market.order, 2);
  const game = roundAsk({ round: { stakeExpiryBlocks: 144 }, roundIdHex: 'cd', invite: 'i', seed: 's', nodes: [] }, 'LC');
  assert.equal(game.round.marketTerms, undefined);
});
