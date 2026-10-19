// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CENSUS OVER REAL BLOCKS SAYS WHICH NODES ARE GUARDIANS, off the adverts their bonds carry (spec §5A.1 v4.6.4,
// §23A.2 one node is one guardian, drawn from the guardian-capable census). The blocks are the ones
// tools/census-regtest.mjs recorded (fixtures/regtest-census.json), where the honest node's bond says it is a guardian
// and the others' do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveCensus, resolveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { splitBlock } from '../../arena-protocol/src/block.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { BOND } from './curve.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const CHAIN = JSON.parse(readFileSync(new URL('./fixtures/regtest-census.json', import.meta.url)));
const blocks = CHAIN.blocks.map((b) => splitBlock(fromHex(b.hex)));
const view = { blocks, firstHeight: CHAIN.firstHeight };
const contract = {
  bondMinSats: 1000000n, protocolVersion: 1, networkId: NETWORK_ID_REGTEST,
  censusHeight: CHAIN.censusHeight, censusConfirmations: 6,
};
const byTxid = new Map();
for (const block of blocks) for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
const resolve = (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; };
const whoIs = (pubkey) => Object.keys(CHAIN.nodes).find((k) => CHAIN.nodes[k].pubkey === toHex(pubkey));

test('the census of real blocks lists the guardian node as guardian-capable, with its own endpoint', () => {
  const out = deriveCensus(view, { contract, resolve, bond: BOND });
  assert.equal(out.ok, true, out.why);
  assert.equal(out.entries.length, 1);
  const [honest] = out.entries;
  assert.equal(whoIs(honest.pubkey), 'honest');
  assert.equal(honest.advert.guardianCapable, true);
  assert.equal(honest.advert.guardianEndpoint, 'ws://honest/guardian');
});

test('and a node whose bond does not say so is not listed as a guardian', () => {
  // the same bonds read without a view, so the non-guardians' adverts are in the list too
  const listed = ['honest', 'doomed', 'shallow'].map((who) => ({
    txid: fromHex(CHAIN.nodes[who].txid).reverse(), vout: 0, pubkey: fromHex(CHAIN.nodes[who].pubkey),
    bondSats: 50000000n, height: CHAIN.funded, spent: false, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'],
  }));
  const read = resolveCensus(listed, { contract, resolve, bond: BOND });
  assert.equal(read.ok, true, read.why);
  const capable = Object.fromEntries(read.eligible.map((e) => [whoIs(e.pubkey), e.advert.guardianCapable]));
  assert.deepEqual(capable, { honest: true, doomed: false, shallow: false });
  for (const e of read.eligible.filter((x) => whoIs(x.pubkey) !== 'honest')) assert.equal(e.advert.guardianEndpoint, '');
});

// THE CENSUS READS THE NEWEST ADVERTISEMENT (§5A.2; 2026-09-28, the advertisement-update letter: "the node
// census: read the newest update, not the original bond advert"). One block on top of the recorded chain carries an
// update of the honest bond naming a new guardian key; with the census height there, the honest entry is the same bond
// with the updated advertisement. The fixture holds no node secret, so the signature check is the test's: an update
// the check refuses is not applied, and the bond's own advertisement stands.
test('an update of the honest bond at or below the census height replaces its advertisement; a refused one does not', async () => {
  const { advertUpdateTransaction, blockOf } = await import('../../arena-protocol/tools/bond.js');
  const { hash256 } = await import('../../arena-protocol/src/tx.js');
  const { blockHashOf } = await import('../../arena-protocol/src/chain.js');
  const base = deriveCensus(view, { contract, resolve, bond: BOND });
  const honest = base.entries[0];
  const newKey = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x7a)]);
  const fed = new Uint8Array(32).fill(0x33);
  const a = { ...honest.advert, guardianOf: [{ federationId: fed, guardianKey: newKey }], timestamp: 1790000000000n };
  const tx = advertUpdateTransaction(a, { bondTxid: honest.txid, bondVout: honest.vout, signature: new Uint8Array(64).fill(1) });
  const last = blocks.at(-1).header;
  const time = new DataView(last.buffer, last.byteOffset).getUint32(68, true) + 600;
  const { header } = blockOf(hash256, [parseTransaction(tx).txid], { previous: blockHashOf(last), time });
  const tipHeight = view.firstHeight + blocks.length;
  const longer = { blocks: [...blocks, { header, transactions: [tx] }], firstHeight: view.firstHeight };
  const at = { ...contract, censusHeight: tipHeight };
  const seen = [];
  const applied = deriveCensus(longer, { contract: at, resolve, bond: BOND, verifyUpdate: (sig, msg, key) => { seen.push(toHex(key)); return true; } });
  assert.equal(applied.ok, true, applied.why);
  const e = applied.entries.find((x) => whoIs(x.pubkey) === 'honest');
  assert.deepEqual(e.advert.guardianOf[0].guardianKey, newKey, 'the census names the updated guardian key');
  assert.equal(toHex(e.txid), toHex(honest.txid), 'the same bond');
  assert.equal(e.updatedBy.height, tipHeight);
  assert.deepEqual(seen, [CHAIN.nodes.honest.pubkey], 'the update is checked against the bond\'s own node key');
  const refused = deriveCensus(longer, { contract: at, resolve, bond: BOND, verifyUpdate: () => false });
  const kept = refused.entries.find((x) => whoIs(x.pubkey) === 'honest');
  assert.equal(kept.advert.guardianCapable, true);
  assert.equal(kept.advert.guardianOf.length, honest.advert.guardianOf.length, 'a refused update leaves the bond\'s own advertisement');
  assert.equal(kept.updatedBy, undefined);
  // and an update above the census height is not read
  const early = deriveCensus(longer, { contract: { ...at, censusHeight: tipHeight - 1 }, resolve, bond: BOND, verifyUpdate: () => true });
  assert.equal(early.entries.find((x) => whoIs(x.pubkey) === 'honest').updatedBy, undefined);
});

