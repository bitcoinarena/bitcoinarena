// A MARKET ON A GAME AT A SEAT (kanban #362 feature 6; protocol 2026.0.6): the node hook (src/game-market.js) checks a market
// round's outcome from its source round's RoundResult signed with the seats' node keys (BIP-340), against the source round the
// seat holds and the settlement committee its roster draws - never the contract's `nodes`. 5 of 7 stands, 4 of 7 or a
// stranger's do not, FLAT refunds, a seat without the source refuses by name, and a market whose entries closed after its
// source started is VOID. Harness: the hook on a store of two rounds and the hosted-games map a seat builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { gameMarketHook } from '../src/game-market.js';
import { hostedPlugins } from '../src/plugins.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { decodeManifest, gameIdOf, SOURCE_KIND, GAME_MARKET_REFUND } from '../../arena-protocol/src/manifest.js';
import { roundResultId } from '../../arena-protocol/src/round-result.js';
import { GAME_MARKET_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { MANIFEST_V2_HEX as NEXTBLOCK_V2_HEX } from '../../nextblock/plugin/nextblock-v2.js';
import { testAttestedGame } from './plugins/sign.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { opts } from './window-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const seats = [1, 2, 3, 4, 5, 6, 7].map((n) => { const sk = b32(n + 40); return { sk, pk: schnorr.getPublicKey(sk) }; });
const stranger = (() => { const sk = b32(99); return { sk, pk: schnorr.getPublicKey(sk) }; })();
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };

const TICK_TOCK_ID = gameIdOf(decodeManifest(fromHex(NEXTBLOCK_V2_HEX)));
const MARKET = testAttestedGame({ name: 'tick-tock-fronts', outcomes: ['BULLS', 'BEARS'],
  marketTerms: { nodeFeeBps: 100, donationBps: 50, question: 'Which front wins this Tick Tock round?', resolveAfterCloseMs: 600000n,
    deadlineAfterResolveMs: 3600000n, sourceRule: 'the source round\'s RoundResult (§13), signed by 5 of its 7 seats' },
  gameSource: { sourceGameId: TICK_TOCK_ID, sourceKind: SOURCE_KIND.ROUND_RESULT, mapping: [0, 1, GAME_MARKET_REFUND] },
  requiredProtocolVersion: GAME_MARKET_VERSION });
const PLUGINS = hostedPlugins([MARKET.registration]);

const BASE = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: b32(0x67), simCoreHash: b32(1),
  startTimeMs: 0n, entryCloseMs: 0n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 0n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [],
};
const S = 1788200000000n;
// THE SOURCE ROUND'S CONTRACT NAMES A STRANGER AMONG ITS NODES: from version 2 its id does not hash them, so the hook must not
// count by them - it counts by the roster's draw
const SOURCE = { ...BASE, protocolVersion: 2, gameId: TICK_TOCK_ID, startTimeMs: S, entryCloseMs: S + 45000n, nodes: [...seats.slice(0, 6).map((s) => s.pk), stranger.pk] };
const SOURCE_ID = roundId(SOURCE);
const market = (over = {}) => ({ ...BASE, protocolVersion: GAME_MARKET_VERSION, gameId: MARKET.registration.gameId, simCoreHash: new Uint8Array(32),
  configHash: new Uint8Array(32), startTimeMs: S - 900000n, entryCloseMs: S - 60000n, sourceRoundId: SOURCE_ID, ...over });

function seat({ rounds, committee = seats, nowMs = S + 200000n }) {
  const rows = new Map(rounds.map((c) => [toHex(roundId(c)), { contract: encodeRoundContract(c) }]));
  const round = { get: (id) => rows.get(toHex(id)) || null };
  const committeeFor = (id, role) => (role === 'settlement' && toHex(id) === toHex(SOURCE_ID) ? { ok: true, committee: committee.map((s) => ({ pubkey: s.pk })) } : { ok: false, why: 'not drawn' });
  return gameMarketHook({ round, plugins: PLUGINS, committeeFor, verify, now: () => Number(nowMs) });
}
const signedBy = (openCents, closeCents, keys) => {
  const id = roundResultId({ roundId: SOURCE_ID, openCents, closeCents });
  return { openCents, closeCents, sigs: keys.map((s) => ({ key: toHex(s.pk), signature: toHex(schnorr.sign(id, s.sk)) })) };
};

