// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE TAKES THE RETURN LEAF BY ITSELF (spec 5A.3B, RULED 2026-11-02, kanban #1021, ruling 3). bitcoind's answers are tools/bond3-regtest.mjs's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { holdOutputKey } from '../../arena-protocol/src/bond-script.js';
import { arbitrationCommitment } from '../../arena-protocol/src/arbitration-tx.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint } from '../src/curve.js';
import { createHoldWatch, decideReturn, holdsOfOwnBond, readSlashStart, returnOpensAt, signedReturn, takeReturnIfOwed } from '../src/hold-return.js';

const secret = taggedHash('ARENA/test/Return', Uint8Array.of(1));
const nodeKey = schnorr.getPublicKey(secret);
const censusKey = schnorr.getPublicKey(taggedHash('ARENA/test/Return', Uint8Array.of(2)));
const b32 = (n) => new Uint8Array(32).fill(n);
const hold = holdOutputKey({ nodeKey, censusKey, panelA: [], panelB: [], bondMaturity: 1000, holdBlocks: 6, returnBlocks: 144, fallbackBlocks: 288 }, { tweakPoint });
const proof = Uint8Array.of(1, 2, 3);
const proofId = taggedHash('ARENA/v1/SlashProof', proof);
const start = { txid: b32(0x66), value: 100000000n, hold, proofId };
const at = { startHeight: 900, bondMaturity: 1000, returnBlocks: 144 };
const script = fromHex(`5120${'77'.repeat(32)}`);
const decide = (tip, over = {}) => decideReturn({ start, ...at, tip, fetchProof: async () => proof, proofChecks: async () => false, ...over });

test('the leaf opens when both its clocks read true on the next block', () => {
  assert.equal(returnOpensAt(at), 1043);
  assert.equal(returnOpensAt({ ...at, bondMaturity: 2000 }), 2000, 'an immature bond waits for maturity too');
});

test('a proof that fails this node\'s replay: wait for the clock, nothing fetched, then the return', async () => {
  let fetched = 0;
  const early = await decide(1042, { fetchProof: async () => { fetched++; return proof; } });
  assert.deepEqual([early.action, fetched], ['wait', 0]);
  assert.equal((await decide(1043)).action, 'return');
});

test('a true proof is left alone: this is no way out of a slash', async () => {
  const r = await decide(1043, { proofChecks: async () => true });
  assert.equal(r.action, 'keep');
});

test('no answer from the replay waits; no proof, or bytes nobody can produce, has nothing that checks', async () => {
  assert.equal((await decide(1043, { proofChecks: async () => undefined })).action, 'wait');
  assert.equal((await decide(1043, { start: { ...start, proofId: null } })).action, 'return');
  assert.equal((await decide(1043, { fetchProof: async () => null })).action, 'return');
  assert.equal((await decide(1043, { fetchProof: async () => Uint8Array.of(9) })).action, 'return', 'bytes that do not hash to it are not the proof');
});

test('one pass broadcasts once it owes, and never before', async () => {
  const sent = [];
  const pass = (tip, over = {}) => takeReturnIfOwed({ start, ...at, tip, fetchProof: async () => proof, proofChecks: async () => false, toScript: script, feeSats: 500n, nodeSecret: secret,
    broadcast: async (hex) => { sent.push(hex); return true; }, ...over });
  await pass(1000);
  assert.equal(sent.length, 0);
  await pass(1043, { proofChecks: async () => true });
  assert.equal(sent.length, 0);
  const r = await pass(1043);
  assert.equal(r.sent, true);
  const tx = parseTransaction(fromHex(sent[0]));
  assert.deepEqual([tx.locktime, tx.inputs[0].sequence, tx.outputs[0].value], [1000, 144, 99999500n]);
  assert.equal(tx.witnesses[0].length, 3);
  assert.equal(toHex(tx.witnesses[0][1]), toHex(hold.scripts.return));
  assert.throws(() => signedReturn({ start, ...at, toScript: script, feeSats: 99999999n, nodeSecret: secret }), /below dust/);
});

test('a start is read off the raw transaction: it spends the bond into a known hold output', () => {
  const bond = { txid: b32(0x11), vout: 1 };
  const raw = (input, first) => serializeSpend({ version: 2, locktime: 0, inputs: [{ ...input, sequence: 0xfffffffd }],
    outputs: [{ value: 100000000n, script: first }, arbitrationCommitment(proofId, 900)], witnesses: [[Uint8Array.of(1)]] });
  const holds = new Map([[toHex(hold.script), hold]]);
  const seen = readSlashStart(raw(bond, hold.script), bond, holds);
  assert.equal(toHex(seen.proofId), toHex(proofId));
  assert.equal(seen.value, 100000000n);
  assert.equal(readSlashStart(raw({ txid: b32(0x12), vout: 1 }, hold.script), bond, holds), null, 'another bond');
  assert.equal(readSlashStart(raw(bond, script), bond, holds), null, 'the node\'s own spend of its bond');
});

