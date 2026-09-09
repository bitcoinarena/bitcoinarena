// A round's transcript: the object a node hands over and a verifier replays.
//
// §11 chains the batches and §13C says the canonical transcript is what every
// node replays, so it has to be ONE thing with ONE hash - not a table a
// verifier queries and hopes it asked for everything. This is that thing:
// the round, the entry, and the batches in chain order.
//
// AND THE CHECKPOINT CHAIN, which §13C names FIRST: the canonical transcript
// is "the longest checkpoint chain that carries receipts from at least 5
// committee nodes, TOGETHER WITH the input batches whose hashes it commits
// to". For a while this object carried the second half only, and the cost was
// measured rather than argued: three nodes carrying three different mark
// chains over one set of batches - two marks against three, and a third node
// whose player committed to a DIFFERENT world at the last tick - all produced
// one `transcriptHash`, and therefore one `resultId` for the committee to
// sign. The thing a result pins has to be the thing that is replayed, and
// what a replay is checked against is the state the player signed.
//
// THE MARKS ARE CARRIED SIGNED, and the hash covers the signature. That is
// the opposite of the rule one object down - a checkpoint's own id is taken
// before it is signed, so the chain does not shift underneath it - and the
// reason is that this is a container, not an identity. What must be pinned
// here is exactly the bytes a node hands over and a committee signs a result
// about; a signature outside the hash would let a node serve marks with
// nobody's signature on them and still match the hash the result named.
//
// WHOSE signature it is stays the caller's business, as everywhere in this
// package: there is no curve here, so `checkTranscript` checks the chain, the
// ticks and what the marks commit to, and the session key that verifies them
// lives in the entry contract.
//
// A transcript with NO marks is still a transcript - it is what a node hands
// a client back on resume, where the marks travel on their own endpoint and
// are checked there against receipts. It is not the canonical object, and the
// difference shows in the hash rather than being a matter of who is asking.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, TYPE_TRANSCRIPT, TAG } from './constants.js';
import { encodeInputBatch, decodeInputBatch, batchId, batchTicks } from './batch.js';
import { entryId, lastTickOfRun } from './contracts.js';
// The run length is the core's; this reads it rather than restating it.
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import {
  decodeCheckpoint, checkpointId, splitSigned, NO_PREVIOUS, SIGNED_CHECKPOINT_BYTES,
} from './checkpoint.js';

export const GENESIS = new Uint8Array(32);

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export function encodeTranscript(t) {
  const w = new Writer();
  w.u8(TYPE_TRANSCRIPT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(t.roundId);
  w.bytes32(t.entryId);
  w.vec(t.batches, (b, ww) => {
    const bytes = encodeInputBatch(b);
    ww.u16(bytes.length);
    ww.bytes(bytes, bytes.length);
  });

  // The marks, in chain order, each a whole signed record. No length prefix:
  // a signed checkpoint has no variable-length field, so the count is enough
  // and a reader cuts them at a fixed stride.
  w.vec(t.marks || [], (m, ww) => ww.bytes(m, SIGNED_CHECKPOINT_BYTES));
  return w.finish();
}

export function decodeTranscript(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_TRANSCRIPT) throw new Error('not a transcript');
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const t = { roundId: r.bytes32(), entryId: r.bytes32() };
  t.batches = r.vec((rr) => decodeInputBatch(rr.bytes(rr.u16())));
  t.marks = r.vec((rr) => rr.bytes(SIGNED_CHECKPOINT_BYTES));
  if (r.at !== bytes.length) throw new Error('trailing bytes after the transcript');
  return t;
}

export const transcriptHash = (t) => taggedHash(TAG.transcript, encodeTranscript(t));

/**
 * Checks both chains, the tick order, and what the marks commit to - and says
 * WHERE it broke rather than that it broke. A verifier that only learns
 * "invalid" has to bisect by hand.
 *
 * Returns `{ ok: true, ticks, marks, throughTick }` or
 * `{ ok: false, in, at, why }`, where `in` is 'batch' or 'mark' because the
 * two are numbered separately and an index alone would name two places.
 *
 * WHAT THE MARKS ARE CHECKED AGAINST IS THIS OBJECT AND NOTHING ELSE. Every
 * mark's `inputChainHash` has to be a head this transcript actually reaches -
 * §11's "a transcript whose inputs were never published cannot be replayed"
 * turned from a sentence into a refusal - and the heads may not go backwards,
 * because a later mark on an earlier input head is a rewind and not a chain.
 * The last mark's head must be the LAST batch: inputs past the last carried
 * mark are inputs no committee stood behind, and a transcript that carried
 * them would hand a replay ticks nobody receipted.
 *
 * `throughTick` is the tick of the last mark, or `null` when there are none.
 */
