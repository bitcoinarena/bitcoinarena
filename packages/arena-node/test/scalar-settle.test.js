// A SCALAR MARKET SETTLED AT A SEAT (kanban #362 feature 8; protocol 2026.0.7): its attestors' VALUE attestation comes in at
// POST /outcome beside the outcome attestations, is held in the same table and read back by its own type byte, and every reader
// of an attested round's outcome reads the value: the settlement makes the scalar table (LONG (V - low) / (high - low) of the net
// pool, SHORT the rest) and pays it by the lock rule - a row paid less than its stake has its lock claimed and its rest paid back,
// a row paid more keeps its lock and is paid the excess; the stake-share handout releases exactly the claimed rows; the return
// door hands every stake back at once when one side had nobody. An index attestation is refused for it, a value for any other
// market; two values are DISPUTED and VOID, as is no value by the deadline.
// Harness: a real store (openStore + Round) with the market round written in as a seat keeps it, the settlement plan from
// LockSettlement over the same store (as game-market-settle.test.js), and one served seat for the door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { heldOutcomes, marketVoidOf, VALUE_HELD_OUTCOME } from '../src/game-market.js';
import { LockSettlement } from '../src/settlement.js';
import { StakeSecrets } from '../src/stake-secret.js';
import { Forfeit } from '../src/forfeit.js';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { encodeValueAttestation, valueAttestationBodyId, scalarPayoutTable } from '../../arena-protocol/src/scalar.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { SCALAR_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { testAttestedGame, attestorSign, attestorSignValue } from './plugins/sign.js';
import { opts } from './window-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const TERMS = { nodeFeeBps: 100, donationBps: 50, question: 'BTC/USD at 18:00 UTC, in points of a 0..100 index?', resolveAfterCloseMs: 600000n,
  deadlineAfterResolveMs: 3600000n, sourceRule: 'the index as three exchanges print it at the resolution time' };
const MARKET = testAttestedGame({ name: 'index-at-18', outcomes: ['LONG', 'SHORT'], marketTerms: TERMS, scalar: { low: 0n, high: 100n, unit: 'points' },
  requiredProtocolVersion: SCALAR_VERSION });
const BUCKETS = testAttestedGame({ name: 'index-buckets', outcomes: ['below 50', 'at or above 50'], marketTerms: TERMS });
const [A0, A1, A2] = MARKET.attestors;

const BASE = {
  networkId: b32(0x4e), configHash: new Uint8Array(32), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: new Uint8Array(32),
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', bondMinSats: 100000n, blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656,
  spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [],
};
const S = 1788200000000n;
const STAKE = 1_000_000n;
const market = (over = {}) => ({ ...BASE, protocolVersion: SCALAR_VERSION, gameId: MARKET.registration.gameId, startTimeMs: S - 900000n, entryCloseMs: S,
  stakeMsat: STAKE, ...over });
const RESOLVE_AT = S + TERMS.resolveAfterCloseMs;
const valueOf = (rid, value, by = [A0, A2], observedAtMs = RESOLVE_AT) => {
  const body = { roundId: rid, value, observedAtMs };
  return { ...body, signatures: by.map((a) => attestorSignValue(a, body)) };
};

/** A seat's store holding `rounds`, on a clock the test moves - just past the market's resolution time. */
function seatStore(rounds, plugins = [MARKET.registration]) {
  const clock = { ms: Number(RESOLVE_AT) + 1000 };
  const round = new Round(openStore(':memory:'), () => clock.ms, { plugins });
  for (const c of rounds) round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(roundId(c), encodeRoundContract(c), 1);
  return { round, clock };
}
/** A value held as the door holds it (server.js POST /outcome). */
const holdValue = (round, a, receivedMs) => round.putOutcomeAttestation({ bodyId: valueAttestationBodyId(a), roundId: a.roundId, outcome: VALUE_HELD_OUTCOME,
  observedAtMs: a.observedAtMs, bytes: encodeValueAttestation(a), receivedMs });

