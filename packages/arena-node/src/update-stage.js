// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// UPDATES STAGED PER FEDERATION (kanban #1093 part 3, the owner 2026-11-03: "An update reaches at most f guardians of one federation at a time.
// A guardian's updater waits while f of its federation's guardians already run the new version without a healthy hour behind them. ... A
// release with a fault then never reaches the threshold before it shows.").
//
// A guardian's seat answers its updater (GET /update-stage?version=V) from what its fellow guardians' seats say about themselves (GET
// /release): the release each runs and since when. A fellow on V for less than STAGE_HEALTHY_MS - or on V and not answering for its health -
// is still on trial. While f fellows are on trial nobody else updates. The ones still on the old release go one after the other in the order of
// their node keys, so two guardians that ask at the same moment never both take the last free place.
//
// A SILENT GUARDIAN HOLDS ITS PLACE (kanban #1169): a release that crashes or hangs its guardians makes them silent. Read as "not on trial",
// the first two of seven to update freed their places, the next one went, and fewer than five were left. Now:
//   - a fellow counts only by its own SIGNED answer to this ask (its node key over the answer and the nonce this seat sent, so an old answer
//     cannot be played back); a fellow that is silent, or answers unsigned, or in another node's name, is SILENT - and SILENT is on trial;
//   - the healthy hour is this seat's own: it keeps, per fellow, "seen healthy on V since t" (update_stage_seen), and a fellow is PROVEN
//     only once both that and the fellow's own start time lie an hour back. A silent or unhealthy reading starts its hour again.
// One enum (FELLOW), one transition function (fellowStep), and the go/wait answer (stageDecision) counts only those states.
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { utf8Encode } from '../../arena-protocol/src/utf8.js';

/** A healthy hour: a guardian on the new release this long, answering, no longer counts against the stage. */
export const STAGE_HEALTHY_MS = 3_600_000;

/** f of a federation of n guardians (n = 3f + 1, rounded down): 7 -> 2, 10 -> 3, 4 -> 1. */
export const faultsOf = (n) => Math.max(0, Math.floor((Number(n) - 1) / 3));

const hexOf = (k) => (k instanceof Uint8Array ? Buffer.from(k).toString('hex') : String(k || '')).toLowerCase();

/** What this seat knows of one fellow guardian, for one release V (kanban #1169). */
export const FELLOW = Object.freeze({
  SILENT: 'silent',         // no signed answer to this ask: on trial (it may be down on V)
  ELSEWHERE: 'elsewhere',   // its signed answer: another release (it still has to update; it waits in node-key order)
  TRIAL: 'trial',           // its signed answer: on V, not yet a healthy hour behind it as this seat saw it
  PROVEN: 'proven',         // its signed answer: on V, healthy, an hour behind it as this seat saw it and as it says
});
/** The states that hold a place on trial. */
export const ON_TRIAL = Object.freeze([FELLOW.SILENT, FELLOW.TRIAL]);

/** THE SIGNED RELEASE ANSWER (kanban #1169): what a seat signs with its node key in GET /release?nonce=. */
export const RELEASE_ANSWER_TAG = 'ARENA/v1/ReleaseAnswer';
export const releaseAnswerDigest = (a) => taggedHash(RELEASE_ANSWER_TAG, utf8Encode(JSON.stringify([
  hexOf(a.node), String(a.version ?? ''), String(a.commit ?? ''), Number(a.startedAtMs) || 0, a.healthy !== false, String(a.nonce || ''), Number(a.atMs) || 0])));
/** The answer, signed: `sign(digest)` answers 64 bytes. */
export const signReleaseAnswer = (a, sign) => ({ ...a, node: hexOf(a.node), healthy: a.healthy !== false, signature: toHex(sign(releaseAnswerDigest(a))) });
/** A fellow's answer counts only as its own signed word over this ask's nonce. Answers the answer, or null. */
export function verifiedAnswer(a, { node, nonce, verify }) {
  if (!a || typeof a !== 'object' || typeof verify !== 'function' || !nonce) return null;
  if (hexOf(a.node) !== hexOf(node) || String(a.nonce || '') !== String(nonce) || !/^[0-9a-f]{128}$/i.test(String(a.signature || ''))) return null;
  if (typeof a.version !== 'string' || !a.version) return null;
  let ok = false; try { ok = !!verify(fromHex(String(a.signature).toLowerCase()), releaseAnswerDigest(a), fromHex(hexOf(node))); } catch { ok = false; }
  return ok ? a : null;
}

/**
 * THE ONE TRANSITION (kanban #1169): a fellow's state for release `version` from this seat's kept row `prev` ({ version, sinceMs } or null:
 * "seen healthy on that release since") and this ask's `reading` (its verified answer, or null). Answers { state, row }: `row` is what is
 * kept from now on (null: nothing - the hour starts again at the next healthy reading).
 */
