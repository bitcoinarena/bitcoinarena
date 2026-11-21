// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1615 refute: the guard skips scalar markets (`!p.market.scalar`), so a scalar line still takes its share from one seat's
// table. The verified value is the LOW bound (80,000.00 USD): LONG is paid 0 of its net. A seat's table pays LONG everything.
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

test('a scalar pick at the low bound is never told LONG gained, whatever one seat\'s table says', async () => {
  const market = marketForRound({ gameId: SCALAR_ROUND.gameId }, { manifestBytes: encodeManifest(SCALAR_M) });
  const rid = toHex(SCALAR_RID);
  const ok = await checkMarketOutcome({ outcome: { attestation: valueAtt(8000000n, ATTESTORS.slice(0, 2)) }, market, roundIdHex: rid, verify: verifyEd });
  assert.equal(ok.verified, true, ok.why);
  const pick = { roundIdHex: rid, entryIdHex: 'e1'.repeat(32), market, pick: 0, stakeMsat: '100000', entryCloseMs: '1' };
  const forged = { refunded: false, rows: [{ entryId: 'e1'.repeat(32), netMsat: '98500', payoutMsat: '197000', won: true },
    { entryId: 'e2'.repeat(32), netMsat: '98500', payoutMsat: '0', won: false }] };
  const [line] = marketLines({ picks: [pick], outcomes: new Map([[rid, { state: 'ATTESTED', label: 'LONG', final: true, table: forged, check: ok }]]), nowMs: 2 });
  console.log('  LINE:', line.state, line.text);
  // at the low bound LONG's share of the pool is 0: no verified line may say LONG got back more than its net
  assert.ok(!(line.state === 'settled' && BigInt(line.payoutMsat) > BigInt(line.netMsat)), 'forged scalar gain shown as verified: ' + line.text);
});
