// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEAT'S ARENA INDEX (kanban #925 part 2 step 1): what each reader finds walking whole blocks is in the index, at the same
// height and position, its branch proving into its header; a reorg rolls back and re-reads; the rows survive a reopen; a
// transaction with nothing of Bitcoin Arena in it is not kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openArenaIndex, syncArenaIndex, provesRow, indexFirstHeight, displayHash } from '../src/arena-index.js';
import { candidatesIn, chainFactsAt, chainViewOf } from '../../arena-protocol/src/census.js';
import { arenaKindsOf } from '../../arena-protocol/src/arena-kinds.js';
import { parseTransaction, commitmentsOf } from '../../arena-protocol/src/tx.js';
import { splitBlock } from '../../arena-protocol/src/block.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { publicationOutput, findPublication } from '../../arena-protocol/src/publication.js';
import { seriesPublicationPayload, findSeriesPublication } from '../../arena-protocol/src/series.js';
import { dutyMarkerOutput, dayMarkersOf } from '../../arena-protocol/src/duty.js';
import { encodeVote, CHOICE } from '../../arena-protocol/src/ballot.js';
import { votesInBlock } from '../../arena-protocol/src/ballot-chain.js';
import { reshareAnchor, reshareAnchorIn } from '../../arena-protocol/src/census-key.js';
import { newestUpdates } from '../../arena-protocol/src/advert-update.js';
import { reaffirmedBonds } from '../../arena-protocol/src/reaffirm.js';
import { ancestorMarker, ancestorAdvertId } from '../../arena-protocol/src/ancestor.js';
import { joinSignedAdvert } from '../../arena-protocol/src/advert.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { bondTransaction, advertUpdateTransaction, reaffirmationTransaction, encodeAncestorAdvert } from '../../arena-protocol/tools/bond.js';
import { chainOf } from '../../arena-protocol/tools/chainview.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const advertFor = (n, over = {}) => ({
  nodePubkey: b32(n), operatorId: 'operator', protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'],
  endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32),
  bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
  ...over,
});
const txidOf = (raw) => parseTransaction(raw).txid;
/** A transaction with nothing of Bitcoin Arena in it: one input, one P2WPKH-like output. */
const plain = (n, { txid = b32(0xe0 ^ (n & 0x0f)), vout = n } = {}) => serializeSpend({
  inputs: [{ txid, vout, sequence: 0xffffffff }],
  outputs: [{ value: 5000n + BigInt(n), script: Uint8Array.from([0x00, 0x14, ...new Uint8Array(20).fill(n & 0xff)]) }],
  witnesses: [[new Uint8Array(64).fill(n & 0xff)]],
});
const spend = (txid, vout, n, outputs = 2) => serializeSpend({
  inputs: [{ txid, vout, sequence: 0xffffffff }],
  outputs: Array.from({ length: outputs }, (_, i) => ({ value: 1000n + BigInt(i), script: Uint8Array.from([0x51, 0x20, ...b32(0x30 + n + i)]) })),
  witnesses: [[new Uint8Array(64).fill(n)]],
});
const opReturn = (payload) => ({ value: 0n, script: Uint8Array.from(payload.length <= 75 ? [0x6a, payload.length, ...payload] : [0x6a, 0x4c, payload.length, ...payload]) });
const carrying = (n, outputs) => serializeSpend({ inputs: [{ txid: b32(0x90 + n), vout: n, sequence: 0xffffffff }], outputs, witnesses: [[new Uint8Array(64)]] });

