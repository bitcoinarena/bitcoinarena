#!/usr/bin/env node
// THE ARBITRATION TRANSACTION, ASKED OF BITCOIND (§5A.3B; PRIORITIES 2026-09-29 item 4 - M4 in the repo only). A
// private regtest, never testnet4, never a live bond: a bond is funded here, and the slashing transaction
// `arbitration-tx.js` builds from slash.js's own distribution is handed to `testmempoolaccept` - 5 of 7 arbitration
// signatures, then the ways it must fail - then mined, and the players' escrow it pays is spent by the arbitration set
// in turn. Printed, one JSON line per question; it decides nothing.
//
//   bitcoind -regtest -datadir=DIR -port=19444 -rpcport=19443 -fallbackfee=0.0001 -daemon
//   RT=DIR node tools/arbitration-regtest.mjs          (from packages/arena-node)
import { execFileSync } from 'node:child_process';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { bondOutputKey, bondInternalKey, slashLeaf, tapLeafHash, controlBlockFor, maturityHeightFor } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import {
  escrowOutput, arbitrationSpend, arbitrationSighash, arbitrationWitness, arbitrationTransaction, arbitrationCommitmentIn,
} from '../../arena-protocol/src/arbitration-tx.js';
import { slashDistribution } from '../../arena-protocol/src/slash.js';
import { toHex, fromHex, taggedHash } from '../../arena-protocol/src/hash.js';

