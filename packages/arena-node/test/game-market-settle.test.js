// A MARKET ON A GAME SETTLED AT A SEAT (kanban #362 feature 6, §0A.7d; protocol 2026.0.6): the source round's signed result is
// HELD where an attestation is held (store.js game_outcomes) and every reader of an attested round's outcome reads it, so the
// market settles exactly as an attested market - pari-mutuel, final after the round's objection window - with the source's
// RoundResult and its committee's signatures as the evidence. FLAT (mapped to 0xff) is VOID at once, not at the deadline. A
// forged or 4-of-7 result is never held. The seat's own sweep resolves a market it holds once, and looks at each round of its
// store once. A seat without the source round fetches its contract from other seats and takes it only if it is the round the
// market names (a series round only as a series it holds derives it), then counts the committee it draws itself.
// Harness: a real store (openStore + Round) with the market and source rounds written in as a seat keeps them, a fake roster
// draw, fake seats behind an injected fetch; the settlement plan from LockSettlement over the same store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { gameMarkets, gameMarketSweep, heldOutcomes, marketVoidOf, gameEvidenceOf, NO_RESULT_ID } from '../src/game-market.js';
import { LockSettlement } from '../src/settlement.js';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { decodeManifest, gameIdOf, SOURCE_KIND, GAME_MARKET_REFUND } from '../../arena-protocol/src/manifest.js';
import { roundResultId, decodeRoundResult } from '../../arena-protocol/src/round-result.js';
import { pariMutuelTable } from '../../arena-protocol/src/attested.js';
import { seriesRound } from '../../arena-protocol/src/series.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { GAME_MARKET_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { MANIFEST_V2_HEX as NEXTBLOCK_V2_HEX } from '../../nextblock/plugin/nextblock-v2.js';
import { testAttestedGame } from './plugins/sign.js';
import { opts } from './window-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const seats = [1, 2, 3, 4, 5, 6, 7].map((n) => { const sk = b32(n + 40); return { sk, pk: schnorr.getPublicKey(sk), url: `http://seat${n}.example` }; });
const strangers = [1, 2, 3, 4, 5].map((n) => { const sk = b32(n + 90); return { sk, pk: schnorr.getPublicKey(sk) }; });
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };

const TICK_TOCK_ID = gameIdOf(decodeManifest(fromHex(NEXTBLOCK_V2_HEX)));
const MARKET = testAttestedGame({ name: 'tick-tock-fronts', outcomes: ['BULLS', 'BEARS'],
  marketTerms: { nodeFeeBps: 100, donationBps: 50, question: 'Which front wins this Tick Tock round?', resolveAfterCloseMs: 600000n,
    deadlineAfterResolveMs: 3600000n, sourceRule: 'the source round\'s RoundResult (§13), signed by 5 of its 7 seats' },
  gameSource: { sourceGameId: TICK_TOCK_ID, sourceKind: SOURCE_KIND.ROUND_RESULT, mapping: [0, 1, GAME_MARKET_REFUND] },
  requiredProtocolVersion: GAME_MARKET_VERSION });

const BASE = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: b32(0x67), simCoreHash: b32(1),
  startTimeMs: 0n, entryCloseMs: 0n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 0n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [],
};
const S = 1788200000000n;
const SOURCE = { ...BASE, protocolVersion: 2, gameId: TICK_TOCK_ID, startTimeMs: S, entryCloseMs: S + 45000n, nodes: seats.map((s) => s.pk) };
const SOURCE_ID = roundId(SOURCE);
const STAKE = 1_000_000n;
const market = (over = {}) => ({ ...BASE, protocolVersion: GAME_MARKET_VERSION, gameId: MARKET.registration.gameId, simCoreHash: new Uint8Array(32),
  configHash: new Uint8Array(32), startTimeMs: S - 900000n, entryCloseMs: S - 60000n, sourceRoundId: SOURCE_ID, stakeMsat: STAKE, ...over });
