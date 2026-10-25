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

// A SMALL ASK IS NOT HELD BEHIND A LARGE ONE (2026-10-25, measured on testnet4 ~22:10Z): a full listing of 9,760 rows (10-25's grids
// and 10-26's) signed again each window was ~30 s in the worker, and the lobby's `?next=8` asks queued behind it - 22-30 s per
// lobby listing on four of seven seats while their loops sat idle. A large ask goes to the worker in chunks, one chunk at a time,
// and an ask of one chunk or less goes before the chunks still waiting.
export const SIGN_CHUNK = 128;

/**
 * A long-lived signer for `secret`: `sign(messages)` answers the 64-byte signatures of `messages` (32-byte Uint8Arrays),
 * same order; `close()` ends the worker. The worker does not hold the process up (unref), and a worker that dies is
 * started again on the next ask, the asks in flight refused by name.
 */
export function listingSigner(secret, { chunk = SIGN_CHUNK } = {}) {
  let worker = null;
  let nextId = 1;
  let busy = null;                                // the chunk in the worker: { id, ask, at }
  const small = [], large = [];                   // chunks waiting: { ask, at, messages }
  const failAll = (why) => {
    const asks = new Set([...(busy ? [busy.ask] : []), ...small.map((c) => c.ask), ...large.map((c) => c.ask)]);
    busy = null; small.length = 0; large.length = 0;
    for (const a of asks) a.reject(new Error(why));
  };
  const pump = () => {
    if (busy) return;
    const next = small.shift() || large.shift();
    if (!next) return;
    if (!worker) worker = start();
    busy = { id: nextId++, ask: next.ask, at: next.at };
    worker.postMessage({ id: busy.id, messages: next.messages });
  };
  const start = () => {
    const w = new Worker(new URL(import.meta.url), { workerData: { blwpListingSigner: true, secret } });
    w.on('message', (m) => {
      if (!busy || m.id !== busy.id) return;
      const { ask, at } = busy;
      busy = null;
      if (!m.ok) { ask.reject(new Error(m.why)); for (const q of [small, large]) for (let i = q.length - 1; i >= 0; i--) if (q[i].ask === ask) q.splice(i, 1); }
      else {
        m.sigs.forEach((sig, i) => { ask.sigs[at + i] = sig; });
        if (--ask.left === 0) ask.resolve(ask.sigs);
      }
      pump();
    });
    w.on('error', (e) => { if (worker === w) worker = null; failAll(`the listing signer failed: ${e.message}`); });
    w.on('exit', (code) => { if (worker === w) worker = null; failAll(`the listing signer exited with ${code} before answering`); });
    w.unref();
    return w;
  };
  return {
    sign(messages) {
      if (!messages.length) return Promise.resolve([]);
      return new Promise((resolve, reject) => {
        const parts = Math.ceil(messages.length / chunk);
        const ask = { sigs: new Array(messages.length), left: parts, resolve, reject };
        const q = parts === 1 ? small : large;
        for (let at = 0; at < messages.length; at += chunk) q.push({ ask, at, messages: messages.slice(at, at + chunk) });
        pump();
      });
    },
    close() { const w = worker; worker = null; failAll('the listing signer was closed'); if (w) return w.terminate(); return Promise.resolve(); },
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
