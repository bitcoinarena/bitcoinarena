// THE NODE'S BITCOIN WALLET (kanban #471 step C.7; the owner 2026-10-18: "Offers help with bond payment by giving an address on the newly
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

export const WALLET_KEY_TAG = 'arena/node-wallet/v1';
export const PAYOUT_KEY_TAG = 'arena/node-payout/v1';
export const HRP = 'tb';   // testnet4 (ruling 1)

// ---- bech32m (BIP350), segwit v1 ----
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M = 0x2bc830a3;
const polymod = (values) => { let chk = 1; for (const v of values) { const top = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]; } return chk; };
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
const convert = (data, from, to, pad) => {
  let acc = 0, bits = 0; const out = []; const max = (1 << to) - 1;
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & max); } }
  if (pad) { if (bits) out.push((acc << (to - bits)) & max); } else if (bits >= from || ((acc << (to - bits)) & max)) return null;
  return out;
};
/** A segwit v1 (taproot) address of a 32-byte output key. */
export function taprootAddress(outputKey, hrp = HRP) {
  const data = [1, ...convert([...outputKey], 8, 5, true)];
  const chk = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M;
  return `${hrp}1${[...data, ...[0, 1, 2, 3, 4, 5].map((i) => (chk >> (5 * (5 - i))) & 31)].map((d) => CHARSET[d]).join('')}`;
}
/** A testnet4 segwit address (v0 bech32 or v1+ bech32m) to its output script; null when it is not one. */
export function addressScript(address, hrp = HRP) {
  const a = String(address || '').trim().toLowerCase();
  const sep = a.lastIndexOf('1');
  if (a.slice(0, sep) !== hrp || a.length < 14 || a.length > 90) return null;
  const data = [...a.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) return null;
  const chk = polymod([...hrpExpand(hrp), ...data]);
  const version = data[0];
  if (!((version === 0 && chk === 1) || (version > 0 && chk === BECH32M))) return null;
  const prog = convert(data.slice(1, -6), 5, 8, false);
  if (!prog || prog.length < 2 || prog.length > 40 || version > 16 || (version === 0 && prog.length !== 20 && prog.length !== 32)) return null;
  return Uint8Array.from([version ? 0x50 + version : 0, prog.length, ...prog]);
}

/** The wallet key of the node's seed, its BIP86 output key, script and address. */
export function walletOf(seed) {
  const secret = taggedHash(WALLET_KEY_TAG, seed);
  const xonly = schnorr.getPublicKey(secret);
  const { outputKey, parity } = tweakPoint(xonly, taggedHash('TapTweak', xonly));
  const spk = Uint8Array.from([0x51, 0x20, ...outputKey]);
  return { secret, xonly, outputKey, parity, spk, address: taprootAddress(outputKey) };
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
