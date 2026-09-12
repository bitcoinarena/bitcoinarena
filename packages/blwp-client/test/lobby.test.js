// THE PAGE'S LOBBY (M3.3-34, §25): a link naming nodes and no round lists what
// they hold, every row is checked against its own contract, and Join is offered
// only at the round's threshold of its own seats - 2 of 2 here.
//
// "A lobby carries nothing": a node's listing is a list of names. The page
// fetches each contract and hashes it (a mismatch gets no row), reads free or
// paying and open or pending off that contract and its own clock, and counts
// DISTINCT SEATS OF THE ROUND whose signed listing says open and seated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { lobbyQuery, lobbyJoinSearch, fetchLobby, lobbyLine } from '../src/lobby.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { lobbyListingId } from '../../protocol/src/lobby-listing.js';
import { encodeLobbyName, lobbyNameId } from '../../protocol/src/lobby-name.js';
import { generatedName } from '../src/identity.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const A = 'http://127.0.0.1:18581';
const B = 'http://127.0.0.2:18582';
const ADVERT = 'ab'.repeat(64);
const LINK = `?node=${A},${B}&bond=${A}/bond&advert=${ADVERT}`;
const NOW = 1789200000000;
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
// THE ROUND'S TWO SEATS, and a stranger who is no seat of it.
const seatA = schnorr.utils.randomSecretKey();
const seatB = schnorr.utils.randomSecretKey();
const stranger = schnorr.utils.randomSecretKey();
const keyOf = (s) => schnorr.getPublicKey(s);

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
  nodes: [keyOf(seatA), keyOf(seatB)],
  ...extra,
});

/** A seat's listing of one round, signed as the node signs it (or tampered after). */
function listing(secret, id, { phase = 'open', seatedHere = true, seated = 0, playing = 0, free = true, at = NOW, tamper = null } = {}) {
  const signed = { roundId: fromHex(id), nodePubkey: keyOf(secret), nowMs: BigInt(at), phase, seatedHere, seated, playing };
  const x = { id, phase, seatedHere, seated, playing, free, sig: toHex(schnorr.sign(lobbyListingId(signed), secret)) };
  return tamper ? { ...x, ...tamper } : x;
}

/** Nodes that answer from tables: each node's key, time and listings, and `/round?id=` contracts. */
function network({ nodes, contracts }) {
  const fetcher = async (url) => {
    const u = new URL(url);
    const node = nodes[`${u.protocol}//${u.host}`];
    if (u.pathname === '/rounds') {
      if (!node) return new Response('down', { status: 503 });
      return new Response(JSON.stringify({ node: toHex(keyOf(node.secret)), nowMs: String(node.at || NOW), rounds: node.rounds }), { status: 200 });
    }
    if (u.pathname === '/round') {
      const held = contracts[u.searchParams.get('id')];
      return held ? new Response(held, { status: 200 }) : new Response('no such round', { status: 404 });
    }
    return new Response('no', { status: 404 });
  };
  return { fetcher };
}

function roundsOf(defs) {
  const contracts = {};
  const id = {};
  for (const [k, c] of Object.entries(defs)) { id[k] = toHex(roundId(c)); contracts[id[k]] = encodeRoundContract(c); }
  return { contracts, id };
}

test('a lobby link names nodes and no round; a round in the link is a join, no node is the offline daily', () => {
  assert.equal(lobbyQuery(''), null);
  assert.equal(lobbyQuery('?practice=0'), null);
  assert.equal(lobbyQuery(`${LINK}&round=${'1f'.repeat(32)}`), null, 'a join link was read as a lobby');
  const named = lobbyQuery(LINK);
  assert.deepEqual(named.nodes, [A, B]);
  assert.equal(named.bond, `${A}/bond`);
  assert.throws(() => lobbyQuery(`?node=${A}&bond=${A}/bond&advert=${ADVERT}`), /two independent sources/);
  assert.throws(() => lobbyQuery(`?node=${A},${B}&advert=${ADVERT}`), /bond/);
  const join = new URLSearchParams(lobbyJoinSearch(LINK, 'cd'.repeat(32)).slice(1));
  assert.equal(join.get('round'), 'cd'.repeat(32));
  assert.equal(join.get('node'), `${A},${B}`);
  assert.equal(join.get('advert'), ADVERT);
});

