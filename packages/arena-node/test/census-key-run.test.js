// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY ON THE DAEMON (spec 5A.3B, kanban #972, #1041): the run on the chain's clock, its store and doors' checks, the anchor with its body in the witness, the forward scan.
// Real keygen and real transaction bytes; the chain and the wire between nodes are in memory. tools/census-key-regtest.mjs asks the same of real seats and a real bitcoind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { CensusKeyStore } from '../src/census-key-store.js';
import { createCensusKeyScan, censusKeyAnchorsInBlock } from '../src/census-key-chain.js';
import { censusKeyFailing, censusKeyFailingWarning } from '../../arena-protocol/src/census-key.js';
import { createCensusKeyRun, censusKeyPostOrder, censusKeySigners, CENSUS_KEY_POST_STEP, RESHARE_POST_STEP } from '../src/census-key-run.js';
import { censusKeyWork } from '../src/census-key-work.js';
import { censusKeyCarrier, censusKeyAnchorSpend } from '../src/census-key-anchor.js';
import { censusKey0Shares, censusKeyAnchor, censusKeyBodyIn, censusKeyContract, censusKeyEnvelope, censusKeyRecordDue, censusKeyRecordId, censusKeyShares, censusHeightOfEpoch, decodeCensusKeyBody, encodeCensusKeyBody,
  encodeReshareList, reshareAnchor, reshareAnchorIn, reshareListIn, reshareReadyId, reshareWindow, standingKeysName } from '../../arena-protocol/src/census-key.js';
import { CENSUS_KEY_VERSION, BOND_SUM_VERSION } from '../../arena-protocol/src/constants.js';
import { lagrangeOf } from '../../arena-protocol/src/census-dkg.js';
import { BOND_TEMPLATE_V3 } from '../../arena-protocol/src/bond-script.js';
import { feldmanGroup } from '../src/curve.js';
import { CensusDkg } from '../src/dkg.js';
import { randomBytes } from 'node:crypto';
import { CENSUS_KEY_BOND_MIN, CENSUS_KEY_FIRST_HEIGHT, TESTNET4_CENSUS_KEY_FIRST_HEIGHT, censusKeyFirstHeight } from '../../arena-protocol/src/genesis.js';
import { decodeCensusDeal, joinSignedCensusDeal, splitSignedCensusDeal, censusDealId, encodeCensusDeal, censusRunId, founderRun } from '../../arena-protocol/src/census-dkg.js';
import { BOND_MATURITY_OFFSET } from '../../arena-protocol/src/bond-script.js';
import { clocksFor } from '../../arena-protocol/src/federation-slash.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const NETWORK = 'regtest', E = BOND_MATURITY_OFFSET.regtest, WINDOW = clocksFor(NETWORK).clocks.foundingWindow, CONF = 1;
const NET = new Uint8Array(32).fill(9), EPOCH = 3, START = EPOCH * E, FIRST = START;
const BOND = CENSUS_KEY_BOND_MIN.regtest;
const verify = (s, d, k) => { try { return schnorr.verify(s, d, k); } catch { return false; } };
const hashOf = (h, branch = 'a') => `${branch}${String(h).padStart(63, '0')}`;

/** A block in Bitcoin's bytes: a header of zeros and the transactions. */
function blockOf(txs) {
  const parts = [new Uint8Array(80), Uint8Array.of(txs.length), ...txs];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const COINBASE = fromHex('0200000001' + '00'.repeat(36) + '00ffffffff' + '01' + '0000000000000000' + '00' + '00000000');

function chain(tip = START) {
  const c = { tip, branch: 'a', mined: new Map(), mempool: [] };
  c.hashAt = (h) => (h <= c.tip ? hashOf(h, h >= (c.forkAt ?? Infinity) ? c.branch : 'a') : null);
  c.mine = (n = 1) => { for (let i = 0; i < n; i++) { c.tip += 1; c.mined.set(c.hashAt(c.tip), blockOf([COINBASE, ...c.mempool])); c.mempool = []; } };
  c.blockAt = (hash) => c.mined.get(hash) || blockOf([COINBASE]);
  return c;
}

const person = (i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, key: schnorr.getPublicKey(secret) }; };
const entriesOf = (nodes) => nodes.map((n, i) => ({ pubkey: n.key, bondSats: n.bond, txid: new Uint8Array(32).fill(i + 1), vout: 0, advert: { endpoint: `ws://n${i}`, ...(n.advert || {}) } }));

/** N nodes on one chain, their doors joined by a fetch in memory. */
function network(bonds, { c = chain(), down = [], canPay = () => true, entries = null, censusAt = null, censusKey0 = null, extraNamed = null } = {}) {
  const nodes = bonds.map((bond, i) => ({ ...person(i), bond, url: `http://n${i}` }));
  const list = entries || entriesOf(nodes);
  const read = (h) => (censusAt ? censusAt(h, list) : list);
  // the census' namedKeys: here every entry, and `extraNamed(h)` what a real one counts beyond its entries, a bond out of the census or a hold output
  const readNamed = (h) => {
    const out = { ...(extraNamed ? extraNamed(h) : {}) };
    for (const e of read(h)) if (e.advert.censusKey) { const k = toHex(e.advert.censusKey); out[k] = (out[k] || 0) + 1; }
    return out;
  };
  const byUrl = new Map();
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url), n = byUrl.get(`http://${u.host}`);
    if (!n || down.includes(n.index)) throw new Error('down');
    const say = (ok, body) => ({ ok, status: ok ? 200 : 409, json: async () => body, arrayBuffer: async () => body, text: async () => String(body) });
    if (opts.method === 'POST') {
      if (u.pathname === '/census-dkg/deal') { const t = await n.run.takeDeal(new Uint8Array(opts.body)); return say(t.ok, t.why); }
      if (u.pathname === '/census-dkg/complaint') { const t = await n.run.takeComplaint(new Uint8Array(opts.body)); return say(t.ok, t.why); }
      if (u.pathname === '/census-dkg/statement') { const t = n.run.takeStatement(JSON.parse(opts.body)); return say(t.ok, t.why); }
      if (u.pathname === '/census-dkg/ready') { const t = n.run.takeReady(JSON.parse(opts.body)); return say(t.ok, t.why); }
    }
    if (u.pathname === '/census-dkg/ready') { const h = n.run.readyHeld(u.searchParams.get('key'), u.searchParams.get('run')); return say(!!h, h); }
    if (u.pathname === '/census-dkg/deal') { const w = n.run.dealWire(u.searchParams.get('run'), u.searchParams.get('dealer')); return say(!!w, w && w.buffer.slice(w.byteOffset, w.byteOffset + w.length)); }
    if (u.pathname === '/census-dkg') { const h = n.run.heldOf(u.searchParams.get('run')); return say(!!h, h); }
    throw new Error(`no door ${url}`);
  };
  nodes.forEach((n, i) => {
    n.index = i;
    n.db = openStore(':memory:');
    n.store = new CensusKeyStore(n.db);
    n.posted = [];
    n.tried = [];                                   // every height this node's wallet was asked to post at, paid or not (kanban #1188)
    n.build = (extra = {}) => {
      n.scan = createCensusKeyScan({ store: n.store, network: NETWORK, networkId: NET, firstHeight: FIRST, foundingWindow: WINDOW, censusConfirmations: CONF, censusKey0, tipHeight: () => c.tip, blockHashAt: c.hashAt,
        blockAt: c.blockAt, censusEntriesAt: read, censusNamedAt: readNamed, verify });
      n.run = createCensusKeyRun({ store: n.store, network: NETWORK, networkId: NET, key: n.key, secret: n.secret, firstHeight: FIRST, foundingWindow: WINDOW, censusConfirmations: CONF,
        tipHeight: () => c.tip, blockHashAt: c.hashAt, censusEntriesAt: read, standing: n.scan.standing, scannedTo: n.scan.scannedTo, plan: n.scan.planAt, reshareList: n.scan.reshareList,
        generationOf: n.scan.generationOf, fetchFn, work: censusKeyWork,
        post: async ({ body, output }) => {
          n.tried.push(c.tip);
          if (!canPay(i)) return { ok: false, why: 'this wallet holds no confirmed coins' };
          const secret = new Uint8Array(32).fill(200), carrier = censusKeyCarrier(secret, body);
          const raw = censusKeyAnchorSpend({ carrier, secret, funding: { txid: '11'.repeat(32), vout: 0, value: 10000n }, output });
          n.posted.push(c.tip); c.mempool.push(raw);
          return { ok: true, txid: toHex(parseTransaction(raw).txid), vsize: 0 };
        }, ...extra });
    };
    n.build();
    byUrl.set(n.url, n);
  });
  for (const e of list) e.advert.endpoint = e.advert.endpoint.replace('ws://n', 'http://n');
  const live = () => nodes.filter((n) => !down.includes(n.index));
  const pass = async (rounds = 1) => { for (let i = 0; i < rounds; i++) for (const n of live()) { await n.scan.pass(); await n.run.pass(); } };
  const to = async (height) => { while (c.tip < height) { c.mine(); await pass(2); } };
  return { nodes, c, list, pass, to, live, fetchFn };
}
const bonds = (n) => Array.from({ length: n }, (_, i) => BigInt(1 + (i % 3)) * BOND);
const midpoint = START + Math.floor(WINDOW / 2);

