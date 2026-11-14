// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TEST HELPER (kanban #2108, #2123): seats' GET /settled answers signed by each seat's node key, as server.js signs them now. Each
// seat URL (what precedes /settled) has its own key; `bonded` is the census the page checked - the keys of the seats named as honest.
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { settledListDigest } from '../../arena-protocol/src/settled-list.js';
import { sha256, toHex } from '../../arena-protocol/src/hash.js';

const seatOf = (url) => { const u = String(url); const i = u.indexOf('/settled'); return (i < 0 ? u : u.slice(0, i)).replace(/\/+$/, ''); };
export const seatSecret = (url) => sha256(new TextEncoder().encode(`test seat ${seatOf(url)}`));
export const seatKey = (url) => toHex(schnorr.getPublicKey(seatSecret(url)));

/** `fetcher` with every /settled answer signed by its seat's key; `bonded` the keys of `honest` (seat URLs), the census a page checked. */
export function signedSeats(fetcher, honest = []) {
  const signed = async (url, opts) => {
    const r = await fetcher(url, opts);
    if (!String(url).includes('/settled') || !r || !r.ok) return r;
    const body = typeof r.json === 'function' ? await r.json() : JSON.parse(await r.text());
    if (!body || !Array.isArray(body.rounds)) return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    const node = seatKey(url);
    const out = { ...body, node, sig: toHex(schnorr.sign(settledListDigest({ node, since: body.since, rounds: body.rounds }), seatSecret(url))) };
    return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) };
  };
  return { fetcher: signed, bonded: honest.map(seatKey) };
}