export function fellowStep({ prev = null, reading = null, version, nowMs }) {
  if (!reading) return { state: FELLOW.SILENT, row: null };
  if (reading.version !== version) return { state: FELLOW.ELSEWHERE, row: null };
  if (reading.healthy === false) return { state: FELLOW.TRIAL, row: null };
  const sinceMs = prev && prev.version === version && Number(prev.sinceMs) > 0 && Number(prev.sinceMs) <= nowMs ? Number(prev.sinceMs) : nowMs;
  const own = Number(reading.startedAtMs) > 0 ? Number(reading.startedAtMs) : nowMs;   // its own word can only make the hour later
  const proven = nowMs - Math.max(sinceMs, own) >= STAGE_HEALTHY_MS;
  return { state: proven ? FELLOW.PROVEN : FELLOW.TRIAL, row: { version, sinceMs } };
}

/**
 * Whether this guardian may take release `version` now.
 *  `self`     this guardian's node key (hex or bytes)
 *  `members`  every guardian node key of its federation, itself included
 *  `answers`  Map(node key hex -> its GET /release?nonce= answer | null)
 *  `nonce`    the nonce this ask sent; `verify(sig, msg, pubkey)` schnorr: an answer counts only signed by its node over that nonce
 *  `seen`     Map(node key hex -> { version, sinceMs }): this seat's kept rows (update_stage_seen)
 * Answers { go, onTrial, f, waitingBefore, why, fellows: Map(key -> FELLOW), rows: Map(key -> row | null) } - `rows` to be kept.
 */
export function stageDecision({ version, self, members, answers, nonce = null, verify = null, seen = new Map(), nowMs = Date.now() }) {
  const me = hexOf(self);
  const keys = [...new Set((members || []).map(hexOf))].filter(Boolean);
  if (!keys.includes(me)) return { go: true, onTrial: 0, f: 0, waitingBefore: 0, why: 'not a guardian of a federation here: nothing to stage', fellows: new Map(), rows: new Map() };
  const f = faultsOf(keys.length);
  const fellows = new Map(), rows = new Map();
  for (const k of keys) {
    if (k === me) continue;
    const raw = answers instanceof Map ? answers.get(k) : null;
    const reading = verifiedAnswer(raw, { node: k, nonce, verify });
    const step = fellowStep({ prev: seen instanceof Map ? seen.get(k) || null : null, reading, version, nowMs });
    fellows.set(k, step.state); rows.set(k, step.row);
  }
  const silent = [...fellows.values()].filter((s) => s === FELLOW.SILENT).length;
  const onTrial = [...fellows.values()].filter((s) => ON_TRIAL.includes(s)).length;
  // the ones still to update, this one included, in node-key order: those before it go first
  const waiting = [me, ...[...fellows].filter(([, s]) => s === FELLOW.ELSEWHERE).map(([k]) => k)].sort();
  const waitingBefore = waiting.indexOf(me);
  const silentWhy = silent ? ` (${silent} of them silent or unsigned: a guardian that does not answer may be down on ${version})` : '';
  if (f === 0) return { go: onTrial === 0 && waitingBefore === 0, onTrial, f, waitingBefore, fellows, rows,
    why: onTrial || waitingBefore ? `one guardian at a time in a federation of ${keys.length}${silentWhy}` : 'go' };
  const go = onTrial + waitingBefore < f;
  return { go, onTrial, f, waitingBefore, fellows, rows,
    why: go ? `go: ${onTrial} of ${f} places on trial taken${waitingBefore ? `, ${waitingBefore} before this one` : ''}`
      : `wait: ${onTrial} guardian(s) of ${keys.length} on trial for ${version}${silentWhy}${waitingBefore ? ` and ${waitingBefore} go before this one` : ''}; at most ${f} at a time` };
}

/** THIS SEAT'S OWN CLOCK PER FELLOW (kanban #1169): "seen healthy on V since t", kept in the node's store across restarts. */
export function createStageBook(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS update_stage_seen (node TEXT PRIMARY KEY, version TEXT NOT NULL, since_ms INTEGER NOT NULL)`);
  return {
    read: (keys) => {
      const out = new Map(), q = db.prepare('SELECT version, since_ms FROM update_stage_seen WHERE node = ?');
      for (const k of keys || []) { const r = q.get(hexOf(k)); if (r) out.set(hexOf(k), { version: r.version, sinceMs: Number(r.since_ms) }); }
      return out;
    },
    // `version` the release this decision was asked for (kanban #1377, audit 2 #1204 INSTALLER-DOORS-8): a fellow found elsewhere, silent or unhealthy
    // clears only its row of THAT release - an ask naming another release (anyone's GET /update-stage?version=x) never resets its hour on the real one
    write: (rows, version = null) => {
      const put = db.prepare('INSERT INTO update_stage_seen (node, version, since_ms) VALUES (?, ?, ?) ON CONFLICT(node) DO UPDATE SET version = excluded.version, since_ms = excluded.since_ms');
      const del = version === null ? db.prepare('DELETE FROM update_stage_seen WHERE node = ?') : db.prepare('DELETE FROM update_stage_seen WHERE node = ? AND version = ?');
      for (const [k, row] of rows || []) { if (row) put.run(hexOf(k), String(row.version), Number(row.sinceMs)); else if (version === null) del.run(hexOf(k)); else del.run(hexOf(k), String(version)); }
    },
  };
}