export function checkTranscript(t) {
  let previous = GENESIS;
  let expect = null;
  let ticks = 0;

  // Which input heads this transcript reaches, in order. GENESIS is index 0 -
  // a mark taken before any batch went out commits to it - so a head's index
  // is directly comparable and "did not go backwards" is one number test.
  const heads = new Map([[toHex(GENESIS), 0]]);

  for (let i = 0; i < t.batches.length; i++) {
    const b = t.batches[i];
    if (!same(b.roundId, t.roundId))
      return { ok: false, in: 'batch', at: i, why: 'batch is for another round' };
    if (!same(b.entryId, t.entryId))
      return { ok: false, in: 'batch', at: i, why: 'batch is for another entry' };
    if (!same(b.previousHash, previous))
      return { ok: false, in: 'batch', at: i, why: 'the chain is broken here' };
    const at = batchTicks(b);
    if (expect !== null && at[0] !== expect)
      return { ok: false, in: 'batch', at: i, why: `expected tick ${expect}, got ${at[0]}` };
    expect = at.length ? at[at.length - 1] + 1 : expect;
    ticks += at.length;
    previous = batchId(b);
    heads.set(toHex(previous), i + 1);
  }

  const marks = t.marks || [];
  let parent = NO_PREVIOUS;
  let lastTick = null;
  let lastHead = 0;
  let body = null;

  for (let i = 0; i < marks.length; i++) {
    if (marks[i].length !== SIGNED_CHECKPOINT_BYTES)
      return {
        ok: false,
        in: 'mark',
        at: i,
        why: `${marks[i].length} bytes is not a ${SIGNED_CHECKPOINT_BYTES}-byte signed mark`,
      };
    try { body = decodeCheckpoint(splitSigned(marks[i]).body); }
    catch (e) { return { ok: false, in: 'mark', at: i, why: e.message }; }

    if (!same(body.roundId, t.roundId))
      return { ok: false, in: 'mark', at: i, why: 'mark is for another round' };
    if (!same(body.entryId, t.entryId))
      return { ok: false, in: 'mark', at: i, why: 'mark is for another entry' };
    if (!same(body.previousHash, parent))
      return { ok: false, in: 'mark', at: i, why: 'the mark chain is broken here' };
    if (lastTick !== null && body.tick <= lastTick)
      return {
        ok: false,
        in: 'mark',
        at: i,
        why: `tick ${body.tick} does not come after ${lastTick}`,
      };

    const head = heads.get(toHex(body.inputChainHash));
    if (head === undefined)
      return {
        ok: false,
        in: 'mark',
        at: i,
        why: 'the mark commits to inputs this transcript does not carry',
      };
    if (head < lastHead)
      return { ok: false, in: 'mark', at: i, why: 'the mark commits to earlier inputs than the one before it' };

    parent = checkpointId(body);
    lastTick = body.tick;
    lastHead = head;
  }

  if (marks.length && lastHead !== t.batches.length)
    return {
      ok: false,
      in: 'mark',
      at: marks.length - 1,
      why: `the last mark commits through batch ${lastHead} and the transcript carries ${t.batches.length}`,
    };

  return { ok: true, ticks, marks: marks.length, throughTick: lastTick };
}

/**
 * The inputs a replay needs, flattened: one row of five words per tick in
 * tick order, and the liquidations and loads gathered from every batch.
 *
 * Not a convenience - it is the boundary. A verifier gets exactly what the
 * core's `step` and `submitLiquidation` take and nothing else, so there is no
 * second interpretation of a transcript anywhere.
 *
 * THE LIQUIDATION AND LOAD TICKS ARE REBASED to an index into `ticks`, and
 * that is the whole reason this function exists rather than a caller reading
 * the batches.
 * On the wire they are absolute, because absolute is what makes a repeat
 * harmless; a replay walks the array from zero. A transcript that begins at
 * tick 50 would otherwise put a strike at index 51 of a two-element array -
 * that is, nowhere - and the replay would be a different round with nothing
 * to say it had gone wrong. `firstTick` is returned beside them so a caller
 * can still say where the round began.
 */