test('a run on the chain\'s clock makes one key at every node: deals, the midpoint, one record, the anchor by rank 1, and every scan reads it as standing', async () => {
  const w = network(bonds(5));
  await w.pass(2);
  const id = w.nodes[0].run.status().run.runId;
  assert.deepEqual(w.nodes.map((n) => n.store.dealers(fromHex(id)).length), [5, 5, 5, 5, 5], 'all five deals everywhere in the first half');
  await w.to(midpoint + 1);
  assert.equal(new Set(w.nodes.map((n) => n.run.status().run.state.recordId)).size, 1, 'one record');
  await w.pass(2);
  const done = w.nodes.map((n) => n.run.status().run.state);
  assert.ok(done.every((s) => Number.isInteger(s.complete)), 'every node kept its shares');
  const key = fromHex(done[0].publicKey);
  for (const n of w.nodes) {
    const held = n.store.held(key);
    assert.ok(held.shares.size >= 1, 'each node keeps its own shares');
  }
  const first = censusKeyPostOrder({ networkId: NET, epoch: EPOCH, holders: censusKeyShares({ entries: w.list, network: NETWORK }).holders })[0];
  const posted = w.nodes.filter((n) => n.posted.length);
  assert.deepEqual(posted.map((n) => toHex(n.key)), [first], 'only rank 1 posts');
  await w.to(w.c.tip + 1);
  await w.pass();
  for (const n of w.nodes) {
    const standing = n.scan.standing();
    assert.equal(standing.length, 1);
    assert.equal(toHex(standing[0].publicKey), done[0].publicKey);
    assert.equal(standing[0].epoch, EPOCH);
  }
  const status = w.nodes[1].scan.status();
  assert.equal(status.anchors.filter((a) => a.stands).length, 1);
  assert.equal(censusKeyAnchorIdOf(status), toHex(censusKeyRecordId(decodeCensusKeyBody(w.nodes[1].store.anchors()[0].body).record)));
});
const censusKeyAnchorIdOf = (s) => s.anchors[0].recordId;

test('holders may be absent: the key stands on those that dealt, as long as they hold the threshold', async () => {
  const w = network(Array.from({ length: 6 }, () => BOND), { down: [5] });
  await w.pass(2);
  await w.to(midpoint + 1);
  await w.pass(3);
  const live = w.live().map((n) => n.run.status().run);
  assert.ok(live.every((r) => r.deals === 5 && Number.isInteger(r.state.complete)), 'five of six made it');
});

test('a bad deal is named by a complaint anyone can check, and every honest node drops it and signs one record', async () => {
  const w = network(Array.from({ length: 5 }, () => BOND));
  const evil = w.nodes[0];
  const honest = evil.run;
  await w.pass(1);
  const id = fromHex(w.nodes[1].run.status().run.runId);
  // node 0's deal, one envelope of node 1 turned into garbage, signed as it would be: a good signature on a bad share
  const deal = decodeCensusDeal(splitSignedCensusDeal(evil.store.dealOf(id, evil.key)).bytes);
  const target = censusKeyShares({ entries: w.list, network: NETWORK }).holders.find((h) => h.key === toHex(w.nodes[1].key));
  deal.sealed[target.ids[0] - 1].bytes = new Uint8Array(deal.sealed[target.ids[0] - 1].bytes).fill(7);
  const bytes = encodeCensusDeal(deal);
  const wire = joinSignedCensusDeal(bytes, schnorr.sign(censusDealId(deal), evil.secret));
  for (const n of w.nodes) n.db.prepare('UPDATE census_key_deals SET wire = ? WHERE dealer = ?').run(Buffer.from(wire), Buffer.from(evil.key));
  assert.ok(honest);
  await w.to(midpoint);
  await w.pass(2);
  assert.deepEqual(w.nodes.map((n) => n.store.complaints(id).length > 0), [true, true, true, true, true], 'the complaint reached everyone');
  await w.to(midpoint + 1);
  await w.pass(3);
  const states = w.nodes.map((n) => n.run.status().run.state);
  assert.equal(new Set(states.map((s) => s.recordId)).size, 1, 'one record, the bad deal out of it');
  assert.equal(states[1].publicKey.length, 64);
  assert.ok(states.every((s) => Number.isInteger(s.complete)));
});

test('nodes that differ at the midpoint sign different records: nothing reaches the threshold, the epoch fails and the newest stands', async () => {
  const w = network(Array.from({ length: 6 }, () => BOND));
  await w.pass(1);
  const id = fromHex(w.nodes[0].run.status().run.runId);
  // three nodes never saw two deals, and the rest have all six: 3 + 3 on two hashes, threshold 5
  for (const n of w.nodes.slice(0, 3)) n.db.prepare('DELETE FROM census_key_deals WHERE dealer IN (?, ?)').run(Buffer.from(w.nodes[4].key), Buffer.from(w.nodes[5].key));
  const dealers = w.nodes.map((n) => n.store.dealers(id).length);
  assert.deepEqual(dealers, [4, 4, 4, 6, 6, 6]);
  w.c.tip = midpoint - 1;
  await w.c.mine(2);
  for (const n of w.nodes) { await n.scan.pass(); }
  await w.pass(2);
  w.c.mine(WINDOW);
  await w.pass(3);
  const states = w.nodes.map((n) => n.run.status().run.state);
  assert.equal(new Set(states.map((s) => s.recordId)).size, 2);
  assert.ok(states.every((s) => s.failed === true && !s.complete));
  assert.equal(w.nodes[0].scan.standing().length, 0);
});

test('a node that signed another record takes the agreed set from a peer and keeps its shares', async () => {
  const w = network(Array.from({ length: 6 }, () => BOND));
  await w.pass(1);
  const id = fromHex(w.nodes[0].run.status().run.runId);
  await w.to(midpoint - 1);
  w.nodes[0].db.prepare('DELETE FROM census_key_deals WHERE dealer = ?').run(Buffer.from(w.nodes[5].key));
  await w.to(midpoint + 1);
  await w.pass(4);
  const s = w.nodes.map((n) => n.run.status().run.state);
  assert.notEqual(s[0].recordId, s[1].recordId, 'it signed the record of the deals it held');
  assert.equal(s[0].agreed, s[1].agreed, 'and kept the agreed key');
  assert.equal(s[0].publicKey, s[1].publicKey);
  assert.ok(w.nodes[0].store.held(fromHex(s[0].publicKey)));
  assert.equal(w.nodes[0].store.dealers(id).length, 6);
});

