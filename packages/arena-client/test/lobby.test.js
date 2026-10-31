// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE'S LOBBY (M3.3-34, §25): a link naming nodes and no round lists what
// they hold, every row is checked against its own contract, and Join is offered
// only at the round's threshold of its own signer nodes - 2 of 2 here.
//
// "A lobby carries nothing": a node's listing is a list of names. The page
// fetches each contract and hashes it (a mismatch gets no row), reads free or
// paying and open or pending off that contract and its own clock, and counts
// DISTINCT SIGNER NODES OF THE ROUND whose signed listing says open and joined.
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { test } from 'node:test';
// The run length is the core's; a literal 9000 is refused by the node as a contract
// disagreeing with the network it names (WAR_TACTICS moved a run to 10800).
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { lobbyQuery, lobbyJoinSearch, fetchLobby, lobbyLine, dailyLobbySearch, lobbyOnePerKind, lobbyKeepWhenUnanswered, lobbyStakeSats, answerWithin, SIGNER_ANSWER_MS } from '../src/lobby.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { lobbyListingId } from '../../arena-protocol/src/lobby-listing.js';
import { encodeLobbyName, lobbyNameId } from '../../arena-protocol/src/lobby-name.js';
import { generatedName } from '../src/identity.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex, taggedHash } from '../../arena-protocol/src/hash.js';
import { TAG } from '../../arena-protocol/src/constants.js';
import { readFileSync } from 'node:fs';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const A = 'http://127.0.0.1:18581';
const B = 'http://127.0.0.2:18582';
const ADVERT = 'ab'.repeat(64);
const LINK = `?node=${A},${B}&bond=${A}/bond&advert=${ADVERT}`;
const NOW = 1789200000000;
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
// THE ROUND'S TWO SIGNER NODES, and a stranger who is no signer node of it.
const signerNodeA = schnorr.utils.randomSecretKey();
const signerNodeB = schnorr.utils.randomSecretKey();
const stranger = schnorr.utils.randomSecretKey();
const keyOf = (s) => schnorr.getPublicKey(s);

const contractAt = (committeeTimeMs, extra = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs, randomnessRule: 'bitcoin-block-hash',
  startTimeMs: committeeTimeMs + MIN_ENTRY_WINDOW_MS, entryCloseMs: committeeTimeMs + MIN_ENTRY_WINDOW_MS + 120000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [keyOf(signerNodeA), keyOf(signerNodeB)],
  ...extra,
});

// A PAYING ROUND IS SEVEN SIGNER NODES, EACH ONE GUARDIAN (PRIORITIES item 5; 2026-09-27 10:04): A and B and five more.
const SEVEN = [signerNodeA, signerNodeB, ...Array.from({ length: 5 }, () => schnorr.utils.randomSecretKey())];
const paying = (extra = {}, at = BigInt(NOW) - 1000n) => contractAt(at,
  { stakeMsat: 100000n, gameVerifySlots: 7, settlementSlots: 7, nodes: SEVEN.map(keyOf), ...extra });

