// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OPERATOR UI'S TOKENS (spec §27A.7.7). "Pairing is a blwp-operator: URI - endpoint plus a 32-byte token the
// node prints on first start - pasted or scanned. The UI asks for an action; the node performs it. No key ever leaves the
// node." Tokens are scoped:
//   read    dashboards, income, bracket status          - stolen: information disclosure
//   vote    cast and change votes                       - stolen: a wrong vote
//   config  declarations (§27A.2 medians), addresses    - stolen: wrong declared preferences
// None of them can move money: the bond is spent only by its recovery path or a valid slash, and no token reaches either.
// Beside the owner's signed requests (owner.js), never instead of them: minting and revoking a token is an owner action.
//
// A token is kept only as its SHA-256 - the store never holds what was handed out - and compared in constant time.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const OPERATOR_SCOPES = Object.freeze(['read', 'vote', 'config']);
export const OPERATOR_URI_SCHEME = 'blwp-operator:';

const digest = (token) => createHash('sha256').update(String(token), 'utf8').digest();
/** The pairing URI: the node's endpoint, the token after '#', so a link handed around carries it no further than the UI. */
export const operatorUri = ({ endpoint, token }) => `${OPERATOR_URI_SCHEME}${String(endpoint).replace(/\/+$/, '')}#${token}`;
/** The endpoint and token in a pairing URI, or null. */
export function readOperatorUri(uri) {
  const m = /^blwp-operator:(https?:\/\/[^#\s]+)#([0-9a-f]{64})$/.exec(String(uri || '').trim());
  return m ? { endpoint: m[1], token: m[2] } : null;
}

/**
 * `store`: { read() -> [{ id, hash, scopes, createdAtMs }] , write(list) }; `random(n)` bytes. Answers mint / check / revoke /
 * list / first.
 */
export function createOperatorTokens({ store, nowMs = () => Date.now(), random = (n) => randomBytes(n), log = () => {} }) {
  let kept = (() => { try { const l = store.read(); return Array.isArray(l) ? l : []; } catch { return []; } })();
  const save = () => store.write(kept);
  const scopesOf = (scopes) => {
    const s = [...new Set((Array.isArray(scopes) ? scopes : []).map(String))];
    if (!s.length || s.some((x) => !OPERATOR_SCOPES.includes(x))) throw new Error(`a token's scopes are some of ${OPERATOR_SCOPES.join(', ')}`);
    return s;
  };
  const api = {
    /** A new token with `scopes`: its id and the token itself, which is shown once and kept only as its hash. */
    mint(scopes) {
      const s = scopesOf(scopes);
      const token = Buffer.from(random(32)).toString('hex');
      const id = Buffer.from(random(4)).toString('hex');
      kept.push({ id, hash: digest(token).toString('hex'), scopes: s, createdAtMs: nowMs() });
      save();
      return { id, token, scopes: s };
    },
    /** A bearer token for `scope`: { ok, id } or { ok: false, status, why }. */
    check(bearer, scope) {
      const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(String(bearer || '').trim());
      if (!m) return { ok: false, status: 401, why: 'an operator door asks for "Authorization: Bearer <token>" (the blwp-operator: pairing token)' };
      const d = digest(m[1].toLowerCase());
      const hit = kept.find((k) => { const h = Buffer.from(k.hash, 'hex'); return h.length === d.length && timingSafeEqual(h, d); });
      if (!hit) return { ok: false, status: 401, why: 'that is not a token of this node (revoked, or never minted here)' };
      if (!hit.scopes.includes(scope)) return { ok: false, status: 403, why: `that token's scopes are ${hit.scopes.join(', ')}, not ${scope}` };
      return { ok: true, id: hit.id };
    },
    revoke(id) {
      const before = kept.length;
      kept = kept.filter((k) => k.id !== String(id));
      if (kept.length === before) return { ok: false, status: 404, why: 'no such token' };
      save();
      return { ok: true };
    },
    list: () => kept.map(({ id, scopes, createdAtMs }) => ({ id, scopes, createdAtMs })),
    /** FIRST START: with no token kept, the pairing token - every scope, none of which moves money - minted and its URI logged. */
    first(endpoint) {
      if (kept.length) return null;
      const t = api.mint(OPERATOR_SCOPES);
      const uri = operatorUri({ endpoint, token: t.token });
      log(`[operator] pair the operator UI with ${uri} (scopes ${t.scopes.join(', ')}; none can move money - spec 27A.7.7)`);
      return { ...t, uri };
    },
  };
  return api;
}
