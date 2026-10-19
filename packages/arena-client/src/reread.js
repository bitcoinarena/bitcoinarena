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

/** `fetcher(url, opts)`, asked once more if a read lost its connection. */
export async function readWithOneRetry(fetcher, url, opts) {
  try {
    return await fetcher(url, opts);
  } catch (e) {
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    if (method !== 'GET' || !connectionLost(e) || (opts && opts.signal && opts.signal.aborted)) throw e;
    return fetcher(url, opts);
  }
}
