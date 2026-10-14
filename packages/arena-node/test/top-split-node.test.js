// TOP-N PRIZE SPLITS AT THE NODE (kanban #362 feature 3): the node reads a round's payout rule off the manifest it hosts the
// round's game under (plugins.js payoutRuleOfRound), and its settlement plan, its signed table and its standing line all
// compute the protocol's table - the same F a slash proof recomputes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payoutRuleOfRound } from '../src/plugins.js';
import { tableFor } from '../src/payout-table.js';
import { federationPlans } from '../src/settlement.js';
import { computePayoutTable, payoutTableId, DELIVERED, FAILED, FORFEIT } from '../../arena-protocol/src/payout.js';
import { gameIdOf, PAYOUT_RULE } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_MANIFEST, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const RID = b32(0x5f);
const NO_FEES = { ppm: 0n, baseMsat: 0n };
const SHARES = [5000, 3000, 2000];
// a split game: nextblock's manifest with the split, signed or not (the node's rule reads the hosted manifest; the
// signature is hostedPlugins' business, checked when the game is installed)
const SPLIT = { ...NEXTBLOCK_MANIFEST, payoutRule: PAYOUT_RULE.TOP_SPLIT, payoutShares: SHARES, requiredProtocolVersion: 4 };
const SPLIT_ID = gameIdOf(SPLIT);
const hosted = new Map([[toHex(SPLIT_ID), { manifest: SPLIT, gameId: SPLIT_ID }], [toHex(NEXTBLOCK_GAME_ID), { manifest: NEXTBLOCK_MANIFEST, gameId: NEXTBLOCK_GAME_ID }]]);

const STAKE = 100003n;                                      // odd, so the floors leave something for the remainder order
const entry = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: 0n, donationMsat: 0n, outcome, score, entryId: b32(0x10 + n) });
const ENTRIES = [entry(1, DELIVERED, 900), entry(2, DELIVERED, 800), entry(3, DELIVERED, 700), entry(4, DELIVERED, 600),
  entry(5, FAILED, 0), entry(6, FORFEIT, 0), entry(7, FAILED, 0)];

test('the node reads the rule off the game it hosts: the split for a split game, the curve for nextblock, refused for a v4 round it does not host', () => {
  assert.deepEqual(payoutRuleOfRound({ gameId: SPLIT_ID, protocolVersion: 4 }, hosted), { ok: true, payoutShares: SHARES });
  assert.deepEqual(payoutRuleOfRound({ gameId: NEXTBLOCK_GAME_ID, protocolVersion: 3 }, hosted), { ok: true, payoutShares: null });
  assert.deepEqual(payoutRuleOfRound({ gameId: NEXTBLOCK_GAME_ID, protocolVersion: 4 }, hosted), { ok: true, payoutShares: null });
  const blind = payoutRuleOfRound({ gameId: b32(0x99), protocolVersion: 4 }, hosted);
  assert.equal(blind.ok, false);
  assert.match(blind.why, /no manifest of game 9999/);
  // a node with no plugins map (an older test fixture) and a pre-split round: the curve, as before
  assert.deepEqual(payoutRuleOfRound({ gameId: NEXTBLOCK_GAME_ID, protocolVersion: 3 }, undefined), { ok: true, payoutShares: null });
});

test('the node\'s signed table is the protocol\'s table under the split', () => {
  const { payoutShares } = payoutRuleOfRound({ gameId: SPLIT_ID, protocolVersion: 4 }, hosted);
  const node = tableFor({ roundId: RID, entries: ENTRIES, minScore: 1, payoutShares });
  const protocol = computePayoutTable({ roundId: RID, entries: ENTRIES, minScore: 1, payoutShares: SHARES });
  assert.equal(toHex(node.tableId), toHex(payoutTableId({ roundId: RID, table: protocol.table })));
  const curve = tableFor({ roundId: RID, entries: ENTRIES, minScore: 1 });
  assert.notEqual(toHex(curve.tableId), toHex(node.tableId), 'the split is not the curve');
  // 3 losers' locks = 300009 msat: 150004.5 / 90002.7 / 60001.8 -> floors 150004 / 90002 / 60001, two msat left over
  const won = protocol.table.map((r) => r.amountMsat - (ENTRIES.find((e) => toHex(e.pubkey) === toHex(r.pubkey)).outcome === DELIVERED ? STAKE : 0n));
  assert.equal(won.slice(0, 4).reduce((s, x) => s + x, 0n), 300009n);
  console.log(`  FACTS (split table, winnings by place): ${won.slice(0, 4).join(' / ')} msat`);
});

test('the node\'s settlement plan pays the split: each qualifier\'s payout is its table winnings, the losers\' locks the pot', () => {
  const locks = new Map(ENTRIES.map((e) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + e.pubkey[0]), outIdx: BigInt(e.pubkey[0]) }, amountMsat: STAKE, refundPk: refund(e.pubkey[0]) }]));
  const plan = (payoutShares) => federationPlans({ roundId: RID, entries: ENTRIES, minScore: 1, payoutShares, locks, feeLocks: new Map() },
    { federationOf: () => 'aa'.repeat(32), feesOf: () => NO_FEES });
  const got = plan(SHARES);
  assert.equal(got.ok, true, got.why);
  const table = computePayoutTable({ roundId: RID, entries: ENTRIES, minScore: 1, payoutShares: SHARES });
  const owed = new Map(table.table.map((r) => [toHex(r.pubkey), r.amountMsat - STAKE]));
  const paid = got.plan.payouts.filter((p) => p.kind === 'qualifier');
  assert.equal(paid.length, 3, 'the top three places are paid; the 4th keeps its stake (its lock is not claimed)');
  for (const p of paid) assert.equal(p.msat, owed.get(toHex(p.pubkey)), `place ${p.pubkey[0]}`);
  assert.equal(got.plan.poolMsat, 3n * STAKE);
  assert.deepEqual(got.plan.claims.map((c) => Number(c.outpoint.outIdx)).sort(), [5, 6, 7]);
  // and the curve's plan for the same round is the curve's: K = ceil(4 / 4) = 1, the winner takes the pot
  const curve = plan(null);
  assert.deepEqual(curve.plan.payouts.filter((p) => p.kind === 'qualifier').map((p) => [p.pubkey[0], p.msat]), [[1, 3n * STAKE]]);
});
