// THE COMMITTEE'S RE-RUN OF A SUSPENDED RESULT (v4.6.2 §13A).
//
// "A valid objection suspends finality. The full committee re-runs the
// canonical transcript; the replay outcome is authoritative. Every node that
// signed the contradicted result is slashed (§5A.3). If the committee cannot
// reach 5-of-7 on the re-run, §13C applies."
//
// The spec names no wire object for a re-run signature, and a signer node keeps one
// PlayerResult per run - so a signer node that signed the contradicted result could
// never sign again. This is the object: the run it re-runs (the contradicted
// result's run id, which is what an objection is against) and the whole
// PlayerResult its replay produced, signed under the signer node's key. And the count:
// distinct ASSIGNED committee signer nodes that re-ran the same contradicted run and
// agree on one outcome, at the round's own threshold (5 of 7, 2 of 2) - the
// number results are counted at. What 13C does when they cannot is timed from
// the result window, which is not in the contract yet; nothing here decides it.
//
// The curve is not this package's business: `verify(signature, digest, key)` is
// injected, as `claim-key.js` and `posting.js` take it.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, TYPE_RERUN_RESULT, TAG } from './constants.js';
import { encodePlayerResult, decodePlayerResult, resultId, RESULT_BYTES } from './result.js';
import { receiptsNeeded } from './threshold.js';

/** 1 type + 2 version + 32 contradicted run + the 168-byte PlayerResult. */
export const RERUN_BYTES = 1 + 2 + 32 + RESULT_BYTES;
export const RERUN_SIGNATURE_BYTES = 64;
export const SIGNED_RERUN_BYTES = RERUN_BYTES + RERUN_SIGNATURE_BYTES;

/** A result's run: its id with no signer in it, so signer nodes that agree share one. */
export const runOf = (result) => resultId({ ...result, nodePubkey: new Uint8Array(32) });

const is32 = (b) => b instanceof Uint8Array && b.length === 32;

export function encodeRerunResult({ contradictedRunId, result }) {
  const w = new Writer();
  w.u8(TYPE_RERUN_RESULT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(contradictedRunId);
  w.bytes(encodePlayerResult(result), RESULT_BYTES);
  return w.finish();
}

export function decodeRerunResult(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_RERUN_RESULT) throw new Error('not a re-run result');
  const version = r.u16();
  if (version !== PROTOCOL_VERSION) throw new Error('protocol version ' + version);
  const contradictedRunId = r.bytes32();
  const result = decodePlayerResult(r.bytes(RESULT_BYTES));
  r.end();
  return { contradictedRunId, result };
}

/** What one signer node signs; the signer node is the embedded result's node_pubkey. */
export const rerunResultId = (x) => taggedHash(TAG.rerunResult, encodeRerunResult(x));

export function joinSignedRerun(body, signature) {
  if (body.length !== RERUN_BYTES) throw new Error(`a re-run result is ${RERUN_BYTES} bytes, got ${body.length}`);
  if (signature.length !== RERUN_SIGNATURE_BYTES)
    throw new Error(`a signature is ${RERUN_SIGNATURE_BYTES} bytes, got ${signature.length}`);
  const out = new Uint8Array(SIGNED_RERUN_BYTES);
  out.set(body, 0);
  out.set(signature, RERUN_BYTES);
  return out;
}

export function splitSignedRerun(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SIGNED_RERUN_BYTES)
    throw new Error(`a signed re-run result is ${SIGNED_RERUN_BYTES} bytes`);
  return { body: bytes.subarray(0, RERUN_BYTES), signature: bytes.subarray(RERUN_BYTES) };
}

/**
 * HAS THE COMMITTEE'S RE-RUN AGREED? Counted once per ASSIGNED signer node, about this
 * round, this player and this contradicted run, signed by the signer node the result
 * names; grouped by the run each re-run produced. `records` are `{ bytes }`.
 * `slots` is the committee's size (the round's game/verify slots).
 */
export function rerunIsAgreed({
  roundId, playerPubkey, contradictedRunId, records, signerNodes, slots, verify,
} = {}) {
  if (!is32(roundId) || !is32(playerPubkey) || !is32(contradictedRunId))
    return { ok: false, agreed: 0, why: 'a re-run is counted for one round, one player and one contradicted run' };
  if (typeof verify !== 'function') return { ok: false, agreed: 0, why: 'counting a re-run needs a verifier, and none was injected' };
  if (!Array.isArray(signerNodes) || !signerNodes.length) return { ok: false, agreed: 0, why: 'this round has no assigned committee to re-run it' };
  let needed;
  try { needed = receiptsNeeded(slots); } catch (e) { return { ok: false, agreed: 0, why: e.message }; }

  const joined = new Set(signerNodes.map(toHex));
  const counted = new Set();
  const byRun = new Map();
  for (const rec of records || []) {
    let x, signature;
    try {
      const split = splitSignedRerun(rec && rec.bytes);
      signature = split.signature;
      x = decodeRerunResult(split.body);
    } catch { continue; }
    const who = toHex(x.result.nodePubkey);
    if (!joined.has(who) || counted.has(who)) continue;
    if (toHex(x.result.roundId) !== toHex(roundId) || toHex(x.result.playerPubkey) !== toHex(playerPubkey)) continue;
    if (toHex(x.contradictedRunId) !== toHex(contradictedRunId)) continue;
    let good = false;
    try { good = !!verify(signature, rerunResultId(x), x.result.nodePubkey); } catch { good = false; }
    if (!good) continue;
    counted.add(who);
    const run = toHex(runOf(x.result));
    const at = byRun.get(run) || { count: 0, result: x.result };
    at.count++;
    byRun.set(run, at);
  }
  let best = null;
  for (const [run, at] of byRun) if (!best || at.count > best.count) best = { run, ...at };
  if (!best || best.count < needed)
    return {
      ok: false, agreed: best ? best.count : 0, needed,
      why: `${best ? best.count : 0} of ${needed} committee signer nodes have re-run the contradicted result to one outcome`,
    };
  return { ok: true, agreed: best.count, needed, runId: runOf(best.result), result: best.result };
}