// FOUR ENTRIES: LONG 3 and 1 units, SHORT 2 and 2 - net stakes as their locks hold them, no fee
const PICKS = [[0, 3n], [0, 1n], [1, 2n], [1, 2n]];
// `feeLocks`: the view holds a fee lock per entry (the return door's fee path reads one); the settlement tests hold none, as
// game-market-settle.test.js
function withEntries(round, rid, picks = PICKS, { feeLocks = false } = {}) {
  const entries = picks.map(([pick, units], i) => {
    const playerPubkey = schnorr.getPublicKey(b32(0x70 + i));
    return { entryId: b32(0x30 + i), entry: { roundId: rid, playerPubkey, stakeMsat: units * STAKE, feeMsat: 0n, donationMsat: 0n, pick, feePreimage: new Uint8Array(32) } };
  });
  const CLAIM = new Uint8Array(33).fill(2);
  const lockOf = (eid) => { const e = entries.find((x) => toHex(x.entryId) === toHex(eid)); return { outpoint: `${toHex(b32(0x50 + eid[0] - 0x30))}:0`,
    fields: lockFieldsToJson({ paymentImage: { kind: 'hash', bytes: b32(9) }, amountMsat: e.entry.stakeMsat, claimPk: CLAIM, refundPk: refundKeyOf(e.entry.playerPubkey), expiration: 1000 }) }; };
  const view = Object.assign(Object.create(round), {
    entriesOf: () => entries,
    stakeSeen: () => ({ paidMsat: STAKE, seenMs: 1 }),
    stakeLock: lockOf,
    feeLock: feeLocks ? lockOf : () => null,
    lockSettlement: () => null,
    fedLockSettlementsOf: () => [],
  });
  const settlement = new LockSettlement(view, { dkg: { signerNodeFor: () => ({ ok: true, pool: { groupPublicKey: CLAIM } }) },
    port: { settle: async () => ({}), fees: async () => ({ ppm: 0n, baseMsat: 0n }) } });
  return { view, entries, settlement };
}

test('a held value settles the market by the scalar table: the locks of rows paid less claimed, each paid its rest, the others their excess - after the objection window', async () => {
  const M = market();
  const rid = roundId(M);
  const { round, clock } = seatStore([M]);
  assert.equal(holdValue(round, valueOf(rid, 25n), clock.ms), true);
  // EVERY READER OF AN ATTESTED ROUND'S OUTCOME SEES THE VALUE: decoded by its own type byte, no index
  const held = heldOutcomes(round, rid);
  assert.deepEqual(held.map((h) => [h.value, h.outcome, h.receivedMs]), [[25n, undefined, clock.ms]]);
  assert.deepEqual(round.outcomeAttestations(rid).map((r) => Number(r.outcome)), [VALUE_HELD_OUTCOME]);

  const { view, entries, settlement } = withEntries(round, rid);
  const inside = await settlement.planOf(rid);
  assert.equal(inside.ok, false);
  assert.match(inside.why, /inside its objection window: its outcome is final at/);
  clock.ms += 600001;
  const plan = await settlement.planOf(rid);
  assert.equal(plan.ok, true, plan.why);
  // THE TABLE IS THE PROTOCOL'S: pool 8 units, LONG a quarter (2) split 3 : 1, SHORT 6 split evenly
  const table = scalarPayoutTable({ entries: entries.map(({ entryId, entry }) => ({ entryId, ...entry })), value: 25n, bounds: MARKET.registration.manifest.scalar });
  assert.deepEqual(plan.table.rows.map((r) => [r.entryId, r.payoutMsat, r.won]), table.rows.map((r) => [r.entryId, r.payoutMsat, r.won]));
  assert.deepEqual(table.rows.map((r) => r.payoutMsat), [1_500_000n, 500_000n, 3_000_000n, 3_000_000n]);
  // CLAIMED: the two LONG locks (3 and 1 units); PAID: LONG its rest back, SHORT its excess over its own lock
  assert.deepEqual(plan.plan.claims.filter((c) => c.kind === 'stake').map((c) => c.amountMsat).sort(), [STAKE, 3n * STAKE]);
  const paid = Object.fromEntries(plan.plan.payouts.filter((p) => p.kind === 'qualifier').map((p) => [entries.findIndex((e) => toHex(e.entry.playerPubkey) === toHex(p.pubkey)), p.msat]));
  assert.deepEqual(paid, { 0: 1_500_000n, 1: 500_000n, 2: STAKE, 3: STAKE });
  assert.equal(marketVoidOf(view, rid, { contract: M, manifest: MARKET.registration.manifest, nowMs: clock.ms + 10 ** 9 }).voided, false, 'a held value is never VOID, even past the deadline');

  // THE STAKE-SHARE HANDOUT RELEASES EXACTLY THE CLAIMED ROWS' SECRETS
  const secrets = new StakeSecrets(view, { curve: null, random: () => new Uint8Array(32) });
  const may = entries.map((e) => secrets.mayRelease(rid, e.entryId));
  assert.deepEqual(may.map((m) => m.ok), [true, true, false, false]);
  assert.equal(may[0].outcome, 'SCALAR_CLAIMED');
  assert.match(may[2].why, /gets back at least its stake: its lock is its own/);
  console.log(`  FACTS: V 25 of 0..100 points | paid ${JSON.stringify(paid, (k, v) => (typeof v === 'bigint' ? String(v) : v))} | release ${may.map((m) => m.ok)}`);
});

