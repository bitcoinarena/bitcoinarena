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
import { bodyBudget } from './body-budget.js';

export const BODY_MOST = Number(process.env.ARENA_BODY_MOST) > 0 ? Number(process.env.ARENA_BODY_MOST) : 8 * 1024 * 1024;
// ALL BODIES IN FLIGHT SHARE ONE BUDGET (kanban #1724, #1794, refute of #1469): the limit above is per request, so a stranger who
// opened many connections and sent just under it on each, never ending the body, kept every partial body (measured: 48 bodies
// of ~3.9 MiB pinned +190 MiB). BODY_BUDGET (four bodies at the limit, 32 MiB by default; ARENA_BODY_BUDGET, never below BODY_MOST) is
// what all unfinished bodies of this process may hold together; a chunk past it ends that request (503 where it can still be said)
// and frees what it held. A door's message is a few kilobytes, so honest traffic never comes near it.
export const BODY_BUDGET = Math.max(BODY_MOST, Number(process.env.ARENA_BODY_BUDGET) > 0 ? Number(process.env.ARENA_BODY_BUDGET) : 4 * BODY_MOST);
// COUNTED ON BYTES RECEIVED, NEVER ON A DECLARED LENGTH (kanban #1911, #1953, refute of #1724, #1794): taking the share from Content-Length let
// four idle connections declaring 8 MiB each hold the whole budget for free and cut every honest POST off. Now an idle socket holds nothing,
// one address takes at most half the budget, a small body always finds room in a reserve, a body silent for 10 s (ARENA_BODY_IDLE_MS) is
// dropped, and a refused body is answered (413 / 503) before its socket ends - see body-budget.js. The arbiter has a budget of its own.
const BODY_IDLE_MS = Number(process.env.ARENA_BODY_IDLE_MS) > 0 ? Number(process.env.ARENA_BODY_IDLE_MS) : 10000;
const bodies = bodyBudget({ total: BODY_BUDGET, perAddress: Math.max(BODY_MOST, Math.floor(BODY_BUDGET / 2)), idleMs: BODY_IDLE_MS, defaultMax: BODY_MOST });
/** What all unfinished bodies of this process hold now (kanban #1724; bytes received, kanban #1911). */
export const bodiesHeld = () => { const h = bodies.held(); return h.main + h.reserve; };
/** Name a request's answer, so a refused body's socket ends only after its 413 / 503 was written (kanban #1911). */
export const attachBody = (req, res) => bodies.attach(req, res);
// A DOOR'S OWN LIMIT (kanban #1271): past `max` bytes the body is not kept, the request ends, and the door answers 413
export const readBody = async (req, max = BODY_MOST) => new Uint8Array(await bodies.read(req, max));

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
