// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PROJECT PROPOSALS ON BITCOIN-ARENA.IO (§27A.9.32026-10-17: "Add a Project Proposals section to the website
// where people can comment and review"; "Anyone can do a proposal to pay out"). The homepage reads the proposals the network's nodes
// hold (GET /funding) and shows one only when at least `needed` of them hold it; it builds a proposal or a comment as the seats read
// them (arena-protocol funding.js), signs it with the visitor's own key - an nsec, or a key kept in that browser - and hands it to
// every node (POST /funding), which keep it and pass it on. The curve is the page's (arena-curve.js, globalThis.BLWP_CURVE: pointX,
// signSchnorr), passed in as `curve` - this bundle carries no crypto of its own.
import { encodeFundingProposal, fundingProposalId, encodeFundingComment, fundingCommentId } from '../../arena-protocol/src/funding.js';
import { bech32Encode, bech32Decode, convertBits } from '../../arena-protocol/src/bech32.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodePlayerName, decodePlayerName, playerNameId } from '../../arena-protocol/src/player-name.js';
import { identitySecretFor } from '../../arena-protocol/src/player-key.js';
import { displayNameFromKey } from '../../arena-protocol/src/display-name.js';

const fundingBaseOf = (n) => String(n).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
const fundingMost = (xs) => { const c = new Map(); for (const x of xs) c.set(x, (c.get(x) || 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0]; };

const curveOf = (curve) => { const c = curve || globalThis.BLWP_CURVE; if (!c || typeof c.pointX !== 'function') throw new Error('no curve loaded (arena-curve.js)'); return c; };
/** A visitor's key: 32 random bytes the curve takes, or the one an nsec names. */
export function newProposalKey(curve) {
  const c = curveOf(curve);
  for (;;) { const k = crypto.getRandomValues(new Uint8Array(32)); try { c.pointX(k); return k; } catch { /* outside the group: again */ } }
}
export function keyOfNsec(nsec) {
  const d = bech32Decode(String(nsec).trim().toLowerCase());
  if (!d || d.hrp !== 'nsec') throw new Error('that is not an nsec');
  const k = Uint8Array.from(convertBits(d.words, 5, 8, false));
  if (k.length !== 32) throw new Error('an nsec names 32 bytes');
  return k;
}
export const npubOf = (sk, curve) => bech32Encode('npub', convertBits(curveOf(curve).pointX(sk), 8, 5, true));
export const npubOfKey = (pkHex) => bech32Encode('npub', convertBits(fromHex(pkHex), 8, 5, true));

/**
 * What the nodes hold: every proposal at least `needed` of them hold, its stage as most of those say, and every comment any of
 * them holds (comments carry no weight; each node checked its signature). Answers { ok, tip, network, proposals, agreeing, asked }.
 */
export async function fetchProposals({ nodes, needed = 5, fetcher = (u, o) => fetch(u, o), timeoutMs = 10000, verify = null } = {}) {
  const asked = [...new Set((nodes || []).map(fundingBaseOf))];
  const answers = (await Promise.all(asked.map(async (b) => {
    try { const r = await fetcher(`${b}/funding`, { signal: AbortSignal.timeout(timeoutMs) }); return r.ok ? await r.json() : null; } catch { return null; }
  }))).filter((a) => a && Array.isArray(a.proposals));
  if (answers.length < needed) return { ok: false, why: `only ${answers.length} of ${asked.length} nodes answered, and ${needed} must`, asked: asked.length };
  const by = new Map();
  for (const a of answers) for (const p of a.proposals) {
    const had = by.get(p.hex) || { views: [], comments: new Map() };
    had.views.push(p);
    for (const c of p.comments || []) had.comments.set(c.id, c);
    by.set(p.hex, had);
  }
  // EVERY PLAYER'S NAME (PIP, player-name.js): the newest record any node holds whose signature this page checks itself - a node can
  // leave a name out, never write one; without `verify` (a test) the nodes' word is taken
  const names = new Map();
  for (const a of answers) for (const n of a.names || []) {
    const player = String(n.player || '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(player)) continue;
    if (verify) { const bytes = fromHex(String(n.hex || '')); if (bytes.length <= 64) continue;
      let ok = false; try { const rec = decodePlayerName(bytes.slice(0, -64));
        ok = toHex(rec.player) === player && rec.name === String(n.name) && String(rec.atMs) === String(n.atMs) && verify(bytes.slice(-64), playerNameId(rec), rec.player) === true; } catch { ok = false; }
      if (!ok) continue; }
    const had = names.get(player);
    if (!had || BigInt(n.atMs) > BigInt(had.atMs)) names.set(player, { name: String(n.name), atMs: String(n.atMs) });
  }
  const proposals = [];
  for (const { views, comments } of by.values()) {
    if (views.length < needed) continue;
    const p = views[0];
    const [stageKey] = fundingMost(views.map((v) => JSON.stringify([v.signal && v.signal.state, v.vote && v.vote.state, v.cancelled || null])));
    const v = views.find((x) => JSON.stringify([x.signal && x.signal.state, x.vote && x.vote.state, x.cancelled || null]) === stageKey);
    proposals.push({ id: p.id, purpose: p.purpose, amountSats: String(p.amountSats), lnurl: p.lnurl, author: p.author, network: p.network,
      publishedHeight: p.publishedHeight, signal: v.signal, vote: v.vote, cancelled: v.cancelled || null, signals: (v.signals || []).length,
      comments: [...comments.values()].sort((a, b) => a.atHeight - b.atHeight || (a.id < b.id ? -1 : 1)), holding: views.length });
  }
  // PIP NUMBERS (2026-10-17: "Project improvement proposals, PIP - each item set to vote is prefixed with PIP"): the earliest
  // published is PIP-1 - by its published block, then its id - so a number never changes once the proposals before it are held
  [...proposals].sort((a, b) => a.publishedHeight - b.publishedHeight || (a.id < b.id ? -1 : 1)).forEach((p, i) => { p.pip = i + 1; });
  proposals.sort((a, b) => b.publishedHeight - a.publishedHeight);
  const tips = answers.map((a) => Number(a.tip)).filter(Number.isInteger).sort((a, b) => a - b);
  return { ok: true, tip: tips.length ? tips[Math.floor(tips.length / 2)] : null, proposals, names: Object.fromEntries(names), agreeing: answers.length, asked: asked.length };
}

/** The network the nodes run, as most of them name it (GET /network). */
export async function fetchNetworkId({ nodes, needed = 5, fetcher = (u, o) => fetch(u, o), timeoutMs = 10000 } = {}) {
  const ids = (await Promise.all([...new Set((nodes || []).map(fundingBaseOf))].map(async (b) => {
    try { const r = await fetcher(`${b}/network`, { signal: AbortSignal.timeout(timeoutMs) }); if (!r.ok) return null; const j = await r.json(); return j && j.manifest ? String(j.manifest.networkId).toLowerCase() : null; } catch { return null; }
  }))).filter((x) => /^[0-9a-f]{64}$/.test(x || ''));
  const [id, n] = fundingMost(ids);
  return n >= needed ? id : null;
}

/** A proposal or a comment, signed: the hex the nodes take (body || BIP340 signature over its id). */
export function signedProposal({ secretKey, networkId, publishedHeight, amountSats, lnurl, purpose, curve }) {
  const c = curveOf(curve);
  const p = { networkId: fromHex(networkId), author: c.pointX(secretKey), publishedHeight, amountSats: BigInt(amountSats), lnurl: String(lnurl).trim(), purpose: String(purpose) };
  const id = fundingProposalId(p);
  return { id: toHex(id), hex: toHex(Uint8Array.from([...encodeFundingProposal(p), ...c.signSchnorr(id, secretKey)])) };
}
export function signedComment({ secretKey, proposalId, parentId = null, atHeight, text, curve }) {
  const k = curveOf(curve);
  const c = { proposalId: fromHex(proposalId), parentId: parentId ? fromHex(parentId) : null, author: k.pointX(secretKey), atHeight, text: String(text) };
  const id = fundingCommentId(c);
  return { id: toHex(id), hex: toHex(Uint8Array.from([...encodeFundingComment(c), ...k.signSchnorr(id, secretKey)])) };
}

/**
 * THE PLAYER'S IN-GAME KEY (PIP, 2026-10-17: "Users can sign in with their ingame key"): the identity key a wallet seed makes -
 * the key the lobby, the board and the generated name use (identity.js) - and that generated name.
 */
export function forumIdentity(seedHex, curve) {
  const secret = identitySecretFor(fromHex(String(seedHex).toLowerCase()));
  const pubkey = curveOf(curve).pointX(secret);
  return { secret, pubkey: toHex(pubkey), generated: displayNameFromKey(pubkey) };
}
/** The name a player is shown by: its own from the nodes (`names` as fetchProposals answers), else the one made from its key. */
export const forumNameOf = (pkHex, names = {}) => { const n = names[String(pkHex).toLowerCase()]; return n && n.name ? n.name : displayNameFromKey(fromHex(String(pkHex))); };
/** A player's name, signed by its identity key ('' = back to its generated name): the hex a node takes as kind 'name'. */
export function signedName({ secretKey, networkId, name = '', atMs = Date.now(), curve }) {
  const c = curveOf(curve);
  const rec = { networkId: fromHex(networkId), player: c.pointX(secretKey), atMs: BigInt(atMs), name: String(name) };
  const id = playerNameId(rec);
  return { id: toHex(id), hex: toHex(Uint8Array.from([...encodePlayerName(rec), ...c.signSchnorr(id, secretKey)])) };
}

/** Hand a signed object to every node; kept when any took it (they pass it on to each other). */
export async function postFunding({ nodes, kind, hex, fetcher = (u, o) => fetch(u, o), timeoutMs = 15000 } = {}) {
  const asked = [...new Set((nodes || []).map(fundingBaseOf))];
  const res = await Promise.all(asked.map(async (b) => {
    try {
      const r = await fetcher(`${b}/funding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, hex }), signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => ({}));
      return r.ok && j.ok !== false ? { ok: true } : { ok: false, why: j.why || `HTTP ${r.status}` };
    } catch (e) { return { ok: false, why: e.message }; }
  }));
  const took = res.filter((r) => r.ok).length;
  return took ? { ok: true, took, asked: asked.length } : { ok: false, why: (res.find((r) => r.why) || {}).why || 'no node answered', asked: asked.length };
}
