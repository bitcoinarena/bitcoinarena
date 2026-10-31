// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DAEMON REPLAYS A RUN. IT DOES NOT RUN ONE BESIDE THE PLAYER.
//
// `arena-client/src/client.js` opens by saying why this file did not exist:
// "the node is a store... `arena-node/src` imports no core ON PURPOSE, because
// a daemon that recomputed the state would be a second simulator and then two
// of them could disagree." That argument is against a node stepping a round
// LIVE, in parallel with the player - two engines running at once, each with
// its own idea of the present, and no way to say which is the game.
//
// This is the other thing, and section 13 requires it: seven nodes replay a
// player's FINISHED run and five must agree. That is one simulator run twice
// over the same inputs, which is the only claim determinism ever made. A node
// that cannot do it has to take the player's word for the state hash it signs
// a receipt over, and "five of seven agree" degrades to "five of seven were
// told the same thing".
//
// So a core is stepped HERE and nowhere else in the daemon - since M3 R1 the core the round names,
// which plugins.js hands in, as the game's registration installed it. One door, and it opens on a transcript
// that is already stored and already finished.
//
// THE SHAPE IS `core/tools/replay.js`, whose own header said this was coming:
// "this is the shape the node's replay pool needs - the difference there is
// that it runs in a worker and the transcript comes off the wire rather than
// off disk." Same loop, same order, no second reading of the rules.
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
// AND SINCE M3 R1 (2026-09-15 08:03/08:07) IT IS HANDED THE CORE: the round names one, the
// signer node's plugins.js resolves it, and this file drives that core's adapter - it imports none. The
// loop is the same; what a tick's events are, what a run came to and what a picture is are the
// core's to say.
import { lastTickOfRun, runTicksForEntry } from '../../arena-protocol/src/contracts.js';
import { INPUT_WORDS } from '../../arena-protocol/src/batch.js';
import { seedWordForEntry, worldSeedWord, worldSlot } from '../../arena-protocol/src/seed.js';
// AND SINCE KANBAN (spec §0A.6) THE CORE RUNS ONLY IN ITS SANDBOX: no network, no file system, no clock. The loop
// below is core-driver.js, inside it; this file checks what it hands in and reads back what the core said.
import { sandboxFor } from './core-sandbox.js';

const hex = (b) => {
  if (typeof b === 'string') return b.toLowerCase();
  let s = '';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
};

/**
 * WHY A SEED IS DERIVED FROM THE ENTRY.
 *
 * IMPLEMENTATION.md names the player sub-seed as
 * `H(round_randomness || pubkey || secret || join_tick)`. Three of those four
 * are on signed objects a node already holds. `secret` is the PLAYER's, and
 * section 0.10's private world says nothing about when or whether it reaches a
 * verifier: there is no reveal message, no entry field, and no clause naming
 * one. Writing that hash here would settle a protocol question by implementing
 * it, which is the BOND_MARKER and checkpoint class of decision.
 *
 * 2026-09-08: the secret is on the Entry Contract. A node derives the
 * seed; a fixture may still hand in seedWord. Missing secret or randomness is
 * a refusal, not a guess.
 */
export const NO_SEED_RULE = 'that entry carries no world secret to replay from';
/** A replay with no core named to run it under is refused, not run under whichever core is nearest. */
export const NO_CORE_RULE = 'no core is named to replay that run under';

/**
 * THE WORLD THIS RUN IS REPLAYED IN (2026-10-04): the one function the page uses too. A core resolved for a
 * round carries `world` - its config hash, census root and id - and the round's config chooses the rule: one world for
 * the whole round (config v4) or the player's own (every older config, byte for byte as before). A core with no `world`
 * is a caller that names no round: the per-player seed, as it always was.
 */
function seedWordOf(entry, roundRandomness, core) {
  if (core && core.world && core.world.configHash instanceof Uint8Array)
    return worldSeedWord({ entry, roundRandomness, contract: core.world, roundId: core.world.roundId, sharedWorld: core.world.sharedWorld });
  return seedWordForEntry(entry, roundRandomness);
}

