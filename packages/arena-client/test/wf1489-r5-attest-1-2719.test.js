// kanban #1489 r5 attest-1: ONE SEAT'S UNPROVEN "VOID" ON GET /outcome IS SHOWN AS THE MARKET'S RESULT (P8, way around #1502 / #1615).
// The page believes an ATTESTED outcome only once its attestation verifies and rebuilds the payout itself (checkMarketOutcome,
// rebuildTable) - but a seat answering { state: 'VOID' } carries no evidence at all, and marketLines draws it as the result:
// "VOID - ... every stake comes back". For an attested market (not a market on a game) a seat holds VOID only by the market's
// deadline (attested.js marketVoided; a contradiction is DISPUTED); before that deadline on the page's own clock - or for a market
// with no deadline at all - an honest seat can never say VOID. btc-updown's market-page.js keeps the first answer that names the
// pick's row (answers.find(hasRow)), so one seat listed first that adds the row to its lie is the line the winner reads.
// SAFE: a VOID no rule allows yet, and that carries no evidence, is never drawn as the result ('void', "every stake comes back").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketLines } from '../src/market.js';

const rid = '77'.repeat(32);
const entry = 'aa'.repeat(32);
const base = { name: 'btc-updown', outcomes: ['Up', 'Down'], attestors: ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)], threshold: 2 };

test('a seat\'s bare VOID before the market\'s deadline is not drawn as the market\'s result', () => {
  const now = Date.now();
  // entries closed a minute ago; the market resolves 15 min after its close and has a further hour before any deadline VOID
  const market = { ...base, terms: { resolveAfterCloseMs: 900000n, deadlineAfterResolveMs: 3600000n } };
  const pick = { roundIdHex: rid, entryIdHex: entry, market, pick: 0, stakeMsat: 1_000_000n, entryCloseMs: now - 60000 };
  // the lying seat's whole answer: no attestation, no proof, a row for the pick so the page keeps it
  const lie = { state: 'VOID', why: 'no outcome was attested by the market\'s deadline: every stake goes back', table: { rows: [{ entryId: entry }] } };
  const [line] = marketLines({ picks: [pick], outcomes: new Map([[rid, lie]]), nowMs: now });
  console.log('  LINE:', JSON.stringify(line));
  assert.notEqual(line.state, 'void', 'one seat\'s unproven VOID, an hour before the market\'s deadline, is drawn as the result');
  assert.doesNotMatch(line.text, /every stake comes back/);
});

test('a seat\'s bare VOID for a market with no deadline (VOID only by a dispute, never by time) is not drawn as the result', () => {
  const now = Date.now();
  const market = { ...base, terms: null };
  const pick = { roundIdHex: rid, entryIdHex: entry, market, pick: 0, stakeMsat: 1_000_000n, entryCloseMs: now - 60000 };
  const [line] = marketLines({ picks: [pick], outcomes: new Map([[rid, { state: 'VOID', why: 'refunded' }]]), nowMs: now });
  console.log('  LINE:', JSON.stringify(line));
  assert.notEqual(line.state, 'void');
});