// 2026.0.2 (measured 2026-10-13 05:20Z on testnet4): THE VERSION IS THE NEWEST ADVERTISEMENT'S. Every node announced
// version 2 in an update; the first v2 grid's census came out empty, because the version was asked of the bond's first
// advertisement before the update was applied. An update to [1, 2] now puts the node into a v2 census; without it, not.
test('a v2 census counts a node whose update announces version 2, and not one whose bond alone speaks version 1', async () => {
  const { advertUpdateTransaction, blockOf } = await import('../../arena-protocol/tools/bond.js');
  const { hash256 } = await import('../../arena-protocol/src/tx.js');
  const { blockHashOf } = await import('../../arena-protocol/src/chain.js');
  const honest = deriveCensus(view, { contract, resolve, bond: BOND }).entries[0];
  assert.deepEqual(honest.advert.protocolVersions, [1]);
  const tx = advertUpdateTransaction({ ...honest.advert, protocolVersions: [1, 2], timestamp: 1790000000000n },
    { bondTxid: honest.txid, bondVout: honest.vout, signature: new Uint8Array(64).fill(1) });
  const last = blocks.at(-1).header;
  const time = new DataView(last.buffer, last.byteOffset).getUint32(68, true) + 600;
  const { header } = blockOf(hash256, [parseTransaction(tx).txid], { previous: blockHashOf(last), time });
  const longer = { blocks: [...blocks, { header, transactions: [tx] }], firstHeight: view.firstHeight };
  const v2 = { ...contract, protocolVersion: 2, censusHeight: view.firstHeight + blocks.length };
  const updated = deriveCensus(longer, { contract: v2, resolve, bond: BOND, verifyUpdate: () => true });
  assert.equal(updated.ok, true, updated.why);
  assert.deepEqual(updated.entries.map((e) => whoIs(e.pubkey)), ['honest']);
  assert.deepEqual(updated.entries[0].advert.protocolVersions, [1, 2]);
  const notUpdated = deriveCensus(view, { contract: { ...contract, protocolVersion: 2 }, resolve, bond: BOND, verifyUpdate: () => true });
  assert.equal(notUpdated.entries.length, 0);
  assert.match(notUpdated.excluded.find((x) => whoIs(x.pubkey) === 'honest').why, /speaks 1 and this round runs 2/);
  // PROTOCOL TOO OLD, BY NAME (scope 3): the exclusion says so, with what the node speaks
  const out = notUpdated.excluded.find((x) => whoIs(x.pubkey) === 'honest');
  assert.equal(out.tooOld, true); assert.deepEqual(out.speaks, [1]);
  // and an update that still speaks 1 only is too old the same way, through the update
  const tx1 = advertUpdateTransaction({ ...honest.advert, protocolVersions: [1], timestamp: 1790000000001n },
    { bondTxid: honest.txid, bondVout: honest.vout, signature: new Uint8Array(64).fill(1) });
  const { header: h1 } = blockOf(hash256, [parseTransaction(tx1).txid], { previous: blockHashOf(last), time });
  const still1 = deriveCensus({ blocks: [...blocks, { header: h1, transactions: [tx1] }], firstHeight: view.firstHeight }, { contract: v2, resolve, bond: BOND, verifyUpdate: () => true });
  const out1 = still1.excluded.find((x) => whoIs(x.pubkey) === 'honest');
  console.log('  TOO OLD:', JSON.stringify({ step: out1.step, tooOld: out1.tooOld, speaks: out1.speaks, why: out1.why }));
  assert.equal(out1.tooOld, true); assert.equal(out1.step, 'update'); assert.match(out1.why, /update speaks 1 and this round runs 2/);
});

