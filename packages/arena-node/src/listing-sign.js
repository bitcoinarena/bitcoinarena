// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LISTING'S ROW SIGNATURES, SIGNED OFF THE SEAT'S THREAD. A listed row is a BIP-340 signature of its
// lobbyListingId (~3.2 ms each on the live testnet4 seats); a listing that names many rows not yet signed in its window
// would hold the seat's loop for seconds. Here the messages (made on the seat's thread) cross to a worker, which signs
// them and answers the signatures in the same order.
//
// ONE WORKER FOR THE SEAT'S LIFE (2026-10-08): it was one new Worker per set of signatures - a thread
// spawned, this module and the curve loaded and warmed every ~45 s, on all seven seats. The key crosses as bytes once,
// when the worker starts, and never leaves the process.
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { schnorr } from '@noble/curves/secp256k1.js';

/**
 * A long-lived signer for `secret`: `sign(messages)` answers the 64-byte signatures of `messages` (32-byte Uint8Arrays),
 * same order; `close()` ends the worker. The worker does not hold the process up (unref), and a worker that dies is
 * started again on the next ask, the asks in flight refused by name.
 */
export function listingSigner(secret) {
  let worker = null;
  let nextId = 1;
  const waiting = new Map();                      // ask id -> { resolve, reject }
  const failAll = (why) => { for (const w of waiting.values()) w.reject(new Error(why)); waiting.clear(); };
  const start = () => {
    const w = new Worker(new URL(import.meta.url), { workerData: { blwpListingSigner: true, secret } });
    w.on('message', (m) => {
      const ask = waiting.get(m.id);
      if (!ask) return;
      waiting.delete(m.id);
      if (m.ok) ask.resolve(m.sigs); else ask.reject(new Error(m.why));
    });
    w.on('error', (e) => { if (worker === w) worker = null; failAll(`the listing signer failed: ${e.message}`); });
    w.on('exit', (code) => { if (worker === w) worker = null; failAll(`the listing signer exited with ${code} before answering`); });
    w.unref();
    return w;
  };
  return {
    sign(messages) {
      if (!messages.length) return Promise.resolve([]);
      if (!worker) worker = start();
      const id = nextId++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker.postMessage({ id, messages });
      });
    },
    close() { const w = worker; worker = null; if (w) return w.terminate(); return Promise.resolve(); },
  };
}

if (!isMainThread && workerData && workerData.blwpListingSigner) {
  const { secret } = workerData;
  parentPort.on('message', ({ id, messages }) => {
    try {
      parentPort.postMessage({ id, ok: true, sigs: messages.map((m) => schnorr.sign(m, secret)) });
    } catch (e) {
      parentPort.postMessage({ id, ok: false, why: e.message });
    }
  });
}
