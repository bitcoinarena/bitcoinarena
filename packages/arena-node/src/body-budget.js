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
  // A REFUSED BODY'S ANSWER REACHES THE CLIENT (kanban #3536): the seat answers at once, then reads and drops what the client still sends for at
  // most LINGER_MS before it closes. Closing with unread bytes in the socket resets it, and a client still writing its body (macOS at once) gets
  // EPIPE / ECONNRESET and loses the 413 it was already sent. Dropped bytes take no budget; the socket goes at the body's end or after LINGER_MS
  // Only a body past the door's limit lingers, and only for LINGER_MOST dropped bytes: a refusal of the shared budget (busy, stalled) - the
  // many-bodies attack of #1469 - still closes at once
  const LINGER_MS = 2000, LINGER_MOST = 2 * 1024 * 1024;
  const endAfterAnswer = (req, { linger: lingers = false } = {}) => {
    const res = responseOf.get(req);
    const end = () => { try { req.destroy(); } catch { /* gone */ } };
    if (res) {
      if (!lingers) { try { if (!res.headersSent) res.setHeader('connection', 'close'); } catch { /* sent */ } }
      const after = () => {
        if (!lingers || req.readableEnded || req.destroyed) return end();
        const t = setTimeout(end, LINGER_MS); if (t.unref) t.unref();
        let dropped = 0;
        req.on('data', (c) => { dropped += c.length; if (dropped > LINGER_MOST) { clearTimeout(t); end(); } });
        req.once('end', () => { clearTimeout(t); end(); }); req.once('error', end);
        try { req.resume(); } catch { end(); }
      };
      if (res.writableFinished) return after();
      res.once('finish', after); res.once('close', () => { if (!res.writableFinished) end(); });
    }
    setTimeout(end, res ? 5000 + LINGER_MS : 2000).unref();
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
    const refuse = (e) => { if (!finish()) return; try { req.pause(); } catch { /* gone */ } reject(e); endAfterAnswer(req, { linger: !!e.tooLarge }); };
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

/**
 * THE UNFINISHED WEBSOCKET MESSAGES SHARE A BUDGET TOO (kanban #2075, refute of #1469 / #1724 / #1794 / #1911 / #1953).
 *
 * The budget above covers HTTP bodies only. A websocket keeps every fragment of a message until its last one came, up to the
 * server's maxPayload, with no time limit (the seat's own keepalive pings hold the socket open): measured 2026-11-12 on the
 * test laptop, six /guardian-p2p connections each sending 56 MiB of one message and never its final fragment pinned 383 MiB in the
 * seat. So every accepted websocket is watched on its raw socket: the bytes received since its last whole message (control
 * frames taken off again) count against one shared budget with the same rules as the bodies - one address at most `perAddress`,
 * a small unfinished message (at most `smallMost`) may use a separate `reserve` (one address at most half of it), and a message
 * still unfinished `messageMs` after its first byte is not waited for. A connection past any of them is ended at once and its
 * share freed. A connection that sends whole messages holds nothing between them.
 *
 * `watch(ws, socket, address)` right after handleUpgrade's callback got `ws`: setSocket has run, so the counter is put in front
 * of ws's own data listener (the upgrade's `head` was unshifted onto the socket there and comes as a data event, counted too).
 */
export function messageBudget({ total, perAddress = Math.floor(total / 2), reserve = 4 * 1024 * 1024, smallMost = 256 * 1024, messageMs = 15000, evictOldest = false } = {}) {
  let main = 0; let spare = 0;
  const mainBy = new Map(); const spareBy = new Map();
  // THE OLDEST UNFINISHED MESSAGE GOES, NOT THE NEWCOMER (kanban #3734, audit nostr a8-1-1, `evictOldest`): with one first-come pool, a stranger
  // whose sockets each hold part of a frame (renewed every messageMs) kept the budget and the reserve full, and every honest socket that sent a
  // message in more than one read was ended at its first bytes - behind the tunnel every peer has one address, so the per-address shares do
  // not help. With `evictOldest` a message that finds no room ends the sockets whose unfinished message began first (of the same address when
  // that address's share is what is full) until it fits; only when none began before it is it ended itself. An honest message is in flight for
  // a moment, a message held to pin memory is old: to cut off an honest one the stranger has to renew the whole budget in that moment.
  // `open` holds the sockets with an unfinished message, in the order their messages began (Map insertion order)
  const open = new Map();
  const add = (m, k, n) => { const v = (m.get(k) || 0) + n; if (v > 0) m.set(k, v); else m.delete(k); };
  const plain = (a) => { const s = String(a || ''); return s.startsWith('::ffff:') ? s.slice(7) : s; };

  // `live()` (kanban #3188): false once `ws` no longer parses what `socket` reads (a dialled socket closing after a refused frame drains and drops it)
  //
  // WHAT IS HELD IS READ OFF THE FRAMES, NOT OFF WS'S EVENTS (kanban #3733, audit nostr a8-1-2): ws parses a read synchronously, so one read that
  // holds a whole small message and then the start of a big frame was counted, and then all of it was given back - and the deadline cleared - on
  // the small message's 'message': the unfinished frame behind it was held with no charge and no deadline. Now the counter walks the frame headers
  // of every read itself (2-14 header bytes, then the payload length they name) and charges exactly the bytes past the last whole message: the
  // open message's frames so far, a control frame not yet whole, a header not yet whole. A message that ends inside a read gives its bytes back,
  // and if the read goes on into the next message, that message's deadline starts there.
  const watch = (ws, socket, address, { live = null } = {}) => {
    const who = plain(address !== undefined ? address : socket && socket.remoteAddress);
    let inMain = 0; let inSpare = 0; let timer = null; let ended = false;
    // the frame reader: `head` the header bytes so far, `left` the payload bytes still to come of the frame being read (-1: reading a header)
    const head = []; let left = -1; let control = false; let fin = false; let message = 0; let controlBytes = 0;
    const charged = () => inMain + inSpare;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const arm = () => { clear(); timer = setTimeout(end, messageMs); if (timer.unref) timer.unref(); open.delete(me); open.set(me, me); };
    const giveBack = (n) => {
      const fromSpare = Math.min(n, inSpare); inSpare -= fromSpare; spare -= fromSpare; add(spareBy, who, -fromSpare); n -= fromSpare;
      const fromMain = Math.min(n, inMain); inMain -= fromMain; main -= fromMain; add(mainBy, who, -fromMain);
    };
    const me = { who, end: () => { if (ended) release(); else end(); } };
    const release = () => { giveBack(charged()); clear(); open.delete(me); };
    function end() { if (ended) return; ended = true; release(); try { ws.terminate(); } catch { /* gone */ } try { socket.destroy(); } catch { /* gone */ } }
    // charge (or give back) the difference to `held`, the bytes of the open message and of a frame not yet whole
    const hold = (held) => {
      const n = held - charged();
      if (n < 0) return giveBack(-n);
      if (n === 0) return;
      for (;;) {
        if (main + n <= total && (mainBy.get(who) || 0) + n <= perAddress) { main += n; inMain += n; add(mainBy, who, n); return; }
        if (held <= smallMost && spare + n <= reserve && (spareBy.get(who) || 0) + n <= Math.floor(reserve / 2)) { spare += n; inSpare += n; add(spareBy, who, n); return; }
        if (!evictOldest) break;
        // only the address's own sockets free its share; only older messages go (`open` is in start order, so those before `me`)
        const ownShare = main + n <= total;
        let victim = null;
        for (const other of open.keys()) {
          if (other === me) break;
          if (ownShare && other.who !== who) continue;
          victim = other; break;
        }
        if (!victim) break;
        victim.end();
      }
      end();
    };
    const frameDone = () => {
      left = -1; head.length = 0;
      if (control) { controlBytes = 0; return false; }
      if (!fin) return false;
      message = 0; return true;                      // a whole message: its bytes are no longer held
    };
    const read = (c) => {
      let i = 0; let whole = false;
      while (i < c.length) {
        if (left < 0) {
          head.push(c[i++]);
          if (head.length < 2) continue;
          const len7 = head[1] & 0x7f;
          const need = 2 + (len7 === 126 ? 2 : len7 === 127 ? 8 : 0) + (head[1] & 0x80 ? 4 : 0);
          if (head.length < need) continue;
          const b = Buffer.from(head);
          left = len7 === 126 ? b.readUInt16BE(2) : len7 === 127 ? Number(b.readBigUInt64BE(2)) : len7;
          fin = (head[0] & 0x80) !== 0; control = (head[0] & 0x08) !== 0;
          if (control) controlBytes = need; else message += need;
          head.length = 0;
          if (left === 0 && frameDone()) whole = true;
          continue;
        }
        const n = Math.min(left, c.length - i); i += n; left -= n;
        if (control) controlBytes += n; else message += n;
        if (left === 0 && frameDone()) whole = true;
      }
      return whole;
    };
    socket.prependListener('data', (c) => {
      if (ended || (live && !live())) return;
      const whole = read(c);
      const held = message + controlBytes + head.length;
      if (held === 0) return release();
      if (whole || !timer) arm();                  // a message's deadline runs from its first byte
      hold(held);
    });
    ws.on('close', () => { ended = true; release(); });
    socket.on('close', () => { ended = true; release(); });
  };
  return { watch, held: () => ({ main, reserve: spare }) };
}