// STEPPING OUT WITHOUT UNBONDING (§5A.3, RULED 2026-09-28): an advertisement update with serving = false takes the
// node out of every census at or above its block, its bond untouched; one with serving = true brings it back the same way. The
// advertisement bytes of a serving node are what they were.
test('an update saying serving = false steps the node out of the census from its block on; serving = true brings it back', async () => {
  const { advertUpdateTransaction, blockOf } = await import('../../arena-protocol/tools/bond.js');
  const { hash256 } = await import('../../arena-protocol/src/tx.js');
  const { blockHashOf } = await import('../../arena-protocol/src/chain.js');
  const { encodeAdvert, decodeAdvert, NOT_SERVING_MARKER } = await import('../../arena-protocol/src/advert.js');
  const honest = deriveCensus(view, { contract, resolve, bond: BOND }).entries[0];
  // the bytes: serving is no bytes, serving = false one marker byte last
  const serving = encodeAdvert(honest.advert), out = encodeAdvert({ ...honest.advert, serving: false });
  assert.deepEqual(encodeAdvert({ ...honest.advert, serving: true }), serving);
  assert.deepEqual(out.subarray(0, serving.length), serving); assert.equal(out.length, serving.length + 1); assert.equal(out.at(-1), NOT_SERVING_MARKER);
  assert.equal(decodeAdvert(serving).serving, undefined, 'a serving node decodes as it always did'); assert.equal(decodeAdvert(out).serving, false);
  const last = blocks.at(-1).header;
  const time = new DataView(last.buffer, last.byteOffset).getUint32(68, true) + 600;
  const withUpdate = (adv, ts, prev = last, more = []) => {
    const tx = advertUpdateTransaction({ ...adv, timestamp: ts }, { bondTxid: honest.txid, bondVout: honest.vout, signature: new Uint8Array(64).fill(1) });
    const { header } = blockOf(hash256, [parseTransaction(tx).txid], { previous: blockHashOf(prev), time: time + more.length * 600 });
    return { header, transactions: [tx] };
  };
  const b1 = withUpdate({ ...honest.advert, serving: false }, 1790000000000n);
  const stepped = { blocks: [...blocks, b1], firstHeight: view.firstHeight };
  const at = { ...contract, censusHeight: view.firstHeight + blocks.length };
  const gone = deriveCensus(stepped, { contract: at, resolve, bond: BOND, verifyUpdate: () => true });
  const left = gone.excluded.find((x) => whoIs(x.pubkey) === 'honest');
  console.log('  STEPPED OUT:', JSON.stringify({ notServing: left && left.notServing, why: left && left.why }));
  assert.equal(gone.entries.some((e) => whoIs(e.pubkey) === 'honest'), false, 'a node that stepped out is in the census');
  assert.equal(left.notServing, true); assert.match(left.why, /serving = false: its node stepped out of the census, its bond untouched/);
  // a census below the update's block still counts it (the series already created keep it)
  const before = deriveCensus(stepped, { contract: { ...at, censusHeight: at.censusHeight - 1 }, resolve, bond: BOND, verifyUpdate: () => true });
  assert.ok(before.entries.map((e) => whoIs(e.pubkey)).includes('honest'), 'a census below the update\'s block left the node out');
  // serving = true in a later update: back from that block's census on
  const b2 = withUpdate({ ...honest.advert, serving: true }, 1790000000001n, b1.header, [b1]);
  const back = deriveCensus({ blocks: [...blocks, b1, b2], firstHeight: view.firstHeight }, { contract: { ...at, censusHeight: at.censusHeight + 1 }, resolve, bond: BOND, verifyUpdate: () => true });
  assert.ok(back.entries.map((e) => whoIs(e.pubkey)).includes('honest'), 'serving = true did not bring the node back');
});
