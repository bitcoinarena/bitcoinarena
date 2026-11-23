// audit attest a6-1-1: ONE SEAT'S BARE "DISPUTED" ON GET /outcome REPLACES A VERIFIED WINNER'S RESULT (P8; gap in the #2719 fix).
// #2719 made marketLines refuse a seat's evidence-free VOID before the market's deadline, but the DISPUTED branch right below it is
// still drawn from the seat's word alone: { state: 'DISPUTED' } with no proof, no attestation, at any time, gives the line
// 'disputed' final: true - "the attestors contradicted themselves, nothing is paid". An honest seat answers DISPUTED only with the two
// standing attestations of different outcomes (server.js outcomeOf `proof`), each of which the page could check.
// Reach: btc-updown market-page.js ranks the answers holding the pick's row by how many seats serve their table byte for byte (#3019).
// The lying seat copies the honest seats' public table into its DISPUTED answer, so it ties with them, and being listed first it is
// `best`; an answer with no attestation is never checked, and it replaces the verified one (agreement equal, not greater).
// SAFE: a DISPUTED answer with no two verified standing attestations is never drawn as the market's decided result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { marketLines } from '../src/market.js';

const SCRIPT = readFileSync(new URL('../../btc-updown/page/market-page.js', import.meta.url), 'utf8');
const ROUND = 'ab'.repeat(32), ENTRY = 'cd'.repeat(32), LOSER = 'ee'.repeat(32);

function page(seats, pick) {
  const store = new Map([['arena.market.picks', JSON.stringify([pick])]]);
  const sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const json = (x) => ({ ok: x !== undefined && x !== null, json: async () => JSON.parse(JSON.stringify(x)) });
  const fetch = async (url) => {
    const u = new URL(url), s = seats[u.origin];
    if (!s) throw new Error('down');
    if (u.pathname === '/outcome') return json(s.outcome);
    if (u.pathname === '/book') return json(s.book);
    return json(null);
  };
  const ARENACLIENT = {
    fromHex: (x) => x, toHex: (x) => x,
    marketForRound: () => ({ name: 'updown' }),
    // the honest attestation verifies (as checkMarketOutcome would for the real, public one)
    checkMarketOutcome: async ({ outcome }) => (outcome.attestation === 'good' ? { verified: true, outcome: 0, label: 'Up' } : { verified: false, why: 'no' }),
  };
  const ctx = { sessionStorage, fetch, ARENACLIENT, console, setInterval: () => 0, setTimeout: () => 0, AbortSignal: { timeout: () => undefined },
    document: { getElementById: () => ({ insertAdjacentHTML() {} }) } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx);
  return ctx;
}

test('one seat\'s evidence-free DISPUTED (with the honest seats\' public table copied in) is not the verified winner\'s result', async () => {
  const now = Date.now();
  // the honest table: the pick won 1,000 sats -> 1,980 sats against one loser
  const table = { rows: [
    { entryId: ENTRY, pick: 0, stakeMsat: '1000000', feeMsat: '10000', donationMsat: '0', netMsat: '990000', payoutMsat: '1980000', won: true },
    { entryId: LOSER, pick: 1, stakeMsat: '1000000', feeMsat: '10000', donationMsat: '0', netMsat: '990000', payoutMsat: '0', won: false },
  ], refunded: false, losingPoolMsat: '990000' };
  const honest = { state: 'ATTESTED', final: false, finalAtMs: String(now + 300000), attestation: 'good', outcome: 0, label: 'Up', table };
  // the lying seat: no attestation, no proof - only the honest table copied so its answer ties on agreement
  const lie = { state: 'DISPUTED', why: 'two standing attestations name outcomes 0 and 1', table };
  const seats = { 'http://s1': { outcome: lie }, 'http://s2': { outcome: honest }, 'http://s3': { outcome: honest }, 'http://s4': { outcome: honest } };
  const pick = { roundIdHex: ROUND, entryIdHex: ENTRY, gameId: 'ef'.repeat(32), entryCloseMs: now - 960000, nodes: Object.keys(seats), stakeMsat: '1000000' };
  const P = page(seats, pick);
  await P.readMarketOutcomes();
  const kept = P.ARENA_MARKET_OUTCOMES.get(ROUND);
  console.log('  KEPT:', JSON.stringify({ state: kept.state, agreedBy: kept.agreedBy, verified: !!(kept.check && kept.check.verified) }));
  // the real marketLines over what the page kept (a market well inside its deadline)
  const market = { name: 'btc-updown', outcomes: ['Up', 'Down'], attestors: ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)], threshold: 2,
    terms: { resolveAfterCloseMs: 900000n, deadlineAfterResolveMs: 3600000n } };
  const [line] = marketLines({ picks: [{ roundIdHex: ROUND, entryIdHex: ENTRY, market, pick: 0, stakeMsat: 1_000_000n, entryCloseMs: now - 960000 }],
    outcomes: new Map([[ROUND, kept]]), nowMs: now });
  console.log('  LINE:', JSON.stringify(line));
  assert.notEqual(line.state, 'disputed', 'one seat\'s unproven DISPUTED is drawn as the decided result of a verified winner');
  assert.doesNotMatch(line.text, /nothing is paid/);
});

test('marketLines alone: a bare DISPUTED with no proof, inside the deadline, is not drawn as decided', () => {
  const now = Date.now();
  const market = { name: 'btc-updown', outcomes: ['Up', 'Down'], attestors: ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)], threshold: 2,
    terms: { resolveAfterCloseMs: 900000n, deadlineAfterResolveMs: 3600000n } };
  const [line] = marketLines({ picks: [{ roundIdHex: ROUND, entryIdHex: ENTRY, market, pick: 0, stakeMsat: 1_000_000n, entryCloseMs: now - 960000 }],
    outcomes: new Map([[ROUND, { state: 'DISPUTED' }]]), nowMs: now });
  console.log('  LINE:', JSON.stringify(line));
  assert.notEqual(line.state, 'disputed');
  assert.notEqual(line.final, true);
});
