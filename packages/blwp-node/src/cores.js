// THE CORES THIS SIGNER NODE CAN REPLAY (M3; the owner 2026-09-15 08:03: "the truck game is one use of the
// federated consensus network, not the network"; 08:07: "several games at once, and several rule
// sets at once. Each round names its sim_wasm_hash and its game_config/config_hash").
//
// The one door between a signer node and any game. Each core is its adapter module (the calls a signer node
// replays through, core/src/adapter.js for the truck), its hash - sim_wasm_hash, computed here from
// its own sources, never typed - and the configs it runs, by config_hash. `replay.js` imports no
// core: it is handed one of these.
import { CORE as TRUCK_ADAPTER } from '../../core/src/adapter.js';
import { CORE as TRUCK_2069_ADAPTER } from '../../core/frozen/2069b4c2/adapter.js';
import { CORE as TRUCK_DE2F_ADAPTER } from '../../core/frozen/de2f263d/adapter.js';
import { coreHashHex } from '../../core/tools/hash-core.js';
import { GENESIS_CONFIG_HASH } from '../../protocol/src/genesis-ids.js';
import { computeCurrentConfigHash, computeDe2fConfigHash } from '../../protocol/src/genesis.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

/**
 * THE CONFIG A ROUND ON THE TRUCK NAMES (the owner 2026-10-04, fix 1 of the spec audit; §27A.6 "a round is bound to the config
 * it was created under"): the current core's own rules, hashed from its constants (genesis.js encodeGameConfigV2) - not
 * the founding config, which the network id commits to and which describes 2069b4c2's rounds.
 */
export const TRUCK_CURRENT_CONFIG = toHex(computeCurrentConfigHash());
/**
 * THE ROUNDS de2f263d PLAYED BEFORE ITS CONFIG HAD A HASH OF ITS OWN: from 08:23Z on 2026-10-04 the free pair opened rounds
 * naming de2f263d with the founding config, and they are not rewritten. That one pair stays accepted for a round whose
 * committee time is before the cut-over, and for no round after it.
 */
export const DE2F_HASH = 'de2f263da7ddf892699713ccd43041fb2ea881df9994fbe9f32581904e32e6c8';
export const FOUNDING_CONFIG_ON_DE2F_BEFORE_MS = Date.parse('2026-10-04T13:00:00Z');

/** The truck: the network's title, the current core with the config its rounds name. */
export const TRUCK = Object.freeze({
  name: TRUCK_ADAPTER.name,
  hash: coreHashHex(),
  url: new URL('../../core/src/adapter.js', import.meta.url).href,
  adapter: TRUCK_ADAPTER,
  configs: new Map([[TRUCK_CURRENT_CONFIG, {}]]),
  // the bundle the replay page runs for this core's rounds (core/tools/bundle-replay.js)
  replayFile: new URL('../../core/dist/blwp-replay-core.js', import.meta.url),
});

/**
 * THE TRUCK BEFORE C BECAME THE BED FILL AND T SANK FROM 20 S (the owner 2026-10-04 08:54 and 09:17; accepted path A): core
 * 2069b4c2, kept INSTALLED beside the truck - every round published on it (the day's paid set, the late-join series, the
 * free rounds before the pair moved) is replayed by it, byte for byte the core those rounds were played on. Its source
 * is frozen in core/frozen/2069b4c2 and its hash is computed from those files here, never typed: a frozen tree that
 * drifted would name another core and be refused below.
 */
/**
 * de2f263d KEPT INSTALLED BESIDE THE TRUCK (the owner 2026-10-04, option 1: exposure weighted by heat makes a new core): the
 * free rounds the pair opened on it from 08:23Z are replayed by it, frozen in core/frozen/de2f263d. It plays its own
 * config dbb49344 (v2), and the founding config only for a round made before the 13:00Z cut-over.
 */
