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
import { toHex } from '../../protocol/src/hash.js';

/** The truck: the network's first title, its genesis game config its one rule set. */
export const TRUCK = Object.freeze({
  name: TRUCK_ADAPTER.name,
  hash: coreHashHex(),
  url: new URL('../../core/src/adapter.js', import.meta.url).href,
  adapter: TRUCK_ADAPTER,
  configs: new Map([[toHex(GENESIS_CONFIG_HASH), {}]]),
});

/**
 * THE CORE A ROUND IS REPLAYED BY. Step A of R1 (TASKBOOK): every round is replayed by the truck,
 * as every round was before - the seam moves, nothing else does. Step B picks by the round's
 * simCoreHash and configHash from the seat's installed cores and refuses a pair it does not hold.
 */
export function coreForRound(/* contract */) {
  return { ok: true, core: TRUCK };
}