// BLOCKS AS BITCOIND SERVES THEM, for an RPC double: the header, a count, the transactions back to back
const compact = (n) => (n < 0xfd ? [n] : [0xfd, n & 255, n >> 8]);
const rawBlock = (b) => Uint8Array.from([...b.header, ...compact(b.transactions.length), ...b.transactions.flatMap((t) => [...t])]);
function rpcOver(view) {
  const byHash = new Map(view.blocks.map((b) => [displayHash(blockHashOf(b.header)), b]));
  const asked = { getblock: 0 };
  const call = async (method, params) => {
    if (method === 'getblockcount') return view.firstHeight + view.blocks.length - 1;
    if (method === 'getblockhash') { const b = view.blocks[params[0] - view.firstHeight]; if (!b) throw new Error('out of range'); return displayHash(blockHashOf(b.header)); }
    if (method === 'getbestblockhash') return displayHash(blockHashOf(view.blocks[view.blocks.length - 1].header));
    if (method === 'getblock') { asked.getblock++; return toHex(rawBlock(byHash.get(params[0]))); }
    throw new Error(`no ${method} here`);
  };
  return { call, asked };
}

const indexAll = (index, view) => view.blocks.forEach((b, i) => { const got = index.addBlock(view.firstHeight + i, b); assert.equal(got.ok, true, got.why); });
const at = (view) => { const m = new Map(); view.blocks.forEach((b, i) => b.transactions.forEach((raw, position) => m.set(toHex(txidOf(raw)), { height: view.firstHeight + i, position }))); return m; };
/** Every row of the range at the height and position the whole blocks put it, and its branch proving into its header. */
function assertKeptAt(index, view, txids, what) {
  const r = index.range(view.firstHeight, view.firstHeight + view.blocks.length - 1);
  assert.equal(r.ok, true, r.why);
  const where = at(view);
  const rows = new Map(r.transactions.map((x) => [toHex(x.txid), x]));
  const headers = new Map(r.headers.map((h) => [h.height, h.header]));
  for (const t of txids) {
    const row = rows.get(toHex(t));
    assert.ok(row, `${what}: ${toHex(t)} is not in the index`);
    assert.deepEqual({ height: row.height, position: row.position }, where.get(toHex(t)), `${what}: ${toHex(t)} is kept elsewhere`);
    assert.equal(provesRow(row, headers.get(row.height)), true, `${what}: the branch of ${toHex(t)} does not prove`);
  }
  return r;
}

test('(a) on real regtest blocks: every census candidate and every spend of one is kept where the whole blocks have it', () => {
  const CHAIN = JSON.parse(readFileSync(new URL('./fixtures/regtest-census.json', import.meta.url)));
  const view = { blocks: CHAIN.blocks.map((b) => splitBlock(fromHex(b.hex))), firstHeight: CHAIN.firstHeight };
  assert.equal(chainViewOf(view).ok, true);
  const index = openArenaIndex({ network: 'regtest', firstHeight: view.firstHeight });
  indexAll(index, view);

  // THE CENSUS'S OWN WHOLE-BLOCK READING: SCAN's candidates and chainFactsAt's spends, up to the tip
  const heighted = view.blocks.map((b, i) => ({ ...b, height: view.firstHeight + i }));
  const candidates = candidatesIn(heighted, CHAIN.tip, 'regtest');
  const facts = chainFactsAt(heighted, CHAIN.tip);
  const spenders = candidates.map((c) => facts.spentIn.get(`${toHex(c.txid)}:${c.vout}`)).filter(Boolean).map((tx) => tx.txid);
  assert.ok(candidates.length >= 3, `the fixture has its bonds (${candidates.length})`);
  assert.ok(spenders.length >= 1, 'the fixture spends a bond (the slash)');
  const r = assertKeptAt(index, view, [...candidates.map((c) => c.txid), ...spenders], 'census');

  // AND THE SAME READING OVER THE KEPT ROWS ALONE FINDS THE SAME: the same candidates, created and spent at the same heights
  const keptBlocks = view.blocks.map((b, i) => ({ height: view.firstHeight + i, transactions: r.transactions.filter((x) => x.height === view.firstHeight + i).map((x) => x.raw) }));
  const again = candidatesIn(keptBlocks, CHAIN.tip, 'regtest');
  assert.deepEqual(again.map((c) => `${toHex(c.txid)}:${c.vout}`), candidates.map((c) => `${toHex(c.txid)}:${c.vout}`));
  const factsKept = chainFactsAt(keptBlocks, CHAIN.tip);
  for (const c of candidates) {
    const k = `${toHex(c.txid)}:${c.vout}`;
    assert.equal(factsKept.createdAt.get(k), facts.createdAt.get(k), `created ${k}`);
    assert.equal(factsKept.spentAt.get(k), facts.spentAt.get(k), `spent ${k}`);
  }
  const total = view.blocks.reduce((n, b) => n + b.transactions.length, 0);
  const counts = index.counts();
  assert.equal(counts.headers, view.blocks.length);
  // nothing else of the fixture is Bitcoin Arena: coinbases and wallet moves are left out
  assert.equal(counts.transactions, r.transactions.length);
  assert.ok(counts.transactions < total, `kept ${counts.transactions} of ${total}`);
  console.log(`# regtest fixture ${view.firstHeight}-${CHAIN.tip}: ${total} transactions, ${counts.transactions} kept (${candidates.length} bonds, ${spenders.length} spends), ${counts.watched} outputs watched`);
});

