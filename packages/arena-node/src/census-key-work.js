// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HEAVY HALF OF A CENSUS KEY RUN, OFF THE SEAT'S THREAD (kanban #972). Measured at 1000 nodes and 1024 drawn shares, one node's keygen is 130-143 s, nearly all of it the
// batched check, and a deal is 4 s. On the seat's thread either would stop every round it serves, so all of it runs in a worker, one job at a time. A job is a function of
// what it is handed, so a restart simply runs it again. `censusKeyWork` is the job itself, and a test can call it without a worker.
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { CensusDkg } from './dkg.js';
import { feldmanGroup } from './curve.js';
import { encodeCensusComplaint } from '../../arena-protocol/src/census-dkg.js';
import { encodeCensusKeyRecord } from '../../arena-protocol/src/census-key.js';

const random = (n) => new Uint8Array(randomBytes(n));

/**
 * `job`: { kind, key, secret, run, part, deals, statements }. `deals` is the plain bytes of the deals to read, dropped ones left out by the caller. `part` is a reshare dealer's part of the key.
 *   deal     this node's one deal
 *   check    answers each bad deal's complaint and every dealer it refuses
 *   sign     this node's signature on the record of the deals handed in
 *   finish   this node's shares, once `statements` show the threshold on the record of those deals
 */
export async function censusKeyWork({ kind, key, secret, run, part = null, deals = [], statements = [] }) {
  const dkg = new CensusDkg({ key, secret, run, part, curve: feldmanGroup, random });
  if (kind === 'deal') return dkg.deal();
  const refused = [];
  for (const bytes of deals) {
    const took = await dkg.accept(bytes);
    if (!took.ok) refused.push({ dealer: took.from || null, why: took.why });
  }
  if (kind === 'check') {
    const seen = dkg.check();
    return { ok: true, complaints: seen.complaints.map(encodeCensusComplaint), bad: [...dkg.bad.keys()], refused, ...(run.reshare && !seen.ok && seen.why ? { why: seen.why } : {}) };
  }
  if (kind === 'sign') {
    if (run.reshare) { const whole = dkg.reshareHolds(); if (!whole.ok) return whole; }
    const said = dkg.statement();
    if (!said) return { ok: false, why: 'this node holds no deal to sign a record of' };
    return { ok: true, ...said, record: encodeCensusKeyRecord(dkg.record()), set: [...dkg.deals.keys()] };
  }
  if (kind === 'finish') {
    const done = dkg.finish(statements);
    if (!done.ok) return { ok: false, why: done.why, have: done.have };
    return { ok: true, publicKey: done.groupPublicKey.subarray(1), negated: done.negated, shares: done.shares, commitments: done.commitments,
      record: encodeCensusKeyRecord(done.record), recordId: done.recordId };
  }
  return { ok: false, why: `no such job: ${kind}` };
}

/** One job in one worker, which ends with it. */
export function censusKeyInWorker(job) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { arenaCensusKeyWork: true, job } });
    w.once('message', (m) => { resolve(m); w.terminate(); });
    w.once('error', reject);
  });
}

if (!isMainThread && workerData && workerData.arenaCensusKeyWork) {
  censusKeyWork(workerData.job).then((m) => parentPort.postMessage(m), (e) => parentPort.postMessage({ ok: false, why: e.message }));
}

