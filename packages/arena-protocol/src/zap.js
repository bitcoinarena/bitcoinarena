/**
 * ZAPS (NIP-57) BETWEEN PLAYERS AND TIPS TO DEVELOPERS, AS RULES (kanban #362 item 14).
 *
 * A zap is an LNURL-pay (LUD-06) payment that carries a signed Nostr event: the payer signs a ZAP REQUEST (kind 9734) naming
 * the recipient's key and the amount, hands it to the recipient's LNURL callback as `nostr`, and gets an invoice whose
 * description hash is SHA-256 of exactly that request's JSON. Once paid, the recipient's LNURL server - the key its pay
 * request names as `nostrPubkey` - signs a ZAP RECEIPT (kind 9735) carrying the invoice and the request, and publishes it to
 * the relays the request listed. Anyone can then count a player's zaps without trusting anyone's word: the receipt is
 * signed by the server the recipient chose, the invoice inside it is for the request's amount under the request's hash.
 *
 * No money path of the game changes: a zap is the payer's own wallet (NWC) paying the recipient's own Lightning address.
 * These are the decisions; the fetching, signing and paying are the client's and the server's.
 */
import { decodeBolt11 } from './bolt11.js';
import { sha256, toHex } from './hash.js';
import { lnurlFor } from './bech32.js';

export const ZAP_REQUEST_KIND = 9734;
export const ZAP_RECEIPT_KIND = 9735;
/** A zap's message, in characters: the request travels in a URL, so it is kept short. */
export const ZAP_COMMENT_MAX = 280;
/** Relays a request may name for its receipt. */
export const ZAP_RELAYS_MAX = 8;

const ZAP_HEX64 = /^[0-9a-f]{64}$/;
const zapUtf8 = (s) => new TextEncoder().encode(String(s));
const zapTagsNamed = (e, name) => (Array.isArray(e && e.tags) ? e.tags.filter((t) => Array.isArray(t) && t[0] === name) : []);
const zapTagValue = (e, name) => { const t = zapTagsNamed(e, name)[0]; return t ? t[1] : undefined; };

