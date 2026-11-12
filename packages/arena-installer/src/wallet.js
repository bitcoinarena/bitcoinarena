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

// A DEPOSIT COUNTS ONCE IT IS IN THE MEMPOOL (kanban #635, 2026-10-25: "sobald die Transaktion da ist weiter erlauben"): with
// Bitcoin Core the wallet read only the UTXO set, so the installer waited for the deposit's first block. bitcoind has no address
// index, so its mempool is read transaction by transaction - each one once per bitcoind (kept here; a later read asks only for the
// ones that are new) - and the outputs to this script are coins at height 0.
const mempoolSeen = new Map();   // bitcoind url -> Map(txid -> [{ vout, sats, spkHex }])
async function mempoolOutputs(rpc, key, spkHex, { batch = 16 } = {}) {
  const seen = mempoolSeen.get(key) || new Map(); mempoolSeen.set(key, seen);
  const now = (await rpc('getrawmempool')) || [];
  const live = new Set(now);
  for (const t of [...seen.keys()]) if (!live.has(t)) seen.delete(t);
  const fresh = now.filter((t) => !seen.has(t));
  for (let i = 0; i < fresh.length; i += batch) {
    await Promise.all(fresh.slice(i, i + batch).map(async (txid) => {
      let tx = null;
      try { tx = await rpc('getrawtransaction', [txid, true]); } catch { return; }   // left the mempool meanwhile: read again next time
      if (tx) seen.set(txid, (tx.vout || []).map((o) => ({ vout: o.n, sats: Math.round(o.value * 1e8), spkHex: o.scriptPubKey.hex })));
    }));
  }
  const out = [];
  for (const [txid, outs] of seen) for (const o of outs) if (o.spkHex === spkHex) out.push({ txid, vout: o.vout, sats: o.sats, height: 0 });
  return out;
}

/**
 * The coins at the wallet's address: [{ txid, vout, sats, height (0 = unconfirmed) }] and the tip, from the chain the node uses
 * (state.chain: { kind: 'core', ... } or { kind: 'electrum', ... }).
 */
// THE UTXO SET CHANGES ONLY WITH A BLOCK (the 2026.1.9.11 install test, kanban #728: the owner area's Bond panel asked its plan every 30 s and
// each answer took 14-18 s, a scantxoutset of the whole UTXO set each time): with `reuseScan` a scan made at this same tip is used again -
// the mempool and gettxout are still read, so a deposit arriving or a coin spent shows at once. Kept per bitcoind and script.
const scanKept = new Map();   // `${url} ${spkHex}` -> { tip, found }
export async function coinsOf(chain, spk, { session = electrumSession, fetcher = fetch, scanPauseMs = 2000, scanTries = 30, reuseScan = false } = {}) {
  if (chain.kind === 'core') {
    const rpc = coreRpc({ ...chain, fetcher, timeoutMs: 120000 });
    const tip = await rpc('getblockcount');
    const key = `${chain.url} ${toHex(spk)}`, kept = scanKept.get(key);
    if (reuseScan && kept && kept.tip === tip) return { tip, coins: await liveCoins(rpc, chain, spk, kept.found.map((c) => ({ ...c }))), reused: true };
    // ONE SCAN AT A TIME PER BITCOIN CORE (kanban #577, measured 2026-10-22 on the second machine: nodes sharing one Bitcoin Core - an
    // install's bond check and the custody agents' coin reads - met "Scan already in progress" at every check for 25 minutes, each
    // scan taking 5-10 s): a busy scan is waited for, every scanPauseMs, up to scanTries times, before it counts as a failure
    let r;
    for (let i = 0; ; i++) {
      try { r = await rpc('scantxoutset', ['start', [`raw(${toHex(spk)})`]]); break; }
      catch (e) { if (!/scan already in progress/i.test(String(e && e.message)) || i + 1 >= scanTries) throw e; await new Promise((ok) => setTimeout(ok, scanPauseMs)); }
    }
    const found = (r.unspents || []).map((u) => ({ txid: u.txid, vout: u.vout, sats: Math.round(u.amount * 1e8), height: u.height }));
    if (Number(r.height) === tip || r.height === undefined) scanKept.set(key, { tip, found: found.map((c) => ({ ...c })) });
    return { tip, coins: await liveCoins(rpc, chain, spk, found) };
  }
  const s = await session({ ...chain, timeoutMs: 20000 });
  try {
    const tip = (await s.call('blockchain.headers.subscribe', [])).height;
    const list = await s.call('blockchain.scripthash.listunspent', [scriptHash(spk)]);
    return { tip, coins: list.map((u) => ({ txid: u.tx_hash, vout: u.tx_pos, sats: u.value, height: u.height > 0 ? u.height : 0 })) };
  } finally { s.close(); }
}
/** The scan's coins with the mempool's outputs to `spk` added and the ones the mempool spends taken out. */
async function liveCoins(rpc, chain, spk, found) {
  // scantxoutset reads the UTXO set only: a deposit still in the mempool is found by reading the mempool (kanban #635)
  for (const c of await mempoolOutputs(rpc, chain.url, toHex(spk))) if (!found.some((f) => f.txid === c.txid && f.vout === c.vout)) found.push(c);
  // A COIN THE MEMPOOL ALREADY SPENDS IS NO COIN (kanban #577, measured 2026-10-22 on the three installers after founding
  // a997abf1: the custody agent's peg-in picked the coins its own unconfirmed guardian_of update had just spent, and bitcoind
  // refused it every minute - "insufficient fee, rejecting replacement"): gettxout with the mempool says null for it
  const coins = [];
  for (const c of found) { let out = null; try { out = await rpc('gettxout', [c.txid, c.vout, true]); } catch { out = {}; } if (out) coins.push(c); }
  return coins;
}

