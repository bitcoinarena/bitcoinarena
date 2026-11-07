// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TEMPLATE 3 (spec 5A.3B, kanban #971, #972, #974). Offline: the bytes, the tree, the refusals. The consensus answers are
// tools/bond3-regtest.mjs's, against bitcoind 31.1 on a private regtest on mainnet's clocks with a weighted FROST census key, 46 of 46:
// the start, the release 5 + 5, the return of a mature node, the fallback of an immature bond and path A accepted (314, 464, 135, 134 and
// 126 vB); money elsewhere, either signature missing, another round's presig or panels, 5 + 4, 4 + 5, one panel alone, each clock
// a block early, another key on a leaf and a return before maturity refused. Panels of 3 to 6 at t of n (329, 347, 397, 446 vB), a hold
// output with no panels (return 127, fallback 126 vB), one table by release and by fallback (557, 306 vB), and the node's own return.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  bondOutputKey, bondInternalKey, bond3OutputKey, bond3OutputKeyMatches, bondMaturityOf, maturityStands, slashStartLeaf, releaseLeaf, returnLeaf, fallbackLeaf,
  holdTapTree, holdOutputKey, holdControlBlock, tapLeafHash, tapBranchHash, tapTweak, rootFromControlBlock, recoveryLeaf, controlBlockFor,
  HOLD_INTERNAL_KEY, BOND_TEMPLATE_V3,
} from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathSigners, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { genesisFor, SLASH_CLOCKS } from '../../arena-protocol/src/genesis.js';
import { bondKeyMatches } from '../../arena-protocol/src/chain.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { resolveCensus, chainFactsAt, holdOfStart } from '../../arena-protocol/src/census.js';
import { encodeAdvert, decodeAdvert } from '../../arena-protocol/src/advert.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { tweakPoint, combine } from '../src/curve.js';

const hexOf = toHex;
const person = (n) => schnorr.getPublicKey(taggedHash('ARENA/test/Bond3', Uint8Array.from([n])));
const nodeKey = schnorr.getPublicKey(new Uint8Array(32).fill(0x11));
// THE OWNER KEY (kanban #1093 part 1, ruling #1103): path A and the hold's return are its, never the node key's
const ownerKey = schnorr.getPublicKey(new Uint8Array(32).fill(0x22));
const censusKey = person(1);
const panelA = Array.from({ length: 7 }, (_, i) => person(10 + i));
const panelB = Array.from({ length: 7 }, (_, i) => person(30 + i));
const { arbitrationKeys } = genesisFor('regtest');
const internalKey = bondInternalKey({ nodeKey, arbitrationKeys }, { combine }).internalKey;
const clocks = { holdBlocks: 6, returnBlocks: 432, fallbackBlocks: 288 };
const hold = { ownerKey, censusKey, panelA, panelB, bondMaturity: 160000, ...clocks };

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
  assert.equal(hexOf(returnLeaf({ ownerKey, bondMaturity: 160000, returnBlocks: 144 })), `029000b275${'03007102'}b17520${hexOf(ownerKey)}ac`, 'the return is the owner key\'s');
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
  assert.equal(hexOf(tapLeafHash(of(0x10000))), hexOf(tagged([0xfe, 0, 0, 1, 0], of(0x10000))), 'and an anchor\'s leaf over 65,535 bytes');
});

