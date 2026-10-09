#!/usr/bin/env node
// THE ORACLE FOR `bond-spend.js`, AND THE ONLY ONE THIS TREE HAS.
//
// There are no BIP-341 vectors here offline, so the way to know a witness is
// right is to hand it to a node and see. This script funds two bonds on a
// throwaway regtest, spends one by the recovery leaf and one by the slash
// leaf, and asks bitcoind. Run it against a regtest daemon of your own:
//
//   bitcoind -regtest -datadir=DIR -port=19444 -rpcport=19443 -fallbackfee=0.0001 -daemon
//   RT=DIR node tools/bond-regtest.mjs        (from packages/arena-node)
//
// It touches no mainnet or testnet datadir and creates its own wallet.
//
// IT LIVES HERE AND NOT IN `packages/protocol` because it needs a curve, and
// that package carries none - the same rule that keeps the tweak and the
// aggregate injected.
import { execFileSync } from 'node:child_process';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import {
  bondOutputKey, bondInternalKey, recoveryLeaf, slashLeaf, tapLeafHash, controlBlockFor,
} from '../../arena-protocol/src/bond-script.js';
import {
  tapSighash, scriptPathWitness, serializeSpend, commitmentOutput, spendCommitsTo,
} from '../../arena-protocol/src/bond-spend.js';
import { toHex, fromHex, taggedHash } from '../../arena-protocol/src/hash.js';
import { chainFactsAt } from '../../arena-protocol/src/census.js';

const RT = process.env.RT, B = '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli';
const cli = (...a) => execFileSync(B, ['-regtest', `-datadir=${RT}`, '-rpcport=19443', ...a], { encoding: 'utf8' }).trim();
const big = (b) => BigInt('0x' + toHex(b));
const tweakPoint = (P, t) => {
  const Q = schnorr.utils.lift_x(big(P)).add(secp256k1.Point.BASE.multiply(big(t)));
  return { outputKey: schnorr.utils.pointToBytes(Q), parity: Number(Q.toAffine().y & 1n) };
};
const combine = (terms) => {
  let sum = null;
  for (const { key, coefficient } of terms) {
    const p = schnorr.utils.lift_x(big(key)).multiply(big(coefficient));
    sum = sum === null ? p : sum.add(p);
  }
  return schnorr.utils.pointToBytes(sum);
};
// THE WALLET AND THE COINS ARE THIS SCRIPT'S OWN. A regtest daemon starts with
// no wallet loaded and no blocks, so a tool that assumed either would work once
// and fail on the next fresh datadir - which is exactly what happened.
try { cli('loadwallet', 'bondtest'); } catch { cli('createwallet', 'bondtest'); }
if (Number(cli('getblockcount')) < 101) cli('generatetoaddress', '101', cli('getnewaddress'));

const g = genesisFor('regtest');

/** The arbitration secrets this test network derives, by public key. */
const signerNodes = new Map();
for (let i = 0; i < g.arbitrationM; i++) {
  const secret = taggedHash('BLWP/v1/TestArbitration', new TextEncoder().encode(`bitcoin-regtest:${i}`));
  signerNodes.set(toHex(schnorr.getPublicKey(secret)), secret);
}

function bondFor(nodeSecret) {
  const nodeKey = schnorr.getPublicKey(nodeSecret);
  const built = bondOutputKey({
    nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK,
    bondMaturity: g.bondMaturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey,
  }, { tweakPoint, combine });
  return { nodeKey, built, spk: fromHex('5120' + toHex(built.outputKey)) };
}

function fund(spk) {
  const address = JSON.parse(cli('decodescript', toHex(spk))).address;
  const txid = cli('sendtoaddress', address, '1.0');
  cli('generatetoaddress', '1', cli('getnewaddress'));
  const decoded = JSON.parse(cli('gettransaction', txid, 'true', 'true')).decoded;
  const vout = decoded.vout.find((o) => o.scriptPubKey.hex === toHex(spk)).n;
  return { txid, vout, value: 100000000n };
}

const payTo = fromHex(JSON.parse(cli('getaddressinfo', cli('getnewaddress'))).scriptPubKey);

