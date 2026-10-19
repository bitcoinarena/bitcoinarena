// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HEAD-TO-HEAD ROUND, FROM THE PAGE (kanban #233): the player's hidden move, its reveal to the round's seats after entry
// close, and the reveals the seats hold - for any head-to-head game; which moves a game has, and what beats what, are the
// game's own (its client and its decide adapter). The commitment is the protocol's (arena-protocol head-to-head.js); the
// entry itself is built and handed over as a market pick's is (join.js entryFor, market.js submitPick), with `commit` set.
import { headToHeadCommit } from '../../arena-protocol/src/head-to-head.js';

const h2hHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

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
// `identity`: { key, sig } (identity.js identityProofFor, kanban #280) - the tab's identity on this entry, for a score across rounds
export async function revealMove({ entryIdHex, move, salt, nodes, identity = null, fetcher = fetch }) {
  const body = JSON.stringify({ move, salt: salt instanceof Uint8Array ? h2hHex(salt) : String(salt), ...(identity ? { identity } : {}) });
  return Promise.all(nodes.map(async (node) => {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/reveal?entry=${entryIdHex}`, { method: 'POST', body });
      return { node, status: r.status, why: r.status === 200 || r.status === 201 ? null : (await r.text()).trim() };
    } catch (e) { return { node, status: 0, why: e.message }; }
  }));
}

/** Every reveal the round's seats hold, merged by entry: { [entryIdHex]: move }. */
export async function revealsOfRound({ roundIdHex, nodes, fetcher = fetch }) {
  const out = {};
  await Promise.all(nodes.map(async (node) => {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/reveals?round=${roundIdHex}`);
      if (!r.ok) return;
      const j = await r.json();
      for (const x of (j && Array.isArray(j.reveals) ? j.reveals : [])) if (Number.isInteger(x.move)) out[x.entry] = x.move;
    } catch { /* a seat that is down says nothing */ }
  }));
  return out;
}