test('a holder that cannot pay says so, and the next rank posts (k - 1) x 6 blocks after the record is complete', async () => {
  const holders = censusKeyShares({ entries: entriesOf(Array.from({ length: 4 }, (_, i) => ({ ...person(i), bond: BOND }))), network: NETWORK }).holders;
  const order = censusKeyPostOrder({ networkId: NET, epoch: EPOCH, holders });
  const rank1 = order[0];
  const w = network(Array.from({ length: 4 }, () => BOND), { canPay: (i) => toHex(person(i).key) !== rank1 });
  await w.pass(2);
  await w.to(midpoint + 1);
  await w.pass(3);
  const complete = w.nodes[0].run.status().run.state.complete;
  assert.ok(w.nodes.every((n) => !n.posted.length), 'rank 2 waits');
  assert.match(w.nodes.find((n) => toHex(n.key) === rank1).run.status().lastWhy, /no confirmed coins/);
  while (w.c.tip < complete + CENSUS_KEY_POST_STEP - 1) { w.c.mine(); await w.pass(); }
  assert.ok(w.nodes.every((n) => !n.posted.length));
  w.c.mine(); await w.pass();
  const posters = w.nodes.filter((n) => n.posted.length);
  assert.deepEqual(posters.map((n) => toHex(n.key)), [order[1]]);
  assert.equal(posters[0].posted[0], complete + CENSUS_KEY_POST_STEP);
  w.c.mine(); await w.pass(2);
  assert.equal(w.nodes[2].scan.standing().length, 1);
  w.c.mine(CENSUS_KEY_POST_STEP * 2); await w.pass(2);
  assert.equal(w.nodes.reduce((n, x) => n + x.posted.length, 0), 1, 'no other rank pays once it stands');
});

test('a deal needs its dealer\'s signature, the first one stands, the deals close at the midpoint, and a restart never deals again', async () => {
  const w = network(Array.from({ length: 3 }, () => BOND));
  const [a, b, c] = w.nodes;
  await a.scan.pass(); await a.run.pass(); await b.scan.pass();
  const id = fromHex(a.run.status().run.runId);
  const own = a.store.dealOf(id, a.key);
  const { bytes } = splitSignedCensusDeal(own);
  assert.match((await b.run.takeDeal(own)).why, /not in a census key run/, 'a seat that has not reached the run yet answers so, and pulls later');
  await b.run.pass();
  assert.match((await b.run.takeDeal(joinSignedCensusDeal(bytes, schnorr.sign(censusDealId(decodeCensusDeal(bytes)), c.secret)))).why, /not signed by its dealer/);
  assert.equal((await b.run.takeDeal(own)).fresh, false, 'the deal was already pulled from a');
  const again = await censusKeyWork({ kind: 'deal', key: a.key, secret: a.secret, run: { ...runOf(w), runId: id } });
  const other = decodeCensusDeal(again.bytes);
  assert.equal((await b.run.takeDeal(joinSignedCensusDeal(again.bytes, schnorr.sign(censusDealId(other), a.secret)))).fresh, false, 'a second deal writes nothing');
  assert.equal(toHex(b.store.dealOf(id, a.key)), toHex(own), 'the first stands');
  a.build();
  await a.scan.pass(); await a.run.pass();
  assert.equal(toHex(a.store.dealOf(id, a.key)), toHex(own), 'a restarted node has its deal and makes no other');
  await w.to(midpoint);
  assert.match((await b.run.takeDeal(own)).why, /closed at/);
});
function runOf(w) {
  const { holders, total, threshold } = censusKeyShares({ entries: w.list, network: NETWORK });
  const censusHeight = censusHeightOfEpoch(EPOCH, NETWORK, CONF);
  return { runId: censusRunId({ networkId: NET, epoch: EPOCH, censusHeight, holders, threshold }), networkId: NET, epoch: EPOCH, censusHeight, holders, total, threshold, needed: threshold };
}

test('no run where none is due: before the first height, without a named newest key, for a node holding no share, or with no first height', async () => {
  const before = network(bonds(3), { c: chain(START - 1) });
  await before.pass(1);
  assert.equal(before.nodes[0].run.status().run, null);

  const w = network(bonds(3));
  await w.pass(2);
  await w.to(midpoint + 1);
  await w.pass(3);
  w.c.mine(); await w.pass(2);
  assert.equal(w.nodes[0].scan.standing().length, 1);
  w.c.tip = START + E - 1; w.c.mine(); await w.pass(2);
  assert.equal(await w.nodes[0].run.pass().then((p) => p.idle), 'the newest key has not been named by a bond', 'a key no bond named is not followed by another');

  const small = network([BOND, BOND, BOND], { entries: entriesOf([...[0, 1].map((i) => ({ ...person(i), bond: BOND })), { ...person(9), bond: BOND }]) });
  await small.pass(1);
  assert.equal(await small.nodes[2].run.pass().then((p) => p.idle), 'this node holds no share of this run');

  // NAMED IN 2.0 (decision #1083): regtest from its first block, testnet4 at an epoch's first block the owner confirms before deploy
  assert.equal(CENSUS_KEY_FIRST_HEIGHT.regtest, 0, 'a private chain runs the key from its first epoch');
  assert.equal(censusKeyFirstHeight('testnet4'), TESTNET4_CENSUS_KEY_FIRST_HEIGHT);
  assert.equal(TESTNET4_CENSUS_KEY_FIRST_HEIGHT % 144, 0, 'testnet4\'s first height is an epoch\'s first block');
  assert.equal(censusKeyFirstHeight('mainnet'), null, 'mainnet reads its genesis');
  assert.equal(censusKeyFirstHeight('mainnet', { genesisHeight: 900000 }), 900000, 'and scans from genesis_height, not from 0');
  assert.equal(censusKeyFirstHeight('nowhere'), null);
  const off = createCensusKeyScan({ store: new CensusKeyStore(openStore(':memory:')), network: 'testnet4', networkId: NET, firstHeight: null, censusConfirmations: 6 });
  assert.equal((await off.pass()).skipped, true);
  assert.deepEqual(off.standing(), []);
});

const fixedRecord = (over = {}) => ({ networkId: NET, epoch: EPOCH, publicKey: new Uint8Array(32).fill(4), censusHeight: START - CONF, totalShares: 3, threshold: 3, transcriptHash: new Uint8Array(32).fill(5), ...over });
const signaturesOf = (nodes, record) => nodes.map((n) => ({ key: n.key, signature: schnorr.sign(censusKeyRecordId(record), n.secret) })).sort((a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1));
function anchorTx(record, signatures, value = 10000n) {
  const secret = new Uint8Array(32).fill(200), carrier = censusKeyCarrier(secret, encodeCensusKeyBody({ record, signatures }));
  return censusKeyAnchorSpend({ carrier, secret, funding: { txid: '11'.repeat(32), vout: 0, value }, output: censusKeyAnchor(record) });
}

