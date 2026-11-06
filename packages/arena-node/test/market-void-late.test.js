// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE #1151 SCENARIO, OLD AND NEW (kanban #1151): VOID flipped back to ATTESTED after the deadline. A market with no outcome by its
// deadline is VOID and its stakes go back at once by the return door; a valid attestation or source result withheld until then
// and handed in late turned it ATTESTED again, and once its window passed the settlement claimed the locks already returned.
// This file reproduces it with nothing but what the old source exports too, so it fails there on its assertions: a market on a
// game at a real store (as game-market-settle.test.js) and an attested market with terms at two real seats with the fake
// federation, through their HTTP doors (as attested-settlement.test.js's deadline test). The state machine's own tests are
// market-terminal-state.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { gameMarkets, heldOutcomes, marketVoidOf } from '../src/game-market.js';
import { LockSettlement } from '../src/settlement.js';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { decodeManifest, gameIdOf, SOURCE_KIND, GAME_MARKET_REFUND } from '../../arena-protocol/src/manifest.js';
import { roundResultId } from '../../arena-protocol/src/round-result.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { GAME_MARKET_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { MANIFEST_V2_HEX as NEXTBLOCK_V2_HEX } from '../../nextblock/plugin/nextblock-v2.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame, attestorSign } from './plugins/sign.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { LOSER } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const seats = [1, 2, 3, 4, 5, 6, 7].map((n) => { const sk = b32(n + 40); return { sk, pk: schnorr.getPublicKey(sk), url: `http://seat${n}.example` }; });
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };

// A MARKET ON A TICK TOCK ROUND (feature 6), as game-market-settle.test.js has it: deadline entry close + 600 s + 1 h
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
const M = { ...BASE, protocolVersion: GAME_MARKET_VERSION, gameId: MARKET.registration.gameId, simCoreHash: new Uint8Array(32),
  configHash: new Uint8Array(32), startTimeMs: S - 900000n, entryCloseMs: S - 60000n, sourceRoundId: SOURCE_ID, stakeMsat: STAKE };
const RID = roundId(M);
const AFTER_END = Number(S) + 200000;
const DEADLINE = Number(M.entryCloseMs) + 600000 + 3600000;
const WINDOW = 600000;
const BULLS = [8297000, 8298000], BEARS = [8298000, 8297000];
const signedBy = (openCents, closeCents, keys) => {
  const id = roundResultId({ roundId: SOURCE_ID, openCents, closeCents });
  return { openCents, closeCents, sigs: keys.map((s) => ({ key: toHex(s.pk), signature: toHex(schnorr.sign(id, s.sk)) })) };
};
const drawFor = () => (id, role) => (role === 'settlement' && toHex(id) === toHex(SOURCE_ID)
  ? { ok: true, committee: seats.map((s) => ({ pubkey: s.pk, advert: { endpoint: s.url.replace('http:', 'ws:') } })) } : { ok: false, why: 'not drawn' });

function seatStore(path = ':memory:', at = AFTER_END) {
  const clock = { ms: at };
  const round = new Round(openStore(path), () => clock.ms, { plugins: [MARKET.registration] });
  for (const c of [SOURCE, M]) round.db.prepare('INSERT OR IGNORE INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(roundId(c), encodeRoundContract(c), 1);
  return { round, clock, markets: gameMarkets({ round, plugins: round.plugins, committeeFor: drawFor(), verify, now: () => clock.ms }) };
}
// FOUR PICKS (two each side) whose locks the settlement would claim; the store's own settlement rows (none) under it
const PICKS = [[0, 1n], [1, 2n], [0, 3n], [1, 2n]];
function withEntries(round) {
  const entries = PICKS.map(([pick, units], i) => ({ entryId: b32(0x30 + i), entry: { roundId: RID, playerPubkey: schnorr.getPublicKey(b32(0x70 + i)), stakeMsat: units * STAKE, feeMsat: 0n, donationMsat: 0n, pick, feePreimage: new Uint8Array(32) } }));
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
  return { view, settlement };
}

test('#1151 the scenario, a market on a game: VOID at its deadline, the stakes back - a late source result is refused, the round stays VOID, and nothing is ever claimed', async () => {
  const { round, clock, markets } = seatStore();
  const { view, settlement } = withEntries(round);
  // NO RESULT BY THE DEADLINE: VOID, the return door's reading opens (forfeit.js #marketRefund reads marketVoidOf's state)
  clock.ms = DEADLINE + 1000;
  const voidAt = await settlement.settle(RID);
  const door = marketVoidOf(view, RID, { contract: M, manifest: MARKET.registration.manifest, nowMs: clock.ms });
  assert.equal(voidAt.state, 'VOID');
  assert.equal(door.voided, true, 'the return door did not open at the deadline');
  // THE WITHHELD RESULT, VALID (5 of 7 of the source's committee), HANDED IN AFTER THE STAKES WENT BACK
  const late = await markets.hold(RID, signedBy(...BULLS, seats.slice(0, 5)));
  // AND A WINDOW LATER, AS THE SETTLEMENT SWEEP WOULD ASK
  clock.ms += WINDOW + 1000;
  const after = await settlement.settle(RID);
  const plan = await settlement.planOf(RID);
  const doorAfter = marketVoidOf(view, RID, { contract: M, manifest: MARKET.registration.manifest, nowMs: clock.ms });
  console.log(`  #1151 GAME MARKET: at deadline ${voidAt.state}, door ${door.voided ? 'open' : 'shut'} | late result: ${late.held ? `HELD (${late.label})` : `refused ${late.status}: ${late.why}`} | window later: ${after.state}, plan ${plan.ok ? `CLAIMS ${plan.plan.claims.length} locks` : 'none'}, door ${doorAfter.voided ? 'open' : 'shut'}`);
  assert.equal(late.held, undefined, 'a source result handed in after the deadline was held');
  assert.equal(late.status, 409);
  assert.match(late.why, /deadline was .*: no source result is taken after it/);
  assert.deepEqual(heldOutcomes(round, RID), []);
  assert.equal(after.state, 'VOID', 'the VOID market turned into one that settles');
  assert.equal(plan.ok, false, 'the settlement planned claims on locks the return door handed back');
  assert.equal(doorAfter.voided, true, 'the return door shut again');
});

// THE SCENARIO ON TWO SEATS, THROUGH THEIR DOORS: an attested market with terms (1 min to resolve, 1 min for its attestors)
const TERMS = { nodeFeeBps: 50, donationBps: 50, question: 'Where does BTC/USD close?', resolveAfterCloseMs: 60000n, deadlineAfterResolveMs: 60000n, sourceRule: 'median of three test feeds' };
const TERMS_MARKET = testAttestedGame({ name: 'btc-close-terms', outcomes: ['above 100k', 'between', 'below 90k'], marketTerms: TERMS });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: TERMS_MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
const [A0, , A2] = TERMS_MARKET.attestors;
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32(0x40 + n), worldSecret: b32(0) });

