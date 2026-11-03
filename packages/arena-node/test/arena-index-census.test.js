// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS FROM THE SEAT'S INDEX (kanban #925 part 2, steps 2 and 3): the proven partial view the index gives is a chain view
// chainViewOf accepts only as this module built it, and the census a seat derives from it (roster.js censusOfView, main.js's path)
// is the census it derives from whole blocks - the same root, the same entries, the same exclusions and the same evidence - on the
// real regtest fixture, on a testnet4 chain read from its first census block (156,036) at census heights past 158,226, and across a
// reorganisation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openArenaIndex, syncArenaIndex, indexServesCensus, displayHash } from '../src/arena-index.js';
import { censusOfView, censusEvidenceOf } from '../src/roster.js';
import { bondSetFor, tweakPoint, combine } from '../src/curve.js';
import { chainViewOf, censusFirstBlock, partialViewOf, isPartialBlock } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { splitBlock } from '../../arena-protocol/src/block.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { publicationOutput } from '../../arena-protocol/src/publication.js';
import { bondOutputKey, bondInternalKey } from '../../arena-protocol/src/bond-script.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { advertId, joinSignedAdvert } from '../../arena-protocol/src/advert.js';
import { ancestorMarker, ancestorAdvertId } from '../../arena-protocol/src/ancestor.js';
import { reaffirmationMessage } from '../../arena-protocol/src/reaffirm.js';
import { PROTOCOL_VERSION } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { bondTransaction, advertUpdateTransaction, reaffirmationTransaction, encodeAncestorAdvert } from '../../arena-protocol/tools/bond.js';
import { chainOf } from '../../arena-protocol/tools/chainview.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const keyOf = (n) => schnorr.getPublicKey(b32(n));
const txidOf = (raw) => parseTransaction(raw).txid;
const advertFor = (n, over = {}) => ({
  nodePubkey: keyOf(n), operatorId: 'operator', protocolVersions: [PROTOCOL_VERSION],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'verify', 'settlement'], endpoint: `wss://node${n}.example/`, region: 'eu-west',
  capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [],
  guardianCapable: false, guardianEndpoint: '', timestamp: 1788700000000n, ...over,
});
const outputKeyOf = (net, nodeKey) => {
  const g = genesisFor(net);
  return bondOutputKey({ nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: g.bondMaturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine }).outputKey;
};
const plain = (n) => serializeSpend({
  inputs: [{ txid: b32(0xe0), vout: n, sequence: 0xffffffff }],
  outputs: [{ value: 5000n, script: Uint8Array.from([0x00, 0x14, ...new Uint8Array(20).fill(n & 0xff)]) }],
  witnesses: [[new Uint8Array(64)]],
});
const spend = (txid, vout, n) => serializeSpend({
  inputs: [{ txid, vout, sequence: 0xffffffff }],
  outputs: [{ value: 99000n, script: Uint8Array.from([0x51, 0x20, ...b32(0x30 + n)]) }],
  witnesses: [[new Uint8Array(64).fill(n)]],
});

/**
 * One network's Arena transactions: three bonds of this network (one old - below a 2016-block window of the census -, one updated
 * later, one spent), one shallow bond, an ancestor's bond re-affirmed, a round's publication. `at(name)` places them.
 */
function arenaOf(net, networkId) {
  const bond = (n, prev) => {
    const ad = advertFor(n);
    return bondTransaction(ad, { network: net === 'testnet4' ? 'testnet' : net, signature: schnorr.sign(advertId(ad), b32(n)),
      outputKey: outputKeyOf(net, keyOf(n)), previousTxid: b32(prev), value: 100000 });
  };
  const old = bond(0x21, 0xa1), updated = bond(0x22, 0xa2), spent = bond(0x23, 0xa3), shallow = bond(0x24, 0xa4);
  const upAd = advertFor(0x22, { endpoint: 'wss://moved.example/', timestamp: 1790000000000n });
  const update = advertUpdateTransaction(upAd, { network: net === 'testnet4' ? 'testnet' : net, bondTxid: txidOf(updated), bondVout: 0, signature: schnorr.sign(advertId(upAd), b32(0x22)) });
  const ancAd = advertFor(0x25, { hostedGames: [] });
  const ancBody = encodeAncestorAdvert(ancAd), ancId = ancestorAdvertId(ancBody);
  const ancestor = bondTransaction(ancAd, { commitment: ancId, body: joinSignedAdvert(ancBody, schnorr.sign(ancId, b32(0x25))),
    markerProgram: ancestorMarker(net), outputKey: outputKeyOf(net, keyOf(0x25)), previousTxid: b32(0xa5), value: 100000 });
  const reaffirm = reaffirmationTransaction({ networkId, network: net === 'testnet4' ? 'testnet' : net, previousTxid: b32(0xb5),
    signature: schnorr.sign(reaffirmationMessage({ networkId, bondTxid: txidOf(ancestor), bondVout: 0 }), b32(0x25)) });
  const slash = spend(txidOf(spent), 0, 0x41);
  const round = serializeSpend({ inputs: [{ txid: b32(0x5a), vout: 0, sequence: 0xffffffff }], outputs: [publicationOutput(b32(0x5b))], witnesses: [[new Uint8Array(64)]] });
  return { old, updated, spent, shallow, update, ancestor, reaffirm, slash, round };
}