test('the body travels in the leaf the anchor spends, read back by the id the OP_RETURN names, at the largest a key can need, and no relay can take it off', () => {
  const nodes = Array.from({ length: 683 }, (_, i) => { const secret = fromHex((i + 1).toString(16).padStart(64, '0')); return { secret, key: schnorr.getPublicKey(secret) }; });
  const record = fixedRecord();
  const signatures = nodes.map((n) => ({ key: n.key, signature: new Uint8Array(64).fill(1) })).sort((a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1));
  const raw = anchorTx(record, signatures);
  const tx = parseTransaction(raw);
  assert.equal(tx.witnesses[0].length, 3, 'a signature, the leaf and its control block');
  assert.ok(tx.witnesses[0][0].length <= 80, 'the only stack item is the signature');
  const stripped = { ...tx, witnesses: [[tx.witnesses[0][0], Uint8Array.from([...tx.witnesses[0][1].subarray(0, 34)]), tx.witnesses[0][2]]] };
  assert.equal(censusKeyBodyIn(stripped, censusKeyRecordId(record)), null, 'a leaf without the body is another leaf, and the output commits to this one');
  assert.ok(censusKeyEnvelope(new Uint8Array(1)).length < 6);
  const seen = censusKeyBodyIn(tx, censusKeyRecordId(record));
  assert.equal(seen.signatures.length, 683);
  assert.deepEqual(seen.record, decodeCensusKeyBody(encodeCensusKeyBody({ record, signatures })).record);
  assert.equal(censusKeyBodyIn(tx, new Uint8Array(32).fill(1)), null);
  const [found] = censusKeyAnchorsInBlock(blockOf([COINBASE, raw]), 900);
  assert.equal(found.index, 1);
  assert.equal(found.height, 900);
  assert.equal(toHex(found.id), toHex(censusKeyRecordId(record)));
  assert.deepEqual(censusKeyAnchorsInBlock(blockOf([COINBASE]), 900), []);
  assert.deepEqual(Array.from(censusKeyAnchor(record).script.subarray(0, 6)), [0x6a, 36, 0x41, 0x52, 0x4e, 0x4b]);
});