const RT = process.env.RT, PORT = process.env.RPCPORT || '19443', B = '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli';
if (!RT) throw new Error('RT=<the private regtest datadir>');
const cli = (...a) => execFileSync(B, ['-regtest', `-datadir=${RT}`, `-rpcport=${PORT}`, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const out = (o) => console.log(JSON.stringify(o));
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
try { cli('loadwallet', 'arbtest'); } catch { try { cli('createwallet', 'arbtest'); } catch { /* loaded */ } }
const mine = (n) => cli('generatetoaddress', String(n), cli('getnewaddress'));
if (Number(cli('getblockcount')) < 101) mine(101);

const g = genesisFor('regtest');
const K = g.arbitrationK;
const secrets = new Map();
for (let i = 0; i < g.arbitrationM; i++) {
  const secret = taggedHash('BLWP/v1/TestArbitration', new TextEncoder().encode(`bitcoin-regtest:${i}`));
  secrets.set(toHex(schnorr.getPublicKey(secret)), secret);
}
const sorted = [...g.arbitrationKeys].sort((a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; });
const signBy = (count) => (h) => new Map(sorted.slice(0, count).map((k) => [toHex(k), schnorr.sign(h, secrets.get(toHex(k)))]));
const accepts = (hex) => { const r = JSON.parse(cli('testmempoolaccept', JSON.stringify([hex])))[0]; return { allowed: r.allowed, why: r['reject-reason'] || null }; };

// ---- a bond, funded here (never a live one)
const nodeSecret = schnorr.utils.randomSecretKey();
const nodeKey = schnorr.getPublicKey(nodeSecret);
// THE BOND AT ITS OWN HEIGHT (kanban #295, template 2): the next block plus regtest's offset - the slash leaf is the same
const bondMaturity = maturityHeightFor(Number(cli('getblockcount')), 'regtest', { slackBlocks: 0 });
const bondBuilt = bondOutputKey({ nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: K, bondMaturity,
  internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine });
const bondSpk = fromHex('5120' + toHex(bondBuilt.outputKey));
const fundTxid = cli('sendtoaddress', JSON.parse(cli('decodescript', toHex(bondSpk))).address, '1.0');
mine(1);
const fundVout = JSON.parse(cli('gettransaction', fundTxid, 'true', 'true')).decoded.vout.find((o) => o.scriptPubKey.hex === toHex(bondSpk)).n;
const bond = { txid: fromHex(fundTxid).reverse(), vout: fundVout, value: 100000000n, script: bondSpk };

// ---- the distribution, slash.js's own: two affected players, a census of four, one of them the round's seat
const key = (n) => schnorr.getPublicKey(taggedHash('ARENA/v1/ArbProbe', Uint8Array.from([n])));
const distribution = slashDistribution({ bondSats: bond.value, roundId: new Uint8Array(32).fill(7), contract: { slashRemainder: 'SPLIT' },
  affectedPlayers: [key(1), key(2)], censusNodes: [key(10), key(11), key(12), key(13)], seats: [key(10)] });
const escrow = escrowOutput({ arbitrationKeys: g.arbitrationKeys, k: K }, { tweakPoint, combine });
const walletSpk = () => fromHex(JSON.parse(cli('getaddressinfo', cli('getnewaddress'))).scriptPubKey);
const nodesScript = walletSpk(); const developersScript = walletSpk();
const proofId = taggedHash('ARENA/v1/SlashProof', fromHex('cd'.repeat(32)));
const tip = Number(cli('getblockcount'));
const slashLeafScript = slashLeaf(g.arbitrationKeys, K);
const leaf = tapLeafHash(slashLeafScript);
const control = controlBlockFor('slash', bondBuilt).controlBlock;

const build = (slashHeight, signers = K, tamper = null) => {
  const built = arbitrationSpend({ bond, proofId, slashHeight, hint: new TextEncoder().encode('blwp'), distribution,
    escrowScript: escrow.script, nodesScript, developersScript, feeSats: 3000n });
  if (!built.ok) return { built };
  const h = arbitrationSighash(built, leaf);
  const w = arbitrationWitness({ arbitrationKeys: g.arbitrationKeys, k: K, signatures: signBy(signers)(h), controlBlock: control });
  // UNDER K, forced past the builder's own refusal, to hear the node refuse it too.
  const witness = w.ok ? w.witness : scriptPathWitness({ stack: sorted.map((k, i) => (i < signers ? signBy(signers)(h).get(toHex(k)) : new Uint8Array(0))).reverse(), script: slashLeafScript, controlBlock: control });
  if (tamper) tamper(built);
  return { built, builderRefused: w.ok ? null : w.why, hex: toHex(arbitrationTransaction(built, witness)) };
};

const good = build(tip);
out({ step: 'built', slashHeight: tip, amounts: Object.fromEntries(Object.entries(good.built.amounts).map(([k, v]) => [k, String(v)])),
  fee: { sats: String(good.built.fee.sats), fromNodes: String(good.built.fee.fromNodes), fromDevelopers: String(good.built.fee.fromDevelopers) },
  distribution: { toPlayers: String(distribution.toPlayers), toNodes: String(distribution.toNodes), toDevelopers: String(distribution.toDevelopers), toPool: String(distribution.toPool) },
  outputs: good.built.tx.outputs.map((o) => ({ pays: o.pays || 'commitment', value: String(o.value) })) });
out({ step: `${K} of ${g.arbitrationM}, slash_height = tip`, ...accepts(good.hex) });
out({ step: `${K - 1} of ${g.arbitrationM}`, builder: build(tip, K - 1).builderRefused, ...accepts(build(tip, K - 1).hex) });
out({ step: 'slash_height above the tip (nLockTime not reached)', ...accepts(build(tip + 2).hex) });
out({ step: 'an output moved after signing (1 sat from the escrow to the nodes)', ...accepts(build(tip, K, (b) => { b.tx.outputs[1].value -= 1n; b.tx.outputs[2].value += 1n; }).hex) });

// ---- mined, and read back: nLockTime and the commitment name the height the signers chose
const txid = cli('sendrawtransaction', good.hex);
const minedIn = JSON.parse(mine(1))[0];
const decoded = JSON.parse(cli('getrawtransaction', txid, 'true', minedIn));
const read = arbitrationCommitmentIn(decoded.vout.map((o) => ({ script: fromHex(o.scriptPubKey.hex) })));
out({ step: 'mined', txid, confirmations: decoded.confirmations, locktime: decoded.locktime, committedHeight: read && read.slashHeight,
  committedProof: read && toHex(read.proofId) === toHex(proofId), hint: read && new TextDecoder().decode(read.hint),
  bondSpent: JSON.parse(cli('gettxout', fundTxid, String(fundVout)) || 'null') === null });

// ---- the players' escrow: spent by the arbitration set, k of m, and by nobody with fewer
const escrowVout = decoded.vout.findIndex((o) => o.scriptPubKey.hex === toHex(escrow.script));
const escrowValue = good.built.amounts.players;
const spendEscrow = (signers) => {
  const tx = { version: 2, locktime: 0, inputs: [{ txid: fromHex(txid).reverse(), vout: escrowVout, sequence: 0xfffffffd }],
    outputs: [{ value: escrowValue - 2000n, script: walletSpk() }] };
  const h = tapSighash({ ...tx, prevouts: [{ value: escrowValue, script: escrow.script }], inputIndex: 0, leafHash: escrow.leaf });
  const sigs = signBy(signers)(h);
  const stack = sorted.map((k) => sigs.get(toHex(k)) || new Uint8Array(0)).reverse();
  return toHex(serializeSpend({ ...tx, witnesses: [scriptPathWitness({ stack, script: escrow.leafScript, controlBlock: escrow.controlBlock })] }));
};
out({ step: `players' escrow spent by ${K} of ${g.arbitrationM}`, escrowSats: String(escrowValue), ...accepts(spendEscrow(K)) });
out({ step: `players' escrow spent by ${K - 1} of ${g.arbitrationM}`, ...accepts(spendEscrow(K - 1)) });
