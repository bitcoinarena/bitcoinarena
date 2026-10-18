// SCALAR MARKETS (kanban #362 feature 8, docs/PLATFORM-RESEARCH.md item 8; protocol 2026.0.7): an attested market whose outcome is
// a NUMBER, paid linearly between bounds to two sides. The manifest names low < high in a unit (marker 0x06) and the outcomes
// LONG, SHORT; its attestors sign the value in a message of its own (TYPE_VALUE_ATTESTATION 0x2a, tag ARENA/v1/ValueAttestation,
// written at version 7); the table splits the net pool LONG (V - low) / (high - low), SHORT the rest, each side pari-mutuel.
// Every manifest and contract written before keeps its bytes and its id (the shapes pinned in game-market.test.js, and a market
// on a game's below, printed by origin/main e2e1ebbc before the scalar existed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify as edVerify, createPublicKey } from 'node:crypto';
import {
  encodeManifest, decodeManifest, encodeManifestBody, manifestBodyId, gameIdOf, manifestStands, roundFitsManifest, RESULT_TYPE, PAYOUT_RULE,
  NO_PARENT, SCALAR_MARKER, GAME_SOURCE_MARKER, REQUIRED_VERSION_MARKER, TEMPLATE_MARKER, PAYOUT_SHARES_MARKER, MARKET_TERMS_MARKER,
  SOURCE_KIND, GAME_MARKET_REFUND, isScalar, isGameMarket, scalarFits, SCALAR_SIDES, SCALAR_LONG, SCALAR_SHORT,
} from '../src/manifest.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../src/contracts.js';
import {
  attestationStands, encodeAttestation, decodeAttestation, attestationBodyId, outcomeStanding, outcomeFinality, marketVoided, attestationTimely,
  pariMutuelTable,
} from '../src/attested.js';
import {
  encodeValueAttestation, decodeValueAttestation, encodeValueAttestationBody, valueAttestationBodyId, valueAttestationStands, isValueAttestationBytes,
  scalarPayoutTable, scalarOneSided, scalarClamp, scalarBoundsFit,
} from '../src/scalar.js';
import { attestedLockSettlement } from '../src/lock-settlement.js';
import { SCALAR_VERSION, SUPPORTED_PROTOCOL_VERSIONS, speaksVersion, TYPE_VALUE_ATTESTATION, TYPE_OUTCOME_ATTESTATION, TAG } from '../src/constants.js';
import { protocolVersionName } from '../src/protocol-version.js';
import { Writer, Reader } from '../src/encode.js';
import { toHex, sha256 } from '../src/hash.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const edKey = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; };
const verifyEd = (sig, digest, key) => edVerify(null, Buffer.from(digest), createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));
const sum = (xs) => xs.reduce((t, x) => t + x, 0n);

// ---- THE BYTES THAT MUST NOT MOVE ------------------------------------------------------------------------------------------

// A market on a game's manifest body (version 6, fixed keys) - its sha256 as origin/main e2e1ebbc printed it, before the scalar
const GAME_SOURCE_PIN = 'cea21c0fc7045b088bb7ad25f6139853db3c8eb9c69236cb0546bad7d272cb02';
const PINNED_GAME_MARKET = {
  gameName: 'tick-tock-fronts', gameDevPubkey: b32(0xde), version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: b32(0xd0), outcomes: ['BULLS', 'BEARS'], attestors: [], attestThreshold: 0,
  marketTerms: { nodeFeeBps: 100, donationBps: 50, question: 'Which front wins?', resolveAfterCloseMs: 600000n, deadlineAfterResolveMs: 3600000n, sourceRule: 'its RoundResult' },
  gameSource: { sourceGameId: b32(0x67), sourceKind: SOURCE_KIND.ROUND_RESULT, mapping: [0, 1, GAME_MARKET_REFUND] }, requiredProtocolVersion: 6,
};

test('version 7 is spoken: 2026.0.7, scalar markets', () => {
  assert.equal(SCALAR_VERSION, 7);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(7));
  assert.equal(speaksVersion(7), true);
  assert.equal(speaksVersion(17), false, '11 is 2026.0.11, the protocol reserves; 12 is 2026.0.12, the leaderboard payout; 13 is 2026.0.13, the seated guardian pool; 14 the cohort; 15 the gateway seats; 16 the liquidity providers; 17 is spoken by no build');
  assert.equal(protocolVersionName(7), '2026.0.7');
  assert.equal(TYPE_VALUE_ATTESTATION, 0x2a);
  assert.notEqual(TYPE_VALUE_ATTESTATION, TYPE_OUTCOME_ATTESTATION);
  assert.notEqual(TAG.valueAttestation, TAG.outcomeAttestation);
  assert.equal(new Set(Object.values(TAG)).size, Object.values(TAG).length, 'two kinds of message share a tag');
  // and a market on a game's manifest keeps its bytes: nothing written before 7 moves
  assert.equal(toHex(sha256(encodeManifestBody(PINNED_GAME_MARKET))), GAME_SOURCE_PIN, 'a market on a game\'s manifest body moved');
});