test('the bond: path A the owner key\'s, path B the census key\'s, no key path (NUMS), and the output key depends on all of them (kanban #1093 part 1)', () => {
  const inputs = { nodeKey, ownerKey, censusKey, bondMaturity: 160000 };
  const built = bond3OutputKey(inputs, { tweakPoint });
  assert.equal(built.ok, true, built.why);
  assert.equal(hexOf(built.internalKey), '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0', 'unspendable: no cooperative door');
  assert.equal(hexOf(built.recovery), hexOf(tapLeafHash(recoveryLeaf(ownerKey, 160000))), 'path A is the owner key\'s');
  assert.equal(hexOf(built.slash), hexOf(tapLeafHash(slashStartLeaf(nodeKey, censusKey))));
  assert.equal(hexOf(built.merkleRoot), hexOf(tapBranchHash(built.recovery, built.slash)));
  assert.equal(bond3OutputKeyMatches(built.outputKey, inputs, { tweakPoint }).ok, true);
  for (const change of [{ censusKey: person(2) }, { bondMaturity: 160001 }, { ownerKey: person(4) }, { nodeKey: person(5) }])
    assert.equal(bond3OutputKeyMatches(built.outputKey, { ...inputs, ...change }, { tweakPoint }).ok, false, Object.keys(change)[0]);
  for (const path of ['recovery', 'slash']) {
    const c = controlBlockFor(path, built);
    assert.equal(hexOf(rootFromControlBlock(path === 'recovery' ? built.recovery : built.slash, c.controlBlock).merkleRoot), hexOf(built.merkleRoot), path);
  }
  const old = bondOutputKey({ nodeKey, arbitrationKeys, arbitrationK: 5, bondMaturity: 160000, internalKey }, { tweakPoint, combine });
  assert.notEqual(hexOf(old.outputKey), hexOf(built.outputKey), 'template 3 is a different output from template 2');
});

test('a template-3 advertisement carries its maturity and its census key; a reader rebuilds the bond from the body alone (kanban #1021)', () => {
  const advert = { nodePubkey: nodeKey, censusKey, ownerPubkey: ownerKey, bondScriptTemplateVersion: BOND_TEMPLATE_V3, bondMaturityHeight: 160000 };
  assert.deepEqual(bondMaturityOf(advert, { network: 'testnet4' }), { ok: true, maturity: 160000 });
  assert.equal(maturityStands(advert, 159000, 'testnet4').ok, true);
  assert.match(maturityStands({ ...advert, bondMaturityHeight: 159100 }, 159000, 'testnet4').why, /short of/);
  const built = bond3OutputKey({ nodeKey, ownerKey, censusKey, bondMaturity: 160000 }, { tweakPoint });
  const script = fromHex(`5120${hexOf(built.outputKey)}`);
  const bond = { arbitrationKeys, arbitrationK: 5, bondMaturity: 100, tweakPoint, combine, network: 'regtest' };
  assert.equal(bondKeyMatches(script, advert, bond).ok, true);
  assert.equal(bondKeyMatches(script, { ...advert, censusKey: person(2) }, bond).ok, false, 'another key rebuilds another bond');
  assert.equal(bondKeyMatches(script, { ...advert, ownerPubkey: person(4) }, bond).ok, false, 'another owner key rebuilds another bond');
  assert.equal(bondMaturityOf({ bondScriptTemplateVersion: 4 }, {}).ok, false);
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
  for (const change of [{ panelA: panelB, panelB: panelA }, { censusKey: person(2) }, { bondMaturity: 160001 }, { returnBlocks: 433 }])
    assert.notEqual(hexOf(holdOutputKey({ ...hold, ...change }, { tweakPoint }).outputKey), hexOf(h.outputKey), Object.keys(change).join());
});

test('a panel of n is t of n, by the ruling (kanban #1021)', () => {
  for (const [n, t] of [[3, 3], [4, 3], [5, 4], [6, 5], [7, 5]]) {
    const a = panelA.slice(0, n), b = panelB.slice(0, n);
    const leaf = releaseLeaf({ panelA: a, panelB: b, holdBlocks: 6 });
    const count = (list, close) => { const [f, ...r] = [...list].map(hexOf).sort(); return `20${f}ac${r.map((k) => `20${k}ba`).join('')}${(0x50 + t).toString(16)}${close}`; };
    assert.equal(hexOf(leaf), `56b275${count(a, '9d')}${count(b, '9c')}`, `n = ${n}`);
  }
});

