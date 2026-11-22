// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3258: POST /round's bond_min floor derives each notice point's census once with bond_min 0 and reads the census of any other
// bond_min at a canonical value (server.js bondMinFloorValues / bondMinCanonical). The median is consensus, so this holds the shortcut to
// the derivation itself: for every bond_min around every value that matters, the census the shortcut reads has the same root and the same
// bond-weighted median as deriveCensus at that bond_min - protocol 3 (each output on its own floor) and 19 (a node's outputs by their sum,
// after resolving and again after updates), with nodes of several outputs, two operators under one key, and an update that takes one
// output out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { bondWeightedMedian } from '../../arena-protocol/src/census-median.js';
import { chainOf as minedChain } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction, advertUpdateTransaction } from '../../arena-protocol/tools/bond.js';
import { censusOfView } from '../src/roster.js';
import { bondMinFloorValues, bondMinCanonical } from '../src/server.js';
import { keyFor, bondFor } from './curve.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SECRET = (n) => new Uint8Array(32).fill(n);
const HEIGHT = 900000;
const advertFor = (n, version, over = {}) => ({
  nodePubkey: keyFor(n), operatorId: `op-${n}`, protocolVersions: [version],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), guardianOf: [], timestamp: 1000n, declares: { bondMinSats: BigInt(n) * 1000n, proposalDepositSats: 1n }, ...over,
});
const bond = (n, version, value, prev, over = {}) => {
  const a = advertFor(n, version, over);
  return bondTransaction(a, { previousTxid: b32(prev), previousVout: 0, outputKey: bondFor(keyFor(n)), value, signature: schnorr.sign(advertId(a), SECRET(n)) });
};
const view = (at) => { const blocks = []; for (let h = HEIGHT - 30; h <= HEIGHT + 2; h++) blocks.push({ transactions: at[h] || [] }); return minedChain(blocks, HEIGHT - 30); };

function chainFor(version) {
  // node 0x11: one output; 0x12: two outputs; 0x13: three outputs, one of them under a second operator; 0x14: two outputs, the
  // second stepped out by its own signed update (protocol 19: the node's newest body decides, so the update is per node)
  const b12b = bond(0x12, version, 70000, 0xb2);
  const b14b = bond(0x14, version, 45000, 0xb4);
  const at = {
    [HEIGHT - 25]: [bond(0x11, version, 60000, 0xa1), bond(0x12, version, 40000, 0xa2), b12b, bond(0x13, version, 30000, 0xa3)],
    [HEIGHT - 24]: [bond(0x13, version, 50000, 0xb3), bond(0x13, version, 90000, 0xc3, { operatorId: 'op-other' }), bond(0x14, version, 80000, 0xa4), b14b],
  };
  const upd = advertFor(0x14, version, { timestamp: 5000n, serving: false });
  at[HEIGHT - 12] = [advertUpdateTransaction(upd, { bondTxid: parseTransaction(b14b).txid, bondVout: 0, signature: schnorr.sign(advertId(upd), SECRET(0x14)), previousTxid: b32(0xd4) })];
  return view(at);
}

for (const version of [3, 19]) {
  test(`#3258: protocol ${version} - the canonical bond_min reads the census deriveCensus gives at the round's own bond_min`, () => {
    const v = chainFor(version);
    const contract = { gameId: NEXTBLOCK_GAME_ID, bondMinSats: 0n, protocolVersion: version, censusHeight: HEIGHT, censusConfirmations: 6, networkId: NETWORK_ID_REGTEST };
    const at = (b) => censusOfView(v, { ...contract, bondMinSats: b });
    const base = at(0n);
    assert.equal(base.ok, true, base.why);
    const values = bondMinFloorValues(base);
    assert.ok(values && values.length >= 8, `values ${values}`);
    const median = (c) => bondWeightedMedian(c.entries || [], 'bondMinSats');
    const probes = new Set([0n, 1n]);
    for (const x of values) for (const d of [-1n, 0n, 1n]) if (x + d >= 0n) probes.add(x + d);
    let derived = 0;
    for (const b of [...probes].sort((x, y) => (x < y ? -1 : 1))) {
      const direct = at(b);
      assert.equal(direct.ok, true, direct.why);
      const k = bondMinCanonical(values, b);
      const read = k === 'base' ? base : k === 'none' ? { entries: [], root: null } : at(k);
      if (typeof k === 'bigint') derived++;
      if (k === 'none') assert.equal(direct.entries.length, 0, `bond_min ${b}: everything falls`);
      else assert.equal(toHex(read.root), toHex(direct.root), `bond_min ${b} (read at ${k}): another census`);
      assert.equal(median(read), median(direct), `bond_min ${b} (read at ${k}): another median`);
    }
    assert.ok(derived > 0, 'some bond_min is read at a value of its own');
  });
}
