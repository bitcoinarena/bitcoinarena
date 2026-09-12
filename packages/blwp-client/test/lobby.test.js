// THE PAGE'S LOBBY (M3.3-34, §25): a link naming nodes and no round lists what
// they hold, and every row is checked against its own contract.
//
// "A lobby carries nothing": a node's listing is a list of names. The page
// fetches each contract and hashes it (a mismatch gets no row), reads free or
// paying and open or pending off that contract and its own clock, and shows a
// node's seat counts as what that node says. Joining is the join link.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lobbyQuery, lobbyJoinSearch, fetchLobby, lobbyLine } from '../src/lobby.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const A = 'http://127.0.0.1:18581';
const B = 'http://127.0.0.2:18582';
const ADVERT = 'ab'.repeat(64);
const LINK = `?node=${A},${B}&bond=${A}/bond&advert=${ADVERT}`;
const NOW = 1789200000000;

const contractAt = (committeeTimeMs, extra = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1),
  committeeTimeMs, randomnessRule: 'bitcoin-block-hash',
  startTimeMs: committeeTimeMs + MIN_ENTRY_WINDOW_MS, entryCloseMs: committeeTimeMs + MIN_ENTRY_WINDOW_MS + 120000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [],
  donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n,
  blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(0x0a), b32(0x0b)],
  ...extra,
});

/** Two nodes that answer from tables: `/rounds` listings and `/round?id=` contracts. */
function network({ listings, contracts }) {
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url);
    const u = new URL(url);
    const node = `${u.protocol}//${u.host}`;
    if (u.pathname === '/rounds') {
      if (!listings[node]) return new Response('down', { status: 503 });
      return new Response(JSON.stringify({ rounds: listings[node] }), { status: 200 });
    }
    if (u.pathname === '/round') {
      const held = contracts[u.searchParams.get('id')];
      return held ? new Response(held, { status: 200 }) : new Response('no such round', { status: 404 });
    }
    return new Response('no', { status: 404 });
  };
  return { fetcher, asked };
}

test('a lobby link names nodes and no round; a round in the link is a join, no node is the offline daily', () => {
  assert.equal(lobbyQuery(''), null);
  assert.equal(lobbyQuery('?practice=0'), null);
  assert.equal(lobbyQuery(`${LINK}&round=${'1f'.repeat(32)}`), null, 'a join link was read as a lobby');
  const named = lobbyQuery(LINK);
  assert.deepEqual(named.nodes, [A, B]);
  assert.equal(named.bond, `${A}/bond`);
  // held to the join link's rules: a lobby naming one chain source is refused by name
  assert.throws(() => lobbyQuery(`?node=${A}&bond=${A}/bond&advert=${ADVERT}`), /two independent sources/);
  assert.throws(() => lobbyQuery(`?node=${A},${B}&advert=${ADVERT}`), /bond/);
  const join = new URLSearchParams(lobbyJoinSearch(LINK, 'cd'.repeat(32)).slice(1));
  assert.equal(join.get('round'), 'cd'.repeat(32));
  assert.equal(join.get('node'), `${A},${B}`);
  assert.equal(join.get('advert'), ADVERT);
});

test('every row is the contract\'s own word: free, open or pending, and a node that lists a round it cannot back gets no row', async () => {
  const now = BigInt(NOW);
  const rounds = {
    freeOpen: contractAt(now - 5000n),
    freePending: contractAt(now + 90000n),
    freeOver: contractAt(now - 400000n),
    payingOpen: contractAt(now - 8000n, { stakeMsat: 100000n, federationId: b32(0xfe) }),
  };
  const contracts = {};
  const id = {};
  for (const [k, c] of Object.entries(rounds)) { id[k] = toHex(roundId(c)); contracts[id[k]] = encodeRoundContract(c); }
  // A LISTED ID WHOSE CONTRACT IS ANOTHER ROUND'S: the node answers with the free round's bytes.
  const forged = 'ee'.repeat(32);
  contracts[forged] = encodeRoundContract(rounds.freeOpen);
  const net = network({
    listings: {
      [A]: [
        { id: id.freeOpen, seated: 2, playing: 1, watching: 1, free: true },
        { id: id.freePending, seated: 0, playing: 0, free: true },
        { id: id.freeOver, seated: 3, playing: 3, free: true },
        { id: id.payingOpen, seated: 0, playing: 0, free: true },      // it says free; the contract stakes 100 sat
        { id: forged, seated: 9, playing: 9, free: true },
        { id: 'not-a-round', seated: 1 },
      ],
      [B]: [{ id: id.freeOpen, seated: 2, playing: 2, watching: 0, free: true }],
    },
    contracts,
  });
  const { rows, refused } = await fetchLobby({ nodes: [A, B], fetcher: net.fetcher, nowMs: NOW });
  const name = (r) => Object.keys(id).find((k) => id[k] === r.id) || r.id.slice(0, 8);
  const facts = {
    rows: rows.map(name),
    phases: rows.map((r) => r.phase),
    free: rows.map((r) => r.free),
    wallet: rows.map((r) => r.wallet),
    counts: rows[0] && rows[0].said.map((c) => `${c.seated}/${c.playing}`),
    disagrees: rows.map((r) => r.disagrees.length),
    refusedForged: refused.some((w) => w.startsWith(forged.slice(0, 16))),
    refusedJunk: refused.some((w) => /not a round id/.test(w)),
  };
  console.log('  FACTS (page lobby):', JSON.stringify(facts));
  assert.deepEqual(facts, {
    // open before pending, soonest entry close first; freeOver is past its entry close
    rows: ['payingOpen', 'freeOpen', 'freePending'],
    phases: ['open', 'open', 'pending'],
    free: [false, true, true],
    wallet: ['federation-lock', 'none', 'none'],
    counts: ['0/0'],
    disagrees: [1, 0, 0],
    refusedForged: true, refusedJunk: true,
  });
  const free = rows[1];
  assert.deepEqual(free.said.map((c) => `${c.seated}/${c.playing}`), ['2/1', '2/2'], 'both nodes\' counts are carried, each as that node\'s');
  const line = lobbyLine(free, NOW);
  console.log(`  ${line}`);
  assert.match(line, /^free - no wallet, no Lightning · entry open, closes in 2:55 · /);
  assert.match(lobbyLine(rows[0], NOW), /stake 100 sat - a federation stake lock .* listed it as free$/);
  assert.match(lobbyLine(rows[2], NOW), /committee: pending, entry opens in 1:30/);
});

test('a node that is down is named, and the other node\'s rounds are still listed', async () => {
  const c = contractAt(BigInt(NOW) - 1000n);
  const rid = toHex(roundId(c));
  const net = network({ listings: { [B]: [{ id: rid, seated: 1, playing: 0, free: true }] }, contracts: { [rid]: encodeRoundContract(c) } });
  const { rows, refused } = await fetchLobby({ nodes: [A, B], fetcher: net.fetcher, nowMs: NOW });
  assert.deepEqual(rows.map((r) => r.id), [rid]);
  assert.match(refused.join('; '), new RegExp(`${A.replace(/[.]/g, '\\.')}: answered 503`));
});