test('#1151 the scenario at two seats: VOID at the deadline, every stake back by the return door - a withheld attestation handed in late is refused, the round stays VOID, nothing settles', async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000, stakeExpiryFor: (c) => marketExpiryBlocks(c, TERMS).blocks,
    serveOpts: { plugins: [NEXTBLOCK, TERMS_MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const played = [];
    for (const [i, pick] of [0, 1].entries()) played.push(await lockAndPlay(w, player(i + 60), { noMarks: true, pick }));
    await closeRound(w, { window: false });
    const deadlineMs = Number(w.c.entryCloseMs) + 120000;
    const forfeit = (d, e) => fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(e.eid)}`).then((r) => r.status);
    skipTo(deadlineMs + 1000);
    const atDeadline = await w.a.settlements.settle(w.rid);
    const back = await Promise.all(played.map((e) => forfeit(w.a, e)));
    // THE ATTESTATION, VALID (2 of 3, observed after the resolution time), WITHHELD UNTIL THE STAKES WENT BACK
    const body = { roundId: w.rid, outcome: 0, observedAtMs: w.c.entryCloseMs + 60000n };
    const late = await Promise.all(w.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(w.rid)}`, { method: 'POST', body: encodeAttestation({ ...body, signatures: [A0, A2].map((a) => attestorSign(a, body)) }) })
      .then(async (r) => `${r.status} ${(await r.text()).slice(0, 140)}`)));
    const o = await (await fetch(`http://127.0.0.1:${w.a.port}/outcome?round=${toHex(w.rid)}`)).json();
    // A WINDOW LATER, AS THE SWEEP WOULD ASK
    skipTo(deadlineMs + 1000 + 600000 + 1000);
    const after = await w.a.settlements.settle(w.rid);
    const backAfter = await Promise.all(played.map((e) => forfeit(w.a, e)));
    const o2 = await (await fetch(`http://127.0.0.1:${w.a.port}/outcome?round=${toHex(w.rid)}`)).json();
    console.log('  #1151 TWO SEATS:', JSON.stringify({ atDeadline: atDeadline.state, back, late, outcomeAfterLate: [o.state, o.market], windowLater: after.state, why: after.why, backAfter, outcomeLater: [o2.state, o2.market] }));
    assert.equal(atDeadline.state, 'VOID');
    assert.deepEqual(back, [200, 200]);
    for (const l of late) assert.match(l, /^409 that market's deadline was .*: no outcome is taken after it/);
    assert.deepEqual([o.state, o.market], ['VOID', 'VOID']);
    assert.equal(after.state, 'VOID', 'the VOID market settled on a late attestation');
    assert.deepEqual(backAfter, [200, 200], 'the return door shut on a late attestation');
    assert.deepEqual([o2.state, o2.market], ['VOID', 'VOID']);
    for (const e of played) assert.ok((await w.port.status(e.outpoint)).stored, 'a returned stake lock was claimed');
  } finally { await w.close(); }
});