const FROZEN_DE2F = new URL('../../core/frozen/de2f263d', import.meta.url).pathname;
if (coreHashHex(FROZEN_DE2F) !== DE2F_HASH) throw new Error(`core/frozen/de2f263d hashes to ${coreHashHex(FROZEN_DE2F)}, not the core it keeps`);
export const TRUCK_DE2F = Object.freeze({
  name: `${TRUCK_ADAPTER.name} (de2f263d, exposure by C)`,
  hash: DE2F_HASH,
  url: new URL('../../core/frozen/de2f263d/adapter.js', import.meta.url).href,
  adapter: TRUCK_DE2F_ADAPTER,
  configs: new Map([[toHex(computeDe2fConfigHash()), {}],
    [toHex(GENESIS_CONFIG_HASH), { committeeBeforeMs: FOUNDING_CONFIG_ON_DE2F_BEFORE_MS }]]),
  replayFile: new URL('../../core/dist/blwp-replay-core-de2f263d.js', import.meta.url),
});

export const TRUCK_2069_HASH = '2069b4c2ab39466c79000aac1b091c75b066b814a0952f8037011691538a774e';
const FROZEN_2069 = new URL('../../core/frozen/2069b4c2', import.meta.url).pathname;
if (coreHashHex(FROZEN_2069) !== TRUCK_2069_HASH) throw new Error(`core/frozen/2069b4c2 hashes to ${coreHashHex(FROZEN_2069)}, not the core it keeps`);
export const TRUCK_2069 = Object.freeze({
  name: `${TRUCK_ADAPTER.name} (2069b4c2, C 0.7 and par 65 s)`,
  hash: TRUCK_2069_HASH,
  url: new URL('../../core/frozen/2069b4c2/adapter.js', import.meta.url).href,
  adapter: TRUCK_2069_ADAPTER,
  configs: new Map([[toHex(GENESIS_CONFIG_HASH), {}]]),
  replayFile: new URL('../../core/dist/blwp-replay-core-2069b4c2.js', import.meta.url),
});

/**
 * A CORE'S RUN LENGTH UNDER A CONFIG (M3 R1 R3): its `runTicks(config)` where it has one, else its one RUN_TICKS (the
 * truck's BLOCK_TICKS) - the length of a run whose round names none, and, since the 82/90 fork, the longest one may.
 */
export function runTicksOf(core, config) {
  const a = core && core.adapter;
  if (!a) return null;
  return typeof a.runTicks === 'function' ? a.runTicks(config) : a.RUN_TICKS;
}

/**
 * MAY A ROUND NAME THIS RUN LENGTH ON THIS CORE (the 82/90 fork, the owner 2026-10-01: "The round length must be part of
 * the contract - not a fixed constant")? A core held to one length (the truck before the fork) takes that one; a core
 * that takes the round's length takes any it says fits (1 .. RUN_TICKS for the truck).
 */
export function runLengthFits(core, config, blockTicks) {
  if (!core || !core.adapter) return { ok: false, why: 'no core to check that round\'s run length against' };
  if (!Number.isInteger(blockTicks)) return { ok: false, why: 'that round names no run length' };
  if (Number.isInteger(core.fixedRunTicks))
    return blockTicks === core.fixedRunTicks ? { ok: true }
      : { ok: false, why: `that round says a run is ${blockTicks} ticks and this core ends one at ${core.fixedRunTicks} (${core.name}) - a run is not replayed to a length its core does not stop at` };
  if (typeof core.adapter.runTicksFits !== 'function') {
    // A CORE OF ONE LENGTH UNDER ITS CONFIG (it takes none from the round): that length only.
    const own = runTicksOf(core, config);
    return blockTicks === own ? { ok: true }
      : { ok: false, why: `that round says a run is ${blockTicks} ticks and this core ends one at ${own}` };
  }
  return core.adapter.runTicksFits(blockTicks) ? { ok: true }
    : { ok: false, why: `that round says a run is ${blockTicks} ticks, and ${core.name} runs 1 to ${runTicksOf(core, config)}` };
}

/** The truck's hashes as a round names them: its sim_wasm_hash and the config_hash of the rules it plays. */
export const TRUCK_CORE_HASH = fromHex(TRUCK.hash);
export const TRUCK_CONFIG_HASH = fromHex(TRUCK_CURRENT_CONFIG);