// A CHAIN WITH ONE OF EVERY KIND, and each reader's own whole-block function run over it
const BASE = 600;
const bondAdvert = advertFor(0x11);
const bond = bondTransaction(bondAdvert, { previousTxid: b32(0xb1) });
const bondTxid = txidOf(bond);
const ancestorAd = advertFor(0x12, { hostedGames: [] });
const ancestorBody = encodeAncestorAdvert(ancestorAd);
const ancestorBond = bondTransaction(ancestorAd, { previousTxid: b32(0xb2), markerProgram: ancestorMarker('regtest'),
  commitment: ancestorAdvertId(ancestorBody), body: joinSignedAdvert(ancestorBody, new Uint8Array(64)) });
const update = advertUpdateTransaction(advertFor(0x11, { endpoint: 'ws://moved' }), { bondTxid, bondVout: 0 });
const reaffirm = reaffirmationTransaction({ networkId: NETWORK_ID_REGTEST, signature: new Uint8Array(64).fill(7) });
const rid = b32(0x5a), sid = b32(0x5b), pid = b32(0x5c);
const round = carrying(1, [publicationOutput(rid)]);
const series = carrying(2, [opReturn(seriesPublicationPayload(sid)), dutyMarkerOutput(20000, 'rps-day')]);
const vote = carrying(3, [opReturn(encodeVote({ proposalId: pid, choice: CHOICE.YES, signature: new Uint8Array(64).fill(9) }))]);
const reshare = carrying(4, [reshareAnchor(Uint8Array.of(1, 2, 3))]);
const start = spend(bondTxid, 0, 0x41);                    // spends the bond: its output 0 is watched as the hold
const hold = spend(txidOf(start), 0, 0x42);                // spends the hold output
const notHold = spend(txidOf(start), 1, 0x43);             // spends another output of the start: nothing
const blocksA = [
  { transactions: [plain(1)] },
  { transactions: [plain(2), bond, ancestorBond, plain(3)] },
  { transactions: [plain(4), update, reaffirm] },
  { transactions: [plain(5), round, series, vote, reshare] },
  { transactions: [plain(6), start, plain(7)] },
  { transactions: [plain(8), hold, notHold] },
];

