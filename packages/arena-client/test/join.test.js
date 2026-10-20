// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAGE CAN BE SENT TO A ROUND THAT ALREADY EXISTS.
//
// The shipped page refuses to invent `ARENA_ROUND` and that refusal is right.
// It also had no way to be GIVEN one, so two people could not join the same
// round from the daily however correct everything under it was. This is that
// way in, and it is the same family as `?practice=0`: the URL NAMES things -
// a round id, the daemons holding it, where headers and the bond are asked
// for - and nothing here mints any of them.
// A PAYING ROUND OPENS ONLY ON A SIGNER NODE THAT REACHES A FEDERATION (RULED 2026-09-25): this file's paying-round
// daemons get the lock fixture's port - the test federation, two gateways, zero base fee. Contracts unchanged.
import { lockPort, bondedChainSlot, bondedChainFor } from '../../arena-node/test/lock-fixture.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { test } from 'node:test';
// The run length is the core's; a literal 9000 is refused by the node as a contract
// disagreeing with the network it names (WAR_TACTICS moved a run to 10800).
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../arena-node/src/store.js';
import { serve } from '../../arena-node/src/server.js';
import { Client } from '../src/client.js';
import { joinQuery, joinFromQuery, fetchRound, forgetRounds, tabSeed, playerFor, entryFor, stakeFor, fetchSettlementSignerNodes, roundPays } from '../src/join.js';
import { playerSecretFor, refundFingerprint } from '../../arena-protocol/src/player-key.js';
import { coreHashHex } from '../../nextblock/tools/hash-core.js';
import { entryFeeMsat, feeMatchesEntry, NODE_FEE_BPS } from '../../arena-protocol/src/fee.js';
import { NO_SHARES } from '../../arena-protocol/src/handout.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from '../../arena-node/test/plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const CORE = fromHex(coreHashHex());
const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FUNDED = { funded: () => true };
// ON A CHAIN THAT BONDS THE ROUND'S TWO NODES (RULED 2026-09-25): one slot the round's daemons share, its beacon the
// chain's; a keyless committee member's claim key is claimKeyFor's. Only the round's censusRoot changes.
const onChain = (slot) => ({ ...FUNDED, stakeLocks: slot.port, chainFor: slot.chainFor, randomnessFor: slot.randomnessFor,
  claimKeyFor: () => new Uint8Array(33).fill(2) });
const bonded = (c, slot, daemons) => ({ ...c, censusRoot: bondedChainFor(c.nodes, c, slot,
  { endpoints: daemons.map((d) => `ws://127.0.0.1:${d.port}`) }).censusRoot });
const ADVERT = 'ab'.repeat(64);

const contractOn = (a, b, seed = 0x43) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  startTimeMs: 500n + MIN_ENTRY_WINDOW_MS, entryCloseMs: 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20 + (seed - 0x43),
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [a, b],
});

test('a page nobody sent anywhere is the single-player daily', () => {
  assert.equal(joinQuery(''), null);
  assert.equal(joinQuery('?practice=0'), null);
  assert.equal(joinQuery('?node=http://127.0.0.1:1&bond=http://127.0.0.1:2'), null,
    'a URL with no round still opened a session');
});

test('every way of naming a round badly is refused by name', () => {
  const why = (q) => { try { joinQuery(q); return 'accepted'; } catch (e) { return e.message; } };
  const id = 'aa'.repeat(32);
  assert.match(why('?round=nonsense'), /not a 32-byte id/);
  assert.match(why(`?round=${id}`), /no node holding it/);
  assert.match(why(`?round=${id}&node=not-a-url`), /not a node address/);
  assert.match(why(`?round=${id}&node=http://a.test&bond=http://b.test&advert=${ADVERT}`),
    /two independent sources/);
  assert.match(why(`?round=${id}&node=http://a.test,http://b.test&advert=${ADVERT}`),
    /nowhere to ask for the bond/);
  assert.match(why(`?round=${id}&node=http://a.test,http://b.test&bond=http://c.test`),
    /no signed advertisement/);
  assert.match(why(`?round=${id}&node=http://a.test,http://b.test&bond=http://c.test&advert=xy`),
    /64 signed bytes or a place/);
  const twoPaths = joinQuery(`?round=${id}&node=https://h.test/blwp-a,https://h.test/blwp-b`
    + `&bond=https://h.test/blwp-a/bond&advert=${ADVERT}`);
  assert.equal(twoPaths.nodes.length, 2);
});