function spendOf({ utxo, spk, script, leaf, control, sign, locktime, commits }) {
  const inputs = [{ txid: fromHex(utxo.txid).reverse(), vout: utxo.vout, sequence: 0xfffffffe }];
  const outputs = [{ value: utxo.value - 2000n, script: payTo }];
  // 5A.3B step 4: a slash commits to the proof that justified it, so every
  // slash is permanently auditable.
  if (commits) outputs.push(commitmentOutput(commits));
  const spend = { version: 2, locktime, inputs, outputs };
  const sighash = tapSighash({ ...spend, prevouts: [{ value: utxo.value, script: spk }], inputIndex: 0, leafHash: leaf });
  return {
    outputs,
    hex: toHex(serializeSpend({ ...spend, witnesses: [scriptPathWitness({ stack: sign(sighash), script, controlBlock: control })] })),
  };
}
const allowed = (hex) => {
  const r = JSON.parse(cli('testmempoolaccept', JSON.stringify([hex])))[0];
  return { ok: r.allowed, why: r['reject-reason'] || null };
};

// ---- two bonds, one for each leaf
const secretA = schnorr.utils.randomSecretKey();
const secretB = schnorr.utils.randomSecretKey();
const bondA = bondFor(secretA);
const bondB = bondFor(secretB);
const utxoA = fund(bondA.spk);
const utxoB = fund(bondB.spk);

// ---- recovery, by the node itself, after maturity
const recA = recoveryLeaf(bondA.nodeKey, g.bondMaturity);
const recovery = spendOf({
  utxo: utxoA, spk: bondA.spk, script: recA, leaf: tapLeafHash(recA),
  control: controlBlockFor('recovery', bondA.built).controlBlock,
  sign: (h) => [schnorr.sign(h, secretA)], locktime: g.bondMaturity,
});
console.log('recovery, honest        ', JSON.stringify(allowed(recovery.hex)));

// ---- recovery signed by a stranger
const stranger = schnorr.utils.randomSecretKey();
const forged = spendOf({
  utxo: utxoA, spk: bondA.spk, script: recA, leaf: tapLeafHash(recA),
  control: controlBlockFor('recovery', bondA.built).controlBlock,
  sign: (h) => [schnorr.sign(h, stranger)], locktime: g.bondMaturity,
});
console.log('recovery, stranger      ', JSON.stringify(allowed(forged.hex)));

// ---- recovery BEFORE maturity, which is the whole reason CLTV is in the leaf
const early = spendOf({
  utxo: utxoA, spk: bondA.spk, script: recA, leaf: tapLeafHash(recA),
  control: controlBlockFor('recovery', bondA.built).controlBlock,
  sign: (h) => [schnorr.sign(h, secretA)], locktime: g.bondMaturity - 1,
});
console.log('recovery, before maturity', JSON.stringify(allowed(early.hex)));

// ---- slash, five of the seven signer nodes
const sorted = [...g.arbitrationKeys].sort((a, b) => {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
});
const slashScript = slashLeaf(g.arbitrationKeys, g.arbitrationK);
const signWith = (count) => (h) => {
  const items = sorted.map((k, i) => (i < count ? schnorr.sign(h, signerNodes.get(toHex(k))) : new Uint8Array(0)));
  return items.reverse();          // bottom-first: the first key's signature ends on top
};
// A WELL-FORMED SLASH commits to the proof that justified it.
const proofId = taggedHash('ARENA/v1/SlashProof', fromHex('ab'.repeat(32)));
const slash5 = spendOf({
  utxo: utxoB, spk: bondB.spk, script: slashScript, leaf: tapLeafHash(slashScript),
  control: controlBlockFor('slash', bondB.built).controlBlock, sign: signWith(5), locktime: 0,
  commits: proofId,
});
console.log('slash, five of seven    ', JSON.stringify(allowed(slash5.hex)),
  '| commits to the proof', JSON.stringify(spendCommitsTo(slash5.outputs, proofId).ok));

// AND ONE WITHOUT THE COMMITMENT. Consensus does not care - it is a valid
// transaction and bitcoind takes it - which is exactly why the protocol must.
const bare = spendOf({
  utxo: utxoB, spk: bondB.spk, script: slashScript, leaf: tapLeafHash(slashScript),
  control: controlBlockFor('slash', bondB.built).controlBlock, sign: signWith(5), locktime: 0,
});
console.log('slash, no commitment    ', JSON.stringify(allowed(bare.hex)),
  '| protocol says', JSON.stringify(spendCommitsTo(bare.outputs, proofId)));