test('2 of 2: Join only where both of the round\'s seats signed it open and seated; the contract\'s word for free, open and pending', async () => {
  const now = BigInt(NOW);
  const { contracts, id } = roundsOf({
    freeOpen: contractAt(now - 5000n),
    oneSeat: contractAt(now - 6000n),
    freePending: contractAt(now + 90000n),
    freeOver: contractAt(now - 400000n),
    payingOpen: contractAt(now - 8000n, { stakeMsat: 100000n, federationId: b32(0xfe) }),
  });
  const forged = 'ee'.repeat(32);
  contracts[forged] = contracts[id.freeOpen];        // a listed id whose contract is another round's
  const net = network({
    contracts,
    nodes: {
      [A]: { secret: seatA, rounds: [
        listing(seatA, id.freeOpen, { seated: 2, playing: 1 }),
        listing(seatA, id.oneSeat, { seated: 1 }),
        listing(seatA, id.freePending, { phase: 'pending', seatedHere: false }),
        listing(seatA, id.freeOver, { seated: 3, playing: 3 }),
        listing(seatA, id.payingOpen, { free: true }),     // it says free; the contract stakes 100 sat
        listing(seatA, forged, { seated: 9 }),
        { id: 'not-a-round', seated: 1 },
      ] },
      [B]: { secret: seatB, rounds: [
        listing(seatB, id.freeOpen, { seated: 2, playing: 2 }),
        listing(seatB, id.payingOpen, { free: false }),
        listing(seatB, id.freePending, { phase: 'pending', seatedHere: false }),
      ] },
    },
  });
  const { rows, refused } = await fetchLobby({ nodes: [A, B], fetcher: net.fetcher, nowMs: NOW, verify });
  const name = (r) => Object.keys(id).find((k) => id[k] === r.id) || r.id.slice(0, 8);
  const facts = {
    rows: rows.map(name),
    phases: rows.map((r) => r.phase),
    free: rows.map((r) => r.free),
    agree: rows.map((r) => `${r.seatsAgree}/${r.needed}`),
    joinable: rows.map((r) => r.joinable),
    disagrees: rows.map((r) => r.disagrees.length),
    refusedForged: refused.some((w) => w.startsWith(forged.slice(0, 16))),
    refusedJunk: refused.some((w) => /not a round id/.test(w)),
  };
  console.log('  FACTS (page lobby, 2-of-2):', JSON.stringify(facts));
  assert.deepEqual(facts, {
    // open before pending, soonest entry close first; freeOver is past its entry close
    rows: ['payingOpen', 'oneSeat', 'freeOpen', 'freePending'],
    phases: ['open', 'open', 'open', 'pending'],
    free: [false, true, true, true],
    agree: ['2/2', '1/2', '2/2', '0/2'],
    joinable: [true, false, true, false],
    disagrees: [1, 0, 0, 0],
    refusedForged: true, refusedJunk: true,
  });
  const byName = Object.fromEntries(rows.map((r) => [name(r), r]));
  assert.deepEqual(byName.freeOpen.said.map((c) => `${c.seated}/${c.playing}`), ['2/1', '2/2'], 'both nodes\' counts are carried, each as that node\'s');
  const line = lobbyLine(byName.freeOpen, NOW);
  console.log(`  ${line}`);
  assert.match(line, /^free - no wallet, no Lightning · entry open, closes in 2:55 · 2 of 2 seats agree · /);
  assert.match(lobbyLine(byName.oneSeat, NOW), /1 of 2 seats agree - waiting for 1 more/);
  assert.match(lobbyLine(byName.payingOpen, NOW), /stake 100 sat - a federation stake lock .* listed it as free$/);
  assert.match(lobbyLine(byName.freePending, NOW), /committee: pending, entry opens in 1:30/);
});

