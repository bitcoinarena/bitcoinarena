// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TEMPLATE 3 (spec 5A.3B, kanban #971, #972, #974). Offline: the bytes, the tree, the refusals. The consensus answers are
// tools/bond3-regtest.mjs's, against bitcoind 31.1 on a private regtest on mainnet's clocks with a weighted FROST census key, 26 of 26:
// the start, the release 5 + 5, the return of a mature node, the fallback of an immature bond and path A accepted (314, 464, 135, 134 and
// 126 vB); money elsewhere, either signature missing, another round's presig or panels, 5 + 4, 4 + 5, one panel alone, each clock
// a block early, another key on a leaf and a return before maturity refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  bondOutputKey, bondInternalKey, bond3OutputKey, bond3OutputKeyMatches, bondMaturityOf, slashStartLeaf, releaseLeaf, returnLeaf, fallbackLeaf,
  holdTapTree, holdOutputKey, holdControlBlock, tapLeafHash, tapBranchHash, tapTweak, rootFromControlBlock, recoveryLeaf, controlBlockFor,
  HOLD_INTERNAL_KEY, BOND_TEMPLATE_V3,
} from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathSigners } from '../../arena-protocol/src/bond-spend.js';
import { genesisFor, SLASH_CLOCKS } from '../../arena-protocol/src/genesis.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint, combine } from '../src/curve.js';

const hexOf = toHex;
const person = (n) => schnorr.getPublicKey(taggedHash('ARENA/test/Bond3', Uint8Array.from([n])));
const nodeKey = schnorr.getPublicKey(new Uint8Array(32).fill(0x11));
const censusKey = person(1);
const panelA = Array.from({ length: 7 }, (_, i) => person(10 + i));
const panelB = Array.from({ length: 7 }, (_, i) => person(30 + i));
const { arbitrationKeys } = genesisFor('regtest');
const internalKey = bondInternalKey({ nodeKey, arbitrationKeys }, { combine }).internalKey;
const clocks = { holdBlocks: 6, returnBlocks: 144, fallbackBlocks: 288 };
const hold = { nodeKey, censusKey, panelA, panelB, bondMaturity: 160000, ...clocks };

test('templates 1 and 2 are the bytes they were: output keys pinned off the tree before template 3 was written (aefaff835)', () => {
  const pins = [['regtest', 100, 'fb0a797f025871162be6a1324da67c64234c10aacb309af30b7e7ab5450da51e', 1],
    ['regtest', 160000, '7ae39de78bd8b66502af8e58490fc82cd5ea3280b80b64889a21673c828d793c', 0],
    ['testnet4', 100, '9aaf3e965a4edb7345f3b8de416ae76ed5a59f047768dbd6585373fa3f3a6053', 0],
    ['testnet4', 160000, '4c3abb37f2f608b34a23623d0f5a4fa121991fcd6a5463f437c0b650e5caf6c8', 1]];
  for (const [net, bondMaturity, key, parity] of pins) {
    const g = genesisFor(net);
    const inner = bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey;
    const r = bondOutputKey({ nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity, internalKey: inner }, { tweakPoint, combine });
    assert.deepEqual([hexOf(r.outputKey), r.parity], [key, parity], `${net} ${bondMaturity}`);
  }
});

test('path B and the three hold leaves are the spec\'s scripts, opcode for opcode', () => {
  const n = hexOf(nodeKey), c = hexOf(censusKey);
  assert.equal(hexOf(slashStartLeaf(nodeKey, censusKey)), `20${n}ad20${c}ac`);
  assert.equal(hexOf(fallbackLeaf({ censusKey, fallbackBlocks: 288 })), `022001b27520${c}ac`);
  assert.equal(hexOf(returnLeaf({ nodeKey, bondMaturity: 160000, returnBlocks: 144 })), `029000b275${'03007102'}b17520${n}ac`);
  const sorted = (list) => [...list].map(hexOf).sort();
  const count = (list, close) => { const [f, ...r] = sorted(list); return `20${f}ac${r.map((k) => `20${k}ba`).join('')}55${close}`; };
  const leaf = releaseLeaf({ panelA, panelB, holdBlocks: 6 });
  assert.equal(hexOf(leaf), `56b275${count(panelA, '9d')}${count(panelB, '9c')}`);
  assert.equal(leaf.length, 483);
  assert.equal(hexOf(releaseLeaf({ panelA: [...panelA].reverse(), panelB, holdBlocks: 6 })), hexOf(leaf), 'one set, one leaf');
  assert.equal(hexOf(fallbackLeaf({ censusKey, fallbackBlocks: 1 }).subarray(0, 3)), '51b275', 'a small clock is OP_n, as Bitcoin wants it');
  // a clock of 128 or more is padded, or it would read as negative
  assert.equal(hexOf(fallbackLeaf({ censusKey, fallbackBlocks: 128 }).subarray(0, 5)), '028000b275');
});

