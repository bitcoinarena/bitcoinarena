// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HEAD-TO-HEAD ROUND, FROM THE PAGE: the player's hidden move, its reveal to the round's seats after entry
// close, and the reveals the seats hold - for any head-to-head game; which moves a game has, and what beats what, are the
// game's own (its client and its decide adapter). The commitment is the protocol's (arena-protocol head-to-head.js); the
// entry itself is built and handed over as a market pick's is (join.js entryFor, market.js submitPick), with `commit` set.
import { headToHeadCommit } from '../../arena-protocol/src/head-to-head.js';
import { lockSetCertificateStands, LOCK_SET_WINDOW_MS } from '../../arena-protocol/src/lock-set.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';

const h2hHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// EVERY SEAT ASK HAS A DEADLINE (kanban #1644): revealsOfRound and revealMove waited on each seat with no signal and read its body
// with no limit, all in one Promise.all - one seat that never answered, or never ended its body, held the call forever, and the
// RPS client's refresh() (behind its `refreshing` flag) never ran again on that tab. Each ask now carries an abort signal and the
// whole ask (headers and body) races a timer; a seat past it counts as down, as one that refused. The body is capped in size.
export const H2H_SEAT_ASK_MS = 4000;
const H2H_BODY_MAX = 1 << 20;   // 1 MiB: far above any round's reveals
function h2hAsk(work, ms) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  let t;
  const late = new Promise((_, rej) => { t = setTimeout(() => { try { ctl?.abort(); } catch { /* */ } rej(new Error('seat timed out')); }, ms); });
  return Promise.race([work(ctl?.signal), late]).finally(() => clearTimeout(t));
}
async function h2hJson(r) {
  if (typeof r.text !== 'function') return r.json();
  const len = Number(r.headers?.get?.('content-length'));
  if (len > H2H_BODY_MAX) throw new Error('reveals body too large');
  const txt = await r.text();
  if (txt.length > H2H_BODY_MAX) throw new Error('reveals body too large');
  return JSON.parse(txt);
}

/** A move and a fresh 32-byte salt to hide it with; `random(n)` is the page's CSPRNG. */
export function hiddenMove(move, random) {
  if (!Number.isInteger(move) || move < 0 || move > 255) throw new Error('a move is a byte');
  return { move, salt: random(32) };
}

/** The commitment an entry into `roundId` under session key `sessionPubkey` names for that hidden move. */
export function moveCommitment({ roundId, sessionPubkey, move, salt }) {
  return headToHeadCommit({ roundId, entryKey: sessionPubkey, move, salt });
}

/** The reveal to every seat: POST /reveal?entry= { move, salt }. Answers each seat's status. */
// `identity`: { key, sig } (identity.js identityProofFor) - the tab's identity on this entry, for a score across rounds
export async function revealMove({ entryIdHex, move, salt, nodes, identity = null, fetcher = fetch, timeoutMs = H2H_SEAT_ASK_MS }) {
  const body = JSON.stringify({ move, salt: salt instanceof Uint8Array ? h2hHex(salt) : String(salt), ...(identity ? { identity } : {}) });
  return Promise.all(nodes.map(async (node) => {
    try {
      return await h2hAsk(async (signal) => {
        const r = await fetcher(`${String(node).replace(/\/+$/, '')}/reveal?entry=${entryIdHex}`, { method: 'POST', body, signal });
        return { node, status: r.status, why: r.status === 200 || r.status === 201 ? null : String(await r.text()).trim().slice(0, 500) };
      }, timeoutMs);
    } catch (e) { return { node, status: 0, why: e.message }; }
  }));
}

/** Every reveal the round's seats hold, merged by entry: { [entryIdHex]: move }. */
// A MOVE COUNTS ONLY WHEN THE SEATS AGREE ON IT (kanban #1489): the merge was last-answer-wins, so one seat answering late with
// an opponent's move changed flipped the provisional verdict the page shows before any seat signs. Each seat now gives one
// vote per entry; an entry's move is the one at least two seats (or every seat, on a one-seat list) name, and more seats than
// name any other move. A tie, or a move only one seat of several names, leaves the entry undecided here.
export async function revealsOfRound({ roundIdHex, nodes, fetcher = fetch, timeoutMs = H2H_SEAT_ASK_MS }) {
  const votes = new Map();   // entry -> Map(move -> seats naming it)
  await Promise.all(nodes.map(async (node) => {
    try {
      const j = await h2hAsk(async (signal) => {
        const r = await fetcher(`${String(node).replace(/\/+$/, '')}/reveals?round=${roundIdHex}`, { signal });
        return r.ok ? h2hJson(r) : null;
      }, timeoutMs);
      if (j == null) return;
      const mine = new Map();   // this seat's one move per entry: the first it lists
      for (const x of (j && Array.isArray(j.reveals) ? j.reveals : [])) {
        if (Number.isInteger(x.move) && typeof x.entry === 'string' && !mine.has(x.entry)) mine.set(x.entry, x.move);
      }
      for (const [entry, move] of mine) {
        if (!votes.has(entry)) votes.set(entry, new Map());
        const m = votes.get(entry); m.set(move, (m.get(move) || 0) + 1);
      }
    } catch { /* a seat that is down says nothing */ }
  }));
  const need = Math.min(2, nodes.length);
  const out = {};
  for (const [entry, m] of votes) {
    const ranked = [...m].sort((a, b) => b[1] - a[1]);
    if (ranked[0][1] >= need && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) out[entry] = ranked[0][0];
  }
  return out;
}

