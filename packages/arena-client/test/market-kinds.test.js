// THE PAGE'S MARKET LINES FOR PROTOCOLS 6 AND 7 (kanban #362, docs/PLATFORM-RESEARCH.md items 6 and 8): a scalar market's value and
// a market on a game's source result, each checked by the page itself before a line says what a pick won - the value against the
// attestors its manifest names, the source result against the committee the page derives (never the seats' list).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify as edVerify, createPublicKey } from 'node:crypto';
import { marketForRound, checkMarketOutcome, marketLines, scalarValueLine, pickRecord, fetchSeriesTemplate, roundOfPick } from '../src/market.js';
import { seriesId, seriesRound } from '../../arena-protocol/src/series.js';
import { seriesLineOf } from '../../arena-protocol/src/series-line.js';
import { encodeManifest, manifestBodyId, gameIdOf, decodeManifest, RESULT_TYPE, PAYOUT_RULE, NO_PARENT, SOURCE_KIND, GAME_MARKET_REFUND,
  SCALAR_SIDES } from '../../arena-protocol/src/manifest.js';
import { encodeValueAttestation, valueAttestationBodyId } from '../../arena-protocol/src/scalar.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { roundResultId } from '../../arena-protocol/src/round-result.js';
import { GAME_MARKET_VERSION, SCALAR_VERSION, SCALAR_TEMPLATE_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { MANIFEST_V2_HEX as NEXTBLOCK_V2_HEX } from '../../nextblock/plugin/nextblock-v2.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const edKey = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; };
const verifyEd = (sig, digest, key) => edVerify(null, Buffer.from(digest), createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));
const signed = (dev, b) => ({ ...b, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(b)), dev.key)) });
const BASE = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: b32(0x67), simCoreHash: b32(1),
  startTimeMs: 1788200000000n, entryCloseMs: 1788200060000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(4), b32(7), b32(9)],
};
const MARKET_BODY = { version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED, cores: [], runTicksMax: 0, roundPeriodMs: 0n,
  payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0, clients: [], gameDonationSetId: b32(0xd0) };

// ---- A SCALAR MARKET ---------------------------------------------------------------------------------------------------------
const DEV = edKey();
const ATTESTORS = [edKey(), edKey(), edKey()].sort((x, y) => Buffer.compare(Buffer.from(x.pub), Buffer.from(y.pub)));
const SCALAR_M = signed(DEV, { ...MARKET_BODY, gameName: 'btc-at-18', gameDevPubkey: DEV.pub, outcomes: [...SCALAR_SIDES], attestors: ATTESTORS.map((a) => a.pub),
  attestThreshold: 2, scalar: { low: 8000000n, high: 9000000n, unit: 'USD cents' }, requiredProtocolVersion: SCALAR_VERSION,
  marketTerms: { nodeFeeBps: 100, donationBps: 50, question: 'BTC/USD at 18:00 UTC?', resolveAfterCloseMs: 3600000n, deadlineAfterResolveMs: 3600000n, sourceRule: 'median, cents' } });
const SCALAR_ROUND = { ...BASE, protocolVersion: SCALAR_VERSION, gameId: gameIdOf(SCALAR_M), simCoreHash: new Uint8Array(32), configHash: new Uint8Array(32), nodes: [] };
const SCALAR_RID = roundId(SCALAR_ROUND);
const valueAtt = (value, by, rid = SCALAR_RID) => {
  const body = { roundId: rid, value, observedAtMs: 1788203660000n };
  return toHex(encodeValueAttestation({ ...body, signatures: by.map((a) => ({ key: a.pub, signature: new Uint8Array(sign(null, Buffer.from(valueAttestationBodyId(body)), a.key)) })) }));
};

