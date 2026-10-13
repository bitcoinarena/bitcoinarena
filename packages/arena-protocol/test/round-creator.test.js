// A ROUND'S CREATOR (§6 creator_pubkey / creator_signature, kanban #313; 2026.0.3). The contract may name its creator's x-only key,
// last, after its marker - every contract naming none keeps its bytes and id; the creator's BIP-340 signature over the round id
// rides beside it (creator.js), and stands only by that key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { encodeRoundContract, decodeRoundContract, roundId, CREATOR_MARKER } from '../src/contracts.js';
import { creatorMessage, creatorSignatureStands } from '../src/creator.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId } from '../src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const round = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 3,
};
const SECRET = b32(0x11);
const CREATOR = schnorr.getPublicKey(SECRET);
const verify = (s, m, k) => schnorr.verify(s, m, k);

test('a v3 contract names its creator last, after its marker, beside every other tail; none named keeps its bytes; v1/v2 refuse it', () => {
  const plain = encodeRoundContract(round);
  const named = encodeRoundContract({ ...round, creatorPubkey: CREATOR });
  assert.deepEqual(named.subarray(0, plain.length), plain);
  assert.equal(named[plain.length], CREATOR_MARKER);
  assert.equal(named.length, plain.length + 33);
  assert.deepEqual(decodeRoundContract(named).creatorPubkey, CREATOR);
  assert.equal(decodeRoundContract(plain).creatorPubkey, undefined);
  assert.notDeepEqual(roundId({ ...round, creatorPubkey: CREATOR }), roundId(round), 'the creator is in the id');
  // with a start deadline, a series, both: the creator reads back and so does the rest
  for (const more of [{ startDeadlineTicks: 100 }, { seriesId: b32(0x5e), roundIndex: 7 }, { startDeadlineTicks: 100, seriesId: b32(0x5e), roundIndex: 7 }]) {
    const back = decodeRoundContract(encodeRoundContract({ ...round, ...more, creatorPubkey: CREATOR }));
    assert.deepEqual(back.creatorPubkey, CREATOR, JSON.stringify(Object.keys(more)));
    for (const [k, v] of Object.entries(more)) assert.deepEqual(back[k], v, k);
    assert.equal(decodeRoundContract(encodeRoundContract({ ...round, ...more })).creatorPubkey, undefined);
  }
  for (const v of [1, 2]) assert.throws(() => encodeRoundContract({ ...round, protocolVersion: v, creatorPubkey: CREATOR }), /from protocol version 3/);
  assert.throws(() => encodeRoundContract({ ...round, creatorPubkey: new Uint8Array(32) }), /32-byte x-only key/);
  // 33 trailing bytes without the marker are no contract
  const bad = Uint8Array.from(named); bad[plain.length] = 0x00;
  assert.throws(() => decodeRoundContract(bad), /trailing bytes/);
});

test('the creator signature stands only by the named key over this round\'s id; a round naming none takes none', () => {
  const c = decodeRoundContract(encodeRoundContract({ ...round, creatorPubkey: CREATOR }));
  const sig = schnorr.sign(creatorMessage(roundId(c)), SECRET);
  assert.equal(creatorSignatureStands(c, sig, { verify }).ok, true);
  assert.match(creatorSignatureStands(c, null, { verify }).why, /without the creator's 64-byte signature/);
  const other = schnorr.sign(creatorMessage(roundId(c)), b32(0x22));
  assert.match(creatorSignatureStands(c, other, { verify }).why, /not the named creator's/);
  const elsewhere = schnorr.sign(creatorMessage(roundId({ ...c, minScore: 2 })), SECRET);
  assert.equal(creatorSignatureStands(c, elsewhere, { verify }).ok, false, 'a signature over another round');
  assert.equal(creatorSignatureStands(decodeRoundContract(encodeRoundContract(round)), null, { verify }).ok, true);
  assert.equal(creatorSignatureStands(decodeRoundContract(encodeRoundContract(round)), sig, { verify }).ok, false);
});

test('a series naming its creator: one signature over the series id stands for it, and travels on its series line (kanban #313)', async () => {
  const { seriesCreatorMessage, seriesCreatorStands } = await import('../src/creator.js');
  const { seriesId } = await import('../src/series.js');
  const { parseSeriesLine, seriesLineOf } = await import('../../arena-node/src/series-line.js');
  const t = { ...round, creatorPubkey: CREATOR, seriesGrid: true, seriesPeriodMs: 8000n, seriesCount: 10800, committeeTimeMs: 0n, startTimeMs: 2700000n, entryCloseMs: 2780000n };
  const sid = seriesId(t);
  const sig = schnorr.sign(seriesCreatorMessage(sid), SECRET);
  assert.equal(seriesCreatorStands(t, sig, { verify, seriesIdOf: seriesId }).ok, true);
  assert.match(seriesCreatorStands(t, null, { verify, seriesIdOf: seriesId }).why, /comes without the creator's 64-byte signature/);
  assert.match(seriesCreatorStands(t, schnorr.sign(seriesCreatorMessage(sid), b32(0x22)), { verify, seriesIdOf: seriesId }).why, /not the named creator's/);
  const { creatorPubkey: _c, ...unnamed } = t; void _c;
  assert.match(seriesCreatorStands(unnamed, sig, { verify, seriesIdOf: seriesId }).why, /names no creator/);
  const line = seriesLineOf({ ...t, creatorSignature: sig }, encodeRoundContract);
  assert.match(line, / grid period=8000 count=10800 creator=[0-9a-f]{128}$/);
  const back = parseSeriesLine(line);
  assert.deepEqual([Buffer.from(back.creatorSignature).toString('hex'), Buffer.from(seriesId(back)).toString('hex')], [Buffer.from(sig).toString('hex'), Buffer.from(sid).toString('hex')],
    'the signature beside the id, the id unchanged by it');
  assert.equal(seriesCreatorStands(back, back.creatorSignature, { verify, seriesIdOf: seriesId }).ok, true);
});
