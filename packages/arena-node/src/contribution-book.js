// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S BOOK OF COUNTED ROUNDS FOR THE CONTRIBUTION AGREEMENTS (spec §27A.4.2, kanban #1346).
//
// His share at a round's census height is read from facts every seat holds: the rounds that COUNT (kanban #1218), as their own seats signed
// their accounts (#1153, protocol mergeSignedSeasonAccounts - a round counts with one account signed by the threshold of its own draw, as this
// seat draws it). This book keeps them:
//
//   READ     `refresh()` asks every seat's GET /season-rounds for a window (the caller's `accountsFor(window)`), merges the signed accounts
//            and keeps every counted round it did not hold yet: round id, census height, entries - append-only, a kept round never changes.
//   LAG      the share at height H reads only rounds whose census height is at most H - the network's lag (288; regtest 6, #1349): a round is settled and its
//            account signed hours after its census, and by two days every seat has read it. So two seats holding the same counted rounds
//            answer the same share at every height, and the page takes a share only where a majority of the round's seats agree.
//   SHARE    `shareAt(agreement, height, network, { leftAt, terminatedAt })` -> protocol contributionShare over the book's facts.
import { contributionShare, contributionProgress, factsFromSeasonRounds, contributionAgreementId, contributionScaleOf } from '../../arena-protocol/src/contribution.js';
import { toHex } from '../../arena-protocol/src/hash.js';

/** The share at H reads rounds with census height <= H - this (288 blocks, ~2 days, on mainnet and testnet4; 6 on regtest and a devnet, kanban #1349). */
export const CONTRIBUTION_LAG_BLOCKS = 288;
export const contributionLagOf = (network) => contributionScaleOf(network).lagBlocks;

export const CONTRIBUTION_BOOK_SQL = `CREATE TABLE IF NOT EXISTS contribution_rounds (round_id TEXT PRIMARY KEY, census_height INTEGER NOT NULL,
  round TEXT NOT NULL, kept_ms INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS contribution_ends (agreement_id TEXT NOT NULL, kind TEXT NOT NULL, at_height INTEGER NOT NULL, hex TEXT NOT NULL,
    PRIMARY KEY (agreement_id, kind));
  CREATE INDEX IF NOT EXISTS contribution_rounds_h ON contribution_rounds (census_height)`;

const big = (_k, v) => (typeof v === 'bigint' ? { big: String(v) } : v);
const unbig = (_k, v) => (v && typeof v === 'object' && typeof v.big === 'string' && Object.keys(v).length === 1 ? BigInt(v.big) : v);

/**
 * `db` node:sqlite. `accountsFor(window)` -> the merged signed season (mergeSignedSeasonAccounts' answer: { ok, rounds, evidence }) for
 * the window { fromMs, toMs }; `heightOf(contractHex)` -> its census height or null. `now()` ms.
 */
export function createContributionBook({ db, accountsFor, heightOf, now = () => Date.now() }) {
  db.exec(CONTRIBUTION_BOOK_SQL);
  const put = db.prepare('INSERT OR IGNORE INTO contribution_rounds (round_id, census_height, round, kept_ms) VALUES (?, ?, ?, ?)');

  /** Keep the counted rounds of `merged` (mergeSignedSeasonAccounts' answer) not held yet. Answers how many were new. */
  function keep(merged) {
    if (!merged || !merged.ok) return 0;
    const contractOf = new Map((merged.evidence || []).map((e) => [String(e.roundId).toLowerCase(), e.contract]));
    let n = 0;
    for (const r of merged.rounds || []) {
      const rid = String(r.roundId).toLowerCase();
      const c = contractOf.get(rid);
      const h = c ? heightOf(c) : null;
      if (!Number.isInteger(h)) continue;
      const got = put.run(rid, h, JSON.stringify(r, big), now());
      if (got.changes) n += 1;
    }
    return n;
  }

  /** Read the window from every seat and keep its counted rounds. */
  async function refresh(window) {
    const merged = await accountsFor(window);
    return { kept: keep(merged), counted: merged && merged.ok ? (merged.rounds || []).length : 0, why: merged && !merged.ok ? merged.why : null };
  }

  /** The facts for a share at `height`: the kept rounds with census height <= height - CONTRIBUTION_LAG_BLOCKS. */
  function factsAt(height, network = 'mainnet') {
    const rows = db.prepare('SELECT round_id, census_height, round FROM contribution_rounds WHERE census_height <= ? ORDER BY round_id').all(Number(height) - contributionLagOf(network));
    const heights = new Map(rows.map((x) => [x.round_id, Number(x.census_height)]));
    return factsFromSeasonRounds(rows.map((x) => JSON.parse(x.round, unbig)), (rid) => heights.get(rid) ?? null);
  }

  /**
   * A LEAVE OR A TERMINATION, its signature already checked by the caller (his key; the cold admin key): kept once per agreement and kind, the
   * first one standing - a later one of the same kind changes nothing. Answers { ok, fresh }.
   */
  function addEnd(kind, { agreementId, atHeight }, hex) {
    if (kind !== 'leave' && kind !== 'termination') return { ok: false, why: 'a leave or a termination' };
    const got = db.prepare('INSERT OR IGNORE INTO contribution_ends (agreement_id, kind, at_height, hex) VALUES (?, ?, ?, ?)').run(toHex(agreementId), kind, Number(atHeight), String(hex));
    return { ok: true, fresh: got.changes > 0 };
  }
  /** The agreement's leave and termination heights held here: { leftAt, terminatedAt } (null: none). */
  function endsOf(agreementIdHex) {
    const out = { leftAt: null, terminatedAt: null };
    for (const r of db.prepare('SELECT kind, at_height FROM contribution_ends WHERE agreement_id = ?').all(String(agreementIdHex).toLowerCase()))
      out[r.kind === 'leave' ? 'leftAt' : 'terminatedAt'] = Number(r.at_height);
    return out;
  }

  /** His share at `height` (protocol contributionShare), and the agreement's id; his leave and termination as held here unless given. */
  function shareAt(agreement, height, network, ends = null, { main = network === 'mainnet' } = {}) {
    const { leftAt, terminatedAt } = ends || endsOf(toHex(contributionAgreementId(agreement)));
    const s = contributionShare(agreement, { facts: factsAt(height, network), height, network, main, leftAt, terminatedAt });
    const facts = factsAt(height, network);
    return { agreementId: toHex(contributionAgreementId(agreement)), height: Number(height), ...s, ends: { leftAt, terminatedAt },
      progress: contributionProgress(agreement, { facts, height: Number(height) - contributionLagOf(network), network }) };
  }

  const held = () => db.prepare('SELECT COUNT(*) n, MAX(census_height) top FROM contribution_rounds').get();
  const ends = () => db.prepare('SELECT agreement_id, kind, at_height, hex FROM contribution_ends ORDER BY agreement_id, kind').all();
  return { keep, refresh, factsAt, shareAt, held, addEnd, endsOf, ends };
}