/** A signer node's listing of one round, signed as the node signs it (or tampered after). */
function listing(secret, id, { phase = 'open', assignedHere = true, joined = 0, playing = 0, free = true, at = NOW, tamper = null } = {}) {
  const signed = { roundId: fromHex(id), nodePubkey: keyOf(secret), nowMs: BigInt(at), phase, assignedHere, joined, playing };
  const x = { id, phase, assignedHere, joined, playing, free, sig: toHex(schnorr.sign(lobbyListingId(signed), secret)) };
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

test('2 of 2: Join only where both of the round\'s signer nodes signed it open and joined; the contract\'s word for free, open and pending', async () => {
  const now = BigInt(NOW);
  const { contracts, id } = roundsOf({
    freeOpen: contractAt(now - 5000n),
    oneSignerNode: contractAt(now - 6000n),
    freePending: contractAt(now + 90000n),
    freeOver: contractAt(now - 400000n),
    payingOpen: paying({ custody: 'FEDERATION', federationId: TEST_FEDERATION_ID }, now - 8000n),   // seven signer nodes, A and B two of them
  });
  const forged = 'ee'.repeat(32);
  contracts[forged] = contracts[id.freeOpen];        // a listed id whose contract is another round's
  const net = network({
    contracts,
    nodes: {
      [A]: { secret: signerNodeA, rounds: [
        listing(signerNodeA, id.freeOpen, { joined: 2, playing: 1 }),
        listing(signerNodeA, id.oneSignerNode, { joined: 1 }),
        listing(signerNodeA, id.freePending, { phase: 'pending', assignedHere: false }),
        listing(signerNodeA, id.freeOver, { joined: 3, playing: 3 }),
        listing(signerNodeA, id.payingOpen, { free: true }),     // it says free; the contract stakes 100 sat
        listing(signerNodeA, forged, { joined: 9 }),
        { id: 'not-a-round', joined: 1 },
      ] },
      [B]: { secret: signerNodeB, rounds: [
        listing(signerNodeB, id.freeOpen, { joined: 2, playing: 2 }),
        listing(signerNodeB, id.payingOpen, { free: false }),
        listing(signerNodeB, id.freePending, { phase: 'pending', assignedHere: false }),
      ] },
    },
  });
  const { rows, refused } = await fetchLobby({ nodes: [A, B], fetcher: net.fetcher, nowMs: NOW, verify });
  const name = (r) => Object.keys(id).find((k) => id[k] === r.id) || r.id.slice(0, 8);
  const facts = {
    rows: rows.map(name),
    phases: rows.map((r) => r.phase),
    free: rows.map((r) => r.free),
    agree: rows.map((r) => `${r.signerNodesAgree}/${r.needed}`),
    joinable: rows.map((r) => r.joinable),
    disagrees: rows.map((r) => r.disagrees.length),
    refusedForged: refused.some((w) => w.startsWith(forged.slice(0, 16))),
    refusedJunk: refused.some((w) => /not a round id/.test(w)),
  };
  console.log('  FACTS (page lobby, 2-of-2):', JSON.stringify(facts));
  assert.deepEqual(facts, {
    // open before pending, soonest entry close first; freeOver is past its entry close
    rows: ['payingOpen', 'oneSignerNode', 'freeOpen', 'freePending'],
    phases: ['open', 'open', 'open', 'pending'],
    free: [false, true, true, true],
    agree: ['2/5', '1/2', '2/2', '0/2'],       // the paying round needs 5 of its 7; A and B are two
    joinable: [false, false, true, false],
    disagrees: [1, 0, 0, 0],
    refusedForged: true, refusedJunk: true,
  });
  const byName = Object.fromEntries(rows.map((r) => [name(r), r]));
  assert.deepEqual(byName.freeOpen.said.map((c) => `${c.joined}/${c.playing}`), ['2/1', '2/2'], 'both nodes\' counts are carried, each as that node\'s');
  const line = lobbyLine(byName.freeOpen, NOW);
  console.log(`  ${line}`);
  assert.match(line, /^free - no wallet, no Lightning · entry open, closes in 2:55 · 2 signer nodes agree \(2 needed\) · /);
  //: "N signer nodes agree (M needed)", never "7 of 5"
  assert.match(lobbyLine(byName.oneSignerNode, NOW), /1 signer node agrees \(2 needed\) - waiting for 1 more/);
  assert.match(lobbyLine(byName.payingOpen, NOW), /stake 100 sat - a federation stake lock .* listed it as free$/);
  // ITS FEDERATION AND LOAD (§23A.3): named beside the stake; the load once the page holds that federation's status
  const fid = Buffer.from(byName.payingOpen.contract.federationId).toString('hex');
  assert.match(lobbyLine(byName.payingOpen, NOW), new RegExp(`a federation stake lock in federation ${fid.slice(0, 8)} · `));
  assert.match(lobbyLine(byName.payingOpen, NOW, { loads: new Map([[fid, { load: 4.3333 }]]) }), new RegExp(`in federation ${fid.slice(0, 8)} \\(load 4\\.33\\) · `));
  assert.doesNotMatch(lobbyLine(byName.freeOpen, NOW, { loads: new Map([[fid, { load: 4.3333 }]]) }), /federation [0-9a-f]{8}/, 'a free row names no federation');
  // A ROUND IN A FEDERATION THAT IS NOT THE LOWEST-LOAD OPEN ONE says which is lower (§23A.3: "the client show why")
  const two = new Map([[fid, { federation: fid, status: 'OPEN', load: 0.93 }], ['bb'.repeat(32), { federation: 'bb'.repeat(32), status: 'OPEN', load: 0.4 }]]);
  assert.match(lobbyLine(byName.payingOpen, NOW, { loads: two }), /\(load 0\.93 - not the lowest-load federation: bbbbbbbb is at 0\.40\)/);
  const drained = new Map([[fid, { federation: fid, status: 'OPEN', load: 0.93 }], ['bb'.repeat(32), { federation: 'bb'.repeat(32), status: 'DRAINING', load: 0.1 }]]);
  assert.match(lobbyLine(byName.payingOpen, NOW, { loads: drained }), /\(load 0\.93\) · /, 'a draining one is no reason');
  assert.match(lobbyLine(byName.freePending, NOW), /committee: pending, entry opens in 1:30/);
});

test('what does not count toward 2 of 2: a node down, a stranger\'s key, one key twice, a tampered count, a stale listing', async () => {
  const c = contractAt(BigInt(NOW) - 1000n);
  const { contracts, id } = roundsOf({ r: c });
  const rid = id.r;
  const run = async (nodes, extraNodes = []) => (await fetchLobby({ nodes: [A, B, ...extraNodes], fetcher: network({ nodes, contracts }).fetcher, nowMs: NOW, verify }));
  const C = 'http://127.0.0.3:18583';
  const cases = {
    bothSignerNodes: await run({ [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, rid)] }, [B]: { secret: signerNodeB, rounds: [listing(signerNodeB, rid)] } }),
    nodeDown: await run({ [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, rid)] } }),
    stranger: await run({ [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, rid)] }, [B]: { secret: stranger, rounds: [listing(stranger, rid)] } }),
    oneKeyTwice: await run({ [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, rid)] }, [B]: { secret: signerNodeA, rounds: [listing(signerNodeA, rid)] } }),
    tampered: await run({ [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, rid)] }, [B]: { secret: signerNodeB, rounds: [listing(signerNodeB, rid, { assignedHere: false, tamper: { assignedHere: true } })] } }),
    stale: await run({ [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, rid)] }, [B]: { secret: signerNodeB, at: NOW - 120000, rounds: [listing(signerNodeB, rid, { at: NOW - 120000 })] } }),
    notAssigned: await run({ [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, rid)] }, [B]: { secret: signerNodeB, rounds: [listing(signerNodeB, rid, { assignedHere: false })] } }),
    thirdNodeIsAStranger: await run({ [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, rid)] }, [C]: { secret: stranger, rounds: [listing(stranger, rid)] } }, [C]),
  };
  const facts = Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, v.rows.length ? `${v.rows[0].signerNodesAgree}/${v.rows[0].needed} ${v.rows[0].joinable ? 'join' : 'no join'}` : 'no row']));
  console.log('  FACTS (what counts):', JSON.stringify(facts));
  assert.deepEqual(facts, {
    bothSignerNodes: '2/2 join', nodeDown: '1/2 no join', stranger: '1/2 no join', oneKeyTwice: '1/2 no join',
    tampered: '1/2 no join', stale: '1/2 no join', notAssigned: '1/2 no join', thirdNodeIsAStranger: '1/2 no join',
  });
  assert.match(cases.nodeDown.refused.join('; '), new RegExp(`${B.replace(/[.]/g, '\\.')}: answered 503`));
  await assert.rejects(fetchLobby({ nodes: [A, B], fetcher: network({ nodes: {}, contracts }).fetcher, nowMs: NOW }), /no verify was injected/);
});