test('one side only: the return door hands every stake and fee back at once; two sides: it waits for the settlement', async () => {
  const M = market();
  const rid = roundId(M);
  const { round, clock } = seatStore([M]);
  holdValue(round, valueOf(rid, 80n), clock.ms);
  clock.ms += 600001;
  const refusedClaimKey = { signerNodeFor: () => ({ ok: false, why: 'no claim-key share in this test' }) };
  // BOTH SIDES: a fee lock is not handed back - it is claimed at resolution
  const both = withEntries(round, rid, PICKS, { feeLocks: true });
  const waits = await new Forfeit(both.view, { dkg: refusedClaimKey }).message(rid, both.entries[0].entryId, 'fee');
  assert.match(waits.why, /a fee lock comes back at once only for a cancelled order or a refunded market/);
  // LONG ONLY: refunded - the door goes on to sign the return (and stops here only at this test's missing claim-key share)
  const longs = withEntries(round, rid, [[0, 3n], [0, 1n]], { feeLocks: true });
  const back = await new Forfeit(longs.view, { dkg: refusedClaimKey }).message(rid, longs.entries[0].entryId, 'fee');
  const settleLongs = withEntries(round, rid, [[0, 3n], [0, 1n]]);
  assert.match(back.why, /holds no share of the round's claim key: no claim-key share in this test/);
  const plan = await settleLongs.settlement.planOf(rid);
  assert.equal(plan.ok, false, 'a one-sided round has a plan');
  assert.match(plan.why, /only the LONG side staked: no counterparty, every stake comes back, its fee too: nothing is claimed/);
  const secrets = new StakeSecrets(longs.view, { curve: null, random: () => new Uint8Array(32) });
  assert.match(secrets.mayRelease(rid, longs.entries[0].entryId).why, /only the LONG side staked/);
  console.log(`  FACTS: two sides - ${waits.why.slice(0, 80)} | one side - ${back.why.slice(0, 80)} | plan - ${plan.why.slice(0, 80)}`);
});

test('a scalar market trades its sides in a book too (kanban #362, §0A.7e): an order passes the door\'s scalar rule, and a plain pick of a side does', () => {
  const M = market();
  const rid = roundId(M);
  const { round, clock } = seatStore([M]);
  clock.ms = Number(S) - 1000;                                  // its entries still open
  const pick = { roundId: rid, pick: 0, worldSecret: new Uint8Array(32), sessionPubkey: b32(0x11) };
  // an order at a whole cent: no longer refused for being on a scalar market (it stops later, at this harness's missing stake)
  let orderWhy = null;
  try { round.enter({ ...pick, limitPrice: 50000n }); } catch (e) { orderWhy = e.message; }
  assert.doesNotMatch(String(orderWhy), /scalar market/);
  // a plain pick passes that rule (and stops later, at this harness's missing stake)
  let why = null;
  try { round.enter(pick); } catch (e) { why = e.message; }
  assert.doesNotMatch(String(why), /no order|order book/);
  // a side beyond SHORT is out of range, as any pick
  assert.throws(() => round.enter({ ...pick, pick: 2 }), /picks outcome 2, out of range: game "index-at-18" has 2 outcomes/);
});

test('two values are DISPUTED and VOID; no value by the deadline is VOID', async () => {
  const M = market();
  const rid = roundId(M);
  const { round, clock } = seatStore([M]);
  const { settlement } = withEntries(round, rid);
  const open = await settlement.settle(rid);
  assert.equal(open.state, 'HELD');
  // NO VALUE BY THE DEADLINE: entry close + 600 s + 1 h
  clock.ms = Number(RESOLVE_AT + TERMS.deadlineAfterResolveMs);
  const late = await settlement.settle(rid);
  assert.equal(late.state, 'VOID');
  assert.match(late.why, /no outcome was attested by the market's deadline/);
  // TWO VALUES: the pair is the proof
  const N = market({ entryCloseMs: S + 1n });
  const s2 = seatStore([N]);
  const nid = roundId(N);
  holdValue(s2.round, valueOf(nid, 40n), s2.clock.ms);
  holdValue(s2.round, valueOf(nid, 41n, [A1, A2]), s2.clock.ms + 1);
  const w = withEntries(s2.round, nid);
  const d = await w.settlement.settle(nid);
  assert.equal(d.state, 'VOID');
  assert.match(d.why, /contradicted themselves: two standing attestations name value 40 and value 41/);
});

test('the door: a value attestation is held for a scalar round and served with its bounds; an index is refused for it, a value for any other market; two values DISPUTED', async () => {
  const d = await serve(openStore(':memory:'), { plugins: [MARKET.registration, BUCKETS.registration], port: 0, ...opts });
  try {
    const M = market({ stakeMsat: 0n });
    const B = market({ stakeMsat: 0n, gameId: BUCKETS.registration.gameId });
    for (const c of [M, B]) d.round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(roundId(c), encodeRoundContract(c), 1);
    const rid = roundId(M), bid = roundId(B);
    const post = async (id, bytes) => { const r = await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(id)}`, { method: 'POST', body: bytes }); return [r.status, (await r.text()).trim()]; };
    const get = async (id) => (await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(id)}`)).json();
    // BEFORE ITS RESOLUTION TIME: not the value it asked for
    const early = await post(rid, encodeValueAttestation(valueOf(rid, 30n, [A0, A1], RESOLVE_AT - 1n)));
    // AN INDEX FOR THE SCALAR ROUND, a VALUE FOR THE BUCKETS ROUND - each signed by the market's own attestors
    const indexBody = { roundId: rid, outcome: 0, observedAtMs: RESOLVE_AT };
    const index = await post(rid, encodeAttestation({ ...indexBody, signatures: [A0, A1].map((a) => attestorSign(a, indexBody)) }));
    const wrongMarket = await post(bid, encodeValueAttestation(valueOf(bid, 30n)));
    const short = await post(rid, encodeValueAttestation(valueOf(rid, 30n, [A0])));
    const ok = await post(rid, encodeValueAttestation(valueOf(rid, 130n)));
    const again = await post(rid, encodeValueAttestation(valueOf(rid, 130n)));
    console.log('  DOOR:', JSON.stringify({ early, index, wrongMarket, short, ok: [ok[0], JSON.parse(ok[1]).why], again: again[0] }));
    assert.equal(early[0], 409);
    assert.match(early[1], /before the market's resolution time/);
    assert.equal(index[0], 409);
    assert.match(index[1], /is a scalar market: its attestors sign the observed value/);
    assert.equal(wrongMarket[0], 409);
    assert.match(wrongMarket[1], /is not a scalar market/);
    assert.equal(short[0], 409);
    assert.match(short[1], /carries 1 attestor signature\(s\)/);
    assert.equal(ok[0], 201);
    assert.equal(again[0], 200, 'the same value again is held already');
    const o = await get(rid);
    assert.deepEqual([o.state, o.value, o.clamped, o.final, o.scalar], ['ATTESTED', '130', '100', false, { low: '0', high: '100', unit: 'points' }]);
    assert.ok(o.attestation && o.attestation.startsWith('2a0007'), 'GET /outcome carries no value attestation bytes for a page to check');
    assert.ok(o.table && o.table.refunded === true, 'no scalar table (a round with no entry is refunded)');
    // A SECOND VALUE: DISPUTED, both named
    assert.equal((await post(rid, encodeValueAttestation(valueOf(rid, 131n, [A1, A2]))))[0], 201);
    const dis = await get(rid);
    assert.deepEqual([dis.state, dis.valuesNamed, dis.proof.length], ['DISPUTED', ['130', '131'], 2]);
  } finally { await d.close(); }
});
