// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ADD TO BOND (kanban #544, spec §5A "Multiple bond outputs"): a node raises its bond with a second bond output beside the first,
// each valid on its own (template, marker, advertisement with the same node key and operator), and from protocol 19 the census
// applies the round's floor to the node's SUM. Before 19 the floor is each output's, as it always was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { BOND_SUM_VERSION } from '../src/constants.js';
import { parseTransaction } from '../src/tx.js';
import { bondTransaction } from '../tools/bond.js';
import { resolveCensus, nodeBonds, nodeBondOf, newestPerNode } from '../src/census.js';
import { toHex } from '../src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const HEIGHT = 900000;
const advertFor = (node, over = {}) => ({
  nodePubkey: b32(node), operatorId: 'operator', protocolVersions: [18, 19],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], endpoint: `ws://node${node}`, region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n, ...over,
});

/** One bond output of `node` worth `sats`, funded from its own previous output `seq` (so two outputs of one node differ). */
function output(node, sats, seq, over = {}) {
  const transaction = bondTransaction(advertFor(node, over), { previousTxid: b32(0x40 + seq), previousVout: seq, value: sats });
  const txid = parseTransaction(transaction).txid;
  return { transaction, entry: { txid, vout: 0, pubkey: b32(node), bondSats: BigInt(sats), height: HEIGHT, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], spent: false } };
}

function census(version, outputs, { missing = [] } = {}) {
  const byTxid = new Map(outputs.map((o) => [toHex(o.entry.txid), o.transaction]));
  for (const m of missing) byTxid.delete(toHex(m.entry.txid));
  const resolve = (e) => { const t = byTxid.get(toHex(e.txid)); return t ? { transaction: t } : null; };
  return resolveCensus(outputs.map((o) => o.entry), { contract: { bondMinSats: 50000n, protocolVersion: version, networkId: NETWORK_ID_REGTEST }, resolve });
}

test('protocol 19 is the version that sums', () => assert.equal(BOND_SUM_VERSION, 19));