test('only a listing that could count has its signature checked, once (kanban #573: 12,761 checks in 10 s with a game open)', async () => {
  const c = contractAt(BigInt(NOW) - 1000n);
  const { contracts, id } = roundsOf({ r: c });
  const rid = id.r;
  const C = 'http://127.0.0.3:18583';
  let checks = 0;
  const counting = (...a) => { checks++; return verify(...a); };
  const run = async (nodes, extraNodes = []) => (await fetchLobby({ nodes: [A, B, ...extraNodes], fetcher: network({ nodes, contracts }).fetcher, nowMs: NOW, verify: counting }));
  // both signer nodes and a third node that is no signer node of this round: 2 checks, the third's listing never checked
  checks = 0;
  const three = await run({ [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, rid)] }, [B]: { secret: signerNodeB, rounds: [listing(signerNodeB, rid)] },
    [C]: { secret: stranger, rounds: [listing(stranger, rid)] } }, [C]);
  assert.equal(`${three.rows[0].signerNodesAgree}/${three.rows[0].needed} ${three.rows[0].joinable ? 'join' : 'no join'}`, '2/2 join');
  assert.equal(checks, 2, 'the stranger\'s listing is not checked');
  // a signer node's listing that says it is not assigned there cannot count: not checked either
  checks = 0;
  const notAssigned = await run({ [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, rid)] }, [B]: { secret: signerNodeB, rounds: [listing(signerNodeB, rid, { assignedHere: false })] } });
  assert.equal(notAssigned.rows[0].signerNodesAgree, 1);
  assert.equal(checks, 1);
  // a forged listing that could count is still refused: its check runs and fails
  checks = 0;
  const tampered = await run({ [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, rid)] }, [B]: { secret: signerNodeB, rounds: [listing(signerNodeB, rid, { assignedHere: false, tamper: { assignedHere: true } })] } });
  assert.deepEqual([tampered.rows[0].signerNodesAgree, checks], [1, 2]);
});