test('two daemons hold the round, and the page joins the one the URL names', async () => {
  const slot = bondedChainSlot(lockPort());
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...onChain(slot) });
  const b = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...onChain(slot) });
  try {
    const contract = bonded(contractOn(a.round.pubkey, b.round.pubkey), slot, [a, b]);
    const client = new Client({ base: `http://127.0.0.1:${a.port}`, sign, verify });
    const rid = await client.openRound(contract);
    // the SAME round on the second daemon, which is what a 2-of-2 is
    await fetch(`http://127.0.0.1:${b.port}/round`,
      { method: 'POST', body: encodeRoundContract(contract) });

    const url = `?round=${toHex(rid)}`
      + `&node=http://127.0.0.1:${a.port},http://127.0.0.1:${b.port}`
      + `&bond=http://127.0.0.1:${a.port}/bond&advert=${ADVERT}`;
    const joined = await joinFromQuery(url);

    assert.ok(joined, 'the URL named a round and the page stayed single-player');
    assert.equal(toHex(roundId(joined.round)), toHex(rid),
      'the page joined a round that is not the one the URL named');
    // SORTED, because the encoding puts a committee in canonical order and
    // that is the round's own ordering, not the one an author typed.
    assert.deepEqual(joined.round.nodes.map(toHex).sort(), contract.nodes.map(toHex).sort(),
      'the committee the page carries is not the round\'s');
    assert.equal(joined.chain.headers.length, 2, 'a chain is read from two sources');
    assert.equal(new Set(joined.chain.headers.map((h) => h.tag)).size, 2,
      'two providers on one address are one source');
    assert.equal(joined.chain.bonds.length, 1);
    assert.equal(joined.advert.signedAdvert, ADVERT);
  } finally { await a.close(); await b.close(); }
});

test('a node answering with a different round is refused, not played', async () => {
  const slot = bondedChainSlot(lockPort());
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...onChain(slot) });
  try {
    const wanted = bonded(contractOn(a.round.pubkey, b32(9)), slot, [a]);
    const other = bonded(contractOn(a.round.pubkey, b32(9), 0x44), slot, [a]);
    const client = new Client({ base: `http://127.0.0.1:${a.port}`, sign, verify });
    const rid = await client.openRound(wanted);
    assert.notEqual(toHex(roundId(other)), toHex(rid), 'the two rounds are the same round');

    // A LIAR AND THEN THE TRUTH. The first node answers 200 with a perfectly
    // well-formed contract that is not the one asked for - a different config,
    // so a different stake and a different committee could ride in the same
    // way - and the second answers with the round itself.
    const swap = async (at) => (String(at).includes('liar')
      ? new Response(encodeRoundContract(other), { status: 200 })
      : fetch(at));
    const got = await fetchRound(toHex(rid), ['http://liar.test', `http://127.0.0.1:${a.port}`],
      { fetcher: swap });
    assert.equal(toHex(roundId(got.contract)), toHex(rid));
    assert.equal(got.from, `http://127.0.0.1:${a.port}`, 'the page took the substituted round');
    assert.match(got.refused[0], /answered with round/);

    // AND WITH NOBODY ELSE TO ASK, IT IS A REFUSAL AND NOT A GUESS (the contract read above is kept, so it is forgotten first).
    const again = await fetchRound(toHex(rid), ['http://liar.test'], { fetcher: swap });
    assert.equal(again.kept, true, 'a contract read once is kept: the liar is not even asked');
    assert.equal(toHex(roundId(again.contract)), toHex(rid));
    forgetRounds();
    await assert.rejects(
      fetchRound(toHex(rid), ['http://liar.test'], { fetcher: swap }),
      /no node holds the round this URL names/);
  } finally { await a.close(); }
});