test('a leaf over 252 bytes hashes with BIP-341\'s longer compact size; every shorter one as it always did', () => {
  const tagged = (prefix, s) => taggedHash('TapLeaf', Uint8Array.from([0xc0, ...prefix, ...s]));
  const of = (n) => new Uint8Array(n).fill(0x51);
  assert.equal(hexOf(tapLeafHash(of(252))), hexOf(tagged([252], of(252))));
  assert.equal(hexOf(tapLeafHash(of(253))), hexOf(tagged([0xfd, 253, 0], of(253))));
  assert.equal(hexOf(tapLeafHash(of(483))), hexOf(tagged([0xfd, 0xe3, 0x01], of(483))));
  assert.throws(() => tapLeafHash(of(0x10000)), /that long/);
});

test('the bond: key path and path A as before, path B the census key\'s, and the output key depends on all of them', () => {
  const inputs = { nodeKey, censusKey, arbitrationKeys, bondMaturity: 160000, internalKey };
  const built = bond3OutputKey(inputs, { tweakPoint, combine });
  assert.equal(built.ok, true, built.why);
  assert.equal(hexOf(built.recovery), hexOf(tapLeafHash(recoveryLeaf(nodeKey, 160000))), 'path A is the same leaf');
  assert.equal(hexOf(built.slash), hexOf(tapLeafHash(slashStartLeaf(nodeKey, censusKey))));
  assert.equal(hexOf(built.merkleRoot), hexOf(tapBranchHash(built.recovery, built.slash)));
  assert.equal(bond3OutputKeyMatches(built.outputKey, inputs, { tweakPoint, combine }).ok, true);
  for (const change of [{ censusKey: person(2) }, { bondMaturity: 160001 }])
    assert.equal(bond3OutputKeyMatches(built.outputKey, { ...inputs, ...change }, { tweakPoint, combine }).ok, false, Object.keys(change)[0]);
  const chosen = bond3OutputKey({ ...inputs, internalKey: person(3) }, { tweakPoint, combine });
  assert.match(chosen.why, /not the MuSig2 aggregate/);
  for (const path of ['recovery', 'slash']) {
    const c = controlBlockFor(path, built);
    assert.equal(hexOf(rootFromControlBlock(path === 'recovery' ? built.recovery : built.slash, c.controlBlock).merkleRoot), hexOf(built.merkleRoot), path);
  }
  const old = bondOutputKey({ nodeKey, arbitrationKeys, arbitrationK: 5, bondMaturity: 160000, internalKey }, { tweakPoint, combine });
  assert.notEqual(hexOf(old.outputKey), hexOf(built.outputKey), 'template 3 is a different output from template 2');
});

test('nothing reads a template-3 advertisement yet: it stays refused by name until the census knows a hold output', () => {
  const read = bondMaturityOf({ bondScriptTemplateVersion: BOND_TEMPLATE_V3, bondMaturityHeight: 160000 }, { network: 'testnet4' });
  assert.equal(read.ok, false);
  assert.match(read.why, /reads templates 1 and 2/);
});

test('the hold output: anyone rebuilds it from the bond and the round, each leaf proves its way to the root', () => {
  const h = holdOutputKey(hold, { tweakPoint });
  assert.equal(h.ok, true, h.why);
  assert.equal(hexOf(h.internalKey), '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');
  assert.equal(hexOf(h.script), `5120${hexOf(h.outputKey)}`);
  assert.equal(hexOf(h.tweak), hexOf(tapTweak(HOLD_INTERNAL_KEY, h.merkleRoot)));
  assert.equal(hexOf(holdOutputKey(hold, { tweakPoint }).outputKey), hexOf(h.outputKey), 'rebuilt, the same');
  const sizes = {};
  for (const path of ['release', 'return', 'fallback']) {
    const c = holdControlBlock(path, h);
    const r = rootFromControlBlock(h.leaves[path], c.controlBlock);
    assert.equal(hexOf(r.merkleRoot), hexOf(h.merkleRoot), path);
    assert.equal(r.parity, h.parity);
    assert.deepEqual(hexOf(tweakPoint(r.internalKey, r.tweak).outputKey), hexOf(h.outputKey), path);
    sizes[path] = c.controlBlock.length;
  }
  assert.deepEqual(sizes, { release: 65, return: 97, fallback: 97 });
  assert.equal(holdControlBlock('elsewhere', h).ok, false);
  for (const change of [{ panelA: panelB, panelB: panelA }, { censusKey: person(2) }, { bondMaturity: 160001 }, { returnBlocks: 145 }])
    assert.notEqual(hexOf(holdOutputKey({ ...hold, ...change }, { tweakPoint }).outputKey), hexOf(h.outputKey), Object.keys(change).join());
});

