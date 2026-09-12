// WHAT A LAUNCHED DAEMON COUNTS AS FUNDED (M3.3-31).
//
// `serve` refuses a round or an entry nobody funded - the disk is spent only on
// stakes that exist (IMPLEMENTATION.md), and a default of yes is how a stranger
// opened 200 free rounds. But `main.js` gave `serve` no answer at all, so a
// launched daemon refused EVERY round and every entry with 402 and held no
// stake: a round for sats existed only where a harness passed `() => true`.
//
// The rule (the owner's pick):
//   a ROUND is funded when the operator NAMED it and it asks a stake - named in
//     BLWP_FUNDED_ROUNDS (ids, comma or space) or BLWP_FUNDED_ROUNDS_FILE (one
//     id per line, read on every ask, so a round can be named without a
//     restart). Neither set, none named. A free round is not funded here.
//   an ENTRY is funded when it names a round this node already holds, that
//     round asks a stake, and this node can hold it: Lightning for a hold
//     invoice, and - for a round naming a federation, whose stake is a lock
//     the seat verifies there (§23.1 step 5, W1b) - the federation.
// NOT "the invoice is paid": the hold is issued after the entry is stored. The
// transcript waits for the money anyway - input batches are refused until the
// stake is seen paid.
import { readFileSync } from 'node:fs';
import { roundId, decodeRoundContract } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';

const idsIn = (text) => String(text || '').split(/[\s,]+/)
  .map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{64}$/.test(s));

/**
 * `named()` answers which round ids the operator funds, asked each time.
 * `funded.nameRound(id)` adds one in-process - the rehearsal names its round
 * once the contract that names this node gives it an id.
 */
export function operatorFunding({ named = () => [] } = {}) {
  const added = new Set();
  const isNamed = (hex) => added.has(hex) || named().includes(hex);
  const funded = ({ kind, contract, node } = {}) => {
    try {
      if (kind === 'round')
        return BigInt(contract.stakeMsat) > 0n && isNamed(toHex(roundId(contract)));
      if (kind === 'entry') {
        if (!node) return false;
        const held = node.holds(contract.roundId);
        if (!held) return false;
        const round = decodeRoundContract(new Uint8Array(held.contract));
        if (BigInt(round.stakeMsat) <= 0n) return false;
        // CAN THIS NODE HOLD THE STAKE, asked of the stake's own custody. A
        // round naming a federation takes its stake as a lock in that
        // federation, which the seat VERIFIES there (§23.1 step 5) - so the
        // node must reach the federation, and Lightning is not it. Any other
        // paying round is a hold invoice, which needs Lightning, as before.
        const locks = round.custody === 'FEDERATION' && round.federationId instanceof Uint8Array
          && round.federationId.some((b) => b !== 0);
        return locks ? !!node.reachesFederation : !!node.reachesLightning;
      }
    } catch { return false; }
    return false;
  };
  funded.nameRound = (id) => { added.add(typeof id === 'string' ? id.toLowerCase() : toHex(id)); };
  return funded;
}

/** The launcher's rule, off the operator's own settings. */
export function fundingFromEnv(env) {
  return operatorFunding({
    named: () => {
      const ids = idsIn(env.BLWP_FUNDED_ROUNDS);
      if (env.BLWP_FUNDED_ROUNDS_FILE) {
        try { ids.push(...idsIn(readFileSync(env.BLWP_FUNDED_ROUNDS_FILE, 'utf8'))); }
        catch { /* no such file yet: none named from it */ }
      }
      return ids;
    },
  });
}