/** THE PLACE THIS RUN STARTS AT (kanban #828, seed.js worldSlot): a shared-world round's, the same number the page's join computes. */
function slotOf(entry, core) {
  return core && core.world && core.world.configHash instanceof Uint8Array
    ? worldSlot({ entry, contract: core.world, sharedWorld: core.world.sharedWorld }) : undefined;
}

/**
 * REPLAY ONE PLAYER'S RUN FROM WHAT THE NODE ALREADY STORES.
 *
 * `transcript` is `Round#transcript()`: absolute tick numbers with five words
 * each, and sparse `[tick, size]` liquidations. `entry` is the player's signed
 * Entry Contract, which is where the START tick comes from - letter 19 fixed
 * that a late run begins at the tick its own entry names, so a replay that
 * began at zero would be replaying a different run from the one played.
 *
 * `marks` are the player's own checkpoints: `{ tick, stateHash }`. Each is
 * compared against the state THIS core reaches at that tick, and the first
 * that disagrees is named. A disagreement is not decided here - section 13
 * needs five of seven and one node is not a committee - it is reported.
 *
 * `pictures` are ticks a GHOST is wanted for (0.9 / 0.10): three truck words,
 * read off this same run at the tick it asks for. They are taken HERE, inside
 * the one loop, and not by a caller stepping its own copy - a second stepping
 * path would agree today and be the live parallel simulator the moment either
 * side changed. `ghosts.js` builds the frame and never touches the core.
 *
 * A PICTURE AT TICK N IS THE TRUCK AFTER N WAS STEPPED, which is not the mark
 * convention above and is deliberate: a mark names the state it REACHED
 * (published after stepping N-1), while a ghost names THE TICK IT IS A PICTURE
 * OF, because 11's input chain covers ticks and `ghostBinds` checks the tick
 * against the inputs that cover it. The same state is mark N+1 and ghost N.
 */
/** The core's sandbox (core-sandbox.js), or why it has none: a core that cannot run in the sandbox is not run. */
function sandboxOf(core) {
  if (!core || typeof core.url !== 'string') return { ok: false, why: NO_CORE_RULE };
  let s;
  try { s = sandboxFor(core); } catch (e) { return { ok: false, why: `that run's core is not run outside its sandbox, and it does not load in one: ${e.message}` }; }
  return s.meta.start ? { ok: true, s } : { ok: false, why: NO_CORE_RULE };
}

/**
 * THE UNLOCKS AN ENTRY PLAYS WITH: each item its entry names (protocol 10), as the round's game's catalogue unlocks
 * it (core.items, plugins.js itemUnlocksOf) - in the entry's order. An entry naming no item answers []; one naming an item the game
 * does not sell answers why not, and is not replayed. The core's start is handed them only when there are some.
 */
export function unlocksOf(entry, core) {
  const items = (entry && entry.items) || [];
  const out = [];
  for (const it of items) {
    const u = core && core.items ? core.items[it.itemId] : undefined;
    if (!u) return { ok: false, why: `that entry plays with item "${it.itemId}", which the round's game does not sell` };
    out.push(u);
  }
  return { ok: true, unlocks: out };
}

/** The run's length: the round's (core.runTicks), else the core's runTicks(config), else its RUN_TICKS. */
function runTicksIn(core, s) {
  return Number.isInteger(core.runTicks) ? core.runTicks : s.meta.runTicks ? s.call('runTicks', { config: core.config }) : s.meta.RUN_TICKS;
}

