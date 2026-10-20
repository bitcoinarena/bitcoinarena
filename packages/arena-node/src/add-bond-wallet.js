// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ADD TO BOND FROM A BOND WALLET (kanban #553, the owner 2026-10-20: "Add bond needs to be posted from within the interface"): a seat set up
// by hand has no installer home (no arena.conf, no installer wallet), so the owner page could only tell its owner to run a command. Such a
// seat names the Bitcoin Core wallet its bonds were paid from - ARENA_BOND_CLI, a bitcoin-cli command line with its -datadir and
// -rpcwallet - and the owner page adds to its bond as on an installed node: a SECOND bond output beside the first (protocol 19 counts both
// as one), its body the seat's own newest advertisement (tools/testnet4-add-bond.mjs, kanban #544), funded from that wallet.
//
//   ARENA_BOND_CLI="/path/bitcoin-cli -datadir=/path -rpcwallet=bonds"   (or the same with commas)
//
// Without `post` it builds both transactions and checks them with testmempoolaccept; with it, broadcasts them.
import { execFileSync } from 'node:child_process';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertInTransaction } from '../../arena-protocol/src/census.js';
import { recognizeBond } from '../../arena-protocol/src/chain.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../../arena-protocol/src/constants.js';
import { bondSetFor } from './curve.js';

const CARRIER_FEE = 3000n;
/** WHAT ADDING COSTS BESIDE THE AMOUNT (kanban #553: the page says "send N sat", worked out): the bond output's dust (330), the carrier's fee and
 *  what it keeps for the bond transaction (1,000), and about 500 sat for the funding transaction at 2 sat/vB. */
export const ADD_OVERHEAD_SATS = 330n + CARRIER_FEE + 1000n + 500n;
const MIN_ADD = 1000n;
/** The bond wallet's command line from the environment, or null: { cli(...args) -> stdout, wallet }. */
export function bondCliFrom(env = process.env) {
  // words apart by spaces or commas (a launcher that passes its settings as one space-split list writes them with commas)
  const words = String(env.ARENA_BOND_CLI || '').trim().split(/[\s,]+/).filter(Boolean);
  if (!words.length) return null;
  const [bin, ...base] = words;
  const w = base.find((x) => x.startsWith('-rpcwallet='));
  return { cli: (...a) => execFileSync(bin, [...base, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 }).trim(), wallet: w ? w.slice('-rpcwallet='.length) : null };
}

/**
 * THE PLAN, AND WITH `post` THE TWO TRANSACTIONS SENT. { ok, plan: { addSats, bondSats, totalSats, fees: { total }, maturity, lock: { estimatedMs },
 * countsAfter }, bond?: { txid } } or { ok: false, why }. `blockMs` the chain's block interval, for the time estimate only.
 */
export async function addBondFromWallet({ cli, wallet, network = 'testnet4', secret, pubkey, addSats, post = false, blockMs = 600000, now = Date.now() }) {
  let add; try { add = BigInt(String(addSats)); } catch { return { ok: false, why: 'name the sat to add as a whole number' }; }
  if (add < MIN_ADD) return { ok: false, why: `add at least ${MIN_ADD} sat` };
  const { regtest } = await import('../tools/regtest-bond.mjs');
  const rt = regtest(cli, { network, wallet: wallet || 'arena' });
  const bonds = rt.bondsOf(secret);
  if (!bonds.length) return { ok: false, why: 'this node has no confirmed bond to add to yet' };
  const bondSats = bonds.reduce((a, b) => a + BigInt(b.sats), 0n);
  const newest = bonds[0];
  const versions = [...new Set([...(newest.advert.protocolVersions || []), ...SUPPORTED_PROTOCOL_VERSIONS])].sort((a, b) => a - b);
  let fundingHex = null, fundingFee = 0n, made;
  try { made = rt.postBond(secret, { advert: { ...newest.advert, protocolVersions: versions }, bondSats: add, utxo: (spk) => {
    const address = JSON.parse(cli('decodescript', toHex(spk))).address;
    const value = add + 330n + CARRIER_FEE + 1000n;
    let funded;
    try { funded = JSON.parse(cli('-named', 'walletcreatefundedpsbt', 'inputs=[]', `outputs=${JSON.stringify([{ [address]: Number(value) / 1e8 }])}`,
      `options=${JSON.stringify({ include_unsafe: true, fee_rate: 2 })}`)); }
    catch (e) {
      if (!/Insufficient funds/i.test(String(e.stderr || e.message))) throw e;
      const have = walletOf(cli).spendableSats;
      throw Object.assign(new Error(`the bond wallet holds ${have} sat that can be spent, and adding ${add} sat needs about ${value + 500n} sat: top it up first`), { plain: true });
    }
    fundingFee = BigInt(Math.round(Number(funded.fee) * 1e8));
    const final = JSON.parse(cli('finalizepsbt', JSON.parse(cli('walletprocesspsbt', funded.psbt)).psbt));
    if (!final.complete) throw new Error('the bond wallet did not sign the funding transaction');
    fundingHex = final.hex;
    const d = JSON.parse(cli('decoderawtransaction', fundingHex));
    return { txid: d.txid, vout: d.vout.find((o) => o.scriptPubKey.hex === toHex(spk)).n, value };
  } }); } catch (e) { if (e.plain) return { ok: false, why: e.message }; throw e; }
  const tx = parseTransaction(fromHex(made.hex));
  const advert = advertInTransaction(tx);
  if (!advert || toHex(advert.nodePubkey) !== toHex(pubkey) || advert.operatorId !== newest.advert.operatorId)
    return { ok: false, why: 'the added bond does not read back as this node\'s advertisement; nothing was sent' };
  const seen = recognizeBond(tx, 0, advert, { network, bond: bondSetFor(network) });
  if (!seen.ok) return { ok: false, why: `the added bond would not be recognised (${seen.why}); nothing was sent` };
  const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify([fundingHex, made.hex])));
  if (!accept.every((a) => a.allowed)) return { ok: false, why: `the network would refuse it (${accept.map((a) => a['reject-reason']).filter(Boolean).join(', ')}); nothing was sent` };
  const tip = Number(cli('getblockcount'));
  // the added output's own fee is the carrier's, beside the 1,000 sat the carrier output keeps for the bond transaction
  const plan = { addSats: String(add), bondSats: String(bondSats), totalSats: String(bondSats + add), fees: { total: String(fundingFee + CARRIER_FEE) },
    maturity: made.maturity, lock: { estimatedMs: now + Math.max(0, made.maturity - tip) * blockMs }, countsAfter: 6 };
  if (!post) return { ok: true, plan };
  cli('sendrawtransaction', fundingHex);
  cli('sendrawtransaction', made.hex);
  return { ok: true, plan, bond: { txid: made.txid } };
}

/** THE BOND WALLET'S COINS: what it can spend now and what is still confirming, in sat. */
export function walletOf(cli) {
  const b = JSON.parse(cli('getbalances')).mine || {};
  const sat = (x) => BigInt(Math.round(Number(x || 0) * 1e8));
  return { spendableSats: sat(b.trusted), confirmingSats: sat(b.untrusted_pending) + sat(b.immature) };
}
/** A NEW ADDRESS of the bond wallet, to top it up (bech32m). */
export const walletAddress = (cli) => cli('getnewaddress', 'add-bond', 'bech32m');
