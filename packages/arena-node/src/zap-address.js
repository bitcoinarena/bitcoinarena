// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * A LIGHTNING ADDRESS THAT TAKES ZAPS (NIP-57).
 *
 * LUD-16's `name@host` is `https://host/.well-known/lnurlp/name`. This answers there (and at `/lnurlp/name`) with a LUD-06
 * pay request that says `allowsNostr` and names this server's own Nostr key, and at its callback mints an invoice of exactly
 * the amount asked: under SHA-256 of the zap request's JSON when the callback carries one (`nostr`, checked as NIP-57
 * appendix D says), else under the address's own metadata - a plain tip. It then watches each zap invoice and, once it is
 * paid, signs the zap receipt (kind 9735) with its key and hands it to `publish` for the relays the request named.
 *
 * The Lightning side is injected: `invoice({ name, amountMsat, descriptionHash })` -> { request, paymentHash } and
 * `lookup({ name, paymentHash })` -> { settled, preimage, settledAtS }. The receipt is signed by `curve` with `secret`.
 * Pending zaps are kept in `statePath` (JSON) when one is given, so a restart still issues their receipts.
 * CORS is open: the page that zaps is served from another origin.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { zapRequestStands, zapReceiptTemplate, ZAP_COMMENT_MAX } from '../../arena-protocol/src/zap.js';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';
import { eventId } from './nostr-relay.js';

const OPEN = { 'access-control-allow-origin': '*' };
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const hex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const toHexB = (b) => Buffer.from(b).toString('hex');
// BOUNDS (kanban #1514): one signed zap request could be replayed at the callback without end, each call a new LND invoice, a new
// pending entry (one lookup every watchMs for an hour) and a whole rewrite of the state file. Open zaps are capped in total and per
// payer key, and the refusal log is a ring.
export const ZAP_PENDING_MAX = 1000;
export const ZAP_PENDING_PER_PAYER = 10;
export const ZAP_REFUSED_KEPT = 200;
// PLAIN TIPS TOO (kanban #1754): the callback without `nostr` needs no key and no signature, and each call was one more LND invoice
// (one `lncli addinvoice` child in tools/zap-address.mjs) with no bound at all. Open tip invoices (until their expiry) are capped
// like open zaps, and so are the tip invoices being made at once.
export const ZAP_TIPS_OPEN_MAX = ZAP_PENDING_MAX;
export const ZAP_TIPS_MINTING_MAX = 16;
// RECEIPTS DO NOT WAIT ON ANOTHER ZAP'S RELAYS (kanban #1828): the relays are the payer's own choice, and watch() used to await each
// publish before it looked at the next zap - one 1-sat zap naming 8 silent relays held every later receipt (and the expiry sweep)
// for 8 x 10 s. A paid zap's receipt is signed and kept at once; its publish runs beside the watcher, a few at a time, from a
// bounded queue (the oldest waiting one is dropped when it is full; the receipt itself stays in `receipts`).
// ONE LANE PER RELAY HOST, AND NO RECEIPT DROPPED UNSENT (kanban #2249, #2261, #1489 a45-refute-17): that queue was one FIFO with 4
// shared slots, each held as long as the payer's relays took, so 4 one-sat zaps naming a silent relay held every later receipt for
// 10 s (K zaps: ceil(K/4) x 10 s), and 1000 more pushed a waiting honest receipt out of the queue, never to be sent. Now each
// (receipt, relay) is its own send, queued in the lane of the relay's host (hostname and effective port, #2398): at most
// ZAP_PUBLISH_PER_HOST sends to one host at once, ZAP_PUBLISH_PARALLEL in all, lanes taken in turn. A host whose last send took
// ZAP_PUBLISH_SLOW_MS or more (or failed) is not proven, and hosts not proven share all but ZAP_PUBLISH_RESERVED of the slots, so a
// payer's silent hosts cannot hold the sends to relays that answer. Receipts still owed a send are kept in the state file
// (`owed`) and published again after a restart; a send whose publish throws is tried again on a backoff, up to
// ZAP_PUBLISH_TRIES. When more than ZAP_PUBLISH_QUEUED sends wait, one is parked, not shed (kanban #2362, below).
export const ZAP_PUBLISH_PARALLEL = 32;
export const ZAP_PUBLISH_PER_HOST = 2;
export const ZAP_PUBLISH_RESERVED = 8;
export const ZAP_PUBLISH_SLOW_MS = 3000;
export const ZAP_PUBLISH_QUEUED = 1000;
export const ZAP_PUBLISH_PARKED = 8000;
export const ZAP_PUBLISH_TRIES = 6;
export const ZAP_PUBLISH_RETRY_MS = 30000;
const HOSTS_KEPT = 4096;