test('i64: two\'s complement over the u64 it replaces nothing of - the extremes and zero read back exactly', () => {
  for (const v of [0n, 1n, -1n, 123456789n, -987654321012n, -0x8000000000000000n, 0x7fffffffffffffffn]) {
    const bytes = new Writer().i64(v).finish();
    assert.equal(bytes.length, 8);
    assert.equal(new Reader(bytes).i64(), v);
  }
  assert.deepEqual([...new Writer().i64(-1n).finish()], [255, 255, 255, 255, 255, 255, 255, 255]);
  assert.deepEqual([...new Writer().i64(5n).finish()], [...new Writer().u64(5n).finish()], 'a non-negative i64 is its u64');
  assert.throws(() => new Writer().i64(0x8000000000000000n), /i64 out of range/);
  assert.throws(() => new Writer().i64(-0x8000000000000001n), /i64 out of range/);
  assert.throws(() => new Writer().i64(5), /i64 needs a BigInt/);
});

// ---- THE MARKET -----------------------------------------------------------------------------------------------------------

const DEV = edKey();
const ATTESTORS = [edKey(), edKey(), edKey()].sort((x, y) => Buffer.compare(Buffer.from(x.pub), Buffer.from(y.pub)));
const STRANGER = edKey();
const TERMS = { nodeFeeBps: 100, donationBps: 50, question: 'BTC/USD at 18:00 UTC, in cents?', resolveAfterCloseMs: 3600000n, deadlineAfterResolveMs: 3600000n,
  sourceRule: 'the median of Coinbase, Kraken and Bitstamp at 18:00:00 UTC, whole cents' };
const SCALAR = { low: 9000000n, high: 11000000n, unit: 'cents' };
const BODY = {
  gameName: 'btc-at-18', gameDevPubkey: DEV.pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: b32(0xd0), outcomes: [...SCALAR_SIDES], attestors: ATTESTORS.map((a) => a.pub), attestThreshold: 2,
  marketTerms: TERMS, scalar: SCALAR, requiredProtocolVersion: SCALAR_VERSION,
};
const signed = (b) => ({ ...b, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(b)), DEV.key)) });
const MARKET = signed(BODY);
const MARKET_ID = gameIdOf(MARKET);
// A PARI-MUTUEL MARKET OF THE SAME ATTESTORS: what a value attestation must never decide
const BUCKETS = signed({ ...BODY, gameName: 'btc-buckets', outcomes: ['below 100k', 'above 100k'], scalar: undefined, requiredProtocolVersion: undefined });

const ROUND = {
  networkId: b32(0x4e), configHash: new Uint8Array(32), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: MARKET_ID, simCoreHash: new Uint8Array(32),
  startTimeMs: 1788200000000n, entryCloseMs: 1788200060000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: SCALAR_VERSION,
};
const RID = roundId(ROUND);
const valueSigned = (body, by) => ({ ...body, signatures: by.map((a) => ({ key: a.pub, signature: new Uint8Array(sign(null, Buffer.from(valueAttestationBodyId(body)), a.key)) })) });
const indexSigned = (body, by) => ({ ...body, signatures: by.map((a) => ({ key: a.pub, signature: new Uint8Array(sign(null, Buffer.from(attestationBodyId(body)), a.key)) })) });
const AT = ROUND.entryCloseMs + TERMS.resolveAfterCloseMs;

test('a scalar rides in its manifest after its own marker 0x06: read back whole, behind the market terms and before the required version', () => {
  const back = decodeManifest(encodeManifest(MARKET));
  assert.deepEqual(back.scalar, SCALAR);
  assert.deepEqual(back.outcomes, ['LONG', 'SHORT']);
  assert.equal(back.requiredProtocolVersion, 7);
  assert.deepEqual(encodeManifest(back), encodeManifest(MARKET));
  assert.deepEqual([isScalar(back), isGameMarket(back), isScalar(BUCKETS), isScalar(PINNED_GAME_MARKET)], [true, false, false, false]);
  // THE BYTES: the market without the scalar and the version, then the scalar's marker and fields (1 + 8 + 8 + 2 + 5), then the version's 3
  const plain = encodeManifestBody({ ...BODY, scalar: undefined, requiredProtocolVersion: undefined });
  const body = encodeManifestBody(BODY);
  const at = body.length - 3 - 24;
  assert.equal(body.length - plain.length, 24 + 3, 'the scalar and the required version are all that was added');
  assert.deepEqual(body.subarray(0, plain.length), plain, 'nothing before the scalar moved');
  assert.equal(body[at], SCALAR_MARKER);
  assert.equal(new Reader(body.subarray(at + 1, at + 9)).i64(), SCALAR.low);
  assert.equal(new Reader(body.subarray(at + 9, at + 17)).i64(), SCALAR.high);
  assert.equal(body[body.length - 3], REQUIRED_VERSION_MARKER);
  assert.equal(new Set([MARKET_TERMS_MARKER, REQUIRED_VERSION_MARKER, PAYOUT_SHARES_MARKER, TEMPLATE_MARKER, GAME_SOURCE_MARKER, SCALAR_MARKER]).size, 6, 'six distinct manifest markers');
  assert.equal(SCALAR_MARKER, 0x06);
  // signed bounds below zero, and the extremes of 64 bits, read back exactly
  for (const sc of [{ low: -500n, high: 500n, unit: 'tenths °C' }, { low: -0x8000000000000000n, high: 0x7fffffffffffffffn, unit: 'msat' }]) {
    const m = signed({ ...BODY, scalar: sc });
    assert.deepEqual(decodeManifest(encodeManifest(m)).scalar, sc);
  }
  const st = manifestStands(MARKET, { verify: verifyEd });
  assert.equal(st.ok, true, st.why);
  console.log(`  scalar market ${toHex(MARKET_ID).slice(0, 16)}: ${body.length} body bytes, marker 0x06 at ${at}`);
});

