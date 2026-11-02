#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TEMPLATE 3, ASKED OF BITCOIND (kanban #972, spec 5A.3B). A private regtest, never testnet4, never a live bond. The spec's table was
// measured with a throwaway script and one plain key standing in for the census key. This asks the same questions of the bytes
// bond-script.js builds, on mainnet's clocks, and the census key here is a real weighted FROST key: 15 nodes, 32 shares, threshold 22.
// One line per question, expected answer beside it; exits 1 if any differs.
//
//   bitcoind -regtest -datadir=DIR -port=29144 -rpcport=29143 -listen=0 -fallbackfee=0.0001 -daemon
//   RT=DIR RPCPORT=29143 node tools/bond3-regtest.mjs          (from packages/arena-node)
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { genesisFor, SLASH_CLOCKS } from '../../arena-protocol/src/genesis.js';
import {
  bond3OutputKey, bondInternalKey, holdOutputKey, holdControlBlock, controlBlockFor, recoveryLeaf, slashStartLeaf, tapLeafHash, tapTweak,
  HOLD_INTERNAL_KEY, TAPLEAF_VERSION,
} from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { arbitrationCommitment } from '../../arena-protocol/src/arbitration-tx.js';
import { toHex, fromHex, taggedHash } from '../../arena-protocol/src/hash.js';
import { tweakPoint, combine } from '../src/curve.js';
import { weightedKeygen, weightsFor, signersFor, signByNode } from './census-key-measure.mjs';