test('a seat resolves a market on a game from its source round\'s RoundResult: 5 of 7 BIP-340 signatures stand, 4 or a stranger\'s do not', () => {
  const M = market();
  const resolve = seat({ rounds: [SOURCE, M] });
  const rid = roundId(M);
  const bulls = resolve(rid, signedBy(8297000, 8298000, seats.slice(0, 5)));
  assert.equal(bulls.ok, true, bulls.why);
  assert.deepEqual([bulls.outcome, bulls.label, bulls.signers, bulls.threshold, bulls.voided, bulls.source], [0, 'BULLS', 5, 5, false, toHex(SOURCE_ID)]);
  const bears = resolve(rid, { ...signedBy(8298000, 8297000, seats.slice(1, 6)), front: 'BEARS' });
  assert.deepEqual([bears.ok, bears.outcome, bears.label], [true, 1, 'BEARS']);
  const four = resolve(rid, signedBy(8297000, 8298000, seats.slice(0, 4)));
  assert.equal(four.ok, false);
  assert.match(four.why, /does not stand: 4 of the committee signed it, 5 are needed/);
  // THE STRANGER IS IN THE SOURCE CONTRACT'S `nodes`, NOT IN THE ROSTER'S DRAW: its signature counts nothing
  const withStranger = resolve(rid, signedBy(8297000, 8298000, [...seats.slice(0, 4), stranger]));
  assert.equal(withStranger.ok, false);
  assert.match(withStranger.why, /4 of the committee signed it, 5 are needed/);
  console.log(`  FACTS: ${bulls.why} | 4 of 7: ${four.why}`);
});

test('a seat answers FLAT as a refund (VOID), a late market as VOID, and refuses by name without the source round or for another game', () => {
  const M = market();
  const flat = seat({ rounds: [SOURCE, M] })(roundId(M), signedBy(8297000, 8297000, seats));
  assert.deepEqual([flat.ok, flat.refund, flat.value, flat.voided], [true, true, 'FLAT', true]);
  // ENTRIES CLOSED A MILLISECOND AFTER THE SOURCE STARTED: VOID, however well the result is signed
  const L = market({ entryCloseMs: S + 1n });
  const late = seat({ rounds: [SOURCE, L] })(roundId(L), signedBy(8297000, 8298000, seats));
  assert.deepEqual([late.ok, late.void, late.voided], [false, true, true]);
  assert.match(late.why, /after its source round [0-9a-f]{16} starts at/);
  // NO SOURCE ROUND HELD HERE
  const none = seat({ rounds: [M] })(roundId(M), signedBy(8297000, 8298000, seats));
  assert.deepEqual([none.ok, none.status], [false, 404]);
  assert.match(none.why, /this seat holds no source round [0-9a-f]{16}/);
  // NO ROUND AT ALL; AND A ROUND OF A GAME THE SEAT DOES NOT HOST
  assert.equal(seat({ rounds: [SOURCE] })(roundId(M), {}).status, 404);
  const notHosted = seat({ rounds: [SOURCE] })(roundId(SOURCE), signedBy(8297000, 8298000, seats));
  assert.equal(notHosted.ok, false);
  assert.match(notHosted.why, /does not host game/);
  // NOTHING STANDING BY THE DEADLINE (entry close + 600 s + 1 h): VOID on the seat's clock
  const deadline = M.entryCloseMs + 600000n + 3600000n;
  const short = seat({ rounds: [SOURCE, M], nowMs: deadline })(roundId(M), signedBy(8297000, 8298000, seats.slice(0, 3)));
  assert.deepEqual([short.ok, short.voided], [false, true]);
  assert.match(short.voidWhy, /no signed result of its source round stood by the market's deadline/);
});

test('the door: POST /game-outcome reaches the hook - 400 without a round or a JSON result, 404 for a round not held, and the roster asked for the source round\'s committee', async () => {
  const d = await serve(openStore(':memory:'), { plugins: [MARKET.registration], port: 0, ...opts });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const post = async (q, body) => { const r = await fetch(`${base}/game-outcome${q}`, { method: 'POST', body }); return { status: r.status, text: (await r.text()).trim() }; };
    const M = market();
    const result = JSON.stringify(signedBy(8297000, 8298000, seats));
    const noRound = await post('', result);
    const notJson = await post(`?round=${toHex(roundId(M))}`, 'nope');
    const notHeld = await post(`?round=${toHex(roundId(M))}`, result);
    // BOTH ROUNDS HELD (written as a seat's store keeps them): the hook reads them and asks the roster for the source's committee,
    // which this one-seat test node with no census cannot draw - refused by name, not answered on the contract's `nodes`
    for (const c of [SOURCE, M]) d.round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(roundId(c), encodeRoundContract(c), 1);
    const noDraw = await post(`?round=${toHex(roundId(M))}`, result);
    console.log(`  POST /game-outcome: ${noRound.status} "${noRound.text}" | ${notJson.status} | ${notHeld.status} "${notHeld.text}" | ${noDraw.status} "${noDraw.text}"`);
    assert.equal(noRound.status, 400);
    assert.equal(notJson.status, 400);
    assert.equal(notHeld.status, 404); assert.match(notHeld.text, /holds no such round/);
    assert.equal(noDraw.status, 409); assert.match(noDraw.text, /no settlement committee of source round [0-9a-f]{16} is drawn here/);
  } finally { await d.close(); }
});
