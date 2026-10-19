// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ZAPS BETWEEN PLAYERS AND TIPS TO DEVELOPERS (kanban #362 item 14; NIP-57 rules in arena-protocol/src/zap.js).
//
// THE PLAYER'S OWN WALLET PAYS, OVER NWC, AND NOTHING ELSE MOVES. A zap is the recipient's Lightning address (LUD-16) asked
// for an invoice of exactly the amount; when that address takes zaps, the invoice is bound to a zap request the tab signs
// with its identity key (the key the season board and the badges name), and the recipient's server publishes a receipt
// anyone can check. An address that does not take zaps is still paid - as a plain tip, under its own metadata hash, with no
// receipt. Every invoice is checked before it is paid: the amount, the description hash, the network.
//
// A PLAYER'S ADDRESS IS THEIR OWN WORD: the lud16 of their Nostr profile (kind 0) on the game's relay, signed by their
// identity key. A game developer's is the one their developer key signed beside the manifest (game-info.js `lightning`).
import { lightningAddressEndpoint, payRequestStands, callbackFor, invoiceAnswersPayRequest } from '../../arena-protocol/src/lnurl-pay.js';
import { zapRequestTemplate, payRequestTakesZaps, zapCallbackFor, zapInvoiceStands, zapTotals, nostrEventSigned, ZAP_RECEIPT_KIND } from '../../arena-protocol/src/zap.js';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';
import { decodeBolt11 } from '../../arena-protocol/src/bolt11.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { signEvent, payInvoice } from './nwc.js';

/** How long a relay is given to answer a read, in ms. */
export const ZAP_READ_MS = 8000;
/** The amounts the page offers, in sat. */
export const ZAP_CHOICES_SAT = Object.freeze([21, 100, 1000]);

