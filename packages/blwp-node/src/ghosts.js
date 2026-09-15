// A PICTURE OF SOMEBODY ELSE'S TRUCK, BUILT FROM WHAT THEY PUBLISHED.
//
// 0.9 lets a player watch competitors "drive, struggle, fail and arrive", and
// 0.10 says what that must not become: another player's truck is a PICTURE,
// never an input to my simulation. The frame itself was already in
// `protocol/src/ghost.js` and nothing produced one - so the question this file
// answers is the one that decides whether ghosts are honest at all: where do
// the three numbers come from?
//
// They come from the run the other player published, replayed through
// `replay.js`, which is the daemon's only door to the simulator. Not from a
// position a node announces, not from a second stepping loop here, and not
// from a renderer: a node that made up coordinates would be painting a
// competitor somewhere they never were, which is the same fault a payout table
// had before `payoutInputsId`.
//
// NOTHING IN THIS FILE TOUCHES THE CORE. It asks `replay` for a picture and
// builds a frame around it, so the guard that counts the files reaching the
// simulator still counts one.
import { encodeGhost, ghostBinds } from '../../protocol/src/ghost.js';
import { interestSet, GHOST_SUBSCRIPTIONS } from '../../protocol/src/interest.js';
import { decodeRoundContract, decodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { toHex as hex } from '../../protocol/src/hash.js';
import { batchId, batchTicks } from '../../protocol/src/batch.js';
import { GENESIS, decodeTranscript } from '../../protocol/src/transcript.js';
import { replay, RunInProgress } from './replay.js';
import { coreForRound, installedCores } from './cores.js';

const same = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array
  && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * THE HEAD THAT COVERS A TICK, walked rather than assumed.
 *
 * `ghostBinds` accepts a head whose batch reaches the tick, so the honest
 * choice is the FIRST such head: the picture is taken from the inputs that
 * produced it and not from a later batch that happens to contain it too. A
 * chain that does not link is refused here rather than producing a frame
 * nobody could check.
 */
function headCovering(batches, tick) {
  let previous = GENESIS;
  let first = null;
  for (const b of batches) {
    if (!same(b.previousHash, previous))
      return { ok: false, why: 'that transcript\'s input chain is broken' };
    const at = batchTicks(b);
    if (first === null && at.length) first = at[0];
    previous = batchId(b);
    if (at.length && tick >= first && tick <= at[at.length - 1])
      return { ok: true, head: previous, firstTick: first, throughTick: at[at.length - 1] };
  }
  return {
    ok: false,
    why: first === null
      ? 'that entry has published no inputs, so there is nothing to be a picture of'
      : `tick ${tick} is not one the published inputs cover`,
  };
}

/**
 * ONE GHOST FRAME for one entry at one tick, or the reason there is none.
 *
 * `batches` are that entry's signed input batches in chain order - what the
 * node stored on the way in - and `transcript` is the same run as ticks and
 * words, which is what a replay eats. Both are the node's own tables; neither
 * is anything the asking side gets to choose.
 */
export function ghostFor({
  transcript, entry, batches, roundId, entryId, tick, seedWord, roundRandomness, core,
}) {
  if (!Number.isInteger(tick) || tick < 0)
    return { ok: false, why: 'a ghost is at a whole tick' };
  if (!entry || !(entry.playerPubkey instanceof Uint8Array))
    return { ok: false, why: 'no entry contract to say whose truck that is' };
  if (!Array.isArray(batches) || !batches.length)
    return { ok: false, why: 'that entry has published no inputs, so there is nothing to be a picture of' };

  // WHERE IN THEIR CHAIN, first. A tick nobody published inputs for cannot be
  // photographed, and finding that out before the replay is the difference
  // between a refusal and a minute of simulation ending in one.
  const chain = headCovering(batches, tick);
  if (!chain.ok) return chain;

  // GENESIS IS NOT A HEAD A PICTURE COMES FROM - it is the head before any
  // input went out. `ghostBinds` refuses one; this refuses to build one, so
  // the two ends agree instead of one of them cleaning up after the other.
  if (same(chain.head, GENESIS))
    return { ok: false, why: 'that head is before any input went out' };

  const run = replay(transcript, entry, { core, seedWord, roundRandomness, pictures: [tick] });
  if (!run.ok) return { ok: false, why: run.why };

  const shot = run.pictures.find((p) => p.tick === tick);
  if (!shot)
    return { ok: false, why: `that run never reached tick ${tick}, so there is no picture of it` };

  const ghost = {
    roundId, entryId,
    playerPubkey: entry.playerPubkey,
    tick,
    inputChainHash: chain.head,
    x: shot.x, z: shot.z, heading: shot.heading,
  };
  return { ok: true, ghost, bytes: encodeGhost(ghost), throughTick: chain.throughTick };
}

/**
 * THE SAME FRAME, CHECKED THE WAY A STRANGER WOULD CHECK IT.
 *
 * A producer that could not be checked by its own consumer is a producer
 * nobody should trust, so this runs `ghostBinds` over what it just built. It
 * is not belt and braces: it is the only thing that would notice this file and
 * `ghost.js` drifting apart on what a tick means.
 */
export function ghostForChecked(options) {
  const made = ghostFor(options);
  if (!made.ok) return made;
  const bound = ghostBinds(made.ghost, {
    roundId: options.roundId, entryId: options.entryId, batches: options.batches,
  }, options.entry);
  if (!bound.ok) return { ok: false, why: `that picture does not bind: ${bound.why}` };
  return { ...made, unchecked: bound.unchecked };
}

/**
 * THE PICTURES A ROUND CAN SHOW, AND WHO GETS WHICH.
 *
 * One instance per daemon. It holds two things and no simulator: a cache of
 * frames already produced, keyed by round, entry and tick, and the round
 * store to ask what has been published. Every picture in it came out of
 * `ghostFor`, which came out of `replay.js`.
 *
 * THE CACHE IS PER TICK because that is what a picture is. A tick already
 * photographed is served from here rather than replayed again - a replay is
 * minutes of simulation and a subscriber asking twice must not cost twice -
 * and a tick nobody asked for is never produced.
 *
 * THE RANDOMNESS IS NOT INVENTED HERE, for the reason `verify.js` gives at
 * length: the world seed mixes a future Bitcoin block hash, and a node that
 * made one up would be seeding a world its peers could not reproduce. No
 * source, no picture, and the refusal says which.
 */
export class Ghosts {
  constructor(round, { randomnessFor = () => undefined, limit = GHOST_SUBSCRIPTIONS, cores = installedCores() } = {}) {
    this.round = round;
    // THE CORES THIS SEAT INSTALLED (M3 R1): a round's picture is drawn by the core it names, or not at all.
    this.cores = cores;
    this.randomnessFor = randomnessFor;
    this.limit = limit;
    this.frames = new Map();
    this.made = 0;
    this.served = 0;
    // ONE WARM RUN PER ENTRY, so a live picture costs the ticks since the last
    // one instead of the whole run. Measured before this existed: a frame at
    // tick 3599 took 568.9 ms and a driver publishes every 100 ms, so the
    // picture fell behind for good about eighteen seconds in.
    this.runs = new Map();
    this.walked = 0;
    // HOW FAR EACH RUN'S INPUT CHAIN HAS BEEN CHECKED, so the check is done
    // once per batch instead of once per batch per frame.
    this.chains = new Map();
  }

  /**
   * THE CHAIN, CHECKED THE WAY A STRANGER WOULD CHECK IT, INCREMENTALLY.
   *
   * `ghostBinds` walks from GENESIS every time, which is the right shape for
   * somebody handed a transcript and no history - and the wrong one for a node
   * that has been watching this chain link by link. Every batch is still
   * checked against the one before it and the head is still the one whose
   * ticks cover the picture; what is dropped is re-checking links this node
   * already checked. Measured: 1500 batches per frame at the end of a round.
   */
  #chainThrough(roundIdBytes, entryIdBytes, tick) {
    const key = `${hex(roundIdBytes)}:${hex(entryIdBytes)}`;
    const held = this.chains.get(key)
      || { seq: -1, previous: GENESIS, head: GENESIS, firstTick: null, from: null, to: null };
    for (const { seq, batch } of this.round.batchesFrom(roundIdBytes, entryIdBytes, held.seq)) {
      if (!same(batch.previousHash, held.previous))
        return { ok: false, why: 'that transcript\'s input chain is broken' };
      const at = batchTicks(batch);
      if (held.firstTick === null && at.length) held.firstTick = at[0];
      held.previous = batchId(batch);
      held.head = held.previous;
      held.seq = seq;
      if (at.length) { held.from = held.firstTick; held.to = at[at.length - 1]; }
    }
    this.chains.set(key, held);
    if (same(held.head, GENESIS))
      return { ok: false, why: 'that head is before any input went out' };
    if (held.to === null)
      return { ok: false, why: 'that head carries no ticks to be a picture of' };
    if (tick < held.from || tick > held.to)
      return {
        ok: false,
        why: `that ghost is at tick ${tick}, and the inputs it names cover ${held.from} to ${held.to}`,
      };
    return { ok: true, head: held.head, throughTick: held.to };
  }

  /** The kept run for an entry, made on the first picture asked of it. */
  #runFor(roundIdBytes, entryIdBytes, entry) {
    const key = `${hex(roundIdBytes)}:${hex(entryIdBytes)}`;
    const had = this.runs.get(key);
    if (had) return had;
    const made = new RunInProgress(entry, {
      core: this.#coreOf(roundIdBytes),
      roundRandomness: this.#randomnessOf(roundIdBytes, entry, entryIdBytes),
    });
    this.runs.set(key, made);
    return made;
  }

  /** A run this node will not picture again - a round that closed, say. */
  forget(roundIdBytes, entryIdBytes) {
    return this.runs.delete(`${hex(roundIdBytes)}:${hex(entryIdBytes)}`);
  }

  /** The core the round names, as this seat's cores.js resolves it (M3 R1) - or none: nothing is pictured. */
  #coreOf(roundIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return null;
    const found = coreForRound(decodeRoundContract(new Uint8Array(row.contract)), this.cores);
    return found.ok ? found.core : null;
  }

  #randomnessOf(roundIdBytes, entry, entryId) {
    const row = this.round.get(roundIdBytes);
    if (!row) return null;
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const given = this.randomnessFor({ contract, roundIdBytes, entry, entryId });
    if (given instanceof Uint8Array) return given;
    return (given && given.hash) || null;
  }

  /** The last tick this node holds for an entry, or null if it holds none. */
  playedThrough(roundIdBytes, entryIdBytes) {
    const held = this.round.entry(entryIdBytes);
    if (!held) return null;
    // `nextTick` answers the JOIN TICK for an entry that has published
    // nothing, which is letter 19's rule and exactly the case where there is
    // no picture: a truck that has not been driven yet.
    const start = decodeEntryContract(held).joinTick;
    const next = this.round.nextTick(roundIdBytes, entryIdBytes);
    return next > start ? next - 1 : null;
  }

  /**
   * ONE FRAME, produced once. `{ ok, bytes }` or `{ ok: false, why }`, and the
   * refusal is cached too: a tick that cannot be photographed will not become
   * photographable by asking again, and re-replaying to learn that costs the
   * same minutes as a picture.
   */
  frameFor(roundIdBytes, entryIdBytes, tick) {
    const key = `${hex(roundIdBytes)}:${hex(entryIdBytes)}:${tick}`;
    const had = this.frames.get(key);
    if (had) { this.served++; return had; }

    const bytes = this.round.entry(entryIdBytes);
    if (!bytes) return { ok: false, why: 'no such entry on this node' };
    const held = decodeEntryContract(bytes);
    const roundRandomness = this.#randomnessOf(roundIdBytes, held, entryIdBytes);
    if (!roundRandomness)
      return { ok: false, why: 'that round has no randomness yet, so there is no world to picture' };

    // THE BATCHES THE NODE HOLDS, chain-checked on the way out - `handOver`
    // refuses to serve a broken chain, so a picture is never built on one.
    let batches = [];
    try { batches = decodeTranscript(this.round.handOver(roundIdBytes, entryIdBytes).bytes).batches; }
    catch (e) { return { ok: false, why: e.message }; }

    const made = ghostForChecked({
      core: this.#coreOf(roundIdBytes),
      transcript: this.round.transcript(roundIdBytes, entryIdBytes),
      entry: held,
      batches,
      roundId: new Uint8Array(roundIdBytes),
      entryId: new Uint8Array(entryIdBytes),
      tick,
      roundRandomness,
    });
    this.frames.set(key, made);
    if (made.ok) this.made++;
    return made;
  }

  /**
   * THE LATEST FRAME AN ENTRY CAN PROVE, off a run kept warm since the last one.
   *
   * This is the live path, and the only one a driving truck goes through.
   * `frameFor` still exists for an arbitrary older tick and still replays from
   * the start, which is right for a question nobody asks at 10 Hz.
   *
   * The picture is built and CHECKED exactly as `ghostForChecked` builds and
   * checks one - same head from the same batches, same `ghostBinds` - because
   * a producer its own consumer cannot check is a producer nobody should
   * trust, and that does not stop being true when it is fast.
   */
  latest(roundIdBytes, entryIdBytes) {
    const at = this.playedThrough(roundIdBytes, entryIdBytes);
    if (at === null)
      return { ok: false, why: 'that entry has published no inputs, so there is nothing to be a picture of' };

    const key = `${hex(roundIdBytes)}:${hex(entryIdBytes)}:${at}`;
    const had = this.frames.get(key);
    if (had) { this.served++; return had; }

    const stored = this.round.entry(entryIdBytes);
    if (!stored) return { ok: false, why: 'no such entry on this node' };
    const entry = decodeEntryContract(stored);

    // THE SAME REFUSAL THE SLOW PATH GIVES, in the same words. A node that
    // made up a world seed would be seeding a world its peers cannot
    // reproduce, and the door's own test speaks this sentence.
    if (!this.#randomnessOf(roundIdBytes, entry, entryIdBytes))
      return { ok: false, why: 'that round has no randomness yet, so there is no world to picture' };

    const run = this.#runFor(roundIdBytes, entryIdBytes, entry);
    if (!run.ok) return { ok: false, why: run.why };

    const before = run.stepped;
    const walked = run.stepTo(this.round.ticksFrom(roundIdBytes, entryIdBytes, run.at + 1), at);
    if (!walked.ok) return { ok: false, why: walked.why };
    this.walked += run.stepped - before;

    const chain = this.#chainThrough(roundIdBytes, entryIdBytes, at);
    if (!chain.ok) return chain;
    const head = chain.head;

    const ghost = {
      roundId: new Uint8Array(roundIdBytes), entryId: new Uint8Array(entryIdBytes),
      playerPubkey: entry.playerPubkey,
      tick: at, inputChainHash: chain.head,
      x: walked.x, z: walked.z, heading: walked.heading,
    };
    // AND THE KEY IS STILL THE ENTRY'S, which is the half of `ghostBinds`
    // that is not about the chain. The chain half was done above, once per
    // batch rather than once per frame.
    if (hex(entryId(entry)) !== hex(ghost.entryId))
      return { ok: false, why: 'that is a different entry than the ghost names' };
    if (hex(entry.playerPubkey) !== hex(ghost.playerPubkey))
      return { ok: false, why: 'that ghost names a key that entry was not signed for' };
    const made = { ok: true, ghost, bytes: encodeGhost(ghost), throughTick: chain.throughTick,
      unchecked: [] };

    // ONLY THE LIVE TICK IS KEPT. The old cache held one entry per tick of
    // every run forever - 600 of them in a minute, none ever served twice,
    // because a live watcher never asks for yesterday's tick.
    this.frames.set(key, made);
    if (this.frames.size > 1) {
      for (const k of this.frames.keys()) {
        if (k !== key && k.startsWith(`${hex(roundIdBytes)}:${hex(entryIdBytes)}:`)) this.frames.delete(k);
      }
    }
    if (made.ok) this.made++;
    return made;
  }

  /**
   * WHAT ONE VIEWER IS SHOWN: the interest set of piece 3, over positions that
   * came from replays rather than from anything anybody announced.
   *
   * The viewer is never in it - `interestSet` drops them by entry id, and a
   * player does not need a picture of the truck they are driving.
   */
  setFor(roundIdBytes, viewerEntryId) {
    const seen = [];
    for (const { entryId } of this.round.entriesOf(roundIdBytes)) {
      const made = this.latest(roundIdBytes, entryId);
      if (!made.ok) continue;
      seen.push({
        entryId: new Uint8Array(entryId),
        playerPubkey: made.ghost.playerPubkey,
        x: made.ghost.x, z: made.ghost.z,
        bytes: made.bytes, tick: made.ghost.tick,
      });
    }

    const me = seen.find((o) => hex(o.entryId) === hex(viewerEntryId));
    // A VIEWER WITH NO RUN OF THEIR OWN still has neighbours, and they are
    // measured from where the viewer is - which is nowhere yet. 5A says
    // nothing about it; the honest answer is the leaders' half only, so the
    // origin is not used as a position somebody could be near.
    const viewer = me || { entryId: new Uint8Array(viewerEntryId), x: 0, z: 0 };
    return interestSet(viewer, seen, { limit: this.limit })
      .map((o) => ({ entryId: o.entryId, tick: o.tick, bytes: o.bytes }));
  }
}