// THE CERTIFIED LOCK SET (protocol 28, kanban #2561, ruling #2116 (b)): in a paying head-to-head round of protocol 28 no seat takes a reveal
// before the round's committee has certified, at its threshold, the set of entries whose stake it saw locked before the close - and the
// page reveals only once it has seen that certificate itself. Without one by the close + 3 s the round is VOID: every stake comes back.
export const H2H_LOCK_SET_POLL_MS = 150;
const h2hFromHex = (h) => Uint8Array.from(String(h).match(/../g) || [], (x) => parseInt(x, 16));

/**
 * What the round's seats say of its lock set, once: { required (true / false / null: nobody answered), certified: { entries, atMs } | null,
 * void }. A certificate counts only if it stands against `committee` (hex keys, the round's seats the page dealt its stake to) under
 * `verify` (BIP-340); without a committee, only one at least two seats serve with the same entries (one seat on a one-seat list).
 */
export async function lockSetOfSeats({ roundIdHex, nodes, committee = null, verify = null, entryCloseMs, fetcher = fetch, timeoutMs = H2H_SEAT_ASK_MS }) {
  const said = await Promise.all(nodes.map(async (node) => {
    try {
      return await h2hAsk(async (signal) => {
        const r = await fetcher(`${String(node).replace(/\/+$/, '')}/lock-set?round=${roundIdHex}`, { signal, cache: 'no-store' });
        if (!r.ok) { try { r.body && r.body.cancel && await r.body.cancel(); } catch { /* gone */ } return null; }
        return h2hJson(r);
      }, timeoutMs);
    } catch { return null; }
  }));
  const answered = said.filter((x) => x && typeof x === 'object');
  if (!answered.length) return { required: null, certified: null, void: false };
  if (!answered.some((x) => x.required === true)) return { required: false, certified: null, void: false };
  let certified = null;
  const byEntries = new Map();
  for (const x of answered) {
    if (!x.certificate || !/^[0-9a-f]+$/.test(String(x.certificate))) continue;
    if (committee && committee.length && typeof verify === 'function') {
      const st = lockSetCertificateStands(h2hFromHex(x.certificate), { roundId: h2hFromHex(roundIdHex), committee, threshold: receiptsNeeded(committee.length),
        entryCloseMs: BigInt(entryCloseMs), verify });
      if (st.ok) { certified = { entries: st.entries, atMs: st.atMs }; break; }
    } else if (Array.isArray(x.entries)) {
      const k = [...x.entries].sort().join(',');
      byEntries.set(k, (byEntries.get(k) || 0) + 1);
      if (byEntries.get(k) >= Math.min(2, nodes.length)) { certified = { entries: [...x.entries].sort(), atMs: Number(x.certifiedAtMs) || null }; break; }
    }
  }
  return { required: true, certified, void: !certified && answered.some((x) => x.void === true) };
}

/**
 * REVEAL ONCE THE LOCK SET IS CERTIFIED (the page's reveal in a round of protocol 28; a round below it is revealed at once, as before).
 * Asks the seats every H2H_LOCK_SET_POLL_MS; `onWait(state)` is told 'certifying' while it waits. Answers revealMove's seats with
 * { certified }, or { void: true } / { notCertified: true } with why - never a reveal before a certificate this page checked.
 */
export async function revealWhenCertified({ roundIdHex, entryIdHex, move, salt, nodes, identity = null, committee = null, verify = null, entryCloseMs,
  fetcher = fetch, now = () => Date.now(), timeoutMs = H2H_SEAT_ASK_MS, onWait = null, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)) }) {
  const giveUpAt = Number(entryCloseMs) + LOCK_SET_WINDOW_MS + 6000;
  for (;;) {
    const got = await lockSetOfSeats({ roundIdHex, nodes, committee, verify, entryCloseMs, fetcher, timeoutMs });
    if (got.required === false) return { seats: await revealMove({ entryIdHex, move, salt, nodes, identity, fetcher, timeoutMs }), certified: null };
    if (got.certified) {
      if (!got.certified.entries.includes(String(entryIdHex))) return { seats: [], notCertified: true, why: 'your entry is not in the round\'s certified lock set: it is not played, its stake comes back' };
      return { seats: await revealMove({ entryIdHex, move, salt, nodes, identity, fetcher, timeoutMs }), certified: got.certified };
    }
    if (got.void || now() > giveUpAt) return { seats: [], void: true, why: 'the round\'s lock set was not certified by its close + 3 s: the round is VOID, every stake comes back' };
    if (onWait) { try { onWait('certifying'); } catch { /* the page's own */ } }
    await sleep(H2H_LOCK_SET_POLL_MS);
  }
}
