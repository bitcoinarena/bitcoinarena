// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A COMMITTEE PEER IS DIALED AT ITS ANNOUNCED ADDRESS FIRST (kanban #757, URGENT, rounds not seating). Measured 2026-10-28
// ~10:30Z: installer test node b36828fa... was in the census (157704) and drawn in 67 listed rounds; its advert endpoint
// (cups-grades-observation-card.trycloudflare.com) no longer resolved, while its signed address announcement, held by every
// seat, named top-linda-jose-visibility.trycloudflare.com, which answered /identity in 0.1 s. The seating agent and every
// committee/settlement/verify peer list read only the advert. Now they read the address book first (roster.js endpointsOf).
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { Roster, endpointsOf } from '../src/roster.js';
import { createAddressBook } from '../src/address-book.js';
import { seatingAgent } from '../src/seating-agent.js';
import { signAddressAnnouncement } from '../../arena-protocol/src/address-announcement.js';
import { signPresent } from '../../arena-protocol/src/seating.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { encodeRoundContract, decodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { chainOf, FIRST_TIME, SPACING, publicationOf } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';
import { bondFor } from './curve.js';
import { beaconFromChain } from '../../arena-protocol/src/beacon.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { contractFor as windowContractFor } from './window-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const FUNDED = { funded: () => true };
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const keyOf = (b) => { const secret = new Uint8Array(32).fill(b); const pubkey = schnorr.getPublicKey(secret); return { secret, pubkey, hex: toHex(pubkey) }; };
const T0 = 1_800_000_000_000;
const DEAD = 'wss://cups-grades-observation-card.trycloudflare.com';
const LIVE = 'https://top-linda-jose-visibility.trycloudflare.com';

test('endpointsOf: a fresh announcement beats a stale advert, a forged one is ignored, no announcement keeps the advert', () => {
  const me = keyOf(1), x = keyOf(2), y = keyOf(3), z = keyOf(4);
  const committee = [me, x, y, z].map((k, i) => ({ pubkey: k.pubkey, advert: { endpoint: i === 1 ? DEAD : `ws://seat-${i}:1/`, timestamp: BigInt(T0 - 1000) } }));
  const book = createAddressBook({ db: new DatabaseSync(':memory:'), verify, nowMs: () => T0 });
  const asBefore = ['https://cups-grades-observation-card.trycloudflare.com', 'http://seat-2:1', 'http://seat-3:1'];
  assert.deepEqual(endpointsOf(committee, me.pubkey, book.endpointOf), asBefore, 'no announcement: the advert endpoint, ws -> http, self left out');
  assert.equal(book.take(signAddressAnnouncement({ node: x.hex, endpoint: LIVE, atMs: T0 }, (d) => schnorr.sign(d, x.secret))).kept, true);
  // forged: y's announcement signed by z's key; x's signature with its endpoint swapped
  const forged = signAddressAnnouncement({ node: y.hex, endpoint: 'https://evil.example', atMs: T0 }, (d) => schnorr.sign(d, z.secret));
  assert.equal(book.take(forged).ok, false, 'a forged announcement is not kept');
  const bent = { ...signAddressAnnouncement({ node: x.hex, endpoint: LIVE, atMs: T0 + 1 }, (d) => schnorr.sign(d, x.secret)), endpoint: 'https://evil.example' };
  assert.equal(book.take(bent).ok, false, 'an endpoint swapped under a good signature is not kept');
  assert.deepEqual(endpointsOf(committee, me.pubkey, book.endpointOf), [LIVE, 'http://seat-2:1', 'http://seat-3:1'], 'x at its announced address; y still at its advert');
  assert.deepEqual(endpointsOf(committee, me.pubkey), asBefore, 'without a resolver: exactly as before');
  assert.deepEqual(endpointsOf(committee, me.pubkey, () => { throw new Error('x'); }), asBefore, 'a resolver that throws: the advert');
});