export function replay(transcript, entry, { core, seedWord, roundRandomness, marks = [], pictures = [] } = {}) {
  const box = sandboxOf(core);
  if (!box.ok) return { ok: false, why: box.why };
  const s = box.s;
  if (!Number.isInteger(seedWord)) {
    if (!(entry?.worldSecret instanceof Uint8Array) || entry.worldSecret.length !== 32)
      return { ok: false, why: NO_SEED_RULE };
    if (!(roundRandomness instanceof Uint8Array) || roundRandomness.length !== 32)
      return { ok: false, why: 'that round names no randomness to mix the player seed' };
    try { seedWord = seedWordOf(entry, roundRandomness, core); }
    catch (e) { return { ok: false, why: String(e.message || e) }; }
  }
  if (!transcript || !Array.isArray(transcript.ticks))
    return { ok: false, why: 'that is not a transcript this node stored' };
  if (!entry || !Number.isInteger(entry.joinTick))
    return { ok: false, why: 'that entry names no join tick to start from' };

  const { ticks } = transcript;
  const start = entry.joinTick;
  if (ticks.length === 0) return { ok: false, why: 'that transcript carries no ticks' };
  if (ticks[0].tick !== start)
    return { ok: false, why: `that transcript starts at tick ${ticks[0].tick} and the entry joins at ${start}` };

  // AND A RUN THAT NEVER ENDS IS NOT A LONGER RUN. The core stops every run at
  // BLOCK_TICKS elapsed - 0.8's mission duration, counted from this player's
  // own first tick so a late joiner gets a whole one - so a transcript
  // reaching past `joinTick + BLOCK_TICKS` is inputs for a run that is over,
  // and replaying them spends a worker on ticks no honest node will replay.
  // Measured before this existed: 9600 ticks of a 9000-tick run replayed
  // clean, all 9600 of them.
  // THE RUN'S LENGTH IS ITS CORE'S, under the round's config (M3 R1 R3): runTicks(config), else RUN_TICKS.
  // AND, SINCE THE 82/90 FORK, THE ROUND'S OWN: core.runTicks, its contract's blockTicks, when the round names one.
  let runTicks;
  try { runTicks = runTicksIn(core, s); } catch (e) { return { ok: false, why: e.message }; }
  const ends = lastTickOfRun(start, runTicks);
  const reaches = ticks[ticks.length - 1].tick;
  if (reaches > ends)
    return {
      ok: false,
      why: `that run ends at tick ${ends} - the round's last of ${runTicks}, joined at ${start} - `
        + `and that transcript reaches ${reaches}`,
    };

  // A GAP IS NOT A SHORTER RUN. Ticks are absolute precisely so a hole shows
  // as a hole; replaying across one would produce a state nobody played and a
  // hash that disagrees for a reason that has nothing to do with the player.
  for (let i = 0; i < ticks.length; i++) {
    if (ticks[i].tick !== start + i)
      return { ok: false, why: `the transcript jumps from tick ${ticks[i - 1].tick} to ${ticks[i].tick}` };
    if (!Array.isArray(ticks[i].words) || ticks[i].words.length !== INPUT_WORDS)
      return { ok: false, why: `tick ${ticks[i].tick} does not carry five words` };
  }

  // BEFORE THAT TICK, which is what the golden vectors say and what
  // `core/tools/replay.js` does: liquidations, loads, samples and tapes land
  // BEFORE the tick they name (the core's eventsOf), a mark names the state a
  // tick REACHED, a picture the truck after its tick was stepped. That loop is
  // core-driver.js now, run inside the core's sandbox: it is
  // handed the words, the events, the marks and the ticks wanted as one JSON
  // string, and answers one. A LATE ENTRY'S RUN ENDS WITH THE ROUND'S (kanban
  //): blockTicks - joinTick ticks, the same as every run for joinTick 0.
  const unl = unlocksOf(entry, core);
  if (!unl.ok) return { ok: false, why: unl.why };
  let ran;
  try {
    ran = s.call('replay', {
      seedWord, config: core.config, runTicks: runTicksForEntry(start, runTicks), start, ...(unl.unlocks.length ? { items: unl.unlocks } : {}), slot: slotOf(entry, core),
      words: ticks.map((t) => t.words),
      events: { liquidations: transcript.liquidations, loads: transcript.loads, samples: transcript.samples, tapes: transcript.tapes },
      marks: marks.map((m) => [m.tick, hex(m.stateHash)]), pictures,
    });
  } catch (e) { return { ok: false, why: e.message }; }
  const taken = new Map(ran.taken.map((p) => [p.tick, p]));
  const { checked, divergedAt } = ran;
  const events = { count: ran.count || {} };

  return {
    ok: true,
    // THE CORE THAT REPLAYED IT, by its own hash - what a result may name, and nothing else.
    coreHash: core.hash,
    outcome: ran.outcome,
    // Every tick that was asked for and reached, in the order asked. A tick
    // this run never got to is simply absent - the caller is refusing it by
    // name, and a zeroed picture would be a truck somewhere it never was.
    pictures: pictures.map((at) => taken.get(at)).filter(Boolean),
    score: ran.score,
    ticks: ticks.length,
    liquidations: events.count.liquidations,
    loads: events.count.loads,
    samples: events.count.samples,
    tapes: events.count.tapes,
    heat: ran.heat,
    stateHash: ran.stateHash,
    checked,
    unchecked: marks.length - checked,
    divergedAt,
    agrees: divergedAt === null,
  };
}