test('a scalar market\'s rules, each refused by name - low >= high among them', () => {
  const refusals = {
    'low equal to high': [{ ...BODY, scalar: { ...SCALAR, high: SCALAR.low } }, /low bound is below its high bound; this one names low 9000000 and high 9000000/],
    'low above high': [{ ...BODY, scalar: { ...SCALAR, low: 11000001n } }, /low bound is below its high bound; this one names low 11000001 and high 11000000/],
    'number bounds': [{ ...BODY, scalar: { ...SCALAR, low: 1 } }, /names its bounds low and high as BigInt whole numbers/],
    'beyond 64 bits': [{ ...BODY, scalar: { ...SCALAR, high: 1n << 63n } }, /signed 64-bit whole numbers/],
    'no unit': [{ ...BODY, scalar: { ...SCALAR, unit: '' } }, /names the unit of its bounds and its value in 1 to 16 characters/],
    'a long unit': [{ ...BODY, scalar: { ...SCALAR, unit: 'x'.repeat(17) } }, /in 1 to 16 characters/],
    'other outcomes': [{ ...BODY, outcomes: ['UP', 'DOWN'] }, /outcomes are its two sides, LONG and SHORT, in that order/],
    'the sides swapped': [{ ...BODY, outcomes: ['SHORT', 'LONG'] }, /LONG and SHORT, in that order/],
    'three outcomes': [{ ...BODY, outcomes: ['LONG', 'SHORT', 'FLAT'] }, /LONG and SHORT, in that order/],
    'no market terms': [{ ...BODY, marketTerms: undefined }, /names its market terms/],
    'a template too': [{ ...BODY, template: { category: 'x', maxOutcomes: 2, resolveWithinMs: 86400000n }, roundPeriodMs: 0n }, /template/],
    'a game source too': [{ ...BODY, gameSource: PINNED_GAME_MARKET.gameSource, attestors: [], attestThreshold: 0 }, /no market on a game|names no attestors/],
    'below version 7': [{ ...BODY, requiredProtocolVersion: 6 }, /requires protocol version 2026\.0\.7 or later/],
    'no required version': [{ ...BODY, requiredProtocolVersion: undefined }, /requires protocol version 2026\.0\.7 or later/],
    'no attestor': [{ ...BODY, attestors: [], attestThreshold: 0 }, /names 1 to 16 attestor keys/],
    'a replayed game': [{ gameName: 'r', gameDevPubkey: b32(1), version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.REPLAY, cores: [{ hash: b32(1), configs: [b32(2)] }],
      runTicksMax: 9000, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE, rankNumerator: 3, rankDenominator: 4, minScore: 1, clients: [], gameDonationSetId: b32(0xd0), scalar: SCALAR },
    /only an attested game is a scalar market/],
  };
  const said = {};
  for (const [name, [m, why]] of Object.entries(refusals)) {
    let msg = null;
    try { encodeManifestBody(m); } catch (e) { msg = e.message; }
    assert.ok(msg, `${name}: encoded`);
    assert.match(msg, why, name);
    said[name] = msg;
  }
  assert.equal(scalarFits(SCALAR, BODY).ok, true);
  // the protocol's own table refuses the same bounds by name
  assert.match(scalarBoundsFit({ low: 5n, high: 5n }).why, /low bound is below its high bound/);
  assert.throws(() => scalarPayoutTable({ entries: [], value: 0n, bounds: { low: 7n, high: 3n } }), /low bound is below its high bound; this one names low 7 and high 3/);
  // and a manifest that requires a version this build does not speak is no game it hosts
  const tooNew = signed({ ...BODY, requiredProtocolVersion: 17 });
  const st = manifestStands(tooNew, { verify: verifyEd });
  assert.equal(st.ok, false);
  assert.match(st.why, /scalar market under protocol version \?\.\?\.17, which this build does not speak/);
  console.log('  FACTS (refusals):', JSON.stringify(said));
});