// THE NODE READS ITS OWN STARTED BOND (kanban #972)
const panelA = [3, 4, 5].map((n) => schnorr.getPublicKey(taggedHash('ARENA/test/Return', Uint8Array.of(n)))), panelB = [6, 7, 8].map((n) => schnorr.getPublicKey(taggedHash('ARENA/test/Return', Uint8Array.of(n))));
const clocks = { holdBlocks: 1, returnBlocks: 12, fallbackBlocks: 24 };
const bondTx = b32(0x44), bond = { txid: toHex(Uint8Array.from(bondTx).reverse()), vout: 0, sats: '100000', maturity: 500, censusKey: toHex(censusKey), hold: { txid: 'ab'.repeat(32), vout: 0, height: 480 } };
const holdsFor = (b, panels = [{ a: panelA, b: panelB }]) => holdsOfOwnBond({ nodeKey, censusKey: fromHex(b.censusKey), bondMaturity: b.maturity, clocks, tweakPoint, panels });
const startPaying = (script2) => serializeSpend({ version: 2, locktime: 0, inputs: [{ txid: bondTx, vout: 0, sequence: 0xfffffffd }], outputs: [{ value: 100000n, script: script2 }, arbitrationCommitment(proofId, 479, new Uint8Array(0))], witnesses: [[new Uint8Array(64)]] });
const watch = (raw, over = {}) => createHoldWatch({ clocks, nodeSecret: secret, holdsFor, rawTxAt: async () => raw, tipHeight: async () => 499, broadcast: async () => 'sent', ...over });

test('a bond can be in its bonding presig\'s hold or in one a round\'s panels name, and the node knows both', async () => {
  const holds = holdsFor(bond);
  assert.equal(holds.size, 2);
  const shapes = [...holds.values()].map((h) => !!h.leaves.release).sort();
  assert.deepEqual(shapes, [false, true], 'one with a release leaf, the bonding one with none');
  const [plain, panelled] = [...holds.values()].sort((a, b) => Number(!!a.leaves.release) - Number(!!b.leaves.release));
  const a = await watch(startPaying(plain.script)).read(bond);
  assert.deepEqual([a.known, a.startHeight, a.returnOpensAt, a.fallbackOpensAt, a.proofId, a.releaseOpensAt], [true, 480, 500, 503, toHex(proofId), undefined], 'a clock is read from the next block; maturity holds the return');
  assert.equal((await watch(startPaying(panelled.script)).read(bond)).releaseOpensAt, 480);
  assert.equal((await watch(startPaying(script)).read(bond)).known, false, 'a hold it never signed');
});

test('an owner\'s return: only once its clocks read true, to the address asked', async () => {
  const [plain] = holdsFor(bond).values();
  const raw = startPaying(plain.script);
  assert.match((await watch(raw).returnTo(bond, script)).why, /opens at block 500, 1 from now/);
  const r = await watch(raw, { tipHeight: async () => 500 }).returnTo(bond, script);
  const spend = parseTransaction(fromHex(r.hex));
  assert.deepEqual([spend.locktime, spend.inputs[0].sequence, spend.inputs[0].previousVout], [500, 12, 0]);
  assert.equal(toHex(spend.outputs[0].script), toHex(script));
  assert.equal(spend.outputs[0].value, 99000n);
  assert.match((await watch(startPaying(script), { tipHeight: async () => 500 }).returnTo(bond, script)).why, /no hold output this node signed/);
});

test('a pass: nothing before the clock; then a false proof returned to the wallet, a true one left, no wallet named', async () => {
  const [plain] = holdsFor(bond).values();
  const raw = startPaying(plain.script), sent = [];
  const pass = (tip, over = {}) => watch(raw, { tipHeight: async () => tip, broadcast: async (h) => { sent.push(h); return 'tx'; }, fetchProof: async () => proof, proofChecks: async () => false, returnScript: async () => script, ...over }).pass([bond, { ...bond, hold: undefined }]);
  assert.equal((await pass(499))[0].action, 'wait');
  assert.equal(sent.length, 0);
  assert.equal((await pass(500, { proofChecks: async () => true }))[0].action, 'keep');
  const none = await pass(500, { returnScript: async () => null });
  assert.deepEqual([none[0].action, none[0].sent, sent.length], ['return', null, 0], 'owed, and left to the owner\'s page');
  const done = await pass(500);
  assert.deepEqual([done.length, done[0].sent, sent.length], [1, 'tx', 1], 'an output with no hold is not read');
});
