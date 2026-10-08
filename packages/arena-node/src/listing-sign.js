// THE LISTING'S ROW SIGNATURES, SIGNED OFF THE SEAT'S THREAD (kanban #197). A seat signs every announced round's row for
// one time every ~45 s (server.js, the background-signed full listing) - 2,281 BIP-340 signatures at ~3.2 ms each on the
// live testnet4 seats. Signed in 15 ms slices on the seat's own loop, one set took 12-17 s of wall time on a loaded
// test host, and sets aged past the 55 s a listing may be served. Here the messages (each row's lobbyListingId, made on the
// seat's thread) cross to a worker, which signs them and answers the signatures in the same order. The key crosses as
// bytes, once per set, and never leaves the process.
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { schnorr } from '@noble/curves/secp256k1.js';

/** Signs `messages` (32-byte Uint8Arrays) with `secret`, in a worker; answers the 64-byte signatures, same order. */
export function signInWorker(messages, secret) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { blwpListingSign: true, messages, secret } });
    let answered = false;
    worker.once('message', (m) => { answered = true; if (m.ok) resolve(m.sigs); else reject(new Error(m.why)); });
    worker.once('error', reject);
    worker.once('exit', (code) => { if (!answered) reject(new Error(`the listing signer exited with ${code} before answering`)); });
  });
}

if (!isMainThread && workerData && workerData.blwpListingSign) {
  try {
    const { messages, secret } = workerData;
    parentPort.postMessage({ ok: true, sigs: messages.map((m) => schnorr.sign(m, secret)) });
  } catch (e) {
    parentPort.postMessage({ ok: false, why: e.message });
  }
  parentPort.close();
}
