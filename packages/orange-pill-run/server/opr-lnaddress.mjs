// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PLAYER'S LIGHTNING ADDRESS FOR PRIZES (kanban #3250): checked before it is kept, so the play bounty and the pot go to an address that answers.
//   lnAddressSyntax(text) -> { ok, address, user, domain } | { ok: false, why }     LUD-16 user@domain, lower case, a public name, no port, no IP
//   checkLnAddress(address, { fetchFn, timeoutMs }) -> { ok, address } | { ok: false, why }
//     GET https://<domain>/.well-known/lnurlp/<user>: 5 s for the whole ask, at most 64 KB read, redirects followed by hand (checkedFetch), each hop
//     on https to a public name whose every address is global (internalByName by name, globalLookup at connect - pinned, no rebinding in between).
//     The answer must be JSON with tag "payRequest", an https callback on a public name, and minSendable..maxSendable taking at least 1 sat.
// The `why` is short: the page shows it under the field as it is.
import { request as httpsRequest } from 'node:https';
import { checkedFetch, globalLookup, internalByName } from '../../arena-node/src/public-fetch.js';

export const LN_ANSWER_MOST = 64 * 1024;
export const LN_TIMEOUT_MS = 5000;
export const LN_CHECKS_PER_HOUR = 10;
export const WHY = Object.freeze({
  syntax: 'Not a Lightning address', private: 'That is not a public wallet', silent: 'That wallet did not answer', unknown: 'That wallet does not know this address',
  answer: 'That wallet did not answer with a Lightning address', callback: 'That wallet gave no public https callback', amount: 'That wallet takes no payment of 1 sat',
});

/** LUD-16 as the owner set it (2026-11-22): user [a-z0-9-_.+], a public domain name, no IP literal, localhost or private name, no port. */
export function lnAddressSyntax(text) {
  const a = String(text == null ? '' : text).trim().toLowerCase();
  const m = /^([a-z0-9\-_.+]{1,64})@([a-z0-9.-]{1,253})$/.exec(a);
  if (!m) return { ok: false, why: WHY.syntax };
  const [, user, domain] = m;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-')) || !/^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]{2,}$/.test(labels[labels.length - 1])) return { ok: false, why: WHY.syntax };
  if (internalByName(domain)) return { ok: false, why: WHY.private };
  return { ok: true, address: `${user}@${domain}`, user, domain };
}

/** A hop's URL is asked only on https, port 443, a public name (the address it resolves to is checked at connect). */
export function lnUrlRefusal(url) {
  let u; try { u = new URL(String(url)); } catch { return WHY.private; }
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password || internalByName(u.hostname)) return WHY.private;
  return null;
}

/** One https GET pinned to the checked global address, no redirect followed itself, at most LN_ANSWER_MOST bytes. */
export function lnFetch(url, { signal, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(String(url), { method: 'GET', headers: { accept: 'application/json', ...(headers || {}) }, lookup: globalLookup, signal, agent: false }, (res) => {
      const parts = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > LN_ANSWER_MOST) { req.destroy(Object.assign(new Error('its answer is too large'), { code: 'ETOOLARGE' })); return; } parts.push(c); });
      res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(parts).toString('utf8'), status = res.statusCode || 0;
        const get = (k) => { const v = res.headers[String(k).toLowerCase()]; return v === undefined ? null : Array.isArray(v) ? v.join(', ') : String(v); };
        resolve({ ok: status >= 200 && status < 300, status, headers: { get }, text: async () => body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function checkLnAddress(address, { fetchFn = lnFetch, timeoutMs = LN_TIMEOUT_MS } = {}) {
  const s = lnAddressSyntax(address);
  if (!s.ok) return s;
  const url = `https://${s.domain}/.well-known/lnurlp/${encodeURIComponent(s.user)}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let r, text;
  try {
    // the timeout covers the whole ask, a fetcher that does not watch the signal included
    const gone = new Promise((_, no) => { signal.addEventListener('abort', () => no(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), { once: true }); });
    r = await Promise.race([checkedFetch(url, { fetchFn, signal, refusal: lnUrlRefusal }), gone]);
    text = await Promise.race([r.text(), gone]);
  } catch (e) {
    return { ok: false, why: e && e.code === 'EINTERNALHOST' ? WHY.private : WHY.silent };
  }
  if (r.status === 404 || r.status === 410) return { ok: false, why: WHY.unknown };
  if (!(r.status >= 200 && r.status < 300)) return { ok: false, why: r.status >= 300 && r.status < 400 ? WHY.private : WHY.silent };
  if (typeof text !== 'string' || text.length > LN_ANSWER_MOST) return { ok: false, why: WHY.answer };
  let j; try { j = JSON.parse(text); } catch { return { ok: false, why: WHY.answer }; }
  if (!j || typeof j !== 'object' || j.tag !== 'payRequest') return { ok: false, why: WHY.answer };
  if (typeof j.callback !== 'string' || lnUrlRefusal(j.callback)) return { ok: false, why: WHY.callback };
  const min = Number(j.minSendable), max = Number(j.maxSendable);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < 1000 || min > max) return { ok: false, why: WHY.amount };
  return { ok: true, address: s.address };
}