export function flatten(t) {
  const ticks = [];
  const liquidations = [];
  const loads = [];
  for (const b of t.batches) {
    for (const row of b.ticks) ticks.push(row);
    for (const l of b.liquidations) liquidations.push(l);
    for (const l of (b.loads || [])) loads.push(l);
  }
  const firstTick = t.batches.length ? t.batches[0].firstTick : 0;
  liquidations.sort((a, c) => a[0] - c[0] || a[1] - c[1]);
  loads.sort((a, c) => a[0] - c[0] || a[1] - c[1] || a[2] - c[2]);
  return {
    firstTick,
    ticks,
    liquidations: liquidations.map(([at, size]) => [at - firstTick, size]),
    loads: loads.map(([at, fee, btc]) => [at - firstTick, fee, btc]),
  };
}

/**
 * DOES THIS TRANSCRIPT BELONG TO THAT ENTRY, AND DID IT BEGIN WHERE THE ENTRY
 * SAYS IT JOINED?
 *
 * 0.8: "Late join is a normal feature, not merely reconnect. Each accepted
 * entrant receives the same contract-defined mission duration `T_run`, even
 * when wall-clock start times differ." Section 7: "Late joins simply add more
 * Entry Contracts. The Round Contract is never rewritten."
 *
 * So a late entrant's world does not begin at tick 0 - it begins at the tick
 * their own Entry Contract names, and `joinTick` is the field that says which.
 * Measured before this existed: an entry that joined at tick 50 had its
 * transcript ACCEPTED beginning at 0, at 50 and at 500, all three, because
 * `checkTranscript` is handed a transcript and never the entry it is for. A
 * player could publish a run that started earlier than they joined, or one
 * that skipped the first four hundred ticks, and every check passed.
 *
 * The entry is signed and the tick is in it, so this is the same discipline as
 * everywhere else here: the thing being checked is bound to the thing that was
 * signed, and whoever brings the transcript does not also get to choose what
 * it is checked against.
 *
 * WHAT THIS CANNOT SAY is how LONG the run may be. 0.8's "same contract-defined
 * mission duration T_run" needs `player_run_duration`, which section 6 names
 * and this Round Contract does not carry - one of the eighteen absent names
 * audited during item 16, parked because adding one moves every round id. It
 * is reported as unchecked rather than assumed.
 */
export function transcriptBelongsToEntry(transcript, entry) {
  if (!transcript || !Array.isArray(transcript.batches))
    return { ok: false, why: 'that is not a transcript' };
  if (!entry || !Number.isInteger(entry.joinTick))
    return { ok: false, why: 'that entry names no join tick' };

  const same = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array
    && a.length === b.length && a.every((v, i) => v === b[i]);

  if (!same(entryId(entry), transcript.entryId))
    return { ok: false, why: 'that is a different entry than the transcript names' };
  if (!same(entry.roundId, transcript.roundId))
    return { ok: false, why: 'that entry is for another round' };

  if (!transcript.batches.length)
    return {
      ok: false,
      why: 'that transcript carries no inputs, so there is nothing that began anywhere',
    };

  const first = batchTicks(transcript.batches[0]);
  if (!first.length)
    return { ok: false, why: 'that transcript begins with a batch carrying no ticks' };

  if (first[0] !== entry.joinTick)
    return {
      ok: false,
      why: `that transcript begins at tick ${first[0]} and that entry joined at `
        + `${entry.joinTick}`,
    };

  // AND IT ENDS WHERE THE RUN ENDS.
  //
  // This used to report the run length as UNCHECKED, on the ground that
  // section 6's `player_run_duration` was a contract field nobody carried. It
  // is carried - by the core, as `BLOCK_TICKS`, which `genesis.js` writes into
  // the config hash a round's network commits to - so there was a number to
  // check against all along and no second one needed adding.
  //
  // The core measures a run in ELAPSED ticks while it is LIVE, which is what
  // gives a late joiner a whole run (0.8) rather than the stub left of the
  // round. Elapsed can never exceed the span of absolute ticks, so a
  // transcript reaching `joinTick + BLOCK_TICKS` carries inputs for a run that
  // is over however it ended - delivered, wrecked or missed.
  const last = batchTicks(transcript.batches[transcript.batches.length - 1]);
  const reaches = last.length ? last[last.length - 1] : first[0];
  const ends = lastTickOfRun(entry.joinTick);
  if (reaches > ends)
    return {
      ok: false,
      why: `that run ends at tick ${ends} - ${BLOCK_TICKS} ticks from its join at `
        + `${entry.joinTick} - and that transcript reaches ${reaches}`,
    };

  return { ok: true, joinTick: entry.joinTick, endsAt: ends, reaches };
}