/**
 * THE SAME REPLAY, OFF THE DAEMON'S OWN THREAD.
 *
 * A replay is minutes of simulation. Run on the event loop it would stop the
 * node answering anything - no batch stored, no receipt issued, no checkpoint
 * taken - for as long as it took, and a daemon that goes deaf while it thinks
 * is a daemon that drops the run it is meant to be witnessing. IMPLEMENTATION
 * calls for worker threads, each loading the simulator once - since M3 R1 the core the round names,
 * by its adapter's URL (the game's registration), not a core this file imports.
 *
 * IT IS THE SAME FILE. The worker entry is this module: a Worker is started on
 * `import.meta.url`, so there is exactly one door to the simulator whichever
 * thread opens it, and the guard test that counts the files reaching the core
 * still counts one. A separate worker entry would be a second place to change
 * when the loop changes.
 *
 * AND IT IS STILL NOT A LIVE SECOND SIMULATOR. A thread does not make it one:
 * the transcript is finished before this is called, and nothing here has a
 * clock - no interval, no timeout, nothing that could step in time with
 * anybody. It runs as fast as the machine allows and stops at the last stored
 * tick.
 */
export function replayInWorker(transcript, entry, options = {}) {
  // THE CORE CROSSES AS ITS HASH AND ITS MODULE, not as the object: the worker imports the adapter
  // itself, so no function is ever handed across a thread.
  //
  // AND A STORED RUN CROSSES AS ITS NAME. `source` is a store's path and the two ids: the worker opens that file
  // read-only and reads the run's inputs itself. Measured on the Daily (2026-09-17 19:15, the ghost lag): a
  // close held the daemon's loop 554-1511 ms before it waited, none of its steps over 100 ms alone - it is the
  // per-entry work of up to seven entries, and a transcript read is 21-31 ms of each. The loop that feeds pictured
  // trucks does not read them any more. A caller holding a transcript already still hands it over as before.
  const { core, source, ...rest } = options;
  if (!core || typeof core.url !== 'string') return Promise.resolve({ ok: false, why: NO_CORE_RULE });
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { blwpReplay: true, transcript, entry, source: source || null, options: rest,
        core: { hash: core.hash, url: core.url, root: core.root ? String(core.root) : undefined, sourceHash: core.sourceHash,
          name: core.name, config: core.config, runTicks: core.runTicks, world: core.world || null,
          // AND THE GAME'S ITEM CATALOGUE (measured live 2026-10-16 05:50Z: every committee seat held the truck entry
          // 3de8e94c "plays with item "large-truck", which the round's game does not sell" - the worker's core lost `items` here)
          ...(core.items ? { items: { ...core.items } } : {}) } },
    });
    let answered = false;
    worker.once('message', (m) => { answered = true; resolve(m); });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!answered) reject(new Error(`the replay worker exited with ${code} before answering`));
    });
  });
}