test('verifyMany: the listings that could count checked in one batch, none by verify; a batch that fails leaves them to verify (kanban #573)', async () => {
  const c = contractAt(BigInt(NOW) - 1000n);
  const { contracts, id } = roundsOf({ r: c });
  const rid = id.r;
  const C = 'http://127.0.0.3:18583';
  const nodes = { [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, rid)] }, [B]: { secret: signerNodeB, rounds: [listing(signerNodeB, rid, { assignedHere: false, tamper: { assignedHere: true } })] },
    [C]: { secret: stranger, rounds: [listing(stranger, rid)] } };
  let single = 0; const batches = [];
  const one = (...a) => { single++; return verify(...a); };
  const many = async (list) => { batches.push(list.length); return list.map((a) => verify(a.sig, a.msg, a.key)); };
  const got = await fetchLobby({ nodes: [A, B, C], fetcher: network({ nodes, contracts }).fetcher, nowMs: NOW, verify: one, verifyMany: many });
  assert.deepEqual([batches, single], [[2], 0], 'one batch of the two signer nodes\' listings, nothing checked on the page');
  assert.equal(got.rows[0].signerNodesAgree, 1, 'the tampered listing still refused');
  single = 0;
  const broken = await fetchLobby({ nodes: [A, B, C], fetcher: network({ nodes, contracts }).fetcher, nowMs: NOW, verify: one, verifyMany: async () => { throw new Error('no worker'); } });
  assert.deepEqual([broken.rows[0].signerNodesAgree, single], [1, 2], 'checked by verify instead');
});

test('a silent signer node costs one limit, not the lobby: the other still lists, the silent one is named, no join (2026-09-17)', async () => {
  // MEASURED BEFORE, on the Daily with one tunnel silent: /rounds failed after 125.1 s and the next node's took 60 s, all while
  // the page sat on "Connecting …". The silent node here never answers at all.
  const { contracts, id } = roundsOf({ r: contractAt(BigInt(NOW) - 1000n) });
  const net = network({ nodes: { [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, id.r)] }, [B]: { secret: signerNodeB, rounds: [listing(signerNodeB, id.r)] } }, contracts });
  const silentB = (url, opts) => (url.startsWith(B) ? new Promise(() => {}) : net.fetcher(url, opts));
  const t0 = Date.now();
  const got = await fetchLobby({ nodes: [B, A], fetcher: silentB, nowMs: NOW, verify, answerMs: 1000 });
  const took = Date.now() - t0;
  console.log(`  silent B, limit 1 s: answered in ${took} ms; unanswered ${JSON.stringify(got.unanswered)}; refused ${JSON.stringify(got.refused)}`);
  assert.ok(took < 2500, `one limit, not two or a hang: ${took} ms`);
  assert.deepEqual(got.unanswered, [B]);
  assert.ok(got.refused.includes(`${B}: did not answer in 1 s`), 'the words the lobby shows name the node');
  assert.equal(got.rows.length, 1, 'the round the answering node lists is still a row');
  assert.equal(got.rows[0].joinable, false, 'no join while one of 2 is silent');
  assert.equal(got.rows[0].signerNodesAgree, 1);
  // both answering: nobody is named
  const both = await fetchLobby({ nodes: [A, B], fetcher: net.fetcher, nowMs: NOW, verify, answerMs: 1000 });
  assert.deepEqual(both.unanswered, []);
  assert.equal(both.rows[0].joinable, true);
  assert.equal(SIGNER_ANSWER_MS, 10000);
});

test('answerWithin refuses a read that has not answered in its limit, and aborts a fetch that honours the signal', async () => {
  let aborted = false;
  const hangs = (url, opts) => new Promise((_, reject) => { opts.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); });
  await assert.rejects(answerWithin(hangs, 200)('http://x/rounds'), (e) => e.silent === true && /did not answer in 200 ms/.test(e.message));
  assert.equal(aborted, true);
  const quick = answerWithin(async () => new Response('ok', { status: 200 }), 200);
  assert.equal((await quick('http://x/rounds')).status, 200);
});

