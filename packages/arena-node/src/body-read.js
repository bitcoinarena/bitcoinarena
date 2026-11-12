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
