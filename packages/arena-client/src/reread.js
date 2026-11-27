// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A READ THAT SURVIVES A DEAD KEPT-ALIVE SOCKET (M3.3-27).
//
// Measured on the regtest rehearsal: after the event loop was held past the
// server's keep-alive (5 s by Node's default) - a replay does that - the next
// read went out on a pooled socket the server had already closed, and failed
// `fetch failed: ECONNRESET` in a few ms. The provider was counted as having
// given no chain, and `Client.at` refused. Asked again, the same read succeeds:
// measured 5 of 5 on the second attempt.
//
// So a READ is asked once more, and only when the failure is the connection's
// own - a reset, a broken pipe, the other side closed - never an HTTP answer
// and never a refused connection (a server that is down is down; asking twice
// is waiting twice). A write is never asked twice: posting a round, an entry or
// a handout again is a second act, whatever the door would make of it. A
// browser's fetch does this retry by itself, which is why the page never met
// the flake; Node's does not.
const CONNECTION_LOST = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);

/** Did this fetch fail because the connection it rode was already gone? */
export const connectionLost = (e) => !!(e && e.cause && CONNECTION_LOST.has(e.cause.code));

// AND A READ THAT NEVER ENDS ENDS (measured 2026-10-27: two market bots stood still for 7 min, each on one census read of a
// loaded seat that took the connection and never answered): a read with no signal of its own gives up after READ_MS
export const READ_MS = 30000;

/** `fetcher(url, opts)`, asked once more if a read lost its connection. */
export async function readWithOneRetry(fetcher, url, opts) {
  if (!(opts && opts.signal)) opts = { ...(opts || {}), signal: AbortSignal.timeout(READ_MS) };
  try {
    return await fetcher(url, opts);
  } catch (e) {
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    if (method !== 'GET' || !connectionLost(e) || (opts && opts.signal && opts.signal.aborted)) throw e;
    return fetcher(url, opts);
  }
}

// A SEAT'S ANSWER READ UP TO A BOUND (kanban #2740; moved here from committee.js for kanban #3848 so join.js can use it without a
// circular import): chunk by chunk, the stream cancelled past `max` (a Content-Length over it refused unread); over = that seat refused.
export async function bytesUpTo(r, max) {
  const said = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-length') : NaN);
  if (Number.isFinite(said) && said > max) { try { await r.body?.cancel(); } catch { /* gone */ } throw new Error(`its answer is ${said} bytes, more than ${max}`); }
  const reader = r.body && typeof r.body.getReader === 'function' ? r.body.getReader() : null;
  if (!reader) { const b = new Uint8Array(await r.arrayBuffer()); if (b.length > max) throw new Error(`its answer is more than ${max} bytes`); return b; }
  const parts = []; let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) throw new Error(`its answer is more than ${max} bytes`);
      parts.push(value);
    }
  } catch (e) { try { await reader.cancel(); } catch { /* gone */ } throw e; }
  const all = new Uint8Array(n); let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return all;
}
