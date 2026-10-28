// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE'S BEACON, KEPT AS AN ANSWER RATHER THAN FETCHED IN THE MIDDLE OF ONE.
//
// `roster.seedFor` and `verify` ask for the beacon SYNCHRONOUSLY - they are in
// the middle of joining a round or closing one - and reading a chain is not
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
import { beaconFromChain, MEDIAN_TIME_SPAN } from '../../arena-protocol/src/beacon.js';
import { headersToTip, headersFrom, MAX_HEADERS } from './chain-rpc.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';

const hex = (b) => Buffer.from(b).toString('hex');
const fromHex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

/** Headers read per refresh. A view is a window; the rule judges what is in it. */
export const BEACON_WINDOW = 64;
/** How often a held beacon is checked against the chain as it stands now (kanban #727): the window read again, past its tip. */
export const BEACON_RECHECK_MS = 30000;

/** Two rounds share an answer only if they ask the same question of the chain. */
const keyOf = (contract) => `${contract.committeeTimeMs}:${contract.censusConfirmations}`;

export function chainBeacon({ call, window = BEACON_WINDOW, recheckMs = BEACON_RECHECK_MS } = {}) {
  if (typeof call !== 'function') throw new Error('a chain beacon needs a way to ask a node');
  const held = new Map();
  // ONE READ IN FLIGHT PER QUESTION (2026-09-30, the testnet4 bitcoind flood): rounds that share a committee_time
  // share the read, instead of each reading 400 headers until the first answer lands.
  const reading = new Map();
  // AND ONE HEADER WINDOW FOR EVERY QUESTION (ORDER-2116, measured on the free pair 2026-10-01): a round asked about
  // before its beacon read 400 headers - 800 calls - on every ask, and ten rounds posted ahead held 46 RPC calls open per
  // node; their beacons were found minutes after their entry had closed. The window is read once and then extended by the
  // blocks past its tip; a first new header that does not link to the held tip (a reorganised chain) reads it whole.
  let win = null;
  let winRead = null;
  let lastCheck = 0;
  const extend = () => {
    if (winRead) return winRead;
    winRead = (async () => {
      const tip = Number(await call('getblockcount'));
      if (win && tip === win.tipHeight) return win;
      if (win && tip > win.tipHeight && tip - win.tipHeight < window) {
        const added = [];
        for (let h = win.tipHeight + 1; h <= tip; h++)
          added.push(fromHex(await call('getblockheader', [await call('getblockhash', [h]), false])));
        const last = win.headers[win.headers.length - 1];
        if (hex(added[0].subarray(4, 36)) === hex(blockHashOf(last))) {
          const headers = [...win.headers, ...added];
          const drop = Math.max(0, headers.length - window);
          win = { headers: headers.slice(drop), firstHeight: win.firstHeight + drop, tipHeight: tip };
          return win;
        }
      }
      win = await headersToTip(call, { count: window });
      return win;
    })().finally(() => { winRead = null; });
    return winRead;
  };

  const api = {
    /**
     * Read the chain and keep what the rule names, or keep nothing.
     *
     * Answers the same shape the rule does, so a caller can print the refusal
     * rather than discover later that it has no beacon.
     */
    async refresh(contract) {
      const key = keyOf(contract);
      if (held.has(key)) return { ok: true, ...held.get(key) };
      if (reading.has(key)) return reading.get(key);
      const read = (async () => {
        const view = await extend();
        let seen = beaconFromChain(contract, view);
        // A BEACON BEHIND THE WINDOW (measured on testnet4 2026-10-07): a seat started after its round's beacon
        // had sunk more than the window below the tip read "this view begins at height ... already after this round's
        // committee time" for good - no committee, no peer for the send plan, a settle retried forever. A tip window that
        // begins after committee_time cannot say which block is the first one; a range read forward from the round's
        // census height (which comes before committee_time) can, and names the same block every other view does.
        if (!seen.ok && Number.isInteger(contract.censusHeight) && view.firstHeight > contract.censusHeight) {
          const from = Math.max(0, contract.censusHeight - (MEDIAN_TIME_SPAN - 1));
          // up to the tip, at most one read's worth (2016 headers, two weeks of blocks); read once - a found beacon is held
          const back = await headersFrom(call, { from, count: Math.min(MAX_HEADERS, view.tipHeight - from + 1) });
          const again = beaconFromChain(contract, back);
          if (again.ok) seen = again;
        }
        if (seen.ok) held.set(key, seen);
        return seen;
      })().finally(() => reading.delete(key));
      reading.set(key, read);
      return read;
    },

    /** What this node holds for that round, or nothing at all. */
    for({ contract } = {}) {
      if (!contract) return undefined;
      const key = keyOf(contract);
      const seen = held.get(key);
      if (!seen) return undefined;
      // A HELD BEACON THE CHAIN LEFT (kanban #727, measured 2026-10-28 on public testnet4: an 11-block side branch 157901-157911 held
      // the seats' beacon 157904 eight deep, then lost; every seat kept drawing the afternoon grids' committees on the branch's block
      // while a page drew on the chain's, and refused every seating "which the draw did not draw"): the window, read again at most
      // every BEACON_RECHECK_MS, still holds the beacon's height - and a different block there drops the answer and reads it again
      if (Date.now() - lastCheck > recheckMs) { lastCheck = Date.now(); extend().catch(() => {}); }
      if (win && seen.height >= win.firstHeight && seen.height <= win.tipHeight) {
        const at = win.headers[seen.height - win.firstHeight];
        if (at && hex(blockHashOf(at)) !== hex(seen.hash)) {
          held.delete(key);
          api.refresh(contract).catch(() => {});
          return undefined;
        }
      }
      return { hash: seen.hash, height: seen.height, timeMs: seen.timeMs };
    },

    /** What is being held, for an operator who wants to see it. */
    get size() { return held.size; },
  };
  return api;
}
