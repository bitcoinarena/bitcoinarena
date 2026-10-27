// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN OBJECTION BUNDLE, BUILT FROM WHAT ANY SIGNER NODE HANDS OUT (§13A): the canonical transcript
// (GET /canonical - the batches and the signed marks, the object a result's transcript_hash names), the signed receipts
// (GET /receipts), and the Objection itself, signed by the objector's own key. Anyone can build one; a seat takes it
// only if its check holds (objection-check.js).
//
//   import { buildObjectionBundle } from './objection-bundle.js';
// tools/objection-bundle.mjs is its command line; an auditor builds its objections with it too (round-auditor.js, §13A.1, kanban #725).
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeObjection, objectionId, encodeObjectionBundle } from '../../arena-protocol/src/objection.js';
import { decodeTranscript, transcriptHash } from '../../arena-protocol/src/transcript.js';

const bytesOf = (h) => (h instanceof Uint8Array ? h : new Uint8Array(Buffer.from(String(h), 'hex')));
const hex = (b) => Buffer.from(b).toString('hex');

/**
 * `base` a signer node's URL; `roundId`, `entryId`, `signedRunId` (the run objected to), `playerPubkey` (bytes or
 * hex); `claimed` { outcome, score }; `objectorSecret` 32 bytes (a fresh one when omitted). `transcript` and `receipts`
 * bytes may be handed in instead of fetched (a test that edits one). Returns { bundle, objection, objectorPubkey, transcriptHash }.
 */
export async function buildObjectionBundle({ base, roundId, entryId, signedRunId, playerPubkey, claimed,
  objectorSecret = schnorr.utils.randomSecretKey(), transcript = null, receipts = null, inputs = null, atMs = BigInt(Date.now()), fetcher = fetch }) {
  const q = `round=${hex(bytesOf(roundId))}&entry=${hex(bytesOf(entryId))}`;
  if (!transcript) {
    const r = await fetcher(`${base}/canonical?${q}`);
    if (r.status !== 200) throw new Error(`GET /canonical ${r.status}: ${await r.text()}`);
    transcript = new Uint8Array(await r.arrayBuffer());
  }
  if (!receipts) {
    const r = await fetcher(`${base}/receipts?${q}`);
    if (r.status !== 200) throw new Error(`GET /receipts ${r.status}: ${await r.text()}`);
    receipts = new Uint8Array(await r.arrayBuffer());
  }
  let th, decoded = null;
  try { decoded = decodeTranscript(transcript); th = transcriptHash(decoded); } catch { th = new Uint8Array(32); }
  // A LIVE RUN'S INPUTS (play frames, not batches): its canonical transcript carries none, so they go beside it as the
  // bundle's fifth part, as GET /replay/transcript hands them out
  if (inputs === null && decoded && !decoded.batches.length) {
    const r = await fetcher(`${base}/replay/transcript?${q}`);
    if (r.status !== 200) throw new Error(`GET /replay/transcript ${r.status}: ${await r.text()}`);
    const j = await r.json();
    delete j.clock;                                                   // when the node saw it, not part of the run
    inputs = new TextEncoder().encode(JSON.stringify(j));
  }
  const objectorPubkey = schnorr.getPublicKey(objectorSecret);
  const objection = {
    roundId: bytesOf(roundId), playerPubkey: bytesOf(playerPubkey), transcriptHash: th, signedResultId: bytesOf(signedRunId),
    claimedOutcome: claimed.outcome, claimedScore: claimed.score, objectorPubkey, atMs,
  };
  const signature = schnorr.sign(objectionId(objection), objectorSecret);
  return { bundle: encodeObjectionBundle({ objection: encodeObjection(objection), signature, transcript, receipts, inputs }),
    objection, objectorPubkey, transcriptHash: th, transcript, receipts, inputs };
}
