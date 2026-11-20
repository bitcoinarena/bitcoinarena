// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE BOUNTY'S CHECKLIST (kanban #1342, the owner 2026-11-08): "the conditions as a checklist that fills in live from the census for the reporter's npub
// (in census, bonded, online 7 days, committees and signed rounds, owner key = your npub)". Read from the seats' public doors only, so it works for a
// node on any release:
//   owner       the node's own GET /owner (its claimed owner key) - found among the seats GET /network-games lists
//   committees  every seat's GET /served?finals=1 for each of the last 7 UTC days: the rounds whose committee names the node, and those it signed FINAL
//   in census   the node is a bonded node of the chain's census as the TRUSTED census seats read it (GET /roles: the faucet's own configured seats),
//               and drawn into committees; the days it served are its days online (kanban #1489 / #1682: "drawn" alone was only "committees > 0")
//   witnesses   a round counts only held by NODE_BOUNTY_AGREE census nodes of that round's committee, each read at its own advertised endpoint
//               (the census entry's endpoint, answering with that node key) and each node key once (kanban #1682) - NEVER the node itself
//               (kanban #2015, #2049: its own door was one of its three witnesses) - and confirmed by a TRUSTED census seat holding the same
//               round with the same committee (kanban #2015, #2049: three cheap testnet4 bonds of one operator made a round up among themselves)
// Answers { ok, node, checks: [{ key, label, ok, says }], passes } - `passes` only when every check holds. Team nodes are refused by `excluded`.
import { splitSignedFinalSig, decodeFinalSig, finalSigId } from '../../arena-protocol/src/final-sig.js';
import { decodeAttestation, attestationBodyId } from '../../arena-protocol/src/attested.js';
import { SEASON_NETWORK_AGREE } from '../../arena-protocol/src/season.js';
import { ATTEST_DRAW_THRESHOLD } from '../../arena-protocol/src/sortition.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ownerStatementMessage } from './owner.js';

// a node's owner statement counts only signed by that node and at most this old (kanban #1418)
export const OWNER_STATEMENT_MAX_AGE_MS = 24 * 3600 * 1000;

const DAY_MS = 24 * 3600 * 1000;
// a held FINAL (hex of its signed bytes) -> its signer's node key hex, or null. KANBAN #1489: the FINAL counts only when it is about this round and
// its BIP-340 signature verifies under its signerPubkey over finalSigId (what finality.js signs) - a FINAL "signed" with 64 zero bytes was taken,
// and so was a bare 64-hex key; neither is a signature any more
// KANBAN #3069: a market round's service is its outcome attestation. KANBAN #3094, #3096 (refute of #3069): the key that signs it is one of the
// round's 7 DRAWN ATTESTORS (roster.attestorsFor, their own seed) - not its committee (signer_nodes) - and a node's own door served an attestation
// it signed at check time (outcome 200, observed at 1 ms) and that counted. An attestation is now read apart: its body id, the keys whose
// BIP-340 signature verifies over it (only drawn attestors, when the witnesses agree on them). Who counts is decided per round below.
const readAttestation = (a, roundId, drawn) => {
  try {
    const x = decodeAttestation(fromHex(String(a).toLowerCase()));
    if (toHex(x.roundId) !== String(roundId).toLowerCase()) return null;
    const id = attestationBodyId(x), keys = new Set();
    for (const s of x.signatures) { const k = toHex(s.key); if (keys.has(k) || (drawn && !drawn.has(k))) continue; try { if (schnorr.verify(s.signature, id, s.key)) keys.add(k); } catch { /* not a signature */ } }
    return { body: toHex(id), keys };
  } catch { return null; }
};
// a quick look (no verify): does any attestation name this key among its signers - so a round the node attested is read although its committee does not name it
const namesKey = (list, roundId, n) => (Array.isArray(list) ? list.slice(0, 16) : []).some((a) => { try { const x = decodeAttestation(fromHex(String(a).toLowerCase()));
  return toHex(x.roundId) === String(roundId).toLowerCase() && x.signatures.some((s) => toHex(s.key) === n); } catch { return false; } });