test('the seating agent asks a drawn node whose advert went stale at its announced address', async () => {
  const nodes = Array.from({ length: 9 }, (_, i) => ({ ...keyOf(i + 1), endpoint: `http://seat-${i}` }));
  const START = 60500n;
  const NOW = Number(START) - 150000;            // inside the PRESENT window
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const c = { ...windowContractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
  const me = nodes[0];
  const round = { db, pubkey: me.pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
  // node 3's advert names a host that is gone and it announced http://seat-3; node 4 has only a forged announcement
  const drawn = nodes.map((n, i) => ({ pubkey: n.pubkey, advert: { endpoint: i === 3 ? 'http://dead-3' : n.endpoint, timestamp: 0n } }));
  const book = createAddressBook({ db: new DatabaseSync(':memory:'), verify, nowMs: () => T0 });
  assert.equal(book.take(signAddressAnnouncement({ node: nodes[3].hex, endpoint: 'http://seat-3', atMs: T0 }, (d) => schnorr.sign(d, nodes[3].secret))).kept, true);
  assert.equal(book.take(signAddressAnnouncement({ node: nodes[4].hex, endpoint: 'http://evil-4', atMs: T0 }, (d) => schnorr.sign(d, nodes[5].secret))).ok, false);
  const roster = { committeeFor: () => ({ ok: true, drawn }) };
  const asked = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    asked.push(`${init.method || 'GET'} ${u.protocol}//${u.host}${u.pathname}`);
    const i = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
    if (i < 0) throw new Error(`getaddrinfo ENOTFOUND ${u.host}`);
    if (u.pathname === '/seating-batch') {
      const presents = ['game', 'settlement'].map((role) => ({ role, node: toHex(nodes[i].pubkey),
        present: toHex(signPresent({ roundId: rid, role, nodePubkey: nodes[i].pubkey }, (d) => schnorr.sign(d, nodes[i].secret))) }));
      return new Response(JSON.stringify({ rounds: { [toHex(rid)]: { presents, sig: {}, cert: {} } } }), { status: 200 });
    }
    return new Response('ok', { status: 200 });
  };
  const run = async (endpointOf) => {
    asked.length = 0;
    const agent = seatingAgent({ round, roster, sign: (d) => schnorr.sign(d, me.secret), verify, fetcher, nowMs: () => NOW, endpointOf });
    await agent.tick();
    return { agent, batches: asked.filter((a) => a.startsWith('GET') && a.endsWith('/seating-batch')) };
  };
  const before = await run(null);
  assert.ok(before.batches.includes('GET http://dead-3/seating-batch'), 'without the book: the dead advert is dialed (the bug)');
  assert.equal(before.agent.presentsOf(rid).filter((p) => p.role === 'game').length, 8, 'node 3\'s PRESENT is missing');
  const after = await run(book.endpointOf);
  assert.ok(after.batches.includes('GET http://seat-3/seating-batch'), `the announced address is dialed: ${after.batches}`);
  assert.ok(!after.batches.some((a) => a.includes('dead-3')), 'the dead advert is not dialed');
  assert.ok(after.batches.includes('GET http://seat-4/seating-batch') && !after.batches.some((a) => a.includes('evil-4')), 'a forged announcement is ignored');
  assert.equal(after.agent.presentsOf(rid).filter((p) => p.role === 'game').length, 9, 'all 9 game PRESENTs held');
});

// THE DAEMON'S OWN WIRING (close-peers.test.js fixture): a census of two, the other's bond endpoint dead.
const HEIGHT = 900000;
const TIP = HEIGHT + 10;
const FROM = HEIGHT - 20;
const advertFor = (key, endpoint) => ({
  nodePubkey: key, operatorId: 'operator', protocolVersions: [1],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], endpoint, region: 'eu-west',
  capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
});
const bondOf = (key, n, endpoint) => bondTransaction(advertFor(key, endpoint), { previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(key) });
const chainWith = (bonds, contract) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
  if (contract) blocks[1] = { transactions: [publicationOf(contract)] };
  return chainOf(blocks, FROM);
};
const contractFor = (nodes, censusRoot) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n,
  startTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 60500n,
  entryCloseMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: HEIGHT, censusRoot, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

test('a daemon dials a settlement peer whose bond endpoint is dead at its announced address (peersFor); forged and absent announcements leave the advert', async () => {
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED });
  const b = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...FUNDED });
  try {
    const keys = [a.round.pubkey, b.round.pubkey];
    const bonds = [bondOf(keys[0], 1, `ws://127.0.0.1:${a.port}`), bondOf(keys[1], 2, 'ws://127.0.0.1:1')];
    const view = chainWith(bonds);
    const byTxid = new Map();
    for (const block of view.blocks) for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
    const census = deriveCensus(view, {
      contract: decodeRoundContract(encodeRoundContract(contractFor(keys, b32(2)))), bond: bondSetFor('regtest'),
      resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; },
    });
    assert.equal(census.ok, true, census.why);
    const c = contractFor(keys, census.root);
    const published = chainWith(bonds, c);
    const named = beaconFromChain(c, { headers: published.blocks.map((x) => x.header), firstHeight: published.firstHeight });
    const beacon = { hash: named.hash, height: named.height, timeMs: named.timeMs };
    const storeA = a.round.db;
    await a.close();
    const again = await serve(storeA, { plugins: HOSTED, port: a.port, ...FUNDED, chainFor: () => published, randomnessFor: () => beacon });
    try {
      const rid = again.round.open(c);
      const joined = new Roster(again.round, { chainFor: () => published, randomnessFor: () => beacon }).assignSignerNodes(rid);
      assert.equal(joined.ok, true, joined.why);
      assert.deepEqual(again.stakeSecrets.peersOf(rid), ['http://127.0.0.1:1'], 'no announcement: the advert endpoint');
      const post = (body) => fetch(`http://127.0.0.1:${again.port}/address-announcement`, { method: 'POST', body: JSON.stringify(body) });
      const live = `http://127.0.0.1:${b.port}`;
      const forged = signAddressAnnouncement({ node: toHex(keys[1]), endpoint: 'http://127.0.0.1:2', atMs: Date.now() }, (d) => schnorr.sign(d, again.round.identity.secret));
      const refused = await post(forged);
      await refused.text();
      assert.equal(refused.status, 400, 'a forged announcement is refused');
      assert.deepEqual(again.stakeSecrets.peersOf(rid), ['http://127.0.0.1:1'], 'a forged announcement is ignored');
      const good = await post(signAddressAnnouncement({ node: toHex(keys[1]), endpoint: live, atMs: Date.now() }, (d) => schnorr.sign(d, b.round.identity.secret)));
      await good.text();
      assert.equal(good.status, 200);
      assert.deepEqual(again.stakeSecrets.peersOf(rid), [live], 'the settlement peer is dialed at its announced address');
    } finally { await again.close(); }
  } finally { await b.close(); }
});
