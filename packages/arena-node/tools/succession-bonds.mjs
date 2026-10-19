// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OLD FEDERATION'S GUARDIANS' BONDS, SPENT AT MATURITY (kanban #276 custody succession, §23A.6 step 4: "after CLOSED they
// may stop, and their bonds mature as any node's"). Driven by succession-regtest.sh once the old federation is empty: one bond
// per old guardian on the run's own regtest, each recovery spend (path A, the node's own key) refused one block before
// maturity, then accepted at maturity, broadcast, mined and seen spent by the census reader. Prints one JSON line.
//   RPC=30101 RPCUSER=blwp RPCPASS=blwp GUARDIANS=4 node tools/succession-bonds.mjs
import { execFileSync } from 'node:child_process';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { bondOutputKey, bondInternalKey, recoveryLeaf, tapLeafHash, controlBlockFor, maturityHeightFor } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { toHex, fromHex, taggedHash } from '../../arena-protocol/src/hash.js';
import { chainFactsAt } from '../../arena-protocol/src/census.js';

const B = process.env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const cli = (...a) => execFileSync(`${B}/bitcoin-cli`, [...(process.env.BTC_DATADIR ? [`-datadir=${process.env.BTC_DATADIR}`] : []), '-regtest', `-rpcport=${process.env.RPC || 30101}`, `-rpcuser=${process.env.RPCUSER || 'blwp'}`,
  `-rpcpassword=${process.env.RPCPASS || 'blwp'}`, ...a], { encoding: 'utf8' }).trim();
const w = (...a) => cli('-rpcwallet=bonds', ...a);
const big = (b) => BigInt('0x' + toHex(b));
const tweakPoint = (P, t) => {
  const Q = schnorr.utils.lift_x(big(P)).add(secp256k1.Point.BASE.multiply(big(t)));
  return { outputKey: schnorr.utils.pointToBytes(Q), parity: Number(Q.toAffine().y & 1n) };
};
const combine = (terms) => {
  let sum = null;
  for (const { key, coefficient } of terms) { const p = schnorr.utils.lift_x(big(key)).multiply(big(coefficient)); sum = sum === null ? p : sum.add(p); }
  return schnorr.utils.pointToBytes(sum);
};
try { cli('loadwallet', 'bonds'); } catch { try { cli('createwallet', 'bonds'); } catch { /* loaded */ } }
w('generatetoaddress', '101', w('getnewaddress'));
const g = genesisFor('regtest');
const payTo = fromHex(JSON.parse(w('getaddressinfo', w('getnewaddress'))).scriptPubKey);
const allowed = (hex) => { const r = JSON.parse(cli('testmempoolaccept', JSON.stringify([hex])))[0]; return { ok: r.allowed, why: r['reject-reason'] || null }; };

const out = [];
for (let i = 0; i < Number(process.env.GUARDIANS || 4); i++) {
  // each old guardian's seat key (test keys of this run, by index)
  const secret = taggedHash('ARENA/test/succession-guardian', new TextEncoder().encode(String(i)));
  const nodeKey = schnorr.getPublicKey(secret);
  // EACH BOND AT ITS OWN HEIGHT (kanban #295, template 2): the next block plus regtest's offset, mined to below
  const maturity = maturityHeightFor(Number(cli('getblockcount')), 'regtest', { slackBlocks: 0 });
  const built = bondOutputKey({ nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: maturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine });
  const spk = fromHex('5120' + toHex(built.outputKey));
  const address = JSON.parse(cli('decodescript', toHex(spk))).address;
  const txid = w('sendtoaddress', address, '0.5');
  w('generatetoaddress', '1', w('getnewaddress'));
  const decoded = JSON.parse(w('gettransaction', txid, 'true', 'true')).decoded;
  const utxo = { txid, vout: decoded.vout.find((o) => o.scriptPubKey.hex === toHex(spk)).n, value: 50000000n };
  const script = recoveryLeaf(nodeKey, maturity);
  const spend = (locktime) => {
    const tx = { version: 2, locktime, inputs: [{ txid: fromHex(utxo.txid).reverse(), vout: utxo.vout, sequence: 0xfffffffe }], outputs: [{ value: utxo.value - 2000n, script: payTo }] };
    const sighash = tapSighash({ ...tx, prevouts: [{ value: utxo.value, script: spk }], inputIndex: 0, leafHash: tapLeafHash(script) });
    return toHex(serializeSpend({ ...tx, witnesses: [scriptPathWitness({ stack: [schnorr.sign(sighash, secret)], script, controlBlock: controlBlockFor('recovery', built).controlBlock })] }));
  };
  const confirmed = Number(cli('getblockcount'));
  // one block before: the tip at H - 1, the spend's locktime H - 1 - refused by the leaf's CLTV
  const tipNow = Number(cli('getblockcount'));
  if (tipNow < maturity - 1) w('generatetoaddress', String(maturity - 1 - tipNow), w('getnewaddress'));
  const early = allowed(spend(maturity - 1));
  w('generatetoaddress', '1', w('getnewaddress'));
  const atMaturity = spend(maturity);
  const ok = allowed(atMaturity);
  const sent = cli('sendrawtransaction', atMaturity);
  w('generatetoaddress', '1', w('getnewaddress'));
  const tip = Number(cli('getblockcount'));
  const blocks = [];
  for (let h = tip - 3; h <= tip; h++) blocks.push({ height: h, transactions: JSON.parse(cli('getblock', cli('getblockhash', String(h)), '2')).tx.map((t) => fromHex(t.hex)) });
  const facts = chainFactsAt(blocks, tip);
  out.push({ guardian: i, bond: `${txid.slice(0, 16)}:${utxo.vout}`, sat: Number(utxo.value), confirmed, maturity, beforeMaturity: early, atMaturity: ok, spentBy: sent.slice(0, 16), height: tip,
    censusSeesSpent: facts.spentAt.has(`${toHex(fromHex(utxo.txid).reverse())}:${utxo.vout}`) });
}
console.log('BONDS ' + JSON.stringify({ offset: 100, bonds: out }));