test('the scan keeps the first valid record per epoch and refuses the rest by name, and an anchor with no body or too few signatures leaves the epoch open', async () => {
  const nodes = [person(0), person(1), person(2)].map((n) => ({ ...n, bond: BOND }));
  const entries = entriesOf(nodes);
  const c = chain(START + 1);
  const store = new CensusKeyStore(openStore(':memory:'));
  let reads = 0;
  const scan = createCensusKeyScan({ store, network: NETWORK, networkId: NET, firstHeight: FIRST, censusConfirmations: CONF, tipHeight: () => c.tip, blockHashAt: c.hashAt, blockAt: c.blockAt,
    censusEntriesAt: async () => { reads += 1; return entries; }, verify, log: () => {} });
  const shares = censusKeyShares({ entries, network: NETWORK });
  const good = fixedRecord({ totalShares: shares.total, threshold: shares.threshold });
  const other = { ...good, publicKey: new Uint8Array(32).fill(8) };
  c.mempool = [anchorTx(good, signaturesOf(nodes.slice(0, 1), good))];            // one signer, under the threshold
  c.mine();
  c.mempool = [anchorTx({ ...good, networkId: new Uint8Array(32).fill(1) }, signaturesOf(nodes, good))];
  c.mine();
  c.mempool = [anchorTx({ ...good, censusHeight: START - 5 }, signaturesOf(nodes, good))];
  c.mine();
  c.mempool = [anchorTx({ ...good, epoch: EPOCH - 1 }, signaturesOf(nodes, good))];    // before the first height: no census is read for it
  c.mine();
  c.mempool = [anchorTx(good, signaturesOf(nodes, good))];
  c.mine();
  const standsAt = c.tip;
  c.mempool = [anchorTx(other, signaturesOf(nodes, other))];
  c.mine();
  await scan.pass();
  const said = scan.status();
  assert.deepEqual(said.anchors.map((a) => a.stands), [false, false, false, false, true, false]);
  assert.match(said.anchors[0].why, /nodes holding 1 shares signed/);
  assert.match(said.anchors[1].why, /another network/);
  assert.match(said.anchors[2].why, /census height/);
  assert.match(said.anchors[3].why, /before this network's first key height/);
  assert.match(said.anchors[5].why, /already has its key/);
  assert.equal(reads, 2, 'only the two records of the right shape read a census');
  assert.deepEqual(scan.standing().map((k) => [k.epoch, toHex(k.publicKey), k.height]), [[EPOCH, toHex(good.publicKey), standsAt]]);
  assert.equal(said.keys[0].height, standsAt);
  assert.equal(scan.scannedTo(), c.tip);
  assert.equal(store.anchors().filter((a) => a.body).length, 1, 'a refused anchor keeps no body');
});

test('an anchor whose record has too few signatures counts for nothing, and the same record posted again stands', async () => {
  const nodes = [person(0), person(1), person(2)].map((n) => ({ ...n, bond: BOND }));
  const entries = entriesOf(nodes);
  const c = chain(START + 1);
  const scan = createCensusKeyScan({ store: new CensusKeyStore(openStore(':memory:')), network: NETWORK, networkId: NET, firstHeight: FIRST, censusConfirmations: CONF, tipHeight: () => c.tip,
    blockHashAt: c.hashAt, blockAt: c.blockAt, censusEntriesAt: () => entries, verify });
  const shares = censusKeyShares({ entries, network: NETWORK });
  const good = fixedRecord({ totalShares: shares.total, threshold: shares.threshold });
  c.mempool = [anchorTx(good, [])];
  c.mine();
  await scan.pass();
  assert.equal(scan.standing().length, 0);
  c.mempool = [anchorTx(good, signaturesOf(nodes, good))];
  c.mine();
  await scan.pass();
  assert.equal(scan.standing().length, 1);
});

test('what the scan found survives a restart, it reads on from where it stopped, it holds at a census it cannot read, and it follows a reorg', async () => {
  const nodes = [person(0), person(1), person(2)].map((n) => ({ ...n, bond: BOND }));
  const entries = entriesOf(nodes);
  const c = chain(START + 1);
  const db = openStore(':memory:');
  let censusUp = false, asked = [];
  const make = (max = 64) => createCensusKeyScan({ store: new CensusKeyStore(db), network: NETWORK, networkId: NET, firstHeight: FIRST, censusConfirmations: CONF, tipHeight: () => c.tip,
    blockHashAt: (h) => { asked.push(h); return c.hashAt(h); }, blockAt: c.blockAt, censusEntriesAt: () => (censusUp ? entries : null), verify, maxBlocksPerPass: max });
  const shares = censusKeyShares({ entries, network: NETWORK });
  const good = fixedRecord({ totalShares: shares.total, threshold: shares.threshold });
  c.mempool = [anchorTx(good, signaturesOf(nodes, good))];
  c.mine();
  const at = c.tip;
  const scan = make();
  await assert.rejects(scan.pass(), /cannot be read yet/);
  assert.equal(scan.scannedTo(), at - 1, 'it holds below the anchor it could not judge');
  censusUp = true;
  await scan.pass();
  assert.equal(scan.standing().length, 1);

  const restarted = make();
  assert.equal(restarted.standing().length, 1, 'kept across a restart');
  assert.equal(restarted.scannedTo(), at);
  c.mine(3);
  asked = [];
  await restarted.pass();
  assert.deepEqual([...new Set(asked.filter((h) => h > at))], [at + 1, at + 2, at + 3], 'only new heights are read');

  const bounded = createCensusKeyScan({ store: new CensusKeyStore(openStore(':memory:')), network: NETWORK, networkId: NET, firstHeight: FIRST, censusConfirmations: CONF, tipHeight: () => c.tip,
    blockHashAt: c.hashAt, blockAt: c.blockAt, censusEntriesAt: () => entries, verify, maxBlocksPerPass: 2 });
  assert.equal((await bounded.pass()).read, 2, 'a pass reads at most its bound');

  // the block holding the anchor leaves the chain
  c.forkAt = at; c.branch = 'b';
  await restarted.pass();
  assert.equal(restarted.standing().length, 0, 'the key left with its block');
  assert.equal(restarted.scannedTo(), c.tip, 'the new branch is read');
});

test('a cache of a census names only the keys at or below its height, and with no key it names nothing', () => {
  const k = (epoch, height, fill) => ({ epoch, height, publicKey: new Uint8Array(32).fill(fill) });
  assert.equal(standingKeysName([], 500), '');
  assert.equal(standingKeysName(null, 500), '');
  assert.equal(standingKeysName([k(3, 600, 1)], 500), '', 'a key anchored above the census is not read by it');
  const one = standingKeysName([k(3, 300, 1)], 500);
  assert.match(one, /^[0-9a-f]{16}$/);
  assert.equal(standingKeysName([k(3, 300, 1), k(4, 600, 2)], 500), one, 'a later key leaves it where it was');
  assert.notEqual(standingKeysName([k(3, 300, 1), k(4, 400, 2)], 500), one);
  assert.notEqual(standingKeysName([k(3, 300, 2)], 500), one);
});

test('the rules of a record before any census is read, and the census a key reads', () => {
  const due = (over, height = START + 3, firstHeight = FIRST) => censusKeyRecordDue({ record: fixedRecord(over), height, network: NETWORK, firstHeight, censusConfirmations: CONF });
  assert.deepEqual(due({}), { ok: true, censusHeight: START - CONF, drawHeight: START });
  assert.match(due({}, START - 1).why, /before its epoch's first height/);
  assert.match(due({ epoch: EPOCH + 1 }).why, /before its epoch's first height/);
  assert.match(due({ censusHeight: 7 }).why, /reads/);
  assert.match(due({}, START, null).why, /no census key/);
  const contract = censusKeyContract({ networkId: NET, network: NETWORK, height: 299, censusConfirmations: CONF });
  assert.equal(contract.protocolVersion, CENSUS_KEY_VERSION);
  assert.ok(CENSUS_KEY_VERSION >= BOND_SUM_VERSION, 'bonds still sum');
  assert.equal(contract.bondMinSats, BOND);
  assert.equal(contract.censusHeight, 299);
});

test('the signers of an anchor are the fewest that reach the threshold, largest first, in key order', () => {
  const key = (n) => toHex(person(n).key);
  const holders = [{ key: key(0), shares: 1 }, { key: key(1), shares: 5 }, { key: key(2), shares: 3 }, { key: key(3), shares: 1 }];
  const recordId = new Uint8Array(32).fill(3), other = new Uint8Array(32).fill(4);
  const statements = [0, 1, 2, 3].map((n) => ({ node: person(n).key, recordId: n === 3 ? other : recordId, signature: new Uint8Array(64).fill(n) }));
  const got = censusKeySigners({ holders, threshold: 7, statements, recordId });
  assert.deepEqual(got.map((s) => toHex(s.key)).sort(), [key(1), key(2)].sort());
  assert.equal(censusKeySigners({ holders, threshold: 10, statements, recordId }), null, 'short of the threshold on this record');
  assert.ok(toHex(got[0].key) < toHex(got[1].key));
});


// A RESHARE (kanban #1048 answer 1): the census changes under a key, and the chain decides the rest
const named = (key) => ({ bondScriptTemplateVersion: BOND_TEMPLATE_V3, censusKey: key });
function fourThenMoved(options = {}) {
  // 2 + 2 + 3 + 4 shares, threshold 8. Node 2 leaves the census: 8 of 11 held, under 80 %, still over the threshold. Node 4 comes in naming the key
  const shape = [2n, 2n, 3n, 4n, 3n].map((n) => n * BOND);
  const everyone = shape.map((bond, i) => ({ ...person(i), bond }));
  let key = null;
  const first = entriesOf(everyone.slice(0, 4));
  const w = network(shape, { ...options, entries: first, censusAt: (h) => {
    if (h < START + E - CONF || !key) return first;
    const later = entriesOf([0, 1, 3, 4].map((i) => ({ ...everyone[i], advert: i === 4 ? named(key) : {} })));
    for (const e of later) e.advert.endpoint = e.advert.endpoint.replace(/ws:\/\/n(\d)/, (_, x) => `http://n${[0, 1, 3, 4][Number(x)]}`);
    return later;
  } });
  w.setKey = (k) => { key = k; };
  return w;
}
const jump = async (w, height) => { w.c.tip = height - 1; w.c.mine(); await w.pass(4); };
async function firstKey(w) {
  await w.pass(2);
  await w.to(midpoint + 1);
  await w.pass(2);
  w.c.mine(); await w.pass(2);
  const key = w.live()[0].scan.standing()[0].publicKey;
  w.setKey(key);
  return key;
}
const resharedStart = START + E, rw = reshareWindow(EPOCH + 1, NETWORK, WINDOW);

test('reshare: the census moves under the key, the chain says who is present, and the new census holds the same key', async () => {
  const w = fourThenMoved();
  const key = await firstKey(w);
  await jump(w, resharedStart);
  const n0 = w.nodes[0];
  const plan = await n0.scan.planAt(EPOCH + 1);
  assert.equal(plan.reshare.key, toHex(key), 'read from the chain: 8 of 11 shares held, under 80 %');
  assert.equal(plan.reshare.heldNow, 8);
  await w.pass(2);
  assert.ok(w.nodes.slice(0, 4).every((n) => n.run.status().reshare.signed === 4), 'all four old holders said ready, the one that left too');
  assert.equal(w.nodes[4].run.status().reshare.signed, 0, 'a new node has no part to offer');
  while (w.c.tip < rw.ready + 3 && !w.c.mempool.some((t) => reshareAnchorIn(parseTransaction(t).outputs))) { w.c.mine(); await w.pass(2); }
  w.c.mine(); await w.pass(2);
  const list = n0.scan.reshareList(toHex(key), EPOCH + 1);
  assert.ok(list.height >= rw.ready && list.height < rw.midpoint, `the list is on the chain at ${list.height}`);
  assert.ok(list.present.length >= 2);
  await w.to(rw.midpoint + 1);
  await w.pass(3);
  const r = w.nodes[3].run.status().reshare;
  assert.equal(r.state.publicKey, toHex(key), 'the reshare keeps the public key');
  assert.notEqual(r.runId, w.nodes[3].run.status().run.runId, 'a keygen ran beside it, as another run');
  for (let i = 0; i < CENSUS_KEY_POST_STEP * 4 && n0.scan.generationOf(toHex(key)).epoch !== EPOCH + 1; i++) { w.c.mine(); await w.pass(2); }
  assert.equal(n0.scan.generationOf(toHex(key)).epoch, EPOCH + 1, 'the record of the new census stands');
  assert.equal(n0.scan.standing().filter((k) => toHex(k.publicKey) === toHex(key)).length, 1, 'and no key was added by it');
  await w.pass(2);
  // #1188: NOT WHILE A REORG CAN TAKE THE RECORD OFF. The scan follows reorgs 288 blocks deep; restarted here with one that follows them 2 deep, the old shares go 3 blocks on
  assert.ok(w.nodes[2].store.held(key), 'the old shares stay while the record is shallower than a reorg the scan follows');
  for (const n of w.nodes) n.build({ reorgDepth: 2 });
  w.c.mine(3); await w.pass(2);
  assert.equal(w.nodes[2].store.held(key), null, 'the node that left no longer keeps its shares');
  // THE NEW SHARES OPEN THE SAME KEY: enough of them, interpolated at zero
  const shares = new Map();
  for (const i of [0, 1, 3, 4]) for (const [x, v] of w.nodes[i].store.held(key, EPOCH + 1).shares) shares.set(x, v);
  const xs = [...shares.keys()].sort((a, b) => a - b).slice(0, r.threshold);
  const lambda = lagrangeOf(xs, xs);
  const FIELD = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const secret = xs.reduce((a, x) => (a + lambda.get(x) * shares.get(x)) % FIELD, 0n);
  assert.equal(toHex(feldmanGroup.pointFromScalar(secret)).slice(2), toHex(key));
  // AND THE TRIGGER IS QUIET NOW: the new census holds all of the key's shares
  await jump(w, resharedStart + E);
  assert.equal((await n0.scan.planAt(EPOCH + 2)).reshare, null);
});

test('key 0 is a key like any other: genesis names its holders, the 80 % trigger reads them, and a reshare moves them on (kanban #1050)', async () => {
  // THE FOUNDERS' RUN, before any bond: nodes 0..3, one share each. Node 3 never bonds, so three of four are in the census: under 80 %, at the threshold of 3
  const founders = [0, 1, 2, 3].map(person);
  const shares0 = censusKey0Shares({ holders: founders.map((f) => f.key), threshold: 3 });
  const run = founderRun(shares0);
  const dkgs = founders.map((f) => new CensusDkg({ key: f.key, secret: f.secret, run, curve: feldmanGroup, random: (n) => new Uint8Array(randomBytes(n)) }));
  const bytes = [];
  for (const d of dkgs) bytes.push((await d.deal()).bytes);
  for (const d of dkgs) for (const b of bytes) await d.accept(b);
  for (const d of dkgs) assert.equal(d.check().ok, true);
  const said = dkgs.map((d) => d.statement());
  const done = dkgs.map((d) => d.finish(said));
  const key = done[0].groupPublicKey.subarray(1);
  const censusKey0 = { publicKey: key, holders: founders.map((f) => f.key), threshold: 3 };
  const entries = [0, 1, 2, 4].map((i) => ({ pubkey: person(i).key, bondSats: 2n * BOND, txid: new Uint8Array(32).fill(i + 1), vout: 0, advert: { endpoint: `ws://n${i}`, ...(i === 4 ? {} : named(key)) } }));
  const w = network([2n, 2n, 2n, 2n, 2n].map((n) => n * BOND), { entries, censusKey0, down: [3] });
  dkgs.slice(0, 3).forEach((_, i) => w.nodes[i].store.keepHeld({ publicKey: key, epoch: 0, runId: run.runId, record: new Uint8Array(0), negated: done[i].negated, shares: done[i].shares, commitments: done[i].commitments }));
  const n0 = w.nodes[0];
  await w.pass(2);
  assert.deepEqual(n0.scan.standing().map((k) => [k.epoch, k.height]), [[0, 0]], 'key 0 stands from genesis');
  const plan = await n0.scan.planAt(EPOCH);
  assert.equal(plan.reshare.key, toHex(key), 'the trigger reads the holders genesis names');
  assert.deepEqual([plan.reshare.heldNow, plan.reshare.total, plan.reshare.threshold, plan.reshare.generation.epoch], [3, 4, 3, 0]);
  assert.equal(plan.newKey, true, 'and it is named by bonds, so the first key by weight runs beside it');
  const rw0 = reshareWindow(EPOCH, NETWORK, WINDOW);
  while (!n0.scan.reshareList(toHex(key), EPOCH)) { assert.ok(w.c.tip < rw0.midpoint); w.c.mine(); await w.pass(2); }
  assert.equal(n0.scan.reshareList(toHex(key), EPOCH).present.length, 3, 'three founders cover its threshold');
  await w.to(rw0.midpoint + 1);
  await w.pass(3);
  assert.equal(w.nodes[4].run.status().reshare.state.publicKey, toHex(key), 'a node that never held key 0 now holds shares of it');
  for (let i = 0; i < CENSUS_KEY_POST_STEP * 5 && n0.scan.generationOf(toHex(key)).epoch !== EPOCH; i++) { w.c.mine(); await w.pass(2); }
  assert.equal(n0.scan.generationOf(toHex(key)).epoch, EPOCH, 'the record stands');
  assert.equal(n0.scan.standing().filter((k) => toHex(k.publicKey) === toHex(key)).length, 1, 'and adds no key');
  await w.pass(2);
  assert.ok(w.nodes[1].store.held(key, 0), '#1188 a founder keeps its old shares while a reorg could take the record off');
  for (const n of w.nodes) n.build({ reorgDepth: 2 });
  w.c.mine(3); await w.pass(2);
  assert.equal(w.nodes[1].store.held(key, 0), null, 'a founder deletes its old shares once the record stands deep');
  const newer = new Map();
  for (const i of [0, 1, 2, 4]) for (const [x, v] of w.nodes[i].store.held(key, EPOCH).shares) newer.set(x, v);
  const xs = [...newer.keys()].sort((a, b) => a - b);
  const lambda = lagrangeOf(xs, xs);
  const FIELD = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  assert.equal(toHex(feldmanGroup.pointFromScalar(xs.reduce((a, x) => (a + lambda.get(x) * newer.get(x)) % FIELD, 0n))).slice(2), toHex(key), 'the new shares open key 0');
  await jump(w, START + E);
  assert.equal((await n0.scan.planAt(EPOCH + 1)).reshare, null, 'and the trigger is quiet: from here its holders are its newest record\'s');
});

test('reshare: a dealer whose part is not its own is named and its deal dropped, the run fails, and the next list leaves it out (kanban #1050 reading 6)', async () => {
  const w = fourThenMoved({ canPay: (i) => i !== 2 });
  const cheat = w.nodes[2], cheater = toHex(cheat.key);
  cheat.build({ work: (job) => censusKeyWork(job.kind === 'deal' && job.part !== null ? { ...job, part: job.part + 1n } : job) });
  const key = await firstKey(w);
  const K = toHex(key), n0 = w.nodes[0], stranger = w.nodes[4];
  await jump(w, resharedStart);
  while (!n0.scan.reshareList(K, EPOCH + 1)) { assert.ok(w.c.tip < rw.midpoint); w.c.mine(); await w.pass(2); }
  assert.ok(n0.scan.reshareList(K, EPOCH + 1).present.includes(cheater), 'the largest first: it is one of the dealers');
  await w.to(rw.midpoint + 1);
  await w.pass(2);
  assert.deepEqual(n0.run.status().reshare.state.bad, [cheater], 'an old holder reads the part off the old polynomial and names its dealer');
  assert.deepEqual(stranger.run.status().reshare.state.bad, [], 'a new holder has nothing to check a name against');
  assert.match(stranger.run.status().reshare.state.why, /do not add up to the key/);
  await w.to(rw.end);
  await w.pass(2);
  assert.ok(n0.run.status().reshare.state.failed, 'the run fails: each part is a term over exactly that set');
  assert.ok(stranger.run.status().reshare.state.failed, 'and the new holder fails it naming nobody');
  assert.equal(n0.scan.generationOf(K).epoch, EPOCH, 'no record: the old shares stand');
  assert.deepEqual(n0.run.status().recent.filter((x) => x.reshareOf).map((x) => x.named), [[cheater]], 'GET /census-key shows who was named');
  assert.deepEqual([...stranger.store.namedDealers(`${K}:${EPOCH}`)], []);
  // THE NEXT WINDOW: the others hold 2 + 2 + 4 = 8 of the old threshold of 8
  const rw2 = reshareWindow(EPOCH + 2, NETWORK, WINDOW);
  await jump(w, resharedStart + E);
  while (!n0.scan.reshareList(K, EPOCH + 2)) { assert.ok(w.c.tip < rw2.midpoint); w.c.mine(); await w.pass(2); }
  const list = n0.scan.reshareList(K, EPOCH + 2);
  assert.ok(!list.present.includes(cheater), 'the poster left it off the list');
  assert.equal(list.present.length, 3);
  await w.to(rw2.midpoint + 1);
  await w.pass(3);
  assert.equal(n0.run.status().reshare.state.publicKey, K, 'and the run holds without it');
  for (let i = 0; i < CENSUS_KEY_POST_STEP * 4 && n0.scan.generationOf(K).epoch !== EPOCH + 2; i++) { w.c.mine(); await w.pass(2); }
  assert.equal(n0.scan.generationOf(K).epoch, EPOCH + 2, 'its record stands: one old holder did not block the reshare');
});

test('key 0 with too few founders left is dead, and one no bond names is retired: neither is reshared (kanban #1050)', async () => {
  const founders = [0, 1, 2, 3].map((i) => person(i).key);
  const censusKey0 = { publicKey: new Uint8Array(32).fill(0x70), holders: founders, threshold: 3 };
  const census = (list, advert) => list.map((i) => ({ pubkey: person(i).key, bondSats: 2n * BOND, txid: new Uint8Array(32).fill(i + 1), vout: 0, advert: { endpoint: `ws://n${i}`, ...advert } }));
  const dead = network([2n, 2n, 2n, 2n, 2n, 2n].map((n) => n * BOND), { entries: census([0, 1, 4, 5], named(censusKey0.publicKey)), censusKey0 });
  await dead.pass();
  assert.deepEqual([(await dead.nodes[0].scan.planAt(EPOCH)).reshare, (await dead.nodes[0].scan.planAt(EPOCH)).dead], [null, 1], 'two of four founders, under its threshold');
  await dead.nodes[0].scan.readDead();
  assert.deepEqual(dead.nodes[0].scan.dead(), [toHex(censusKey0.publicKey)], 'read with the plan, for the owner page');
  assert.deepEqual(dead.nodes[0].scan.status().dead, [toHex(censusKey0.publicKey)]);
  const quiet = network([2n, 2n, 2n, 2n, 2n, 2n].map((n) => n * BOND), { entries: census([0, 1, 2, 4], {}), censusKey0 });
  await quiet.pass();
  const plan = await quiet.nodes[0].scan.planAt(EPOCH);
  assert.deepEqual([plan.reshare, plan.retired, plan.newKey], [null, 1, false], 'named by no bond, so nothing is done for it, and no new key is due');
  // ONE HOLD OUTPUT, OR A BOND WHOSE NODE STEPPED OUT, IS ENOUGH (kanban #1050): the census' namedKeys counts them, and a key is not retired under them
  const held = network([2n, 2n, 2n, 2n, 2n, 2n].map((n) => n * BOND), { entries: census([0, 1, 2, 4], {}), censusKey0, extraNamed: () => ({ [toHex(censusKey0.publicKey)]: 1 }) });
  await held.pass();
  const reading = await held.nodes[0].scan.planAt(EPOCH);
  assert.deepEqual([reading.retired, reading.newKey, reading.reshare.key], [0, true, toHex(censusKey0.publicKey)], 'still named, so still reshared, and a new key is due');
});

test('reshare: no anchor, no reshare. A record of a standing key with no list is refused, and so is a list short of the threshold, late, or for a key the plan does not name', async () => {
  const w = fourThenMoved();
  const key = await firstKey(w);
  await jump(w, resharedStart);
  const n0 = w.nodes[0];
  const id = reshareReadyId({ networkId: NET, key, run: EPOCH + 1 });
  const listOf = (nodes, over = {}) => encodeReshareList({ networkId: NET, key, run: EPOCH + 1, signatures: nodes.map((n) => ({ key: n.key, signature: schnorr.sign(id, n.secret) })).sort((a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1)), ...over });
  const tx = (body) => { const secret = new Uint8Array(32).fill(201); return censusKeyAnchorSpend({ carrier: censusKeyCarrier(secret, body), secret, funding: { txid: '22'.repeat(32), vout: 0, value: 10000n }, output: reshareAnchor(body) }); };
  const read = async () => { w.c.mine(); await n0.scan.pass(); return n0.scan.status().anchors.slice(-1)[0]; };
  w.c.mempool = [anchorTx(fixedRecord({ publicKey: key, epoch: EPOCH + 1, censusHeight: resharedStart - CONF, totalShares: 11, threshold: 8 }), [])];
  assert.match((await read()).why, /no anchor, no reshare/);
  w.c.mempool = [tx(listOf(w.nodes.slice(0, 2)))];
  assert.match((await read()).why, /holders of 4 shares signed that list/);
  const stranger = person(9);
  w.c.mempool = [tx(listOf([...w.nodes.slice(0, 3), stranger]))];
  assert.match((await read()).why, /holds no share/);
  const other = new Uint8Array(32).fill(5);
  w.c.mempool = [tx(listOf(w.nodes.slice(0, 4), { key: other }))];
  assert.match((await read()).why, /reshares/);
  w.c.tip = rw.midpoint;
  w.c.mempool = [tx(listOf(w.nodes.slice(0, 4)))];
  assert.match((await read()).why, /takes one from/);
  assert.equal(n0.scan.reshareList(toHex(key), EPOCH + 1), null);
  const again = listOf(w.nodes.slice(0, 4));
  assert.equal(toHex(reshareListIn(parseTransaction(tx(again)), reshareAnchorIn(parseTransaction(tx(again)).outputs)).key), toHex(key));
});

test('reshare: a dealer that drops out fails the run, nothing is lost, and the next window starts again', async () => {
  const down = [];
  const shape = [2n, 2n, 3n, 4n, 3n].map((n) => n * BOND);
  const everyone = shape.map((bond, i) => ({ ...person(i), bond }));
  let key = null;
  const first = entriesOf(everyone.slice(0, 4));
  const w = network(shape, { entries: first, down, censusAt: (h) => {
    if (h < START + E - CONF || !key) return first;
    const later = entriesOf([0, 1, 3, 4].map((i) => ({ ...everyone[i], advert: i === 4 ? named(key) : {} })));
    for (const e of later) e.advert.endpoint = e.advert.endpoint.replace(/ws:\/\/n(\d)/, (_, x) => `http://n${[0, 1, 3, 4][Number(x)]}`);
    return later;
  } });
  w.setKey = (k) => { key = k; };
  await firstKey(w);
  await jump(w, resharedStart);
  await w.pass(2);
  const K = toHex(key);
  while (!w.c.mempool.some((t) => reshareAnchorIn(parseTransaction(t).outputs))) { w.c.mine(); await w.pass(2); }
  // the list is on its way, and the largest holder, a dealer, stops before it deals
  down.push(3);
  w.c.mine(); await w.pass(2);
  const n0 = w.nodes[0];
  assert.ok(n0.scan.reshareList(K, EPOCH + 1).present.includes(toHex(w.nodes[3].key)), 'present by the chain');
  while (w.c.tip < rw.end + 1) { w.c.mine(); await w.pass(2); }
  await w.pass(2);
  assert.equal(n0.scan.generationOf(K).epoch, EPOCH, 'the old shares stand');
  assert.ok(n0.run.status().reshare.state.failed, 'the run failed by the end of its window');
  assert.ok(n0.store.held(key, EPOCH), 'and every old share is still kept');
  down.length = 0;
  await jump(w, resharedStart + E);
  await w.pass(2);
  assert.equal((await n0.scan.planAt(EPOCH + 2)).reshare.key, K, 'the next window tries again');
  const rw2 = reshareWindow(EPOCH + 2, NETWORK, WINDOW);
  while (!n0.scan.reshareList(K, EPOCH + 2)) { assert.ok(w.c.tip < rw2.midpoint); w.c.mine(); await w.pass(2); }
  await w.to(rw2.midpoint + 1);
  await w.pass(3);
  for (let i = 0; i < CENSUS_KEY_POST_STEP * 4 && n0.scan.generationOf(K).epoch !== EPOCH + 2; i++) { w.c.mine(); await w.pass(2); }
  assert.equal(n0.scan.generationOf(K).epoch, EPOCH + 2);
  assert.equal(RESHARE_POST_STEP, 1);
});

test('the owner hears of a key that fails: closed epochs a key was due and none stands, counted from the chain; an epoch that asked nothing ends the count (5A.3B, kanban #1041)', async () => {
  const nodes = [person(0), person(1), person(2)].map((n) => ({ ...n, bond: BOND }));
  const entries = entriesOf(nodes);
  const c = chain(START);
  const scan = createCensusKeyScan({ store: new CensusKeyStore(openStore(':memory:')), network: NETWORK, networkId: NET, firstHeight: FIRST, foundingWindow: WINDOW, censusConfirmations: CONF, tipHeight: () => c.tip,
    blockHashAt: c.hashAt, blockAt: c.blockAt, censusEntriesAt: () => entries, censusNamedAt: () => ({}), verify, maxBlocksPerPass: 4096, log: () => {} });
  const to = async (h) => { c.mine(h - c.tip); await scan.pass(); return scan.failing(); };
  assert.deepEqual(await to(START + WINDOW - 1), { epochs: 0, since: null, keygen: 0, reshare: 0, warn: false }, 'the window is still open');
  assert.deepEqual(await to(START + WINDOW), { epochs: 1, since: EPOCH, keygen: 1, reshare: 0, warn: false }, 'one failed epoch says nothing yet');
  assert.deepEqual(await to(START + E + WINDOW), { epochs: 2, since: EPOCH, keygen: 2, reshare: 0, warn: true }, 'two in a row do');
  assert.equal(scan.status().failing.epochs, 2);
  const w = censusKeyFailingWarning(scan.failing());
  assert.equal(w.kind, 'census key');
  assert.equal(w.urgent, true);
  assert.match(w.says, /failed 2 epochs in a row, since epoch 3: no new key was made/);
  assert.equal(censusKeyFailingWarning(censusKeyFailing([{ epoch: 9, keygen: true, madeKey: false }])), null);

  // a key stands at epoch 5: the count ends there
  const shares = censusKeyShares({ entries, network: NETWORK });
  const record = fixedRecord({ epoch: 5, censusHeight: 5 * E - CONF, totalShares: shares.total, threshold: shares.threshold });
  c.mine(5 * E + 1 - c.tip);
  c.mempool = [anchorTx(record, signaturesOf(nodes, record))];
  c.mine();
  assert.equal((await to(5 * E + WINDOW)).epochs, 0);
  // and an epoch with a key standing that no bond named asks nothing, so nothing failed
  assert.equal((await to(6 * E + WINDOW)).epochs, 0);
});

test('censusKeyFailing: a reshare that did not finish counts as a key that was not made; a key made ends the count', () => {
  const failed = censusKeyFailing([{ epoch: 8, keygen: false, reshare: true, madeReshare: false }, { epoch: 7, keygen: true, madeKey: false, reshare: true, madeReshare: true }, { epoch: 6, keygen: true, madeKey: true }]);
  assert.deepEqual(failed, { epochs: 2, since: 7, keygen: 1, reshare: 1, warn: true });
  assert.match(censusKeyFailingWarning(failed).says, /no new key was made and a reshare did not finish/);
});

// #1188 THE CENSUS-KEY RUN: NOTHING IRREVERSIBLE BEFORE ITS STATE IS ON DISK. Before: the one try of the anchor per block was kept in memory, so a restart in the same block asked
// the wallet again (a funded carrier whose reveal fails costs its fee), and the shares a reshare replaced went the pass its record was read, so a reorg that took the record off left
// the holder with no share of the key that still stands.
const rankOneOf = (n) => censusKeyPostOrder({ networkId: NET, epoch: EPOCH, holders: censusKeyShares({ entries: entriesOf(Array.from({ length: n }, (_, i) => ({ ...person(i), bond: BOND }))), network: NETWORK }).holders })[0];

test('#1188 a try of the anchor is on disk: a restart in the same block asks the wallet no second time', async () => {
  const rank1 = rankOneOf(4);
  const w = network(Array.from({ length: 4 }, () => BOND), { canPay: (i) => toHex(person(i).key) !== rank1 });
  await w.pass(2);
  await w.to(midpoint + 1);
  await w.pass(3);
  const r1 = w.nodes.find((n) => toHex(n.key) === rank1);
  const before = r1.tried.length;
  assert.ok(before >= 1, 'rank 1 tried, and its wallet could not pay');
  r1.build(); await r1.run.pass(); await r1.run.pass();           // the seat restarts, twice, in the same block
  console.log(`  FACTS #1188: rank 1 tried at ${r1.tried.join(', ')} (tip ${w.c.tip}); after restarts in that block: ${r1.tried.length - before} more`);
  assert.equal(r1.tried.length, before, 'no second try in the block of the first');
  assert.equal(r1.run.status().run.state.anchor.state, 'refused');
  w.c.mine(); await w.pass();
  assert.equal(r1.tried.length, before + 1, 'one try in the next block');
});

test('#1188 an anchor whose answer was never heard waits for the chain: the wallet is not asked again each block', async () => {
  const rank1 = rankOneOf(4);
  const w = network(Array.from({ length: 4 }, () => BOND));
  const r1 = w.nodes.find((n) => toHex(n.key) === rank1);
  const held = [];                                  // what the wallet sent, held back from the blocks until `release`
  r1.build({ post: async ({ body, output }) => {
    r1.tried.push(w.c.tip);
    const secret = new Uint8Array(32).fill(201 + r1.tried.length), carrier = censusKeyCarrier(secret, body);
    held.push(censusKeyAnchorSpend({ carrier, secret, funding: { txid: '22'.repeat(32), vout: r1.tried.length, value: 10000n }, output }));
    throw new Error('the wallet\'s answer was lost');
  } });
  const pass = async () => { for (const n of w.live()) { await n.scan.pass(); await n.run.pass().catch(() => null); } };
  await pass(); await pass();
  while (w.c.tip < midpoint + 1) { w.c.mine(); await pass(); await pass(); }
  for (let i = 0; i < 3; i += 1) await pass();
  const first = r1.tried.length;
  assert.equal(first, 1, 'rank 1 asked its wallet once');
  for (let i = 0; i < 3; i += 1) { w.c.mine(); await pass(); }   // three blocks while the anchor sits unmined
  const meanwhile = r1.tried.length - first;
  w.c.mempool.push(held[0]); w.c.mine(); await pass(); await pass();
  console.log(`  FACTS #1188: the wallet's answer lost; asked again in the 3 blocks before the anchor confirmed: ${meanwhile} times; anchors sent in all: ${held.length}`);
  assert.equal(meanwhile, 0, 'no second carrier while the first may be out');
  assert.ok(w.nodes.every((n) => n.scan.standing().length === 1), 'the first anchor stands');
  assert.equal(r1.run.status().run.state.anchor.state, 'sent');
  w.c.mine(CENSUS_KEY_POST_STEP * 2); await pass();
  assert.equal(held.length, 1, 'and never after');
});

test('#1188 a reorg that takes a reshare\'s record off leaves every old holder its shares', async () => {
  const w = fourThenMoved();
  const key = await firstKey(w);
  await jump(w, resharedStart);
  const n0 = w.nodes[0];
  await w.pass(2);
  while (w.c.tip < rw.ready + 3 && !w.c.mempool.some((t) => reshareAnchorIn(parseTransaction(t).outputs))) { w.c.mine(); await w.pass(2); }
  w.c.mine(); await w.pass(2);
  await w.to(rw.midpoint + 1);
  await w.pass(3);
  for (let i = 0; i < CENSUS_KEY_POST_STEP * 4 && n0.scan.generationOf(toHex(key)).epoch !== EPOCH + 1; i++) { w.c.mine(); await w.pass(2); }
  const g = n0.scan.generationOf(toHex(key));
  assert.equal(g.epoch, EPOCH + 1, 'the record of the new census stands');
  await w.pass(2);
  const keptBefore = [0, 1, 2, 3].map((i) => !!w.nodes[i].store.held(key, EPOCH));
  // THE REORG: from the record's block a branch without it
  w.c.forkAt = g.height; w.c.branch = 'b';
  await w.pass(2);
  assert.equal(n0.scan.generationOf(toHex(key)).epoch, EPOCH, 'off the chain: the old census holds the key again');
  const kept = [0, 1, 2, 3].map((i) => !!w.nodes[i].store.held(key, EPOCH));
  console.log(`  FACTS #1188: old holders keeping their epoch-${EPOCH} shares once the record stood: ${keptBefore.filter(Boolean).length} of 4; after the reorg took it off: ${kept.filter(Boolean).length} of 4`);
  assert.deepEqual(kept, [true, true, true, true], 'every old holder can still sign for the key that stands');
});
