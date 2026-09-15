// A SECOND TITLE ON THE SAME SEATS - THE ACCEPTANCE FOR M3 R1 (the owner 2026-09-15 08:07: "several
// games at once, and several rule sets at once ... two titles and two configs can run on the same
// nodes in the same window").
//
// Deliberately nothing like the truck: a run adds its first input word each tick, for its config's
// number of ticks, and delivers when the sum reaches its config's target. It is here to show the
// seats replay whatever core a round names, under whatever config it names, and that the truck is
// not special to them: the same adapter face (core/src/adapter.js), its own hash, its own configs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = (s) => createHash('sha256').update(s).digest();

export const CORE = Object.freeze({
  name: 'counter (a second title)',
  // replay's run-length rule is still the protocol's (R3); a counter run ends by its own config
  RUN_TICKS: 9000,
  INPUT_WORDS: 5,
  start: (seedWord, config = {}) => ({ seed: seedWord | 0, sum: 0, ticks: 0, target: config.target ?? 1000, length: config.ticks ?? 120 }),
  eventsOf: () => ({ count: { liquidations: 0, loads: 0 }, before() {} }),
  step(st, w) {
    if (st.ticks >= st.length) return;
    st.sum = (st.sum + (w[0] | 0)) | 0;
    st.ticks++;
  },
  stateHash: (st) => sha(`counter:${st.seed}:${st.sum}:${st.ticks}:${st.target}:${st.length}`).toString('hex'),
  result: (st) => ({ outcome: st.ticks < st.length ? null : (st.sum >= st.target ? 'DELIVERED' : 'FAILED'), score: st.sum, heat: 0 }),
  picture: (st) => ({ x: st.sum, z: st.ticks, heading: 0 }),
});

/** Its sim_wasm_hash: sha256 over its own source, as the truck's is over its sources. */
export const COUNTER_HASH = sha(readFileSync(new URL(import.meta.url))).toString('hex');

/** Two rule sets for it - a low bar and a high one - each named by the hash of its own bytes. */
export const CONFIGS = [{ target: 1000, ticks: 120 }, { target: 2000000000, ticks: 120 }]
  .map((c) => ({ config: c, hash: sha(`counter-config:${c.target}:${c.ticks}`) }));

/** The registry entry a seat installs beside the truck (serve's `cores`). */
export const COUNTER = Object.freeze({
  name: CORE.name, hash: COUNTER_HASH, url: new URL(import.meta.url).href, adapter: CORE,
  configs: new Map(CONFIGS.map(({ config, hash }) => [hash.toString('hex'), config])),
});