/** NIP-01's id: SHA-256 of [0, pubkey, created_at, kind, tags, content], in hex. */
export const nostrEventId = (e) => toHex(sha256(zapUtf8(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));

/** Is this a NIP-01 event whose id is its own hash and whose signature is its key's? `verify(sig, id, pubkey)` on bytes. */
export function nostrEventSigned(e, { verify } = {}) {
  if (!e || typeof e !== 'object') return { ok: false, why: 'that is not an event' };
  if (!ZAP_HEX64.test(String(e.pubkey)) || !ZAP_HEX64.test(String(e.id)) || !/^[0-9a-f]{128}$/.test(String(e.sig)))
    return { ok: false, why: 'an event carries a 32-byte key, a 32-byte id and a 64-byte signature in lower-case hex' };
  if (!Number.isSafeInteger(e.created_at) || !Number.isSafeInteger(e.kind) || !Array.isArray(e.tags) || typeof e.content !== 'string')
    return { ok: false, why: 'an event carries created_at, kind, tags and content' };
  if (!e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string')))
    return { ok: false, why: 'every tag is a list of strings' };
  if (nostrEventId(e) !== e.id) return { ok: false, why: 'its id is not the hash of its own fields' };
  if (typeof verify !== 'function') return { ok: false, why: 'no verifier to check its signature' };
  const hex = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
  let good = false;
  try { good = verify(hex(e.sig), hex(e.id), hex(e.pubkey)) === true; } catch { good = false; }
  return good ? { ok: true } : { ok: false, why: `its signature is not ${e.pubkey.slice(0, 16)}'s` };
}

/**
 * DOES THIS PAY REQUEST TAKE ZAPS? A LUD-06 pay request saying `allowsNostr: true` and naming the key its receipts are signed
 * with (`nostrPubkey`). One that does not is still an address a tip can be paid to, without a receipt.
 */
export function payRequestTakesZaps(said) {
  if (!said || said.allowsNostr !== true) return { ok: false, why: 'this Lightning address does not take zaps (no allowsNostr)' };
  if (!ZAP_HEX64.test(String(said.nostrPubkey))) return { ok: false, why: 'this Lightning address names no 32-byte nostrPubkey for its receipts' };
  return { ok: true, nostrPubkey: said.nostrPubkey };
}

/**
 * THE ZAP REQUEST TO SIGN (kind 9734), unsigned: the recipient's key, the amount in msat, the relays its receipt goes to,
 * the recipient's LNURL (bech32 of its pay request URL), and - when the zap is for one thing - the event (`e`) or the
 * addressable thing (`a`, e.g. `30762:<seat>:<round>`) it is for. The content is the payer's message.
 */
export function zapRequestTemplate({ recipient, amountMsat, relays = [], payRequestUrl = null, comment = '', event = null, address = null } = {}) {
  if (!ZAP_HEX64.test(String(recipient))) throw new Error('a zap names its recipient by a 32-byte key in hex');
  if (typeof amountMsat !== 'bigint' || amountMsat < 1000n) throw new Error('a zap is at least 1 sat, in msat as a bigint');
  const message = String(comment || '');
  if (message.length > ZAP_COMMENT_MAX) throw new Error(`a zap's message is at most ${ZAP_COMMENT_MAX} characters`);
  const named = [...new Set(relays.map(String))];
  if (!named.length || named.length > ZAP_RELAYS_MAX || !named.every((r) => /^wss?:\/\/\S+$/.test(r)))
    throw new Error(`a zap names 1 to ${ZAP_RELAYS_MAX} relays (wss://) its receipt is published to`);
  const tags = [['relays', ...named], ['amount', String(amountMsat)]];
  if (payRequestUrl) tags.push(['lnurl', lnurlFor(payRequestUrl)]);
  tags.push(['p', recipient]);
  if (event) { if (!ZAP_HEX64.test(String(event))) throw new Error('a zapped event is named by its 32-byte id'); tags.push(['e', event]); }
  if (address) tags.push(['a', String(address)]);
  return { kind: ZAP_REQUEST_KIND, tags, content: message };
}

/**
 * WHETHER A ZAP REQUEST STANDS, AS THE LNURL SERVER CHECKS IT (NIP-57 appendix D): signed, exactly one `p`, at most one `e`
 * and one `a`, a `relays` tag, and an `amount` tag - when there is one - equal to the amount the callback was asked for.
 * Answers `{ ok, recipient, relays }` or why not.
 */
export function zapRequestStands(request, { amountMsat, verify } = {}) {
  if (!request || request.kind !== ZAP_REQUEST_KIND) return { ok: false, why: `a zap request is a kind ${ZAP_REQUEST_KIND} event` };
  const signed = nostrEventSigned(request, { verify });
  if (!signed.ok) return { ok: false, why: `the zap request: ${signed.why}` };
  const ps = zapTagsNamed(request, 'p');
  if (ps.length !== 1 || !ZAP_HEX64.test(String(ps[0][1]))) return { ok: false, why: 'a zap request names exactly one recipient (p)' };
  if (zapTagsNamed(request, 'e').length > 1) return { ok: false, why: 'a zap request names at most one event (e)' };
  if (zapTagsNamed(request, 'a').length > 1) return { ok: false, why: 'a zap request names at most one address (a)' };
  const relayTag = zapTagsNamed(request, 'relays')[0];
  const relays = relayTag ? relayTag.slice(1).filter((r) => /^wss?:\/\/\S+$/.test(r)).slice(0, ZAP_RELAYS_MAX) : [];
  if (!relays.length) return { ok: false, why: 'a zap request names the relays its receipt goes to' };
  const said = zapTagValue(request, 'amount');
  if (said !== undefined) {
    if (!/^\d{1,15}$/.test(String(said))) return { ok: false, why: 'a zap request\'s amount is a whole number of msat' };
    if (typeof amountMsat === 'bigint' && BigInt(said) !== amountMsat)
      return { ok: false, why: `the zap request is for ${said} msat, and the callback was asked ${amountMsat}` };
  }
  return { ok: true, recipient: ps[0][1], relays, amountMsat: said === undefined ? null : BigInt(said) };
}

/** The callback asked for a zap: exactly `amountMsat`, the signed request as `nostr`, and the recipient's `lnurl` when known. */
export function zapCallbackFor({ callback, amountMsat, request, lnurl = null }) {
  const u = new URL(callback);
  u.searchParams.set('amount', String(amountMsat));
  u.searchParams.set('nostr', JSON.stringify(request));
  if (lnurl) u.searchParams.set('lnurl', lnurl);
  return u.toString();
}

/**
 * IS THIS THE INVOICE A ZAP MAY BE PAID WITH? Exactly `amountMsat`, its description hash SHA-256 of the request's JSON as it
 * was sent (`description`, the string), and - when named - on that network.
 */
export function zapInvoiceStands({ invoice, amountMsat, description, network = null } = {}) {
  let d;
  try { d = decodeBolt11(String(invoice || '')); } catch (e) { return { ok: false, why: `that is not an invoice: ${e.message}` }; }
  if (d.amountMsat !== amountMsat)
    return { ok: false, why: `the invoice asks ${d.amountMsat === null ? 'any amount' : `${d.amountMsat} msat`}, and the zap is ${amountMsat} msat` };
  if (!d.descriptionHash || toHex(d.descriptionHash) !== toHex(sha256(zapUtf8(description))))
    return { ok: false, why: 'the invoice\'s description hash is not the zap request\'s (NIP-57)' };
  if (network && d.network !== network) return { ok: false, why: `that invoice is for ${d.network}, not ${network}` };
  return { ok: true, paymentHash: d.paymentHash, amountMsat: d.amountMsat, network: d.network };
}

/**
 * THE RECEIPT TO SIGN (kind 9735), unsigned, once the invoice is paid: the request's `p`, `e` and `a`, its signer as `P`, the
 * invoice (`bolt11`), the request's JSON (`description`) and the preimage. created_at is when the invoice was paid.
 */
export function zapReceiptTemplate({ request, description, invoice, preimage = null, paidAtS }) {
  const tags = [['p', zapTagValue(request, 'p')]];
  for (const name of ['e', 'a']) { const v = zapTagValue(request, name); if (v !== undefined) tags.push([name, v]); }
  tags.push(['P', request.pubkey], ['bolt11', String(invoice)], ['description', String(description)]);
  if (preimage) tags.push(['preimage', String(preimage)]);
  return { kind: ZAP_RECEIPT_KIND, created_at: paidAtS, tags, content: '' };
}

/**
 * WHETHER A ZAP RECEIPT STANDS (NIP-57 appendix F): signed by the recipient's LNURL server (`nostrPubkey`); its description is
 * a zap request that stands, for the receipt's own recipient; its invoice is for the request's amount under SHA-256 of that
 * description; and, when known, the request names the recipient's LNURL. Answers `{ ok, sender, recipient, amountMsat,
 * comment, event, address, paidAtS }` - what a board counts - or why not. A preimage, when there is one, must hash to the
 * invoice's payment hash.
 */
export function zapReceiptStands(receipt, { nostrPubkey, lnurl = null, verify } = {}) {
  if (!receipt || receipt.kind !== ZAP_RECEIPT_KIND) return { ok: false, why: `a zap receipt is a kind ${ZAP_RECEIPT_KIND} event` };
  if (nostrPubkey && receipt.pubkey !== nostrPubkey)
    return { ok: false, why: `the receipt is signed by ${String(receipt.pubkey).slice(0, 16)}, not the recipient's server ${String(nostrPubkey).slice(0, 16)}` };
  const signed = nostrEventSigned(receipt, { verify });
  if (!signed.ok) return { ok: false, why: `the receipt: ${signed.why}` };
  const description = zapTagValue(receipt, 'description');
  let request;
  try { request = JSON.parse(String(description)); } catch { return { ok: false, why: 'the receipt carries no zap request as its description' }; }
  const stands = zapRequestStands(request, { verify });
  if (!stands.ok) return { ok: false, why: stands.why };
  if (stands.amountMsat === null) return { ok: false, why: 'the zap request names no amount, so the receipt cannot be counted' };
  if (zapTagValue(receipt, 'p') !== stands.recipient) return { ok: false, why: 'the receipt is for another recipient than its request' };
  const paid = zapInvoiceStands({ invoice: zapTagValue(receipt, 'bolt11'), amountMsat: stands.amountMsat, description });
  if (!paid.ok) return { ok: false, why: paid.why };
  if (lnurl) {
    const named = zapTagValue(request, 'lnurl');
    if (named !== undefined && String(named).toLowerCase() !== String(lnurl).toLowerCase())
      return { ok: false, why: 'the zap request names another Lightning address than the recipient\'s' };
  }
  const preimage = zapTagValue(receipt, 'preimage');
  if (preimage !== undefined) {
    if (!ZAP_HEX64.test(String(preimage)) || toHex(sha256(Uint8Array.from(preimage.match(/../g).map((b) => parseInt(b, 16))))) !== toHex(paid.paymentHash))
      return { ok: false, why: 'the receipt\'s preimage is not the invoice\'s' };
  }
  return { ok: true, sender: request.pubkey, recipient: stands.recipient, amountMsat: stands.amountMsat, comment: request.content,
    event: zapTagValue(request, 'e') || null, address: zapTagValue(request, 'a') || null, paidAtS: receipt.created_at, receiptId: receipt.id };
}

/** The sum a board shows: receipts that stand, each counted once by its invoice's payment hash. */
export function zapTotals(receipts, options = {}) {
  const seen = new Set();
  const counted = [];
  let msat = 0n;
  for (const r of receipts || []) {
    const s = zapReceiptStands(r, options);
    if (!s.ok) continue;
    const key = toHex(decodeBolt11(zapTagValue(r, 'bolt11')).paymentHash);
    if (seen.has(key)) continue;
    seen.add(key); counted.push(s); msat += s.amountMsat;
  }
  return { count: counted.length, msat, zaps: counted };
}