/**
 * THE TRUCK BEFORE THE 82/90 HARD FORK (the owner 2026-10-01: "Change the core, it's basically a hard fork"): the core every
 * round before the fork names, d15c39bb..., ended every run at its own 10800 ticks. The core after it takes the run length
 * from the round and runs 10800 ticks hash for hash as the old one did (core/test/round-ends.test.js), so the old hash is
 * installed as this same core held to that one length: its rounds replay unchanged, and none of them names another.
 */
export const TRUCK_BEFORE_FORK_HASH = 'd15c39bb83b7cb63ce2b232a7b62b0078d78d9944013ce42799c80a29bf005ef';
// HELD BY 2069b4c2 SINCE THE TRUCK MOVED ON (2026-10-04): 2069b4c2 is the core that ran d15c39bb's rounds hash for hash at
// 10800 ticks; the truck after it does not (C from an empty bed, T from 20 s), so it no longer stands in for them.
export const TRUCK_BEFORE_FORK = Object.freeze({ ...TRUCK_2069, name: `${TRUCK.name} (before the 82/90 fork)`, hash: TRUCK_BEFORE_FORK_HASH,
  fixedRunTicks: TRUCK_2069_ADAPTER.RUN_TICKS });

/**
 * THE CORES A SIGNER NODE HAS INSTALLED, by hash: the truck always, and every core its operator installs
 * beside it (serve's `cores`) - several at once, each with its own configs (the owner 08:07).
 */
export function installedCores(extra = []) {
  const all = new Map([[TRUCK.hash, TRUCK], [DE2F_HASH, TRUCK_DE2F], [TRUCK_2069_HASH, TRUCK_2069], [TRUCK_BEFORE_FORK_HASH, TRUCK_BEFORE_FORK]]);
  for (const c of extra) all.set(c.hash, c);
  return all;
}
const INSTALLED = installedCores();

/**
 * THE CORE A ROUND IS REPLAYED BY, AND THE CONFIG IT RUNS: the one its simCoreHash names, running
 * the config its configHash names, among the cores this signer node installed. A pair the signer node does not
 * hold is refused by name - 27A.7.5: not selectable for that round, it serves nothing there, it is
 * not ejected and not slashed. (R1 step B; step A handed every round the truck.)
 */
export function coreForRound(contract, installed = INSTALLED) {
  if (!contract || !(contract.simCoreHash instanceof Uint8Array) || contract.simCoreHash.length !== 32)
    return { ok: false, why: 'that round names no 32-byte core' };
  const core = installed.get(toHex(contract.simCoreHash));
  if (!core)
    return { ok: false, why: `this signer node holds no core ${toHex(contract.simCoreHash).slice(0, 16)}: it is not selectable for `
      + 'that round (27A.7.5) - it serves nothing there, and is not slashed' };
  if (!(contract.configHash instanceof Uint8Array) || !core.configs.has(toHex(contract.configHash)))
    return { ok: false, why: `this signer node runs ${core.name} but not the config `
      + `${contract.configHash instanceof Uint8Array ? toHex(contract.configHash).slice(0, 16) : '(none)'} that round names: `
      + 'not selectable for it (27A.7.5)' };
  // A PAIR KEPT ONLY FOR THE ROUNDS ALREADY MADE WITH IT (de2f263d with the founding config): refused past its cut-over
  const config = core.configs.get(toHex(contract.configHash));
  if (config && config.committeeBeforeMs !== undefined
      && !(typeof contract.committeeTimeMs === 'bigint' && contract.committeeTimeMs < BigInt(config.committeeBeforeMs)))
    return { ok: false, why: `${core.name} runs the config ${toHex(contract.configHash).slice(0, 16)} only for rounds made before `
      + `${new Date(config.committeeBeforeMs).toISOString()}: a round on this core names the config of the rules it plays (27A.6)` };
  // AND THE ROUND'S RUN LENGTH (the 82/90 fork): its contract's blockTicks, carried with the core to every replay of it.
  return { ok: true, core, config, runTicks: contract.blockTicks };
}
