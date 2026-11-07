// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FALSE START, AND THE OWNER TAKES THE BOND BACK (spec 5A.3B, kanban #1021; kanban #1093 part 1, ruling #1103: the return leaf is the owner key's,
// there is no automatic return - the node prepares it and the owner signs with the 24 words). bitcoind's answers are tools/bond3-regtest.mjs's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { holdOutputKey } from '../../arena-protocol/src/bond-script.js';
import { arbitrationCommitment } from '../../arena-protocol/src/arbitration-tx.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint } from '../src/curve.js';
import { createHoldWatch, decideReturn, holdsOfOwnBond, readSlashStart, returnOpensAt, returnToSign, withOwnerSignature, prepareReturnIfOwed } from '../src/hold-return.js';

const secret = taggedHash('ARENA/test/Return', Uint8Array.of(1));
const nodeKey = schnorr.getPublicKey(secret);
const ownerSecret = taggedHash('ARENA/test/Return', Uint8Array.of(9));
const ownerKey = schnorr.getPublicKey(ownerSecret);
const censusKey = schnorr.getPublicKey(taggedHash('ARENA/test/Return', Uint8Array.of(2)));
const ownerSigns = (prepared) => toHex(schnorr.sign(fromHex(prepared.digest), ownerSecret));
const nodeSigns = (prepared) => toHex(schnorr.sign(fromHex(prepared.digest), secret));
const b32 = (n) => new Uint8Array(32).fill(n);
const hold = holdOutputKey({ ownerKey, censusKey, panelA: [], panelB: [], bondMaturity: 1000, holdBlocks: 6, returnBlocks: 432, fallbackBlocks: 288 }, { tweakPoint });
const proof = Uint8Array.of(1, 2, 3);
const proofId = taggedHash('ARENA/v1/SlashProof', proof);
const start = { txid: b32(0x66), value: 100000000n, hold, proofId };
const at = { startHeight: 900, bondMaturity: 1000, returnBlocks: 432 };
const script = fromHex(`5120${'77'.repeat(32)}`);
const decide = (tip, over = {}) => decideReturn({ start, ...at, tip, fetchProof: async () => proof, proofChecks: async () => false, ...over });

test('the leaf opens when both its clocks read true on the next block', () => {
  assert.equal(returnOpensAt(at), 1331);
  assert.equal(returnOpensAt({ ...at, bondMaturity: 2000 }), 2000, 'an immature bond waits for maturity too');
});

test('a proof that fails this node\'s replay: wait for the clock, nothing fetched, then the return', async () => {
  let fetched = 0;
  const early = await decide(1330, { fetchProof: async () => { fetched++; return proof; } });
  assert.deepEqual([early.action, fetched], ['wait', 0]);
  assert.equal((await decide(1331)).action, 'return');
});

test('a true proof is left alone: this is no way out of a slash', async () => {
  const r = await decide(1331, { proofChecks: async () => true });
  assert.equal(r.action, 'keep');
});

test('no answer from the replay waits; no proof, or bytes nobody can produce, has nothing that checks', async () => {
  assert.equal((await decide(1331, { proofChecks: async () => undefined })).action, 'wait');
  assert.equal((await decide(1331, { start: { ...start, proofId: null } })).action, 'return');
  assert.equal((await decide(1331, { fetchProof: async () => null })).action, 'return');
  assert.equal((await decide(1331, { fetchProof: async () => Uint8Array.of(9) })).action, 'return', 'bytes that do not hash to it are not the proof');
});