test('what does not count toward 2 of 2: a node down, a stranger\'s key, one key twice, a tampered count, a stale listing', async () => {
  const c = contractAt(BigInt(NOW) - 1000n);
  const { contracts, id } = roundsOf({ r: c });
  const rid = id.r;
  const run = async (nodes, extraNodes = []) => (await fetchLobby({ nodes: [A, B, ...extraNodes], fetcher: network({ nodes, contracts }).fetcher, nowMs: NOW, verify }));
  const C = 'http://127.0.0.3:18583';
  const cases = {
    bothSeats: await run({ [A]: { secret: seatA, rounds: [listing(seatA, rid)] }, [B]: { secret: seatB, rounds: [listing(seatB, rid)] } }),
    nodeDown: await run({ [A]: { secret: seatA, rounds: [listing(seatA, rid)] } }),
    stranger: await run({ [A]: { secret: seatA, rounds: [listing(seatA, rid)] }, [B]: { secret: stranger, rounds: [listing(stranger, rid)] } }),
    oneKeyTwice: await run({ [A]: { secret: seatA, rounds: [listing(seatA, rid)] }, [B]: { secret: seatA, rounds: [listing(seatA, rid)] } }),
    tampered: await run({ [A]: { secret: seatA, rounds: [listing(seatA, rid)] }, [B]: { secret: seatB, rounds: [listing(seatB, rid, { seatedHere: false, tamper: { seatedHere: true } })] } }),
    stale: await run({ [A]: { secret: seatA, rounds: [listing(seatA, rid)] }, [B]: { secret: seatB, at: NOW - 120000, rounds: [listing(seatB, rid, { at: NOW - 120000 })] } }),
    notSeated: await run({ [A]: { secret: seatA, rounds: [listing(seatA, rid)] }, [B]: { secret: seatB, rounds: [listing(seatB, rid, { seatedHere: false })] } }),
    thirdNodeIsAStranger: await run({ [A]: { secret: seatA, rounds: [listing(seatA, rid)] }, [C]: { secret: stranger, rounds: [listing(stranger, rid)] } }, [C]),
  };
  const facts = Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, v.rows.length ? `${v.rows[0].seatsAgree}/${v.rows[0].needed} ${v.rows[0].joinable ? 'join' : 'no join'}` : 'no row']));
  console.log('  FACTS (what counts):', JSON.stringify(facts));
  assert.deepEqual(facts, {
    bothSeats: '2/2 join', nodeDown: '1/2 no join', stranger: '1/2 no join', oneKeyTwice: '1/2 no join',
    tampered: '1/2 no join', stale: '1/2 no join', notSeated: '1/2 no join', thirdNodeIsAStranger: '1/2 no join',
  });
  assert.match(cases.nodeDown.refused.join('; '), new RegExp(`${B.replace(/[.]/g, '\\.')}: answered 503`));
  await assert.rejects(fetchLobby({ nodes: [A, B], fetcher: network({ nodes: {}, contracts }).fetcher, nowMs: NOW }), /no verify was injected/);
});

test('a row names its seated players by the names they signed; a seat\'s forgery and a record for another round are not shown', async () => {
  const { contracts, id } = roundsOf({ r: contractAt(BigInt(NOW) - 1000n) });
  const rid = fromHex(id.r);
  const player = schnorr.utils.randomSecretKey();
  const other = schnorr.utils.randomSecretKey();
  const signed = (secret, fields) => {
    const r = { roundId: rid, identityPubkey: b32(7), atMs: 1000n, name: '', ...fields };
    return { record: toHex(encodeLobbyName(r)), sig: toHex(schnorr.sign(lobbyNameId(r), secret)) };
  };
  const named = signed(player, { playerPubkey: keyOf(player), name: 'Road Owl 42' });
  const plain = signed(other, { playerPubkey: keyOf(other), identityPubkey: b32(8) });
  const forged = signed(seatB, { playerPubkey: keyOf(player), name: 'Mallory', atMs: 9000n });
  const elsewhere = signed(player, { roundId: b32(0x77), playerPubkey: keyOf(player), name: 'Elsewhere', atMs: 9000n });
  const net = network({ contracts, nodes: {
    [A]: { secret: seatA, rounds: [{ ...listing(seatA, id.r, { seated: 2, playing: 2 }), names: [named, plain] }] },
    [B]: { secret: seatB, rounds: [{ ...listing(seatB, id.r, { seated: 2, playing: 2 }), names: [forged, elsewhere] }] },
  } });
  const { rows } = await fetchLobby({ nodes: [A, B], fetcher: net.fetcher, nowMs: NOW, verify });
  const line = lobbyLine(rows[0], NOW);
  console.log(`  ${line}`);
  assert.deepEqual(rows[0].names.map((n) => n.name).sort(), ['Road Owl 42', generatedName(b32(8))].sort());
  assert.match(line, / · players: .*Road Owl 42/);
  assert.doesNotMatch(line, /Mallory|Elsewhere/);
  assert.equal(line.includes(toHex(keyOf(player)).slice(0, 8)), false, 'a key in place of a name');
  assert.equal(rows[0].joinable, true, 'names are no part of 2 of 2');
});