// THE WORKER SIDE OF THE SAME FILE. Only reached when this module is started
// as a Worker by `replayInWorker`; in the daemon's own thread it does nothing.
if (!isMainThread && workerData && workerData.blwpReplay) {
  const { transcript, entry, source, options, core } = workerData;
  // THE CORE IS NOT IMPORTED HERE: replay() loads it into its sandbox from its checked files
  Promise.resolve().then(async () => {
    let inputs = transcript;
    if (source) {
      // READ HERE, NOT ON THE DAEMON'S LOOP. Read-only, and only the rows of this one run.
      const { DatabaseSync } = await import('node:sqlite');
      const { readTranscript } = await import('./transcript-read.js');
      const db = new DatabaseSync(source.store, { readOnly: true });
      try { inputs = readTranscript(db, source.roundId, source.entryId); }
      finally { try { db.close(); } catch { /* closing */ } }
    }
    parentPort.postMessage(replay(inputs, entry, { ...options, core }));
    parentPort.close();
  }, (e) => {
    parentPort.postMessage({ ok: false, why: `the core named for that run could not be loaded: ${e.message}` });
    parentPort.close();
  });
}

/**
 * THE SAME RUN, KEPT WARM, SO THE PICTURE CAN KEEP UP WITH THE TRUCK.
 *
 * `replay` starts at `init(seed)` every time it is called, which is right for
 * the thing it is for: a run that is over, replayed once, signed once. It is
 * the wrong shape for a LIVE ghost, and the difference was measured rather
 * than argued. A driver publishes a batch every 100 ms (`BatchEvery` is 6
 * ticks at 60 Hz), so a watcher's frame has to cost well under that:
 *
 *     tick     5     one frame  11.8 ms
 *     tick  1085     one frame  94.6 ms      already the whole budget
 *     tick  2165     one frame 175.9 ms
 *     tick  3599     one frame 568.9 ms      five batches behind, per watcher
 *
 *     600 frames of a 60-second run cost 110 SECONDS of simulation, and the
 *     frame cache served 0 of them - every frame replayed the run from zero.
 *
 * That is the whole of "the other truck is seen at spawn and then does not
 * follow": it keeps up for about eighteen seconds and then falls behind for
 * good, and a frame that does land is minutes old by the time it is drawn.
 *
 * SO THE STATE IS KEPT AND STEPPED FORWARD. Nothing about the simulation
 * changes: same seed, same words, same order, and a liquidation still lands
 * BEFORE its own tick and exactly once. What changes is that the ticks already
 * stepped are not stepped again. `ghost-live.test.js` measures that the pose
 * this produces is byte-identical to a full replay's at every tick, because
 * "it should be the same" is not a thing to take on trust when it is the
 * position other players are shown.
 *
 * A GHOST IS STILL A PICTURE (0.10). This runs on the NODE, off the transcript
 * the node stored, and produces three words. Nothing here is an input to
 * anybody's simulation and no browser computes any of it.
 */
/** A warm run's state lives in its core's sandbox; when the RunInProgress holding it is collected, it is let go there too. */
const DROP = new FinalizationRegistry(({ s, id }) => { try { s.call('drop', { id }); } catch { /* gone with it */ } });

