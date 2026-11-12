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
import { askerAddress } from './reach-check.js';

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
export const ZAP_PUBLISH_PARALLEL = 4;
export const ZAP_PUBLISH_QUEUED = 1000;
// HOLDING FOR GOOD (kanban #1683, #1743, #1801): the caps above had three ways round them.
// - The per-payer cap counted only invoiced zaps, so one key's requests sent at once all passed it while LND was minting: the
//   requests being minted now count against their payer too (`minting` maps request id -> payer key).
// - Keys cost nothing, so a full ZAP_PENDING_MAX refused every honest zap for the hour the strangers' invoices stayed open: a full
//   book now gives way - the oldest open zap is let go (looked up once more, so one paid at that moment still gets its receipt) and
//   the new one is taken. Nobody can hold the book shut; what stays bounded is the book itself.
// - The plain tip callback minted one invoice per call: a tip of the same name and amount gets the open, unpaid invoice again
//   (looked up first; ZAP_TIPS_KEPT of them kept, asks at the same moment share one mint).
// - And what any one asker can mint at all is bounded: ZAP_MINTS_PER_ASKER fresh invoices (zap or tip) per ZAP_ASKER_WINDOW_S, the
//   asker being the address the proxy in front saw (reach-check.js askerAddress: cf-connecting-ip, else the first X-Forwarded-For
//   hop). A caller on this machine itself, with no proxy header, is this host's own tools and is not limited.
export const ZAP_TIPS_KEPT = 256;
export const ZAP_MINTS_PER_ASKER = 30;
export const ZAP_ASKER_WINDOW_S = 600;
export const ZAP_ASKERS_KEPT = 4096;
// FOR GOOD, AGAIN (kanban #1922, #1964, #1999; #1489 v1-refute-19-s2):
// - A zap let go from a full book could still be paid at LND, and was never looked up again: an honest zap paid after strangers filled
//   the book got no receipt. A let-go zap is now WATCHED UNTIL ITS INVOICE EXPIRES (`letGo`, saved with the book, looked up by watch()
//   like every open zap); nothing open is dropped before expiry. When the book and the let-go list are both full, a new zap is refused.
// - The asker is an IPv4 address or an IPv6 /64 (one /64 holds 2^64 addresses, each its own asker before), and on top of the
//   per-asker bound all callers that are not this host together mint at most ZAP_MINTS_ALL fresh invoices per window, so rotating
//   askers cannot exceed it: strangers alone keep at most ZAP_MINTS_ALL * (expiry / window + 1) zaps open, under the let-go room.
// - The asker table never drops a live window: when it is full of them, a new asker is refused.
// - A plain tip invoice is handed again only to the asker that got it (asker|name|amount): two tippers of the same amount are never
//   handed one bolt11 that only the first could pay.
export const ZAP_LET_GO_MAX = 4000;
export const ZAP_MINTS_ALL = 300;

