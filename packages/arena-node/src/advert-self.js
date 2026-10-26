// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S OWN guardian_of UPDATE, CHECKED OFF THE SEAT'S THREAD (kanban #705, measured on testnet4 2026-10-26 ~12:20Z): the check
// reads the bond wallet with bitcoin-cli, synchronously - its bonds, the newest update of the first (a scantxoutset over the whole
// UTXO set and a getrawtransaction per marker) - and on the seat's thread that held the loop 2-3 minutes every 10 min. Seat 6's
// accept queue filled (Recv-Q 512) and a CPU profile of it was 94.9 % spawn from this check. Here the whole check runs in a worker,
// one per check; the seat's thread only waits for its answer.
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { toHex } from '../../arena-protocol/src/hash.js';

/**
 * One check: `mine` = [{ federationId, guardianKey }] (bytes) of the guardians this seat runs. Answers null when there is nothing
 * to do (no wallet, no bond, an update still in the mempool), else guardianOfFromWallet's answer.
 */
export async function advertSelfOnce({ mine, secret, last, network = 'testnet4', dry = false }) {
  const { bondCliFrom, guardianOfFromWallet } = await import('./add-bond-wallet.js');
  const b = bondCliFrom(); if (!b) return null;
  if (last && last.txid) { try { b.cli('getmempoolentry', last.txid); return null; } catch { /* confirmed or gone: look again */ } }
  // what the advertisement names, with this seat's own guardians added (or their keys made current) - never fewer
  const { regtest } = await import('../tools/regtest-bond.mjs');
  const rt = regtest(b.cli, { network, wallet: b.wallet || 'arena' });
  const bonds = rt.bondsOf(secret);
  if (!bonds.length) return null;
  const now = (rt.newestUpdateOf(bonds[0]) || {}).advert || bonds[0].advert;
  const want = new Map(((now && now.guardianOf) || []).map((g) => [toHex(g.federationId), g]));
  for (const e of mine) want.set(toHex(e.federationId), e);
  return guardianOfFromWallet({ cli: b.cli, wallet: b.wallet, network, secret, guardianOf: [...want.values()], post: !dry });
}

/** advertSelfOnce in a worker thread: the seat's loop stays free while bitcoin-cli runs. */
export function advertSelfInWorker(ask) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { blwpAdvertSelf: true, ask } });
    w.unref();
    let done = false;
    w.once('message', (m) => { done = true; if (m.ok) resolve(m.r); else reject(new Error(m.why)); });
    w.once('error', (e) => { if (!done) { done = true; reject(e); } });
    w.once('exit', (code) => { if (!done) { done = true; reject(new Error(`the advert worker stopped (${code})`)); } });
  });
}

if (!isMainThread && workerData && workerData.blwpAdvertSelf) {
  advertSelfOnce(workerData.ask).then(
    (r) => parentPort.postMessage({ ok: true, r }),
    (e) => parentPort.postMessage({ ok: false, why: e.message }));
}
