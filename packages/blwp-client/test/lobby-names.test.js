// THE OTHER PLAYERS' NAMES, AS A PAGE MAKES AND CHECKS THEM (M3.3-34).
//
// A seated tab hands its seats one record, signed with the round key it is
// seated under: the name the player chose, or none. Another page shows a name
// only from a record that decodes, is for this round and verifies under the
// player key it names - the newest of each player's - so a seat can leave a
// name out but cannot write one, and no key is ever shown in place of a name.
//
// MEASURED BEFORE (TASKBOOK, M3.3-34), on the built page: tab 2 saved "Road Owl
// 42"; tab 1's seated view read "2 players in this round · other at -76,-78 m ·
// free seat" and the round's lobby row read only seat counts - fresh, after its
// repaint and after a reload - so the other player never saw the chosen name.
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { pageCurve } from '../src/page-curve.js';
import { nameRecordFor, namesOf, checkedNames, shownNameOf, boardNames, setPlayerName, tabIdentity, generatedName } from '../src/identity.js';
import { displayNameFromKey } from '../../protocol/src/display-name.js';
import { leaderboard } from '../../protocol/src/leaderboard.js';
import { resultId, encodePlayerResult, RESULT_BYTES, RESULTS_FOR_FINAL } from '../../protocol/src/result.js';
import { roundId } from '../../protocol/src/contracts.js';
import { DELIVERED } from '../../protocol/src/payout.js';
import { playerFor, tabSeed } from '../src/join.js';
import { playersLine } from '../src/ghost-field.js';
import { encodeLobbyName, decodeLobbyName, lobbyNameId } from '../../protocol/src/lobby-name.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const ROUND = { id: b32(0x5a) };
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
function tab() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

test('the name a tab hands its seats is the name it shows, signed with the round key it is seated under', () => {
  const storage = tab();
  assert.deepEqual(setPlayerName('Road Owl 42', { storage }), { ok: true, custom: true, name: 'Road Owl 42' });
  const signed = nameRecordFor(ROUND, { storage, random, curve: pageCurve, nowMs: 1789200000000 });
  const rec = decodeLobbyName(fromHex(signed.record));
  const player = playerFor(ROUND, { seed: tabSeed({ storage, random }), curve: pageCurve });
  const me = tabIdentity({ storage, random, curve: pageCurve });
  assert.equal(rec.name, 'Road Owl 42');
  assert.equal(rec.name, me.name, 'the others are shown what this tab shows itself');
  assert.equal(toHex(rec.roundId), toHex(ROUND.id));
  assert.equal(toHex(rec.playerPubkey), toHex(player.pubkey));
  assert.equal(toHex(rec.identityPubkey), me.pubkeyHex);
  assert.equal(rec.atMs, 1789200000000n);
  assert.equal(schnorr.verify(fromHex(signed.sig), lobbyNameId(rec), rec.playerPubkey), true);
  setPlayerName('', { storage });
  assert.equal(decodeLobbyName(fromHex(nameRecordFor(ROUND, { storage, random, curve: pageCurve }).record)).name, '',
    'no name chosen: the record carries none, and the others make the generated one from the identity key');
  assert.throws(() => nameRecordFor(ROUND, { storage, random, curve: { pointX: pageCurve.pointX } }), /no signer/);
});