test('a scalar market\'s value is believed only signed by its manifest\'s attestors for this round, and its line says the value and the share', async () => {
  const market = marketForRound({ gameId: SCALAR_ROUND.gameId }, { manifestBytes: encodeManifest(SCALAR_M) });
  assert.deepEqual([market.scalar.low, market.scalar.high, market.scalar.unit], [8000000n, 9000000n, 'USD cents']);
  const rid = toHex(SCALAR_RID);
  const ok = await checkMarketOutcome({ outcome: { attestation: valueAtt(8300000n, ATTESTORS.slice(0, 2)) }, market, roundIdHex: rid, verify: verifyEd });
  assert.deepEqual([ok.verified, ok.value, ok.clamped], [true, 8300000n, 8300000n], ok.why);
  const one = await checkMarketOutcome({ outcome: { attestation: valueAtt(8300000n, ATTESTORS.slice(0, 1)) }, market, roundIdHex: rid, verify: verifyEd });
  assert.match(one.why, /carries 1 attestor signature/);
  const other = await checkMarketOutcome({ outcome: { attestation: valueAtt(8300000n, ATTESTORS.slice(0, 2), b32(9)) }, market, roundIdHex: rid, verify: verifyEd });
  assert.match(other.why, /not this round/);
  const stranger = edKey();
  const forged = await checkMarketOutcome({ outcome: { attestation: valueAtt(8300000n, [ATTESTORS[0], stranger]) }, market, roundIdHex: rid, verify: verifyEd });
  assert.match(forged.why, /does not name as an attestor/);
  const above = await checkMarketOutcome({ outcome: { attestation: valueAtt(9500000n, ATTESTORS.slice(1)) }, market, roundIdHex: rid, verify: verifyEd });
  assert.deepEqual([above.value, above.clamped], [9500000n, 9000000n]);

  const pick = { roundIdHex: rid, entryIdHex: 'e1'.repeat(32), market, pick: 0, stakeMsat: '100000', entryCloseMs: '1' };
  const table = { refunded: false, rows: [{ entryId: 'e1'.repeat(32), netMsat: '98500', payoutMsat: '118200', won: true }] };
  const [line] = marketLines({ picks: [pick], outcomes: new Map([[rid, { state: 'ATTESTED', label: 'LONG', final: true, table, check: ok }]]), nowMs: 2 });
  assert.equal(line.text, `btc-at-18 ${rid.slice(0, 8)}: value 83,000.00 USD between 80,000.00 USD and 90,000.00 USD (2 of 3 attestors, verified) · 'LONG' gets 118.2 of your 98.5 sats · +19.7`);
  const [clampedLine] = marketLines({ picks: [{ ...pick, pick: 1 }], outcomes: new Map([[rid, { state: 'ATTESTED', label: 'LONG', final: false,
    table: { refunded: false, rows: [{ entryId: 'e1'.repeat(32), netMsat: '98500', payoutMsat: '0', won: false }] }, check: above }]]), nowMs: 2 });
  assert.match(clampedLine.text, /value 95,000.00 USD \(paid as 90,000.00 USD\) .* 'SHORT' gets 0 of your 98.5 sats · -98.5 \(final after the objection window\)$/);
  const [waiting] = marketLines({ picks: [pick], outcomes: new Map(), nowMs: 2 });
  assert.match(waiting.text, /waiting for 2 of 3 attestors to sign the value$/);
  assert.equal(scalarValueLine(-5n, 'USD cents'), '-0.05 USD');
  assert.equal(scalarValueLine(144n, 'blocks'), '144 blocks');
});

// ---- A MARKET ON A GAME ------------------------------------------------------------------------------------------------------
const COMMITTEE = Array.from({ length: 7 }, edKey);
const TICK_TOCK_ID = gameIdOf(decodeManifest(fromHex(NEXTBLOCK_V2_HEX)));
const GAME_M = signed(DEV, { ...MARKET_BODY, gameName: 'tick-tock-fronts', gameDevPubkey: DEV.pub, outcomes: ['BULLS', 'BEARS'], attestors: [], attestThreshold: 0,
  gameSource: { sourceGameId: TICK_TOCK_ID, sourceKind: SOURCE_KIND.ROUND_RESULT, mapping: [0, 1, GAME_MARKET_REFUND] }, requiredProtocolVersion: GAME_MARKET_VERSION,
  marketTerms: { nodeFeeBps: 100, donationBps: 50, question: 'Which front wins?', resolveAfterCloseMs: 600000n, deadlineAfterResolveMs: 3600000n, sourceRule: '5 of 7' } });
const S = 1788200000000n;
const SOURCE = { ...BASE, protocolVersion: 2, gameId: TICK_TOCK_ID, startTimeMs: S, entryCloseMs: S + 45000n, nodes: COMMITTEE.map((k) => k.pub) };
const SOURCE_ID = roundId(SOURCE);
const GAME_ROUND = { ...BASE, protocolVersion: GAME_MARKET_VERSION, gameId: gameIdOf(GAME_M), simCoreHash: new Uint8Array(32), configHash: new Uint8Array(32),
  startTimeMs: S - 900000n, entryCloseMs: S - 60000n, nodes: [], sourceRoundId: SOURCE_ID };
const sigsOf = (r, keys) => keys.map((k) => ({ key: toHex(k.pub), signature: toHex(new Uint8Array(sign(null, Buffer.from(roundResultId(r)), k.key))) }));
const evidence = (openCents, closeCents, keys, source = SOURCE) => ({ source: toHex(roundId(source)), sourceContract: toHex(encodeRoundContract(source)),
  outcome: null, void: false, openCents: String(openCents), closeCents: String(closeCents), sigs: sigsOf({ roundId: roundId(source), openCents, closeCents }, keys) });

