// THE TRUCK GAME, AS A CORE A SEAT REPLAYS (M3; the owner 2026-09-15 08:03 and 08:07).
//
// The seats are a network the truck game runs on, not the game. They replay the core a round names
// - its sim_wasm_hash - and read no truck, cargo or map themselves: this is the one face the truck
// shows them, the same calls every core a seat can replay answers. It lives in core/src, so the
// core's hash covers it: what a run came to is decided here, by the core, not by a seat. The page's
// bundle does not carry it - the page drives sim.js itself, and nothing bundled imports this file.
import { init, step, submitLiquidation, submitLoad, submitSample, submitTape, runScore } from './sim.js';
import { hash, O_SCORE, S_STATE, S_HEAT, O_TRUCK, T_X, T_Z, T_HEADING } from './state.js';
import { RUN_LIVE, RUN_DELIVERED, BLOCK_TICKS, runTicksIsValid } from './rules/gate.js';

export const CORE = Object.freeze({
  name: 'btc-logistics truck',
  /** A run's length in ticks when its round names none (0.8's mission duration), and the longest a round may name. */
  RUN_TICKS: BLOCK_TICKS,
  /** Whether a round may name this run length (blockTicks): the hard fork of 2026-10-01 - the round's, 1 to RUN_TICKS. */
  runTicksFits: (t) => runTicksIsValid(t),
  /** Input words per tick: throttle, steer, brake, handbrake, practice. */
  INPUT_WORDS: 5,
  /** A run from its seed word, ending after its round's run length (blockTicks; RUN_TICKS when none is named). */
  start: (seedWord, config, { runTicks } = {}) => init(seedWord, runTicks === undefined ? {} : { runTicks }),
  /**
   * THE TRANSCRIPT'S OWN EVENTS, each applied BEFORE the tick it names - round setup for that tick,
   * not a consequence of it: a load (fee, btc - how hard the war hunts the run; and the room it fills, the cargo factor C,
   * when it carries one) and a liquidation
   * (size). Loads first, then liquidations, as the golden vectors and core/tools/replay.js have it.
   */
  eventsOf(transcript) {
    const due = new Map((transcript.liquidations || []).map(([at, size]) => [at, size]));
    // a load is [at, fee, btc] or, since the bed fill crossed (the owner 2026-10-04 08:54), [at, fee, btc, room]
    const loaded = new Map((transcript.loads || []).map(([at, ...rest]) => [at, rest]));
    // the live price, one sample at a tick (the page submits at most one per 300 ticks)
    const priced = new Map((transcript.samples || []).map(([at, price]) => [at, price]));
    // the live tape handed over before any sample, [tick, p0 .. p63]
    const taped = new Map((transcript.tapes || []).map(([at, ...prices]) => [at, prices]));
    return {
      count: { liquidations: due.size, loads: loaded.size, samples: priced.size, tapes: taped.size },
      before(st, tick) {
        if (taped.has(tick)) submitTape(st, taped.get(tick));
        if (loaded.has(tick)) submitLoad(st, ...loaded.get(tick));
        if (priced.has(tick)) submitSample(st, priced.get(tick));
        if (due.has(tick)) submitLiquidation(st, due.get(tick));
      },
    };
  },
  /** One tick of the player's five words. */
  step: (st, w) => step(st, w[0], w[1], w[2], w[3], w[4]),
  stateHash: (st) => hash(st),
  /**
   * WHAT THE RUN CAME TO, off the state: DELIVERED; FAILED for wrecked and missed - the whole of the
   * difference the money cares about; null while it is still LIVE (not FAILED: the transcript only
   * stops). Its score, and the heat it was hunted at.
   */
  result(st) {
    const ended = st.i32[O_SCORE + S_STATE];
    return {
      outcome: ended === RUN_LIVE ? null : (ended === RUN_DELIVERED ? 'DELIVERED' : 'FAILED'),
      score: runScore(st),
      heat: st.i32[O_SCORE + S_HEAT],
    };
  },
  /** A ghost's picture: three words, the truck's x, z and heading after the tick. */
  picture: (st) => ({ x: st.i32[O_TRUCK + T_X], z: st.i32[O_TRUCK + T_Z], heading: st.i32[O_TRUCK + T_HEADING] }),
});