test('50,000 + 32,000 of one node count as 82,000 in protocol 19; protocol 18 still leaves the 32,000 out', () => {
  const first = output(0x11, 50000, 1), added = output(0x11, 32000, 2);
  const v19 = census(19, [first, added]);
  assert.equal(v19.ok, true, v19.why);
  assert.equal(v19.eligible.length, 2, 'both outputs are in the census');
  const [node] = nodeBonds(v19.eligible);
  assert.equal(node.bondSats, 82000n);
  assert.deepEqual(node.outputs.map((o) => o.bondSats).sort(), [32000n, 50000n]);
  assert.deepEqual(new Set(node.outputs.map((o) => o.txid)), new Set([toHex(first.entry.txid), toHex(added.entry.txid)]), 'both outputs named');
  assert.equal(nodeBondOf(v19.eligible, b32(0x11)).bondSats, 82000n);
  console.log('  v19:', JSON.stringify({ node: node.pubkey.slice(0, 8), bondSats: String(node.bondSats), outputs: node.outputs.map((o) => `${o.txid.slice(0, 8)}:${o.vout}=${o.bondSats}`) }));

  const v18 = census(18, [first, added]);
  assert.equal(v18.ok, true, v18.why);
  assert.deepEqual(v18.eligible.map((e) => toHex(e.txid)), [toHex(first.entry.txid)]);
  const out = v18.excluded.find((e) => toHex(e.txid) === toHex(added.entry.txid));
  assert.match(out.why, /that bond is 32000 where this round's floor is 50000/);
  assert.equal(nodeBonds(v18.eligible)[0].bondSats, 50000n);
});

test('one bad output does not void the other; a node whose good outputs sum below the floor is out by its sum', () => {
  const good = output(0x21, 50000, 1), bad = output(0x21, 32000, 2);
  const r = census(19, [good, bad], { missing: [bad] });
  assert.deepEqual(r.eligible.map((e) => toHex(e.txid)), [toHex(good.entry.txid)]);
  assert.ok(r.excluded.some((e) => toHex(e.txid) === toHex(bad.entry.txid)), 'the unretrievable one is excluded on its own');
  // 30,000 + an unretrievable 30,000: the 30,000 alone is under the floor
  const low = output(0x22, 30000, 3), gone = output(0x22, 30000, 4);
  const r2 = census(19, [low, gone], { missing: [gone] });
  assert.equal(r2.eligible.length, 0);
  assert.match(r2.excluded.find((e) => toHex(e.txid) === toHex(low.entry.txid)).why, /that node's bonds sum to 30000 \(1 output\(s\)\) where this round's floor is 50000/);
});

test('two operators never merge, even under one node key', () => {
  const a = output(0x31, 30000, 1, { operatorId: 'op-a' }), b = output(0x31, 30000, 2, { operatorId: 'op-b' });
  const r = census(19, [a, b]);
  assert.equal(r.eligible.length, 0, '30,000 each is under the floor; 60,000 together would have passed');
  const groups = nodeBonds([a, b].map((o) => ({ ...o.entry, advert: advertFor(0x31, { operatorId: o === a ? 'op-a' : 'op-b' }) })));
  assert.deepEqual(groups.map((g) => [g.operatorId, g.bondSats]).sort(), [['op-a', 30000n], ['op-b', 30000n]]);
  // and two keys of one operator are two nodes
  const k1 = output(0x32, 30000, 3), k2 = output(0x33, 30000, 4);
  assert.equal(census(19, [k1, k2]).eligible.length, 0);
});

test('each output keeps its own maturity', () => {
  const at = (m) => advertFor(0x41, { bondScriptTemplateVersion: 2, bondMaturityHeight: m });
  const entries = [
    { txid: b32(0x51), vout: 0, pubkey: b32(0x41), bondSats: 50000n, height: HEIGHT, advert: at(HEIGHT + 4400) },
    { txid: b32(0x52), vout: 0, pubkey: b32(0x41), bondSats: 32000n, height: HEIGHT + 3000, advert: at(HEIGHT + 7400) },
  ];
  const [n] = nodeBonds(entries);
  assert.equal(n.bondSats, 82000n);
  assert.deepEqual(n.outputs.map((o) => o.maturity), [HEIGHT + 4400, HEIGHT + 7400]);
  // the census's own maturity rule is per output: a template-2 output short of its offset is out, the other stays
  const ok = output(0x42, 50000, 1), short = output(0x42, 32000, 2, { bondScriptTemplateVersion: 2, bondMaturityHeight: HEIGHT + 10 });
  const r = census(19, [ok, short]);
  assert.deepEqual(r.eligible.map((e) => toHex(e.txid)), [toHex(ok.entry.txid)]);
  assert.match(r.excluded.find((e) => toHex(e.txid) === toHex(short.entry.txid)).why, /matures at height/);
});

test('the newest advertisement over all a node\'s outputs decides: an update beats an older bond, a newer bond beats an older update', () => {
  const e1 = { txid: b32(0x61), vout: 0, pubkey: b32(0x51), height: 100, advert: advertFor(0x51) };
  const e2 = { txid: b32(0x62), vout: 0, pubkey: b32(0x51), height: 120, advert: advertFor(0x51, { endpoint: 'ws://new' }) };
  const key = (e) => `${Array.from(e.txid).join(',')}:${e.vout}`;
  // no updates: the newer output's own advertisement
  assert.equal(newestPerNode([e1, e2], new Map()).values().next().value.own, e2);
  // an update of the first output at 130 beats the second output's bond at 120
  const u = { advert: advertFor(0x51, { endpoint: 'ws://updated' }), height: 130, position: 1, txid: b32(0x71) };
  assert.equal(newestPerNode([e1, e2], new Map([[key(e1), u]])).values().next().value.u, u);
  // an update at 110 is older than the second bond at 120
  const old = { ...u, height: 110 };
  assert.equal(newestPerNode([e1, e2], new Map([[key(e1), old]])).values().next().value.own, e2);
});