test('one pass prepares the return once it is owed, and never before; the owner key signs it, the node key cannot', async () => {
  const pass = (tip, over = {}) => prepareReturnIfOwed({ start, ...at, tip, fetchProof: async () => proof, proofChecks: async () => false, toScript: script, feeSats: 500n, ...over });
  assert.equal((await pass(1000)).prepared, undefined);
  assert.equal((await pass(1331, { proofChecks: async () => true })).prepared, undefined);
  const r = await pass(1331);
  assert.equal(r.action, 'return');
  assert.throws(() => withOwnerSignature(r.prepared, nodeSigns(r.prepared), ownerKey), /not the owner key/, 'a hacked node cannot sign its own return');
  const tx = parseTransaction(fromHex(withOwnerSignature(r.prepared, ownerSigns(r.prepared), ownerKey)));
  assert.deepEqual([tx.locktime, tx.inputs[0].sequence, tx.outputs[0].value], [1000, 432, 99999500n]);
  assert.equal(tx.witnesses[0].length, 3);
  assert.equal(toHex(tx.witnesses[0][1]), toHex(hold.scripts.return));
  assert.throws(() => returnToSign({ start, ...at, toScript: script, feeSats: 99999999n }), /below dust/);
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
const clocks = { holdBlocks: 1, returnBlocks: 36, fallbackBlocks: 24 };
const bondTx = b32(0x44), bond = { txid: toHex(Uint8Array.from(bondTx).reverse()), vout: 0, sats: '100000', maturity: 500, censusKey: toHex(censusKey), ownerKey, hold: { txid: 'ab'.repeat(32), vout: 0, height: 465 } };   // #1317: the return opens at 500 (maturity), the fallback before it at 488
const holdsFor = (b, panels = [{ a: panelA, b: panelB }]) => holdsOfOwnBond({ ownerKey: b.ownerKey, censusKey: fromHex(b.censusKey), bondMaturity: b.maturity, clocks, tweakPoint, panels });
const startPaying = (script2) => serializeSpend({ version: 2, locktime: 0, inputs: [{ txid: bondTx, vout: 0, sequence: 0xfffffffd }], outputs: [{ value: 100000n, script: script2 }, arbitrationCommitment(proofId, 479, new Uint8Array(0))], witnesses: [[new Uint8Array(64)]] });
const watch = (raw, over = {}) => createHoldWatch({ clocks, holdsFor, rawTxAt: async () => raw, tipHeight: async () => 499, broadcast: async () => 'sent', ...over });

test('a bond can be in its bonding presig\'s hold or in one a round\'s panels name, and the node knows both', async () => {
  const holds = holdsFor(bond);
  assert.equal(holds.size, 2);
  const shapes = [...holds.values()].map((h) => !!h.leaves.release).sort();
  assert.deepEqual(shapes, [false, true], 'one with a release leaf, the bonding one with none');
  const [plain, panelled] = [...holds.values()].sort((a, b) => Number(!!a.leaves.release) - Number(!!b.leaves.release));
  const a = await watch(startPaying(plain.script)).read(bond);
  assert.deepEqual([a.known, a.startHeight, a.returnOpensAt, a.fallbackOpensAt, a.proofId, a.releaseOpensAt], [true, 465, 500, 488, toHex(proofId), undefined], 'a clock is read from the next block; the fallback opens before the return (kanban #1317)');
  assert.equal((await watch(startPaying(panelled.script)).read(bond)).releaseOpensAt, 465);
  assert.equal((await watch(startPaying(script)).read(bond)).known, false, 'a hold it never signed');
});

test('an owner\'s return: only once its clocks read true, to the address asked', async () => {
  const [plain] = holdsFor(bond).values();
  const raw = startPaying(plain.script);
  assert.match((await watch(raw).returnTo(bond, script)).why, /opens at block 500, 1 from now/);
  const r = await watch(raw, { tipHeight: async () => 500 }).returnTo(bond, script);
  const spend = parseTransaction(fromHex(withOwnerSignature(r.prepared, ownerSigns(r.prepared), ownerKey)));
  assert.deepEqual([spend.locktime, spend.inputs[0].sequence, spend.inputs[0].previousVout], [500, 36, 0]);
  assert.equal(toHex(spend.outputs[0].script), toHex(script));
  assert.equal(spend.outputs[0].value, 99000n);
  assert.match((await watch(startPaying(script), { tipHeight: async () => 500 }).returnTo(bond, script)).why, /no hold output this node signed/);
});

test('a pass: nothing before the clock; then a false proof prepared for the owner and nothing sent, a true one left; the owner\'s signature sends it', async () => {
  const [plain] = holdsFor(bond).values();
  const raw = startPaying(plain.script), sent = [];
  const w = (tip, over = {}) => watch(raw, { tipHeight: async () => tip, broadcast: async (h) => { sent.push(h); return 'tx'; }, fetchProof: async () => proof, proofChecks: async () => false, returnScript: async () => script, ...over });
  assert.equal((await w(499).pass([bond]))[0].action, 'wait');
  assert.equal((await w(500, { proofChecks: async () => true }).pass([bond]))[0].action, 'keep');
  const told = [];
  const watcher = w(500, { notify: (x) => told.push(x.why) });
  const done = await watcher.pass([bond, { ...bond, hold: null }]);
  assert.deepEqual([done.length, done[0].action, sent.length, told.length], [1, 'return', 0, 1], 'owed: prepared and the owner told, nothing sent by the node; an output with no hold is not read');
  await watcher.pass([bond]);
  assert.equal(told.length, 1, 'told once');
  const owed = (await watcher.read(bond)).returnOwed;
  assert.match(owed.why, /does not check/);
  assert.equal((await watcher.submit(bond, owed.prepared, nodeSigns(owed.prepared))).ok, false, 'the node key cannot send it');
  const ok = await watcher.submit(bond, owed.prepared, ownerSigns(owed.prepared));
  assert.deepEqual([ok.ok, ok.sent, sent.length], [true, 'tx', 1]);
  assert.equal((await watcher.read(bond)).returnOwed, null);
  const none = await w(500, { returnScript: async () => null }).pass([bond]);
  assert.deepEqual([none[0].action, none[0].prepared], ['return', undefined], 'no wallet named: owed, and the owner page asks for the address');
});

test('the bytes under the hash are the proof: other bytes are no copy of anything, and there is nothing to try next (ruling #1065)', async () => {
  const proof = Uint8Array.of(7, 7, 7), id = taggedHash('ARENA/v1/SlashProof', proof);
  const decide = (bytes, proofChecks) => decideReturn({ start: { proofId: id }, startHeight: 400, bondMaturity: 100, returnBlocks: 6, tip: 410, fetchProof: async () => bytes, proofChecks });
  assert.equal((await decide(proof, async () => true)).action, 'keep');
  assert.equal((await decide(proof, async () => false)).action, 'return', 'bytes that hash and do not check: the start really was false');
  assert.equal((await decide(Uint8Array.of(7, 7, 8), async () => true)).action, 'return', 'bytes that do not hash are never judged');
});

// ---- kanban #1193: THE RETURN'S STATE IS PER START AND ON DISK, AND A PROOF THAT CHECKED ONCE IS KEPT FOR GOOD ----
test('kanban #1193: a proof that checks after the return was prepared recalls it; a later "does not check" prepares nothing; neither page nor node sends one', async () => {
  const [plain] = holdsFor(bond).values();
  const raw = startPaying(plain.script), sent = [];
  let verdict = false;
  const w = watch(raw, { tipHeight: async () => 500, broadcast: async (h) => { sent.push(h); return 'tx'; }, fetchProof: async () => proof, proofChecks: async () => verdict, returnScript: async () => script });
  assert.equal((await w.pass([bond]))[0].action, 'return');
  const prepared = (await w.read(bond)).returnOwed.prepared;
  assert.ok(prepared, 'prepared for the owner');
  // THE REPLAY NOW HOLDS THE PROOF (its round's data came in)
  verdict = true;
  await w.pass([bond]);
  const recalled = (await w.read(bond)).returnOwed;
  // AND LATER SAYS OTHERWISE AGAIN (a replay that is not monotone)
  verdict = false;
  const later = (await w.pass([bond]))[0].action;
  const again = (await w.read(bond)).returnOwed;
  const submitted = await w.submit(bond, prepared, ownerSigns(prepared));
  const asked = await w.returnTo(bond, script);
  const facts = { recalled: recalled === null, laterAction: later, preparedAgain: again !== null, submitted: submitted.ok, returnToOk: asked.ok, sent: sent.length };
  console.log('  FACTS (#1193, proof checks after the return was prepared):', JSON.stringify(facts));
  assert.deepEqual(facts, { recalled: true, laterAction: 'keep', preparedAgain: false, submitted: false, returnToOk: false, sent: 0 });
  assert.match(submitted.why, /checked on this node's replay|checks on this node's replay/);
});

test('kanban #1193: the owed return survives a restart, and a reorg that moves the start is another start, judged at its own height', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const [plain] = holdsFor(bond).values();
  const raw = startPaying(plain.script);
  // THE REPLAY SAYS FALSE AT THE START'S FIRST HEIGHT, TRUE ONCE A REORG MINED IT AT 483 (the round's census reads otherwise there)
  const checks = async (bytes, { startHeight }) => startHeight === 483;
  const w = (over = {}) => watch(raw, { db, tipHeight: async () => 520, fetchProof: async () => proof, proofChecks: checks, returnScript: async () => script, ...over });
  await w().pass([bond]);
  const restarted = (await w().read(bond)).returnOwed;
  // ONE RUN THROUGH THE REORG: it prepared the return at 465, then reads the start at 483
  const one = w();
  await one.pass([bond]);
  const moved = { ...bond, hold: { ...bond.hold, height: 483 } };
  const atNew = (await one.pass([moved]))[0].action;
  const owedNew = (await one.read(moved)).returnOwed;
  const facts = { owedAfterRestart: !!(restarted && restarted.prepared), afterReorg: atNew, owedAfterReorg: owedNew !== null };
  console.log('  FACTS (#1193, restart and reorg):', JSON.stringify(facts));
  assert.deepEqual(facts, { owedAfterRestart: true, afterReorg: 'keep', owedAfterReorg: false });
  assert.equal(restarted.prepared.digest, (await w().returnTo(bond, script, 1000n)).prepared.digest, 'the same return as prepared before the stop');
});

test('an owner\'s return the mempool refuses can be sent again', async () => {
  const [plain] = holdsFor(bond).values();
  const sent = [];
  let refuse = true;
  const w = watch(startPaying(plain.script), { tipHeight: async () => 500, broadcast: async (h) => { if (refuse) throw new Error('the mempool refuses it'); sent.push(h); return 'tx'; } });
  const r = await w.returnTo(bond, script);
  assert.match((await w.submit(bond, r.prepared, ownerSigns(r.prepared))).why, /the mempool refuses it/);
  refuse = false;
  assert.equal((await w.submit(bond, r.prepared, ownerSigns(r.prepared))).sent, 'tx');
  assert.equal(sent.length, 1);
});
