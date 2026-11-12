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
// RECEIPTS DO NOT WAIT ON ANOTHER ZAP'S RELAYS (kanban #1828): the relays are the payer's own choice, and watch() used to await each
// publish before it looked at the next zap - one 1-sat zap naming 8 silent relays held every later receipt (and the expiry sweep)
// for 8 x 10 s. A paid zap's receipt is signed and kept at once; its publish runs beside the watcher, a few at a time, from a
// bounded queue (the oldest waiting one is dropped when it is full; the receipt itself stays in `receipts`).
export const ZAP_PUBLISH_PARALLEL = 4;
export const ZAP_PUBLISH_QUEUED = 1000;

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
  const requestOf = (p) => { try { return JSON.parse(p.description); } catch { return {}; } };
  if (statePath && existsSync(statePath)) {
    try { for (const p of JSON.parse(readFileSync(statePath, 'utf8')).pending || []) pending.set(p.paymentHash, p); } catch { /* a bad file starts empty */ }
  }
  const save = () => {
    if (!statePath) return;
    writeFileSync(`${statePath}.tmp`, JSON.stringify({ pending: [...pending.values()] }));
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
    const nowS = Math.floor(Date.now() / 1000);
    for (const [hash, p] of pending) {
      let got;
      try { got = await lookup({ name: p.name, paymentHash: hash }); } catch (e) { log(`lookup ${hash.slice(0, 16)} failed: ${e.message}`); continue; }
      if (got && got.settled) {
        const receipt = signNostr(zapReceiptTemplate({ request: JSON.parse(p.description), description: p.description, invoice: p.invoice,
          preimage: got.preimage || null, paidAtS: got.settledAtS || nowS }), { secret, curve });
        pending.delete(hash); save();
        receipts.push(receipt);
        log(`zap paid ${p.name} ${hash.slice(0, 16)} -> receipt ${receipt.id.slice(0, 16)}`);
        enqueuePublish(receipt, p.relays);   // not awaited (kanban #1828)
      } else if (p.until < nowS) { pending.delete(hash); save(); log(`zap ${hash.slice(0, 16)} expired unpaid`); }
    }
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
        if (pending.size + minting.size >= ZAP_PENDING_MAX) return refuse('too many zaps are open here; try again later');
        if (open.filter(([, r]) => r.pubkey === request.pubkey).length >= ZAP_PENDING_PER_PAYER) return refuse('too many open zaps from that key');
      } else {
        const comment = u.searchParams.get('comment');
        if (comment && comment.length > ZAP_COMMENT_MAX) return refuse(`a comment is at most ${ZAP_COMMENT_MAX} characters`);
      }
      let made;
      if (zap) minting.add(zap.request.id);
      try { made = await invoice({ name, amountMsat, descriptionHash: hex(sha256hex(zap ? description : metadata)), expiryS }); }
      catch (e) { return refuse(`no invoice was made: ${String(e.message).slice(0, 160)}`); }
      finally { if (zap) minting.delete(zap.request.id); }
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
      close: () => new Promise((r) => { clearInterval(timer); server.close(r); }) }));
  });
}