export class RunInProgress {
  constructor(entry, { core, seedWord, roundRandomness } = {}) {
    this.ok = true;
    // THE CORE THE ROUND NAMES (M3 R1), as `replay` takes it: none named, none run.
    const box = sandboxOf(core);
    if (!box.ok) return Object.assign(this, { ok: false, why: box.why });
    this.core = core;
    this.s = box.s;
    if (!Number.isInteger(seedWord)) {
      if (!(entry?.worldSecret instanceof Uint8Array) || entry.worldSecret.length !== 32)
        return Object.assign(this, { ok: false, why: NO_SEED_RULE });
      if (!(roundRandomness instanceof Uint8Array) || roundRandomness.length !== 32)
        return Object.assign(this, { ok: false, why: 'that round names no randomness to mix the player seed' });
      try { seedWord = seedWordOf(entry, roundRandomness, core); }
      catch (e) { return Object.assign(this, { ok: false, why: String(e.message || e) }); }
    }
    if (!entry || !Number.isInteger(entry.joinTick))
      return Object.assign(this, { ok: false, why: 'that entry names no join tick to start from' });

    this.seedWord = seedWord;
    this.joinTick = entry.joinTick;
    try {
      this.runTicks = runTicksIn(core, this.s);
      // THE RUN IS KEPT IN THE CORE'S SANDBOX; this object holds its number, and lets it go when it is collected
      const unl = unlocksOf(entry, core);
      if (!unl.ok) return Object.assign(this, { ok: false, why: unl.why });
      this.id = this.s.call('open', { seedWord, config: core.config, runTicks: runTicksForEntry(entry.joinTick, this.runTicks),
        ...(unl.unlocks.length ? { items: unl.unlocks } : {}), slot: slotOf(entry, core) });
    } catch (e) { return Object.assign(this, { ok: false, why: e.message }); }
    DROP.register(this, { s: this.s, id: this.id });
    this.endsAt = lastTickOfRun(entry.joinTick, this.runTicks);
    // The last tick STEPPED. Nothing yet, so one before the join.
    this.at = entry.joinTick - 1;
    // Liquidations land BEFORE their own tick and exactly once, whether the
    // caller hands the whole run or one slice at a time.
    this.due = new Map();
    this.seen = new Set();
    // AND THE LOAD, by the same rule and for the reason letter 40 exists: this
    // is the path a LIVE ghost is drawn on, so a warm run that ignored the
    // load would draw every other player's truck as though its bed were empty
    // while its driver was being hunted for a full one - which is the wrong
    // pose the letter was reopened on.
    this.loadDue = new Map();
    this.loadSeen = new Set();
    this.stepped = 0;
  }

  /** x, z and heading as of the last tick stepped. Three words, like `replay`. */
  pose() {
    return { tick: this.at, ...this.s.call('pose', { id: this.id }) };
  }

