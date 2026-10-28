// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EACH NODE CHOOSES WHICH GAMES IT HOSTS - THE CENSUS HALF (§0A.4, comment 756): the game/verify committee of
// a round is drawn only from census nodes whose advertisement hosts the round's game; settlement is drawn from the whole
// census; the census minimum for game/verify counts only hosting nodes; and a change of the hosted list is an
// advertisement update, which spends no bond.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { selectCommittee } from '../src/sortition.js';
import { meetsCensusMinimum, leafHash } from '../src/census.js';
import { encodeAdvert, decodeAdvert, advertId, hostsGame } from '../src/advert.js';
import { acceptAdvertUpdate, newestUpdates } from '../src/advert-update.js';
import { parseTransaction } from '../src/tx.js';
import { advertUpdateTransaction, bondTransaction } from '../tools/bond.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { taggedHash, toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NEXTBLOCK = b32(0x6e);          // two game ids; the census reads ids, never a game's code
const TALLY = b32(0x74);
const RARE = b32(0x72);               // a game one node hosts
const entry = (i, hostedGames) => ({ txid: b32(0x10 + i), vout: 0, pubkey: b32(0x80 + i), bondSats: 100000n, height: 100,
  roles: ['game', 'verify', 'settlement'], hostedGames });
const CENSUS = [0, 1, 2].map((i) => entry(i, [NEXTBLOCK])).concat([3, 4, 5].map((i) => entry(i, [TALLY])));
const hostsOf = (game) => CENSUS.filter((e) => hostsGame(e, game)).map((e) => toHex(e.pubkey)).sort();
const roundOf = (gameId) => ({ networkId: NETWORK_ID_REGTEST, gameId, gameVerifySlots: 2, settlementSlots: 2, bondMinSats: 100000n });
const seed = (i) => taggedHash('hosted-games-seed', Uint8Array.of(i & 255, i >> 8));

test('a nextblock round\'s game/verify committee is drawn only from the 3 nextblock hosts, its settlement from all 6, over 300 seeds', () => {
  const gameSeen = new Set(), settleSeen = new Set();
  for (let i = 0; i < 300; i++) {
    for (const e of selectCommittee({ entries: CENSUS, contract: roundOf(NEXTBLOCK), role: 'game', committeeSeed: seed(i) })) gameSeen.add(toHex(e.pubkey));
    for (const e of selectCommittee({ entries: CENSUS, contract: roundOf(NEXTBLOCK), role: 'settlement', committeeSeed: seed(i) })) settleSeen.add(toHex(e.pubkey));
  }
  console.log(`  FACTS (draw): game/verify drew ${gameSeen.size} distinct nodes (nextblock hosts ${hostsOf(NEXTBLOCK).length}), settlement drew ${settleSeen.size} of ${CENSUS.length}`);
  assert.deepEqual([...gameSeen].sort(), hostsOf(NEXTBLOCK), 'game/verify drew a node that does not host nextblock, or missed one that does');
  assert.equal(settleSeen.size, CENSUS.length, 'settlement was not drawn from the whole census');
  // and a tally round's game/verify committee from the tally hosts only
  const tallySeen = new Set();
  for (let i = 0; i < 300; i++) for (const e of selectCommittee({ entries: CENSUS, contract: roundOf(TALLY), role: 'verify', committeeSeed: seed(i) })) tallySeen.add(toHex(e.pubkey));
  assert.deepEqual([...tallySeen].sort(), hostsOf(TALLY));
});

test('the hosting minimum: a game hosted by fewer nodes than the network needs has no committee, and the reason names the count', () => {
  const census = [...CENSUS, entry(6, [RARE])];
  const got = meetsCensusMinimum(census, roundOf(RARE), 'game');
  assert.equal(got.ok, false);
  assert.equal(got.have, 1);
  assert.match(got.why, /^that census carries 1 game node where regtest was born needing 2, counting only the nodes that host game 7272727272727272 \(§0A\.4\): no round of it is drawn$/);
  assert.throws(() => selectCommittee({ entries: census, contract: roundOf(RARE), role: 'game', committeeSeed: seed(1) }), /counting only the nodes that host game 7272727272727272/);
  // the settlement pool is game-agnostic: the same census holds a settlement committee for that round
  assert.equal(meetsCensusMinimum(census, roundOf(RARE), 'settlement').ok, true);
  assert.equal(meetsCensusMinimum(CENSUS, roundOf(NEXTBLOCK), 'game').have, 3);
});