const slash4 = spendOf({
  utxo: utxoB, spk: bondB.spk, script: slashScript, leaf: tapLeafHash(slashScript),
  control: controlBlockFor('slash', bondB.built).controlBlock, sign: signWith(4), locktime: 0,
});
console.log('slash, four of seven    ', JSON.stringify(allowed(slash4.hex)));

// ---- a second node, given only the body and genesis, builds the same witness
const second = bondFor(secretA);
const again = spendOf({
  utxo: utxoA, spk: second.spk, script: recoveryLeaf(second.nodeKey, g.bondMaturity),
  leaf: tapLeafHash(recoveryLeaf(second.nodeKey, g.bondMaturity)),
  control: controlBlockFor('recovery', second.built).controlBlock,
  sign: (h) => [schnorr.sign(h, secretA)], locktime: g.bondMaturity,
});
// TWO SIGNATURES OVER ONE MESSAGE DIFFER: BIP-340 signing draws auxiliary
// randomness, so byte-identity is the wrong claim. What must match is
// everything the two nodes DERIVED - the leaf, the control block, the output
// key - and what must hold is that the second node's spend is accepted too.
const sameScript = toHex(recoveryLeaf(second.nodeKey, g.bondMaturity)) === toHex(recA);
const sameControl = toHex(controlBlockFor('recovery', second.built).controlBlock)
  === toHex(controlBlockFor('recovery', bondA.built).controlBlock);
console.log('second node, same leaf   ', sameScript && sameControl,
  '| same output key', toHex(second.built.outputKey) === toHex(bondA.built.outputKey));
console.log('second node, accepted    ', JSON.stringify(allowed(again.hex)));

// ---- A DETERMINISTIC VECTOR, so a committed test can pin what bitcoind just
// accepted. Fixed keys, fixed outpoint, fixed amounts: only the signature is
// random, and the sighash is what the signature covers.
const fixedSecret = fromHex('11'.repeat(32));
const fixedNode = schnorr.getPublicKey(fixedSecret);
const fixedBond = bondFor(fixedSecret);
const fixedLeaf = recoveryLeaf(fixedNode, g.bondMaturity);
const fixedSpend = {
  version: 2, locktime: g.bondMaturity,
  inputs: [{ txid: fromHex('22'.repeat(32)), vout: 1, sequence: 0xfffffffe }],
  outputs: [{ value: 99998000n, script: fromHex('0014' + '33'.repeat(20)) }],
};
const fixedSighash = tapSighash({
  ...fixedSpend, prevouts: [{ value: 100000000n, script: fixedBond.spk }],
  inputIndex: 0, leafHash: tapLeafHash(fixedLeaf),
});
console.log('VECTOR nodeKey  ', toHex(fixedNode));
console.log('VECTOR outputKey', toHex(fixedBond.built.outputKey));
console.log('VECTOR leafHash ', toHex(tapLeafHash(fixedLeaf)));
console.log('VECTOR sighash  ', toHex(fixedSighash));
console.log('VECTOR control  ', toHex(controlBlockFor('recovery', fixedBond.built).controlBlock));

// ---- broadcast the honest recovery, mine it, and read the chain back
const sent = cli('sendrawtransaction', recovery.hex);
const hash = JSON.parse(cli('generatetoaddress', '1', cli('getnewaddress')))[0];
const height = JSON.parse(cli('getblock', hash))?.height;
const blocks = [];
const tip = Number(cli('getblockcount'));
for (let h = tip - 5; h <= tip; h++) {
  const b = JSON.parse(cli('getblock', cli('getblockhash', String(h)), '2'));
  blocks.push({ height: h, transactions: b.tx.map((t) => fromHex(t.hex)) });
}
const facts = chainFactsAt(blocks, tip);
// The census keys outpoints by the txid as it is HASHED, which is the reverse
// of the way an API prints one.
const key = `${toHex(fromHex(utxoA.txid).reverse())}:${utxoA.vout}`;
console.log('broadcast               ', sent.slice(0, 16), 'at height', height);
console.log('spent, seen by the census', facts.spentAt.has(key));
