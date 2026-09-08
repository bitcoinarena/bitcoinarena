// A NODE'S BEACON, KEPT AS AN ANSWER RATHER THAN FETCHED IN THE MIDDLE OF ONE.
//
// `roster.seedFor` and `verify` ask for the beacon SYNCHRONOUSLY - they are in
// the middle of seating a round or closing one - and reading a chain is not
// synchronous. So the read happens ahead of the question and this holds what
// it found.
//
// THE ANSWER IS ALLOWED TO BE HELD AND THE TIP IS NOT. Those are different
// facts and the difference is the whole safety of doing it this way: for a
// given `committee_time`, the first block whose median time is after it does
// not change as the chain grows. A later read finds the same block DEEPER, not
// a different block. So a held answer is the same answer, while a held TIP
// would be a stale one - which is why what is kept here is what
// `beaconFromChain` decided and never a hash somebody liked.
//
// A REORG IS THE ONE THING THAT CAN MOVE IT, and that is what the depth is
// for: `beaconFromChain` refuses a block shallower than the round's own
// `censusConfirmations`, so nothing is held until it is that settled.
//
// NOTHING IS INVENTED WHEN THERE IS NOTHING. No chain, no read, no answer -
// `for()` returns undefined and the daemons' own rule turns that into "this
// node has no beacon for that round", which is the honest state and already
// tested. There is no default, no constant and no fallback here.
import { beaconFromChain } from '../../protocol/src/beacon.js';
import { headersToTip } from './chain-rpc.js';

/** Headers read per refresh. A view is a window; the rule judges what is in it. */
export const BEACON_WINDOW = 64;

/** Two rounds share an answer only if they ask the same question of the chain. */
const keyOf = (contract) => `${contract.committeeTimeMs}:${contract.censusConfirmations}`;

export function chainBeacon({ call, window = BEACON_WINDOW } = {}) {
  if (typeof call !== 'function') throw new Error('a chain beacon needs a way to ask a node');
  const held = new Map();

  return {
    /**
     * Read the chain and keep what the rule names, or keep nothing.
     *
     * Answers the same shape the rule does, so a caller can print the refusal
     * rather than discover later that it has no beacon.
     */
    async refresh(contract) {
      const view = await headersToTip(call, { count: window });
      const seen = beaconFromChain(contract, view);
      if (seen.ok) held.set(keyOf(contract), seen);
      return seen;
    },

    /** What this node holds for that round, or nothing at all. */
    for({ contract } = {}) {
      if (!contract) return undefined;
      const seen = held.get(keyOf(contract));
      return seen && { hash: seen.hash, height: seen.height, timeMs: seen.timeMs };
    },

    /** What is being held, for an operator who wants to see it. */
    get size() { return held.size; },
  };
}
