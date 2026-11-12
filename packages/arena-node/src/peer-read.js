// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PEER SEAT'S ANSWER, READ UP TO A CAP (kanban #1829, #2244). One seat could answer tens of MB where a few kB are honest, and r.json() or
// r.arrayBuffer() buffered - and parsed - all of it on every honest seat that asked. The body is read chunk by chunk and refused, the stream
// cancelled, once it passes the cap; a Content-Length over it is refused unread. Shared by every door that reads a small peer answer:
// game-market.js (GET /round, GET /round-result, #1829), entry-relay.js seatView (GET /api/round-result, #2244) and server.js
// learnRoundApps (GET /round, #2244; GET /entry, #2327 #2343), entry-relay.js handLocks (GET /order-locks, #2327 #2343), server.js
// takeEntryParts, takeAcceptedEntry and replayOrder (GET /order-locks, /payout-address, /entry, /handout, #2368).

/** A peer's body as bytes, at most `maxBytes` of them; throws past the cap. */
export async function bytesUpTo(r, maxBytes) {
  const said = Number(r.headers.get('content-length'));
  if (said > maxBytes) { try { await r.body?.cancel(); } catch { /* dropped */ } throw new Error(`its answer is ${said} bytes, more than ${maxBytes}`); }
  if (!r.body) return new Uint8Array(0);
  const reader = r.body.getReader();
  const parts = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxBytes) { reader.cancel().catch(() => {}); throw new Error(`its answer passed ${maxBytes} bytes`); }
    parts.push(value);
  }
  const out = new Uint8Array(n); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A peer's JSON body, parsed from at most `maxBytes` bytes. */
export const jsonUpTo = async (r, maxBytes) => JSON.parse(new TextDecoder().decode(await bytesUpTo(r, maxBytes)));
