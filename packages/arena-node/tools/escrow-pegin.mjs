#!/usr/bin/env node
/**
 * THE PLAYERS' ESCROW INTO THE FEDERATION, ON A REGTEST CHAIN (kanban #307, §5A.3B): a players' escrow output of the
 * arbitration set (escrowOutput: its one k-of-m leaf) is funded from the stack's wallet - as a slash's path B pays it -,
 * then spent whole, less the fee, to the federation peg-in address PEGIN_ADDRESS, signed by k of the set's m members, each
 * on its own (memberSign), testmempoolaccept before sendrawtransaction. The arbiter's client then claims the peg-in.
 *
 *   BITCOIN_CLI="<bitcoin-cli> -datadir=<dir> -rpcwallet=<wallet>" PEGIN_ADDRESS=<addr> [ESCROW_SATS=150000] [FEE_SATS=1000]
 *   [NETWORK=regtest] node tools/escrow-pegin.mjs
 */
import { execFileSync } from 'node:child_process';
import { arbitrationMembers, buildEscrowPegin, memberSign, assemble } from '../src/arbiter.js';
import { escrowOutput } from '../../arena-protocol/src/arbitration-tx.js';
import { tweakPoint, combine } from '../src/curve.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
for (const k of ['BITCOIN_CLI', 'PEGIN_ADDRESS']) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const [cli, ...cliArgs] = env.BITCOIN_CLI.split(' ').filter(Boolean);
const bc = (...a) => execFileSync(cli, [...cliArgs, ...a.map(String)], { encoding: 'utf8' }).trim();
const bcj = (...a) => JSON.parse(bc(...a));
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const network = env.NETWORK || 'regtest';
let code = 0;
try {
  const set = arbitrationMembers(network);
  const escrow = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
  // THE ESCROW'S ADDRESS, as the node derives it: rawtr(output key) - the key already tweaked by the leaf
  const desc = bcj('getdescriptorinfo', `rawtr(${toHex(escrow.outputKey)})`).descriptor;
  const escrowAddress = bcj('deriveaddresses', desc)[0];
  const sats = BigInt(env.ESCROW_SATS || 150000);
  const fundTxid = bc('sendtoaddress', escrowAddress, (Number(sats) / 1e8).toFixed(8));
  const fundTx = bcj('getrawtransaction', fundTxid, 1);
  const vout = fundTx.vout.find((o) => o.scriptPubKey.hex === toHex(escrow.script)).n;
  bc('generatetoaddress', 1, bc('getnewaddress'));
  log({ step: 'escrow funded', escrowAddress, txid: fundTxid, vout, sats, k: set.k, m: set.keys.length });
  const toScript = fromHex(bcj('getaddressinfo', env.PEGIN_ADDRESS).scriptPubKey);
  const slash = buildEscrowPegin({ escrow: { txid: fromHex(fundTxid).reverse(), vout, value: sats, script: escrow.script }, set, toScript, feeSats: BigInt(env.FEE_SATS || 1000) });
  if (!slash.ok) throw new Error(slash.why);
  // k of the m, each signing on its own; the rest do not sign
  const signers = set.members.slice(0, set.k);
  const a = assemble({ slash, signatures: signers.map((m) => ({ key: m.key, sig: memberSign(m, slash.sighash) })), set });
  if (!a.ok) throw new Error(a.why);
  const t = bcj('testmempoolaccept', JSON.stringify([a.hex]))[0];
  if (!t.allowed) throw new Error(`testmempoolaccept refused it: ${t['reject-reason']}`);
  const spendTxid = bc('sendrawtransaction', a.hex);
  bc('generatetoaddress', 1, bc('getnewaddress'));
  log({ step: 'escrow into the federation', spendTxid, pegInAddress: env.PEGIN_ADDRESS, pegInSats: slash.built.amounts.pegIn, feeSats: slash.built.fee.sats,
    signers: a.signers, vsize: t.vsize, confirmations: bcj('getrawtransaction', spendTxid, 1).confirmations || 0 });
} catch (e) { code = 1; log({ step: 'stopped', why: String(e.stack || e.message).slice(0, 500) }); }
process.exit(code);
