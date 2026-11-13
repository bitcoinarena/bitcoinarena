// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
//
// EVERY BODY HAS A LIMIT (kanban #1469, feedback #001 by Hexbox Tools 2026-11-11: read() kept a body of any size, and ~57 doors anyone may call buffered
// it whole before any check - one large POST filled a seat's memory): BODY_MOST by default (8 MiB, ARENA_BODY_MOST), far above the few kilobytes a door's
// message takes; a door that needs less passes its own `max`. Past it the body is dropped, the request ended, and the door answers 413.
//
// ONE READER FOR EVERY SERVER (kanban #1592, a bypass of #1469): the cap first lived only in server.js, and the arbiter's own http server
// (serveArbiter) kept reading /musig/nonce, /musig/partial and /liquidation-claims with an uncapped `s += d` before any check - an 8 MiB
// body was read whole. Every request body in arena-node is read here now, so no server can bring its own unbounded reader back.
export const BODY_MOST = Number(process.env.ARENA_BODY_MOST) > 0 ? Number(process.env.ARENA_BODY_MOST) : 8 * 1024 * 1024;
export const readBody = (req, max = BODY_MOST) => new Promise((resolve, reject) => {
  const parts = []; let size = 0;
  // A DOOR'S OWN LIMIT (kanban #1271): past `max` bytes the body is not kept, the request ends, and the door answers 413
  req.on('data', (c) => { size += c.length; if (size > max) { parts.length = 0; const e = new Error(`a body of more than ${max} bytes`); e.tooLarge = true; reject(e); try { req.destroy(); } catch { /* gone */ } return; } parts.push(c); });
  req.on('end', () => resolve(new Uint8Array(Buffer.concat(parts))));
  req.on('error', reject);
});

// A PEER'S ANSWER HAS A LIMIT TOO (kanban #2458, audit 11): drawn-attestor.js read the other drawn seats' GET /attestation-word answers
// with res.json() - one drawn seat answered hundreds of MB and every honest drawn seat buffered and JSON-parsed it on every pass. The
// same uncapped read was in order-batch.js (#ask, #syncOnce), settlement.js (/cancels) and price-feed.js (/price-sign). A Content-Length
// over `max` is refused unread; a streamed body is read chunk by chunk and cancelled once it passes `max`. An answer without a body
// stream (a test's stub) is read as it is. Past the cap it throws: the caller counts that seat's answer as none.
export async function jsonUpTo(r, max) {
  const said = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-length') : NaN);
  if (said > max) { try { await r.body?.cancel(); } catch { /* gone */ } throw new Error(`an answer of ${said} bytes, more than ${max}`); }
  if (!r.body || typeof r.body.getReader !== 'function') return r.json();
  const reader = r.body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { reader.cancel().catch(() => {}); throw new Error(`an answer of more than ${max} bytes`); }
    parts.push(value);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
