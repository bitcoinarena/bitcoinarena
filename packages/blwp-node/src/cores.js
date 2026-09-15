// THE CORES THIS SEAT CAN REPLAY (M3; the owner 2026-09-15 08:03: "the truck game is one use of the
// federated consensus network, not the network"; 08:07: "several games at once, and several rule
// sets at once. Each round names its sim_wasm_hash and its game_config/config_hash").
//
// The one door between a seat and any game. Each core is its adapter module (the calls a seat
// replays through, core/src/adapter.js for the truck), its hash - sim_wasm_hash, computed here from
// its own sources, never typed - and the configs it runs, by config_hash. `replay.js` imports no
// core: it is handed one of these.
import { CORE as TRUCK_ADAPTER } from '../../core/src/adapter.js';
import { coreHashHex } from '../../core/tools/hash-core.js';
import { GENESIS_CONFIG_HASH } from '../../protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

/** The truck: the network's first title, its genesis game config its one rule set. */
export const TRUCK = Object.freeze({
  name: TRUCK_ADAPTER.name,
  hash: coreHashHex(),
  url: new URL('../../core/src/adapter.js', import.meta.url).href,
  adapter: TRUCK_ADAPTER,
  configs: new Map([[toHex(GENESIS_CONFIG_HASH), {}]]),
});

/** The truck's hashes as a round names them: its sim_wasm_hash and its (genesis) config_hash. */
export const TRUCK_CORE_HASH = fromHex(TRUCK.hash);
export const TRUCK_CONFIG_HASH = GENESIS_CONFIG_HASH;

/**
 * THE CORES A SEAT HAS INSTALLED, by hash: the truck always, and every core its operator installs
 * beside it (serve's `cores`) - several at once, each with its own configs (the owner 08:07).
 */
export function installedCores(extra = []) {
  const all = new Map([[TRUCK.hash, TRUCK]]);
  for (const c of extra) all.set(c.hash, c);
  return all;
}
const INSTALLED = installedCores();

/**
 * THE CORE A ROUND IS REPLAYED BY, AND THE CONFIG IT RUNS: the one its simCoreHash names, running
 * the config its configHash names, among the cores this seat installed. A pair the seat does not
 * hold is refused by name - 27A.7.5: not selectable for that round, it serves nothing there, it is
 * not ejected and not slashed. (R1 step B; step A handed every round the truck.)
 */
export function coreForRound(contract, installed = INSTALLED) {
  if (!contract || !(contract.simCoreHash instanceof Uint8Array) || contract.simCoreHash.length !== 32)
    return { ok: false, why: 'that round names no 32-byte core' };
  const core = installed.get(toHex(contract.simCoreHash));
  if (!core)
    return { ok: false, why: `this seat holds no core ${toHex(contract.simCoreHash).slice(0, 16)}: it is not selectable for `
      + 'that round (27A.7.5) - it serves nothing there, and is not slashed' };
  if (!(contract.configHash instanceof Uint8Array) || !core.configs.has(toHex(contract.configHash)))
    return { ok: false, why: `this seat runs ${core.name} but not the config `
      + `${contract.configHash instanceof Uint8Array ? toHex(contract.configHash).slice(0, 16) : '(none)'} that round names: `
      + 'not selectable for it (27A.7.5)' };
  return { ok: true, core, config: core.configs.get(toHex(contract.configHash)) };
}