test('the census root commits to each node\'s hosted games: the same entry hosting another game is another leaf', () => {
  assert.notEqual(toHex(leafHash(entry(0, [NEXTBLOCK]))), toHex(leafHash(entry(0, [TALLY]))));
  assert.throws(() => leafHash({ ...entry(0, [NEXTBLOCK]), hostedGames: undefined }), /names the games its node hosts/);
});

// THE ADVERTISEMENT: hosted_games in the signed body, sorted, and a change of it an update that spends no bond
const SECRET = b32(0x41);
const NODE = schnorr.getPublicKey(SECRET);
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const advert = (hostedGames, timestamp) => ({
  nodePubkey: NODE, operatorId: 'hosts', protocolVersions: [1], hostedGames, roles: ['game', 'verify', 'settlement'],
  endpoint: 'wss://node.example/', region: 'eu-west', capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0,
  lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3),
  guardianOf: [], guardianCapable: false, guardianEndpoint: '', timestamp,
});
const signed = (a) => schnorr.sign(advertId(a), SECRET);

test('hosted_games is in the signed advertisement, sorted and once each; [] hosts none and nothing is implied', () => {
  const a = advert([NEXTBLOCK, TALLY], 1n);
  assert.deepEqual(decodeAdvert(encodeAdvert(a)).hostedGames.map(toHex), [toHex(NEXTBLOCK), toHex(TALLY)]);
  assert.notEqual(toHex(advertId(a)), toHex(advertId(advert([NEXTBLOCK], 1n))), 'the hosted list is not in the signed body');
  assert.throws(() => encodeAdvert(advert([TALLY, NEXTBLOCK], 1n)), /not sorted or names a game twice/);
  assert.throws(() => encodeAdvert(advert([TALLY, TALLY], 1n)), /not sorted or names a game twice/);
  assert.throws(() => encodeAdvert({ ...advert([], 1n), hostedGames: undefined }), /names the games its node hosts/);
  assert.deepEqual(decodeAdvert(encodeAdvert(advert([], 1n))).hostedGames, []);
});

test('an advertisement update that only changes the hosted list is accepted, spends no bond, and is the advertisement the census reads', async () => {
  const first = advert([NEXTBLOCK], 1788700000000n);
  const BOND_TX = bondTransaction(first, { value: 50000, signature: signed(first) });
  const bondTxid = parseTransaction(BOND_TX).txid;
  const BOND = { txid: bondTxid, vout: 0, nodePubkey: NODE };
  const changed = { ...first, hostedGames: [NEXTBLOCK, TALLY], timestamp: 1790000000000n };
  const UPDATE = advertUpdateTransaction(changed, { bondTxid, bondVout: 0, signature: signed(changed), previousTxid: b32(0xac), network: 'regtest' });
  const got = await acceptAdvertUpdate({ transaction: UPDATE, network: 'regtest', bond: BOND, verify });
  assert.equal(got.ok, true, got.why);
  const spends = parseTransaction(UPDATE).inputs.map((i) => `${toHex(i.previousTxid)}:${i.previousVout}`);
  // either byte order: an input names its previous txid as the wire carries it
  const bondKeys = [`${toHex(bondTxid)}:0`, `${toHex(Uint8Array.from(bondTxid).reverse())}:0`];
  assert.ok(!spends.some((x) => bondKeys.includes(x)), 'the update spends the bond');
  const view = { firstHeight: 100, blocks: [{ transactions: [BOND_TX] }, { transactions: [UPDATE] }] };
  const newest = newestUpdates(view, [{ txid: bondTxid, vout: 0, pubkey: NODE }], { atHeight: 101, verify });
  const u = newest.get(`${Array.from(bondTxid).join(',')}:0`);
  assert.ok(u, 'the census found no update for the bond');
  console.log(`  FACTS (update): accepted ${got.ok}, spends the bond ${spends.some((x) => bondKeys.includes(x))}, hosted before ${first.hostedGames.length}, after ${u.advert.hostedGames.length}`);
  assert.deepEqual(u.advert.hostedGames.map(toHex), [toHex(NEXTBLOCK), toHex(TALLY)]);
});