const signerOf = (f, roundId) => {
  try {
    const bytes = fromHex(String(f).toLowerCase()), { body, signature } = splitSignedFinalSig(bytes), x = decodeFinalSig(body);
    if (toHex(x.roundId) !== String(roundId).toLowerCase()) return null;
    return schnorr.verify(signature, finalSigId(x), x.signerPubkey) ? toHex(x.signerPubkey) : null;
  } catch { return null; }
};
// KANBAN #1489: a round counts only when this many listed seats hold it with the same committee - the season's own network rule (SEASON_NETWORK_AGREE,
// season.js): one seat's /served answered rounds it made up, naming any key in the committee, and that alone passed the checklist (10,000 sat a node)
export const NODE_BOUNTY_AGREE = SEASON_NETWORK_AGREE;
// ONE DAY ONLINE IS ENOUGH (the owner 2026-11-10: "1 tag online reicht"), looked for in the last NODE_BOUNTY_WINDOW days, today included
export const NODE_BOUNTY_DAYS = 1, NODE_BOUNTY_WINDOW = 7;

// a seat's address as one string: scheme, lower-case host, the default port dropped (URL does that), no trailing slash - so one seat under
// several spellings is one address (kanban #1682). A NODE'S ADVERT IS ws:// OR wss:// (kanban #1866, #1888: measured on a live seat's GET /roles,
// 22 of 25 entries wss://): its http door is the same address with http(s) - as federation-records.js and server.js read it - so ws: is http:
// and wss: is https:; dropping them left every such node without a witness address and no honest node could pass
export const seatBaseOf = (u) => { try { const x = new URL(String(u).trim().replace(/^ws(s?):/i, 'http$1:')); if (!/^https?:$/.test(x.protocol)) return '';
  return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}`; } catch { return ''; } };
// THE CENSUS THE CHECK TRUSTS (kanban #1682): node key -> its advertised endpoints, bonded entries only. `census` given as a list of
// { node, endpoint, bondSats } (GET /roles's `nodes`), or read from `censusSeats` - seats the caller trusts (the faucet's own configured seats),
// never the listed seats an outsider can add: three colluding seats answering /roles would name any fresh key again
async function trustedCensus({ census, censusSeats, fetchJson }) {
  const lists = [];
  if (Array.isArray(census)) lists.push(census);
  await Promise.all([...new Set((censusSeats || []).map(seatBaseOf).filter(Boolean))].map(async (u) => {
    try { const j = await fetchJson(`${u}/roles`); if (j && Array.isArray(j.nodes)) lists.push(j.nodes); } catch { /* a census seat that does not answer adds nothing */ } }));
  const out = new Map();
  for (const list of lists) for (const e of list) {
    const k = String((e && e.node) || '').toLowerCase(), at = seatBaseOf(e && e.endpoint);
    let bonded = false; try { bonded = BigInt(String(e && e.bondSats)) > 0n; } catch { bonded = false; }
    if (!/^[0-9a-f]{64}$/.test(k) || !bonded) continue;
    if (!out.has(k)) out.set(k, new Set());
    if (at) out.get(k).add(at);
    // its newest signed address announcement (GET /roles `announced`, the census seat's addressBook.endpointOf - kanban #1866, #1888): a node
    // that moved is still asked where it answers now
    const moved = seatBaseOf(e && e.announced);
    if (moved) out.get(k).add(moved);
  }
  return out;
}

// `teamHosts` hostnames the team runs its nodes on: a node whose own door answers there is a team node, never paid
// `census` / `censusSeats` the bonded census to check against (kanban #1682) - with neither, no node is in the census and none passes
export async function nodeBountyCheck({ node, npub, seats, fetchJson, nowMs = Date.now(), excluded = new Set(), days = NODE_BOUNTY_DAYS, window = NODE_BOUNTY_WINDOW, teamHosts = [], census = null, censusSeats = [] }) {
  const n = String(node || '').toLowerCase(), me = String(npub || '').toLowerCase();
  // THE OWNER KEY IS OPTIONAL (the owner 2026-11-10: "npub muss nicht sein"): with one, the answer says whether it is the node's owner - a hint for the reviewer
  if (!/^[0-9a-f]{64}$/.test(n) || (me && !/^[0-9a-f]{64}$/.test(me))) return { ok: false, why: 'a node key (and, if given, an owner key), 64 hex each' };
  const bonded = await trustedCensus({ census, censusSeats, fetchJson });
  const inCensus = bonded.has(n);
  // seat address -> the census nodes advertised there (kanban #1682): only such a seat's /served is a witness, for one of those node keys.
  // ONE ADDRESS, SEVERAL NODES (kanban #1866, #1888): it was "neither" - one cheap bonded node advertising an honest witness's endpoint
  // cancelled that witness for every committee it sat on. Now the door's own answer says which of them it is (its `node`, which must be one
  // advertised there); an address one node advertises alone may answer without `node` (as before)
  const nodeAt = new Map();
  for (const [k, ats] of bonded) for (const at of ats) { if (!nodeAt.has(at)) nodeAt.set(at, new Set()); nodeAt.get(at).add(k); }
  // the listed seats and every census endpoint (a committee's members are asked where the chain says they are)
  // KANBAN #2015, #2049: the trusted census seats are asked too - a round counts only when one of them holds it (below)
  const trusted = new Set((censusSeats || []).map(seatBaseOf).filter(Boolean));
  const urls = [...new Set([...(seats || []).map((u) => String(u).replace(/\/+$/, '')), ...nodeAt.keys(), ...trusted])];
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
  // KANBAN #3094, #3096: a round is the node's when its committee names it, or (a market round) its drawn attestors do, as /served lists them
  // (`attestors`, roster.attestorsFor), or one of its attestations carries the node's key - verified before it counts (marketServed)
  const attestorsOf = (r) => (Array.isArray(r && r.attestors) ? r.attestors.map((k) => String(k).toLowerCase()) : []);
  const involved = (r, id, committee) => committee.includes(n) || attestorsOf(r).includes(n) || namesKey(r && r.attestations, id, n);
  // WHAT A MARKET ROUND'S SERVICE IS (kanban #3069, #3094, #3096), read only from what NODE_BOUNTY_AGREE witnesses - other nodes - hold:
  //  a drawn attestor: its BIP-340 signature over one body, in an attestation each of those witnesses hands over;
  //  a committee seat: the round's outcome STANDS (one body signed by ATTEST_DRAW_THRESHOLD drawn attestors, each of those witnesses holding it)
  //    and the node's own door keeps that same body - the outcome its round settles on; a body of its own making no witness holds is nothing.
  //  The drawn attestors are taken from the witnesses when NODE_BOUNTY_AGREE of them list the same 7; a signature by any other key is not counted.
  const marketServed = (r) => {
    const lists = new Map();
    for (const l of r.drawn.values()) lists.set(l, (lists.get(l) || 0) + 1);
    const agreed = [...lists].find(([, c]) => c >= NODE_BOUNTY_AGREE), drawn = agreed ? new Set(agreed[0].split(',')) : null;
    const signedBy = new Map(), standsBy = new Map();
    for (const atts of r.held.values()) {
      const mine = new Set(), stands = new Set();
      for (const a of atts) { const x = readAttestation(a, r.id, drawn); if (!x) continue; if (x.keys.has(n)) mine.add(x.body); if (x.keys.size >= ATTEST_DRAW_THRESHOLD) stands.add(x.body); }
      for (const b of mine) signedBy.set(b, (signedBy.get(b) || 0) + 1);
      for (const b of stands) standsBy.set(b, (standsBy.get(b) || 0) + 1);
    }
    if ([...signedBy.values()].some((c) => c >= NODE_BOUNTY_AGREE)) return true;
    if (!r.inCommittee) return false;
    const kept = new Set(r.own.map((a) => { try { const x = decodeAttestation(fromHex(String(a).toLowerCase())); return toHex(x.roundId) === r.id ? toHex(attestationBodyId(x)) : null; } catch { return null; } }).filter(Boolean));
    return [...standsBy].some(([b, c]) => c >= NODE_BOUNTY_AGREE && kept.has(b));
  };
  // THE LAST `days` UTC DAYS: each seat's rounds of that day, merged by round id
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  // the days in parallel (measured 2026-11-08 on 17 seats: one after another took 120 s)
  const perDay = await Promise.all(Array.from({ length: window }, (_, i) => window - 1 - i).map(async (d) => {
    const from = today - d * DAY_MS, to = from + DAY_MS;
    // round id + committee -> the seats holding it and the FINALs they hold (kanban #1489: counted only when NODE_BOUNTY_AGREE seats agree)
    const rounds = new Map();
    // KANBAN #2015, #2049: round id + committee keys a TRUSTED census seat holds. The census is testnet4's (a bond is 50,000 sat of faucet coin)
    // and the bounty is paid in mainnet sat: three bonded nodes of one operator, each at its own advert, held a round they made up with the
    // committee [k1, k2, k3], each signed its own FINAL, and all three keys passed. A round no seat the caller trusts holds is not counted
    const confirmed = new Set();
    await Promise.all(urls.map(async (u) => {
      try {
        // A WITNESS IS A CENSUS NODE AT ITS OWN ADVERTISED ENDPOINT (kanban #1682): any other listed seat's /served is not counted - three seats
        // of one operator invented a round naming a fresh key and passed; one seat under three spellings of its address was three seats
        const there = nodeAt.get(seatBaseOf(u)), isTrusted = trusted.has(seatBaseOf(u));
        if ((!there || !there.size) && !isTrusted) return;
        const j = await fetchJson(`${u}/served?from=${from}&to=${to}&finals=1`);
        if (isTrusted) for (const r of (j && j.held) || []) {
          const id = String(r && r.roundId).toLowerCase(), committee = (Array.isArray(r && r.committee) ? r.committee : []).map((k) => String(k).toLowerCase());
          if (/^[0-9a-f]{64}$/.test(id) && involved(r, id, committee)) confirmed.add(`${id}:${[...committee].sort().join(',')}`);
        }
        if (!there || !there.size) return;
        // the door's `node` names the witness, and only a node advertised at this address; with several there, `node` is required
        const said = j && j.node !== undefined && j.node !== null ? String(j.node).toLowerCase() : null;
        const witness = said !== null ? (there.has(said) ? said : null) : there.size === 1 ? [...there][0] : null;
        if (!witness) return;   // a door answering as another node is not that node
        for (const r of (j && j.held) || []) {
          const id = String(r && r.roundId).toLowerCase(), committee = (Array.isArray(r && r.committee) ? r.committee : []).map((k) => String(k).toLowerCase());
          // the claimed node and the witness both in the round's committee (a seat holds only the rounds it sat on). KANBAN #3094, #3096: or, on a
          // market round, the node (the witness) among its drawn attestors - the node's signature in an attestation it holds says so, checked below
          if (!/^[0-9a-f]{64}$/.test(id) || !involved(r, id, committee) || !(committee.includes(witness) || attestorsOf(r).includes(witness))) continue;
          const key = `${id}:${[...committee].sort().join(',')}`;
          const e = rounds.get(key) || { id, inCommittee: committee.includes(n), seats: new Set(), finals: [], held: new Map(), drawn: new Map(), own: [] };
          if (e.seats.has(witness)) continue;   // one node key is one witness, under any address
          const atts = Array.isArray(r.attestations) ? r.attestations.slice(0, 16) : [];
          // KANBAN #2015, #2049: the node is never its own witness. KANBAN #3094, #3096: nor its own evidence - a FINAL or an attestation counts only
          // as other nodes hand it over; the node's own door is read only for the attestation it kept (a committee seat's service, below)
          if (witness === n) { e.own.push(...atts); rounds.set(key, e); continue; }
          e.seats.add(witness);
          if (Array.isArray(r.finals)) e.finals.push(...r.finals);
          e.held.set(witness, atts);
          const listed = attestorsOf(r);
          if (listed.length) e.drawn.set(witness, [...listed].sort().join(','));
          rounds.set(key, e);
        }
      } catch { /* a seat that does not answer adds nothing */ }
    }));
    const mine = [...new Map([...rounds.entries()].filter(([k, r]) => r.seats.size >= NODE_BOUNTY_AGREE && confirmed.has(k)).map(([, r]) => [r.id, r])).values()];   // one round, counted once
    return { from, committees: mine.length, signed: mine.filter((r) => r.finals.some((f) => signerOf(f, r.id) === n) || marketServed(r)).length };
  }));
  const committees = perDay.reduce((t, x) => t + x.committees, 0), signed = perDay.reduce((t, x) => t + x.signed, 0);
  const daysOn = perDay.filter((x) => x.committees > 0).length;
  const checks = [
    { key: 'census', label: 'Bonded, in the census', ok: inCensus && committees > 0,
      says: !inCensus ? 'not a bonded node of the census' : committees > 0 ? 'bonded, drawn into committees' : `not drawn into a committee in the last ${window} days` },
    { key: 'online', label: `Online ${days} day${days === 1 ? '' : 's'}`, ok: daysOn >= days, says: `served on ${daysOn} of the last ${window} days` },
    { key: 'committees', label: 'Committees and signed rounds', ok: committees > 0 && signed > 0, says: `${committees} committees, ${signed} signed rounds` },
    { key: 'outside', label: 'Not a team node', ok: !team, says: team ? `a team node is never paid${at ? ` (it answers at ${hostOf(at)})` : ''}` : 'outside the team' },
  ];
  // not a condition any more (the owner 2026-11-10), shown to the reviewer: whether the reporter's key is the node's signed owner (kanban #1418)
  // `other`: the node's own signed word names a different key - the approve refuses then (audit 7, kanban #1429)
  const ownerHint = { ok: !!me && owner === me, other: owner !== null && owner !== me, says: !me ? 'no owner key given' : owner === null ? 'the node did not name its owner' : owner === me ? 'the reporter owns this node' : 'the node names another owner' };
  return { ok: true, node: n, npub: me || null, days: perDay, checks, owner: ownerHint, passes: checks.every((c) => c.ok) };
}