test('a hold output with no panels has no release leaf: the return and the fallback alone (kanban #1021)', () => {
  const h = holdOutputKey({ ...hold, panelA: [], panelB: [] }, { tweakPoint });
  assert.equal(h.ok, true, h.why);
  assert.equal(h.scripts.release, undefined);
  assert.equal(hexOf(h.merkleRoot), hexOf(tapBranchHash(h.leaves.return, h.leaves.fallback)));
  assert.match(holdControlBlock('release', h).why, /no release leaf/);
  for (const path of ['return', 'fallback']) {
    const c = holdControlBlock(path, h);
    assert.equal(c.controlBlock.length, 65, path);
    const r = rootFromControlBlock(h.leaves[path], c.controlBlock);
    assert.equal(hexOf(tweakPoint(r.internalKey, r.tweak).outputKey), hexOf(h.outputKey), path);
  }
});

test('every network\'s clocks build a hold output', () => {
  for (const c of Object.values(SLASH_CLOCKS)) {
    const h = holdOutputKey({ ...hold, holdBlocks: c.slashHoldBlocks, returnBlocks: c.slashReturnBlocks, fallbackBlocks: c.slashFallbackBlocks }, { tweakPoint });
    assert.equal(h.ok, true, h.why);
  }
});

test('what cannot be a hold output is refused by name', () => {
  const why = (change) => holdOutputKey({ ...hold, ...change }, { tweakPoint }).why;
  assert.match(why({ panelA: panelA.slice(1) }), /one size/);
  assert.match(why({ panelA: panelA.slice(0, 2), panelB: panelB.slice(0, 2) }), /a panel is 3 to 7 keys/);
  assert.match(why({ panelA: [] }), /a panel is 3 to 7 keys/);
  assert.match(why({ panelB: [panelA[0], ...panelB.slice(1)] }), /sits twice/);
  assert.match(why({ panelA: [panelA[0], panelA[0], ...panelA.slice(2)] }), /sits twice/);
  assert.match(why({ returnBlocks: 288 }), /hold, then fallback, then return/);
  assert.match(why({ returnBlocks: 144 }), /hold, then fallback, then return/, "the old order, return before fallback, is refused (kanban #1317)");
  assert.match(why({ holdBlocks: 288 }), /hold, then fallback, then return/);
  assert.match(why({ holdBlocks: 0 }), /CHECKSEQUENCEVERIFY can wait/);
  assert.match(why({ returnBlocks: 65536 }), /CHECKSEQUENCEVERIFY can wait/);   // the return is the longest clock since #1317
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

// THE CENSUS READER, ON REAL BOND TRANSACTIONS (ruling 4, ruling 5): resolveCensus, as a seat runs it
test('the census reads a template-3 bond naming the newest standing key, and refuses any other by name (kanban #1021)', () => {
  const contract = { bondMinSats: 50000n, protocolVersion: 1, networkId: NETWORK_ID_REGTEST };
  const CONFIRMED = 900000;
  const g = genesisFor('regtest');
  const old = person(60), newest = person(61), later = person(62);
  const body = (k, key, over = {}) => ({ nodePubkey: k, operatorId: 'operator', protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], endpoint: 'ws://node', region: 'eu-west',
    capacityClass: 1, softwareHash: new Uint8Array(32).fill(2), settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0,
    bondScriptTemplateVersion: 3, bondMaturityHeight: CONFIRMED + 100, censusKey: key, ownerPubkey: ownerKey, payoutPubkey: new Uint8Array(32).fill(3), guardianOf: [], timestamp: 1788700000000n, ...over });
  const bondOf = (k, key, over) => {
    const a = body(k, key, over);
    const { outputKey } = bond3OutputKey({ nodeKey: k, ownerKey, censusKey: key, bondMaturity: a.bondMaturityHeight }, { tweakPoint });
    const transaction = bondTransaction(a, { outputKey, previousTxid: new Uint8Array(32).fill(k[0]) });
    return { tx: transaction, entry: { txid: parseTransaction(transaction).txid, vout: 0, pubkey: k, bondSats: 60000n, height: CONFIRMED, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], spent: false } };
  };
  const bonds = [bondOf(person(70), newest), bondOf(person(71), old), bondOf(person(72), later), bondOf(person(73), person(63))];
  const byTxid = new Map(bonds.map((b) => [hexOf(b.entry.txid), b.tx]));
  const read = (standingKeys) => resolveCensus(bonds.map((b) => b.entry), { contract, resolve: (e) => ({ transaction: byTxid.get(hexOf(e.txid)) }),
    bond: { arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: g.bondMaturity, tweakPoint, combine, standingKeys } });
  const standing = [{ epoch: 1, publicKey: old, height: 100 }, { epoch: 2, publicKey: newest, height: 899999 }, { epoch: 3, publicKey: later, height: 900001 }];
  const seen = read(standing);
  assert.equal(seen.ok, true, seen.why);
  assert.deepEqual(seen.eligible.map((e) => hexOf(e.pubkey)), [hexOf(person(70))]);
  assert.equal(seen.excluded.length, 3);
  for (const x of seen.excluded) assert.match(x.why, /newest standing at its confirmation/);
  const none = read([]);
  assert.equal((none.eligible || []).length, 0);
  for (const x of none.excluded) assert.match(x.why, /cannot take a template-3 bond yet/);
  const wire = decodeAdvert(encodeAdvert(body(person(70), newest)));
  assert.equal(hexOf(wire.censusKey), hexOf(newest));
  assert.equal(wire.bondMaturityHeight, CONFIRMED + 100);
});