/** A mined chain from `first` to `tip`, every block a filler transaction plus whatever `put` places at its height. */
function chainWith(first, tip, put) {
  const blocks = [];
  for (let h = first; h <= tip; h++) blocks.push({ transactions: [plain(h - first), ...(put[h] || [])] });
  return chainOf(blocks, first);
}

const verifyStrip = (out) => ({
  ok: out.ok, why: out.why, root: out.root && toHex(out.root),
  entries: (out.entries || []).map((e) => `${toHex(e.txid)}:${e.vout}:${toHex(e.pubkey)}:${e.height}:${e.updatedBy ? toHex(e.updatedBy.txid) + '@' + e.updatedBy.height + '#' + e.updatedBy.position : '-'}`),
  excluded: (out.excluded || []).map((e) => `${e.step}|${toHex(e.txid)}|${e.why}`).sort(),
});

/** The census both ways - whole blocks, and the index's partial view - for `contract`, asserted the same; answers both. */
function bothWays(index, whole, contract, net) {
  const from = censusFirstBlock(contract.censusHeight, net);
  const tipOf = whole.firstHeight + whole.blocks.length - 1;
  const wholeView = { blocks: whole.blocks.slice(from - whole.firstHeight), firstHeight: from };
  const partial = index.viewOf(from, tipOf);
  assert.equal(partial.blocks.every(isPartialBlock), true);
  const a = censusOfView(wholeView, contract, { network: net });
  const b = censusOfView(partial, contract, { network: net });
  assert.equal(a.ok, true, a.why);
  assert.deepEqual(verifyStrip(b), verifyStrip(a), `census ${contract.censusHeight} differs between whole blocks and the index`);
  const ea = censusEvidenceOf(a, wholeView), eb = censusEvidenceOf(b, partial);
  assert.equal(ea.ok, true, ea.why);
  assert.deepEqual(eb, ea, 'the evidence (transactions, positions, branches) differs');
  const kept = partial.blocks.reduce((n, x) => n + x.transactions.length, 0), all = wholeView.blocks.reduce((n, x) => n + x.transactions.length, 0);
  return { a, b, kept, all, blocks: wholeView.blocks.length };
}

