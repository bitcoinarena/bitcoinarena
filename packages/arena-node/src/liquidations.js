// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HALTED FEDERATION'S LIQUIDATION, AS EVERY SEAT MIRRORS IT (spec §23A.5 steps 1-2, RULED 2026-09-21):
// "every seat mirrors them at GET /liquidations". For each federation whose record this seat holds HALTED: the halt height and
// the signed HALTED record it is read from, the liquidation clocks from it (liquidates after abandon_blocks, the claim window,
// the late-claim tail), and the guardians' signed copies of its spent-note set - the newest session wins (spent-set.js).
//
// A seat takes a copy (POST /liquidations/spent-set) only for a federation it holds HALTED, only one that stands against that
// record, and keeps per guardian its newest session. The claim endpoints are the arbitration set's (§5A.3B, liquidation-claims.js);
// a seat names where they are (ARENA_LIQUIDATION_CLAIMS).
import { decodeSpentSet, spentSetStands, newestSpentSet, encodeSpentSet } from '../../arena-protocol/src/spent-set.js';
import { liquidationSchedule } from '../../arena-protocol/src/federation-slash.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

// A HALT FROM EITHER SOURCE (spec §23A.5 "How a halt is proven", RULED 2026-10-14): a signed HALTED record, as before, or the seats'
// halt proof (halts.js) - the one a federation that lost 2f + 1 actually has. The record's halt counts first when both exist.
export function createLiquidations({ records, clocks, verify, claimsUrl = null, halts = null }) {
  const haltOf = (fid) => records.haltOf(fid) || (halts ? halts.haltOf(fid) : null);
  const haltedFederations = () => [...new Set([...records.haltedFederations(), ...(halts ? halts.haltedFederations() : [])])];
  const copies = new Map();                  // federation id hex -> Map(signer hex -> copy)

  /** Takes one guardian's signed copy, `{ spentSet: hex, signature: hex }`; answers { ok, kept } or why not. */
  function offer(said) {
    let c;
    try { c = { ...decodeSpentSet(fromHex(String(said.spentSet || ''))), signature: fromHex(String(said.signature || '')) }; } catch (e) { return { ok: false, why: e.message }; }
    const fid = toHex(c.federationId);
    const held = records.recordOf(fid);
    if (!held) return { ok: false, why: 'this seat holds no record of that federation' };
    if (!haltOf(fid)) return { ok: false, why: `that federation is ${held.status} here, and no halt proof stands: nothing is liquidated` };
    const st = spentSetStands(c, { record: held.record, verify });
    if (!st.ok) return st;
    const mine = copies.get(fid) || new Map(); copies.set(fid, mine);
    const had = mine.get(toHex(c.signer));
    if (had && had.session >= c.session) return { ok: true, kept: false, why: `that guardian's copy of session ${had.session} is held already` };
    mine.set(toHex(c.signer), c);
    return { ok: true, kept: true, session: c.session };
  }

  function list() {
    return haltedFederations().map((fid) => {
      const halt = haltOf(fid); const held = records.recordOf(fid);
      const when = liquidationSchedule({ haltHeight: halt.height, clocks });
      const all = [...(copies.get(fid) || new Map()).values()];
      // a copy is checked again against the record held now - a guardian the newest record no longer lists does not count
      const pick = held ? newestSpentSet(all, { record: held.record, verify }) : { copy: null, why: 'no record held' };
      return {
        federation: fid, haltHeight: halt.height, haltRecord: halt.bytes ? toHex(halt.bytes) : null,
        // THE RECORD HELD, signed (kanban #326 rehearsal 17): a halt PROVEN by the seats has no HALTED record (a federation that lost
        // 2f + 1 signs none), and the remainder's payees leave out the federation's guardians - read from this
        record: held && held.bytes ? toHex(held.bytes) : null,
        haltProof: halt.proof ? { session: halt.proof.session, observers: halt.proof.observers, abandoned: halt.proof.abandoned.map(toHex), id: toHex(halt.proof.id) } : null,
        // WHERE CLAIMS GO (§23A.5 step 2: "advertises where claims go ... every seat mirrors them"): the arbitration set's door
        claims: claimsUrl,
        liquidatesAt: halt.height + clocks.abandonBlocks,
        claimWindowCloses: when.claimWindowCloses, lateClaimsUntil: when.lateClaimsUntil, remainderSplitsAt: when.remainderSplitsAt,
        spentSet: pick.copy ? { session: pick.session, signers: pick.signers, disagree: pick.disagree, nonces: pick.copy.nonces.length,
          copies: all.filter((c) => c.session === pick.session).map((c) => ({ spentSet: toHex(encodeSpentSet(c)), signature: toHex(c.signature) })) }
          : null,
        ...(pick.copy ? {} : { why: pick.why }),
      };
    });
  }
  return { offer, list };
}