test('a market on a game is believed only from its source round\'s result, signed by the committee the page derived, and says so', async () => {
  const market = marketForRound({ gameId: GAME_ROUND.gameId }, { manifestBytes: encodeManifest(GAME_M) });
  assert.equal(market.gameSource.sourceGameId, toHex(TICK_TOCK_ID));
  const record = pickRecord({ roundIdHex: toHex(roundId(GAME_ROUND)), entryIdHex: 'e2'.repeat(32), pick: 0, round: GAME_ROUND, nodes: ['https://seat.example'] });
  assert.equal(record.sourceRoundIdHex, toHex(SOURCE_ID));
  const derived = async () => COMMITTEE.map((k) => toHex(k.pub));
  const args = { market, roundIdHex: record.roundIdHex, sourceRoundIdHex: record.sourceRoundIdHex, entryCloseMs: record.entryCloseMs, verifySchnorr: verifyEd };
  const ok = await checkMarketOutcome({ ...args, outcome: { gameOutcome: evidence(8300000, 8310000, COMMITTEE.slice(0, 5)) }, sourceCommittee: derived });
  assert.deepEqual([ok.verified, ok.label, ok.value], [true, 'BULLS', 'BULLS'], ok.why);
  const four = await checkMarketOutcome({ ...args, outcome: { gameOutcome: evidence(8300000, 8310000, COMMITTEE.slice(0, 4)) }, sourceCommittee: derived });
  assert.equal(four.verified, false);
  // THE SEATS' OWN COMMITTEE IS NEVER TAKEN: signatures by keys the page did not derive count for nothing
  const strangers = Array.from({ length: 5 }, edKey);
  const forged = await checkMarketOutcome({ ...args, outcome: { gameOutcome: evidence(8300000, 8310000, strangers) }, sourceCommittee: derived });
  assert.equal(forged.verified, false);
  const noDerive = await checkMarketOutcome({ ...args, outcome: { gameOutcome: evidence(8300000, 8310000, COMMITTEE) }, sourceCommittee: async () => null });
  assert.match(noDerive.why, /could not derive the source round's committee/);
  // A SOURCE ROUND OF A SERIES (Tick Tock's): checked as its series derives it, from a template the seats hand and the id checks
  const TEMPLATE = { ...SOURCE, startTimeMs: S - 3n * 90000n, entryCloseMs: S - 3n * 90000n, committeeTimeMs: S - 13n * 3600000n };
  const series = seriesRound(TEMPLATE, 3);
  assert.equal(series.startTimeMs, S, 'round 3 starts where the plain source did');
  const sid = toHex(seriesId(TEMPLATE));
  const seats = (lines) => async (url) => { const l = lines[new URL(url).host]; return l ? new Response(l) : new Response('no', { status: 404 }); };
  const other = { ...TEMPLATE, stakeMsat: 1n };
  const fetched = await fetchSeriesTemplate({ seriesIdHex: sid, nodes: ['https://a.example', 'https://b.example', 'https://c.example'],
    fetcher: seats({ 'b.example': seriesLineOf(other), 'c.example': seriesLineOf(TEMPLATE) }) });
  assert.deepEqual([fetched.ok, fetched.from], [true, 'https://c.example'], 'a seat handing another series is passed over');
  const none = await fetchSeriesTemplate({ seriesIdHex: sid, nodes: ['https://b.example'], fetcher: seats({ 'b.example': seriesLineOf(other) }) });
  assert.match(none.why, /its template is another series/);
  const sArgs = { ...args, sourceRoundIdHex: toHex(roundId(series)) };
  const viaSeries = await checkMarketOutcome({ ...sArgs, outcome: { gameOutcome: evidence(8300000, 8310000, COMMITTEE.slice(0, 5), series) }, sourceCommittee: derived,
    sourceSeries: async () => fetched });
  assert.deepEqual([viaSeries.verified, viaSeries.label], [true, 'BULLS'], viaSeries.why);
  const moved = { ...series, entryCloseMs: series.entryCloseMs + 1n };
  const movedCheck = await checkMarketOutcome({ ...sArgs, outcome: { gameOutcome: evidence(8300000, 8310000, COMMITTEE.slice(0, 5), moved) }, sourceCommittee: derived,
    sourceSeries: async () => fetched });
  assert.match(movedCheck.why, /its source round: round 3 of series .* opens and closes its entry/);
  const fromSeries = await checkMarketOutcome({ ...sArgs, outcome: { gameOutcome: evidence(8300000, 8310000, COMMITTEE, series) }, sourceCommittee: derived,
    sourceSeries: async () => none });
  assert.match(fromSeries.why, /its source is round 3 of series .*, and no seat handed series .*'s template/);

  const pick = { ...record, market };
  const rid = record.roundIdHex;
  const table = { refunded: false, losingPoolMsat: '50000', rows: [{ entryId: 'e2'.repeat(32), netMsat: '98500', payoutMsat: '148000', won: true }] };
  const [won] = marketLines({ picks: [pick], outcomes: new Map([[rid, { state: 'ATTESTED', label: 'BULLS', final: true, table, check: ok }]]), nowMs: Number(S) });
  assert.equal(won.text, `tick-tock-fronts ${rid.slice(0, 8)}: 'BULLS' (source round ${toHex(SOURCE_ID).slice(0, 8)} ended BULLS, signed by its committee, verified) · you won 49.5 sats`);
  const [open] = marketLines({ picks: [pick], outcomes: new Map(), nowMs: Number(S) });
  assert.match(open.text, new RegExp(`waiting for source round ${toHex(SOURCE_ID).slice(0, 8)}'s signed result$`));
  const [voided] = marketLines({ picks: [pick], outcomes: new Map([[rid, { state: 'VOID', why: 'the source round ended FLAT, which this market refunds' }]]), nowMs: Number(S) });
  assert.match(voided.text, /VOID - the source round ended FLAT, which this market refunds · every stake comes back$/);
  const [unverified] = marketLines({ picks: [pick], outcomes: new Map([[rid, { state: 'ATTESTED', label: 'BULLS', check: fromSeries }]]), nowMs: Number(S) });
  assert.match(unverified.text, /'BULLS' - UNVERIFIED \(its source is round 3 of series/);
});

// ---- A SCALAR TEMPLATE (2026.0.8) ----------------------------------------------------------------------------------------------
test('a scalar template round\'s pick keeps its question and bounds, and its value is clamped to THEM', async () => {
  const TPL = signed(DEV, { ...MARKET_BODY, gameName: 'price-at', gameDevPubkey: DEV.pub, outcomes: [...SCALAR_SIDES], attestors: ATTESTORS.map((a) => a.pub),
    attestThreshold: 2, scalar: { low: 0n, high: 100000000n, unit: 'USD cents' }, template: { category: 'prices', maxOutcomes: 2, resolveWithinMs: 86400000n },
    requiredProtocolVersion: SCALAR_TEMPLATE_VERSION,
    marketTerms: { nodeFeeBps: 100, donationBps: 50, question: 'a price', resolveAfterCloseMs: 60000n, deadlineAfterResolveMs: 3600000n, sourceRule: 'median' } });
  const round = { ...SCALAR_ROUND, protocolVersion: SCALAR_TEMPLATE_VERSION, gameId: gameIdOf(TPL),
    event: { question: 'BTC at 18:00?', outcomes: ['Higher', 'Lower'], resolveAtMs: SCALAR_ROUND.entryCloseMs + 3600000n, scalar: { low: 8000000n, high: 9000000n } } };
  const rid = toHex(roundId(round));
  const record = JSON.parse(JSON.stringify(pickRecord({ roundIdHex: rid, entryIdHex: 'e3'.repeat(32), pick: 0, round, nodes: ['https://s.example'] })));
  const market = marketForRound(roundOfPick(record), { manifestBytes: encodeManifest(TPL) });
  assert.deepEqual([market.question, market.outcomes, market.scalar], ['BTC at 18:00?', ['Higher', 'Lower'], { low: 8000000n, high: 9000000n, unit: 'USD cents' }]);
  const ok = await checkMarketOutcome({ outcome: { attestation: valueAtt(9500000n, ATTESTORS.slice(0, 2), roundId(round)) }, market, roundIdHex: rid, verify: verifyEd });
  assert.deepEqual([ok.verified, ok.value, ok.clamped], [true, 9500000n, 9000000n], ok.why);
  const [line] = marketLines({ picks: [{ ...record, market }], outcomes: new Map([[rid, { state: 'ATTESTED', label: 'Higher', final: true, check: ok,
    table: { refunded: false, rows: [{ entryId: 'e3'.repeat(32), netMsat: '98500', payoutMsat: '197000', won: true }] } }]]), nowMs: Number(round.entryCloseMs) + 1 });
  assert.match(line.text, /value 95,000.00 USD \(paid as 90,000.00 USD\) between 80,000.00 USD and 90,000.00 USD .* 'Higher' gets 197 of your 98.5 sats · \+98.5$/);
});