test('two tabs are two players, and one tab is one player twice', () => {
  // sessionStorage is per tab, which is why the key lives there: two tabs are
  // two of these, and each keeps its own player across a reload.
  const tab = () => {
    const held = new Map();
    return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) };
  };
  let n = 0;
  const random = (len) => new Uint8Array(len).fill(++n);

  const one = tab(), two = tab();
  // THE TAB KEEPS A SEED (§24, v4.6.2, F2); each round's key comes from it.
  const round = { id: b32(0x0a) };
  const a = playerFor(round, { seed: tabSeed({ storage: one, random }), curve: feldmanGroup });
  const again = playerFor(round, { seed: tabSeed({ storage: one, random }), curve: feldmanGroup });
  const b = playerFor(round, { seed: tabSeed({ storage: two, random }), curve: feldmanGroup });

  assert.equal(toHex(a.pubkey), toHex(again.pubkey), 'a reload made the tab a different player');
  assert.equal(toHex(a.seed), toHex(again.seed), 'a reload drew a new seed');
  assert.notEqual(toHex(a.pubkey), toHex(b.pubkey), 'two tabs are the same player, so each drops the other');

  // AND IT IS A KEY ON THE CURVE, which is the whole point: a payout is an
  // output and an output pays to a key.
  assert.equal(a.pubkey.length, 32);
  assert.deepEqual(a.pubkey, schnorr.getPublicKey(a.secret));
  assert.notDeepEqual(a.pubkey, a.seed, 'the seed was handed out as the public key');

  // FRESH PER ROUND: the same seed, another round, another key - so two
  // rounds' locks do not link.
  const next = playerFor({ id: b32(0x0b) }, { seed: a.seed, curve: feldmanGroup });
  assert.notEqual(toHex(next.pubkey), toHex(a.pubkey), 'one key for two rounds');

  // A TAB CARRYING RUBBISH GETS A NEW SEED rather than an entry nobody can pay.
  const junk = tab(); junk.setItem('arena.player.seed', 'not-a-seed');
  assert.equal(tabSeed({ storage: junk, random }).length, 32);

  // AND A PAGE WITH NO CURVE IS REFUSED, rather than handed random bytes.
  assert.throws(() => playerFor(round, { seed: a.seed }), /a player identity is a key on a curve/);
});

/**
 * THE REFUND AND PAYOUT KEY IS THE SEED'S, AND THE PAGE WILL NOT ENTER ANOTHER
 * (§24, v4.6.2, F2). Before: `entryFor` took any 32 bytes as `playerPubkey` -
 * a key from one random secret per tab, never backed up, the same for every
 * round - and a stake dealt under any key. A payout and a refund go to that
 * key, and the player had nothing to check it against.
 */
// A PAYING ROUND NAMES ITS FEDERATION, AND ITS ENTRY ITS LOCK (RULED 2026-09-24, the enum slice's fifth cut): the
// three paying fixtures below used to be hold-shaped - a stake and no federation - and entryFor now refuses that shape.
// They keep measuring what they measured, on a real FEDERATION entry: page-lock.test's lock inputs, an attested claim key
// and a stake lock with a non-zero outpoint, paying to the dealt stake's point where one is dealt.
const lockedFor = (stakePoint = Uint8Array.of(2, ...b32(0x6c))) => ({
  claimKey: { ok: true, ref: b32(0x9a) },
  stakeLock: { outpoint: { txid: b32(0xd8), outIdx: 0 }, fields: { paymentImage: { kind: 'point', bytes: stakePoint } } },
});

test('a signer node carries the seed\'s key for the round, its fingerprint is the player\'s to check, and any other key is refused', async () => {
  const seed = b32(0x5e);
  const round = { id: b32(0x11), stakeMsat: 100000n, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: CORE, federationId: TEST_FEDERATION_ID };
  const random = (n) => new Uint8Array(n).fill(9);
  const player = playerFor(round, { seed, curve: feldmanGroup });

  // DERIVABLE WITHOUT THE PAGE: the rule is protocol's, the curve is BIP-340.
  assert.deepEqual(player.pubkey, schnorr.getPublicKey(playerSecretFor(seed, round.id)));
  assert.equal(player.fingerprint, refundFingerprint(player.pubkey));
  assert.match(player.fingerprint, /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);

  const signerNode = entryFor(round, { seed, curve: feldmanGroup, random, ...lockedFor() });
  assert.deepEqual(signerNode.playerPubkey, player.pubkey, 'the signer node is not the seed\'s key');
  assert.deepEqual(entryFor(round, { seed, curve: feldmanGroup, playerPubkey: player.pubkey, random, ...lockedFor() }).playerPubkey,
    player.pubkey);

  // ANOTHER KEY IS REFUSED: a stranger's, and this seed's key for another round.
  const otherRound = playerFor({ id: b32(0x12) }, { seed, curve: feldmanGroup }).pubkey;
  for (const wrong of [schnorr.getPublicKey(b32(0x77)), otherRound])
    assert.throws(() => entryFor(round, { seed, curve: feldmanGroup, playerPubkey: wrong, random }),
      /not the one this seed makes for this round/);

  // AND SO IS A STAKE DEALT UNDER ANOTHER KEY.
  const { randomBytes } = await import('node:crypto');
  const rand = (n) => new Uint8Array(randomBytes(n));
  const signerNodes = Array.from({ length: 7 }, () => schnorr.getPublicKey(rand(32)));
  const theirs = await stakeFor(round, { signerNodes, curve: feldmanGroup, random: rand, playerPubkey: otherRound });
  assert.throws(() => entryFor(round, { seed, curve: feldmanGroup, random, stake: theirs }),
    /dealt under another player key/);

  assert.throws(() => entryFor(round, { curve: feldmanGroup, random }), /32-byte seed/);
});