test('the other page shows a name only from a record its player signed for this round - newest wins, never a key', async () => {
  const one = tab();
  setPlayerName('Road Owl 42', { storage: one });
  const first = nameRecordFor(ROUND, { storage: one, random, curve: pageCurve, nowMs: 1000 });
  setPlayerName('Night Hauler 7', { storage: one });
  const second = nameRecordFor(ROUND, { storage: one, random, curve: pageCurve, nowMs: 2000 });
  const oneRec = decodeLobbyName(fromHex(second.record));
  const two = tab();                                          // chose no name
  const plain = nameRecordFor(ROUND, { storage: two, random, curve: pageCurve, nowMs: 1500 });
  const plainRec = decodeLobbyName(fromHex(plain.record));
  // A SEAT'S FORGERY: player one's key named, newest of all, the seat's own signature.
  const forgedRec = { ...oneRec, name: 'Mallory', atMs: 9000n };
  const seat = schnorr.utils.randomSecretKey();
  const forged = { record: toHex(encodeLobbyName(forgedRec)), sig: toHex(schnorr.sign(lobbyNameId(forgedRec), seat)) };
  // AND PLAYER ONE'S OWN RECORD FOR ANOTHER ROUND, moved here.
  const elsewhere = nameRecordFor({ id: b32(0x77) }, { storage: one, random, curve: pageCurve, nowMs: 3000 });
  const byNode = { 'http://a': [first, forged, { record: 'zz', sig: '00' }], 'http://b': [second, plain, elsewhere] };
  const fetcher = async (url) => {
    const u = new URL(url);
    const list = byNode[`${u.protocol}//${u.host}`];
    if (u.pathname !== '/names' || !list || u.searchParams.get('round') !== toHex(ROUND.id)) return new Response('no', { status: 404 });
    return new Response(JSON.stringify({ names: list }), { status: 200 });
  };
  const names = await namesOf({ roundId: ROUND.id, nodes: ['http://a', 'http://b', 'http://down'], fetcher, verify });
  console.log('  FACTS (names the other page is shown):', JSON.stringify(names.map((n) => [n.name, n.chosen])));
  const byPlayer = Object.fromEntries(names.map((n) => [n.player, n]));
  assert.equal(names.length, 2);
  assert.deepEqual(byPlayer[toHex(oneRec.playerPubkey)], { player: toHex(oneRec.playerPubkey), name: 'Night Hauler 7', chosen: true });
  assert.deepEqual(byPlayer[toHex(plainRec.playerPubkey)],
    { player: toHex(plainRec.playerPubkey), name: generatedName(plainRec.identityPubkey), chosen: false });
  for (const n of names) {
    assert.doesNotMatch(n.name, /[0-9a-f]{8}/, 'a key in place of a name');
    assert.equal(n.name.includes(n.player.slice(0, 8)), false);
  }
  await assert.rejects(() => namesOf({ roundId: ROUND.id, nodes: ['http://a'], fetcher }), /no verify/);
  // NO SEAT ANSWERING IS NOT AN EMPTY ROUND: the page keeps what it had.
  await assert.rejects(() => namesOf({ roundId: ROUND.id, nodes: ['http://down', 'http://gone'], fetcher, verify }),
    /no seat answered for the names: http:\/\/down: 404; http:\/\/gone: 404/);
  const slow = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
  await assert.rejects(() => namesOf({ roundId: ROUND.id, nodes: ['http://a'], fetcher: slow, verify }), /http:\/\/a: no answer in time/);
});

test('the seated view names the others it holds a checked name for, and counts the rest', () => {
  assert.equal(playersLine({ seated: true, others: 1, names: ['Road Owl 42'] }), '2 players in this round: Road Owl 42');
  assert.equal(playersLine({ seated: true, others: 2, names: ['Road Owl 42'] }), '3 players in this round: Road Owl 42 +1 more');
  assert.equal(playersLine({ seated: true, others: 0, names: ['Road Owl 42'] }), '2 players in this round: Road Owl 42',
    'a seated player who has not driven yet is still in the round');
  assert.equal(playersLine({ seated: true, others: 1, names: ['Road Owl 42'], stake: { free: true } }),
    '2 players in this round: Road Owl 42 · free seat');
  assert.equal(playersLine({ seated: true, others: 1 }), '2 players in this round');
  assert.equal(playersLine({ seated: true, others: 0 }), '1 player · waiting');
});