test('a row names its joined players by the names they signed; a signer node\'s forgery and a record for another round are not shown', async () => {
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
  const forged = signed(signerNodeB, { playerPubkey: keyOf(player), name: 'Mallory', atMs: 9000n });
  const elsewhere = signed(player, { roundId: b32(0x77), playerPubkey: keyOf(player), name: 'Elsewhere', atMs: 9000n });
  const net = network({ contracts, nodes: {
    [A]: { secret: signerNodeA, rounds: [{ ...listing(signerNodeA, id.r, { joined: 2, playing: 2 }), names: [named, plain] }] },
    [B]: { secret: signerNodeB, rounds: [{ ...listing(signerNodeB, id.r, { joined: 2, playing: 2 }), names: [forged, elsewhere] }] },
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

test('the bare root\'s daily.json becomes exactly a lobby link\'s names, or no lobby at all', () => {
  const daily = { node: [A, B], bond: `${A}/bond`, advert: ADVERT };
  const search = dailyLobbySearch(daily);
  const named = lobbyQuery(search);
  assert.deepEqual(named.nodes, [A, B]);
  assert.equal(named.bond, `${A}/bond`);
  assert.deepEqual(named, lobbyQuery(LINK), 'daily.json names what the lobby link names');
  assert.equal(new URLSearchParams(lobbyJoinSearch(search, 'cd'.repeat(32)).slice(1)).get('node'), `${A},${B}`);
  // WHAT IS NO LOBBY: the root stays the offline daily.
  const refused = {
    oneSignerNode: { ...daily, node: [A] },
    notAUrl: { ...daily, node: ['not a url', B] },
    badAdvert: { ...daily, advert: 'ab' },
    noBond: { node: [A, B], advert: ADVERT },
    namesARound: { ...daily, round: 'cd'.repeat(32) },
    notAnObject: [A, B],
    nothing: null,
  };
  for (const [what, d] of Object.entries(refused)) assert.equal(dailyLobbySearch(d), null, what);
});

// ONE OF EACH (2026-09-15 16:08): the rows the live Daily's signer nodes held at 16:08 - two free
// and two paying, one pair a restart's leftover - and the rollover minute's overlap.
test('the lobby lists one free round and one paying round, never two of either, and the paying one says its stake', () => {
  const T = 1_000_000;
  const row = (id, free, left, more = {}) => ({ id, free, phase: 'open', joinable: true, entryCloseMs: T + left * 1000,
    stakeMsat: free ? 0n : 100000n, ...more });
  const at1608 = [row('892b28a0', true, 900), row('fe0a8c1f', false, 900), row('5a343b8d', true, 1140), row('eb1109af', false, 1140)];
  assert.deepEqual(lobbyOnePerKind(at1608).map((r) => r.id), ['5a343b8d', 'eb1109af'],
    'two of a kind listed, or not the one with the most entry left');
  // THE ROLLOVER MINUTE: the old round's last seconds beside the next one's full window.
  assert.deepEqual(lobbyOnePerKind([row('old', true, 40), row('next', true, 1000), row('pay', false, 500)]).map((r) => r.id), ['next', 'pay']);
  // A round nobody can join does not push out one they can; a pending one does not push out an open one.
  assert.deepEqual(lobbyOnePerKind([row('a', true, 30), row('b', true, 1000, { joinable: false })]).map((r) => r.id), ['a']);
  assert.deepEqual(lobbyOnePerKind([row('a', true, 30), row('b', true, 1000, { phase: 'pending' })]).map((r) => r.id), ['a']);
  // Only one kind open: only that one listed; nothing open: nothing listed.
  assert.deepEqual(lobbyOnePerKind([row('pay', false, 500)]).map((r) => r.id), ['pay']);
  assert.deepEqual(lobbyOnePerKind([]), []);
  // ONLY 90-SECOND PAID ROUNDS (2026-10-01): the core page lists no one-off paying round; a series one stays
  const oneOff = row('one-off', false, 21600);
  const seriesRow = row('series-0', false, 0, { contract: { seriesId: new Uint8Array(32), startTimeMs: BigInt(T), roundIndex: 0n } });
  assert.deepEqual(lobbyOnePerKind([row('free', true, 60), oneOff], T, { paidSeriesOnly: true }).map((r) => r.id), ['free'], 'a 6 h one-off paid row was listed');
  assert.deepEqual(lobbyOnePerKind([oneOff, seriesRow], T - 200000, { paidSeriesOnly: true }).map((r) => r.id), ['series-0']);
  assert.deepEqual(lobbyOnePerKind([oneOff], T).map((r) => r.id), ['one-off'], 'without the option nothing changes');
  const dayOut = row('8172fffd-0', false, 0, { joinable: false, phase: 'pending', contract: { seriesId: new Uint8Array(32), startTimeMs: BigInt(T + 67000000), roundIndex: 0n } });
  assert.deepEqual(lobbyOnePerKind([row('free', true, 60), dayOut], T, { paidSeriesOnly: true }).map((r) => r.id), ['free'], 'a series round nobody can join yet was a paid row');
  // WHAT A PAYING ROW COSTS, in whole sats: 100000 msat is 100 sat; a free row costs nothing.
  assert.equal(lobbyStakeSats(row('pay', false, 500)), 100);
  assert.equal(lobbyStakeSats(row('free', true, 500)), 0);
  assert.equal(lobbyStakeSats({ free: false, stakeMsat: 2_100_000_000_000_000_000n }), 2_100_000_000_000_000);
});

// THE LOBBY HAS ONE PAYING WORD (RULED 2026-09-24, the enum slice's fifth cut): a paying round's stake goes into a
// federation lock, as the node's own list says. "a Lightning payment" and the 'lightning' wallet were THRESHOLD_LN's
// hold invoice - no decodable round reached them, and they are not kept as a name for the withdrawn custody.

test('a paying row is only ever a federation stake lock, whatever its wallet field; the lobby source names no hold-invoice wallet', async () => {
  const { contracts, id } = roundsOf({ p: paying() });
  const net = network({ nodes: { [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, id.p, { free: false })] },
    [B]: { secret: signerNodeB, rounds: [listing(signerNodeB, id.p, { free: false })] } }, contracts });
  const { rows } = await fetchLobby({ nodes: [A, B], fetcher: net.fetcher, nowMs: NOW, verify });
  const lines = ['federation-lock', 'lightning', undefined].map((wallet) => lobbyLine({ ...rows[0], wallet }, NOW));
  const src = readFileSync(new URL('../src/lobby.js', import.meta.url), 'utf8');
  console.log('  FACTS:', JSON.stringify({ wallet: rows[0].wallet, lines: lines.map((l) => l.split(' · ')[0]),
    srcLightning: src.includes("'lightning'"), srcPayment: src.includes('a Lightning payment') }));
  assert.equal(rows[0].wallet, 'federation-lock');
  for (const l of lines) assert.match(l, /^stake 100 sat - a federation stake lock in federation [0-9a-f]{8} · /);
  assert.equal(src.includes("'lightning'"), false, 'the lobby still names a lightning wallet');
  assert.equal(src.includes('a Lightning payment'), false, 'the lobby still draws a Lightning payment');
});

// AND A STORED THRESHOLD_LN ROUND IS NO ROW (§23.6): even a node that lists its id and serves its bytes gets it only a
// line in the refusals - not a row, not a label, not a renamed hold.
test('a node that lists a custody-byte-0 round and serves its bytes gets no row for it; the lobby names it refused', async () => {
  const bytes = encodeRoundContract(contractAt(BigInt(NOW) - 1000n, { stakeMsat: 100000n }));
  const at = Buffer.from(bytes).toString('hex').indexOf(Buffer.from(TEST_FEDERATION_ID).toString('hex')) / 2 - 1;
  assert.equal(bytes[at], 1);
  const old = Uint8Array.from(bytes); old[at] = 0;
  const oldId = toHex(taggedHash(TAG.roundContract, old));
  const net = network({ nodes: { [A]: { secret: signerNodeA, rounds: [listing(signerNodeA, oldId, { free: false })] },
    [B]: { secret: signerNodeB, rounds: [listing(signerNodeB, oldId, { free: false })] } }, contracts: { [oldId]: old } });
  const got = await fetchLobby({ nodes: [A, B], fetcher: net.fetcher, nowMs: NOW, verify });
  console.log('  FACTS:', JSON.stringify({ rows: got.rows.length, refused: got.refused }));
  assert.equal(got.rows.length, 0, 'a byte-0 round became a row');
  assert.ok(got.refused.some((r) => r.startsWith(oldId.slice(0, 16)) && /custody byte 0 is not a custody of this network/.test(r)));
  assert.equal(got.refused.some((r) => r.includes('THRESHOLD_LN')), false);
});

// NO 2-OF-2 PAYING FEDERATION IS OFFERED (PRIORITIES item 5: "The UI offers no 2-of-2 paying federation"; one node is one
// guardian, and a paying round's committee is the federation's seven). A paying round whose committee is two signer
// nodes gets no row, however both sign it open - the lobby names it refused. The free 2-of-2 is untouched.
test('a paying round on a 2-of-2 committee is not offered: no row, named refused; the free 2-of-2 and a paying 5-of-7 are listed', async () => {
  const { contracts, id } = roundsOf({
    two: contractAt(BigInt(NOW) - 1000n, { stakeMsat: 100000n }),
    free: contractAt(BigInt(NOW) - 1000n, { slashMinimumServed: 21 }),
    seven: paying(),
  });
  const said = (k) => [listing(k, id.two, { free: false }), listing(k, id.free), listing(k, id.seven, { free: false })];
  const net = network({ nodes: { [A]: { secret: signerNodeA, rounds: said(signerNodeA) }, [B]: { secret: signerNodeB, rounds: said(signerNodeB) } }, contracts });
  const got = await fetchLobby({ nodes: [A, B], fetcher: net.fetcher, nowMs: NOW, verify });
  console.log('  FACTS:', JSON.stringify({ rows: got.rows.map((r) => ({ id: r.id.slice(0, 8), free: r.free, signerNodes: r.signerNodes, needed: r.needed })), refused: got.refused }));
  assert.equal(got.rows.some((r) => r.id === id.two), false, 'a 2-of-2 paying round was offered');
  assert.ok(got.refused.some((r) => r.startsWith(id.two.slice(0, 16)) && /2-of-2/.test(r)), 'the refusal names it');
  assert.ok(got.rows.some((r) => r.id === id.free && r.free && r.needed === 2), 'the free 2-of-2 is listed');
  const seven = got.rows.find((r) => r.id === id.seven);
  assert.ok(seven && !seven.free && seven.signerNodes === 7 && seven.needed === 5, 'the paying 5-of-7 is listed');
});

// THE NEWEST SERIES FIRST (2026-09-30): series 8172fffd, 100 sat a round, posted after series 3cfbe516 (10000 sat),
// shows its round - listed pending before its committee time - over an open, joinable round of the older series.
test('the newest series wins once it is active - its rows open - and the older series stands until then', () => {
  const now = 1790780000000;
  const mk = (id, seriesByte, seriesStartMs, i, stakeMsat, joinable, phase) => ({ id, free: false, joinable, phase,
    entryCloseMs: seriesStartMs + i * 90000, stakeMsat,
    contract: { seriesId: new Uint8Array(32).fill(seriesByte), roundIndex: i, startTimeMs: BigInt(seriesStartMs + i * 90000) } });
  const old = 1790711525000, next = 1791417600000;
  const rows = [mk('old-open', 0x3c, old, 780, 10000000n, true, 'open'), mk('new-0', 0x81, next, 0, 100000n, false, 'pending'),
    mk('new-1', 0x81, next, 1, 100000n, false, 'pending')];
  // UNTIL IT IS ACTIVE THE OLD SERIES STANDS (16:31): the new series' rounds pending, the joinable 10000 sat round is shown
  assert.deepEqual(lobbyOnePerKind(rows, now).map((r) => r.id), ['old-open'], 'a pending new series hid the old one');
  // ONCE ACTIVE, ITS ROUNDS ARE THE ONES: open rows of the newer series win over the older series' joinable one
  // OPEN BUT NOT YET ASSIGNED (committee time passed, start more than 2 h away): not active yet either
  const opened = rows.map((r) => (r.id.startsWith('new') ? { ...r, phase: 'open', joinable: false } : r));
  assert.deepEqual(lobbyOnePerKind(opened, now).map((r) => r.id), ['old-open'], 'an open, unassigned new series hid a joinable round');
  const active = rows.map((r) => (r.id.startsWith('new') ? { ...r, phase: 'open', joinable: true } : r));
  assert.deepEqual(lobbyOnePerKind(active, now).map((r) => r.id), ['new-0'], 'the 10000 sat round of the older series was shown');
});


// THE HAND-OVER BETWEEN TWO SERIES OF ONE STAKE (2026-09-30): at 2026-10-02 22:00Z series k=2's first round (start
// 2026-10-03 00:00Z) is joinable 2 h early; 8172fffd still starts a round every 90 s until 23:58:30Z - its soonest round
// is the row, not k=2's two hours out. And the newest series still decides the stake: 100 sat over 10000.
test('two series of one stake: the soonest joinable round wins, not the newer series 2 h out; the newest series sets the stake', () => {
  const S1 = Date.parse('2026-10-02T00:00:00Z'), S2 = Date.parse('2026-10-03T00:00:00Z'), now = Date.parse('2026-10-02T22:00:00Z');
  const mk = (id, byte, start, i, stakeMsat, joinable) => ({ id, free: false, joinable, phase: 'open', entryCloseMs: start + i * 90000, stakeMsat,
    contract: { seriesId: new Uint8Array(32).fill(byte), roundIndex: i, startTimeMs: BigInt(start + i * 90000) } });
  const rows = [mk('k1-881', 0x81, S1, 881, 100000n, true), mk('k1-882', 0x81, S1, 882, 100000n, true), mk('k2-0', 0x82, S2, 0, 100000n, true)];
  // 881 starts 22:01:30 - 90 s, exactly the join lead - and is the soonest with it left
  assert.deepEqual(lobbyOnePerKind(rows, now).map((r) => r.id), ['k1-881'], 'the newer series two hours out hid the running one');
  const old = mk('old-10k', 0x3c, Date.parse('2026-09-29T19:52:05Z'), 959, 10000000n, true);
  assert.deepEqual(lobbyOnePerKind([old, ...rows], now).map((r) => r.id), ['k1-881'], 'the 10000 sat round of the older series was shown');
  assert.deepEqual(lobbyOnePerKind([old, ...rows.map((r) => ({ ...r, joinable: false }))], now).map((r) => r.id), ['old-10k'],
    'before the 100 sat series can be joined, the old series stands');
});

// BOTH ROWS, ALWAYS (2026-10-01 15:25): a side whose nodes did not answer one paint keeps the rows it had while
// their entry is open; a side that answered keeps what it answered, rows or none; nothing past its entry close is kept.
test('a lobby read that got no answer keeps its last open rows; one that answered is taken as it is', () => {
  const now = 1790870000000;
  const free = { id: 'free-1', free: true, entryCloseMs: now + 40000 };
  const closed = { id: 'free-0', free: true, entryCloseMs: now - 1 };
  assert.deepEqual(lobbyKeepWhenUnanswered([free, closed], { rows: [], unanswered: ['https://a'], refused: [] }, now), [free]);
  assert.deepEqual(lobbyKeepWhenUnanswered([free], { rows: [], refused: ['fetch failed'], unanswered: [] }, now), [free]);
  assert.deepEqual(lobbyKeepWhenUnanswered([free], { rows: [], refused: [], unanswered: [] }, now), [], 'an answered empty list kept an old row');
  const fresh = { id: 'free-2', free: true, entryCloseMs: now + 90000 };
  assert.deepEqual(lobbyKeepWhenUnanswered([free], { rows: [fresh], unanswered: ['https://b'] }, now), [fresh]);
  assert.deepEqual(lobbyKeepWhenUnanswered(undefined, { rows: [], unanswered: ['x'] }, now), []);
  assert.deepEqual(lobbyKeepWhenUnanswered([free], { rows: [], refused: [], unanswered: [], pending: true }, now), [free], 'a side still in flight dropped its row');
});

// A ROUND JUST CLOSED THAT THE SEATS STILL LIST (2026-10-17: "When I reload the page my open orders are gone and
// still no closed orders"; "Have the open orders from the nodes"): no row - its entry is closed - but named among `closed` for 2 h,
// so the page reads a player's orders in it back from its seats and shows their results
test('a listed round whose entry closed 10 min ago is no row but is named closed; one closed 3 h ago is not', async () => {
  const closedAt = (msAgo) => BigInt(NOW) - BigInt(msAgo) - MIN_ENTRY_WINDOW_MS - 120000n;
  const { contracts, id } = roundsOf({ recent: paying({}, closedAt(600000)), old: paying({ slashMinimumServed: 21 }, closedAt(3 * 3600000)), open: paying({ slashMinimumServed: 22 }) });
  const said = (k) => [listing(k, id.recent, { free: false }), listing(k, id.old, { free: false }), listing(k, id.open, { free: false })];
  const net = network({ nodes: { [A]: { secret: signerNodeA, rounds: said(signerNodeA) }, [B]: { secret: signerNodeB, rounds: said(signerNodeB) } }, contracts });
  const got = await fetchLobby({ nodes: [A, B], fetcher: net.fetcher, nowMs: NOW, verify });
  assert.deepEqual(got.rows.map((r) => r.id), [id.open]);
  assert.deepEqual(got.closed.map((c) => c.id), [id.recent]);
  assert.equal(got.closed[0].entryCloseMs, NOW - 600000);
  assert.equal(toHex(roundId(got.closed[0].contract)), id.recent);
});

test('the settlement facts in plain words (kanban #821)', async () => {
  const { settledWords } = await import('../src/lobby.js');
  assert.equal(settledWords('signer nodes: 5 of 9 drawn (d5faf2aa, dc5194bb) · 1 operator (2of2abcd) · in both committees: 5 of 5 · no selected operator is playing · left out, protocol too old: 0656b934'), '5 nodes settle this round, all run by one operator');
  assert.equal(settledWords('signer nodes: 5 of 9 drawn (a) · 3 operators (x, y, z) · in both committees: 5 of 5 · no selected operator is playing'), '5 nodes settle this round');
  assert.equal(settledWords('selected nodes: 5 of 9 drawn (a) · 2 operators (x, y) · a selected operator is playing: x'), '5 nodes settle this round - one of their operators plays in it');
  assert.equal(settledWords('selected nodes: pending (§5A.5)'), 'The nodes that settle this round are not chosen yet');
  assert.equal(settledWords(''), '');
});
