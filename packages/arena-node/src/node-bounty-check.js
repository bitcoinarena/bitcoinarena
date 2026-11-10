// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE BOUNTY'S CHECKLIST (kanban #1342, Daniel 2026-11-08): "the conditions as a checklist that fills in live from the census for the reporter's npub
// (in census, bonded, online 7 days, committees and signed rounds, owner key = your npub)". Read from the seats' public doors only, so it works for a
// node on any release:
//   owner       the node's own GET /owner (its claimed owner key) - found among the seats GET /network-games lists
//   committees  every seat's GET /served?finals=1 for each of the last 7 UTC days: the rounds whose committee names the node, and those it signed FINAL
//   in census   a node drawn into a committee is a bonded census node (only those are drawn); the days it served are its days online
// Answers { ok, node, checks: [{ key, label, ok, says }], passes } - `passes` only when every check holds. Team nodes are refused by `excluded`.
import { splitSignedFinalSig, decodeFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ownerStatementMessage } from './owner.js';

// a node's owner statement counts only signed by that node and at most this old (kanban #1418)
export const OWNER_STATEMENT_MAX_AGE_MS = 24 * 3600 * 1000;

const DAY_MS = 24 * 3600 * 1000;
// a held FINAL (hex of its signed bytes) -> its signer's node key hex; a key given as such is taken as it is (a test's)
const signerOf = (f) => {
  const h = String(f).toLowerCase();
  if (/^[0-9a-f]{64}$/.test(h)) return h;
  try { const bytes = fromHex(h); const { signature } = splitSignedFinalSig(bytes); return toHex(decodeFinalSig(bytes.subarray(0, bytes.length - signature.length)).signerPubkey); } catch { return null; }
};
// ONE DAY ONLINE IS ENOUGH (Daniel 2026-11-10: "1 tag online reicht"), looked for in the last NODE_BOUNTY_WINDOW days, today included
export const NODE_BOUNTY_DAYS = 1, NODE_BOUNTY_WINDOW = 7;

// `teamHosts` hostnames the team runs its nodes on: a node whose own door answers there is a team node, never paid
export async function nodeBountyCheck({ node, npub, seats, fetchJson, nowMs = Date.now(), excluded = new Set(), days = NODE_BOUNTY_DAYS, window = NODE_BOUNTY_WINDOW, teamHosts = [] }) {
  const n = String(node || '').toLowerCase(), me = String(npub || '').toLowerCase();
  // THE OWNER KEY IS OPTIONAL (Daniel 2026-11-10: "npub muss nicht sein"): with one, the answer says whether it is the node's owner - a hint for the reviewer
  if (!/^[0-9a-f]{64}$/.test(n) || (me && !/^[0-9a-f]{64}$/.test(me))) return { ok: false, why: 'a node key (and, if given, an owner key), 64 hex each' };
  const urls = [...new Set((seats || []).map((u) => String(u).replace(/\/+$/, '')))];
  // THE OWNER: the node's own word, SIGNED BY THE NODE (audit 6, kanban #1418): any listed seat can answer GET /owner naming any node, and the last
  // answer won - a seat of one's own named itself the owner of someone else's node. Only a statement the node key signed counts, at most a day old,
  // the newest of them; `at` (the team-host check) is where that statement was served
  let owner = null, at = null, newest = -1;
  const servedAt = new Set();   // every host that served the node's signed word (audit 6 re-check N7, kanban #1426)
  // AN UNSIGNED ANSWER STILL SAYS WHERE THE NODE IS (audit 7, kanban #1428): no released node signs its statement yet, so a team seat answered only
  // unsigned and the team-host test never fired - the owner condition hid that until it was dropped. For the team test any seat whose /owner names
  // the node counts (a false "team" only refuses); the owner itself is still read from signed statements only
  const namedAt = new Set();
  await Promise.all(urls.map(async (u) => { try { const o = await fetchJson(`${u}/owner`); if (o && String(o.node).toLowerCase() === n) namedAt.add(u); if (!o || String(o.node).toLowerCase() !== n || !o.statement) return;
    const atMs = Number(o.statement.atMs), named = o.claimed ? String(o.owner || '').toLowerCase() : '';
    if (!Number.isFinite(atMs) || Math.abs(nowMs - atMs) > OWNER_STATEMENT_MAX_AGE_MS || !/^[0-9a-f]{128}$/.test(String(o.statement.sig || ''))) return;
    let good = false; try { good = schnorr.verify(fromHex(String(o.statement.sig)), ownerStatementMessage({ node: n, owner: named, atMs }), fromHex(n)); } catch { good = false; }
    if (!good) return;
    servedAt.add(u);
    if (atMs <= newest) return;
    newest = atMs; at = u; owner = named || null; } catch { /* not answering */ } }));
  const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
  // a seat relaying a team node's signed word must not make it look outside: any team host among those that served it makes it a team node
  const team = excluded.has(n) || (me && excluded.has(me)) || [...servedAt, ...namedAt].some((u) => (teamHosts || []).map((h) => String(h).toLowerCase()).includes(hostOf(u)));
  // THE LAST `days` UTC DAYS: each seat's rounds of that day, merged by round id
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  // the days in parallel (measured 2026-11-08 on 17 seats: one after another took 120 s)
  const perDay = await Promise.all(Array.from({ length: window }, (_, i) => window - 1 - i).map(async (d) => {
    const from = today - d * DAY_MS, to = from + DAY_MS;
    const rounds = new Map();
    await Promise.all(urls.map(async (u) => {
      try {
        const j = await fetchJson(`${u}/served?from=${from}&to=${to}&finals=1`);
        for (const r of (j && j.held) || []) if (!rounds.has(r.roundId)) rounds.set(r.roundId, r);
      } catch { /* a seat that does not answer adds nothing */ }
    }));
    const mine = [...rounds.values()].filter((r) => (r.committee || []).map((k) => String(k).toLowerCase()).includes(n));
    return { from, committees: mine.length, signed: mine.filter((r) => (r.finals || []).map(signerOf).includes(n)).length };
  }));
  const committees = perDay.reduce((t, x) => t + x.committees, 0), signed = perDay.reduce((t, x) => t + x.signed, 0);
  const daysOn = perDay.filter((x) => x.committees > 0).length;
  const checks = [
    { key: 'census', label: 'Bonded, in the census', ok: committees > 0, says: committees > 0 ? 'drawn into committees' : `not drawn into a committee in the last ${window} days` },
    { key: 'online', label: `Online ${days} day${days === 1 ? '' : 's'}`, ok: daysOn >= days, says: `served on ${daysOn} of the last ${window} days` },
    { key: 'committees', label: 'Committees and signed rounds', ok: committees > 0 && signed > 0, says: `${committees} committees, ${signed} signed rounds` },
    { key: 'outside', label: 'Not a team node', ok: !team, says: team ? `a team node is never paid${at ? ` (it answers at ${hostOf(at)})` : ''}` : 'outside the team' },
  ];
  // not a condition any more (Daniel 2026-11-10), shown to the reviewer: whether the reporter's key is the node's signed owner (kanban #1418)
  // `other`: the node's own signed word names a different key - the approve refuses then (audit 7, kanban #1429)
  const ownerHint = { ok: !!me && owner === me, other: owner !== null && owner !== me, says: !me ? 'no owner key given' : owner === null ? 'the node did not name its owner' : owner === me ? 'the reporter owns this node' : 'the node names another owner' };
  return { ok: true, node: n, npub: me || null, days: perDay, checks, owner: ownerHint, passes: checks.every((c) => c.ok) };
}