test('a round of a scalar market is refused below version 7, and carries no byte of its own', () => {
  assert.deepEqual(roundFitsManifest(ROUND, MARKET), { ok: true, attested: true, scalar: true });
  for (const v of [1, 4, 6]) {
    const fits = roundFitsManifest({ ...ROUND, protocolVersion: v }, MARKET);
    assert.equal(fits.ok, false, `v${v}`);
    assert.match(fits.why, /requires protocol version 2026\.0\.7; that round runs 2026\.0\./);
  }
  // NO ROUND BYTE CHANGES: a v7 round is the v6 layout with its version byte - nothing appended
  const v7 = encodeRoundContract(ROUND), v6 = encodeRoundContract({ ...ROUND, protocolVersion: 6 });
  assert.equal(v7.length, v6.length);
  assert.deepEqual([...v7].map((x, i) => x !== v6[i] ? i : -1).filter((i) => i >= 0), [2], 'only the low byte of the version differs');
  assert.deepEqual(decodeRoundContract(v7), decodeRoundContract(encodeRoundContract(decodeRoundContract(v7))));
});

test('a value attestation: its own type, its own tag, written at 7 - read back whole, huge and negative values too; refused below 7', () => {
  for (const value of [10123456n, -42n, 0n, -0x8000000000000000n, 0x7fffffffffffffffn]) {
    const a = valueSigned({ roundId: RID, value, observedAtMs: AT }, ATTESTORS.slice(0, 2));
    const bytes = encodeValueAttestation(a);
    assert.equal(bytes[0], TYPE_VALUE_ATTESTATION);
    assert.deepEqual([bytes[1], bytes[2]], [0, 7], 'written at protocol version 7');
    assert.equal(isValueAttestationBytes(bytes), true);
    const back = decodeValueAttestation(bytes);
    assert.deepEqual([toHex(back.roundId), back.value, back.observedAtMs, back.signatures.length], [toHex(RID), value, AT, 2]);
    assert.deepEqual(encodeValueAttestation(back), bytes);
  }
  // REFUSED BELOW 7 (and at a version nobody speaks): the version bytes patched
  const bytes = encodeValueAttestation(valueSigned({ roundId: RID, value: 1n, observedAtMs: AT }, ATTESTORS.slice(0, 2)));
  for (const [v, why] of [[6, /written at protocol version 2026\.0\.7 or later; this one names 2026\.0\.6/], [1, /names 2026\.0\.1/], [17, /names \?\.\?\.17/]]) {
    const p = bytes.slice(); p[1] = v >> 8; p[2] = v & 255;
    assert.throws(() => decodeValueAttestation(p), why, `version ${v}`);
  }
  assert.throws(() => encodeValueAttestationBody({ roundId: RID, value: 1, observedAtMs: AT }), /signed 64-bit BigInt/);
  assert.throws(() => encodeValueAttestationBody({ roundId: RID, value: 1n << 63n, observedAtMs: AT }), /signed 64-bit BigInt/);
  assert.throws(() => decodeValueAttestation(new Uint8Array([...bytes, 0])), /trailing bytes/);
});