test('(a) every reader\'s whole-block finding is in the index; (d) nothing else is', () => {
  const view = chainOf(blocksA, BASE);
  const index = openArenaIndex({ network: 'regtest', firstHeight: BASE });
  indexAll(index, view);
  const tip = BASE + blocksA.length - 1;
  const heighted = view.blocks.map((b, i) => ({ ...b, height: BASE + i }));
  const found = [];
  found.push(...candidatesIn(heighted, tip, 'regtest').map((c) => c.txid));
  assert.equal(found.length, 2, 'this network\'s bond and the ancestor\'s');
  const entries = [{ txid: bondTxid, vout: 0, pubkey: b32(0x11), height: BASE + 1 }];
  const ups = newestUpdates(view, entries, { atHeight: tip, network: 'regtest', verify: () => true });
  assert.equal(ups.size, 1); found.push(...[...ups.values()].map((u) => u.txid));
  const reaff = reaffirmedBonds(view, [{ txid: txidOf(ancestorBond), vout: 0, pubkey: b32(0x12), height: BASE + 1 }], { atHeight: tip, networkId: NETWORK_ID_REGTEST, verify: () => true });
  assert.equal(reaff.size, 1); found.push(...[...reaff.values()].map((x) => x.txid));
  found.push(findPublication(view, rid).tx.txid, findSeriesPublication(view, sid).tx.txid);
  const votes = view.blocks.flatMap((b, i) => votesInBlock(rawBlock(b), BASE + i));
  assert.equal(votes.length, 1); found.push(fromHex(votes[0].txid).reverse());
  const duty = view.blocks.flatMap((b) => b.transactions.filter((raw) => dayMarkersOf(raw).length).map(txidOf));
  assert.equal(duty.length, 1); found.push(...duty);
  const anchors = view.blocks.flatMap((b) => b.transactions.filter((raw) => reshareAnchorIn(parseTransaction(raw).outputs)).map(txidOf));
  assert.equal(anchors.length, 2, 'the reshare anchor, and the round publication - the same 36-byte "ARN" \'R\' push'); found.push(...anchors);
  const facts = chainFactsAt(heighted, tip);
  const spentBond = facts.spentIn.get(`${toHex(bondTxid)}:0`);
  found.push(spentBond.txid, facts.spentIn.get(`${toHex(spentBond.txid)}:0`).txid);
  const r = assertKeptAt(index, view, found, 'readers');

  // (d) exactly those: every plain transaction, and the spend of an output that is no bond and no hold, is left out
  const keptIds = new Set(r.transactions.map((x) => toHex(x.txid)));
  assert.deepEqual([...keptIds].sort(), [...new Set(found.map(toHex))].sort());
  for (const raw of [plain(1), plain(5), plain(8), notHold]) {
    assert.equal(keptIds.has(toHex(txidOf(raw))), false, 'a transaction with nothing of Bitcoin Arena is kept');
    assert.deepEqual(arenaKindsOf(parseTransaction(raw), 'regtest').kinds, []);
  }
  const kindsOf = (raw) => r.transactions.find((x) => toHex(x.txid) === toHex(txidOf(raw))).kinds;
  assert.deepEqual(kindsOf(bond), ['bond']);
  assert.deepEqual(kindsOf(update), ['update']);
  assert.deepEqual(kindsOf(series), ['duty', 'series']);
  assert.deepEqual(kindsOf(start), ['spend']);
  assert.equal(index.watchedKind(bondTxid, 0), 'bond');
  assert.equal(index.watchedKind(txidOf(start), 0), 'hold');
  assert.equal(index.watchedKind(txidOf(start), 1), null);
  // a header is kept for every height, a block with nothing kept too
  assert.equal(r.headers.length, blocksA.length);
  assert.equal(r.transactions.filter((x) => x.height === BASE).length, 0);
});

