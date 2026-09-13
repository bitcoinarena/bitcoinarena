/**
 * LNURL-PAY (LUD-06, LUD-12), THE DONOR'S SIDE, AS RULES (M3.2 item 6e;
 * ruled 2026-09-13).
 *
 * A donation share is paid to a recipient's LNURL endpoint: the wallet asks the
 * endpoint for its pay request, asks the callback for an invoice of exactly the
 * share, and pays it only if the invoice is that - "the invoice amount equals
 * the user's requested amount" and "the description hash matches SHA256 of the
 * metadata string" (LUD-06, MUST). These are the decisions; the fetching and
 * the paying are the client's.
 *
 * The comment is the player's public key as hex (§22A, the owner 2026-09-08), and
 * it is left out when the endpoint takes fewer than 64 characters (LUD-12).
 */
import { decodeBolt11 } from './bolt11.js';
import { sha256, toHex } from './hash.js';

/** A player's public key as hex is 64 characters; an endpoint allowing fewer gets no comment. */
export const COMMENT_KEY_CHARS = 64;

/** Does this first answer stand as a pay request for `amountMsat`? `{ ok, callback, metadata, commentAllowed }` or why not. */
export function payRequestStands(said, amountMsat) {
  if (!said || typeof said !== 'object') return { ok: false, why: 'the endpoint did not answer with a pay request' };
  if (said.status === 'ERROR') return { ok: false, why: `the endpoint refused: ${String(said.reason || '').slice(0, 120)}` };
  if (said.tag !== 'payRequest') return { ok: false, why: `the endpoint answered a "${String(said.tag).slice(0, 20)}", not a payRequest` };
  if (typeof said.callback !== 'string' || !/^https?:\/\//.test(said.callback))
    return { ok: false, why: 'the pay request names no callback URL' };
  if (typeof said.metadata !== 'string') return { ok: false, why: 'the pay request carries no metadata to hash' };
  const min = said.minSendable;
  const max = said.maxSendable;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || min > max)
    return { ok: false, why: 'the pay request names no sendable range' };
  if (typeof amountMsat !== 'bigint' || amountMsat < BigInt(min) || amountMsat > BigInt(max))
    return { ok: false, why: `${amountMsat} msat is outside what the endpoint takes (${min}..${max} msat)` };
  const commentAllowed = Number.isSafeInteger(said.commentAllowed) && said.commentAllowed > 0 ? said.commentAllowed : 0;
  return { ok: true, callback: said.callback, metadata: said.metadata, commentAllowed };
}

/** The callback asked for exactly `amountMsat`, with the comment only if the endpoint takes a whole key. */
export function callbackFor({ callback, amountMsat, comment, commentAllowed = 0 }) {
  const u = new URL(callback);
  u.searchParams.set('amount', String(amountMsat));
  if (comment && commentAllowed >= COMMENT_KEY_CHARS && String(comment).length <= commentAllowed)
    u.searchParams.set('comment', String(comment));
  return u.toString();
}

/** Round networks as an invoice names them. */
const INVOICE_NETWORK = { regtest: 'regtest', testnet4: 'testnet', testnet: 'testnet', bitcoin: 'bitcoin', mainnet: 'bitcoin' };

/**
 * IS THIS THE INVOICE THE SHARE MAY BE PAID WITH? Exactly `amountMsat`, under
 * the endpoint's own metadata hash, and - when named - on the round's network.
 */
export function invoiceAnswersPayRequest({ invoice, amountMsat, metadata, network } = {}) {
  if (typeof invoice !== 'string' || !invoice) return { ok: false, why: 'the callback handed no invoice' };
  let d;
  try { d = decodeBolt11(invoice); }
  catch (e) { return { ok: false, why: `that is not an invoice: ${e.message}` }; }
  if (d.amountMsat !== amountMsat)
    return { ok: false, why: `the invoice asks ${d.amountMsat === null ? 'any amount' : `${d.amountMsat} msat`}, and this recipient's share is ${amountMsat} msat` };
  const want = sha256(new TextEncoder().encode(String(metadata)));
  if (!d.descriptionHash || toHex(d.descriptionHash) !== toHex(want))
    return { ok: false, why: 'the invoice\'s description hash is not the endpoint\'s own metadata (LUD-06)' };
  if (network && INVOICE_NETWORK[network] && d.network !== INVOICE_NETWORK[network])
    return { ok: false, why: `that invoice is for ${d.network}, and this round is on ${network}` };
  return { ok: true, paymentHash: d.paymentHash, amountMsat: d.amountMsat, network: d.network };
}