test('a proven partial view: every kept transaction proved into its header; a forged, misplaced or foreign partial block is refused', () => {
  const A = arenaOf('regtest', NETWORK_ID_REGTEST);
  const view = chainWith(0, 20, { 3: [A.old, A.round], 5: [A.updated] });
  const index = openArenaIndex({ network: 'regtest' });
  view.blocks.forEach((b, i) => assert.equal(index.addBlock(i, b).ok, true));
  const partial = index.viewOf(0, 20);
  const checked = chainViewOf(partial), wholeChecked = chainViewOf(view);
  assert.equal(checked.ok, true, checked.why);
  assert.deepEqual([checked.tipHeight, checked.work], [wholeChecked.tipHeight, wholeChecked.work]);
  assert.deepEqual(checked.blocks[3].positions, [1, 2]);

  const again = () => index.viewOf(0, 20);
  // a transaction's bytes changed (its first input's outpoint: the txid covers it, as it covers no witness byte): not the one its branch proves
  const forged = again(); const raw = Uint8Array.from(forged.blocks[3].transactions[0]); raw[10] ^= 1; forged.blocks[3].transactions[0] = raw;
  assert.match(chainViewOf(forged).why, /does not contain the transaction offered at position 1/);
  // the right transaction at another position
  const moved = again(); moved.blocks[5].positions[0] = 0;
  assert.match(chainViewOf(moved).why, /does not contain the transaction offered at position 0/);
  // a partial block nobody's index made (a copy, as JSON would hand one over): refused, not read as an omission
  const copied = again(); copied.blocks[3] = { ...copied.blocks[3] };
  assert.match(chainViewOf(copied).why, /only a seat's own index/);
  // and a header left out is no chain, as for whole blocks
  const gap = again(); gap.blocks.splice(7, 1);
  assert.match(chainViewOf(gap).why, /not a chain/);
  // a partial view of a range the index does not hold is no view
  assert.throws(() => index.viewOf(0, 21), /holds up to 20/);
  assert.throws(() => partialViewOf({ firstHeight: 0, headers: [] }), /an index range/);
});

test('the regtest fixture: the census from the index is the census from whole blocks, root and evidence', () => {
  const CHAIN = JSON.parse(readFileSync(new URL('./fixtures/regtest-census.json', import.meta.url)));
  const view = { blocks: CHAIN.blocks.map((b) => splitBlock(fromHex(b.hex))), firstHeight: CHAIN.firstHeight };
  const index = openArenaIndex({ network: 'regtest', firstHeight: CHAIN.firstHeight });
  view.blocks.forEach((b, i) => assert.equal(index.addBlock(CHAIN.firstHeight + i, b).ok, true));
  // the fixture starts at 103, not at regtest's first block: its census is read from there, both ways
  const contract = { bondMinSats: 1000000n, protocolVersion: 1, networkId: NETWORK_ID_REGTEST, censusHeight: CHAIN.censusHeight, censusConfirmations: 6 };
  const wholeView = view, partial = index.viewOf(CHAIN.firstHeight, CHAIN.tip);
  const a = censusOfView(wholeView, contract, { network: 'regtest' });
  const b = censusOfView(partial, contract, { network: 'regtest' });
  assert.equal(a.ok, true, a.why);
  assert.equal(toHex(a.root), CHAIN.root, 'the whole-block census is the fixture\'s');
  assert.deepEqual(verifyStrip(b), verifyStrip(a));
  assert.deepEqual(censusEvidenceOf(b, partial), censusEvidenceOf(a, wholeView));
  console.log(`# regtest fixture census ${CHAIN.censusHeight}: root ${CHAIN.root.slice(0, 16)} both ways, ${a.entries.length} entr${a.entries.length === 1 ? 'y' : 'ies'}, ${a.excluded.length} excluded`);
});

test('regtest from block 0: bonds, an update, a spend, an ancestor re-affirmed - the same census at every height, both ways', () => {
  const A = arenaOf('regtest', NETWORK_ID_REGTEST);
  const view = chainWith(0, 70, { 4: [A.old, A.ancestor], 20: [A.updated, A.spent], 30: [A.update, A.round], 40: [A.slash, A.reaffirm], 63: [A.shallow] });
  const index = openArenaIndex({ network: 'regtest' });
  view.blocks.forEach((b, i) => assert.equal(index.addBlock(i, b).ok, true));
  const roots = [];
  for (const censusHeight of [25, 35, 45, 70]) {
    assert.equal(indexServesCensus('regtest', censusHeight), true);
    const { a } = bothWays(index, view, { gameId: NEXTBLOCK_GAME_ID, bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION, censusHeight, censusConfirmations: 6, networkId: NETWORK_ID_REGTEST }, 'regtest');
    // the update (block 30) is applied from 35 on, and the same way both ways (bothWays compares updatedBy, its height and position)
    assert.equal(a.entries.some((e) => e.updatedBy && e.updatedBy.height === 30), censusHeight >= 35);
    roots.push(`${censusHeight}:${a.entries.length}:${toHex(a.root).slice(0, 12)}`);
  }
  // the chain moves the census: the spend and the re-affirmation (45), the shallow bond once deep (70)
  assert.ok(new Set(roots.map((r) => r.split(':')[2])).size >= 3, roots.join(' '));
  console.log(`# regtest 0-70 censuses (height:entries:root): ${roots.join(' ')}`);
});

test('testnet4 from 156,036: a bond older than 2016 blocks is in the census at 158,240, the same both ways; below 158,226 the index does not serve', () => {
  const A = arenaOf('testnet4', NETWORK_ID_TESTNET4);
  const FIRST = 156036, CENSUS = 158240, TIP = 158246;
  const view = chainWith(FIRST, TIP, { [FIRST + 3]: [A.old, A.ancestor], [CENSUS - 100]: [A.updated, A.spent], [CENSUS - 50]: [A.update, A.round],
    [CENSUS - 30]: [A.slash], [CENSUS - 20]: [A.reaffirm], [CENSUS - 2]: [A.shallow] });
  const index = openArenaIndex({ network: 'testnet4' });
  assert.equal(index.firstHeight, FIRST);
  view.blocks.forEach((b, i) => assert.equal(index.addBlock(FIRST + i, b).ok, true));
  assert.equal(indexServesCensus('testnet4', 158225), false);
  assert.equal(indexServesCensus('testnet4', 158226), true);
  const contract = { gameId: NEXTBLOCK_GAME_ID, bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION, censusHeight: CENSUS, censusConfirmations: 6, networkId: NETWORK_ID_TESTNET4 };
  const { a, kept, all, blocks } = bothWays(index, view, contract, 'testnet4');
  const counted = a.entries.map((e) => toHex(e.pubkey));
  assert.ok(counted.includes(toHex(keyOf(0x21))), 'the bond from 156,039 is counted');
  assert.ok(counted.includes(toHex(keyOf(0x22))) && counted.includes(toHex(keyOf(0x25))));
  assert.ok(!counted.includes(toHex(keyOf(0x23))) && !counted.includes(toHex(keyOf(0x24))), 'the spent and the shallow bond are not');
  console.log(`# testnet4 census ${CENSUS}: ${blocks} blocks, ${all} transactions whole, ${kept} kept; root ${toHex(a.root).slice(0, 16)} both ways, ${a.entries.length} entries`);
});

// AN RPC DOUBLE over a list of views, switched between them, for the reorg below
const compact = (n) => (n < 0xfd ? [n] : [0xfd, n & 255, n >> 8]);
const rawBlock = (b) => Uint8Array.from([...b.header, ...compact(b.transactions.length), ...b.transactions.flatMap((t) => [...t])]);
function rpcOver(holder) {
  return async (method, params) => {
    const view = holder.view;
    if (method === 'getblockcount') return view.firstHeight + view.blocks.length - 1;
    if (method === 'getblockhash') return displayHash(blockHashOf(view.blocks[params[0] - view.firstHeight].header));
    if (method === 'getbestblockhash') return displayHash(blockHashOf(view.blocks[view.blocks.length - 1].header));
    if (method === 'getblock') return toHex(rawBlock(view.blocks.find((b) => displayHash(blockHashOf(b.header)) === params[0])));
    throw new Error(`no ${method}`);
  };
}

test('a reorganisation: the index follows it, and the census after it is the new branch\'s, both ways', async () => {
  const A = arenaOf('regtest', NETWORK_ID_REGTEST);
  const put = { 4: [A.old], 20: [A.updated, A.spent], 30: [A.update], 40: [A.slash] };
  const before = chainWith(0, 50, put);
  // the other branch from 28: no update, no spend - and the shallow bond deep instead
  const blocksB = [];
  for (let h = 0; h <= 52; h++) blocksB.push({ transactions: h < 28 ? [plain(h), ...(put[h] || [])] : [plain(1000 + h), ...(h === 31 ? [A.shallow] : [])] });
  const after = chainOf(blocksB, 0);
  for (let h = 0; h < 28; h++) assert.deepEqual(after.blocks[h].header, before.blocks[h].header);
  const holder = { view: before };
  const call = rpcOver(holder);
  const index = openArenaIndex({ network: 'regtest' });
  await syncArenaIndex(index, call);
  const contract = { gameId: NEXTBLOCK_GAME_ID, bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION, censusHeight: 45, censusConfirmations: 6, networkId: NETWORK_ID_REGTEST };
  const one = bothWays(index, before, contract, 'regtest');
  holder.view = after;
  const got = await syncArenaIndex(index, call);
  assert.equal(got.rolledBackFrom, 28);
  const two = bothWays(index, after, contract, 'regtest');
  assert.notEqual(toHex(two.a.root), toHex(one.a.root), 'the reorganisation changes the census');
  assert.equal(two.a.entries.length, 4, 'old, updated (never updated now), the bond never spent, and the shallow one deep');
  console.log(`# reorg at 28: census 45 ${toHex(one.a.root).slice(0, 12)} (${one.a.entries.length}) -> ${toHex(two.a.root).slice(0, 12)} (${two.a.entries.length}), both ways`);
});