/** What a plain (not zap) tip's invoice is hashed over (LUD-06: raw JSON, text/plain first, the address as text/identifier). */
export const addressMetadata = (name, host) => JSON.stringify([['text/plain', `Zap ${name}@${host}`], ['text/identifier', `${name}@${host}`]]);

/** Signs an unsigned event `{ kind, created_at?, tags, content }` with `secret` (BIP-340 via `curve`). */
export function signNostr(template, { secret, curve, nowS = Math.floor(Date.now() / 1000) }) {
  const e = { pubkey: toHexB(curve.pointX(secret)), created_at: template.created_at ?? nowS, kind: template.kind, tags: template.tags, content: template.content };
  e.id = eventId(e);
  e.sig = toHexB(curve.signSchnorr(hex(e.id), secret));
  return e;
}

export function serveZapAddresses({ host = '127.0.0.1', port = 0, publicHost, publicBase = null, names, secret, curve, invoice, lookup, publish,
  statePath = null, minSendable = 1000, maxSendable = 100000000, watchMs = 2000, expiryS = 3600, log = () => {} } = {}) {
  if (!publicHost) throw new Error('a Lightning address names its public host');
  if (!secret || !curve) throw new Error('a zap address signs its receipts, and was handed no key');
  const nostrPubkey = toHexB(curve.pointX(secret));
  const base = publicBase || `https://${publicHost}`;
  const verify = (sig, msg, key) => { try { return curve.verify(sig, msg, key) === true; } catch { return false; } };
  const pending = new Map();          // paymentHash -> { name, request, description, invoice, until }
  const receipts = [];
  const refused = [];
  const minting = new Set();          // zap request ids whose invoice is being made right now (kanban #1514)
  const tips = new Map();             // paymentHash -> until, each plain tip invoice still open (kanban #1754)
  let tipsMinting = 0;                // plain tip invoices being made right now (kanban #1754)
  const pruneTips = (nowS) => { for (const [h, until] of tips) if (until < nowS) tips.delete(h); };
  const requestOf = (p) => { try { return JSON.parse(p.description); } catch { return {}; } };
  const owed = new Map();             // receipt id -> { receipt, relays: [relay still owed a send] } (kanban #2249)
  let loadedOwed = [];
  if (statePath && existsSync(statePath)) {
    try {
      const st = JSON.parse(readFileSync(statePath, 'utf8'));
      for (const p of st.pending || []) pending.set(p.paymentHash, p);
      loadedOwed = Array.isArray(st.owed) ? st.owed : [];
    } catch { /* a bad file starts empty */ }
  }
  let saveTimer = null;
  const save = () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!statePath) return;
    writeFileSync(`${statePath}.tmp`, JSON.stringify({ pending: [...pending.values()], owed: [...owed.values()] }));
    renameSync(`${statePath}.tmp`, statePath);
  };
  // the owed list changes once per send: written at most once a second, not on every answer
  const saveSoon = () => { if (!statePath || saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; save(); }, 1000); saveTimer.unref(); };

  // PUBLISH LANES (kanban #2249, #2261): host -> { queue: [{ receipt, relay, tries, payer, seq }], flying }
  // PROVEN PER RELAY URL, SLOW SENDS LEAVE THE RESERVE, NOTHING SHED UNSENT (kanban #2362, #2371, #2376, #1489 a45-refute-17-s2):
  // - `proven` is keyed by the exact relay URL (normalized), not by host: a stranger's wss:// (or other path) URL to an honest
  //   relay's host:port fails on its own and no longer unproves the honest ws:// URL. The per-host concurrency cap stays per host.
  // - a proven send still in flight after ZAP_PUBLISH_SLOW_MS is moved to the unproven pool at once (its URL marked not proven):
  //   proven-then-silent relays cannot hold the reserved slots for the whole timeout, and a send to a proven URL may start while
  //   at most ZAP_PUBLISH_PARALLEL - ZAP_PUBLISH_RESERVED unproven sends count against the total, so the reserve stays free.
  // - over ZAP_PUBLISH_QUEUED waiting sends nothing is settled unsent: the send of the payer key with the most waiting sends (the
  //   newest on a tie) is PARKED - still owed, still in the state file - and queued again when there is room. Only past
  //   ZAP_PUBLISH_PARKED parked sends is one given up (logged), again the most numerous payer's newest.
  // A LANE IS ONE SOCKET, AND ITS HEAD DOES NOT HOLD A PROVEN SEND (kanban #2398, #2399, #1489 a45-refute-17-s3):
  // - the lane key is hostname + effective port (80 for ws:/http:, 443 for wss:/https: when the URL leaves it out): URL.host drops a
  //   default port, so ws://relay.x/ and wss://relay.x/ (two sockets) shared one lane and its per-host cap, and a stranger's silent
  //   port-80 URLs held the honest wss:// relay.
  // - pump() no longer judges a lane by its head: it takes the lane's first send that may start now, so a proven URL's send starts
  //   from the reserve whatever unproven sends stand before it in the queue. A lane caps proven and unproven sends apart (each
  //   ZAP_PUBLISH_PER_HOST at once), so unproven sends to a host never take the slots of a proven URL on that host.
  const lanes = new Map();
  const proven = new Map();           // relay URL -> true when its last send answered within ZAP_PUBLISH_SLOW_MS (a bounded ring)
  const retries = new Set();
  const slowTimers = new Set();
  const parked = [];                  // sends owed but waiting outside the lanes (kanban #2362)
  let flying = 0, flyingUnproven = 0, queued = 0, seq = 0, closed = false;
  const UNPROVEN_SLOTS = ZAP_PUBLISH_PARALLEL - ZAP_PUBLISH_RESERVED;
  const DEFAULT_PORT = { 'ws:': '80', 'http:': '80', 'wss:': '443', 'https:': '443' };
  const hostOf = (relay) => {
    try {
      const u = new URL(relay);
      if (!u.hostname) return String(relay);
      return `${u.hostname.toLowerCase()}:${u.port || DEFAULT_PORT[u.protocol] || ''}`;
    } catch { return String(relay); }
  };
  const urlOf = (relay) => { try { return new URL(relay).href; } catch { return String(relay); } };
  const payerOf = (receipt) => {
    try { const d = receipt.tags.find((t) => t[0] === 'description'); return String(JSON.parse(d[1]).pubkey || ''); } catch { return ''; }
  };
  const lane = (host) => { let l = lanes.get(host); if (!l) { l = { queue: [], flying: 0, flyingGood: 0, flyingBad: 0 }; lanes.set(host, l); } return l; };
  const settle = (job) => {           // this relay is no longer owed a send for this receipt
    const o = owed.get(job.receipt.id);
    if (!o) return;
    o.relays = o.relays.filter((r) => r !== job.relay);
    if (!o.relays.length) owed.delete(job.receipt.id);
    saveSoon();
  };
  const markUrl = (url, ok) => { proven.delete(url); proven.set(url, ok); if (proven.size > HOSTS_KEPT) proven.delete(proven.keys().next().value); };
  const roomFor = (good) => (good
    ? (flying - flyingUnproven) + Math.min(flyingUnproven, UNPROVEN_SLOTS) < ZAP_PUBLISH_PARALLEL
    : flying < ZAP_PUBLISH_PARALLEL && flyingUnproven < UNPROVEN_SLOTS);
  const pump = () => {
    if (closed) return;
    while (parked.length && queued < ZAP_PUBLISH_QUEUED) { const job = parked.shift(); lane(job.host).queue.push(job); queued++; }
    let moved = true;
    while (moved && queued) {
      moved = false;
      for (const [host, l] of [...lanes]) {          // each lane in turn, one send each pass
        if (!roomFor(true)) break;
        if (!l.queue.length) { if (!l.flying) lanes.delete(host); continue; }
        const roomGood = l.flyingGood < ZAP_PUBLISH_PER_HOST;
        const roomBad = l.flyingBad < ZAP_PUBLISH_PER_HOST && roomFor(false);
        if (!roomGood && !roomBad) continue;
        let i = -1, good = false;           // the lane's first send that may start now (kanban #2398)
        for (let k = 0; k < l.queue.length; k++) {
          const g = proven.get(l.queue[k].url) === true;
          if (g ? roomGood : roomBad) { i = k; good = g; break; }
        }
        if (i < 0) continue;
        const job = l.queue.splice(i, 1)[0]; queued--;
        lanes.delete(host); lanes.set(host, l);   // to the back of the turn
        start(l, job, good);
        moved = true;
      }
    }
  };
  const start = (l, job, good) => {
    const url = job.url;
    const run = { good };
    flying++; l.flying++; if (good) l.flyingGood++; else { flyingUnproven++; l.flyingBad++; }
    const t0 = Date.now();
    let slow = null;
    if (good) {                       // still in flight after SLOW_MS: no longer proven, out of the reserve (kanban #2371)
      slow = setTimeout(() => {
        slowTimers.delete(slow); slow = null;
        if (!run.good) return;
        run.good = false; flyingUnproven++; l.flyingGood--; l.flyingBad++; markUrl(url, false);
        log(`publish ${job.receipt.id.slice(0, 16)} -> ${job.relay} slow; that relay is not proven`);
        pump();
      }, ZAP_PUBLISH_SLOW_MS);
      slow.unref(); slowTimers.add(slow);
    }
    Promise.resolve().then(() => publish(job.receipt, [job.relay]))
      .then(() => { markUrl(url, Date.now() - t0 < ZAP_PUBLISH_SLOW_MS); settle(job); },
        (e) => {
          markUrl(url, false);
          job.tries++;
          if (job.tries >= ZAP_PUBLISH_TRIES) { log(`publish ${job.receipt.id.slice(0, 16)} -> ${job.relay} given up after ${job.tries} tries: ${e && e.message}`); settle(job); return; }
          log(`publish ${job.receipt.id.slice(0, 16)} -> ${job.relay} failed (${e && e.message}); again later`);
          const t = setTimeout(() => { retries.delete(t); push(job); pump(); }, ZAP_PUBLISH_RETRY_MS * 2 ** (job.tries - 1));
          t.unref(); retries.add(t);
        })
      .finally(() => {
        if (slow) { clearTimeout(slow); slowTimers.delete(slow); }
        flying--; l.flying--; if (run.good) l.flyingGood--; else { flyingUnproven--; l.flyingBad--; }
        pump();
      });
  };
  // the send to put aside: of the payer key with the most sends in `jobs`, its newest (the newest overall on a tie)
  const pick = (jobs) => {
    const count = new Map();
    for (const j of jobs) count.set(j.payer, (count.get(j.payer) || 0) + 1);
    let worst = null;
    for (const j of jobs) {
      if (!worst) { worst = j; continue; }
      const cj = count.get(j.payer), cw = count.get(worst.payer);
      if (cj > cw || (cj === cw && j.seq > worst.seq)) worst = j;
    }
    return worst;
  };
  const push = (job) => {
    if (job.seq === undefined) { job.seq = ++seq; job.payer = payerOf(job.receipt); }
    if (job.host === undefined) { job.host = hostOf(job.relay); job.url = urlOf(job.relay); }
    lane(job.host).queue.push(job); queued++;
    while (queued > ZAP_PUBLISH_QUEUED) {     // park (not shed) the most numerous payer's newest send (kanban #2362)
      const all = []; for (const l of lanes.values()) for (const j of l.queue) all.push(j);
      const out = pick(all);
      const l = lanes.get(out.host);
      l.queue.splice(l.queue.indexOf(out), 1); queued--;
      parked.push(out);
    }
    while (parked.length > ZAP_PUBLISH_PARKED) {
      const out = pick(parked);
      parked.splice(parked.indexOf(out), 1);
      log(`publish ${out.receipt.id.slice(0, 16)} -> ${out.relay} given up: ${ZAP_PUBLISH_PARKED} sends are parked, most of them that payer's`);
      settle(out);
    }
  };
  const enqueuePublish = (receipt, relays) => {
    if (typeof publish !== 'function') return;
    const named = [...new Set(relays.map(String))];
    owed.set(receipt.id, { receipt, relays: named });
    for (const relay of named) push({ receipt, relay, tries: 0 });
    saveSoon();
    pump();
  };
  for (const o of loadedOwed) {       // a restart sends what it still owed
    if (o && o.receipt && typeof o.receipt.id === 'string' && Array.isArray(o.relays) && o.relays.length) {
      receipts.push(o.receipt);
      enqueuePublish(o.receipt, o.relays);
    }
  }

  async function watch() {
    const nowS = Math.floor(Date.now() / 1000);
    for (const [hash, p] of pending) {
      let got;
      try { got = await lookup({ name: p.name, paymentHash: hash }); } catch (e) { log(`lookup ${hash.slice(0, 16)} failed: ${e.message}`); continue; }
      if (got && got.settled) await paid(hash, p, got, nowS);
      else if (p.until < nowS) { pending.delete(hash); save(); log(`zap ${hash.slice(0, 16)} expired unpaid`); }
    }
  }
  async function paid(hash, p, got, nowS) {
    const receipt = signNostr(zapReceiptTemplate({ request: JSON.parse(p.description), description: p.description, invoice: p.invoice,
      preimage: got.preimage || null, paidAtS: got.settledAtS || nowS }), { secret, curve });
    receipts.push(receipt);
    enqueuePublish(receipt, p.relays);   // not awaited: no receipt waits on another zap's relays (kanban #1828, #2249)
    pending.delete(hash); save();        // one write: the zap leaves pending as its receipt enters owed (kanban #2249)
    log(`zap paid ${p.name} ${hash.slice(0, 16)} -> receipt ${receipt.id.slice(0, 16)}`);
  }
  // THE CAP EVICTS, IT DOES NOT REFUSE (kanban #1619): the per-payer bound counts by the zap request's pubkey, and Nostr keys are
  // free - 100 fresh keys x 10 unpaid requests filled ZAP_PENDING_MAX and refused every honest zap for expiryS (an hour), for
  // nothing. At the cap the OLDEST open zap is dropped instead (an unpaid invoice just expires at LND), after one last lookup so a
  // zap that was paid meanwhile still gets its receipt.
  function evictOldest() {
    const [hash, p] = pending.entries().next().value;
    pending.delete(hash); save();
    log(`zap ${hash.slice(0, 16)} dropped at the open-zap cap`);
    lookup({ name: p.name, paymentHash: hash })
      .then((got) => (got && got.settled ? paid(hash, p, got, Math.floor(Date.now() / 1000)) : null))
      .catch((e) => log(`lookup ${hash.slice(0, 16)} failed: ${e.message}`));
  }
  let busy = false;
  const timer = setInterval(() => { if (busy) return; busy = true; watch().finally(() => { busy = false; }); }, watchMs);
  timer.unref();

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', ...OPEN }); res.end(JSON.stringify(body)); };
      const refuse = (reason) => { refused.push(reason); if (refused.length > ZAP_REFUSED_KEPT) refused.splice(0, refused.length - ZAP_REFUSED_KEPT); return json(200, { status: 'ERROR', reason }); };
      if (req.method === 'OPTIONS') { res.writeHead(204, { ...OPEN, 'access-control-allow-methods': 'GET' }); return res.end(); }
      const u = new URL(req.url, 'http://local');
      const m = u.pathname.match(/^(?:\/\.well-known)?\/lnurlp\/([a-z0-9._-]+)(\/cb)?$/);
      if (req.method !== 'GET' || !m || !names.includes(m[1])) return json(404, { status: 'ERROR', reason: 'no such address here' });
      const name = m[1];
      const metadata = addressMetadata(name, publicHost);
      if (!m[2]) {
        return json(200, { tag: 'payRequest', callback: `${base}/lnurlp/${name}/cb`, metadata, minSendable, maxSendable,
          commentAllowed: ZAP_COMMENT_MAX, allowsNostr: true, nostrPubkey });
      }
      const said = u.searchParams.get('amount') || '';
      if (!/^\d{1,15}$/.test(said)) return refuse('the amount is a whole number of millisatoshi');
      const amountMsat = BigInt(said);
      if (amountMsat < BigInt(minSendable) || amountMsat > BigInt(maxSendable)) return refuse(`${amountMsat} msat is outside ${minSendable}..${maxSendable}`);
      const description = u.searchParams.get('nostr');
      let zap = null;
      if (description !== null) {
        let request;
        try { request = JSON.parse(description); } catch { return refuse('the nostr parameter is not a JSON event'); }
        const stands = zapRequestStands(request, { amountMsat, verify });
        if (!stands.ok) return refuse(stands.why);
        // THE ADDRESS'S OWN URL (LUD-16: https://host/.well-known/lnurlp/name), or the pay request's under the public base -
        // measured live: with the callback under a path (/zap) the request's lnurl names the host's well-known URL, not the base's
        const lnurl = u.searchParams.get('lnurl');
        const ours = [`https://${publicHost}/.well-known/lnurlp/${name}`, `${base}/.well-known/lnurlp/${name}`, `${base}/lnurlp/${name}`]
          .map((x) => lnurlFor(x).toLowerCase());
        if (lnurl && !ours.includes(lnurl.toLowerCase())) return refuse('that lnurl is not this address');
        zap = { request, relays: stands.relays };
        // ONE SIGNED ZAP REQUEST, ONE OPEN INVOICE (kanban #1514): a request already invoiced and still open gets that invoice again
        // (the same name and amount) and is refused otherwise; a new one waits for room under the caps.
        const open = [...pending.values()].map((p) => [p, requestOf(p)]);
        const same = open.find(([, r]) => r.id === request.id);
        if (same) {
          if (same[0].name === name && same[0].amountMsat === String(amountMsat) && same[0].until >= Math.floor(Date.now() / 1000)) return json(200, { pr: same[0].invoice, routes: [] });
          return refuse('that zap request is already invoiced');
        }
        if (minting.has(request.id)) return refuse('that zap request is being invoiced; ask again');
        if (open.filter(([, r]) => r.pubkey === request.pubkey).length >= ZAP_PENDING_PER_PAYER) return refuse('too many open zaps from that key');
        while (pending.size > 0 && pending.size + minting.size >= ZAP_PENDING_MAX) evictOldest();
        if (pending.size + minting.size >= ZAP_PENDING_MAX) return refuse('too many zaps are open here; try again later');
      } else {
        const comment = u.searchParams.get('comment');
        if (comment && comment.length > ZAP_COMMENT_MAX) return refuse(`a comment is at most ${ZAP_COMMENT_MAX} characters`);
        pruneTips(Math.floor(Date.now() / 1000));
        if (tipsMinting >= ZAP_TIPS_MINTING_MAX) return refuse('too many tips are being invoiced right now; ask again');
        if (tips.size + tipsMinting >= ZAP_TIPS_OPEN_MAX) return refuse('too many tips are open here; try again later');
      }
      let made;
      if (zap) minting.add(zap.request.id); else tipsMinting++;
      try { made = await invoice({ name, amountMsat, descriptionHash: hex(sha256hex(zap ? description : metadata)), expiryS }); }
      catch (e) { return refuse(`no invoice was made: ${String(e.message).slice(0, 160)}`); }
      finally { if (zap) minting.delete(zap.request.id); else tipsMinting--; }
      if (!zap) tips.set(String(made.paymentHash), Math.floor(Date.now() / 1000) + expiryS);
      if (zap) {
        pending.set(made.paymentHash, { paymentHash: made.paymentHash, name, description, relays: zap.relays, invoice: made.request,
          amountMsat: String(amountMsat), until: Math.floor(Date.now() / 1000) + expiryS });
        save();
        log(`zap invoice ${name} ${amountMsat} msat ${made.paymentHash.slice(0, 16)} from ${zap.request.pubkey.slice(0, 16)}`);
      } else log(`tip invoice ${name} ${amountMsat} msat ${made.paymentHash.slice(0, 16)}`);
      return json(200, { pr: made.request, routes: [] });
    });
    server.on('error', reject);
    server.listen(port, host, () => resolve({ port: server.address().port, nostrPubkey, pending, receipts, refused, watch,
      close: () => new Promise((r) => { closed = true; clearInterval(timer); for (const t of retries) clearTimeout(t); for (const t of slowTimers) clearTimeout(t); if (saveTimer) save(); server.close(r); }) }));
  });
}
