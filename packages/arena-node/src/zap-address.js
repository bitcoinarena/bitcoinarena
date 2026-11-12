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
  const tips = new Map();             // `${name}|${amountMsat}` -> { request, paymentHash, until }: open plain-tip invoices (kanban #1801)
  const tipMinting = new Map();       // the same key -> the mint in flight, which asks at the same moment share
  const askers = new Map();           // asker address -> { since, n }: fresh invoices minted for it in this window (kanban #1743, #1801)
  const nowSec = () => Math.floor(Date.now() / 1000);
  const local = (a) => a === '127.0.0.1' || a === '::1';
  const mayMint = (asker) => {
    if (local(asker)) return true;
    const now = nowSec();
    let a = askers.get(asker);
    if (a && now - a.since >= ZAP_ASKER_WINDOW_S) { askers.delete(asker); a = null; }
    if (!a) {
      if (askers.size >= ZAP_ASKERS_KEPT) for (const [k, v] of askers) if (now - v.since >= ZAP_ASKER_WINDOW_S) askers.delete(k);
      while (askers.size >= ZAP_ASKERS_KEPT) askers.delete(askers.keys().next().value);
      a = { since: now, n: 0 }; askers.set(asker, a);
    }
    if (a.n >= ZAP_MINTS_PER_ASKER) return false;
    a.n++;
    return true;
  };
  const requestOf = (p) => { try { return JSON.parse(p.description); } catch { return {}; } };
  if (statePath && existsSync(statePath)) {
    try { for (const p of JSON.parse(readFileSync(statePath, 'utf8')).pending || []) pending.set(p.paymentHash, p); } catch { /* a bad file starts empty */ }
  }
  const save = () => {
    if (!statePath) return;
    writeFileSync(`${statePath}.tmp`, JSON.stringify({ pending: [...pending.values()] }));
    renameSync(`${statePath}.tmp`, statePath);
  };

  async function paid(hash, p, got, nowS) {
    const receipt = signNostr(zapReceiptTemplate({ request: JSON.parse(p.description), description: p.description, invoice: p.invoice,
      preimage: got.preimage || null, paidAtS: got.settledAtS || nowS }), { secret, curve });
    receipts.push(receipt);
    log(`zap paid ${p.name} ${hash.slice(0, 16)} -> receipt ${receipt.id.slice(0, 16)}`);
    try { await publish(receipt, p.relays); } catch (e) { log(`publish ${receipt.id.slice(0, 16)} failed: ${e.message}`); }
  }
  async function watch() {
    const nowS = nowSec();
    for (const [hash, p] of pending) {
      let got;
      try { got = await lookup({ name: p.name, paymentHash: hash }); } catch (e) { log(`lookup ${hash.slice(0, 16)} failed: ${e.message}`); continue; }
      if (pending.get(hash) !== p) continue;                  // let go meanwhile (kanban #1743): its last look is its own
      if (got && got.settled) { pending.delete(hash); save(); await paid(hash, p, got, nowS); }
      else if (p.until < nowS) { pending.delete(hash); save(); log(`zap ${hash.slice(0, 16)} expired unpaid`); }
    }
  }
  // A FULL BOOK GIVES WAY (kanban #1743): the oldest open zap is let go, with one last look so a payment landing now is receipted.
  function letGoOldest() {
    const first = pending.entries().next();
    if (first.done) return false;
    const [hash, p] = first.value;
    pending.delete(hash);
    log(`zap ${hash.slice(0, 16)} let go unpaid: the book of open zaps is full`);
    (async () => {
      try { const got = await lookup({ name: p.name, paymentHash: hash }); if (got && got.settled) await paid(hash, p, got, nowSec()); }
      catch (e) { log(`last lookup ${hash.slice(0, 16)} failed: ${e.message}`); }
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
        const open = [...pending.values()].map((p) => [p, requestOf(p)]);
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
        if (!mayMint(asker)) return refuse(`at most ${ZAP_MINTS_PER_ASKER} invoices per ${ZAP_ASKER_WINDOW_S / 60} minutes from one address`);
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
      // open and unpaid, serves the next tipper as well as a new one would.
      const key = `${name}|${amountMsat}`;
      const kept = tips.get(key);
      if (kept && kept.until - nowSec() >= expiryS / 2) {
        let got = null;
        try { got = await lookup({ name, paymentHash: kept.paymentHash }); } catch (e) { log(`lookup ${kept.paymentHash.slice(0, 16)} failed: ${e.message}`); }
        if (got && !got.settled && tips.get(key) === kept) return json(200, { pr: kept.request, routes: [] });
      }
      if (tips.get(key) === kept) tips.delete(key);
      let mint = tipMinting.get(key);
      if (!mint) {
        if (!mayMint(asker)) return refuse(`at most ${ZAP_MINTS_PER_ASKER} invoices per ${ZAP_ASKER_WINDOW_S / 60} minutes from one address`);
        mint = invoice({ name, amountMsat, descriptionHash: hex(sha256hex(metadata)), expiryS }).then((made) => {
          tips.delete(key);
          tips.set(key, { request: made.request, paymentHash: made.paymentHash, until: nowSec() + expiryS });
          while (tips.size > ZAP_TIPS_KEPT) tips.delete(tips.keys().next().value);
          log(`tip invoice ${name} ${amountMsat} msat ${made.paymentHash.slice(0, 16)}`);
          return made;
        }).finally(() => { tipMinting.delete(key); });
        tipMinting.set(key, mint);
      }
      let made;
      try { made = await mint; } catch (e) { return refuse(`no invoice was made: ${String(e.message).slice(0, 160)}`); }
      return json(200, { pr: made.request, routes: [] });
    });
    server.on('error', reject);
    server.listen(port, host, () => resolve({ port: server.address().port, nostrPubkey, pending, receipts, refused, watch,
      close: () => new Promise((r) => { clearInterval(timer); server.close(r); }) }));
  });
}