test('it stands by k of n of the market\'s attestors - and an index can never be replayed as a value, nor a value as an index', () => {
  const body = { roundId: RID, value: 10250000n, observedAtMs: AT };
  const ok = valueAttestationStands(valueSigned(body, ATTESTORS.slice(1)), { manifest: MARKET, roundIdBytes: RID, verify: verifyEd });
  assert.equal(ok.ok, true, ok.why);
  assert.deepEqual([ok.value, ok.clamped, ok.signers], [10250000n, 10250000n, 2]);
  const beyond = valueAttestationStands(valueSigned({ ...body, value: 12000000n }, ATTESTORS), { manifest: MARKET, roundIdBytes: RID, verify: verifyEd });
  assert.deepEqual([beyond.ok, beyond.clamped], [true, 11000000n]);
  assert.match(beyond.why, /paid as 11000000, its bound/);
  const refusals = {
    one: valueAttestationStands(valueSigned(body, ATTESTORS.slice(0, 1)), { manifest: MARKET, roundIdBytes: RID, verify: verifyEd }).why,
    stranger: valueAttestationStands(valueSigned(body, [ATTESTORS[0], STRANGER]), { manifest: MARKET, roundIdBytes: RID, verify: verifyEd }).why,
    otherRound: valueAttestationStands(valueSigned({ ...body, roundId: b32(9) }, ATTESTORS), { manifest: MARKET, roundIdBytes: RID, verify: verifyEd }).why,
    // A SIGNATURE MOVED FROM ONE VALUE TO ANOTHER
    moved: valueAttestationStands({ ...valueSigned(body, ATTESTORS.slice(0, 2)), value: 10250001n }, { manifest: MARKET, roundIdBytes: RID, verify: verifyEd }).why,
    // A VALUE FOR A PARI-MUTUEL MARKET, by the same attestors
    valueForIndex: valueAttestationStands(valueSigned(body, ATTESTORS), { manifest: BUCKETS, roundIdBytes: RID, verify: verifyEd }).why,
    // AN INDEX FOR THE SCALAR MARKET, by its own attestors
    indexForValue: attestationStands(indexSigned({ roundId: RID, outcome: 0, observedAtMs: AT }, ATTESTORS), { manifest: MARKET, roundIdBytes: RID, verify: verifyEd }).why,
  };
  assert.match(refusals.one, /carries 1 attestor signature\(s\), and game "btc-at-18" asks 2 of its 3/);
  assert.match(refusals.stranger, /does not name as an attestor/);
  assert.match(refusals.otherRound, /not this round/);
  assert.match(refusals.moved, /signature on that value attestation does not verify/);
  assert.match(refusals.valueForIndex, /is not a scalar market: its outcome is an index its attestors sign, and a value decides nothing of it/);
  assert.match(refusals.indexForValue, /is a scalar market: its attestors sign the observed value .*an outcome index decides nothing of it/);
  // THE BYTES DO NOT CROSS: an outcome attestation's bytes are no value attestation, and the other way round
  const idx = encodeAttestation(indexSigned({ roundId: RID, outcome: 1, observedAtMs: AT }, ATTESTORS));
  const val = encodeValueAttestation(valueSigned({ roundId: RID, value: 1n, observedAtMs: AT }, ATTESTORS));
  assert.throws(() => decodeValueAttestation(idx), /not a value attestation/);
  assert.throws(() => decodeAttestation(val), /not an outcome attestation/);
  // AND NEITHER DOES A SIGNATURE: an index attestation's signatures over outcome 1, carried onto a value attestation of value 1
  const transplanted = { roundId: RID, value: 1n, observedAtMs: AT, signatures: indexSigned({ roundId: RID, outcome: 1, observedAtMs: AT }, ATTESTORS).signatures };
  assert.match(valueAttestationStands(transplanted, { manifest: MARKET, roundIdBytes: RID, verify: verifyEd }).why, /does not verify/);
  const back = { roundId: RID, outcome: 1, observedAtMs: AT, signatures: valueSigned({ roundId: RID, value: 1n, observedAtMs: AT }, ATTESTORS).signatures };
  assert.match(attestationStands(back, { manifest: BUCKETS, roundIdBytes: RID, verify: verifyEd }).why, /does not verify/);
  console.log('  FACTS (replay):', JSON.stringify(refusals));
});