test('(b) a reorg rolls the rows back from the fork height and reads the new branch', async () => {
  const viewA = chainOf(blocksA, BASE);
  const index = openArenaIndex({ network: 'regtest', firstHeight: BASE });
  indexAll(index, viewA);
  // THE OTHER BRANCH forks at BASE + 3: the round, series, vote and reshare are gone, the bond is spent by another transaction,
  // and it is one block longer
  const other = spend(bondTxid, 0, 0x51);
  const blocksB = [...blocksA.slice(0, 3), { transactions: [plain(9), other] }, { transactions: [plain(10)] }, { transactions: [plain(11)] }, { transactions: [plain(12), vote] }];
  const viewB = chainOf(blocksB, BASE);
  for (let i = 0; i < 3; i++) assert.deepEqual(viewB.blocks[i].header, viewA.blocks[i].header, 'the branches share their first three blocks');

  // a block of the other branch does not follow what the index holds: refused, nothing added
  const refused = index.addBlock(BASE + 6, viewB.blocks[6]);
  assert.equal(refused.reorg, true);
  assert.equal(index.top().height, BASE + 5);

  const { call, asked } = rpcOver(viewB);
  const got = await syncArenaIndex(index, call);
  assert.equal(got.rolledBackFrom, BASE + 3);
  assert.equal(got.added, 4);
  assert.equal(asked.getblock, 4, 'only the new branch\'s blocks are read');
  assert.equal(got.top, BASE + 6);

  // the rows are exactly those of an index that only ever saw the other branch
  const fresh = openArenaIndex({ network: 'regtest', firstHeight: BASE });
  indexAll(fresh, viewB);
  const rows = (ix) => { const r = ix.range(BASE, BASE + 6); assert.equal(r.ok, true, r.why); return r; };
  assert.deepEqual(rows(index), rows(fresh));
  assert.equal(index.transaction(txidOf(round)), null, 'the round of the old branch is gone');
  assert.equal(index.watchedKind(txidOf(start), 0), null, 'the old branch\'s hold output is no longer watched');
  assert.equal(index.watchedKind(txidOf(other), 0), 'hold');
  assertKeptAt(index, viewB, [bondTxid, txidOf(other), txidOf(vote)], 'after the reorg');

  // and a sync with nothing new reads nothing
  const again = await syncArenaIndex(index, call);
  assert.deepEqual([again.added, again.rolledBackFrom, asked.getblock], [0, null, 4]);
});

test('(c) the rows survive a reopen; another network or first height starts empty; a row that does not prove asks for a rebuild', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-index-'));
  try {
    const path = join(dir, 'index.db');
    const view = chainOf(blocksA, BASE);
    const first = openArenaIndex({ path, network: 'regtest', firstHeight: BASE });
    indexAll(first, view);
    const before = first.range(BASE, BASE + 5);
    first.close();

    const reopened = openArenaIndex({ path, network: 'regtest', firstHeight: BASE });
    assert.equal(reopened.top().height, BASE + 5);
    assert.deepEqual(reopened.range(BASE, BASE + 5), before);
    assert.equal(reopened.watchedKind(bondTxid, 0), 'bond', 'the watched outputs come back with the rows');
    // a block after the reopen still finds the spend of a bond watched before it
    const more = chainOf([...blocksA, { transactions: [plain(13), spend(txidOf(ancestorBond), 0, 0x61)] }], BASE);
    assert.equal(reopened.addBlock(BASE + 6, more.blocks[6]).ok, true);
    assert.equal(reopened.range(BASE + 6, BASE + 6).transactions.length, 1);

    // A ROW THAT DOES NOT PROVE, for no known reason: refused, and the next sync starts from the first block
    reopened.db.prepare('UPDATE arena_index_txs SET branch = ? WHERE txid = ?').run(new Uint8Array(32 * 2), bondTxid);
    const bad = reopened.range(BASE, BASE + 6);
    assert.equal(bad.ok, false); assert.equal(bad.rebuild, true);
    assert.equal(reopened.needsRebuild(), true);
    const { call } = rpcOver(more);
    const got = await syncArenaIndex(reopened, call);
    assert.equal(got.rebuilt, true); assert.equal(got.added, 7);
    assert.equal(reopened.range(BASE, BASE + 6).ok, true);
    reopened.close();

    const elsewhere = openArenaIndex({ path, network: 'regtest', firstHeight: BASE + 1 });
    assert.equal(elsewhere.top(), null, 'another first height starts empty');
    elsewhere.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('each network\'s index starts at its census\'s first block', () => {
  assert.equal(indexFirstHeight('testnet4'), 156036);
  assert.equal(indexFirstHeight('regtest'), 0);
  assert.equal(indexFirstHeight('mainnet', { genesisHeight: 950000 }), 950000);
  assert.throws(() => indexFirstHeight('mainnet'), /genesis_height/);
  assert.throws(() => indexFirstHeight('signet'), /no census rule/);
});