test('a hold output is still the bond: the census reads a slash start\'s output 0 until it is spent, and no other spend (5A.2, kanban #1050)', () => {
  const bondKey = '11'.repeat(32) + ':0';
  const bondScript = fromHex(`5120${'33'.repeat(32)}`), holdScript = fromHex(`5120${'44'.repeat(32)}`);
  const from = { txid: new Uint8Array(32).fill(0x11), vout: 0, sequence: 0xfffffffd };
  const fee = { txid: new Uint8Array(32).fill(0x22), vout: 0, sequence: 0xfffffffd };
  const path = (leaf) => [new Uint8Array(64), new Uint8Array(65), leaf, new Uint8Array(33)];
  const leafB = slashStartLeaf(nodeKey, censusKey);
  const start = (over = {}) => serializeSpend({ version: 2, locktime: 0, inputs: [from, fee], outputs: [{ value: 100000n, script: holdScript }], witnesses: [path(leafB), [new Uint8Array(64)]], ...over });
  const facts = (spend, extra = [], height = 500) => {
    const f = chainFactsAt([{ height: 400, transactions: [spend] }, ...extra.map((t, i) => ({ height: 401 + i, transactions: [t] }))], height);
    f.outputAt.set(bondKey, { value: 100000n, script: bondScript });
    return f;
  };
  const raw = start();
  const txid = hexOf(parseTransaction(raw).txid);
  assert.deepEqual(holdOfStart(facts(raw), bondKey, nodeKey), { txid, vout: 0, height: 400 });
  const ended = serializeSpend({ version: 2, locktime: 0, inputs: [{ txid: fromHex(txid), vout: 0, sequence: 24 }], outputs: [{ value: 90000n, script: bondScript }], witnesses: [path(leafB)] });
  assert.equal(holdOfStart(facts(raw, [ended]), bondKey, nodeKey), null, 'a release, a return or the fallback ends it');
  assert.deepEqual(holdOfStart(facts(raw, [ended], 400), bondKey, nodeKey), { txid, vout: 0, height: 400 }, 'and a census below that spend still reads the hold');
  assert.equal(holdOfStart(facts(raw), bondKey, person(9)), null, 'another node\'s path B is not this bond\'s');
  const refused = {
    'path A': start({ witnesses: [path(recoveryLeaf(nodeKey, 160000)), [new Uint8Array(64)]] }),
    'the key path': start({ witnesses: [[new Uint8Array(64)], [new Uint8Array(64)]] }),
    'less than the whole bond': start({ outputs: [{ value: 99999n, script: holdScript }] }),
    'output 0 not a taproot output': start({ outputs: [{ value: 100000n, script: fromHex(`0014${'55'.repeat(20)}`) }] }),
    'the bond on another input': start({ inputs: [fee, from] }),
  };
  for (const [what, spend] of Object.entries(refused)) assert.equal(holdOfStart(facts(spend), bondKey, nodeKey), null, what);
});
