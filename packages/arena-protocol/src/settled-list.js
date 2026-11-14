// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S GET /settled ANSWER, SIGNED BY ITS NODE KEY (kanban #2108, #2123; decided 2026-11-14: "/settled signed by the census key").
// The owed scan (arena-client page-lock.js findOwedRounds) counted a seat by its site: the live federation's seats share one host, so
// they tied with liar domains (#2108) and shared one 500-id allowance between them (#2123). Now each answer names its node and is
// signed by that node's key over this digest; the page counts only signed answers, one allowance per node key, and - given the census
// it checked - only keys that census bonds. Nothing here is consensus: the digest binds the answer's fields as sent, all as strings.
import { taggedHash } from './hash.js';

export const TAG_SETTLED_LIST = 'ARENA/v1/SettledList';

const str = (v) => (v === undefined || v === null ? '' : String(v));
const strs = (l) => (Array.isArray(l) ? l.map(str) : []);

/** The digest a seat signs over its /settled answer: { node, since, rounds: [{ id, state, madeMs, payouts, refunds }] }. */
export function settledListDigest({ node, since, rounds }) {
  const body = JSON.stringify([str(node).toLowerCase(), str(since),
    (Array.isArray(rounds) ? rounds : []).map((r) => [str(r && r.id), str(r && r.state), str(r && r.madeMs), strs(r && r.payouts), strs(r && r.refunds)])]);
  return taggedHash(TAG_SETTLED_LIST, new TextEncoder().encode(body));
}
