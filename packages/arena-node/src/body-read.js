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
// ALL BODIES IN FLIGHT SHARE ONE BUDGET (kanban #1724, #1794, refute of #1469): the limit above is per request, so a stranger who
// opened many connections and sent just under it on each, never ending the body, kept every partial body (measured: 48 bodies
// of ~3.9 MiB pinned +190 MiB). BODY_BUDGET (four bodies at the limit, 32 MiB by default; ARENA_BODY_BUDGET, never below BODY_MOST) is
// what all unfinished bodies of this process may hold together; a chunk past it ends that request (503 where it can still be said)
// and frees what it held. A door's message is a few kilobytes, so honest traffic never comes near it.
export const BODY_BUDGET = Math.max(BODY_MOST, Number(process.env.ARENA_BODY_BUDGET) > 0 ? Number(process.env.ARENA_BODY_BUDGET) : 4 * BODY_MOST);
let bodiesInFlight = 0;
/** What all unfinished bodies of this process hold now (kanban #1724). */
export const bodiesHeld = () => bodiesInFlight;
export const readBody = (req, max = BODY_MOST) => new Promise((resolve, reject) => {
  const parts = []; let size = 0; let held = 0; let done = false;
  const finish = () => { if (done) return false; done = true; bodiesInFlight -= held; parts.length = 0; return true; };
  const refuse = (e) => { if (!finish()) return; reject(e); try { req.destroy(); } catch { /* gone */ } };
  const tooLarge = () => { const e = new Error(`a body of more than ${max} bytes`); e.tooLarge = true; return e; };
  const busy = () => { const e = new Error('this node holds as many unfinished bodies as it takes; try again'); e.busy = true; return e; };
  // a declared length is taken from the budget before a byte is read, so a refused body costs nothing (kanban #1724, #1794)
  const declared = Number(req.headers && req.headers['content-length']);
  if (Number.isSafeInteger(declared) && declared > 0) {
    if (declared > max) return refuse(tooLarge());
    if (bodiesInFlight + declared > BODY_BUDGET) return refuse(busy());
    held = declared; bodiesInFlight += declared;
  }
  // A DOOR'S OWN LIMIT (kanban #1271): past `max` bytes the body is not kept, the request ends, and the door answers 413
  req.on('data', (c) => {
    if (done) return;
    if (size + c.length > max) return refuse(tooLarge());
    const grow = Math.max(0, size + c.length - held);
    if (grow && bodiesInFlight + grow > BODY_BUDGET) return refuse(busy());
    size += c.length; held += grow; bodiesInFlight += grow; parts.push(c);
  });
  req.on('end', () => { if (done) return; const body = new Uint8Array(Buffer.concat(parts)); finish(); resolve(body); });
  req.on('error', (e) => { if (finish()) reject(e); });
  req.on('close', () => { if (finish()) reject(new Error('the request ended before its body')); });
});
