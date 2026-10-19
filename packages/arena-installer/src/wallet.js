// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S BITCOIN WALLET (2026-10-18: "Offers help with bond payment by giving an address on the newly
// created bitcoin wallet where the bond is first transferred to so the node can post the bond").
//
// One key from the node's 24 words (seed.js), as a taproot key-path address (BIP86: the key tweaked with no script tree), on testnet4
// (`tb1p...`). The user sends the bond there; the wallet finds the coins - by the node's Bitcoin Core (scantxoutset, no wallet in
// bitcoind needed) or its Electrum server (by script hash) - and the bond is built from them (bond.js) and broadcast the same way.
// The payout key the node names in its advertisement comes from the same words (a different tag), so a restored node is paid alike.
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint } from '../../arena-node/src/curve.js';
import { electrumSession } from './chain-test.js';
import { coreRpc } from './chain-test.js';
import { taprootAddress, addressScript } from '../../arena-protocol/src/address.js';

export const WALLET_KEY_TAG = 'arena/node-wallet/v1';
export const PAYOUT_KEY_TAG = 'arena/node-payout/v1';
export const HRP = 'tb';   // testnet4 (ruling 1)

// the address codec is shared with the seat (arena-protocol/src/address.js)
export { taprootAddress, addressScript };
/** The wallet key of the node's seed, its BIP86 output key, script and address. */
export function walletOf(seed) {
  const secret = taggedHash(WALLET_KEY_TAG, seed);
  const xonly = schnorr.getPublicKey(secret);
  const { outputKey, parity } = tweakPoint(xonly, taggedHash('TapTweak', xonly));
  const spk = Uint8Array.from([0x51, 0x20, ...outputKey]);
  return { secret, xonly, outputKey, parity, spk, address: taprootAddress(outputKey, HRP) };
}
/** The payout key the node's advertisement names (§5A.1 payout_pubkey), from the same words. */
export const payoutKeyOf = (seed) => schnorr.getPublicKey(taggedHash(PAYOUT_KEY_TAG, seed));

/** The Electrum script hash of an output script: sha256, reversed, hex. */
export const scriptHash = (spk) => Buffer.from(createHash('sha256').update(spk).digest()).reverse().toString('hex');

/**
 * The coins at the wallet's address: [{ txid, vout, sats, height (0 = unconfirmed) }] and the tip, from the chain the node uses
 * (state.chain: { kind: 'core', ... } or { kind: 'electrum', ... }).
 */
export async function coinsOf(chain, spk, { session = electrumSession, fetcher = fetch } = {}) {
  if (chain.kind === 'core') {
    const rpc = coreRpc({ ...chain, fetcher, timeoutMs: 120000 });
    const tip = await rpc('getblockcount');
    const r = await rpc('scantxoutset', ['start', [`raw(${toHex(spk)})`]]);
    const coins = (r.unspents || []).map((u) => ({ txid: u.txid, vout: u.vout, sats: Math.round(u.amount * 1e8), height: u.height }));
    // scantxoutset reads the UTXO set only: a deposit still in the mempool is found by the address's mempool entries
    return { tip, coins };
  }
  const s = await session({ ...chain, timeoutMs: 20000 });
  try {
    const tip = (await s.call('blockchain.headers.subscribe', [])).height;
    const list = await s.call('blockchain.scripthash.listunspent', [scriptHash(spk)]);
    return { tip, coins: list.map((u) => ({ txid: u.tx_hash, vout: u.tx_pos, sats: u.value, height: u.height > 0 ? u.height : 0 })) };
  } finally { s.close(); }
}

/** Broadcast a raw transaction through the node's chain: its txid. */
export async function broadcast(chain, hex, { session = electrumSession, fetcher = fetch } = {}) {
  if (chain.kind === 'core') return coreRpc({ ...chain, fetcher })('sendrawtransaction', [hex]);
  const s = await session({ ...chain, timeoutMs: 20000 });
  try { return await s.call('blockchain.transaction.broadcast', [hex]); } finally { s.close(); }
}

export { fromHex };