const zapFetchJson = async (fetcher, url) => {
  const r = await fetcher(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
};

/**
 * WHERE A ZAP TO `address` GOES, for `amountMsat`: its pay request, checked, and whether it takes zaps.
 * `{ ok, url, callback, metadata, commentAllowed, zaps, nostrPubkey, lnurl }` or why not.
 */
export async function zapTarget(address, amountMsat, { fetcher = fetch } = {}) {
  const at = lightningAddressEndpoint(address);
  if (!at.ok) return at;
  let said;
  try { said = await zapFetchJson(fetcher, at.url); } catch (e) { return { ok: false, why: `${address} did not answer: ${e.message}` }; }
  const stands = payRequestStands(said, amountMsat);
  if (!stands.ok) return { ok: false, why: `${address}: ${stands.why}` };
  const takes = payRequestTakesZaps(said);
  return { ok: true, url: at.url, callback: stands.callback, metadata: stands.metadata, commentAllowed: stands.commentAllowed,
    zaps: takes.ok, nostrPubkey: takes.ok ? takes.nostrPubkey : null, lnurl: lnurlFor(at.url) };
}

/**
 * ZAP `address` FOR `amountMsat` FROM THIS TAB'S WALLET (`wallet`: the NWC connection payInvoice takes).
 * `recipient` is the recipient's Nostr key (hex) - a player's identity key, or a game developer's tip with none (then it
 * is a plain tip). `sign(template)` - or `secret` and `curve` - signs the zap request (the page hands identitySignEvent, so
 * the tab's key never leaves identity.js); `relays` are where its receipt goes; `event` / `about`
 * name what the zap is for (a round result, a game). `network` is the invoice's (`testnet`, `bitcoin`, `regtest`).
 * `pay(invoice)` is the wallet's half (NWC payInvoice by default). Answers `{ ok, zapped, paymentHash, preimage, invoice,
 * request }` or `{ ok: false, why, paid }`.
 */
export async function sendZap({ address, recipient = null, amountMsat, comment = '', relays = [], event = null, about = null,
  secret, curve, sign = null, wallet, network = null, fetcher = fetch, now, nwc = {}, pay = (invoice) => payInvoice(wallet, invoice, nwc) } = {}) {
  const target = await zapTarget(address, amountMsat, { fetcher });
  if (!target.ok) return target;
  let invoice, check, request = null;
  if (target.zaps && recipient && (sign || (secret && curve))) {
    let template;
    try { template = zapRequestTemplate({ recipient, amountMsat, relays, payRequestUrl: target.url, comment, event, address: about }); }
    catch (e) { return { ok: false, why: e.message }; }
    request = sign ? await sign(template) : await signEvent({ kind: template.kind, tags: template.tags, content: template.content, secret, curve, now });
    const description = JSON.stringify(request);
    let said;
    try { said = await zapFetchJson(fetcher, zapCallbackFor({ callback: target.callback, amountMsat, request, lnurl: target.lnurl })); }
    catch (e) { return { ok: false, why: `${address} made no invoice: ${e.message}` }; }
    if (said && said.status === 'ERROR') return { ok: false, why: `${address} refused the zap: ${String(said.reason || '').slice(0, 160)}` };
    invoice = said && said.pr;
    check = zapInvoiceStands({ invoice, amountMsat, description, network });
  } else {
    let said;
    try { said = await zapFetchJson(fetcher, callbackFor({ callback: target.callback, amountMsat, comment, commentAllowed: target.commentAllowed })); }
    catch (e) { return { ok: false, why: `${address} made no invoice: ${e.message}` }; }
    if (said && said.status === 'ERROR') return { ok: false, why: `${address} refused the tip: ${String(said.reason || '').slice(0, 160)}` };
    invoice = said && said.pr;
    check = invoiceAnswersPayRequest({ invoice, amountMsat, metadata: target.metadata, network });
  }
  if (!check.ok) return { ok: false, why: check.why };
  const paid = await pay(invoice);
  if (!paid.ok) return { ok: false, why: `the wallet did not pay: ${paid.why}` };
  if (toHex(sha256(fromHex(paid.preimage.toLowerCase()))) !== toHex(check.paymentHash))
    return { ok: false, why: 'the wallet\'s preimage is not the invoice\'s', paid: true };
  return { ok: true, zapped: !!request, paymentHash: toHex(check.paymentHash), preimage: paid.preimage.toLowerCase(), invoice, request,
    nostrPubkey: target.nostrPubkey };
}

/**
 * ONE READ FROM ONE RELAY: every event matching `filter` until EOSE (or `timeoutMs`), each event's id and signature checked
 * (`curve.verify`). Never throws: a relay that does not answer gives nothing.
 */
export function relayRead(url, filter, { curve, timeoutMs = ZAP_READ_MS, WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : null } = {}) {
  return new Promise((resolve) => {
    const got = [];
    let sock = null;
    let done = false;
    const verify = (sig, msg, key) => curve.verify(sig, msg, key);
    const finish = () => { if (done) return; done = true; clearTimeout(timer); try { sock && sock.close(); } catch { /* gone */ } resolve(got); };
    const timer = setTimeout(finish, timeoutMs);
    if (!WebSocketImpl) return finish();
    const sub = `zap-${Math.random().toString(36).slice(2, 10)}`;
    try { sock = new WebSocketImpl(url); } catch { return finish(); }
    sock.onopen = () => { try { sock.send(JSON.stringify(['REQ', sub, filter])); } catch { finish(); } };
    sock.onerror = finish;
    sock.onclose = finish;
    sock.onmessage = (m) => {
      let said; try { said = JSON.parse(String(m.data)); } catch { return; }
      if (!Array.isArray(said) || said[1] !== sub) return;
      if (said[0] === 'EOSE' || said[0] === 'CLOSED') return finish();
      if (said[0] === 'EVENT' && said[2] && nostrEventSigned(said[2], { verify }).ok) got.push(said[2]);
    };
  });
}

/**
 * A PLAYER'S LIGHTNING ADDRESS: the lud16 of their newest profile (kind 0) on `relays`, signed by their key. null for none.
 */
export async function playerLightningAddress(pubkey, { relays = [], curve, timeoutMs, WebSocketImpl } = {}) {
  const reads = await Promise.all(relays.map((r) => relayRead(r, { kinds: [0], authors: [pubkey], limit: 3 }, { curve, timeoutMs, WebSocketImpl })));
  const newest = reads.flat().filter((e) => e.pubkey === pubkey && e.kind === 0).sort((a, b) => b.created_at - a.created_at)[0];
  if (!newest) return null;
  let profile; try { profile = JSON.parse(newest.content); } catch { return null; }
  const said = profile && typeof profile.lud16 === 'string' ? profile.lud16.trim().toLowerCase() : '';
  return lightningAddressEndpoint(said).ok ? said : null;
}

/**
 * THE PROFILE THAT SAYS WHERE THIS TAB'S PLAYER TAKES ZAPS: a kind 0 signed by the identity key, carrying the name the board
 * shows and `lud16`. Published by the page to the game's relay; an empty address leaves lud16 out.
 */
export async function zapProfileEvent({ name, lud16 = '', secret, curve, sign = null, now } = {}) {
  const address = String(lud16 || '').trim().toLowerCase();
  if (address && !lightningAddressEndpoint(address).ok) return { ok: false, why: lightningAddressEndpoint(address).why };
  const content = JSON.stringify({ name: String(name || ''), ...(address ? { lud16: address } : {}) });
  return { ok: true, event: sign ? await sign({ kind: 0, tags: [], content }) : await signEvent({ kind: 0, tags: [], content, secret, curve, now }) };
}

/**
 * THE ZAPS A PLAYER HAS RECEIVED, COUNTED: every receipt for `recipient` on `relays`, kept only when it stands (signed by
 * the server of the address the player names - `nostrPubkey` - for its request's amount), each invoice once.
 */
export async function zapsReceived(recipient, { relays = [], nostrPubkey = null, lnurl = null, curve, timeoutMs, WebSocketImpl } = {}) {
  const reads = await Promise.all(relays.map((r) => relayRead(r, { kinds: [ZAP_RECEIPT_KIND], '#p': [recipient], limit: 500 }, { curve, timeoutMs, WebSocketImpl })));
  const byId = new Map();
  for (const e of reads.flat()) byId.set(e.id, e);
  return zapTotals([...byId.values()], { nostrPubkey, lnurl, verify: (sig, msg, key) => curve.verify(sig, msg, key) });
}

/** "21 sat" / "1,000 sat": a zap's amount as the page shows it. */
export function zapSatLine(msat) {
  const sat = BigInt(msat) / 1000n;
  return `${sat.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} sat`;
}

/** The invoice amount an NWC wallet will be asked to pay, from the bolt11 (for the confirmation line). */
export function zapInvoiceSat(invoice) {
  try { const d = decodeBolt11(invoice); return d.amountMsat === null ? null : d.amountMsat / 1000n; } catch { return null; }
}
