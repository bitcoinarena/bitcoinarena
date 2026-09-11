// A PAYING ROUND RUNS A CORE THIS CLIENT KNOWS, OR IT IS REFUSED.
//
// Section 5 (v4.6): "The sim_wasm_hash is chosen by the round creator, so the
// client must not accept it blindly. For real-money rounds the client MUST
// verify the hash against its known-good list of reproducibly built core
// versions, and MUST refuse - or require an explicit, clearly worded override -
// for unknown hashes. Otherwise a creator could publish a round running a
// backdoored core." This client refuses. There is no override: no flag, no
// query parameter, nothing that lets an unknown core through.
//
// F2's second clause rests on it (FEDERATION.md): the player's key is theirs
// only if the code that decides the round is code they can know.
import { toHex } from './hash.js';
import { KNOWN_GOOD_CORE_HASHES } from './known-cores.js';

export function coreIsKnownGood(simCoreHash) {
  if (!(simCoreHash instanceof Uint8Array) || simCoreHash.length !== 32)
    return { ok: false, why: 'that round names no 32-byte core hash, so nothing says which simulation decides it' };
  const hex = toHex(simCoreHash);
  if (!KNOWN_GOOD_CORE_HASHES.includes(hex))
    return {
      ok: false,
      why: `that round runs core ${hex.slice(0, 16)}..., which is not on this client's known-good list of `
        + 'reproducibly built cores: a paying round on an unknown core is refused (§5)',
    };
  return { ok: true };
}
