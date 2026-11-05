// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GATE OF PROTOCOL 27, CACHED PER FEDERATION (kanban #1044 B1, ruling #1134 1): from NAMED_CLAIM_HEIGHT a seat neither opens, lists nor enters
// a protocol-27 round in a federation whose LNv2 module a threshold of its guardians does not report at >= 1.100. The read is the federation's
// own (stake-lock arena-version: request_current_consensus, a threshold of identical answers); a version never goes down, so a "yes" is kept for
// good, and a "no" or no answer is asked again after `againMs`. A federation not asked yet is refused while it is asked, in the background, as the
// reserve-key gate does: a lock in it could not be taken until the answer is in.
import { namedClaims, runsArenaLock, NAMED_CLAIM_VERSION } from '../../arena-protocol/src/arena-lock.js';

const why = (v) => `this round locks to an Arena lock (protocol ${NAMED_CLAIM_VERSION}) and its federation does not run it: LNv2 module version ${v && Number.isInteger(v.major) ? `${v.major}.${v.minor}` : 'no threshold answer'}, needs 1.100 from a threshold of its guardians`;

export class NamedClaimGate {
  constructor({ versionOf, now = () => Date.now(), againMs = 60000, pointOf } = {}) {
    this.versionOf = versionOf; this.now = now; this.againMs = againMs; this.pointOf = pointOf;
    this.yes = new Set(); this.no = new Map(); this.asking = new Map();
  }
  /** Ask the federation `fid` (hex) now, unless a yes is kept or an answer is in flight. Resolves to the version or null. */
  ask(fid) {
    if (this.yes.has(fid)) return Promise.resolve({ major: 1, minor: 100 });
    if (this.asking.has(fid)) return this.asking.get(fid);
    const p = Promise.resolve().then(() => this.versionOf(fid)).then((v) => v, () => null).then((v) => {
      this.asking.delete(fid);
      if (runsArenaLock(v)) { this.yes.add(fid); this.no.delete(fid); } else this.no.set(fid, { atMs: this.now(), version: v });
      return v;
    });
    this.asking.set(fid, p);
    return p;
  }
  /** The refusal for a round in federation `fid`, or null; never waits. */
  refusal(contract, fid) {
    if (!namedClaims(contract, this.pointOf)) return null;
    if (this.yes.has(fid)) return null;
    const seen = this.no.get(fid);
    if (!seen || this.now() - seen.atMs >= this.againMs) this.ask(fid);
    const version = seen ? seen.version : null;
    return why(version) + (seen ? '' : ' (asked now; it opens here once a threshold of its guardians answers 1.100)');
  }
  /** The same, waited for: for a lock being taken now, which must not be refused only because nobody asked yet. */
  async refusalNow(contract, fid) {
    if (!namedClaims(contract, this.pointOf)) return null;
    if (this.yes.has(fid)) return null;
    const v = await this.ask(fid);
    return runsArenaLock(v) ? null : why(v);
  }
}