  /**
   * STEP FORWARD TO `tick`, and refuse for the same reasons `replay` refuses.
   *
   * The transcript is the node's own and grows only at the end, so the ticks
   * already stepped are checked by position rather than re-walked: a
   * transcript whose earlier ticks changed under a warm state is not a longer
   * run, it is a different one, and it is refused rather than continued.
   */
  stepTo(transcript, tick) {
    if (!this.ok) return { ok: false, why: this.why };
    if (!transcript || !Array.isArray(transcript.ticks))
      return { ok: false, why: 'that is not a transcript this node stored' };
    const { ticks } = transcript;
    if (!ticks.length) return { ok: false, why: 'that transcript carries no ticks' };
    // THE SLICE MAY START WHERE THIS RUN IS, not only at the join. A live
    // watcher reads the ticks it has not stepped; a caller handing the whole
    // run still works, because `from` is then the join tick.
    const from = Number.isInteger(transcript.from) ? transcript.from : this.joinTick;
    if (from > this.at + 1)
      return { ok: false, why: `this run is at tick ${this.at} and that slice starts at ${from}` };
    if (ticks[0].tick !== from)
      return { ok: false, why: `that transcript starts at tick ${ticks[0].tick} and was said to start at ${from}` };
    if (from === this.joinTick && ticks[0].tick !== this.joinTick)
      return { ok: false, why: `that transcript starts at tick ${ticks[0].tick} and the entry joins at ${this.joinTick}` };
    if (!Number.isInteger(tick) || tick < this.joinTick)
      return { ok: false, why: 'a ghost is at a whole tick of this run' };
    if (tick > this.endsAt)
      return {
        ok: false,
        why: `that run ends at tick ${this.endsAt} - the round's last of ${this.runTicks}, joined at `
          + `${this.joinTick} - and that picture asks for ${tick}`,
      };

    // A GAP IS NOT A SHORTER RUN, and neither is a transcript that lost its
    // beginning: ticks are absolute, so both show as a mismatch here.
    const want = tick - from;
    if (want >= ticks.length)
      return { ok: false, why: `tick ${tick} is not one the published inputs cover` };
    for (let i = 0; i <= want; i++)
      if (ticks[i].tick !== from + i)
        return { ok: false, why: `that transcript has a gap at tick ${from + i}` };

    // THE LIQUIDATIONS, ONCE EACH. Built on the first step so a transcript
    // that gains one later is not applied twice, and consumed as they land.
    for (const [at, size] of transcript.liquidations || [])
      if (at > this.at && !this.seen.has(at)) { this.due.set(at, size); this.seen.add(at); }

    // THE LOADS, ONCE EACH, the same way. A live watcher asks for the newest
    // ticks and the node serves the loads WHOLE beside them, so the one
    // declared at roll-out is in every slice - and this is what stops it being
    // applied again on each.
    for (const [at, ...load] of transcript.loads || [])    // [fee, btc] or [fee, btc, room] (the bed fill, C)
      if (at > this.at && !this.loadSeen.has(at)) {
        this.loadDue.set(at, load); this.loadSeen.add(at);
      }

    // THE PRICE SAMPLES, ONCE EACH, like the liquidations: each moves the tape at its own tick.
    if (!this.sampleDue) { this.sampleDue = new Map(); this.sampleSeen = new Set(); this.tapeDue = new Map(); this.tapeSeen = new Set(); }
    // THE LIVE TAPE, ONCE: served whole with every slice, applied at its own tick
    for (const [at, ...prices] of transcript.tapes || [])
      if (at > this.at && !this.tapeSeen.has(at)) { this.tapeDue.set(at, prices); this.tapeSeen.add(at); }
    for (const [at, price] of transcript.samples || [])
      if (at > this.at && !this.sampleSeen.has(at)) { this.sampleDue.set(at, price); this.sampleSeen.add(at); }

    // THE CORE APPLIES THEM (adapter.eventsOf), each before its own tick - and a tick is stepped once,
    // so each lands once, whichever slice brought it.
    // In the sandbox (core-driver.js stepTo), as one call: the ticks up to the first that does not carry five words,
    // which is refused after the ones before it were stepped, as it always was.
    const events = {
      liquidations: [...this.due],
      loads: [...this.loadDue].map(([at, load]) => [at, ...load]),
      samples: [...this.sampleDue],
      tapes: [...this.tapeDue].map(([at, prices]) => [at, ...prices]),
    };
    const words = [];
    let bad = null;
    for (let at = this.at + 1; at <= tick; at++) {
      const t = ticks[at - from];
      if (!Array.isArray(t.words) || t.words.length !== INPUT_WORDS) { bad = t; break; }
      words.push(t.words);
    }
    if (words.length) {
      try { this.s.call('stepTo', { id: this.id, events, from: this.at + 1, words }); }
      catch (e) { return { ok: false, why: e.message }; }
      this.at += words.length;
      this.stepped += words.length;
    }
    if (bad) return { ok: false, why: `tick ${bad.tick} does not carry five words` };
    // Consumed as they land: nothing at or before the last tick stepped is kept.
    for (const at of [...this.due.keys()]) if (at <= this.at) this.due.delete(at);
    for (const at of [...this.loadDue.keys()]) if (at <= this.at) this.loadDue.delete(at);
    for (const at of [...this.sampleDue.keys()]) if (at <= this.at) this.sampleDue.delete(at);
    for (const at of [...this.tapeDue.keys()]) if (at <= this.at) this.tapeDue.delete(at);
    return { ok: true, ...this.pose() };
  }
}