/** Broadcast a raw transaction through the node's chain: its txid. */
export async function broadcast(chain, hex, { session = electrumSession, fetcher = fetch } = {}) {
  if (chain.kind === 'core') return coreRpc({ ...chain, fetcher })('sendrawtransaction', [hex]);
  const s = await session({ ...chain, timeoutMs: 20000 });
  try { return await s.call('blockchain.transaction.broadcast', [hex]); } finally { s.close(); }
}

/**
 * IS A BOND OUTPUT STILL UNSPENT (kanban #2098): Bitcoin Core's gettxout with the mempool - an object when unspent, null when spent (or
 * never there); an Electrum chain answers undefined (unknown: it finds outputs by script, not by outpoint). Throws when Core does not answer.
 */
export async function txOut(chain, txid, vout, { fetcher = fetch } = {}) {
  if (!chain || chain.kind !== 'core') return undefined;
  return (await coreRpc({ ...chain, fetcher, timeoutMs: 30000 })('gettxout', [txid, Number(vout || 0), true])) || null;
}

/**
 * IS A TRANSACTION THERE (kanban #1165: an open on-chain action's bytes refused when sent again - a funding whose bond spent it in a block
 * is "missing inputs" - are believed only when the chain has them): in the mempool or a block. Bitcoin Core without a txindex finds a
 * mined one only in its block, so the blocks since `sinceTip` (at most `maxBlocks`) are read; Electrum finds any. Throws when the chain
 * does not answer (unknown is never "not there").
 */
export async function txSeen(chain, txid, { sinceTip = null, maxBlocks = 300, session = electrumSession, fetcher = fetch } = {}) {
  if (chain.kind === 'core') {
    const rpc = coreRpc({ ...chain, fetcher, timeoutMs: 60000 });
    try { if (await rpc('getrawtransaction', [txid, false])) return true; } catch (e) { if (!/no such mempool|no such transaction|not found/i.test(e.message)) throw e; }
    if (!Number.isInteger(sinceTip)) return false;
    const tip = await rpc('getblockcount');
    for (let h = tip; h >= Math.max(sinceTip, tip - maxBlocks); h--) {
      const b = await rpc('getblock', [await rpc('getblockhash', [h]), 1]);
      if ((b.tx || []).includes(txid)) return true;
    }
    return false;
  }
  const s = await session({ ...chain, timeoutMs: 20000 });
  try { await s.call('blockchain.transaction.get', [txid]); return true; }
  catch (e) { if (/no such|not found|unknown|missing/i.test(String(e && e.message))) return false; throw e; }
  finally { s.close(); }
}

export { fromHex };