const RT = process.env.RT, PORT = process.env.RPCPORT || '29143', B = process.env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli';
if (!RT) throw new Error('RT=<the private regtest datadir>');
const cli = (...a) => execFileSync(B, ['-regtest', `-datadir=${RT}`, `-rpcport=${PORT}`, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try { cli('loadwallet', 'bond3'); } catch { try { cli('createwallet', 'bond3'); } catch { /* loaded */ } }
const mine = (n) => { if (n > 0) cli('generatetoaddress', String(n), cli('getnewaddress')); };
if (Number(cli('getblockcount')) < 101) mine(101);
const tip = () => Number(cli('getblockcount'));

let wrong = 0, asked = 0;
function ask(label, expected, hex) {
  const r = JSON.parse(cli('testmempoolaccept', JSON.stringify([hex])))[0];
  asked++;
  if (r.allowed !== expected) wrong++;
  console.log(`#972 ${r.allowed === expected ? 'as expected' : 'WRONG      '} ${r.allowed ? 'accepted' : 'refused '} ${r.vsize ? `${r.vsize} vB` : ''} | ${label}${r.allowed ? '' : ` | ${r['reject-reason']}${r['reject-details'] ? ` ${r['reject-details'].slice(0, 60)}` : ''}`}`);
  return r;
}

const CLOCKS = SLASH_CLOCKS.mainnet;
const clocks = { holdBlocks: CLOCKS.slashHoldBlocks, returnBlocks: CLOCKS.slashReturnBlocks, fallbackBlocks: CLOCKS.slashFallbackBlocks };
const g = genesisFor('regtest');
const person = () => { const secret = schnorr.utils.randomSecretKey(); return { secret, key: schnorr.getPublicKey(secret) }; };
const panel = () => Array.from({ length: 7 }, person);
const keys = (list) => list.map((p) => p.key);
const compare = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const sorted = (list) => [...list].sort((a, b) => compare(a.key, b.key));
const walletScript = () => fromHex(JSON.parse(cli('getaddressinfo', cli('getnewaddress'))).scriptPubKey);
const EMPTY = new Uint8Array(0);

const census = await weightedKeygen({ weights: weightsFor(15, 10) });
const censusKey = census.groupPublicKey.subarray(1);
const censusSign = (digest) => { const r = signByNode(census, digest, signersFor(census)); return r.sig.signature; };
console.log(`#972 census key ${toHex(censusKey).slice(0, 16)}: 15 nodes, ${census.total} shares, threshold ${census.needed}`);

const roundA = { a: panel(), b: panel() }, roundB = { a: panel(), b: panel() };

/** A template-3 bond, funded here. */
function fundBond(node, bondMaturity) {
  const arbitrationKeys = g.arbitrationKeys;
  const internalKey = bondInternalKey({ nodeKey: node.key, arbitrationKeys }, { combine }).internalKey;
  const built = bond3OutputKey({ nodeKey: node.key, censusKey, arbitrationKeys, bondMaturity, internalKey }, { tweakPoint, combine });
  if (!built.ok) throw new Error(built.why);
  const script = fromHex(`5120${toHex(built.outputKey)}`);
  const txid = cli('sendtoaddress', JSON.parse(cli('decodescript', toHex(script))).address, '1.0');
  mine(1);
  const vout = JSON.parse(cli('gettransaction', txid, 'true', 'true')).decoded.vout.find((o) => o.scriptPubKey.hex === toHex(script)).n;
  return { node, bondMaturity, built, txid: fromHex(txid).reverse(), vout, value: 100000000n, script };
}

/** Whoever files the slash brings a fee coin: a one-leaf P2TR on their key, spent beside the bond. */
function fundFee() {
  const payer = person();
  const leafScript = new Uint8Array([0x20, ...payer.key, 0xac]);
  const leaf = tapLeafHash(leafScript);
  const q = tweakPoint(HOLD_INTERNAL_KEY, tapTweak(HOLD_INTERNAL_KEY, leaf));
  const script = fromHex(`5120${toHex(q.outputKey)}`);
  const txid = cli('sendtoaddress', JSON.parse(cli('decodescript', toHex(script))).address, '0.001');
  mine(1);
  const vout = JSON.parse(cli('gettransaction', txid, 'true', 'true')).decoded.vout.find((o) => o.scriptPubKey.hex === toHex(script)).n;
  return { payer, leafScript, leaf, control: new Uint8Array([TAPLEAF_VERSION | q.parity, ...HOLD_INTERNAL_KEY]), txid: fromHex(txid).reverse(), vout, value: 100000n, script };
}

const holdOf = (bond, round) => {
  const h = holdOutputKey({ nodeKey: bond.node.key, censusKey, panelA: keys(round.a), panelB: keys(round.b), bondMaturity: bond.bondMaturity, ...clocks }, { tweakPoint });
  if (!h.ok) throw new Error(h.why);
  return h;
};

/** slash_presig: version 2, nLockTime 0, the bond at sequence 0xfffffffd, output 0 the whole bond to the hold, hash type 0x83. */
function presig(bond, holdScript) {
  const leafHash = tapLeafHash(slashStartLeaf(bond.node.key, censusKey));
  const digest = tapSighash({ version: 2, locktime: 0, inputs: [{ txid: bond.txid, vout: bond.vout, sequence: 0xfffffffd }],
    outputs: [{ value: bond.value, script: holdScript }], prevouts: [{ value: bond.value, script: bond.script }], inputIndex: 0, leafHash, hashType: 0x83 });
  return new Uint8Array([...schnorr.sign(digest, bond.node.secret), 0x83]);
}

/** The start as filed: presig on input 0, the fee coin as input 1, the proof's OP_RETURN, the change. `signed` is what the presig was over. */
function start(bond, fee, { pay, nodeSig, census: useCensus = true }) {
  const leafScript = slashStartLeaf(bond.node.key, censusKey);
  const leafHash = tapLeafHash(leafScript);
  const proofId = taggedHash('ARENA/v1/SlashProof', randomBytes(32));
  const tx = { version: 2, locktime: 0,
    inputs: [{ txid: bond.txid, vout: bond.vout, sequence: 0xfffffffd }, { txid: fee.txid, vout: fee.vout, sequence: 0xfffffffd }],
    outputs: [{ value: bond.value, script: pay }, arbitrationCommitment(proofId, tip(), EMPTY), { value: fee.value - 5000n, script: walletScript() }] };
  const prevouts = [{ value: bond.value, script: bond.script }, { value: fee.value, script: fee.script }];
  const digest = tapSighash({ ...tx, prevouts, inputIndex: 0, leafHash });
  const feeDigest = tapSighash({ ...tx, prevouts, inputIndex: 1, leafHash: fee.leaf });
  const censusSig = useCensus ? censusSign(digest) : EMPTY;
  const control = controlBlockFor('slash', bond.built).controlBlock;
  return toHex(serializeSpend({ ...tx, witnesses: [
    scriptPathWitness({ stack: [censusSig, nodeSig], script: leafScript, controlBlock: control }),
    scriptPathWitness({ stack: [schnorr.sign(feeDigest, fee.payer.secret)], script: fee.leafScript, controlBlock: fee.control }),
  ] }));
}

const holdInput = (startHex, sequence) => ({ txid: fromHex(cli('decoderawtransaction', startHex, 'true') && JSON.parse(cli('decoderawtransaction', startHex)).txid).reverse(), vout: 0, sequence });

function spendHold(bond, hold, startHex, path, { sequence, locktime = 0, sign }) {
  const tx = { version: 2, locktime, inputs: [holdInput(startHex, sequence)],
    outputs: [{ value: bond.value - 20000n, script: walletScript() }] };
  if (path === 'release') tx.outputs.unshift(arbitrationCommitment(taggedHash('ARENA/v1/SlashProof', randomBytes(32)), tip(), randomBytes(32)));
  const script = hold.scripts[path];
  const digest = tapSighash({ ...tx, prevouts: [{ value: bond.value, script: hold.script }], inputIndex: 0, leafHash: hold.leaves[path] });
  return toHex(serializeSpend({ ...tx, witnesses: [scriptPathWitness({ stack: sign(digest), script, controlBlock: holdControlBlock(path, hold).controlBlock })] }));
}

/** `n` of panel A and `m` of panel B, one item per key in the order the leaf checks them, bottom-first. */
const panelStack = (round, n, m) => (digest) => {
  const line = (list, count) => sorted(list).map((p, i) => (i < count ? schnorr.sign(digest, p.secret) : EMPTY));
  return [...line(round.a, n), ...line(round.b, m)].reverse();
};
const release = (bond, hold, startHex, round, n, m, sequence = clocks.holdBlocks) => spendHold(bond, hold, startHex, 'release', { sequence, sign: panelStack(round, n, m) });

// ---- bond 1, not mature: the start, the release, the fallback
const node1 = person();
const bond1 = fundBond(node1, tip() + 1000);
const hold1A = holdOf(bond1, roundA), hold1B = holdOf(bond1, roundB);
const presig1A = presig(bond1, hold1A.script), presig1B = presig(bond1, hold1B.script);
const fee1 = fundFee();
ask('census key + presig, money to another address', false, start(bond1, fee1, { pay: walletScript(), nodeSig: presig1A }));
ask('presig without the census key', false, start(bond1, fee1, { pay: hold1A.script, nodeSig: presig1A, census: false }));
ask('census key without a presig', false, start(bond1, fee1, { pay: hold1A.script, nodeSig: EMPTY }));
ask('round 1\'s presig on round 2\'s hold output', false, start(bond1, fee1, { pay: hold1B.script, nodeSig: presig1A }));
const start1 = start(bond1, fee1, { pay: hold1A.script, nodeSig: presig1A });
ask('round 1\'s presig to its own hold output, FROST census key', true, start1);
const fee1b = fundFee();
ask('round 2\'s presig to its own hold output, FROST census key', true, start(bond1, fee1b, { pay: hold1B.script, nodeSig: presig1B }));
cli('sendrawtransaction', start1); mine(1);
ask('round 2\'s presig after round 1\'s start', false, start(bond1, fee1b, { pay: hold1B.script, nodeSig: presig1B }));

ask('release at 1 confirmation', false, release(bond1, hold1A, start1, roundA, 5, 5));
mine(clocks.holdBlocks - 2);
ask(`release at ${clocks.holdBlocks - 1} confirmations`, false, release(bond1, hold1A, start1, roundA, 5, 5));
mine(1);
ask(`release at ${clocks.holdBlocks} by round 2's panels on round 1's hold`, false, spendHold(bond1, hold1A, start1, 'release', { sequence: clocks.holdBlocks, sign: panelStack(roundB, 5, 5) }));
ask('release, panel A alone', false, release(bond1, hold1A, start1, roundA, 7, 0));
ask('release, panel B alone', false, release(bond1, hold1A, start1, roundA, 0, 7));
ask('release, 5 + 4', false, release(bond1, hold1A, start1, roundA, 5, 4));
ask('release, 4 + 5', false, release(bond1, hold1A, start1, roundA, 4, 5));
ask('release, 5 + 5', true, release(bond1, hold1A, start1, roundA, 5, 5));
ask('release, 7 + 7 (a third signature counts over the threshold)', false, release(bond1, hold1A, start1, roundA, 7, 7));

const fallbackBy = (signer) => spendHold(bond1, hold1A, start1, 'fallback', { sequence: clocks.fallbackBlocks, sign: signer });
ask('fallback before its clock, census key', false, fallbackBy((d) => [censusSign(d)]));
mine(clocks.returnBlocks - clocks.holdBlocks);
ask('return, immature bond, at its clock', false, spendHold(bond1, hold1A, start1, 'return', { sequence: clocks.returnBlocks, locktime: tip(), sign: (d) => [schnorr.sign(d, node1.secret)] }));
mine(clocks.fallbackBlocks - clocks.returnBlocks - 1);
ask('fallback one block early, census key', false, fallbackBy((d) => [censusSign(d)]));
mine(1);
ask('fallback at its clock, another key', false, fallbackBy((d) => [schnorr.sign(d, node1.secret)]));
const fallback = ask('fallback at its clock, FROST census key, immature bond', true, fallbackBy((d) => [censusSign(d)]));

// ---- bond 2, matures early: the node leaves
const node2 = person();
const bond2 = fundBond(node2, tip() + 3);
const hold2 = holdOf(bond2, roundA);
const fee2 = fundFee();
const start2 = start(bond2, fee2, { pay: hold2.script, nodeSig: presig(bond2, hold2.script) });
cli('sendrawtransaction', start2); mine(clocks.returnBlocks - 1);
const returnBy = (who, sequence = clocks.returnBlocks) => spendHold(bond2, hold2, start2, 'return', { sequence, locktime: tip(), sign: (d) => [schnorr.sign(d, who.secret)] });
ask(`return at ${clocks.returnBlocks - 1} confirmations`, false, returnBy(node2));
mine(1);
ask(`return at ${clocks.returnBlocks}, another key`, false, returnBy(person()));
ask(`return at ${clocks.returnBlocks}, mature node`, true, returnBy(node2));

// ---- bond 3: path A is the same leaf as before, after maturity
const node3 = person();
const bond3 = fundBond(node3, tip() + 2);
const recover = (locktime) => {
  const tx = { version: 2, locktime, inputs: [{ txid: bond3.txid, vout: bond3.vout, sequence: 0xfffffffe }], outputs: [{ value: bond3.value - 2000n, script: walletScript() }] };
  const script = recoveryLeaf(node3.key, bond3.bondMaturity);
  const digest = tapSighash({ ...tx, prevouts: [{ value: bond3.value, script: bond3.script }], inputIndex: 0, leafHash: tapLeafHash(script) });
  return toHex(serializeSpend({ ...tx, witnesses: [scriptPathWitness({ stack: [schnorr.sign(digest, node3.secret)], script, controlBlock: controlBlockFor('recovery', bond3.built).controlBlock })] }));
};
ask('path A before maturity', false, recover(bond3.bondMaturity));
mine(3);
ask('path A after maturity', true, recover(bond3.bondMaturity));

console.log(`#972 ${asked - wrong} of ${asked} as expected; tip ${tip()}; fallback ${fallback.vsize} vB`);
process.exit(wrong ? 1 : 0);
