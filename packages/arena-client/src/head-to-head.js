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

// EVERY SEAT ANSWER HERE IS READ UNDER A DEADLINE AND A SIZE CAP (kanban #2053, #1489 v1-refute-18-s3; the page copy of #1507 carryReveals,
// #1685/#1870 peer-body.js): a bare fetch + r.json() under Promise.all waited for every seat, and a browser fetch has no timeout - one
// seat answering 200 and trickling its body held revealsOfRound (and so index.html `reveals` and the RPS client's refresh) forever, and
// one streaming a huge body was buffered whole into the tab. A seat past the deadline or the cap now counts as silent.
export const H2H_SEAT_MS = 5000;
export const H2H_REVEALS_CAP = 65536 + 64 * 1024;   // 64 KiB + 1 KiB per entry for 64 entries; a head-to-head round holds two
const H2H_TEXT_CAP = 4096;                          // a POST /reveal refusal is one line

// The body of `r` as text, at most `cap` bytes (more throws), read chunk by chunk; a response without a stream (a test fetcher) is read
// whole by its own text()/json(), still under the caller's deadline.
async function cappedText(r, cap) {
  const reader = r && r.body && typeof r.body.getReader === 'function' ? r.body.getReader() : null;
  if (!reader) {
    if (typeof r.text === 'function') { const t = await r.text(); if (t.length > cap) throw new Error('answer too large'); return t; }
    return JSON.stringify(await r.json());
  }
  const parts = []; let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > cap) throw new Error('answer too large');
      parts.push(value);
    }
  } catch (e) { try { await reader.cancel(); } catch { /* gone */ } throw e; }
  const all = new Uint8Array(n); let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}

// `work(signal)` under `ms`: aborts the fetch it started and rejects at the deadline even if the fetcher ignores the signal.
function withDeadline(ms, work) {
  const ctl = new AbortController(); let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => { ctl.abort(new Error('seat too slow')); no(new Error('seat too slow')); }, ms); });
  return Promise.race([work(ctl.signal), late]).finally(() => clearTimeout(timer));
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
export async function revealMove({ entryIdHex, move, salt, nodes, identity = null, fetcher = fetch, timeoutMs = H2H_SEAT_MS }) {
  const body = JSON.stringify({ move, salt: salt instanceof Uint8Array ? h2hHex(salt) : String(salt), ...(identity ? { identity } : {}) });
  return Promise.all(nodes.map(async (node) => {
    try {
      return await withDeadline(timeoutMs, async (signal) => {
        const r = await fetcher(`${String(node).replace(/\/+$/, '')}/reveal?entry=${entryIdHex}`, { method: 'POST', body, signal });
        if (r.status === 200 || r.status === 201) { try { r.body && r.body.cancel && await r.body.cancel(); } catch { /* gone */ } return { node, status: r.status, why: null }; }
        let why = '';
        try { why = (await cappedText(r, H2H_TEXT_CAP)).trim(); } catch (e) { why = e.message; }
        return { node, status: r.status, why };
      });
    } catch (e) { return { node, status: 0, why: e.message }; }
  }));
}

/** Every reveal the round's seats hold, merged by entry: { [entryIdHex]: move }. */
// A MOVE COUNTS ONLY WHEN THE SEATS AGREE ON IT (kanban #1489): the merge was last-answer-wins, so one seat answering late with
// an opponent's move changed flipped the provisional verdict the page shows before any seat signs. Each seat now gives one
// vote per entry; an entry's move is the one at least two seats (or every seat, on a one-seat list) name, and more seats than
// name any other move. A tie, or a move only one seat of several names, leaves the entry undecided here.
export async function revealsOfRound({ roundIdHex, nodes, fetcher = fetch, timeoutMs = H2H_SEAT_MS }) {
  const votes = new Map();   // entry -> Map(move -> seats naming it)
  await Promise.all(nodes.map(async (node) => {
    try {
      const j = await withDeadline(timeoutMs, async (signal) => {
        const r = await fetcher(`${String(node).replace(/\/+$/, '')}/reveals?round=${roundIdHex}`, { signal });
        if (!r.ok) { try { r.body && r.body.cancel && await r.body.cancel(); } catch { /* gone */ } return null; }
        return JSON.parse(await cappedText(r, H2H_REVEALS_CAP));
      });
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

// kanban #1644 named the deadline H2H_SEAT_ASK_MS; #2053 is the same ask with a size cap read chunk by chunk
export const H2H_SEAT_ASK_MS = H2H_SEAT_MS;

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
export async function lockSetOfSeats({ roundIdHex, nodes, committee = null, verify = null, entryCloseMs, fetcher = fetch, timeoutMs = H2H_SEAT_MS }) {
  const said = await Promise.all(nodes.map(async (node) => {
    try {
      return await withDeadline(timeoutMs, async (signal) => {
        const r = await fetcher(`${String(node).replace(/\/+$/, '')}/lock-set?round=${roundIdHex}`, { signal, cache: 'no-store' });
        if (!r.ok) { try { r.body && r.body.cancel && await r.body.cancel(); } catch { /* gone */ } return null; }
        return JSON.parse(await cappedText(r, H2H_REVEALS_CAP));
      });
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
  fetcher = fetch, now = () => Date.now(), timeoutMs = H2H_SEAT_MS, onWait = null, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)) }) {
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
