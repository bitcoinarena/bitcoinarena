// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit r6 (attest-1): A MARKET ON A GAME READS ONE PEER SEAT'S ANSWER WHOLE. game-market.js fetchSource takes
// GET /round?id= of each census seat with `await r.arrayBuffer()` and collect() takes each committee seat's GET /round-result with
// `await r.json()` - no byte limit on either. A source contract is a few hundred bytes and a signed result a few kB, yet one seat
// of the round's census (role b) answers with tens of MB and the honest seat buffers (and for /round-result JSON-parses on its one
// thread) all of it, on every sweep pass that asks again. SAFE: a peer's answer is read only up to a small cap and then refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { gameMarkets } from '../src/game-market.js';
import { hostedPlugins } from '../src/plugins.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { decodeManifest, gameIdOf, SOURCE_KIND, GAME_MARKET_REFUND } from '../../arena-protocol/src/manifest.js';
import { GAME_MARKET_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { MANIFEST_V2_HEX as NEXTBLOCK_V2_HEX } from '../../nextblock/plugin/nextblock-v2.js';
import { testAttestedGame } from './plugins/sign.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const seats = [1, 2, 3, 4, 5, 6, 7].map((n) => { const sk = b32(n + 40); return { sk, pk: schnorr.getPublicKey(sk) }; });
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };
const TICK_TOCK_ID = gameIdOf(decodeManifest(fromHex(NEXTBLOCK_V2_HEX)));
const MARKET = testAttestedGame({ name: 'tick-tock-fronts-r6', outcomes: ['BULLS', 'BEARS'],
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
const SOURCE = { ...BASE, protocolVersion: 2, gameId: TICK_TOCK_ID, startTimeMs: S, entryCloseMs: S + 45000n, nodes: seats.map((s) => s.pk) };
const SOURCE_ID = roundId(SOURCE);
const M = { ...BASE, protocolVersion: GAME_MARKET_VERSION, gameId: MARKET.registration.gameId, simCoreHash: new Uint8Array(32),
  configHash: new Uint8Array(32), startTimeMs: S - 900000n, entryCloseMs: S - 60000n, sourceRoundId: SOURCE_ID };

const PADDED = 48 * 1024 * 1024;   // what the one bad seat sends
const CAP = 4 * 1024 * 1024;       // far above any honest answer (a contract is < 1 kB, a signed result a few kB)
// A peer answer of `total` bytes, counting how many the reader pulled
function padded(total, first) {
  const st = { pulled: 0 };
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let sent = 0;
  const body = new ReadableStream({
    pull(ctrl) {
      if (sent >= total) { ctrl.close(); return; }
      const c = sent === 0 && first ? first : chunk;
      sent += c.length; st.pulled += c.length; ctrl.enqueue(c);
    },
  }, { highWaterMark: 0 });
  return { res: new Response(body, { status: 200 }), st };
}

function seatWith(rounds, fetcher, { committee = seats } = {}) {
  const rows = new Map(rounds.map((c) => [toHex(roundId(c)), { contract: encodeRoundContract(c) }]));
  const round = { get: (id) => rows.get(toHex(id)) || null, gameOutcomes: () => [], outcomeAttestations: () => [] };
  const committeeFor = (id, role) => (role === 'settlement' && toHex(id) === toHex(SOURCE_ID)
    ? { ok: true, committee: committee.map((s, i) => ({ pubkey: s.pk, advert: { endpoint: `http://seat${i}.test` } })) } : { ok: false, why: 'not drawn' });
  return gameMarkets({ round, plugins: PLUGINS, committeeFor, verify, now: () => Number(S + 200000n), fetcher, timeoutMs: 20000,
    sourcePeers: () => ['http://bad.test', 'http://good.test'] });
}

test('wf1489-r6-attest-1: one census seat\'s padded GET /round answer is not read whole by fetchSource', async () => {
  let bad = null;
  const fetcher = async (url) => {
    if (url.startsWith('http://bad.test/round?')) { bad = padded(PADDED, null); return bad.res; }
    if (url.startsWith('http://good.test/round?')) return new Response(encodeRoundContract(SOURCE), { status: 200 });
    return new Response('no', { status: 404 });
  };
  const gm = seatWith([M], fetcher);
  const got = await gm.fetchSource(roundId(M), { market: M, manifest: MARKET.registration.manifest });
  console.log(`  FACTS: the bad seat sent ${PADDED} bytes; the honest seat pulled ${bad ? bad.st.pulled : 0} of them; fetchSource ok=${got.ok} from=${got.from || '-'}`);
  assert.ok(bad, 'the bad seat was asked');
  assert.ok(bad.st.pulled <= CAP, `the honest seat read ${bad.st.pulled} bytes of one peer's GET /round answer (cap ${CAP}): a source contract is under 1 kB`);
});

test('wf1489-r6-attest-1: one committee seat\'s padded GET /round-result answer is not read whole by collect()', async () => {
  let bad = null;
  const fetcher = async (url) => {
    if (url.startsWith('http://seat0.test/round-result?')) { bad = padded(PADDED, new TextEncoder().encode('{"pad":"')); return bad.res; }
    return new Response('no', { status: 503 });
  };
  const gm = seatWith([SOURCE, M], fetcher);
  const src = gm.sourceOf(M);
  assert.ok(src && src.ok);
  const c = await gm.collect(SOURCE_ID, src);
  console.log(`  FACTS: the bad seat sent ${PADDED} bytes; the honest seat pulled ${bad ? bad.st.pulled : 0} of them; collect asked=${c.asked}`);
  assert.ok(bad, 'the bad seat was asked');
  assert.ok(bad.st.pulled <= CAP, `the honest seat read ${bad.st.pulled} bytes of one peer's GET /round-result answer (cap ${CAP}): a signed result is a few kB`);
});