// THE SOURCE ROUND HAS ENDED by S + 200 s (9000 ticks); the market's deadline is entry close + 600 s + 1 h
const AFTER_END = Number(S) + 200000;

const resultOf = (openCents, closeCents, sid = SOURCE_ID) => ({ roundId: sid, openCents, closeCents });
const signedBy = (openCents, closeCents, keys, sid = SOURCE_ID) => {
  const id = roundResultId(resultOf(openCents, closeCents, sid));
  return { openCents, closeCents, sigs: keys.map((s) => ({ key: toHex(s.pk), signature: toHex(schnorr.sign(id, s.sk)) })) };
};
const BULLS = [8297000, 8298000], BEARS = [8298000, 8297000], FLAT = [8297000, 8297000];

/** A seat's store holding `rounds` (written as POST /round keeps them), on a clock the test moves. */
function seatStore(rounds) {
  const clock = { ms: AFTER_END };
  const round = new Round(openStore(':memory:'), () => clock.ms, { plugins: [MARKET.registration] });
  for (const c of rounds) round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(roundId(c), encodeRoundContract(c), 1);
  return { round, clock };
}
// THE ROSTER'S DRAW FOR THE SOURCE: the seven seats, each advertising where it answers - never the source contract's `nodes`.
// `asked` records each draw; a draw for a source this seat does not hold must be made on the fetched contract (`posted`)
function drawFor(asked = []) {
  return (id, role, o) => {
    asked.push({ id: toHex(id), role, posted: !!(o && o.posted) });
    if (role !== 'settlement' || toHex(id) !== toHex((o && o.posted && roundId(o.posted)) || SOURCE_ID)) return { ok: false, why: 'not drawn' };
    return { ok: true, committee: seats.map((s) => ({ pubkey: s.pk, advert: { endpoint: s.url.replace('http:', 'ws:') } })) };
  };
}
const json = (x) => ({ ok: true, status: 200, json: async () => x });
const bytes = (b) => ({ ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
const missing = { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
/** Fake seats: `answers` maps a seat's URL to what it answers GET /round-result with (a result signed by that seat), `contracts` to GET /round. */
function seatsAnswering({ results = {}, contracts = {} } = {}, calls = []) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    const base = `${u.protocol}//${u.host}`;
    if (u.pathname === '/round-result' && results[base]) return json(results[base]);
    if (u.pathname === '/round' && contracts[base]) return bytes(contracts[base]);
    return missing;
  };
}
const resultBy = (seat, [openCents, closeCents], sid = SOURCE_ID) => {
  const id = roundResultId(resultOf(openCents, closeCents, sid));
  return { ok: true, round: toHex(sid), openCents, closeCents, key: toHex(seat.pk), signature: toHex(schnorr.sign(id, seat.sk)) };
};

// FOUR PICKS: two on BULLS (1 and 3 units), two on BEARS (2 and 2) - net stakes as their locks hold them, no fee
const PICKS = [[0, 1n], [1, 2n], [0, 3n], [1, 2n]];
function withEntries(round, rid) {
  const entries = PICKS.map(([pick, units], i) => {
    const playerPubkey = schnorr.getPublicKey(b32(0x70 + i));
    return { entryId: b32(0x30 + i), entry: { roundId: rid, playerPubkey, stakeMsat: units * STAKE, feeMsat: 0n, donationMsat: 0n, pick, feePreimage: new Uint8Array(32) } };
  });
  const CLAIM = new Uint8Array(33).fill(2);
  const view = Object.assign(Object.create(round), {
    entriesOf: () => entries,
    stakeSeen: () => ({ paidMsat: STAKE, seenMs: 1 }),
    stakeLock: (eid) => { const e = entries.find((x) => toHex(x.entryId) === toHex(eid)); return { outpoint: `${toHex(b32(0x50 + eid[0] - 0x30))}:0`,
      fields: lockFieldsToJson({ paymentImage: { kind: 'hash', bytes: b32(9) }, amountMsat: e.entry.stakeMsat, claimPk: CLAIM, refundPk: refundKeyOf(e.entry.playerPubkey), expiration: 1000 }) }; },
    feeLock: () => null,
    lockSettlement: () => null,
    fedLockSettlementsOf: () => [],
  });
  const settlement = new LockSettlement(view, { dkg: { signerNodeFor: () => ({ ok: true, pool: { groupPublicKey: CLAIM } }) },
    port: { settle: async () => ({}), fees: async () => ({ ppm: 0n, baseMsat: 0n }) } });
  return { view, entries, settlement };
}

test('a held source result settles the market pari-mutuel: the same table, the losers\' locks claimed, the winners paid their shares - after the objection window', async () => {
  const M = market();
  const rid = roundId(M);
  const { round, clock } = seatStore([SOURCE, M]);
  const markets = gameMarkets({ round, plugins: round.plugins, committeeFor: drawFor(), verify, now: () => clock.ms });
  const got = await markets.hold(rid, signedBy(...BULLS, seats.slice(0, 5)));
  assert.equal(got.held, true, got.why);
  assert.deepEqual([got.fresh, got.outcome, got.label, got.signers, got.voided], [true, 0, 'BULLS', 5, false]);
  // HELD ONCE: the same result again changes nothing
  assert.equal((await markets.hold(rid, signedBy(...BULLS, seats.slice(2)))).fresh, false);
  // THE EVIDENCE KEPT: the RoundResult's bytes, only the committee's verifying signatures, the source contract - re-verifiable
  const [g] = round.gameOutcomes(rid);
  const x = decodeRoundResult(g.result);
  assert.deepEqual([toHex(x.roundId), x.openCents, x.closeCents, g.outcome, g.observedMs > Number(S)], [toHex(SOURCE_ID), ...BULLS, 0, true]);
  assert.equal(g.sigs.length, 5);
  for (const s of g.sigs) assert.equal(verify(fromHex(s.signature), roundResultId(x), fromHex(s.key)), true);
  assert.deepEqual(g.source, encodeRoundContract(SOURCE));
  assert.equal(gameEvidenceOf(g).front, 'BULLS');
  // EVERY READER OF AN ATTESTED ROUND'S OUTCOME SEES IT: held as outcome 0, received now
  assert.deepEqual(heldOutcomes(round, rid).map((h) => [h.outcome, h.receivedMs]), [[0, clock.ms]]);

  const { view, entries, settlement } = withEntries(round, rid);
  // INSIDE THE OBJECTION WINDOW: held, nothing settles
  const inside = await settlement.planOf(rid);
  assert.equal(inside.ok, false);
  assert.match(inside.why, /inside its objection window: its outcome is final at/);
  // PAST IT: the pari-mutuel plan - the BEARS' locks claimed, each BULLS pick paid its table share of their pool
  clock.ms += 600001;
  const plan = await settlement.planOf(rid);
  assert.equal(plan.ok, true, plan.why);
  const table = pariMutuelTable({ entries: entries.map(({ entryId, entry }) => ({ entryId, ...entry })), outcome: 0 });
  assert.deepEqual(plan.table.rows.map((r) => [r.entryId, String(r.payoutMsat)]), table.rows.map((r) => [r.entryId, String(r.payoutMsat)]));
  assert.deepEqual(plan.plan.claims.filter((c) => c.kind === 'stake').map((c) => String(c.amountMsat)).sort(), [String(2n * STAKE), String(2n * STAKE)]);
  const paid = plan.plan.payouts.filter((p) => p.kind === 'qualifier').map((p) => [toHex(p.pubkey), p.msat]);
  // the pool of 4 units split 1 : 3 over the BULLS picks
  assert.deepEqual(paid.sort(), [[toHex(entries[0].entry.playerPubkey), STAKE], [toHex(entries[2].entry.playerPubkey), 3n * STAKE]].sort());
  for (const p of paid) assert.equal(p[1], table.rows.find((r) => r.entryId === toHex(entries.find((e) => toHex(e.entry.playerPubkey) === p[0]).entryId)).payoutMsat
    - table.rows.find((r) => r.entryId === toHex(entries.find((e) => toHex(e.entry.playerPubkey) === p[0]).entryId)).netMsat);
  assert.equal(marketVoidOf(view, rid, { contract: M, manifest: MARKET.registration.manifest, nowMs: clock.ms + 10 ** 9 }).voided, false, 'a held outcome is never VOID, even past the deadline');
  console.log(`  FACTS: ${got.why} | paid ${paid.map((p) => `${p[0].slice(0, 8)} ${p[1]}`).join(', ')} msat`);
});

test('FLAT is VOID at once: held as a refund, the settlement VOID long before the deadline, nothing claimed; a source that can never fit too', async () => {
  const M = market();
  const rid = roundId(M);
  const { round, clock } = seatStore([SOURCE, M]);
  const markets = gameMarkets({ round, plugins: round.plugins, committeeFor: drawFor(), verify, now: () => clock.ms });
  const { view, settlement } = withEntries(round, rid);
  // BEFORE: no outcome, inside the deadline - only held
  const before = await settlement.settle(rid);
  assert.equal(before.state, 'HELD');
  const flat = await markets.hold(rid, signedBy(...FLAT, seats));
  assert.deepEqual([flat.held, flat.fresh, flat.refund, flat.voided, flat.value], [true, true, true, true, 'FLAT']);
  assert.deepEqual(round.gameOutcomes(rid).map((g) => g.outcome), [GAME_MARKET_REFUND]);
  assert.deepEqual(heldOutcomes(round, rid), [], 'a refund is not an outcome to pay');
  const deadline = Number(M.entryCloseMs) + 600000 + 3600000;
  assert.ok(clock.ms < deadline - 3000000, 'the test is not well before the deadline');
  const now = await settlement.settle(rid);
  assert.equal(now.state, 'VOID');
  assert.match(now.why, /the source round ended FLAT, which this market refunds: every stake goes back/);
  const v = marketVoidOf(view, rid, { contract: M, manifest: MARKET.registration.manifest, nowMs: clock.ms });
  assert.deepEqual([v.voided, v.early], [true, true]);
  const plan = await settlement.planOf(rid);
  assert.equal(plan.ok, false, 'a VOID market has a plan');
  // A MARKET WHOSE ENTRIES CLOSE AFTER ITS SOURCE STARTS: no result needed, VOID at once with the source contract as evidence
  const L = market({ entryCloseMs: S + 1n });
  const s2 = seatStore([SOURCE, L]);
  const late = await gameMarkets({ round: s2.round, plugins: s2.round.plugins, committeeFor: drawFor(), verify, now: () => s2.clock.ms }).hold(roundId(L), null);
  assert.deepEqual([late.held, late.void, late.voided], [true, true, true]);
  const [g] = s2.round.gameOutcomes(roundId(L));
  assert.deepEqual([toHex(g.resultId), g.outcome, g.result.length], [toHex(NO_RESULT_ID), GAME_MARKET_REFUND, 0]);
  assert.match(g.why, /its source does not fit it: .*after its source round [0-9a-f]{16} starts at/);
  console.log(`  FACTS: FLAT ${now.state} - ${now.why} | late: ${g.why}`);
});

test('never held: 4 of 7, a stranger\'s five, the committee\'s signatures over another result, another round\'s result, and any result before the source ended', async () => {
  const M = market();
  const rid = roundId(M);
  const { round, clock } = seatStore([SOURCE, M]);
  const markets = gameMarkets({ round, plugins: round.plugins, committeeFor: drawFor(), verify, now: () => clock.ms });
  const four = await markets.hold(rid, signedBy(...BULLS, seats.slice(0, 4)));
  const outsiders = await markets.hold(rid, signedBy(...BULLS, strangers));
  // signed BEARS, handed in as BULLS: no signature verifies over the BULLS result
  const bears = signedBy(...BEARS, seats);
  const swapped = await markets.hold(rid, { openCents: BULLS[0], closeCents: BULLS[1], sigs: bears.sigs });
  const otherRound = await markets.hold(rid, signedBy(...BULLS, seats, b32(0x99)));
  clock.ms = Number(S) + 1000;
  const early = await markets.hold(rid, signedBy(...BULLS, seats));
  const all = [four, outsiders, swapped, otherRound, early];
  for (const g of all) assert.notEqual(g.held, true, `held: ${g.why}`);
  assert.match(four.why, /does not stand: 4 of the committee signed it, 5 are needed/);
  assert.match(outsiders.why, /0 of the committee signed it/);
  assert.match(swapped.why, /0 of the committee signed it/);
  assert.match(early.why, /runs until .*: no result of it is taken before its end/);
  assert.deepEqual(round.gameOutcomes(rid), []);
  // A FORGED HOLD IN THE STORE IS NOT WHAT THE DOOR TAKES: the only rows are ones that stood
  console.log(`  FACTS: ${all.map((g) => g.why.slice(0, 90)).join(' | ')}`);
});

test('the sweep resolves a held market on its own, once: each round of the store looked at once, the source\'s committee asked only when due', async () => {
  const M = market();
  const rid = roundId(M);
  const OTHER = { ...SOURCE, startTimeMs: S + 90000n, entryCloseMs: S + 135000n };
  const { round, clock } = seatStore([SOURCE, OTHER, M]);
  clock.ms = Number(S) - 120000;                                // before the market's entries close
  const calls = [];
  // SIX SEATS SIGN BULLS, ONE LIES BEARS: its signature counts only towards the result it signed
  const results = Object.fromEntries(seats.map((s, i) => [s.url, resultBy(s, i === 6 ? BEARS : BULLS)]));
  const markets = gameMarkets({ round, plugins: round.plugins, committeeFor: drawFor(), verify, now: () => clock.ms, fetcher: seatsAnswering({ results }, calls) });
  let rowsRead = 0;
  const held = [];
  const sweep = gameMarketSweep({ markets, round, plugins: round.plugins, now: () => clock.ms,
    roundsAfter: (after, n) => { const r = round.db.prepare('SELECT rowid, round_id, contract FROM rounds WHERE rowid > ? ORDER BY rowid LIMIT ?').all(after, n); rowsRead += r.length; return r; },
    onHeld: (id, got) => held.push([toHex(id), got.outcome]) });
  const p1 = await sweep.pass();
  assert.deepEqual([p1.scanned, p1.pending, p1.tried, calls.length], [3, 1, 0, 0], 'the market is pending; nothing asked before its entries close');
  clock.ms = Number(S) + 1000;                                  // the source runs: not ended
  const p2 = await sweep.pass();
  assert.deepEqual([p2.scanned, p2.tried, calls.length], [0, 1, 0], 'asked the source\'s committee before the source ended');
  const p3 = await sweep.pass();
  assert.equal(p3.tried, 0, 'tried again before its source\'s end');
  clock.ms = AFTER_END;
  const p4 = await sweep.pass();
  assert.deepEqual([p4.tried, p4.held, p4.pending], [1, 1, 0], JSON.stringify(p4));
  assert.deepEqual(held, [[toHex(rid), 0]]);
  assert.equal(calls.filter((u) => u.includes('/round-result')).length, 7);
  const [g] = round.gameOutcomes(rid);
  assert.equal(g.sigs.length, 6, 'not the six honest seats\' signatures');
  // AND THEN NEVER AGAIN: no round re-read, no seat asked
  const asked = calls.length;
  for (let i = 0; i < 3; i++) { clock.ms += 60000; const p = await sweep.pass(); assert.deepEqual([p.scanned, p.tried], [0, 0]); }
  assert.equal(calls.length, asked);
  assert.equal(rowsRead, 3, 'a round of the store was read twice');
  // A NEW ROUND IS LOOKED AT ONCE, from where the cursor stood
  const M2 = market({ entryCloseMs: S - 61000n });
  round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(roundId(M2), encodeRoundContract(M2), 1);
  const p5 = await sweep.pass();
  assert.deepEqual([p5.scanned, p5.held, rowsRead], [1, 1, 4]);
  console.log(`  FACTS: passes ${JSON.stringify([p1, p2, p4, p5].map((p) => [p.scanned, p.tried, p.held]))}, ${asked} asks, ${rowsRead} rows read`);
});

test('a seat without the source round fetches it: a lying seat\'s contract is passed over, the honest one checked against the id, the committee drawn on it here', async () => {
  const M = market();
  const rid = roundId(M);
  const { round, clock } = seatStore([M]);
  const LIE = { ...SOURCE, startTimeMs: S + 1000n };            // another contract: another id
  const calls = [];
  const asked = [];
  const results = Object.fromEntries(seats.map((s) => [s.url, resultBy(s, BULLS)]));
  const fetcher = seatsAnswering({ results, contracts: { 'http://liar.example': encodeRoundContract(LIE), 'http://honest.example': encodeRoundContract(SOURCE) } }, calls);
  // ONLY THE LIAR: nothing is taken
  const alone = gameMarkets({ round, plugins: round.plugins, committeeFor: drawFor(asked), verify, now: () => clock.ms, fetcher,
    sourcePeers: () => ['http://liar.example'] });
  const refused = await alone.resolveOnce(rid);
  assert.equal(refused.done, false);
  assert.match(refused.why, /no seat answered source round [0-9a-f]{16} as the round this market names: http:\/\/liar\.example: that contract is round [0-9a-f]{16}; market "tick-tock-fronts"'s round is on/);
  assert.deepEqual(round.gameOutcomes(rid), []);
  // THE LIAR FIRST, THEN THE HONEST SEAT
  const markets = gameMarkets({ round, plugins: round.plugins, committeeFor: drawFor(asked), verify, now: () => clock.ms, fetcher,
    sourcePeers: () => ['http://liar.example', 'http://honest.example'] });
  const got = await markets.resolveOnce(rid);
  assert.equal(got.done, true, got.why);
  assert.deepEqual([got.held.outcome, got.held.signers], [0, 7]);
  assert.ok(asked.some((a) => a.id === toHex(SOURCE_ID) && a.posted), 'the committee was not drawn on the fetched contract');
  assert.deepEqual(round.gameOutcomes(rid)[0].source, encodeRoundContract(SOURCE), 'the evidence is not the checked contract');
  assert.ok(!round.get(SOURCE_ID), 'a fetched source was written into the store as a held round');
  // A SERIES SOURCE: its id does not hash its times - a seat answering the right id with other times is refused against the series
  // this seat holds, and with no series held, nothing is taken
  const template = { ...SOURCE };
  const src = seriesRound(template, 3);
  const SM = market({ sourceRoundId: roundId(src), entryCloseMs: src.startTimeMs - 60000n });
  const forged = { ...src, startTimeMs: src.startTimeMs + 1000n };
  assert.deepEqual(roundId(forged), roundId(src));
  const s3 = seatStore([SM]);
  s3.clock.ms = Number(src.startTimeMs) + 200000;
  const seriesFetch = seatsAnswering({ results: Object.fromEntries(seats.map((s) => [s.url, resultBy(s, BEARS, roundId(src))])),
    contracts: { 'http://liar.example': encodeRoundContract(forged), 'http://honest.example': encodeRoundContract(src) } });
  const draw = (id, role, o) => (role === 'settlement' && o && o.posted && toHex(roundId(o.posted)) === toHex(roundId(src))
    ? { ok: true, committee: seats.map((s) => ({ pubkey: s.pk, advert: { endpoint: s.url } })) } : { ok: false, why: 'not drawn' });
  const peers = () => ['http://liar.example', 'http://honest.example'];
  const noSeries = await gameMarkets({ round: s3.round, plugins: s3.round.plugins, committeeFor: draw, verify, now: () => s3.clock.ms, fetcher: seriesFetch, sourcePeers: peers })
    .resolveOnce(roundId(SM));
  assert.equal(noSeries.done, false);
  assert.match(noSeries.why, /http:\/\/liar\.example: source round [0-9a-f]{16}: that round names series [0-9a-f]{16}, and this node holds no such series/);
  const withSeries = await gameMarkets({ round: s3.round, plugins: s3.round.plugins, committeeFor: draw, verify, now: () => s3.clock.ms, fetcher: seriesFetch, sourcePeers: peers,
    seriesHeld: () => [template] }).resolveOnce(roundId(SM));
  assert.equal(withSeries.done, true, withSeries.why);
  assert.equal(withSeries.held.outcome, 1);
  assert.deepEqual(s3.round.gameOutcomes(roundId(SM))[0].source, encodeRoundContract(src), 'the forged series contract was kept');
  console.log(`  FACTS: liar alone: ${refused.why.slice(0, 160)} | series, none held: ${noSeries.why.slice(0, 120)}`);
});

test('the seat serves it: GET /outcome names a held game outcome with its evidence and table, a held VOID as VOID; the attested sweep reads the table', async () => {
  const d = await serve(openStore(':memory:'), { plugins: [MARKET.registration], port: 0, ...opts });
  try {
    const M = market({ stakeMsat: 0n });
    const V = market({ stakeMsat: 0n, entryCloseMs: S - 61000n });
    for (const c of [SOURCE, M, V]) d.round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(roundId(c), encodeRoundContract(c), 1);
    const result = signedBy(...BEARS, seats);
    const x = resultOf(...BEARS);
    const put = (rid, outcome, why = null) => d.round.putGameOutcome({ roundId: rid, resultId: roundResultId(x), sourceRoundId: SOURCE_ID, outcome, why,
      result: new Uint8Array([0]), sigs: result.sigs, source: encodeRoundContract(SOURCE), observedMs: AFTER_END, receivedMs: d.round.now() });
    assert.equal(put(roundId(M), 1), true);
    assert.equal(put(roundId(V), GAME_MARKET_REFUND, 'the source round ended FLAT, which this market refunds: every stake goes back'), true);
    const get = async (rid) => (await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`)).json();
    const o = await get(roundId(M));
    assert.deepEqual([o.state, o.outcome, o.label, o.final, !!o.attestation], ['ATTESTED', 1, 'BEARS', false, false]);
    assert.deepEqual([o.gameOutcome.source, o.gameOutcome.sourceContract, o.gameOutcome.sigs.length], [toHex(SOURCE_ID), toHex(encodeRoundContract(SOURCE)), 7]);
    assert.ok(o.table, 'no pari-mutuel table');
    const v = await get(roundId(V));
    assert.deepEqual([v.state, v.gameOutcome.void], ['VOID', true]);
    assert.match(v.why, /FLAT/);
    // THE ATTESTED SWEEP'S QUERY (started 1 s after start, every 5 s) reads game_outcomes beside the attestations without failing
    await new Promise((r) => setTimeout(r, 6500));
    console.log(`  GET /outcome: ${o.state} ${o.label}, evidence ${Object.keys(o.gameOutcome).join(',')} | VOID: ${v.why}`);
  } finally { await d.close(); }
});