test('every network\'s clocks build a hold output', () => {
  for (const c of Object.values(SLASH_CLOCKS)) {
    const h = holdOutputKey({ ...hold, holdBlocks: c.slashHoldBlocks, returnBlocks: c.slashReturnBlocks, fallbackBlocks: c.slashFallbackBlocks }, { tweakPoint });
    assert.equal(h.ok, true, h.why);
  }
});

test('what cannot be a hold output is refused by name', () => {
  const why = (change) => holdOutputKey({ ...hold, ...change }, { tweakPoint }).why;
  assert.match(why({ panelA: panelA.slice(1) }), /a panel is 7 keys/);
  assert.match(why({ panelB: [panelA[0], ...panelB.slice(1)] }), /sits twice/);
  assert.match(why({ panelA: [panelA[0], panelA[0], ...panelA.slice(2)] }), /sits twice/);
  assert.match(why({ returnBlocks: 288 }), /hold, then return, then fallback/);
  assert.match(why({ holdBlocks: 144 }), /hold, then return, then fallback/);
  assert.match(why({ holdBlocks: 0 }), /CHECKSEQUENCEVERIFY can wait/);
  assert.match(why({ fallbackBlocks: 65536 }), /CHECKSEQUENCEVERIFY can wait/);
  assert.match(why({ bondMaturity: 500000000 }), /not a block height/);
  assert.equal(holdOutputKey(hold).ok, false, 'no curve');
});

test('the sighash: the default is the old message, and the types a witness can carry are BIP-341\'s', () => {
  const script = fromHex(`5120${'22'.repeat(32)}`);
  const one = { txid: new Uint8Array(32).fill(7), vout: 1, sequence: 0xfffffffd };
  const tx = { version: 2, locktime: 0, inputs: [one], outputs: [{ value: 1000n, script }], prevouts: [{ value: 1000n, script }], inputIndex: 0, leafHash: new Uint8Array(32).fill(9) };
  assert.equal(hexOf(tapSighash(tx)), hexOf(tapSighash({ ...tx, hashType: 0x00 })));
  assert.notEqual(hexOf(tapSighash(tx)), hexOf(tapSighash({ ...tx, hashType: 0x01 })));
  // what slash_presig leans on: the filer adds a fee input and outputs after, and the digest does not move
  const presig = tapSighash({ ...tx, hashType: 0x83 });
  const fee = { txid: new Uint8Array(32).fill(8), vout: 0, sequence: 0xffffffff };
  const filed = { ...tx, inputs: [one, fee], prevouts: [...tx.prevouts, { value: 5n, script }], outputs: [...tx.outputs, { value: 1n, script }] };
  assert.equal(hexOf(tapSighash({ ...filed, hashType: 0x83 })), hexOf(presig));
  assert.notEqual(hexOf(tapSighash({ ...filed, outputs: [{ value: 999n, script }], hashType: 0x83 })), hexOf(presig), 'output 0 is what it signs');
  assert.throws(() => tapSighash({ ...tx, hashType: 0x04 }), /not a taproot hash type/);
  assert.throws(() => tapSighash({ ...tx, outputs: [], hashType: 0x03 }), /SIGHASH_SINGLE/);
});

test('a witness names its signers: the keys in the order the leaf checks them, each with its stack item', () => {
  const h = holdOutputKey(hold, { tweakPoint });
  const order = [...[...panelA].map(hexOf).sort(), ...[...panelB].map(hexOf).sort()];
  const stack = order.map((_, i) => Uint8Array.from([i + 1])).reverse();
  const read = scriptPathSigners([...stack, h.scripts.release, holdControlBlock('release', h).controlBlock]);
  assert.equal(read.ok, true, read.why);
  assert.deepEqual(read.signers.map((x) => hexOf(x.key)), order);
  assert.deepEqual(read.signers.map((x) => x.signature[0]), order.map((_, i) => i + 1));
  const start = scriptPathSigners([Uint8Array.of(1), Uint8Array.of(2), slashStartLeaf(nodeKey, censusKey), new Uint8Array(65)]);
  assert.deepEqual(start.signers.map((x) => [hexOf(x.key), x.signature[0]]), [[hexOf(nodeKey), 2], [hexOf(censusKey), 1]], 'the node signs on top');
  assert.equal(scriptPathSigners([new Uint8Array(64)]).ok, false, 'a key path names no one');
  assert.match(scriptPathSigners([h.scripts.release, Uint8Array.of(0x50, 1)]).why, /annex/);
  assert.match(scriptPathSigners([h.scripts.release, new Uint8Array(65)]).why, /14 keys/);
});
