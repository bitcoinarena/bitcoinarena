// SCALAR TEMPLATES (2026.0.8, kanban #362, docs/PLATFORM-RESEARCH.md items 5 + 8: "Left: scalar templates"): a scalar market that is
// a template - anyone opens a numeric question by publishing one round of it, and the round names its own bounds (inside the
// template's, in its unit) in its question's tail. Nothing below version 8 moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify as edVerify, createPublicKey } from 'node:crypto';
import { encodeManifest, decodeManifest, encodeManifestBody, manifestBodyId, gameIdOf, roundFitsManifest, marketOfRound, isScalar, isTemplate,
  RESULT_TYPE, PAYOUT_RULE, NO_PARENT, SCALAR_SIDES } from '../src/manifest.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../src/contracts.js';
import { valueAttestationBodyId, valueAttestationStands, scalarPayoutTable } from '../src/scalar.js';
import { SCALAR_VERSION, SCALAR_TEMPLATE_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../src/constants.js';
import { toHex } from '../src/hash.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const edKey = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; };
const verifyEd = (sig, digest, key) => edVerify(null, Buffer.from(digest), createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));
const DEV = edKey();
const ATTESTORS = [edKey(), edKey(), edKey()].sort((x, y) => Buffer.compare(Buffer.from(x.pub), Buffer.from(y.pub)));
const TERMS = { nodeFeeBps: 100, donationBps: 50, question: 'A price at a time, in cents', resolveAfterCloseMs: 60000n, deadlineAfterResolveMs: 3600000n,
  sourceRule: 'the median of three exchanges, whole cents' };
const BODY = {
  gameName: 'price-at', gameDevPubkey: DEV.pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: b32(0xd0), outcomes: [...SCALAR_SIDES], attestors: ATTESTORS.map((a) => a.pub), attestThreshold: 2,
  marketTerms: TERMS, scalar: { low: 0n, high: 100000000n, unit: 'USD cents' }, template: { category: 'prices', maxOutcomes: 2, resolveWithinMs: 7n * 86400000n },
  requiredProtocolVersion: SCALAR_TEMPLATE_VERSION,
};
const signed = (b) => ({ ...b, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(b)), DEV.key)) });
const TPL = signed(BODY);
const ROUND = {
  networkId: b32(0x4e), configHash: new Uint8Array(32), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: gameIdOf(TPL), simCoreHash: new Uint8Array(32),
  startTimeMs: 1788200000000n, entryCloseMs: 1788200060000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: SCALAR_TEMPLATE_VERSION,
};
const EVENT = { question: 'BTC/USD at 2026-10-20 18:00 UTC?', outcomes: ['Higher', 'Lower'], resolveAtMs: ROUND.entryCloseMs + 3600000n,
  scalar: { low: 8000000n, high: 9000000n } };

test('version 8: a scalar market may be a template, and only from 8 with max_outcomes 2', () => {
  assert.equal(SCALAR_TEMPLATE_VERSION, 8);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(8));
  const back = decodeManifest(encodeManifest(TPL));
  assert.deepEqual([isScalar(back), isTemplate(back), back.scalar.unit, back.template.maxOutcomes], [true, true, 'USD cents', 2]);
  assert.equal(toHex(gameIdOf(back)), toHex(gameIdOf(TPL)));
  assert.throws(() => encodeManifestBody({ ...BODY, requiredProtocolVersion: SCALAR_VERSION }), /a template only under protocol version .*8 or later/);
  assert.throws(() => encodeManifestBody({ ...BODY, template: { ...BODY.template, maxOutcomes: 3 } }), /max_outcomes is 2/);
});

test('a round of it names its own bounds in its question tail, read back whole; below version 8 they are refused', () => {
  const r = { ...ROUND, event: EVENT };
  const bytes = encodeRoundContract(r);
  const back = decodeRoundContract(bytes);
  assert.deepEqual(back.event, EVENT);
  assert.equal(toHex(encodeRoundContract(back)), toHex(bytes));
  const plain = encodeRoundContract({ ...ROUND, event: { ...EVENT, scalar: undefined } });
  assert.equal(plain.length, bytes.length - 16, 'the bounds are two i64 inside the tail');
  assert.notEqual(toHex(roundId(r)), toHex(roundId({ ...ROUND, event: { ...EVENT, scalar: { low: 8000000n, high: 9000001n } } })), 'the bounds are the round\'s id');
  assert.throws(() => encodeRoundContract({ ...r, protocolVersion: SCALAR_VERSION }), /own scalar bounds from protocol version 8 on/);
  assert.throws(() => encodeRoundContract({ ...ROUND, event: { ...EVENT, scalar: { low: 5n, high: 5n } } }), /low bound is below its high bound/);
  assert.throws(() => encodeRoundContract({ ...ROUND, event: { ...EVENT, outcomes: ['A', 'B', 'C'] } }), /names its two sides/);
  // A VERSION-7 CONTRACT CARRYING THEM IS REFUSED BY THE DECODER: the version byte is patched in place
  const v7 = new Uint8Array(bytes); v7[2] = SCALAR_VERSION;
  assert.throws(() => decodeRoundContract(v7), /own scalar bounds from protocol version 8 on/);
});

test('the template holds its rounds to bounds inside its own, and a round is paid between ITS bounds', () => {
  assert.equal(roundFitsManifest({ ...ROUND, event: EVENT }, TPL).ok, true);
  assert.match(roundFitsManifest({ ...ROUND, event: { ...EVENT, scalar: undefined } }, TPL).why, /scalar template: each round names the bounds/);
  assert.match(roundFitsManifest({ ...ROUND, event: { ...EVENT, scalar: { low: -1n, high: 9000000n } } }, TPL).why, /outside template "price-at"'s 0..100000000/);
  const plainTpl = signed({ ...BODY, scalar: undefined, outcomes: ['YES', 'NO'], requiredProtocolVersion: 4 });
  assert.match(roundFitsManifest({ ...ROUND, gameId: gameIdOf(plainTpl), event: EVENT }, plainTpl).why, /no scalar market: its rounds name no bounds/);
  const view = marketOfRound(TPL, { ...ROUND, event: EVENT });
  assert.deepEqual(view.scalar, { low: 8000000n, high: 9000000n, unit: 'USD cents' });
  assert.deepEqual(view.outcomes, ['Higher', 'Lower']);
  // THE VALUE IS CLAMPED TO THE ROUND'S BOUNDS, not the template's
  const rid = roundId({ ...ROUND, event: EVENT });
  const body = { roundId: rid, value: 9500000n, observedAtMs: EVENT.resolveAtMs };
  const a = { ...body, signatures: ATTESTORS.slice(0, 2).map((k) => ({ key: k.pub, signature: new Uint8Array(sign(null, Buffer.from(valueAttestationBodyId(body)), k.key)) })) };
  const st = valueAttestationStands(a, { manifest: view, roundIdBytes: rid, verify: verifyEd });
  assert.deepEqual([st.ok, st.clamped], [true, 9000000n]);
  const t = scalarPayoutTable({ entries: [{ entryId: 'aa'.repeat(32), stakeMsat: 1000n, feeMsat: 0n, donationMsat: 0n, pick: 0 },
    { entryId: 'bb'.repeat(32), stakeMsat: 1000n, feeMsat: 0n, donationMsat: 0n, pick: 1 }], value: 8500000n, bounds: view.scalar });
  assert.deepEqual(t.rows.map((r) => r.payoutMsat), [1000n, 1000n], 'the middle of the round\'s bounds splits the pool evenly');
});