test('the signer node a page takes carries the round\'s own amounts', () => {
  const round = { id: b32(0x0c), stakeMsat: 100000n, blockTicks: BLOCK_TICKS, gameId: NEXTBLOCK_GAME_ID, simCoreHash: CORE, federationId: TEST_FEDERATION_ID };
  let n = 0;
  const random = (len) => new Uint8Array(len).fill(++n);
  const me = { seed: b32(5), curve: feldmanGroup };
  const signerNode = entryFor(round, { ...me, random, ...lockedFor() });

  assert.equal(signerNode.stakeMsat, 100000n, 'the page asked for a stake the round does not name');

  // THE FEE IS 2% OF THE ROUND'S OWN STAKE, and this line used to read
  // `feeMsat === 0n` with "M2 asks for no money" beside it. That was true of
  // M2 and the fixture below is a round that DOES ask for money, so the
  // assertion and its own setup disagreed. `feeMatchesEntry` is the rule -
  // too little and the round collects less than the fee table will owe its
  // nodes - and it had zero callers, so nothing noticed.
  //
  // M2's rounds are unchanged, and that is asserted rather than argued: 2% of
  // nothing is nothing, so a round that asks no stake still carries no fee and
  // there is no branch here to get wrong.
  assert.equal(signerNode.feeMsat, entryFeeMsat(100000n));
  assert.equal(signerNode.feeMsat, (100000n * BigInt(NODE_FEE_BPS)) / 10000n, 'a paying round is charged 5% of its stake (§0A.8)');
  assert.equal(feeMatchesEntry(signerNode).ok, true);
  const free = entryFor({ id: b32(0x0d), stakeMsat: 0n, blockTicks: BLOCK_TICKS }, { ...me, random });
  assert.equal(free.feeMsat, 0n, 'a round that asks no money is charged some');
  assert.equal(feeMatchesEntry(free).ok, true);

  assert.equal(signerNode.donationMsat, 0n);
  assert.equal(signerNode.joinTick, 0);
  assert.equal(signerNode.stakeCommitment.length, 32);
  assert.equal(signerNode.worldSecret.length, 32);
  assert.notEqual(toHex(signerNode.stakeCommitment), toHex(signerNode.worldSecret),
    'the commitment and the world secret are one value, so one leaks the other');

  assert.throws(() => entryFor(null, { ...me, random }), /no round/);
  assert.throws(() => entryFor(round, { seed: b32(5).slice(0, 8), curve: feldmanGroup, random }),
    /32-byte seed/);
});

