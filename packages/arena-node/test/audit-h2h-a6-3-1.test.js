// Audit h2h r3 (finding, never a fix): the house RPS bot (tools/rps-opponent.mjs) takes a round's contract from whichever of its first five
// seats answers GET /round?id= first (contractOf: Promise.any) and keeps it for good (`seen`). A series round's id hashes only its series id and
// index (contracts.js roundId -> seriesRoundIdOf), so the bot's own `roundId(c)` check-free read takes any fields one seat writes: stake, stake
// expiry, entry close. The page's fetchRound was fixed for exactly this (#3041: a series round is believed only as its template derives it);
// the bot was not. The bot then locks the forged stake (lockEntry: c.stakeMsat, c.stakeExpiryBlocks) to the round's real, honestly attested
// claim key, and every honest seat refuses its entry (stake mismatch): the bot's money is parked in a lock no seat holds for an entry until
// its expiry, and the bot never plays the real player's round.
// SAFE: the contract the bot keeps for a series round is the one its series derives (the honest seats' copy), never one seat's rewrite.
//
// The test runs the bot's own contractOf (its source text, cut from the tool) with a stub fetch: one seat answers at once with a forged
// copy of series round 4 (same id), four honest seats answer a few ms later with the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seriesRound } from '../../arena-protocol/src/series.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const PERIOD = 10000n;
const G = 1788201000000n - (1788201000000n % PERIOD);
const TEMPLATE = {
  networkId: b32(0x4e), configHash: new Uint8Array(32), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: b32(0x77), simCoreHash: new Uint8Array(32),
  startTimeMs: G, entryCloseMs: G, objectionWindowMs: 60000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 2, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 3, seriesPeriodMs: PERIOD, seriesCount: 96,
};

// the bot's contractOf, as the tool has it
function botContractOf({ nodes, fetch }) {
  const src = readFileSync(fileURLToPath(new URL('../tools/rps-opponent.mjs', import.meta.url)), 'utf8');
  const at = src.indexOf('const contractOf = async (round) => {');
  assert.ok(at >= 0, 'rps-opponent.mjs has its contractOf');
  const end = src.indexOf('\n};\n', at);
  const body = src.slice(at, end + 3);
  const seen = new Map();
  // eslint-disable-next-line no-new-func
  const make = new Function('nodes', 'fetch', 'seen', 'decodeRoundContract', 'roundId', `${body}\nreturn contractOf;`);
  return { contractOf: make(nodes, fetch, seen, decodeRoundContract, roundId), seen };
}

test('one of the house bot\'s first five seats answering GET /round first rewrites a series RPS round\'s stake and lock expiry for the bot', async () => {
  const honest = seriesRound(TEMPLATE, 4);
  const id = toHex(roundId(honest));
  // the forged copy: same series and index, so the same id - 1000x the stake, a lock that expires a year of blocks later
  const forged = { ...honest, stakeMsat: honest.stakeMsat * 1000n, stakeExpiryBlocks: 52000 };
  assert.equal(toHex(roundId(forged)), id, 'a series round id hashes only its series id and index');
  const nodes = ['https://evil.example', 'https://s1.example', 'https://s2.example', 'https://s3.example', 'https://s4.example'];
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname !== '/round') return new Response('no', { status: 404 });
    if (u.host === 'evil.example') return new Response(encodeRoundContract(forged));
    await new Promise((ok) => setTimeout(ok, 20));   // an honest seat under load, a little slower
    return new Response(encodeRoundContract(honest));
  };
  const { contractOf } = botContractOf({ nodes, fetch });
  let k = null;
  try { k = await contractOf(id); } catch { k = null; }   // refusing to read the round at all is safe too
  if (k) {
    assert.equal(k.c.stakeMsat, honest.stakeMsat, `the bot keeps evil.example's copy of series round 4: it would lock ${k.c.stakeMsat} msat, the round stakes ${honest.stakeMsat}`);
    assert.equal(k.c.stakeExpiryBlocks, honest.stakeExpiryBlocks, `the bot's lock would expire after ${k.c.stakeExpiryBlocks} blocks, the round's after ${honest.stakeExpiryBlocks}`);
  }
});