/** The asker a mint is counted against: an IPv4 address as it is, an IPv6 address by its /64 (kanban #1964). */
export function askerKey(a) {
  const s = String(a || '').split('%')[0].toLowerCase();
  if (!s.includes(':')) return s;
  let t = s;
  const v4 = t.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) { const o = v4[2].split('.').map(Number); t = `${v4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`; }
  const halves = t.split('::');
  if (halves.length > 2) return s;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return s;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return s;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

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
  const minting = new Map();          // zap request id -> payer pubkey, whose invoice is being made right now (kanban #1514, #1683)
  const tips = new Map();             // paymentHash -> until, each plain tip invoice still open (kanban #1754)
  let tipsMinting = 0;                // plain tip invoices being made right now (kanban #1754)
  const pruneTips = (nowS) => { for (const [h, until] of tips) if (until < nowS) tips.delete(h); };
  const tipKept = new Map();          // `${name}|${amountMsat}` -> { request, paymentHash, until }: open plain-tip invoices handed again (kanban #1801)
  const tipMinting = new Map();       // the same key -> the mint in flight, which asks at the same moment share (kanban #1801)
  const askers = new Map();           // asker key (IPv4, IPv6 /64) -> { since, n }: fresh invoices minted for it in this window (kanban #1743, #1801, #1964)
  const letGo = new Map();            // paymentHash -> the zap let go from a full book, watched until its invoice expires (kanban #1922)
  let mintsAll = [];                  // when each fresh invoice for a caller not on this host was minted, the last window's (kanban #1964)
  const nowSec = () => Math.floor(Date.now() / 1000);
  const local = (a) => a === '127.0.0.1' || a === '::1';
  // '' when it may mint (and is counted), else why not
  const mayMint = (asker) => {
    if (local(asker)) return '';
    const now = nowSec();
    const who = askerKey(asker);
    let a = askers.get(who);
    if (a && now - a.since >= ZAP_ASKER_WINDOW_S) { askers.delete(who); a = null; }
    if (a && a.n >= ZAP_MINTS_PER_ASKER) return `at most ${ZAP_MINTS_PER_ASKER} invoices per ${ZAP_ASKER_WINDOW_S / 60} minutes from one address`;
    mintsAll = mintsAll.filter((t) => now - t < ZAP_ASKER_WINDOW_S);
    if (mintsAll.length >= ZAP_MINTS_ALL) return `this Lightning address mints at most ${ZAP_MINTS_ALL} invoices per ${ZAP_ASKER_WINDOW_S / 60} minutes; try again later`;
    if (!a) {
      if (askers.size >= ZAP_ASKERS_KEPT) for (const [k, v] of askers) if (now - v.since >= ZAP_ASKER_WINDOW_S) askers.delete(k);
      if (askers.size >= ZAP_ASKERS_KEPT) return 'too many addresses are asking here; try again later';   // a live window is never dropped
      a = { since: now, n: 0 }; askers.set(who, a);
    }
    a.n++;
    mintsAll.push(now);
    return '';
  };
  const requestOf = (p) => { try { return JSON.parse(p.description); } catch { return {}; } };
  if (statePath && existsSync(statePath)) {
    try {
      const st = JSON.parse(readFileSync(statePath, 'utf8'));
      for (const p of st.pending || []) pending.set(p.paymentHash, p);
      for (const p of st.letGo || []) letGo.set(p.paymentHash, p);
    } catch { /* a bad file starts empty */ }
  }
  const save = () => {
    if (!statePath) return;
    writeFileSync(`${statePath}.tmp`, JSON.stringify({ pending: [...pending.values()], letGo: [...letGo.values()] }));
    renameSync(`${statePath}.tmp`, statePath);
  };

  const publishQueue = [];
  let publishing = 0;
  const pump = () => {
    while (publishing < ZAP_PUBLISH_PARALLEL && publishQueue.length) {
      const [receipt, relays] = publishQueue.shift();
      publishing++;
      Promise.resolve().then(() => publish(receipt, relays))
        .catch((e) => log(`publish ${receipt.id.slice(0, 16)} failed: ${e.message}`))
        .finally(() => { publishing--; pump(); });
    }
  };
  const enqueuePublish = (receipt, relays) => {
    if (typeof publish !== 'function') return;
    publishQueue.push([receipt, relays]);
    if (publishQueue.length > ZAP_PUBLISH_QUEUED) { const [old] = publishQueue.shift(); log(`publish ${old.id.slice(0, 16)} dropped: the queue is full`); }
    pump();
  };

  async function watch() {
    const nowS = nowSec();
    for (const [hash, p] of [...pending, ...letGo]) {
      let got;
      try { got = await lookup({ name: p.name, paymentHash: hash }); } catch (e) { log(`lookup ${hash.slice(0, 16)} failed: ${e.message}`); continue; }
      // where it is now: it may have been let go, or receipted by another look, meanwhile (kanban #1743, #1922)
      const book = pending.get(hash) === p ? pending : letGo.get(hash) === p ? letGo : null;
      if (!book) continue;
      if (got && got.settled) { book.delete(hash); save(); await paid(hash, p, got, nowS); }
      else if (p.until < nowS) { book.delete(hash); save(); log(`zap ${hash.slice(0, 16)} expired unpaid`); }
    }
  }
  async function paid(hash, p, got, nowS) {
    const receipt = signNostr(zapReceiptTemplate({ request: JSON.parse(p.description), description: p.description, invoice: p.invoice,
      preimage: got.preimage || null, paidAtS: got.settledAtS || nowS }), { secret, curve });
    pending.delete(hash); save();
    receipts.push(receipt);
    log(`zap paid ${p.name} ${hash.slice(0, 16)} -> receipt ${receipt.id.slice(0, 16)}`);
    enqueuePublish(receipt, p.relays);   // not awaited (kanban #1828)
  }
  // A FULL BOOK GIVES WAY (kanban #1743) - BUT NOTHING OPEN IS DROPPED (kanban #1922): the oldest open zap moves to `letGo`, which
  // watch() keeps looking up until its invoice expires; it also gets one look at once, so a payment landing now is receipted now.
  function letGoOldest() {
    const first = pending.entries().next();
    if (first.done) return false;
    const [hash, p] = first.value;
    pending.delete(hash);
    letGo.set(hash, p);
    log(`zap ${hash.slice(0, 16)} let go from the full book: watched until it expires`);
    (async () => {
      try {
        const got = await lookup({ name: p.name, paymentHash: hash });
        if (got && got.settled && letGo.get(hash) === p) { letGo.delete(hash); save(); await paid(hash, p, got, nowSec()); }
      } catch (e) { log(`last lookup ${hash.slice(0, 16)} failed: ${e.message}`); }
    })();
    return true;
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
      const asker = askerAddress(req);
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
        const open = [...pending.values(), ...letGo.values()].map((p) => [p, requestOf(p)]);
        const same = open.find(([, r]) => r.id === request.id);
        if (same) {
          if (same[0].name === name && same[0].amountMsat === String(amountMsat) && same[0].until >= nowSec()) return json(200, { pr: same[0].invoice, routes: [] });
          return refuse('that zap request is already invoiced');
        }
        if (minting.has(request.id)) return refuse('that zap request is being invoiced; ask again');
        // the payer's open zaps AND the ones being minted for it now (kanban #1683)
        const fromPayer = open.filter(([, r]) => r.pubkey === request.pubkey).length + [...minting.values()].filter((k) => k === request.pubkey).length;
        if (fromPayer >= ZAP_PENDING_PER_PAYER) return refuse('too many open zaps from that key');
        if (minting.size >= ZAP_PENDING_MAX) return refuse('too many zaps are being invoiced here; try again later');
        // every open zap is watched until it expires (kanban #1922): with the book and the let-go room both full, a new one waits
        if (pending.size + letGo.size + minting.size >= ZAP_PENDING_MAX + ZAP_LET_GO_MAX) return refuse('the book of open zaps is full; try again later');
        const no = mayMint(asker);
        if (no) return refuse(no);
        minting.set(request.id, request.pubkey);
        let made;
        try { made = await invoice({ name, amountMsat, descriptionHash: hex(sha256hex(description)), expiryS }); }
        catch (e) { return refuse(`no invoice was made: ${String(e.message).slice(0, 160)}`); }
        finally { minting.delete(request.id); }
        while (pending.size >= ZAP_PENDING_MAX && letGoOldest()) { /* kanban #1743 */ }
        pending.set(made.paymentHash, { paymentHash: made.paymentHash, name, description, relays: zap.relays, invoice: made.request,
          amountMsat: String(amountMsat), until: nowSec() + expiryS });
        save();
        log(`zap invoice ${name} ${amountMsat} msat ${made.paymentHash.slice(0, 16)} from ${zap.request.pubkey.slice(0, 16)}`);
        return json(200, { pr: made.request, routes: [] });
      }
      const comment = u.searchParams.get('comment');
      if (comment && comment.length > ZAP_COMMENT_MAX) return refuse(`a comment is at most ${ZAP_COMMENT_MAX} characters`);
      // A PLAIN TIP (kanban #1801): its invoice is hashed over the address's metadata only, so one of the same name and amount, still
      // open and unpaid, serves the next tipper as well as a new one would; asks at the same moment share one mint
      const key = `${local(asker) ? asker : askerKey(asker)}|${name}|${amountMsat}`;   // one asker's own invoice only (kanban #1999)
      const kept = tipKept.get(key);
      if (kept && kept.until - nowSec() >= expiryS / 2) {
        let got = null;
        try { got = await lookup({ name, paymentHash: kept.paymentHash }); } catch (e) { log(`lookup ${kept.paymentHash.slice(0, 16)} failed: ${e.message}`); }
        if (got && !got.settled && tipKept.get(key) === kept) return json(200, { pr: kept.request, routes: [] });
      }
      if (tipKept.get(key) === kept) tipKept.delete(key);
      let mint = tipMinting.get(key);
      if (!mint) {
        pruneTips(nowSec());
        if (tipsMinting >= ZAP_TIPS_MINTING_MAX) return refuse('too many tips are being invoiced right now; ask again');
        if (tips.size + tipsMinting >= ZAP_TIPS_OPEN_MAX) return refuse('too many tips are open here; try again later');
        { const no = mayMint(asker); if (no) return refuse(no); }
        tipsMinting++;
        mint = invoice({ name, amountMsat, descriptionHash: hex(sha256hex(metadata)), expiryS }).then((made) => {
          tips.set(String(made.paymentHash), nowSec() + expiryS);
          tipKept.delete(key);
          tipKept.set(key, { request: made.request, paymentHash: made.paymentHash, until: nowSec() + expiryS });
          while (tipKept.size > ZAP_TIPS_KEPT) tipKept.delete(tipKept.keys().next().value);
          log(`tip invoice ${name} ${amountMsat} msat ${made.paymentHash.slice(0, 16)}`);
          return made;
        }).finally(() => { tipsMinting--; tipMinting.delete(key); });
        tipMinting.set(key, mint);
      }
      let made;
      try { made = await mint; } catch (e) { return refuse(`no invoice was made: ${String(e.message).slice(0, 160)}`); }
      return json(200, { pr: made.request, routes: [] });
    });
    server.on('error', reject);
    server.listen(port, host, () => resolve({ port: server.address().port, nostrPubkey, pending, letGo, receipts, refused, watch,
      close: () => new Promise((r) => { clearInterval(timer); server.close(r); }) }));
  });
}
