// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S KEY, PROVEN AT THE ADDRESS IT WAS ASKED AT (kanban #3800, RULED 2026-11-26 on the #3730 PR's open point; protocol 34).
//
// GET /identity?nonce=<fresh 32 bytes> answers the seat's BIP-340 signature over identityProofDigest(nonce) (kanban #2982/#3253). That digest
// names only the nonce, so a box that passes the ask on to a round seat's public door hands back the seat's real signature, and the box's own
// path "proves" the seat's key: one extra voice where the link does not name the real seat (the limit #3730 left, kanban #3773).
//
// So the seat also signs the address it was asked at: identityBoundDigest(nonce, at), `at` the Host of the request as the seat got it (host
// and port as a URL's `host` spells them, lower case). The asker checks that `at` is the host it asked. A relay that reaches the seat by the
// seat's own public name (a tunnel, a CDN: the name routes the request) gets a proof bound to the seat's host, never its own.
//
// What it cannot stop: a seat reachable on a raw address (an IP and port, no name in front) takes any Host a relay sends, and signs that.
// The Host header is the only word of the address the seat has: X-Forwarded-Host is not read, because a relay sets it through every proxy.
//
// The answer keeps the unbound signature beside the bound one (rounds below 34 and older pages read it, as today); the page counts a key's
// voice for a URL of a round of 34+ only with the bound proof (seat-identity.js `bound`), and rounds below 34 keep today's rule.
import { taggedHash } from './hash.js';
import { utf8Encode } from './utf8.js';

export const IDENTITY_BOUND_VERSION = 34;
/** Whether a round of protocol version `v` counts a seat's voice for a URL only with a proof bound to that URL's host (kanban #3800). */
export const bindsIdentity = (v) => Number.isInteger(Number(v)) && Number(v) >= IDENTITY_BOUND_VERSION;

/**
 * A host as both sides spell it: lower case, the name without trailing dots, the port kept where one is named (a URL's `host`, a request's
 * Host header). '' for nothing.
 */
export function identityHostKey(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) return h;                       // an IPv6 literal, [..] and an optional port, as it is
  const m = /^(.*?)(:\d+)?$/.exec(h);
  return m[1].replace(/\.+$/, '') + (m[2] || '');
}

/** The bound digest: the nonce (32 bytes, fixed, so the two parts cannot be shifted into each other) then the host key's UTF-8. */
export function identityBoundDigest(nonce, at) {
  if (!(nonce instanceof Uint8Array) || nonce.length !== 32) throw new Error('an identity proof is over a 32-byte nonce');
  const host = utf8Encode(identityHostKey(at));
  const msg = new Uint8Array(32 + host.length);
  msg.set(nonce, 0); msg.set(host, 32);
  return taggedHash('ARENA/v1/NodeIdentityProofAt', msg);
}
