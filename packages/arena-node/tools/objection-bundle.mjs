// AN OBJECTION BUNDLE, BUILT FROM WHAT ANY SIGNER NODE HANDS OUT (§13A, kanban #24): the canonical transcript
// (GET /canonical - the batches and the signed marks, the object a result's transcript_hash names), the signed receipts
// (GET /receipts), and the Objection itself, signed by the objector's own key. Anyone can build one; a seat takes it
// only if its check holds (objection-check.js).
//
//   import { buildObjectionBundle } from './objection-bundle.mjs';
//   node tools/objection-bundle.mjs <seat url> <round hex> <entry hex> <signed run hex> <player hex> <outcome> <score> <out file>
//     (a fresh objector key each run; prints the objector key and the transcript hash)
import { schnorr } from '@noble/curves/secp256k1.js';
import { writeFileSync } from 'node:fs';
import { encodeObjection, objectionId, encodeObjectionBundle } from '../../arena-protocol/src/objection.js';
import { decodeTranscript, transcriptHash } from '../../arena-protocol/src/transcript.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const [base, round, entry, signed, player, outcome, score, out] = process.argv.slice(2);
  if (!out) { console.error('usage: objection-bundle.mjs <seat url> <round> <entry> <signed run> <player> <outcome> <score> <out file>'); process.exit(2); }
  const b = await buildObjectionBundle({ base, roundId: round, entryId: entry, signedRunId: signed, playerPubkey: player,
    claimed: { outcome, score: Number(score) } });
  writeFileSync(out, b.bundle);
  console.log(JSON.stringify({ bytes: b.bundle.length, objector: hex(b.objectorPubkey), transcriptHash: hex(b.transcriptHash),
    transcriptBytes: b.transcript.length, receipts: b.receipts.length / SIGNED_RECEIPT_BYTES, inputsBytes: b.inputs ? b.inputs.length : 0 }));
}
