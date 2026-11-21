// kanban #3041: the card's test (audit attest r3-1 of 2026-11-19)
// Audit attest r3-1 (finding, never a fix): a SERIES market round's id is H(series_id || i) and hashes none of its other fields, so
// the page's fetchRound (join.js) - which only checks roundId(contract) === id - takes whatever contract the first seat that answers
// GET /round?id= serves, and keeps it (ROUNDS_KEPT, first wins). The lobby (lobby.js "a round's id is its contract's hash"), the join
// and the market page's pick record (market.js pickRecord: entryCloseMs) are built on that copy. One seat that answers first serves
// round i of an Up/Down series with its window moved one period: the pick is recorded on the wrong window, and the honest drawn /
// fixed attestors' outcome - observed at the round's real window end - is refused by the page's own check as "another window".
// SAFE: a series round is believed only as its series template derives it (series.js seriesRoundCheck), as market.js already does
// for a market's source round and as the attestor daemon (attestor.js roundCloseOf) does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify as edVerify, createPublicKey } from 'node:crypto';
import { fetchRound } from '../src/join.js';
import { marketForRound, checkMarketOutcome, pickRecord } from '../src/market.js';
import { seriesRound } from '../../arena-protocol/src/series.js';
import { seriesLineOf } from '../../arena-protocol/src/series-line.js';
import { encodeManifest, manifestBodyId, gameIdOf, RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { encodeAttestation, attestationBodyId } from '../../arena-protocol/src/attested.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const edKey = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; };
const verifyEd = (sig, digest, key) => edVerify(null, Buffer.from(digest), createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));
const DEV = edKey();
const ATTESTORS = [edKey(), edKey(), edKey()].sort((x, y) => Buffer.compare(Buffer.from(x.pub), Buffer.from(y.pub)));
const PERIOD = 900000n;
const body = { version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED, cores: [], runTicksMax: 0, roundPeriodMs: PERIOD,
  payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0, clients: [], gameDonationSetId: b32(0xd0),
  gameName: 'btc-updown-15m-audit', gameDevPubkey: DEV.pub, outcomes: ['Up', 'Down'], attestors: ATTESTORS.map((a) => a.pub), attestThreshold: 2,
  marketTerms: { nodeFeeBps: 100, donationBps: 50, question: 'BTC up or down in 15 min?', resolveAfterCloseMs: 0n, deadlineAfterResolveMs: 600000n, sourceRule: 'TWAP 60 s' } };
const MANIFEST = { ...body, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), DEV.key)) };
const G = 1788201000000n - (1788201000000n % PERIOD);            // a quarter hour
const TEMPLATE = {
  networkId: b32(0x4e), configHash: new Uint8Array(32), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: gameIdOf(MANIFEST), simCoreHash: new Uint8Array(32),
  startTimeMs: G, entryCloseMs: G, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 3, seriesPeriodMs: PERIOD, seriesCount: 96,
};

test('one seat answering GET /round first decides the page\'s copy of a series market round: its window moves and the honest attestation reads as another window', async () => {
  const honest = seriesRound(TEMPLATE, 4);
  const id = toHex(roundId(honest));
  assert.equal(id, toHex(roundId(honest)));
  // the forged copy: the same series and index (so the same id), its window one period later - still on the market's grid
  const forged = { ...honest, startTimeMs: honest.startTimeMs + PERIOD, entryCloseMs: honest.entryCloseMs + PERIOD };
  assert.equal(toHex(roundId(forged)), id, 'a series round id hashes only series id and index');
  const line = seriesLineOf(TEMPLATE);
  const seats = {
    'evil.example': { round: encodeRoundContract(forged), line },
    'honest.example': { round: encodeRoundContract(honest), line },
  };
  const fetcher = async (url) => {
    const u = new URL(url); const s = seats[u.host];
    if (!s) return new Response('no', { status: 404 });
    if (u.pathname === '/round') return new Response(s.round);
    if (u.pathname === '/series-template') return new Response(s.line);
    return new Response('no', { status: 404 });
  };
  const got = await fetchRound(id, ['https://evil.example', 'https://honest.example'], { fetcher });
  // the attestors sign the round's real window end (its honest contract's entry close)
  const att = { roundId: roundId(honest), outcome: 0, observedAtMs: honest.entryCloseMs };
  const attestation = toHex(encodeAttestation({ ...att, signatures: ATTESTORS.slice(0, 2).map((a) => ({ key: a.pub, signature: new Uint8Array(sign(null, Buffer.from(attestationBodyId(att)), a.key)) })) }));
  const pick = pickRecord({ roundIdHex: id, entryIdHex: 'e1'.repeat(32), pick: 0, round: got.contract, nodes: ['https://evil.example', 'https://honest.example'], confirmed: true });
  const market = marketForRound({ gameId: honest.gameId, entryCloseMs: got.contract.entryCloseMs }, { manifestBytes: encodeManifest(MANIFEST) });
  const check = await checkMarketOutcome({ outcome: { attestation }, market, roundIdHex: id, entryCloseMs: pick.entryCloseMs, verify: verifyEd });
  // SAFE: the page's round is the one its series derives, and the attestors' honest outcome of it verifies
  assert.equal(got.contract.entryCloseMs, honest.entryCloseMs, `the page took seat ${got.from}'s contract of series round 4: entry close ${got.contract.entryCloseMs}, the series derives ${honest.entryCloseMs}`);
  assert.equal(check.verified, true, check.why);
});