test('one wordlist, one key: the generated name is display-name.js\'s from the identity key, the same in every round', () => {
  const k = random(32);
  assert.equal(generatedName(k), displayNameFromKey(k), 'a second wordlist names the player');
  const storage = tab();
  const me = tabIdentity({ storage, random, curve: pageCurve });
  assert.equal(me.generated, displayNameFromKey(me.pubkey));
  assert.match(me.generated, /^[a-z]+-[a-z]+-\d{4}$/);
  const inRound = (n) => decodeLobbyName(fromHex(nameRecordFor({ id: b32(n) }, { storage, random, curve: pageCurve }).record));
  const [r1, r2] = [inRound(1), inRound(2)];
  assert.notEqual(toHex(r1.playerPubkey), toHex(r2.playerPubkey), 'two rounds, two round keys');
  assert.equal(toHex(r1.identityPubkey), me.pubkeyHex);
  assert.equal(toHex(r2.identityPubkey), me.pubkeyHex);
  assert.deepEqual([shownNameOf(r1), shownNameOf(r2)], [me.generated, me.generated]);
  assert.notEqual(shownNameOf(r1), displayNameFromKey(r1.playerPubkey), 'the name is not the round key\'s');
});

test('the board, built by leaderboard.js from signed results, is drawn with each player\'s checked name; no name is on a result', () => {
  // A whole round contract, as leaderboard.test.js builds one: the board asks which round it is of.
  const COMMITTEE = [1, 2, 3, 4, 5, 6, 7].map((n) => b32(0xc0 + n));
  const contract = {
    networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6,
    gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1),
    startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
    custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [],
    donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
    bondMinSats: 50000n, blockTicks: 600, exposureReference: 1000,
    corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
    minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: COMMITTEE,
  };
  const rid = roundId(contract);
  const round = { ...contract, id: rid };
  const one = tab();
  setPlayerName('Night Hauler 7', { storage: one });
  const two = tab();                                          // chose no name
  const recOne = nameRecordFor(round, { storage: one, random, curve: pageCurve });
  const recTwo = nameRecordFor(round, { storage: two, random, curve: pageCurve });
  const keyOf = (s) => decodeLobbyName(fromHex(s.record)).playerPubkey;
  const names = checkedNames([recOne, recTwo], toHex(rid), verify);
  const resultFor = (playerPubkey, score) => ({ roundId: rid, playerPubkey, outcome: DELIVERED, score,
    transcriptHash: b32(3), simCoreHash: b32(4), nodePubkey: COMMITTEE[0] });
  const row = (playerPubkey, score) => {
    const result = resultFor(playerPubkey, score);
    const id = resultId(result);
    return { result, signedBy: COMMITTEE.slice(0, RESULTS_FOR_FINAL).map((nodePubkey) => ({ resultId: id, nodePubkey })) };
  };
  const board = leaderboard([row(keyOf(recOne), 500), row(keyOf(recTwo), 900), row(b32(0x44), 100)], { contract });
  assert.equal(board.ok, true, board.why);
  const drawn = boardNames(board.rows, names).map((x) => x.name);
  const twoMe = tabIdentity({ storage: two, random, curve: pageCurve });
  console.log('  FACTS (board, by rank):', JSON.stringify(drawn));
  assert.deepEqual(drawn, [twoMe.generated, 'Night Hauler 7', null], 'ranked 900, 500, 100; the last published no record');
  assert.equal(twoMe.generated, displayNameFromKey(twoMe.pubkey), 'the board\'s string is the lobby\'s');
  assert.notEqual(twoMe.generated, displayNameFromKey(keyOf(recTwo)), 'not the round key\'s');
  for (const r of board.rows)
    assert.deepEqual(Object.keys(r).sort(), ['outcome', 'playerPubkey', 'rank', 'score', 'signers'], 'the board grew a name column');
  // NO NAME REACHES A RESULT: a result is its fixed 168 bytes, and neither name is in them.
  for (const [pk, score] of [[keyOf(recOne), 500], [keyOf(recTwo), 900]]) {
    const bytes = Buffer.from(encodePlayerResult(resultFor(pk, score)));
    assert.equal(bytes.length, RESULT_BYTES);
    for (const name of ['Night Hauler 7', twoMe.generated]) assert.equal(bytes.indexOf(Buffer.from(name, 'utf8')), -1, name);
  }
});
