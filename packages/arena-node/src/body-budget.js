// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
/**
 * THE BODIES IN FLIGHT SHARE ONE BUDGET, COUNTED ON BYTES RECEIVED (kanban #1911, #1953; refute of #1724, #1794 and #1469).
 *
 * #1724/#1794 gave server.js one budget for all unfinished bodies but took a body's share from its DECLARED Content-Length
 * before a byte arrived: four idle connections declaring 8 MiB each held the whole 32 MiB for the request timeout and every
 * honest POST of the seat was cut off - a free denial of service. The arbiter got a per-request limit only, so 150 parallel
 * unfinished claim bodies pinned ~150 MiB in the service that signs slash and liquidation payouts.
 *
 * The rules here, the same for both services:
 *  - only bytes actually received count; an idle socket holds nothing, so it costs the stranger its own bandwidth;
 *  - one remote address takes at most `perAddress` of the budget, so one stranger cannot take all of it;
 *  - a small body (at most `smallMost` bytes, a door's usual few KiB) that finds the budget full is admitted from a separate
 *    `reserve` (one address at most half of it), so honest small messages always get through;
 *  - a body with no data for `idleMs` (10 s) is dropped and its share freed;
 *  - a declared Content-Length past the door's `max` is refused before a byte is read (413); nothing else is decided from it;
 *  - a refused body is not read further, and the socket is ended only after the answer (413 / 503) was written, so the client
 *    sees "too large" or "busy" instead of a reset (`attach(req, res)` names the answer; without it the socket ends after 2 s).
 */
const responseOf = new WeakMap();

export function bodyBudget({ total, perAddress = Math.floor(total / 2), reserve = 4 * 1024 * 1024, smallMost = 64 * 1024, idleMs = 10000, defaultMax = total } = {}) {
  let main = 0; let spare = 0;
  const mainBy = new Map(); const spareBy = new Map();
  const add = (m, k, n) => { const v = (m.get(k) || 0) + n; if (v > 0) m.set(k, v); else m.delete(k); };
  const addressOf = (req) => { const a = String((req.socket && req.socket.remoteAddress) || ''); return a.startsWith('::ffff:') ? a.slice(7) : a; };
  const endAfterAnswer = (req) => {
    const res = responseOf.get(req);
    const end = () => { try { req.destroy(); } catch { /* gone */ } };
    if (res) {
      try { if (!res.headersSent) res.setHeader('connection', 'close'); } catch { /* sent */ }
      if (res.writableFinished) return end();
      res.once('finish', end); res.once('close', end);
    }
    setTimeout(end, res ? 5000 : 2000).unref();
  };

  const read = (req, max = defaultMax) => new Promise((resolve, reject) => {
    const who = addressOf(req);
    const parts = []; let size = 0; let inMain = 0; let inSpare = 0; let done = false; let idle = null;
    const finish = () => {
      if (done) return false; done = true;
      if (idle) clearTimeout(idle);
      main -= inMain; add(mainBy, who, -inMain); spare -= inSpare; add(spareBy, who, -inSpare); inMain = 0; inSpare = 0;
      parts.length = 0; return true;
    };
    const refuse = (e) => { if (!finish()) return; try { req.pause(); } catch { /* gone */ } reject(e); endAfterAnswer(req); };
    const tooLarge = () => { const e = new Error(`a body of more than ${max} bytes`); e.tooLarge = true; return e; };
    const busy = () => { const e = new Error('this node holds as many unfinished bodies as it takes; try again'); e.busy = true; return e; };
    const stalled = () => { const e = new Error(`no part of the body came for ${idleMs / 1000} s`); e.busy = true; return e; };
    const arm = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => refuse(stalled()), idleMs); if (idle.unref) idle.unref(); };
    // a declared length past the door's own limit is refused before a byte is read (kanban #1469); within it, it reserves nothing
    const declared = Number(req.headers && req.headers['content-length']);
    if (Number.isSafeInteger(declared) && declared > max) return refuse(tooLarge());
    arm();
    req.on('data', (c) => {
      if (done) return;
      if (size + c.length > max) return refuse(tooLarge());
      const n = c.length;
      if (main + n <= total && (mainBy.get(who) || 0) + n <= perAddress) { main += n; inMain += n; add(mainBy, who, n); }
      else if (size + n <= smallMost && spare + n <= reserve && (spareBy.get(who) || 0) + n <= Math.floor(reserve / 2)) { spare += n; inSpare += n; add(spareBy, who, n); }
      else return refuse(busy());
      size += n; parts.push(c); arm();
    });
    req.on('end', () => { if (done) return; const body = Buffer.concat(parts); finish(); resolve(body); });
    req.on('error', (e) => { if (finish()) reject(e); });
    req.on('close', () => { if (finish()) reject(new Error('the request ended before its body')); });
  });

  return {
    read,
    /** name the answer of a request, so a refused body's socket ends only after its 413 / 503 was written */
    attach: (req, res) => { responseOf.set(req, res); },
    held: () => ({ main, reserve: spare }),
  };
}