// THE SHIPPING PAGE, READ AS A FILE.
//
// Every rule above is measured against real daemons, and none of it does
// anything unless the page actually calls it. That was the whole shape of the
// last fault in this letter: a class nothing constructed, green tests all
// around it. So the template is read here, the way the client bundle beside it
// already is.
test('the page joins a named round and still invents none', () => {
  // THE PAGE AS IT SHIPS: index.html and each game's page part it loads (packages/<game>/page/*-page.js, kanban #521)
  const games = new URL('../../', import.meta.url);
  const parts = readdirSync(games).flatMap((g) => { try { return readdirSync(new URL(`${g}/page/`, games)).filter((n) => /-page\.js$/.test(n)).map((n) => new URL(`${g}/page/${n}`, games)); } catch { return []; } });
  const page = [new URL('../../../src/arena-ui/index.html', import.meta.url), ...parts].map((u) => readFileSync(u.pathname, 'utf8')).join('\n');

  for (const call of ['joinFromQuery', 'entryFor', 'tabSeed', 'playerFor'])
    assert.ok(new RegExp('ARENACLIENT\\.' + call + '\\s*\\(').test(page),
      'the page never calls ' + call + ', so the round in the URL reaches nothing');

  for (const global of ['ARENA_ROUND', 'ARENA_CHAIN', 'ARENA_ADVERT', 'ARENA_ENTRY'])
    assert.ok(new RegExp('window\\.' + global + '\\s*=\\s*(named|ARENACLIENT)').test(page),
      global + ' is not filled from what the URL named');

  // AND IT WRITES NO CONTRACT. A page that carried its own fields could name
  // its own committee and then satisfy its own choice, which is the exact
  // substitution the round id exists to stop.
  // THE FIELDS ONLY A ROUND'S BUILDER WRITES never appear, and nothing encodes a contract: `stakeMsat` is an order's own
  // amount since (a pick record, an order message) and `committeeTimeMs` is read off fetched rounds to sort them - the
  // words alone no longer say a round is invented, so those two are checked as the page uses them: never encoded into a contract
  for (const field of ['censusRoot', 'simCoreHash', 'gameVerifySlots', 'blockTicks'])
    assert.ok(!page.includes(field),
      'the page writes ' + field + ', so it is inventing a round rather than joining one');
  for (const builder of ['encodeRoundContract', 'openGrid', 'standUpRound', 'roundContractFields'])
    assert.ok(!page.includes(builder), 'the page calls ' + builder + ', so it is inventing a round rather than joining one');
  assert.ok(!/committeeTimeMs\s*:/.test(page), 'the page sets a committee time, so it is inventing a round rather than joining one');

  // THE SESSION KEY IS PER TAB. localStorage would make two tabs one player,
  // and a player's own ghost is dropped - so the two tabs would show each
  // other nothing.
  assert.ok(page.includes('sessionStorage'), 'the page has no per-tab identity');
  // localStorage FOR A KEPT ROUND'S MONEY (2026-09-14, spec §24), in vault(), AND FOR THE KEPT PHRASES (the owner
  // 2026-10-01: "safe even if the user closes the browser and loads it again"), in arenaSeedKeeper - which hands a tab
  // only a phrase no open tab holds, so two tabs stay two players (seed-keeper.test.js). Named twice, nowhere else.
  // AND THE BROWSER'S OWN STORE (PAID-NIGHT-2155): the client log, the console's verbose switch and the one-paid-run
  // heartbeat - named once, in ARENA_BROWSER_STORE, holding no player and no money.
  // (The one-time blwp.* to arena.* movenames it once more before all of these: storage-move.test.js.)
  const pageAfterMove = page.replace(/<script id="arena-storage-move">[\s\S]*?<\/script>/, '');
  assert.equal((pageAfterMove.match(/localStorage/g) || []).length, 3, 'the page names localStorage outside vault(), the seed keeper and ARENA_BROWSER_STORE (every preference, cache and connection goes through that door)');
  // THE ONE DOOR, FROM THE FIRST PAINT ON: defined in the first-paint script, so even the splash's game-name lookup uses it
  assert.match(page, /window\.ARENA_BROWSER_STORE = function \(\) \{ try \{ return window\.localStorage; \}/, 'the browser\'s own store is not the one named helper');
  assert.match(page, /const browserStore = window\.ARENA_BROWSER_STORE;/, 'the console\'s store is not that helper');
  assert.match(page, /window\.ARENA_SEED_KEEPER = arenaSeedKeeper\(\{ L: window\.localStorage, T: window\.sessionStorage,/, 'the phrases are not kept by arenaSeedKeeper');
  assert.match(page, /function vault\(\) \{\n\s+try \{ const s = window\.localStorage;/, 'localStorage is not the kept rounds\' vault()');
  for (const call of ['tabSeed', 'seedOrigin', 'importSeed', 'tabIdentity', 'setPlayerName', 'nameRecordFor'])
    assert.ok(!new RegExp(`${call}\\([^)]*vault\\(\\)`).test(page), `the page keeps the player (${call}) in storage every tab shares`);
  assert.ok(page.includes('id="arena-players"'),
    'the page has no on-screen count of who is in the round');
  assert.ok(page.includes('probeNodes'),
    'the page never checks whether both nodes answer');
  assert.ok(page.includes('playLine'),
    'the page never says whether the play socket is up');
  assert.ok(page.includes('ARENA_CURVE.verify'),
    'the page still verifies node adverts with Ed25519');

  // AND THE PAGE DEALS ITS OWN STAKE (letter 15).
  //
  // Measured before this: `entryFor` was called with NO stake, so every signer node
  // the shipped page took carried `random(32)` where `sha256(P)` belongs and
  // 32 zero bytes where the shares belong - and `stakeFor` was compiled into
  // the bundle with ZERO CALLERS. The daemon accepts those zeros on purpose
  // for M2, so nothing refused and nothing said anything.
  assert.ok(page.includes('ARENACLIENT.stakeFor('),
    'the page joins without dealing a stake');
  assert.ok(page.includes('fetchSettlementSignerNodes'),
    'the page deals a stake without asking who settles the round');
  assert.ok(!/stakeFor\(\s*named\.round\b/.test(page),
    'the page deals to the contract\'s flat node list, which is the union of the committees');
  // THE HANDOUT IS PUBLISHED, AND THE COUNT IS ACTED ON. This pinned the
  // string "/handout" in the page, which only proved a URL was written down.
  // The posting and the five-signer node threshold are `postHandout` now - a handout
  // three of seven signer nodes hold is a stake nobody can open - so what is pinned
  // is the call and the branch that refuses on it.
  assert.match(page, /ARENACLIENT\.postHandout\(/,
    'the page deals a handout and never posts it, so no signer node can accept it');
  assert.match(page, /if \(!put\.ok\)/,
    'the page publishes the handout and ignores how many signer nodes took it');
  assert.ok(page.includes('ARENA_JOIN_REFUSED'),
    'a paying round whose committee cannot be learned is still joined silently');
  // THE SIGNER NODE'S FUNDING REACHES THE SCREEN, and this pin was weaker when it was
  // written: it asserted the page contained the words "THE STAKE IS NOT PAID",
  // which is a CONSTANT - the page asserting a funding state it never measured.
  // The signer nodes count the stake lock they verified, so what is pinned now is
  // that the page hands the chip their count and the refusal, and that
  // `playersLine` is what turns them into a line. Stronger, not looser:
  // `page-stake.test.js` drives the wording itself.
  assert.match(page, /joinRefused,\s*stake/,
    'the chip is never told why there is no signer node or what it cost');
  assert.ok(!page.includes('THE STAKE IS NOT PAID'),
    'the page asserts a funding state it did not measure');

  // AND IT STILL NAMES NO CONTRACT FIELD. Knowing whether a round asks for
  // money is a rule, so it lives in the client where a test can drive it - the
  // page asks `roundPays` rather than reading `stakeMsat` off the contract,
  // which is the same discipline the loop above enforces.
  assert.ok(page.includes('ARENACLIENT.roundPays('),
    'the page decides for itself whether a round pays');
});

test('whether a round pays is one rule, and it is not in the page', () => {
  assert.equal(roundPays({ stakeMsat: 100000n }), true);
  assert.equal(roundPays({ stakeMsat: 0n }), false);
  assert.equal(roundPays({}), false, 'a round with no stake field is not a paying round');
  assert.equal(roundPays(null), false);
});

/**
 * WHO A STAKE IS DEALT TO, AND WHY IT IS NOT THE LIST THE PAGE ALREADY HOLDS.
 *
 * MEASURED on nine bonded nodes with seven game/verify slots and seven
 * settlement slots: the game committee is 7, the settlement committee is 7,
 * and `contract.nodes` - what `joinFromQuery` hands the page - is the UNION at
 * 9, with 5 in both and 2 settlement-only. `Roster.signerNodesFor` says so itself.
 * Dealing to the flat list would seal nine shares for a five-of-seven scheme,
 * two of them to signer nodes that could never open one, and a stake nobody can open
 * at payout is worse than one never dealt.
 */
test('the settlement signer nodes are asked of every node, and a disagreement is refused', async () => {
  const b32 = (n) => new Uint8Array(32).fill(n);
  const committee = (keys) => ({
    ok: true, status: 200,
    arrayBuffer: async () => {
      const out = new Uint8Array(keys.length * 32);
      keys.forEach((k, i) => out.set(k, i * 32));
      return out.buffer;
    },
    text: async () => '',
  });
  const signerNodes = [b32(1), b32(2), b32(3), b32(4), b32(5), b32(6), b32(7)];

  // EVERY NODE IS ASKED, and the ORDER they list them in is not a difference:
  // one committee written two ways is one committee.
  const asked = [];
  const got = await fetchSettlementSignerNodes('ab'.repeat(32), ['http://a', 'http://b/'], {
    fetcher: async (u) => { asked.push(u); return committee(u.startsWith('http://a') ? signerNodes : [...signerNodes].reverse()); },
  });
  assert.equal(got.signerNodes.length, 7);
  assert.equal(got.agreed, 2);
  assert.equal(asked.length, 2, 'the page asked one node and took its word');
  for (const u of asked) assert.match(u, /\/committee\?role=settlement&round=/);

  // A DISAGREEMENT IS A REFUSAL. One node's answer about who may open a
  // player's stake is one node choosing who may open it.
  await assert.rejects(() => fetchSettlementSignerNodes('ab'.repeat(32), ['http://a', 'http://b'], {
    fetcher: async (u) => committee(u.startsWith('http://a') ? signerNodes : [...signerNodes.slice(0, 6), b32(9)]),
  }), /two different settlement committees/);

  // And a round nobody will answer for is a refusal too, with the reasons.
  await assert.rejects(() => fetchSettlementSignerNodes('ab'.repeat(32), ['http://a'], {
    fetcher: async () => ({ ok: false, status: 409, text: async () => 'that round is not assigned' }),
  }), /named no round's settlement committee|no node named this round/);
  await assert.rejects(() => fetchSettlementSignerNodes('ab'.repeat(32), []), /no node to ask/);
});

/**
 * THE PAGE AS DEALER (23.1 steps 1 and 2).
 *
 * Measured before this existed: `entryFor` set `stakeCommitment: random(32)` -
 * a commitment to nothing - and `vssSharesRef: NO_SHARES`, so there was no
 * preimage in the system at all and nothing for a committee to reconstruct.
 *
 * The curve is injected here the same way `sign` is, because this bundle
 * carries no crypto: a vendored curve in the page is an implementation of the
 * thing that pins money that nobody audits.
 */
test('a page deals its own stake: the commitment is a hash and the ref is a handout', async () => {
  const { feldmanGroup } = await import('../../arena-node/src/curve.js');
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const { sha256 } = await import('../../arena-protocol/src/hash.js');
  const { handoutId, decodeHandout, openMyShare } = await import('../../arena-protocol/src/handout.js');
  const { randomBytes } = await import('node:crypto');
  const rand = (n) => new Uint8Array(randomBytes(n));

  const secrets = Array.from({ length: 7 }, () => rand(32));
  const signerNodes = secrets.map((s) => schnorr.getPublicKey(s));
  const round = { id: b32(0x11), stakeMsat: 100000n, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: CORE, federationId: TEST_FEDERATION_ID };

  const me = { seed: b32(5), curve: feldmanGroup };
  const stake = await stakeFor(round, {
    signerNodes, curve: feldmanGroup, random: rand, playerPubkey: playerFor(round, me).pubkey,
  });

  // THE COMMITMENT IS A HASH OF SOMETHING, which is what a hold invoice needs
  // and what `random(32)` never was.
  assert.deepEqual(stake.stakeCommitment, sha256(stake.preimage));
  assert.equal(stake.preimage.length, 32);
  assert.deepEqual(stake.vssSharesRef, handoutId(stake.handout));
  assert.notDeepEqual(stake.vssSharesRef, NO_SHARES);

  // AND EVERY SIGNER NODE CAN OPEN ITS OWN, which is what makes the reference worth
  // naming. A handout no signer node accepts is a reference an entry cannot use.
  const back = decodeHandout(stake.body);
  assert.equal(back.shares.length, 7);
  let opened = 0;
  for (let i = 0; i < signerNodes.length; i++) {
    const mine = await openMyShare(back, {
      pubkey: signerNodes[i], secret: secrets[i], curve: feldmanGroup,
    });
    if (mine.ok) opened++;
  }
  assert.equal(opened, 7, 'the page dealt shares its own committee cannot open');

  // AND THE ENTRY CARRIES IT. Without a dealt stake the signer node is still the M2
  // one: a commitment to nothing, and no shares.
  const signerNode = entryFor(round, { ...me, random: rand, stake, ...lockedFor(stake.stakePoint) });
  assert.deepEqual(signerNode.stakeCommitment, stake.stakeCommitment);
  assert.deepEqual(signerNode.vssSharesRef, stake.vssSharesRef);
  const plain = entryFor(round, { ...me, random: rand, ...lockedFor() });
  assert.deepEqual(plain.vssSharesRef, NO_SHARES);
});

test('a page refuses to deal without a curve, a committee, or a player', async () => {
  const { feldmanGroup } = await import('../../arena-node/src/curve.js');
  const { randomBytes } = await import('node:crypto');
  const rand = (n) => new Uint8Array(randomBytes(n));
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const signerNodes = Array.from({ length: 7 }, () => schnorr.getPublicKey(rand(32)));
  const round = { id: b32(0x11), stakeMsat: 100000n, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: CORE };

  await assert.rejects(() => stakeFor(round, { signerNodes, random: rand, playerPubkey: b32(5) }),
    /needs a curve, and none was injected/);
  await assert.rejects(() => stakeFor(round, { signerNodes: signerNodes.slice(0, 3), curve: feldmanGroup, random: rand, playerPubkey: b32(5) }),
    /cannot be dealt to 3 signer nodes/);
  await assert.rejects(() => stakeFor(round, { signerNodes, curve: feldmanGroup, random: rand }),
    /that is 32 bytes of key/);
  await assert.rejects(() => stakeFor(null, { signerNodes, curve: feldmanGroup, random: rand, playerPubkey: b32(5) }),
    /that is not one/);
});

// THE FEE LOCK AN ENTRY NAMES (plan comment 298, Go 2026-10-05): join.js feeLockOf, through entryFor. A
// stake lock's fee lock must hand over its F (32 bytes, not zeros), be locked to H(F), and hold exactly the entry's fee -
// else the entry is not built (a fee lock the signer node would refuse, or a fee nobody can claim). A good one is named in
// the entry by its F and outpoint; no fee lock writes zeros.
test('feeLockOf through entryFor: no F, not H(F), the wrong amount refused by name; a good fee lock named; none writes zeros', async () => {
  const { federationStakeFor } = await import('../src/client.js');
  const { entryFor: build } = await import('../src/join.js');
  const { entryFeeMsat } = await import('../../arena-protocol/src/fee.js');
  const { TEST_FEDERATION_ID } = await import('../../arena-protocol/src/test-federation.js');
  const { toHex: hx, fromHex: fh, sha256 } = await import('../../arena-protocol/src/hash.js');
  const { coreHashHex } = await import('../../nextblock/tools/hash-core.js');
  const { feldmanGroup } = await import('../../arena-node/src/curve.js');
  const round = { id: new Uint8Array(32).fill(7), stakeMsat: 1000000n, gameId: NEXTBLOCK_GAME_ID, simCoreHash: fh(coreHashHex()), federationId: TEST_FEDERATION_ID };
  const NET = round.stakeMsat - entryFeeMsat(round.stakeMsat);
  const fetcher = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ paymentHash: 'aa'.repeat(32), amountMsat: String(NET), request: 'lnbcrt-fed' }) });
  const stake = await federationStakeFor(round, { nodes: ['http://a'], fetcher });
  const F = new Uint8Array(32).fill(0x4f);
  const feeLock = (more = {}) => ({ preimage: F, outpoint: { txid: new Uint8Array(32).fill(0xfe), outIdx: 1n },
    fields: { paymentImage: { kind: 'hash', bytes: sha256(F) }, amountMsat: entryFeeMsat(round.stakeMsat) }, ...more });
  const entry = (fee) => build(round, { seed: new Uint8Array(32).fill(5), curve: feldmanGroup, random: (n) => new Uint8Array(n).fill(9), stake,
    claimKey: { ok: true, ref: new Uint8Array(32).fill(0x9a) },
    stakeLock: { outpoint: { txid: new Uint8Array(32).fill(0xd8), outIdx: 0 }, fields: { paymentImage: { kind: 'point', bytes: Uint8Array.of(2, ...new Uint8Array(32).fill(0x6c)) } },
      ...(fee === undefined ? {} : { feeLock: fee }) } });
  // no F
  for (const preimage of [undefined, new Uint8Array(31).fill(1), new Uint8Array(32), 'not bytes'])
    assert.throws(() => entry(feeLock({ preimage })), /^Error: that fee lock hands over no F, so it could never be claimed$/, String(preimage && preimage.length));
  // not H(F)
  const other = new Uint8Array(32).fill(0x50);
  for (const fields of [{ paymentImage: { kind: 'hash', bytes: sha256(other) }, amountMsat: entryFeeMsat(round.stakeMsat) },
    { paymentImage: { kind: 'point', bytes: sha256(F) }, amountMsat: entryFeeMsat(round.stakeMsat) }, { amountMsat: entryFeeMsat(round.stakeMsat) }, undefined])
    assert.throws(() => entry(feeLock({ fields })), /^Error: that fee lock is not locked to H\(F\) of the F it hands over$/);
  // the wrong amount
  const want = entryFeeMsat(round.stakeMsat);
  for (const amountMsat of [want - 1n, want + 1n, 0n])
    assert.throws(() => entry(feeLock({ fields: { paymentImage: { kind: 'hash', bytes: sha256(F) }, amountMsat } })),
      new RegExp(`^Error: that fee lock holds ${amountMsat} msat and the entry's fee is ${want}$`));
  // good: named in the entry by its F and its outpoint
  const good = entry(feeLock());
  assert.equal(hx(good.feePreimage), hx(F));
  assert.deepEqual([hx(good.feeLockOutpoint.txid), BigInt(good.feeLockOutpoint.outIdx)], ['fe'.repeat(32), 1n]);
  // none: zeros
  const none = entry(undefined);
  assert.equal(hx(none.feePreimage), '00'.repeat(32));
  assert.equal(hx(none.feeLockOutpoint.txid), '00'.repeat(32));
});
