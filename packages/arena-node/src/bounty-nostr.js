// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// DOES A NOSTR KEY FOLLOW BITCOIN ARENA (kanban #2641, Daniel 2026-11-14: "Mach zusätzlich Follow auf Nostr ... wir müssen das live prüfen ob der npub
// uns folgt"): the key's newest kind 3 contact list, read from our relay and big public ones (REQ/CLOSE only), its id and signature checked; a "p"
// tag naming our profile key (kanban #1144) is a follow. A name@domain (NIP-05) is resolved over https on a public host only, size-capped and timed
// out, redirects checked hop by hop (the #2683 lessons).
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from './nostr-relay.js';
import { bech32Decode, wsQuery } from './bounty-armada.js';
import { checkedFetch } from './public-fetch.js';
import { readJsonBounded } from './lnurl-read.js';

export const ARENA_NOSTR_PUBKEY = '09dbfd772e67e02440df604429f47c747668b82b8e8a5121d367976a06de2bf7';
export const NOSTR_RELAYS = Object.freeze(['wss://relay.bitcoin-arena.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.damus.io']);
const HEX64 = /^[0-9a-f]{64}$/;
const hexOf = (b) => Buffer.from(b).toString('hex');

/** An npub, nprofile, hex key or name@domain -> the hex pubkey, or null. NIP-05: https, public host, 16 KiB, 8 s. */
export async function nostrPubkeyOf(input, { fetchFn = checkedFetch, timeoutMs = 8000 } = {}) {
  const s = String(input || '').trim();
  if (HEX64.test(s.toLowerCase())) return s.toLowerCase();
  const d = bech32Decode(s);
  if (d && d.prefix === 'npub' && d.bytes.length === 32) return hexOf(d.bytes);
  if (d && d.prefix === 'nprofile') { const b = d.bytes; for (let i = 0; i + 2 <= b.length;) { const ty = b[i], l = b[i + 1]; if (ty === 0 && l === 32) return hexOf(b.subarray(i + 2, i + 34)); i += 2 + l; } return null; }
  const m = /^([a-z0-9._-]{1,64})@([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+)$/i.exec(s);
  if (!m) return null;
  try {
    const r = await fetchFn(`https://${m[2].toLowerCase()}/.well-known/nostr.json?name=${encodeURIComponent(m[1].toLowerCase())}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r || r.status !== 200) return null;
    const j = await readJsonBounded(r, 16 * 1024);
    const v = j && j.names && j.names[m[1].toLowerCase()];
    return typeof v === 'string' && HEX64.test(v.toLowerCase()) ? v.toLowerCase() : null;
  } catch { return null; }
}

/** A kind 3 event that is what it says: its id is its content's hash and its signature is its author's. */
export function signedContactList(e, author) {
  try {
    if (!e || e.kind !== 3 || e.pubkey !== author || !Array.isArray(e.tags)) return false;
    if (eventId(e) !== e.id) return false;
    return schnorr.verify(Buffer.from(e.sig, 'hex'), Buffer.from(e.id, 'hex'), Buffer.from(e.pubkey, 'hex'));
  } catch { return false; }
}

/**
 * THE CHECK: `link.userId` the follower's hex key -> { member: follows, why }. The newest signed kind 3 across the relays decides (a later list without
 * us is an unfollow). No list found anywhere: not a follower. `query(relays, filters)` is injectable (tests use fake relays).
 */
export function nostrVerifier({ target = ARENA_NOSTR_PUBKEY, relays = NOSTR_RELAYS, query = wsQuery({ timeoutMs: 6000, maxPages: 1 }) } = {}) {
  return async (link) => {
    const who = String((link && link.userId) || '').toLowerCase();
    if (!HEX64.test(who)) return { member: null, why: 'no Nostr key' };
    try {
      const evs = (await query(relays, [{ kinds: [3], authors: [who], limit: 3 }])).filter((e) => signedContactList(e, who));
      if (!evs.length) return { member: false, why: 'no contact list found' };
      const newest = evs.reduce((a, b) => (b.created_at > a.created_at || (b.created_at === a.created_at && b.id < a.id) ? b : a));
      const follows = newest.tags.some((t) => Array.isArray(t) && t[0] === 'p' && String(t[1]).toLowerCase() === target);
      return { member: follows, why: follows ? 'follows Bitcoin Arena' : 'does not follow Bitcoin Arena' };
    } catch (e) { return { member: null, why: String((e && e.message) || e).slice(0, 80) }; }
  };
}