test('no value by the deadline is VOID; two values are DISPUTED and VOID; one value is final after the window, the value carried', () => {
  const terms = TERMS;
  const deadline = AT + terms.deadlineAfterResolveMs;
  assert.deepEqual(marketVoided([], { entryCloseMs: ROUND.entryCloseMs, terms, nowMs: deadline - 1n }), { voided: false });
  const v = marketVoided([], { entryCloseMs: ROUND.entryCloseMs, terms, nowMs: deadline });
  assert.equal(v.voided, true);
  assert.match(v.why, /no outcome was attested by the market's deadline .*every stake goes back/);
  const held = (value, receivedMs) => ({ ...valueSigned({ roundId: RID, value, observedAtMs: AT }, ATTESTORS), receivedMs });
  // one value, twice: ATTESTED on it, never VOID however late
  const one = [held(10250000n, 1000), held(10250000n, 2000)];
  assert.deepEqual(outcomeStanding(one), { state: 'ATTESTED', value: 10250000n });
  assert.equal(marketVoided(one, { entryCloseMs: ROUND.entryCloseMs, terms, nowMs: deadline * 2n }).voided, false);
  const f = outcomeFinality(one, { windowMs: 600000n, nowMs: 600999 });
  assert.deepEqual([f.state, f.value, f.final, f.finalAtMs], ['ATTESTED', 10250000n, false, 601000]);
  assert.equal(outcomeFinality(one, { windowMs: 600000n, nowMs: 601000 }).final, true);
  // two values: the pair is the proof, and the round is VOID
  const two = [held(10250000n, 1000), held(10250001n, 2000)];
  const d = outcomeStanding(two);
  assert.deepEqual([d.state, d.values], ['DISPUTED', [10250000n, 10250001n]]);
  assert.match(d.why, /name value 10250000 and value 10250001/);
  assert.equal(marketVoided(two, { entryCloseMs: ROUND.entryCloseMs, terms, nowMs: 0 }).voided, true);
  assert.equal(outcomeFinality(two, { windowMs: 600000n, nowMs: 10 ** 12 }).final, false);
  // an index held beside a value is a contradiction too, never a mixture
  assert.equal(outcomeStanding([held(1n, 1), { roundId: RID, outcome: 1, observedAtMs: AT, receivedMs: 2 }]).state, 'DISPUTED');
  // a list of indices reads exactly as before
  assert.deepEqual(outcomeStanding([{ outcome: 1 }, { outcome: 1 }]), { state: 'ATTESTED', outcome: 1 });
  assert.equal(outcomeStanding([{ outcome: 1 }, { outcome: 0 }]).why, 'two standing attestations name outcomes 1 and 0: the pair is proof the attestors contradicted themselves, and the round settles on neither');
  // a value seen before the market's resolution time is not the value it asked for
  assert.match(attestationTimely({ observedAtMs: AT - 1n }, { entryCloseMs: ROUND.entryCloseMs, nowMs: Number(AT), terms }).why, /before the market's resolution time/);
  assert.equal(attestationTimely({ observedAtMs: AT }, { entryCloseMs: ROUND.entryCloseMs, nowMs: Number(AT), terms }).ok, true);
});

// ---- THE TABLE ------------------------------------------------------------------------------------------------------------

const entry = (n, pick, net, fee = 0n, donation = 0n) => ({ entryId: b32(n), stakeMsat: net + fee + donation, feeMsat: fee, donationMsat: donation, pick });
const BOUNDS = { low: 0n, high: 100n };

test('the table, worked: V = 25 of 0..100 gives LONG a quarter of the pool, each side split by its own stakes; fees come out first', () => {
  // LONG 300 + 100, SHORT 200 + 200: a pool of 800 - LONG's share 200, SHORT's 600
  const es = [entry(1, SCALAR_LONG, 300n, 10n, 5n), entry(2, SCALAR_LONG, 100n, 3n, 2n), entry(3, SCALAR_SHORT, 200n, 7n, 0n), entry(4, SCALAR_SHORT, 200n, 0n, 0n)];
  const t = scalarPayoutTable({ entries: es, value: 25n, bounds: BOUNDS });
  assert.deepEqual([t.poolMsat, t.longPoolMsat, t.shortPoolMsat, t.longShareMsat, t.shortShareMsat, t.refunded], [800n, 400n, 400n, 200n, 600n, false]);
  assert.deepEqual(t.rows.map((r) => [r.side, r.netMsat, r.payoutMsat, r.won]),
    [['LONG', 300n, 150n, false], ['LONG', 100n, 50n, false], ['SHORT', 200n, 300n, true], ['SHORT', 200n, 300n, true]]);
  assert.equal(t.feesMsat + t.donationsMsat + t.payoutsMsat, t.grossMsat);
  assert.deepEqual([t.feesMsat, t.donationsMsat, t.grossMsat], [20n, 7n, 827n]);
  // AT THE MIDDLE every side gets its own back: a pool split evenly by sides that staked evenly
  const mid = scalarPayoutTable({ entries: es, value: 50n, bounds: BOUNDS });
  assert.deepEqual(mid.rows.map((r) => r.payoutMsat), [300n, 100n, 200n, 200n]);
  // THE REMAINDERS, NAMED: a pool of 7 at V = 1 of 0..3 - LONG floor(7/3) = 2, SHORT floor(14/3) = 4, the 1 msat to the side of
  // the first entry id (b32(1), LONG) - and within LONG 3 msat over nets 2 and 2: 1 each, the leftover to the first id
  const odd = scalarPayoutTable({ entries: [entry(1, SCALAR_LONG, 2n), entry(2, SCALAR_LONG, 2n), entry(3, SCALAR_SHORT, 3n)], value: 1n, bounds: { low: 0n, high: 3n } });
  assert.deepEqual([odd.longShareMsat, odd.shortShareMsat], [3n, 4n]);
  assert.deepEqual(odd.rows.map((r) => r.payoutMsat), [2n, 1n, 4n]);
});

test('V at or beyond a bound is clamped: LONG takes the pool at or above high, SHORT at or below low', () => {
  const es = [entry(1, SCALAR_LONG, 500n), entry(2, SCALAR_SHORT, 300n), entry(3, SCALAR_SHORT, 200n)];
  for (const v of [100n, 101n, 10n ** 30n]) {
    const t = scalarPayoutTable({ entries: es, value: v, bounds: BOUNDS });
    assert.equal(t.clamped, 100n);
    assert.deepEqual(t.rows.map((r) => r.payoutMsat), [1000n, 0n, 0n], `V = ${v}`);
  }
  for (const v of [0n, -1n, -(10n ** 30n)]) {
    const t = scalarPayoutTable({ entries: es, value: v, bounds: BOUNDS });
    assert.equal(t.clamped, 0n);
    assert.deepEqual(t.rows.map((r) => r.payoutMsat), [0n, 600n, 400n], `V = ${v}`);
  }
  assert.deepEqual([scalarClamp(-5n, BOUNDS), scalarClamp(50n, BOUNDS), scalarClamp(500n, BOUNDS)], [0n, 50n, 100n]);
});

test('one side only is refunded, its fee too; no entry is refunded; a free round of both sides pays 0 each, not a refund', () => {
  const longs = [entry(1, SCALAR_LONG, 500n, 5n, 5n), entry(2, SCALAR_LONG, 300n)];
  for (const v of [0n, 50n, 100n]) {
    const t = scalarPayoutTable({ entries: longs, value: v, bounds: BOUNDS });
    assert.equal(t.refunded, true);
    assert.match(t.why, /only the LONG side staked: no counterparty, every stake comes back, its fee too/);
    assert.deepEqual(t.rows.map((r) => r.payoutMsat), [500n, 300n]);
  }
  assert.match(scalarOneSided([entry(3, SCALAR_SHORT, 9n)]).why, /only the SHORT side staked/);
  // a side present with nothing staked against a side that staked: no counterparty either
  assert.equal(scalarOneSided([entry(1, SCALAR_LONG, 0n, 0n), entry(2, SCALAR_SHORT, 9n)]).refunded, true);
  assert.deepEqual([scalarPayoutTable({ entries: [], value: 1n, bounds: BOUNDS }).refunded, scalarPayoutTable({ entries: [], value: 1n, bounds: BOUNDS }).rows], [true, []]);
  const free = scalarPayoutTable({ entries: [entry(1, SCALAR_LONG, 0n), entry(2, SCALAR_SHORT, 0n)], value: 70n, bounds: BOUNDS });
  assert.deepEqual([free.refunded, free.rows.map((r) => r.payoutMsat)], [false, [0n, 0n]]);
  // THE LOCK SETTLEMENT CLAIMS NOTHING FOR A ONE-SIDED ROUND: every stake back, the fee locks too
  const locks = new Map();
  const ps = longs.map((e) => ({ ...e, entryId: toHex(e.entryId), pubkey: e.entryId }));
  const plan = attestedLockSettlement({ roundId: RID, table: scalarPayoutTable({ entries: longs, value: 70n, bounds: BOUNDS }), entries: ps, locks, fees: { ppm: 0n, baseMsat: 0n } });
  assert.deepEqual([plan.ok, plan.nothing, plan.refunded], [true, true, true]);
  // an entry backing no side is refused by name
  assert.throws(() => scalarPayoutTable({ entries: [entry(1, 2, 5n)], value: 1n, bounds: BOUNDS }), /backs no side of a scalar market/);
});

test('huge values: 64-bit bounds and value, stakes near 2^64 msat - integer math, balanced to the msat', () => {
  const bounds = { low: -0x8000000000000000n, high: 0x7fffffffffffffffn };
  const big = 0xffffffffffffff00n;
  const es = [entry(1, SCALAR_LONG, big), entry(2, SCALAR_LONG, 3n), entry(3, SCALAR_SHORT, big - 7n)];
  for (const v of [0n, 1n, -1n, bounds.high - 1n, bounds.low + 1n, 1234567890123456789n]) {
    const t = scalarPayoutTable({ entries: es, value: v, bounds });
    assert.equal(t.payoutsMsat, t.poolMsat);
    assert.equal(t.longShareMsat + t.shortShareMsat, t.poolMsat);
    assert.ok(t.rows.every((r) => r.payoutMsat >= 0n));
  }
  // V = 0 of [-2^63, 2^63 - 1]: LONG's share is pool * 2^63 / (2^64 - 1), a hair over half
  const t = scalarPayoutTable({ entries: es, value: 0n, bounds });
  const pool = big * 2n - 4n;
  assert.equal(t.longShareMsat, (pool * 0x8000000000000000n) / 0xffffffffffffffffn + (pool - (pool * 0x8000000000000000n) / 0xffffffffffffffffn - (pool * 0x7fffffffffffffffn) / 0xffffffffffffffffn));
});

// A SMALL DETERMINISTIC RANDOM SOURCE: the same cases on every run
function rng(seed) {
  let x = BigInt(seed) | 1n;
  return (n) => { x ^= (x << 13n) & 0xffffffffffffffffn; x ^= x >> 7n; x ^= (x << 17n) & 0xffffffffffffffffn; return n ? x % BigInt(n) : x; };
}

test('properties over 400 random rounds: payouts + fees + donations = stakes; monotone in V; LONG and SHORT symmetric', () => {
  const r = rng(362008);
  let checked = 0, perEntryDips = 0;
  for (let c = 0; c < 400; c++) {
    const n = 2 + Number(r(8));
    const es = [];
    for (let i = 0; i < n; i++) {
      const net = c % 17 === 0 ? (1n << 62n) + r(1n << 40n) : r(c % 3 === 0 ? 1000n : 1n << 40n);
      const fee = r(net / 20n + 1n), donation = r(net / 20n + 1n);
      es.push({ entryId: toHex(sha256(new Uint8Array([c & 255, c >> 8, i]))), stakeMsat: net + fee + donation, feeMsat: fee, donationMsat: donation, pick: i === 0 ? 0 : i === 1 ? 1 : Number(r(2)) });
    }
    const low = r(2) === 0n ? -r(1n << 40n) : r(1000n);
    const high = low + 1n + r(c % 5 === 0 ? 3n : 1n << 32n);
    const bounds = { low, high };
    const span = high - low;
    const values = [low - 5n, low, high, high + 5n];
    for (let k = 0; k < 10; k++) values.push(low + r(span + 1n));
    values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let prev = null;
    for (const v of values) {
      const t = scalarPayoutTable({ entries: es, value: v, bounds });
      // BALANCE: every msat of every stake is a fee, a donation or a payout - nothing invented, nothing kept
      assert.equal(sum(t.rows.map((x) => x.payoutMsat)) + t.feesMsat + t.donationsMsat, sum(es.map((e) => e.stakeMsat)));
      assert.equal(t.payoutsMsat, t.poolMsat);
      assert.ok(t.rows.every((x) => x.payoutMsat >= 0n));
      if (!t.refunded) assert.ok(t.rows.some((x) => x.won) && t.rows.every((x) => x.won === (x.payoutMsat >= x.netMsat)));
      // MONOTONE: the LONG side's total never falls as V rises, SHORT's never rises; each entry moves with its side, the floors
      // and the named remainders keeping it within 1 msat of that
      const longTotal = sum(t.rows.filter((x) => x.pick === 0).map((x) => x.payoutMsat));
      if (prev) {
        assert.ok(longTotal >= prev.longTotal, `case ${c}: LONG fell from ${prev.longTotal} to ${longTotal} as V rose to ${v}`);
        assert.ok(t.poolMsat - longTotal <= prev.pool - prev.longTotal, `case ${c}: SHORT rose as V rose`);
        for (const [i, x] of t.rows.entries()) {
          const was = prev.rows[i].payoutMsat;
          const ok = x.pick === 0 ? x.payoutMsat + 1n >= was : x.payoutMsat <= was + 1n;
          assert.ok(ok, `case ${c}: entry ${i} (${x.side}) moved against V by more than 1 msat: ${was} -> ${x.payoutMsat}`);
          if (x.pick === 0 ? x.payoutMsat < was : x.payoutMsat > was) perEntryDips++;
        }
      }
      prev = { longTotal, pool: t.poolMsat, rows: t.rows };
      // SYMMETRIC: every pick swapped and V mirrored to low + high - V pays every entry the same
      const mirror = scalarPayoutTable({ entries: es.map((e) => ({ ...e, pick: 1 - e.pick })), value: low + high - scalarClamp(v, bounds), bounds });
      assert.deepEqual(mirror.rows.map((x) => x.payoutMsat), t.rows.map((x) => x.payoutMsat), `case ${c}: not symmetric at V = ${v}`);
      assert.deepEqual([mirror.longShareMsat, mirror.shortShareMsat], [t.shortShareMsat, t.longShareMsat]);
      checked++;
    }
  }
  console.log(`  ${checked} tables over 400 rounds: balanced, side totals monotone, symmetric; ${perEntryDips} single-entry 1-msat steps against V`);
});

test('the lock settlement pays a scalar table: a row paid less than its stake has its lock claimed and its rest paid back; one paid more keeps its lock and is paid the excess', () => {
  const es = [entry(1, SCALAR_LONG, 300n), entry(2, SCALAR_LONG, 100n), entry(3, SCALAR_SHORT, 200n), entry(4, SCALAR_SHORT, 200n)];
  const table = scalarPayoutTable({ entries: es, value: 25n, bounds: BOUNDS });
  const entries = es.map((e) => ({ ...e, entryId: toHex(e.entryId), pubkey: e.entryId }));
  const locks = new Map(entries.map((e) => [toHex(e.pubkey), { outpoint: { txid: e.pubkey, outIdx: 0n }, amountMsat: e.stakeMsat - e.feeMsat - e.donationMsat, refundPk: new Uint8Array(33).fill(e.pubkey[0]) }]));
  const plan = attestedLockSettlement({ roundId: RID, table, entries, locks, fees: { ppm: 0n, baseMsat: 0n } });
  assert.equal(plan.ok, true, plan.why);
  // the two LONG locks (300 + 100) claimed whole; LONG gets 150 + 50 back, SHORT 100 + 100 over its own locks
  assert.deepEqual(plan.claims.filter((c) => c.kind === 'stake').map((c) => c.amountMsat).sort(), [100n, 300n]);
  const paid = Object.fromEntries(plan.payouts.map((p) => [p.pubkey[0], p.msat]));
  assert.deepEqual(paid, { 1: 150n, 2: 50n, 3: 100n, 4: 100n });
  assert.equal(sum(plan.payouts.map((p) => p.msat)), plan.poolMsat);
  // A PARI-MUTUEL TABLE THROUGH THE SAME CODE IS UNCHANGED: losers paid nothing back
  const pm = pariMutuelTable({ entries: es, outcome: 1 });
  const pmPlan = attestedLockSettlement({ roundId: RID, table: pm, entries, locks, fees: { ppm: 0n, baseMsat: 0n } });
  assert.deepEqual(Object.fromEntries(pmPlan.payouts.map((p) => [p.pubkey[0], p.msat])), { 3: 200n, 4: 200n });
});
