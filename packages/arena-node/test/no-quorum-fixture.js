// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NO-QUORUM ENTRY ON ONE DAEMON OF A SEVEN-SEAT ROUND OF PROTOCOL 22 (§13A, §13C, kanban #1038, #1060), shared by no-quorum-rerun.test.js and no-quorum-run.test.js.
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sevenSignerNodes, WINDOW_MS, wait } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { resultFinality, NO_RUN } from '../src/finality.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { splitSignedResult, decodePlayerResult, encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { AUDITOR_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeRerunResult, rerunResultId, joinSignedRerun, decodeRerunResult, splitSignedRerun } from '../../arena-protocol/src/rerun.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';

export const seven = (o = {}) => sevenSignerNodes(WINDOW_MS, undefined, { endMs: testNow() + 4000, storedBeforeTheRule: true, round: { protocolVersion: AUDITOR_VERSION }, finality: { everyMs: 100, rerunMs: 60000 }, ...o });
export const win = (w) => Object.fromEntries(Object.entries(windowsOf(w.contract)).map(([k, v]) => [k, Number(v)]));
export const stateOf = (w, eid) => resultFinality(w.holder.round, w.rid, eid);
export const until = async (ok, ms = 15000) => { for (const stop = Date.now() + ms; Date.now() < stop; await wait(50)) if (ok()) return true; return ok(); };

/** The fixture's five sign, whatever the holder's own replay came to: the loser's tape can deliver under a round's random beacon. */
export const signRun = (w, name, rewrite, o = {}) => {
  const mine = w.holder.round.results(w.rid, w.runs[name].eid).find((r) => toHex(r.nodePubkey) === toHex(w.holder.round.pubkey));
  w.sign(name, rewrite, { ...o, expect: decodePlayerResult(splitSignedResult(mine.bytes).body).outcome });
};
/** `count` of the six keys sign the holder's own run, held here inside the window: with the holder's, count + 1 matching results. */
export function results(w, name, count) {
  const eid = w.runs[name].eid;
  const mine = w.holder.round.results(w.rid, eid).find((r) => toHex(r.nodePubkey) === toHex(w.holder.round.pubkey));
  const shape = decodePlayerResult(splitSignedResult(mine.bytes).body);
  for (const secret of w.others.slice(0, count)) {
    const r = { ...shape, nodePubkey: schnorr.getPublicKey(secret) };
    const id = resultId(r);
    w.holder.round.putResult(w.rid, eid, r.nodePubkey, id, joinSignedResult(encodePlayerResult(r), schnorr.sign(id, secret)));
  }
  return eid;
}
/** The entry with no quorum and the other entry signed and published in time, the clock past final_after. */
export async function noQuorumAt(w, signers = 3) {
  signRun(w, 'agrees', () => ({}));
  const eid = results(w, 'dissents', signers);
  skipTo(win(w).finalAfterMs + 50);
  await w.finalBy('agrees', 5);
  return eid;
}
export const rerunsIn = (w, count = 4, o = {}) => w.rerunBy('dissents', count, { contradicted: NO_RUN, ...o });
export const tableOf = (w) => w.holder.settlements.entriesOnRecord(w.rid, w.contract);
/** FINAL on the agreed re-run: past its own window, the holder's FINAL and four of the six. */
export async function finalOnRerun(w, eid) {
  skipTo(win(w).ownFinalAfterMs + 50);
  const q = `round=${toHex(w.rid)}&entry=${toHex(eid)}`;
  const own = await fetch(`http://127.0.0.1:${w.holder.port}/final-sig?${q}`);
  assert.equal(own.status, 200, await own.clone().text());
  await fetch(`http://127.0.0.1:${w.holder.port}/final-sig?${q}`, { method: 'POST', body: new Uint8Array(await own.arrayBuffer()) });
  await w.finalBy('dissents', 4);
  return stateOf(w, eid);
}

/** 3 seats out before any receipt was pulled, as this seat holds it: its own receipts of the run and no result. The other seats' receipts are handed back: put them in to bring a seat back. */
export function withoutResults(w, name) {
  const { db, pubkey } = w.holder.round;
  const eid = w.runs[name].eid;
  const { bytes } = w.holder.round.receipts(w.rid, eid);
  const others = [];
  for (let at = 0; at + SIGNED_RECEIPT_BYTES <= bytes.length; at += SIGNED_RECEIPT_BYTES) others.push(bytes.slice(at, at + SIGNED_RECEIPT_BYTES));
  db.prepare('DELETE FROM results WHERE entry_id = ?').run(eid);
  db.prepare('DELETE FROM receipts WHERE node_pubkey != ? AND checkpoint_id IN (SELECT checkpoint_id FROM checkpoints WHERE entry_id = ?)').run(pubkey, eid);
  return { eid, back: () => { for (const r of others) { try { w.holder.round.takeReceipt(r); } catch { /* its own, held */ } } } };
}
/** No mark of the entry here at all. */
export function withoutMarks(w, name) {
  const { db } = w.holder.round;
  const eid = w.runs[name].eid;
  db.prepare('DELETE FROM results WHERE entry_id = ?').run(eid);
  db.prepare('DELETE FROM receipts WHERE checkpoint_id IN (SELECT checkpoint_id FROM checkpoints WHERE entry_id = ?)').run(eid);
  db.prepare('DELETE FROM checkpoints WHERE entry_id = ?').run(eid);
  return eid;
}
/** `count` of the six sign the holder's own re-run, signed at `signedAtMs`. */
export function rerunsLike(w, eid, count, signedAtMs, keys = w.others) {
  const mine = w.holder.round.reruns(w.rid, eid).find((r) => toHex(r.signerNodePubkey) === toHex(w.holder.round.pubkey));
  const own = decodeRerunResult(splitSignedRerun(mine.bytes).body);
  for (const secret of keys.slice(0, count)) {
    const x = { contradictedRunId: NO_RUN, signedAtMs: BigInt(signedAtMs), result: { ...own.result, nodePubkey: schnorr.getPublicKey(secret) } };
    w.holder.round.putRerun(w.rid, eid, x.result.nodePubkey, joinSignedRerun(encodeRerunResult(x), schnorr.sign(rerunResultId(x), secret)));
  }
}
